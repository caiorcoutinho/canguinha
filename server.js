// Canguinha — gestão de finanças pessoais via Open Finance (Pluggy)
// Servidor: node --env-file=.env server.js  (ou docker compose up)
import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { demoAccounts, demoTransactions, demoBills } from './lib/demo.js';
import { createStore, DuplicateError } from './lib/store.js';
import { createAuth } from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

const PORT = Number(process.env.PORT || 3000);
// Dentro de um container, 127.0.0.1 não é alcançável pela porta publicada: escuta em todas as interfaces.
const IN_CONTAINER = existsSync('/.dockerenv') || existsSync('/run/.containerenv');
const HOST = process.env.HOST || (IN_CONTAINER ? '0.0.0.0' : '127.0.0.1');
const CLIENT_ID = process.env.PLUGGY_CLIENT_ID || '';
const CLIENT_SECRET = process.env.PLUGGY_CLIENT_SECRET || '';
const API = process.env.PLUGGY_API_URL || 'https://api.pluggy.ai';
const DEMO = process.env.DEMO === '1' || !CLIENT_ID || !CLIENT_SECRET;
const CACHE_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- persistência
// Postgres se DATABASE_URL estiver definido; senão arquivos JSON em data/.
const store = await createStore({ databaseUrl: process.env.DATABASE_URL, dataDir: DATA_DIR });

// ---------------------------------------------------------------- login (Google)
const auth = await createAuth({
  store,
  clientId: process.env.GOOGLE_CLIENT_ID || '',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  allowedEmails: (process.env.ALLOWED_EMAILS || '').split(','),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  endpoints: { auth: process.env.GOOGLE_AUTH_URL, token: process.env.GOOGLE_TOKEN_URL, issuers: process.env.GOOGLE_ISSUER ? [process.env.GOOGLE_ISSUER] : undefined },
});
// Nunca publicar sem login: com PUBLIC_URL é obrigatório configurar o Google e a lista de e-mails.
if (process.env.PUBLIC_URL && !auth.enabled) { console.error('PUBLIC_URL definida sem GOOGLE_CLIENT_ID: configure o login antes de publicar.'); process.exit(1); }
if (auth.enabled && (!process.env.GOOGLE_CLIENT_SECRET || !(process.env.ALLOWED_EMAILS || '').trim())) {
  console.error('Login Google exige GOOGLE_CLIENT_SECRET e ALLOWED_EMAILS (e-mails autorizados, separados por vírgula).'); process.exit(1);
}
const PUBLIC_FILES = new Set(['/login.html', '/styles.css']);

