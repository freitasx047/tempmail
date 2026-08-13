#!/usr/bin/env node
/**
 * Backend do Society Mail
 * -------------------------------
 * Servidor HTTP (sem dependências externas, só Node 18+) que:
 *   1. Fala com a API real do provedor de e-mail temporário
 *   2. Guarda o token de cada visitante numa sessão em memória,
 *      identificada por um header (X-Session-Id) em vez de cookie —
 *      assim funciona mesmo com o front rodando em outra porta/origem
 *      (ex.: Live Server em 127.0.0.1:5500 chamando a API em :3000).
 *   3. Expõe uma API simples em /api/* para o front-end (index.html)
 *   4. Também consegue servir o próprio index.html, se você preferir
 *      abrir tudo por aqui em vez do Live Server.
 *
 * Rodar:
 *   node server.js
 *   -> API disponível em http://localhost:3000
 *   -> se quiser, também abre o site em http://localhost:3000
 *
 * Se for usar o Live Server para abrir o public/index.html (porta 5500,
 * por exemplo), deixe este server.js rodando em paralelo — o front já
 * está configurado para chamar a API em http://<mesmo host>:3000.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://tempmailbee.com';
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_HEADER = 'x-session-id';
const SESSION_TTL_MS = 60 * 60 * 1000; // 1h de inatividade

// ---------------------------------------------------------------------------
// Sessões em memória: cada aba do navegador manda o mesmo X-Session-Id em
// todo request (o front gera esse id uma vez e guarda no localStorage).
// ---------------------------------------------------------------------------
const sessions = new Map();

function getOrCreateSession(req) {
  let sid = req.headers[SESSION_HEADER];
  if (!sid || typeof sid !== 'string') {
    sid = crypto.randomUUID();
  }

  let session = sessions.get(sid);
  if (!session) {
    session = {
      accessToken: null,
      cookieJar: new Map(),
      email: null,
      expiresAt: null,
      lastSeen: Date.now(),
    };
    sessions.set(sid, session);
  }

  session.lastSeen = Date.now();
  session.sid = sid;
  return session;
}

// limpa sessões esquecidas de tempos em tempos
setInterval(() => {
  const now = Date.now();
  for (const [sid, s] of sessions) {
    if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(sid);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Cliente da API do provedor de e-mail, isolado por sessão
// ---------------------------------------------------------------------------

function updateCookieJar(session, res) {
  const setCookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : res.headers.get('set-cookie')
        ? [res.headers.get('set-cookie')]
        : [];

  for (const cookieStr of setCookies) {
    const pair = cookieStr.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx > -1) {
      session.cookieJar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
  }
}

function cookieHeader(session) {
  return Array.from(session.cookieJar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function authHeaders(session) {
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) society-mail/1.0',
  };
  if (session.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;
  const cookies = cookieHeader(session);
  if (cookies) headers.Cookie = cookies;
  return headers;
}

async function upstreamFetch(session, url, options = {}) {
  const res = await fetch(url, options);
  updateCookieJar(session, res);
  return res;
}

async function ensureToken(session) {
  if (session.accessToken) return session.accessToken;
  const res = await upstreamFetch(session, `${BASE_URL}/api/auth/anonymous/`, {
    method: 'POST',
    headers: authHeaders(session),
  });
  const data = await res.json();
  if (!data.success) throw new Error('Falha ao obter token anônimo');
  session.accessToken = data.access_token;
  return session.accessToken;
}

async function listDomains(session) {
  await ensureToken(session);
  const res = await upstreamFetch(session, `${BASE_URL}/api/domains/`, {
    headers: authHeaders(session),
  });
  const data = await res.json();
  return data.available_domains || [];
}

async function createMailbox(session, { username, domain } = {}) {
  await ensureToken(session);
  const params = new URLSearchParams();

  if (username) {
    let finalDomain = domain;
    if (!finalDomain) {
      const domains = await listDomains(session);
      if (!domains.length) throw new Error('Nenhum domínio disponível');
      finalDomain = domains[0];
    }
    params.set('email_address', `${username}@${finalDomain}`);
    params.set('free_domain', 'false');
  } else {
    params.set('free_domain', 'true');
  }

  const res = await upstreamFetch(
    session,
    `${BASE_URL}/api/mailbox/create/?${params.toString()}`,
    { method: 'POST', headers: authHeaders(session) }
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Erro HTTP ${res.status} ao criar e-mail`);
  }

  const mailbox = await res.json();
  session.email = mailbox.email_address;
  session.expiresAt = mailbox.expires_at;
  return mailbox;
}

async function getEmails(session) {
  if (!session.email) throw new Error('Nenhuma caixa de e-mail ativa nesta sessão');
  const url = `${BASE_URL}/api/mailbox/emails/?email_address=${encodeURIComponent(session.email)}`;
  const res = await upstreamFetch(session, url, { headers: authHeaders(session) });
  if (!res.ok) throw new Error(`Erro HTTP ${res.status} ao buscar e-mails`);
  return res.json();
}

async function deleteMailbox(session) {
  if (!session.email) return true;
  const url = `${BASE_URL}/api/mailbox/delete/?email_address=${encodeURIComponent(session.email)}`;
  const res = await upstreamFetch(session, url, { method: 'DELETE', headers: authHeaders(session) });
  session.email = null;
  session.expiresAt = null;
  return res.ok;
}

// ---------------------------------------------------------------------------
// Servidor HTTP + roteamento
// ---------------------------------------------------------------------------

function setCors(req, res) {
  // Reflete a origem que chamou (funciona com Live Server em qualquer porta,
  // abrir o HTML direto do disco com origin "null", etc.)
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Session-Id');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) req.destroy(); // proteção simples
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('JSON inválido no corpo da requisição'));
      }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, urlPath) {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safePath === '/' ? 'index.html' : safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Proibido');
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(
        'Não encontrado. Se você está usando o Live Server, abra o index.html por ele ' +
        '(porta 5500) e deixe este servidor (porta 3000) rodando só para a API.'
      );
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  setCors(req, res);

  // preflight do CORS
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const session = getOrCreateSession(req);

  try {
    // ---- API ----
    if (url.pathname === '/api/domains' && req.method === 'GET') {
      const domains = await listDomains(session);
      return sendJson(res, 200, { success: true, domains, sid: session.sid });
    }

    if (url.pathname === '/api/mailbox' && req.method === 'POST') {
      const body = await readJsonBody(req);
      const mailbox = await createMailbox(session, {
        username: body.username?.trim() || undefined,
        domain: body.domain?.trim() || undefined,
      });
      return sendJson(res, 200, { success: true, mailbox, sid: session.sid });
    }

    if (url.pathname === '/api/mailbox' && req.method === 'GET') {
      return sendJson(res, 200, {
        success: true,
        email: session.email,
        expires_at: session.expiresAt,
        sid: session.sid,
      });
    }

    if (url.pathname === '/api/mailbox' && req.method === 'DELETE') {
      const ok = await deleteMailbox(session);
      return sendJson(res, 200, { success: ok });
    }

    if (url.pathname === '/api/emails' && req.method === 'GET') {
      const data = await getEmails(session);
      return sendJson(res, 200, data);
    }

    // ---- Front-end estático (opcional — só é usado se você não abrir via Live Server) ----
    if (req.method === 'GET') {
      return serveStatic(req, res, url.pathname);
    }

    sendJson(res, 404, { success: false, error: 'Rota não encontrada' });
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { success: false, error: err.message || 'Erro interno' });
  }
});

server.listen(PORT, () => {
  console.log(`API do Society Mail rodando em http://localhost:${PORT}`);
  console.log(`Se estiver usando o Live Server para o front-end, deixe este processo aberto.`);
});