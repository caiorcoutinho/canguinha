// Login com Google (OpenID Connect, authorization code + PKCE). Sem dependências.
// O id_token vem direto do endpoint de token do Google por TLS, então as claims são confiáveis sem checar a
// assinatura (OIDC Core §3.1.3.7); ainda assim validamos iss, aud, exp, nonce e email_verified.
import crypto from 'node:crypto';

const SESSION_COOKIE = 'canguinha_sid';
const FLOW_COOKIE = 'canguinha_oauth';
const SESSION_DAYS = 30;
const FLOW_MINUTES = 10;

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const hashToken = (t) => sha256(t).toString('hex');
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export async function createAuth({ store, clientId, clientSecret, allowedEmails, publicUrl, endpoints = {} }) {
  const enabled = !!clientId;
  const allowed = new Set(allowedEmails.map((e) => e.trim().toLowerCase()).filter(Boolean));
  const AUTH_URL = endpoints.auth || 'https://accounts.google.com/o/oauth2/v2/auth';
  const TOKEN_URL = endpoints.token || 'https://oauth2.googleapis.com/token';
  const ISSUERS = endpoints.issuers || ['https://accounts.google.com', 'accounts.google.com'];

  // chave para assinar o cookie temporário do fluxo OAuth
  let signKey = process.env.SESSION_SECRET || (await store.getSetting('session_secret'));
  if (!signKey) { signKey = crypto.randomBytes(32).toString('base64url'); await store.setSetting('session_secret', signKey); }
  const sign = (v) => crypto.createHmac('sha256', signKey).update(v).digest('base64url');

  const baseUrl = (req) => publicUrl || `http://${req.headers.host}`;
  const secure = (req) => baseUrl(req).startsWith('https://');
  const cookie = (req, name, value, maxAgeSec) =>
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure(req) ? '; Secure' : ''}`;
  const redirect = (res, location, cookies = []) => { res.writeHead(302, { Location: location, 'Set-Cookie': cookies, 'Cache-Control': 'no-store' }); res.end(); };
  const fail = (req, res, code) => redirect(res, `/login.html?erro=${code}`, [cookie(req, FLOW_COOKIE, '', 0)]);

  async function start(req, res) {
    const flow = { state: b64url(crypto.randomBytes(16)), nonce: b64url(crypto.randomBytes(16)), verifier: b64url(crypto.randomBytes(32)), exp: Date.now() + FLOW_MINUTES * 60e3 };
    const value = b64url(JSON.stringify(flow));
    const qs = new URLSearchParams({
      client_id: clientId, response_type: 'code', scope: 'openid email profile',
      redirect_uri: `${baseUrl(req)}/auth/google/callback`,
      state: flow.state, nonce: flow.nonce,
      code_challenge: b64url(sha256(flow.verifier)), code_challenge_method: 'S256',
      prompt: 'select_account',
    });
    redirect(res, `${AUTH_URL}?${qs}`, [cookie(req, FLOW_COOKIE, `${value}.${sign(value)}`, FLOW_MINUTES * 60)]);
  }

  async function callback(req, res, url) {
    if (url.searchParams.get('error')) return fail(req, res, 'cancelado');
    const [value, sig] = (parseCookies(req)[FLOW_COOKIE] || '').split('.');
    if (!value || !sig || !safeEqual(sign(value), sig)) return fail(req, res, 'sessao');
    const flow = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (Date.now() > flow.exp || url.searchParams.get('state') !== flow.state) return fail(req, res, 'sessao');

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: url.searchParams.get('code') || '', client_id: clientId, client_secret: clientSecret,
        redirect_uri: `${baseUrl(req)}/auth/google/callback`, grant_type: 'authorization_code', code_verifier: flow.verifier,
      }),
    });
    if (!tokenRes.ok) { console.error('[auth] token', tokenRes.status, (await tokenRes.text()).slice(0, 200)); return fail(req, res, 'google'); }
    const { id_token: idToken } = await tokenRes.json();
    let claims;
    try { claims = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString()); } catch { return fail(req, res, 'google'); }

    const now = Math.floor(Date.now() / 1000);
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!ISSUERS.includes(claims.iss) || !aud.includes(clientId) || !(claims.exp > now) || claims.nonce !== flow.nonce) return fail(req, res, 'google');
    const email = String(claims.email || '').toLowerCase();
    if (!email || claims.email_verified !== true) return fail(req, res, 'email');
    if (!allowed.has(email)) { console.warn(`[auth] acesso negado: ${email}`); return fail(req, res, 'negado'); }

    const token = b64url(crypto.randomBytes(32));
    await store.createSession(hashToken(token), { email, name: claims.name || null, picture: claims.picture || null }, new Date(Date.now() + SESSION_DAYS * 864e5));
    await store.purgeSessions().catch(() => {});
    console.log(`[auth] login: ${email}`);
    redirect(res, '/', [cookie(req, FLOW_COOKIE, '', 0), cookie(req, SESSION_COOKIE, token, SESSION_DAYS * 86400)]);
  }

  async function logout(req, res) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await store.deleteSession(hashToken(token)).catch(() => {});
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': cookie(req, SESSION_COOKIE, '', 0) });
    res.end('{"ok":true}');
  }

  return {
    enabled,
    // trata /auth/*; devolve true se respondeu
    async handle(req, res, url) {
      if (!url.pathname.startsWith('/auth/')) return false;
      if (!enabled) { res.writeHead(404); res.end(); return true; }
      if (req.method === 'GET' && url.pathname === '/auth/google/login') { await start(req, res); return true; }
      if (req.method === 'GET' && url.pathname === '/auth/google/callback') {
        try { await callback(req, res, url); } catch (err) { console.error('[auth]', err.message); fail(req, res, 'google'); }
        return true;
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') { await logout(req, res); return true; }
      res.writeHead(404); res.end(); return true;
    },
    async getUser(req) {
      const token = parseCookies(req)[SESSION_COOKIE];
      if (!token) return null;
      return store.getSession(hashToken(token));
    },
    // origem esperada para checar requisições que alteram dados
    origin: (req) => new URL(baseUrl(req)).origin,
  };
}
