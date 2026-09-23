'use strict';

/**
 * Serveur HTTP du tableau de bord « Mon serveur ».
 * Aucune dépendance externe : uniquement la bibliothèque standard de Node.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const collect = require('./lib/collect');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const STARTED_AT = Date.now();

collect.start();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Introuvable');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/metrics') {
    try {
      sendJson(res, 200, collect.latest());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  if (url.pathname === '/healthz') {
    sendJson(res, 200, {
      status: 'ok',
      uptime: Math.round((Date.now() - STARTED_AT) / 1000),
      source: collect.latest().source,
    });
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
    return;
  }

  // Fichiers statiques, confinés au dossier public/.
  const rel = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const target = path.join(PUBLIC_DIR, rel);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Interdit');
    return;
  }
  sendFile(res, target);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[serveur-monitor] à l'écoute sur http://0.0.0.0:${PORT}`);
  console.log(`[serveur-monitor] sources : ${JSON.stringify(collect.paths)}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`[serveur-monitor] ${sig} reçu, arrêt.`);
    server.close(() => process.exit(0));
  });
}
