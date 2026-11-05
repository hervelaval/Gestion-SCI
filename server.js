// Serveur minimal (aucune dépendance npm) pour l'application d'états des lieux.
// - sert index.html
// - stocke les locataires, les constats (HTML scellé + données) sur le disque persistant Render
//
// Variables d'environnement :
//   PORT          (fourni par Render)
//   DATA_DIR      dossier de stockage (défaut : /data s'il existe, sinon ./data)
//   APP_PASSWORD  (recommandé) mot de passe d'accès à toute l'application

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
const EDL_DIR = path.join(DATA_DIR, 'edl');
const TENANTS_FILE = path.join(DATA_DIR, 'tenants.json');
const TENANTS_PREV = path.join(DATA_DIR, 'tenants.prev.json');
const INDEX_FILE = path.join(DATA_DIR, 'edl-index.json');
const PASSWORD = process.env.APP_PASSWORD || '';
const MAX_BODY = 200 * 1024 * 1024; // 200 Mo (photos incluses)

fs.mkdirSync(EDL_DIR, { recursive: true });

// ---------- utilitaires ----------
function writeAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fallback; }
}

function send(res, status, body, type) {
  const headers = {
    'Content-Type': type || 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Robots-Tag': 'noindex, nofollow'
  };
  res.writeHead(status, headers);
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest(); }

function isAuthorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Basic ')) return false;
  const decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return crypto.timingSafeEqual(sha(pass), sha(PASSWORD));
}

function safeFileBase(title) {
  let s = String(title || 'EDL').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  s = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  if (!s) s = 'EDL';
  return s.slice(0, 150);
}

function uniqueBase(base) {
  let name = base, i = 2;
  while (fs.existsSync(path.join(EDL_DIR, name + '.html'))) { name = base + '-' + i; i++; }
  return name;
}

// ---------- routes ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, 'ok', 'text/plain; charset=utf-8');

  if (!isAuthorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Etats des lieux", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Authentification requise');
  }

  // page principale
  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    try { return send(res, 200, fs.readFileSync(path.join(__dirname, 'index.html')), 'text/html; charset=utf-8'); }
    catch (e) { return send(res, 500, 'index.html introuvable', 'text/plain; charset=utf-8'); }
  }

  // locataires
  if (p === '/api/tenants') {
    if (req.method === 'GET') {
      return send(res, 200, { data: readJson(TENANTS_FILE, null) });
    }
    if (req.method === 'PUT') {
      let data;
      try { data = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'JSON invalide' }); }
      if (!data || !Array.isArray(data.SCI_1) || !Array.isArray(data.SCI_2)) return send(res, 400, { error: 'Format invalide' });
      if (fs.existsSync(TENANTS_FILE)) { try { fs.copyFileSync(TENANTS_FILE, TENANTS_PREV); } catch (e) { /* ignore */ } }
      writeAtomic(TENANTS_FILE, JSON.stringify(data));
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'Méthode non autorisée' });
  }

  // enregistrement d'un constat scellé
  if (p === '/api/edl' && req.method === 'POST') {
    let d;
    try { d = JSON.parse(await readBody(req)); } catch (e) { return send(res, 400, { error: 'JSON invalide ou trop volumineux' }); }
    if (!d || typeof d.title !== 'string' || typeof d.html !== 'string' || !d.state) return send(res, 400, { error: 'Données incomplètes' });
    const base = uniqueBase(safeFileBase(d.title));
    writeAtomic(path.join(EDL_DIR, base + '.html'), d.html);
    writeAtomic(path.join(EDL_DIR, base + '.json'), JSON.stringify(d.state));
    const index = readJson(INDEX_FILE, []);
    index.push({
      file: base,
      title: d.title,
      sciKey: d.sciKey || '',
      address: d.address || '',
      logement: d.logement || '',
      type: d.type || '',
      date: d.date || '',
      tenants: Array.isArray(d.tenants) ? d.tenants : [],
      createdAt: new Date().toISOString()
    });
    writeAtomic(INDEX_FILE, JSON.stringify(index));
    return send(res, 200, { ok: true, url: '/edl/' + base + '.html' });
  }

  // dernier constat d'un logement (pour "repartir du précédent")
  if (p === '/api/edl/last' && req.method === 'GET') {
    const address = url.searchParams.get('address') || '';
    const logement = url.searchParams.get('logement') || '';
    const index = readJson(INDEX_FILE, []).filter((e) => e.address === address && e.logement === logement);
    if (!index.length) return send(res, 404, { error: 'Aucun constat précédent' });
    index.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    const last = index[0];
    const state = readJson(path.join(EDL_DIR, last.file + '.json'), null);
    if (!state) return send(res, 404, { error: 'Données du constat introuvables' });
    return send(res, 200, { title: last.title, date: last.date, type: last.type, state: state });
  }

  // consultation d'un constat scellé
  if (req.method === 'GET' && p.startsWith('/edl/')) {
    const name = decodeURIComponent(p.slice(5));
    if (!/^[A-Za-z0-9._-]+\.html$/.test(name)) return send(res, 400, 'Nom invalide', 'text/plain; charset=utf-8');
    const file = path.join(EDL_DIR, name);
    if (!fs.existsSync(file)) return send(res, 404, 'Constat introuvable', 'text/plain; charset=utf-8');
    return send(res, 200, fs.readFileSync(file), 'text/html; charset=utf-8');
  }

  return send(res, 404, { error: 'Introuvable' });
}

http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error(e);
    if (!res.headersSent) send(res, 500, { error: 'Erreur serveur' });
    else res.end();
  });
}).listen(PORT, () => {
  console.log('Serveur démarré sur le port ' + PORT + ' – données : ' + DATA_DIR + (PASSWORD ? ' – protégé par mot de passe' : ' – ATTENTION : aucun mot de passe'));
});