// Items do .env (fixos) + os adicionados pela tela (removíveis).
async function loadItemIds() {
  const fromEnv = (process.env.PLUGGY_ITEM_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return [...new Set([...fromEnv, ...(await store.listItems())])];
}

// ---------------------------------------------------------------- pluggy client
let apiKey = null;
let apiKeyExp = 0;

async function getApiKey(force = false) {
  if (!force && apiKey && Date.now() < apiKeyExp) return apiKey;
  const res = await fetch(`${API}/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: CLIENT_ID, clientSecret: CLIENT_SECRET }),
  });
  if (!res.ok) throw new HttpError(502, `Falha ao autenticar na Pluggy (${res.status}): ${await res.text()}`);
  apiKey = (await res.json()).apiKey;
  apiKeyExp = Date.now() + 100 * 60 * 1000; // a chave vale 2h; renova antes
  return apiKey;
}

async function pluggy(pathname, { method = 'GET', body, retry = true } = {}) {
  const key = await getApiKey();
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && retry) {
    await getApiKey(true);
    return pluggy(pathname, { method, body, retry: false });
  }
  if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Pluggy ${method} ${pathname} → ${res.status}: ${await res.text()}`);
  return res.json();
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- cache
const cache = new Map();
async function cached(key, fn, refresh) {
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.v;
  const v = await fn();
  cache.set(key, { t: Date.now(), v });
  return v;
}

// ---------------------------------------------------------------- domain
function normalizeAccount(a, item) {
  const isCredit = a.type === 'CREDIT';
  return {
    id: a.id,
    itemId: item?.id ?? a.itemId,
    institution: item?.connector?.name ?? 'Instituição',
    institutionColor: item?.connector?.primaryColor ? `#${item.connector.primaryColor.replace('#', '')}` : null,
    itemStatus: item?.status ?? null,
    lastUpdatedAt: item?.lastUpdatedAt ?? null,
    kind: isCredit ? 'credit' : 'bank',
    subtype: a.subtype,
    name: a.marketingName || a.name,
    number: a.number,
    currency: a.currencyCode || 'BRL',
    // Conta: saldo disponível. Cartão: limite usado total (fatura aberta + fechadas não pagas + parcelas futuras).
    balance: a.balance ?? 0,
    creditLimit: a.creditData?.creditLimit ?? null,
    availableLimit: a.creditData?.availableCreditLimit ?? null,
    dueDate: a.creditData?.balanceDueDate ?? null,
    closeDate: a.creditData?.balanceCloseDate ?? null,
  };
}

// Data local (Brasil). Horário exatamente 00:00:00Z = data sem hora vinda do banco: mantém o dia.
const TZ = process.env.TZ_DISPLAY || 'America/Sao_Paulo';
const localDay = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
function txDate(raw) {
  const s = String(raw);
  if (s.length <= 10 || /T00:00:00(\.000)?Z$/.test(s)) return s.slice(0, 10);
  return localDay.format(new Date(s));
}

// `type` indica a direção: DEBIT = saída, CREDIT = entrada (vale para conta e cartão).
// Sem `type`, cai na convenção de sinal: conta negativo = saída; cartão positivo = compra.
function normalizeTransaction(t, account) {
  const out = t.type ? t.type === 'DEBIT' : account.kind === 'credit' ? t.amount > 0 : t.amount < 0;
  const amount = Math.abs(t.amountInAccountCurrency ?? t.amount);
  const cc = t.creditCardMetadata || {};
  const description = t.descriptionRaw && t.description === t.descriptionRaw ? t.description : (t.description || t.descriptionRaw || '');
  const purchaseDate = cc.purchaseDate ? txDate(cc.purchaseDate) : null; // dia local: o banco manda ora com hora em UTC, ora só a data
  return {
    id: t.id,
    accountId: account.id,
    date: txDate(t.date),
    description,
    merchant: t.merchant?.businessName || t.merchant?.name || null,
    category: t.category || 'Sem categoria',
    status: t.status,
    direction: out ? 'out' : 'in',
    amount,
    signed: out ? -amount : amount,
    installment: cc.totalInstallments > 1 ? `${cc.installmentNumber}/${cc.totalInstallments}` : null,
    billId: cc.billId || null,
    installmentNumber: cc.installmentNumber ?? null,
    totalInstallments: cc.totalInstallments ?? null,
    purchaseDate,
    // identifica a compra parcelada (igual em todas as parcelas): usado para dividir todas de uma vez
    purchaseKey: cc.totalInstallments > 1 ? [account.id, purchaseDate || '', cc.totalInstallments, ruleKey(description)].join('|') : null,
  };
}

async function getItem(itemId, refresh) {
  return cached(`item:${itemId}`, () => pluggy(`/items/${itemId}`), refresh);
}

async function listAccounts(refresh = false) {
  if (DEMO) return demoAccounts();
  const ids = await loadItemIds();
  const all = await Promise.all(ids.map(async (itemId) => {
    try {
      return await cached(`accounts:${itemId}`, async () => {
        const [item, accounts] = await Promise.all([getItem(itemId, refresh), pluggy(`/accounts?itemId=${itemId}`)]);
        const list = accounts.results.map((a) => normalizeAccount(a, item));
        if (HISTORY) {
          await store.saveAccounts(accounts.results.map((a, i) => ({ id: a.id, item_id: itemId, kind: list[i].kind, data: list[i], raw: a })))
            .catch((err) => console.error('[histórico contas]', err.message));
        }
        return list;
      }, refresh);
    } catch (err) {
      console.error(`[item ${itemId}]`, err.message);
      return HISTORY ? store.getAccounts(itemId).catch(() => []) : []; // Pluggy fora: usa o que está salvo
    }
  }));
  return all.flat();
}

const shiftDate = (s, days) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

// GET /v2/transactions: filtros dateFrom/dateTo (inclusivos, em UTC) e paginação por cursor em `next`.
async function fetchAllTransactions(accountId, from, to) {
  const results = [];
  const seen = new Set();
  // Busca 1 dia a mais de cada lado; o recorte exato é feito depois, já no fuso local.
  const qs = new URLSearchParams({ accountId });
  if (from) qs.set('dateFrom', shiftDate(from, -1));
  if (to) qs.set('dateTo', shiftDate(to, 1));
  let url = `/v2/transactions?${qs}`;
  for (let i = 0; url && i < 100; i++) {
    const res = await pluggy(url);
    for (const t of res.results || []) if (!seen.has(t.id)) { seen.add(t.id); results.push(t); }
    url = nextUrl(res.next, qs);
  }
  return results;
}

function nextUrl(next, qs) {
  if (!next || typeof next !== 'string') return null;
  if (/^https?:\/\//.test(next)) { const u = new URL(next); return u.pathname + u.search; }
  if (next.startsWith('/')) return next;
  const q = new URLSearchParams(qs);
  q.set('cursor', next);
  return `/v2/transactions?${q}`;
}

// ---------------------------------------------------------------- faturas
const todayIso = () => localDay.format(new Date());
function addMonths(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
}

function normalizeBill(b) {
  return {
    id: b.id,
    closeDate: b.billClosingDate ? String(b.billClosingDate).slice(0, 10) : null,
    dueDate: String(b.dueDate).slice(0, 10),
    total: b.totalAmount ?? 0,
    minimum: b.minimumPaymentAmount ?? null,
    financeCharges: (b.financeCharges || []).reduce((s, f) => s + (f.amount || 0), 0),
    allowsInstallments: !!b.allowsInstallments,
  };
}

async function fetchBills(accountId) {
  const out = [];
  for (let page = 1, total = 1; page <= total && page <= 50; page++) {
    const res = await pluggy(`/bills?accountId=${accountId}&page=${page}`);
    out.push(...(res.results || []));
    total = res.totalPages || 1;
  }
  return out;
}

// Faturas de um cartão + todas as transações dele, cada uma marcada com a fatura a que pertence
// (`bill`: id da fatura ou 'open'). Usa o billId da Pluggy; se o banco não informa, usa a janela de fechamento.
async function billData(acc, refresh) {
  let bills, tx;
  if (DEMO) {
    bills = demoBills(acc.id);
    tx = demoTransactions().filter((t) => t.accountId === acc.id);
  } else {
    const [rawBills, rawTx] = await Promise.all([
      synced(`bills:${acc.id}`, refresh, () => fetchBills(acc.id), (r) => store.saveBills(acc.id, r), () => store.getBills(acc.id)),
      synced(`txall:${acc.id}`, refresh, () => fetchAllTransactions(acc.id), (r) => persistTx(acc, r, {}), () => store.getTransactions(acc.id)),
    ]);
    bills = rawBills.map(normalizeBill);
    tx = rawTx.map((t) => normalizeTransaction(t, acc));
  }
  bills.sort((a, b) => b.dueDate.localeCompare(a.dueDate));
  const ids = new Set(bills.map((b) => b.id));
  const hasLinks = tx.some((t) => t.billId && ids.has(t.billId));
  const windows = [...bills].filter((b) => b.closeDate).sort((a, b) => a.closeDate.localeCompare(b.closeDate));
  const lastClose = windows.at(-1)?.closeDate ?? null;
  for (const t of tx) {
    // Sem billId = ainda não faturada → fatura aberta (mesmo com data no dia do fechamento).
    if (hasLinks) t.bill = !t.billId ? 'open' : ids.has(t.billId) ? t.billId : null;
    else t.bill = (lastClose && t.date <= lastClose) ? (windows.find((b) => t.date <= b.closeDate)?.id ?? null) : 'open';
  }

  const today = todayIso();
  const last = bills[0];
  let closeEst = lastClose ? addMonths(lastClose, 1) : acc.closeDate;
  while (closeEst && closeEst < today) closeEst = addMonths(closeEst, 1);
  let dueEst = acc.dueDate && (!last || acc.dueDate.slice(0, 10) > last.dueDate) ? acc.dueDate.slice(0, 10) : last ? addMonths(last.dueDate, 1) : null;
  while (dueEst && closeEst && dueEst < closeEst) dueEst = addMonths(dueEst, 1);

  const sum = (list) => list.reduce((s, t) => s + (t.direction === 'out' ? t.amount : -t.amount), 0);
  const openTx = tx.filter((t) => t.bill === 'open');
  const upcoming = upcomingInstallments(tx, bills);
  const counts = {};
  for (const t of tx) if (t.bill) counts[t.bill] = (counts[t.bill] || 0) + 1;
  return {
    tx,
    summary: {
      account: acc,
      bills: bills.map((b) => ({ ...b, txCount: counts[b.id] || 0, status: b.dueDate < today ? 'past' : 'due' })),
      open: {
        id: 'open', closeDate: closeEst, dueDate: dueEst, total: sum(openTx), txCount: openTx.length, estimated: true, status: 'open',
        upcoming, upcomingTotal: upcoming.reduce((s, u) => s + u.amount, 0),
      },
    },
  };
}

// Parcelas que devem cair na fatura aberta mas ainda não foram lançadas: compras parceladas cuja parcela
// mais recente está na última fatura fechada e ainda não chegou à última parcela. A Pluggy não tem id da compra,
// então agrupa por data da compra + nº de parcelas + descrição.
const stripInstallment = (d) => d.replace(/\s*(parc(ela)?\.?\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*/gi, ' ').replace(/\s+/g, ' ').trim();
function upcomingInstallments(tx, bills) {
  const lastClosed = bills.find((b) => b.closeDate)?.id;
  if (!lastClosed) return [];
  const latest = new Map();
  for (const t of tx) {
    if (!(t.totalInstallments > 1) || !t.installmentNumber || t.direction !== 'out') continue;
    const key = [t.purchaseDate || '', t.totalInstallments, stripInstallment(t.description).toLowerCase()].join('|');
    const cur = latest.get(key);
    if (!cur || t.installmentNumber > cur.installmentNumber) latest.set(key, t);
  }
  return [...latest.values()]
    .filter((t) => t.installmentNumber < t.totalInstallments && t.bill === lastClosed)
    .map((t) => ({
      description: stripInstallment(t.description), category: t.category, purchaseDate: t.purchaseDate, purchaseKey: t.purchaseKey, direction: 'out', sourceId: t.id, // parcela lançada que originou a previsão
      installment: `${t.installmentNumber + 1}/${t.totalInstallments}`, amount: t.amount,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ---------------------------------------------------------------- categorias personalizadas
// Ordem: escolha manual na transação > regra pela descrição > categoria da Pluggy.
// Nada é gravado sobre o dado da Pluggy; a troca acontece na leitura (e não altera os objetos em cache).
// chave da regra: descrição sem datas, horários, parcelas e números longos ("PIX - ENVIADO 04/11 09:48 FULANO" → "pix - enviado fulano")
const ruleKey = (d) => String(d || '').toLowerCase()
  .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // datas e parcelas (04/11, 3/10)
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')        // horários
  .replace(/\b\d{6,}\b/g, ' ')                        // documentos, códigos
  .replace(/\bparc(ela)?\b\.?/g, ' ')
  .replace(/\s+/g, ' ').trim();
// Também anexa as divisões com outras pessoas: `shares` [{personId, amount}] e `myAmount` (a sua parte).
const round2 = (v) => Math.round(v * 100) / 100;
async function annotator() {
  const [{ overrides, rules }, shares] = await Promise.all([store.getCategoryState(), store.getShares()]);
  const byRule = new Map(rules.map((r) => [r.match, r.category]));
  const byTarget = new Map();
  for (const x of shares) { if (!byTarget.has(x.target)) byTarget.set(x.target, []); byTarget.get(x.target).push(x); }
  return (t) => {
    let out = t;
    const manual = t.id ? overrides[t.id] : undefined;
    const cat = manual ?? byRule.get(ruleKey(t.description));
    if (cat != null) out = { ...out, category: cat, pluggyCategory: t.category, categorySource: manual != null ? 'manual' : 'rule' };
    if (t.direction !== 'out') return out;
    const own = t.id ? byTarget.get(`tx:${t.id}`) : null;
    const list = own || (t.purchaseKey ? byTarget.get(`purchase:${t.purchaseKey}`) : null);
    if (!list) return out;
    // na compra parcelada a divisão é proporcional: vale para parcelas de valor diferente
    const sh = list.map((x) => ({ personId: x.personId, amount: round2(Math.min(t.amount, own ? x.amount : (x.amount / x.baseAmount) * t.amount)) }));
    const others = sh.reduce((a, x) => a + x.amount, 0);
    return { ...out, shares: sh, shareScope: own ? 'tx' : 'purchase', myAmount: round2(Math.max(0, t.amount - others)) };
  };
}
async function categorize(list) {
  const fn = await annotator();
  return list.map(fn);
}

// Todas as transações (para o saldo com cada pessoa). Com histórico lê do banco; sem, da Pluggy (com cache).
async function allTransactions() {
  const accounts = await listAccounts(false);
  if (DEMO) return demoTransactions();
  const lists = await Promise.all(accounts.map(async (acc) => {
    const raw = HISTORY ? await store.getTransactions(acc.id) : await cached(`txall:${acc.id}`, () => fetchAllTransactions(acc.id));
    return raw.map((t) => normalizeTransaction(t, acc));
  }));
  return lists.flat();
}

async function peopleSummary() {
  const [people, payments, tx] = await Promise.all([store.listPeople(), store.listPayments(), allTransactions().then(categorize)]);
  const shared = tx.filter((t) => t.shares).sort((a, b) => b.date.localeCompare(a.date));
  return people.map((p) => {
    const items = [];
    for (const t of shared) {
      const sh = t.shares.find((x) => x.personId === p.id);
      if (sh) items.push({ id: t.id, date: t.date, description: t.description, accountId: t.accountId, installment: t.installment, total: t.amount, amount: sh.amount, scope: t.shareScope });
    }
    const pays = payments.filter((x) => x.personId === p.id);
    const owed = round2(items.reduce((a, x) => a + x.amount, 0));
    const paid = round2(pays.reduce((a, x) => a + x.amount, 0));
    return { ...p, owed, paid, balance: round2(owed - paid), items, payments: pays };
  });
}

async function listBills(refresh) {
  const cards = (await listAccounts(refresh)).filter((a) => a.kind === 'credit');
  const cat = await annotator();
  return Promise.all(cards.map(async (acc) => {
    try {
      const s = (await billData(acc, refresh)).summary;
      return s.open?.upcoming?.length ? { ...s, open: { ...s.open, upcoming: s.open.upcoming.map(cat) } } : s;
    }
    catch (err) { console.error(`[faturas ${acc.id}]`, err.message); return { account: acc, bills: [], open: null, error: err.message }; }
  }));
}

async function billTransactions(accountId, billId, refresh) {
  const acc = (await listAccounts(refresh)).find((a) => a.id === accountId && a.kind === 'credit');
  if (!acc) throw new HttpError(404, 'Cartão não encontrado');
  const { tx } = await billData(acc, refresh);
  return categorize(tx.filter((t) => t.bill === billId).sort((a, b) => b.date.localeCompare(a.date)));
}

// ---------------------------------------------------------------- histórico (Postgres)
// Com Postgres, tudo que vem da Pluggy é gravado e as leituras saem do banco: o histórico continua
// disponível mesmo depois que a Pluggy deixa de devolvê-lo, e o app funciona com a Pluggy fora do ar.
const HISTORY = !DEMO && store.hasHistory;
const SYNC_HOURS = Number(process.env.SYNC_INTERVAL_HOURS || 6);

function txRow(t, acc) {
  const n = normalizeTransaction(t, acc);
  return {
    id: t.id, date_local: n.date, occurred_at: t.date, amount: t.amount, type: t.type ?? null, status: t.status ?? null,
    description: n.description, category: t.category ?? null, bill_id: n.billId, raw: t,
  };
}

function persistTx(acc, raw, scope) {
  return store.saveTransactions(acc.id, raw.map((t) => txRow(t, acc)), scope);
}

// Busca na Pluggy (com cache), grava no banco e lê do banco. Sem Postgres, devolve o que veio da Pluggy.
async function synced(key, refresh, fetchFn, persistFn, readFn) {
  try {
    const fresh = await cached(key, async () => {
      const v = await fetchFn();
      if (HISTORY) await Promise.resolve(persistFn(v)).catch((err) => console.error(`[histórico] ${key}:`, err.message));
      return v;
    }, refresh);
    return HISTORY ? await readFn() : fresh;
  } catch (err) {
    if (!HISTORY) throw err;
    console.error(`[pluggy indisponível] ${key}: ${err.message} — usando histórico salvo`);
    return readFn();
  }
}

// Sincronização completa: todas as transações (sem filtro de data) e faturas de todas as contas.
let syncing = null;
function syncAll(trigger) {
  if (!HISTORY) return Promise.resolve(null);
  if (syncing) return syncing;
  syncing = (async () => {
    const run = { startedAt: new Date(), trigger, accounts: 0, fetched: 0, inserted: 0, updated: 0, removed: 0, error: null };
    const errors = [];
    try {
      for (const acc of await listAccounts(true)) {
        try {
          const r = await persistTx(acc, await fetchAllTransactions(acc.id), {});
          for (const k of ['fetched', 'inserted', 'updated', 'removed']) run[k] += r[k];
          if (acc.kind === 'credit') await store.saveBills(acc.id, await fetchBills(acc.id));
          run.accounts++;
        } catch (err) { errors.push(`${acc.name || acc.id}: ${err.message}`); }
      }
    } catch (err) { errors.push(err.message); }
    run.error = errors.join('; ') || null;
    await store.logSync(run).catch((err) => console.error('[sync]', err.message));
    cache.clear();
    console.log(`[sync ${trigger}] ${run.accounts} conta(s) · ${run.fetched} lidas · ${run.inserted} novas · ${run.updated} alteradas · ${run.removed} removidas${run.error ? ' · erros: ' + run.error : ''}`);
    return run;
  })().finally(() => { syncing = null; });
  return syncing;
}

async function listTransactions({ from, to, accountIds, refresh }) {
  const accounts = await listAccounts(refresh);
  const selected = accountIds?.length ? accounts.filter((a) => accountIds.includes(a.id)) : accounts;
  if (DEMO) {
    return categorize(demoTransactions().filter((t) =>
      t.date >= from && t.date <= to && selected.some((a) => a.id === t.accountId)));
  }
  const lists = await Promise.all(selected.map(async (acc) => {
    const raw = await synced(`tx:${acc.id}:${from}:${to}`, refresh,
      () => fetchAllTransactions(acc.id, from, to),
      (r) => persistTx(acc, r, { from, to }),
      () => store.getTransactions(acc.id, shiftDate(from, -1), shiftDate(to, 1)));
    return raw.map((t) => normalizeTransaction(t, acc)).filter((t) => t.date >= from && t.date <= to);
  }));
  return categorize(lists.flat().sort((a, b) => b.date.localeCompare(a.date)));
}

// ---------------------------------------------------------------- webhooks Pluggy
// A Pluggy avisa por POST em PUBLIC_URL/webhooks/pluggy/<segredo>. O conteúdo do aviso só é registrado:
// a reação é sempre buscar os dados de novo na API (nada do corpo é usado como dado).
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
const WEBHOOK_PATH = '/webhooks/pluggy/';
const WEBHOOK_EVENTS = [
  'item/updated',            // conexão terminou de atualizar
  'item/error',              // conexão falhou
  'item/waiting_user_input', // banco pede ação (MFA, novo login)
  'item/login_succeeded',
  'transactions/created',
  'transactions/updated',
  'transactions/deleted',
];
const webhook = { enabled: false, url: null, registered: [], error: null, checkedAt: null };
let webhookSecret = null;

async function setupWebhooks() {
  if (DEMO || !PUBLIC_URL) return;
  if (!/^https:\/\//.test(PUBLIC_URL)) { webhook.error = 'PUBLIC_URL precisa ser https://'; console.error('[webhooks]', webhook.error); return; }
  try {
    webhookSecret = process.env.WEBHOOK_SECRET || await store.getSetting('webhook_secret');
    if (!webhookSecret) { webhookSecret = crypto.randomBytes(24).toString('base64url'); await store.setSetting('webhook_secret', webhookSecret); }
    const url = `${PUBLIC_URL}${WEBHOOK_PATH}${webhookSecret}`;
    const existing = (await pluggy('/webhooks')).results || [];
    const ours = (w) => String(w.url || '').includes(WEBHOOK_PATH);
    // remove os nossos que apontam para outra URL (domínio ou segredo trocado); não toca em webhooks de terceiros
    for (const w of existing.filter((w) => ours(w) && w.url !== url)) await pluggy(`/webhooks/${w.id}`, { method: 'DELETE' });
    const have = new Set(existing.filter((w) => w.url === url).map((w) => w.event));
    for (const event of WEBHOOK_EVENTS.filter((e) => !have.has(e))) await pluggy('/webhooks', { method: 'POST', body: { event, url } });
    Object.assign(webhook, { enabled: true, url, registered: WEBHOOK_EVENTS, error: null, checkedAt: new Date().toISOString() });
    console.log(`[webhooks] ${WEBHOOK_EVENTS.length} evento(s) → ${PUBLIC_URL}${WEBHOOK_PATH}…`);
  } catch (err) {
    webhook.error = err.message;
    console.error('[webhooks] falha ao registrar:', err.message);
  }
}

// Vários avisos em sequência (ex.: um por conta) viram uma única sincronização.
let webhookTimer = null;
function scheduleSync(reason) {
  clearTimeout(webhookTimer);
  webhookTimer = setTimeout(() => (syncing || Promise.resolve()).then(() => syncAll(`webhook ${reason}`)), 10_000);
}

// Atualização manual de um item: depois do PATCH a Pluggy coleta os dados no banco em segundo plano.
// Sem webhooks ninguém avisa quando termina, então acompanhamos o status do item e sincronizamos ao final.
const ITEM_POLL_MS = 10_000;
const ITEM_POLL_MAX_MS = 15 * 60_000;
const watching = new Map(); // itemId → { since, status }

function watchItem(itemId, status) {
  if (watching.has(itemId)) { watching.get(itemId).status = status; return; }
  const w = { since: Date.now(), status };
  watching.set(itemId, w);
  (async () => {
    while (Date.now() - w.since < ITEM_POLL_MAX_MS) {
      await new Promise((r) => setTimeout(r, ITEM_POLL_MS));
      try {
        const it = await pluggy(`/items/${itemId}`);
        w.status = it.status;
        if (it.status === 'UPDATING') continue;
        console.log(`[item ${itemId}] atualização terminou: ${it.status}${it.executionStatus ? ' / ' + it.executionStatus : ''}`);
        cache.clear();
        // com webhooks ativos, o item/updated já dispara a sincronização
        if (!webhook.enabled) await (syncing || Promise.resolve()).then(() => syncAll(`manual item ${itemId.slice(0, 8)}`));
        return;
      } catch (err) { console.error(`[item ${itemId}]`, err.message); }
    }
    console.error(`[item ${itemId}] ainda atualizando após ${ITEM_POLL_MAX_MS / 60_000} min; desisti de acompanhar`);
  })().finally(() => watching.delete(itemId));
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

async function handleWebhook(req, res, url) {
  const given = url.pathname.slice(WEBHOOK_PATH.length);
  if (req.method !== 'POST' || !webhookSecret || !safeEqual(given, webhookSecret)) { res.writeHead(404); return res.end(); }
  let body;
  try { body = await readBody(req, 1e6); } catch { res.writeHead(400); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}'); // responde rápido; o trabalho segue em segundo plano
  const event = typeof body.event === 'string' ? body.event : 'desconhecido';
  console.log(`[webhook] ${event}${body.itemId ? ' item ' + body.itemId : ''}`);
  store.logWebhook({ event, itemId: body.itemId, accountId: body.accountId, payload: body }).catch((err) => console.error('[webhook log]', err.message));
  cache.clear(); // status do item e contas são relidos na próxima consulta
  if (event.startsWith('transactions/') || event === 'item/updated' || event === 'item/login_succeeded') scheduleSync(event);
}

// ---------------------------------------------------------------- http
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit = 1e5) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > limit) throw new HttpError(413, 'Payload muito grande'); }
  return raw ? JSON.parse(raw) : {};
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function categoryName(v, what = 'da categoria') {
  const name = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) throw new HttpError(400, `Nome ${what} deve ter de 1 a 40 caracteres`);
  return name;
}
const UUID = /^[0-9a-f-]{36}$/;
const ID = /^[A-Za-z0-9-]{8,64}$/;

async function handleApi(req, res, url) {
  const refresh = url.searchParams.get('refresh') === '1';
  const route = `${req.method} ${url.pathname}`;

  if (route === 'GET /api/me') return send(res, 200, { authEnabled: auth.enabled, user: req.user || null });

  if (route === 'GET /api/status') {
    const ids = DEMO ? [] : await loadItemIds();
    const items = await Promise.all(ids.map(async (id) => {
      try {
        const it = await getItem(id, refresh);
        const w = watching.get(id); // status vindo do acompanhamento é mais novo que o do cache
        return { id, connector: it.connector?.name, status: w?.status || it.status, executionStatus: it.executionStatus, lastUpdatedAt: it.lastUpdatedAt, error: it.error?.message ?? null, watching: !!w };
      } catch (err) {
        return { id, connector: null, status: 'NOT_FOUND', error: err.message };
      }
    }));
    const removable = await store.listItems();
    return send(res, 200, { demo: DEMO, items: items.map((i) => ({ ...i, removable: removable.includes(i.id) })) });
  }

  if (route === 'GET /api/accounts') return send(res, 200, await listAccounts(refresh));

  if (route === 'GET /api/transactions') {
    const from = url.searchParams.get('from');
    const to = url.searchParams.get('to');
    if (!ISO_DATE.test(from || '') || !ISO_DATE.test(to || '')) throw new HttpError(400, 'Parâmetros from/to devem ser YYYY-MM-DD');
    const accountIds = (url.searchParams.get('accountIds') || '').split(',').filter(Boolean);
    return send(res, 200, await listTransactions({ from, to, accountIds, refresh }));
  }

  if (route === 'POST /api/items') {
    if (DEMO) throw new HttpError(400, 'Configure PLUGGY_CLIENT_ID e PLUGGY_CLIENT_SECRET no .env para adicionar conexões.');
    const { itemId } = await readBody(req);
    if (!ID.test(itemId || '')) throw new HttpError(400, 'itemId inválido');
    await getItem(itemId, true); // valida que existe
    await store.addItem(itemId);
    cache.clear();
    return send(res, 201, { ok: true });
  }

  if (route === 'GET /api/goals') return send(res, 200, await store.getGoals());

  const g = url.pathname.match(/^\/api\/goals\/([A-Za-z0-9-]{8,64})$/);
  if (g && req.method === 'PUT') {
    // Corpo parcial: { weekly?, monthly? }. null/'' remove o campo.
    const body = await readBody(req);
    const patch = {};
    for (const k of ['weekly', 'monthly']) {
      if (!(k in body)) continue;
      if (body[k] == null || body[k] === '') { patch[k] = null; continue; }
      const v = Number(body[k]);
      if (!Number.isFinite(v) || v <= 0 || v > 1e7) throw new HttpError(400, 'Meta deve ser um valor positivo');
      patch[k] = Math.round(v * 100) / 100;
    }
    await store.setGoal(g[1], patch);
    return send(res, 200, await store.getGoals());
  }

  if (route === 'GET /api/history') {
    if (!HISTORY) return send(res, 200, { enabled: false, reason: DEMO ? 'demo' : 'sem Postgres (DATABASE_URL)' });
    return send(res, 200, { enabled: true, intervalHours: SYNC_HOURS, syncing: !!syncing, ...(await store.historyStatus()) });
  }
  if (route === 'POST /api/history/sync') {
    if (!HISTORY) throw new HttpError(400, 'Histórico desativado (modo demonstração ou sem Postgres)');
    return send(res, 200, await syncAll('manual'));
  }

  if (route === 'GET /api/webhooks') {
    const masked = webhook.url ? webhook.url.replace(/[^/]+$/, '••••') : null;
    return send(res, 200, { ...webhook, url: masked, configured: !!PUBLIC_URL, events: await store.lastWebhooks(10).catch(() => []) });
  }

  // ---- categorias
  if (route === 'GET /api/categories') {
    const [custom, { rules }] = await Promise.all([store.listCategories(), store.getCategoryState()]);
    return send(res, 200, { custom, rules });
  }
  if (route === 'POST /api/categories') {
    const name = categoryName((await readBody(req)).name);
    return send(res, 201, await store.createCategory(crypto.randomUUID(), name));
  }
  const rr = url.pathname.match(/^\/api\/categories\/rules\/(\d{1,12})$/);
  if (rr && req.method === 'DELETE') {
    if (!(await store.deleteRule(Number(rr[1])))) throw new HttpError(404, 'Regra não encontrada');
    return send(res, 200, { ok: true });
  }
  const cm = url.pathname.match(/^\/api\/categories\/([0-9a-f-]{36})$/);
  if (cm && req.method === 'PATCH') {
    if (!(await store.renameCategory(cm[1], categoryName((await readBody(req)).name)))) throw new HttpError(404, 'Categoria não encontrada');
    return send(res, 200, { ok: true });
  }
  if (cm && req.method === 'DELETE') {
    if (!(await store.deleteCategory(cm[1]))) throw new HttpError(404, 'Categoria não encontrada');
    return send(res, 200, { ok: true });
  }
  // { category: "custom:<id>" | categoria da Pluggy | null, similar?: bool, description? }
  // similar = vale para todas as transações com a mesma descrição, inclusive as que ainda vão chegar.
  const tc = url.pathname.match(/^\/api\/transactions\/([A-Za-z0-9_-]{1,100})\/category$/);
  if (tc && req.method === 'PUT') {
    const body = await readBody(req);
    let category = body.category == null || body.category === '' ? null : String(body.category);
    if (category != null) {
      if (category.length > 80) throw new HttpError(400, 'Categoria inválida');
      if (category.startsWith('custom:') && !(await store.listCategories()).some((c) => `custom:${c.id}` === category)) throw new HttpError(400, 'Categoria não existe');
    }
    if (body.similar) {
      const match = ruleKey(body.description);
      if (!match) throw new HttpError(400, 'Descrição obrigatória para aplicar às semelhantes');
      await store.setRule(match, category);
      await store.setTxCategory(tc[1], null); // esta passa a seguir a regra
    } else {
      await store.setTxCategory(tc[1], category);
    }
    return send(res, 200, { ok: true });
  }

  // ---- pessoas e despesas divididas
  if (route === 'GET /api/people') return send(res, 200, await peopleSummary());
  if (route === 'POST /api/people') {
    return send(res, 201, await store.createPerson(crypto.randomUUID(), categoryName((await readBody(req)).name, 'da pessoa')));
  }
  const pp = url.pathname.match(/^\/api\/people\/payments\/(\d{1,12})$/);
  if (pp && req.method === 'DELETE') {
    if (!(await store.deletePayment(Number(pp[1])))) throw new HttpError(404, 'Pagamento não encontrado');
    return send(res, 200, { ok: true });
  }
  const pm = url.pathname.match(/^\/api\/people\/([0-9a-f-]{36})(\/payments)?$/);
  if (pm) {
    const [, personId, pay] = pm;
    if (!(await store.listPeople()).some((x) => x.id === personId)) throw new HttpError(404, 'Pessoa não encontrada');
    if (!pay && req.method === 'PATCH') { await store.renamePerson(personId, categoryName((await readBody(req)).name, 'da pessoa')); return send(res, 200, { ok: true }); }
    if (!pay && req.method === 'DELETE') { await store.deletePerson(personId); return send(res, 200, { ok: true }); }
    if (pay && req.method === 'POST') {
      const body = await readBody(req);
      const amount = round2(Number(body.amount));
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1e7) throw new HttpError(400, 'Valor do pagamento inválido');
      const date = body.date || todayIso();
      if (!ISO_DATE.test(date)) throw new HttpError(400, 'Data inválida');
      const note = body.note ? String(body.note).slice(0, 120) : null;
      return send(res, 201, { id: await store.addPayment(personId, date, amount, note) });
    }
  }
  // { shares: [{ personId, amount }], scope: 'tx' | 'purchase' } — lista vazia remove a divisão
  // scope 'purchase' (compra parcelada): vale para todas as parcelas, proporcional ao valor de cada uma
  const ts = url.pathname.match(/^\/api\/transactions\/([A-Za-z0-9_-]{1,100})\/shares$/);
  if (ts && req.method === 'PUT') {
    const body = await readBody(req);
    const t = (await allTransactions()).find((x) => x.id === ts[1]);
    if (!t) throw new HttpError(404, 'Transação não encontrada');
    if (t.direction !== 'out') throw new HttpError(400, 'Só despesas podem ser divididas');
    const ids = new Set((await store.listPeople()).map((x) => x.id));
    const list = (Array.isArray(body.shares) ? body.shares : []).map((x) => ({ personId: String(x.personId), amount: round2(Number(x.amount)), baseAmount: t.amount }));
    for (const x of list) {
      if (!ids.has(x.personId)) throw new HttpError(400, 'Pessoa não encontrada');
      if (!Number.isFinite(x.amount) || x.amount <= 0) throw new HttpError(400, 'Cada parte deve ter um valor positivo');
    }
    if (new Set(list.map((x) => x.personId)).size !== list.length) throw new HttpError(400, 'Pessoa repetida na divisão');
    if (list.reduce((a, x) => a + x.amount, 0) > t.amount + 0.005) throw new HttpError(400, `As partes somam mais que a despesa (${t.amount.toFixed(2)})`);
    const purchase = body.scope === 'purchase' && t.purchaseKey;
    if (purchase) await store.setShares(`purchase:${t.purchaseKey}`, list);
    // a própria transação passa a seguir a compra (ou recebe a divisão só dela)
    await store.setShares(`tx:${t.id}`, purchase ? [] : list);
    return send(res, 200, { ok: true });
  }

  if (route === 'GET /api/bills') return send(res, 200, await listBills(refresh));

  if (route === 'GET /api/bills/transactions') {
    const accountId = url.searchParams.get('accountId') || '';
    const billId = url.searchParams.get('billId') || '';
    if (!ID.test(accountId) || !(billId === 'open' || ID.test(billId))) throw new HttpError(400, 'accountId/billId inválidos');
    return send(res, 200, await billTransactions(accountId, billId, refresh));
  }

  let m = url.pathname.match(/^\/api\/items\/([A-Za-z0-9-]+)(\/sync)?$/);
  if (m && !DEMO) {
    const [, itemId, sync] = m;
    if (req.method === 'DELETE' && !sync) {
      await store.removeItem(itemId);
      cache.clear();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sync) {
      const r = await pluggy(`/items/${itemId}`, { method: 'PATCH', body: {} });
      cache.clear();
      watchItem(itemId, r.status);
      return send(res, 200, { ok: true, status: r.status });
    }
  }

  throw new HttpError(404, 'Rota não encontrada');
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url.pathname.startsWith(WEBHOOK_PATH)) return handleWebhook(req, res, url).catch((err) => console.error('[webhook]', err.message));
  try {
    if (await auth.handle(req, res, url)) return;
    if (auth.enabled && !PUBLIC_FILES.has(url.pathname)) {
      req.user = await auth.getUser(req);
      if (!req.user) {
        if (url.pathname.startsWith('/api/')) return send(res, 401, { error: 'Faça login' });
        res.writeHead(302, { Location: '/login.html' }); return res.end();
      }
      // requisições que alteram dados precisam vir do próprio app
      const origin = req.headers.origin;
      if (!['GET', 'HEAD'].includes(req.method) && origin && origin !== auth.origin(req)) return send(res, 403, { error: 'Origem inválida' });
    }
    if (!auth.enabled && url.pathname === '/login.html') { res.writeHead(302, { Location: '/' }); return res.end(); }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (err) {
    console.error(err.message);
    if (err instanceof DuplicateError) return send(res, 409, { error: err.message });
    send(res, err.status || 500, { error: err.message });
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => server.close(() => store.close().finally(() => process.exit(0))));

setupWebhooks();
if (HISTORY) {
  setTimeout(() => syncAll('inicialização'), 5000);
  setInterval(() => syncAll('agendada'), SYNC_HOURS * 3600 * 1000);
}

server.listen(PORT, HOST, () => {
  console.log(`Persistência: ${store.kind}${HISTORY ? ` · histórico ativo, sincroniza a cada ${SYNC_HOURS}h` : ''}`);
  console.log(`Canguinha rodando em http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}${IN_CONTAINER ? ' (container: escutando em ' + HOST + ')' : ''}${DEMO ? '  (modo demonstração — sem credenciais Pluggy)' : ''}`);
});
