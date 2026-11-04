// Persistência do app: conexões (items) adicionadas pela tela, metas por cartão e — só no Postgres —
// o histórico de contas, transações e faturas vindo da Pluggy.
// Com DATABASE_URL usa Postgres; sem, cai nos arquivos JSON em data/ (sem histórico).
import fs from 'node:fs/promises';
import path from 'node:path';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS items (
     id          text PRIMARY KEY,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS goals (
     account_id  text PRIMARY KEY,
     weekly      double precision CHECK (weekly > 0),
     monthly     double precision CHECK (monthly > 0),
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS accounts (
     id          text PRIMARY KEY,
     item_id     text NOT NULL,
     kind        text NOT NULL,
     data        jsonb NOT NULL,          -- conta normalizada (o que o app usa)
     raw         jsonb NOT NULL,          -- resposta original da Pluggy
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS transactions (
     id            text PRIMARY KEY,
     account_id    text NOT NULL,
     date_local    date NOT NULL,         -- dia no fuso do app (America/Sao_Paulo)
     occurred_at   timestamptz,
     amount        double precision,
     type          text,
     status        text,
     description   text,
     category      text,
     bill_id       text,
     raw           jsonb NOT NULL,
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now(),
     removed_at    timestamptz             -- sumiu da Pluggy (ex.: pendente que virou outra); nunca apagamos
   )`,
  `CREATE INDEX IF NOT EXISTS transactions_account_date ON transactions (account_id, date_local)`,
  `CREATE TABLE IF NOT EXISTS bills (
     id            text PRIMARY KEY,
     account_id    text NOT NULL,
     due_date      date,
     close_date    date,
     total         double precision,
     raw           jsonb NOT NULL,
     first_seen_at timestamptz NOT NULL DEFAULT now(),
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS bills_account ON bills (account_id)`,
  `CREATE TABLE IF NOT EXISTS sync_runs (
     id          bigserial PRIMARY KEY,
     started_at  timestamptz NOT NULL,
     finished_at timestamptz NOT NULL DEFAULT now(),
     trigger     text NOT NULL,
     accounts    int NOT NULL DEFAULT 0,
     fetched     int NOT NULL DEFAULT 0,
     inserted    int NOT NULL DEFAULT 0,
     updated     int NOT NULL DEFAULT 0,
     removed     int NOT NULL DEFAULT 0,
     error       text
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key         text PRIMARY KEY,
     value       text NOT NULL,
     updated_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE TABLE IF NOT EXISTS webhook_events (
     id           bigserial PRIMARY KEY,
     received_at  timestamptz NOT NULL DEFAULT now(),
     event        text,
     item_id      text,
     account_id   text,
     payload      jsonb NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS webhook_events_received ON webhook_events (received_at DESC)`,
  `CREATE TABLE IF NOT EXISTS sessions (
     token_hash   text PRIMARY KEY,         -- sha256 do token do cookie; o token em si não é guardado
     email        text NOT NULL,
     name         text,
     picture      text,
     created_at   timestamptz NOT NULL DEFAULT now(),
     expires_at   timestamptz NOT NULL
   )`,
  // categorias criadas pelo usuário; nas transações aparecem como "custom:<id>"
  `CREATE TABLE IF NOT EXISTS categories (
     id          text PRIMARY KEY,
     name        text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS categories_name ON categories (lower(name))`,
  // categoria escolhida à mão para uma transação (custom:<id> ou uma categoria da Pluggy)
  `CREATE TABLE IF NOT EXISTS tx_categories (
     transaction_id text PRIMARY KEY,
     category       text NOT NULL,
     updated_at     timestamptz NOT NULL DEFAULT now()
   )`,
  // regra: toda transação com esta descrição (normalizada, sem "parcela x/y") vai para a categoria
  `CREATE TABLE IF NOT EXISTS category_rules (
     id          bigserial PRIMARY KEY,
     match       text NOT NULL UNIQUE,
     category    text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  // pessoas que passam despesas no seu cartão/conta
  `CREATE TABLE IF NOT EXISTS people (
     id          text PRIMARY KEY,
     name        text NOT NULL,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS people_name ON people (lower(name))`,
  // parte de uma despesa que é de outra pessoa. target = "tx:<id da transação>" ou
  // "purchase:<chave da compra parcelada>" (vale para todas as parcelas, proporcional a base_amount)
  `CREATE TABLE IF NOT EXISTS expense_shares (
     target       text NOT NULL,
     person_id    text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     amount       double precision NOT NULL CHECK (amount > 0),
     base_amount  double precision NOT NULL CHECK (base_amount > 0),
     created_at   timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (target, person_id)
   )`,
  // pagamentos que a pessoa te fez (abatem o que ela deve)
  `CREATE TABLE IF NOT EXISTS person_payments (
     id          bigserial PRIMARY KEY,
     person_id   text NOT NULL REFERENCES people(id) ON DELETE CASCADE,
     date        date NOT NULL,
     amount      double precision NOT NULL CHECK (amount > 0),
     note        text,
     created_at  timestamptz NOT NULL DEFAULT now()
   )`,
];

export class DuplicateError extends Error {}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createStore({ databaseUrl, dataDir }) {
  if (databaseUrl) return createPgStore(databaseUrl, dataDir);
  return createJsonStore(dataDir);
}

async function createPgStore(databaseUrl, dataDir) {
  const { default: pg } = await import('pg');
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 5 });
  pool.on('error', (err) => console.error('[postgres]', err.message));

  for (let attempt = 1; ; attempt++) {
    try { await pool.query('SELECT 1'); break; } catch (err) {
      if (attempt >= 30) throw new Error(`Postgres indisponível: ${err.message}`);
      console.log(`Aguardando Postgres (${attempt})…`);
      await sleep(1000);
    }
  }
  for (const sql of MIGRATIONS) await pool.query(sql);
  await importJsonIfEmpty(pool, dataDir);

  return {
    kind: 'postgres',
    hasHistory: true,

    // ---- histórico
    async saveAccounts(list) {
      if (!list.length) return;
      await pool.query(
        `INSERT INTO accounts (id, item_id, kind, data, raw)
         SELECT x.id, x.item_id, x.kind, x.data, x.raw FROM jsonb_to_recordset($1::jsonb) AS x(id text, item_id text, kind text, data jsonb, raw jsonb)
         ON CONFLICT (id) DO UPDATE SET item_id = EXCLUDED.item_id, kind = EXCLUDED.kind, data = EXCLUDED.data, raw = EXCLUDED.raw, updated_at = now()`,
        [JSON.stringify(list)]);
    },
    async getAccounts(itemId) {
      return (await pool.query('SELECT data FROM accounts WHERE item_id = $1 ORDER BY id', [itemId])).rows.map((r) => r.data);
    },

    // rows: [{ id, date_local, occurred_at, amount, type, status, description, category, bill_id, raw }]
    // scope: { from?, to? } — período que a Pluggy devolveu por completo (para detectar removidas)
    async saveTransactions(accountId, rows, scope = {}) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const up = rows.length ? (await client.query(
          `INSERT INTO transactions (id, account_id, date_local, occurred_at, amount, type, status, description, category, bill_id, raw)
           SELECT x.id, $1, x.date_local, x.occurred_at, x.amount, x.type, x.status, x.description, x.category, x.bill_id, x.raw
           FROM jsonb_to_recordset($2::jsonb) AS x(id text, date_local date, occurred_at timestamptz, amount double precision, type text,
                                                  status text, description text, category text, bill_id text, raw jsonb)
           ON CONFLICT (id) DO UPDATE SET
             account_id = EXCLUDED.account_id, date_local = EXCLUDED.date_local, occurred_at = EXCLUDED.occurred_at,
             amount = EXCLUDED.amount, type = EXCLUDED.type, status = EXCLUDED.status, description = EXCLUDED.description,
             category = EXCLUDED.category, bill_id = EXCLUDED.bill_id, raw = EXCLUDED.raw, updated_at = now(), removed_at = NULL
           WHERE transactions.raw IS DISTINCT FROM EXCLUDED.raw OR transactions.removed_at IS NOT NULL
           RETURNING (xmax = 0) AS inserted`,
          [accountId, JSON.stringify(rows)])).rows : [];
        // Some da Pluggy dentro do período coberto → marca removida. Antes da transação mais antiga que a Pluggy
        // devolveu, só pendentes (o resto pode ser histórico que a Pluggy já não guarda).
        const oldest = rows.reduce((m, r) => (!m || r.date_local < m ? r.date_local : m), null);
        const removed = (await client.query(
          `UPDATE transactions SET removed_at = now()
           WHERE account_id = $1 AND removed_at IS NULL AND NOT (id = ANY($2::text[]))
             AND ($3::date IS NULL OR date_local >= $3) AND ($4::date IS NULL OR date_local <= $4)
             AND (status = 'PENDING' OR ($5::date IS NOT NULL AND date_local >= $5))`,
          [accountId, rows.map((r) => r.id), scope.from ?? null, scope.to ?? null, oldest])).rowCount;
        await client.query('COMMIT');
        const inserted = up.filter((r) => r.inserted).length;
        return { fetched: rows.length, inserted, updated: up.length - inserted, removed };
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async getTransactions(accountId, from, to) {
      const { rows } = await pool.query(
        `SELECT raw FROM transactions
         WHERE account_id = $1 AND removed_at IS NULL AND ($2::date IS NULL OR date_local >= $2) AND ($3::date IS NULL OR date_local <= $3)
         ORDER BY date_local DESC, occurred_at DESC NULLS LAST`,
        [accountId, from ?? null, to ?? null]);
      return rows.map((r) => r.raw);
    },

    async saveBills(accountId, raws) {
      if (!raws.length) return;
      await pool.query(
        `INSERT INTO bills (id, account_id, due_date, close_date, total, raw)
         SELECT x->>'id', $1, (x->>'dueDate')::timestamptz::date, (x->>'billClosingDate')::timestamptz::date, (x->>'totalAmount')::double precision, x
         FROM jsonb_array_elements($2::jsonb) AS x
         ON CONFLICT (id) DO UPDATE SET due_date = EXCLUDED.due_date, close_date = EXCLUDED.close_date, total = EXCLUDED.total,
           raw = EXCLUDED.raw, updated_at = now()
         WHERE bills.raw IS DISTINCT FROM EXCLUDED.raw`,
        [accountId, JSON.stringify(raws)]);
    },
    async getBills(accountId) {
      return (await pool.query('SELECT raw FROM bills WHERE account_id = $1 ORDER BY due_date DESC', [accountId])).rows.map((r) => r.raw);
    },

    async createSession(hash, user, expiresAt) {
      await pool.query('INSERT INTO sessions (token_hash, email, name, picture, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [hash, user.email, user.name, user.picture, expiresAt]);
    },
    async getSession(hash) {
      return (await pool.query('SELECT email, name, picture FROM sessions WHERE token_hash = $1 AND expires_at > now()', [hash])).rows[0] || null;
    },
    async deleteSession(hash) { await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash]); },
    async purgeSessions() { await pool.query('DELETE FROM sessions WHERE expires_at <= now()'); },

    // ---- categorias
    async listCategories() {
      return (await pool.query('SELECT id, name FROM categories ORDER BY lower(name)')).rows;
    },
    async createCategory(id, name) {
      try { await pool.query('INSERT INTO categories (id, name) VALUES ($1, $2)', [id, name]); }
      catch (err) { if (err.code === '23505') throw new DuplicateError('Já existe uma categoria com esse nome'); throw err; }
      return { id, name };
    },
    async renameCategory(id, name) {
      try { return (await pool.query('UPDATE categories SET name = $2 WHERE id = $1', [id, name])).rowCount > 0; }
      catch (err) { if (err.code === '23505') throw new DuplicateError('Já existe uma categoria com esse nome'); throw err; }
    },
    // apaga a categoria e tudo que apontava para ela (as transações voltam à categoria da Pluggy)
    async deleteCategory(id) {
      const key = `custom:${id}`;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM tx_categories WHERE category = $1', [key]);
        await client.query('DELETE FROM category_rules WHERE category = $1', [key]);
        const n = (await client.query('DELETE FROM categories WHERE id = $1', [id])).rowCount;
        await client.query('COMMIT');
        return n > 0;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async getCategoryState() {
      const [o, r] = await Promise.all([
        pool.query('SELECT transaction_id, category FROM tx_categories'),
        pool.query('SELECT id, match, category FROM category_rules ORDER BY match'),
      ]);
      return { overrides: Object.fromEntries(o.rows.map((x) => [x.transaction_id, x.category])), rules: r.rows.map((x) => ({ ...x, id: Number(x.id) })) };
    },
    async setTxCategory(txId, category) {
      if (category == null) await pool.query('DELETE FROM tx_categories WHERE transaction_id = $1', [txId]);
      else await pool.query(
        `INSERT INTO tx_categories (transaction_id, category) VALUES ($1, $2)
         ON CONFLICT (transaction_id) DO UPDATE SET category = EXCLUDED.category, updated_at = now()`, [txId, category]);
    },
    async setRule(match, category) {
      if (category == null) await pool.query('DELETE FROM category_rules WHERE match = $1', [match]);
      else await pool.query(
        'INSERT INTO category_rules (match, category) VALUES ($1, $2) ON CONFLICT (match) DO UPDATE SET category = EXCLUDED.category', [match, category]);
    },
    async deleteRule(id) {
      return (await pool.query('DELETE FROM category_rules WHERE id = $1', [id])).rowCount > 0;
    },

    // ---- pessoas e despesas divididas
    async listPeople() {
      return (await pool.query('SELECT id, name FROM people ORDER BY lower(name)')).rows;
    },
    async createPerson(id, name) {
      try { await pool.query('INSERT INTO people (id, name) VALUES ($1, $2)', [id, name]); }
      catch (err) { if (err.code === '23505') throw new DuplicateError('Já existe uma pessoa com esse nome'); throw err; }
      return { id, name };
    },
    async renamePerson(id, name) {
      try { return (await pool.query('UPDATE people SET name = $2 WHERE id = $1', [id, name])).rowCount > 0; }
      catch (err) { if (err.code === '23505') throw new DuplicateError('Já existe uma pessoa com esse nome'); throw err; }
    },
    async deletePerson(id) { // divisões e pagamentos saem junto (ON DELETE CASCADE)
      return (await pool.query('DELETE FROM people WHERE id = $1', [id])).rowCount > 0;
    },
    async getShares() {
      const { rows } = await pool.query('SELECT target, person_id, amount, base_amount FROM expense_shares');
      return rows.map((r) => ({ target: r.target, personId: r.person_id, amount: r.amount, baseAmount: r.base_amount }));
    },
    // substitui as divisões de um alvo; lista vazia remove
    async setShares(target, list) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM expense_shares WHERE target = $1', [target]);
        for (const x of list) {
          await client.query('INSERT INTO expense_shares (target, person_id, amount, base_amount) VALUES ($1, $2, $3, $4)', [target, x.personId, x.amount, x.baseAmount]);
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    async listPayments() {
      const { rows } = await pool.query(`SELECT id, person_id, to_char(date, 'YYYY-MM-DD') AS date, amount, note FROM person_payments ORDER BY date DESC, id DESC`);
      return rows.map((r) => ({ id: Number(r.id), personId: r.person_id, date: r.date, amount: r.amount, note: r.note }));
    },
    async addPayment(personId, date, amount, note) {
      return Number((await pool.query('INSERT INTO person_payments (person_id, date, amount, note) VALUES ($1, $2, $3, $4) RETURNING id', [personId, date, amount, note])).rows[0].id);
    },
    async deletePayment(id) {
      return (await pool.query('DELETE FROM person_payments WHERE id = $1', [id])).rowCount > 0;
    },

    async getSetting(key) {
      return (await pool.query('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value ?? null;
    },
    async setSetting(key, value) {
      await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2)
                        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [key, value]);
    },
    async logWebhook(e) {
      await pool.query('INSERT INTO webhook_events (event, item_id, account_id, payload) VALUES ($1, $2, $3, $4)',
        [e.event ?? null, e.itemId ?? null, e.accountId ?? null, JSON.stringify(e.payload ?? {})]);
      await pool.query(`DELETE FROM webhook_events WHERE received_at < now() - interval '90 days'`);
    },
    async lastWebhooks(limit = 10) {
      return (await pool.query('SELECT received_at, event, item_id FROM webhook_events ORDER BY received_at DESC LIMIT $1', [limit])).rows;
    },

    async logSync(run) {
      await pool.query(
        `INSERT INTO sync_runs (started_at, trigger, accounts, fetched, inserted, updated, removed, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [run.startedAt, run.trigger, run.accounts, run.fetched, run.inserted, run.updated, run.removed, run.error ?? null]);
    },
    async historyStatus() {
      const [acc, last] = await Promise.all([
        pool.query(`SELECT a.id, a.data->>'name' AS name, a.data->>'institution' AS institution, a.kind,
                           count(t.id) FILTER (WHERE t.removed_at IS NULL) AS transactions,
                           min(t.date_local) FILTER (WHERE t.removed_at IS NULL) AS oldest,
                           max(t.date_local) FILTER (WHERE t.removed_at IS NULL) AS newest,
                           count(t.id) FILTER (WHERE t.removed_at IS NOT NULL) AS removed,
                           (SELECT count(*) FROM bills b WHERE b.account_id = a.id) AS bills
                    FROM accounts a LEFT JOIN transactions t ON t.account_id = a.id
                    GROUP BY a.id ORDER BY a.kind, name`),
        pool.query('SELECT * FROM sync_runs ORDER BY finished_at DESC LIMIT 1'),
      ]);
      const iso = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
      return {
        accounts: acc.rows.map((r) => ({ ...r, transactions: Number(r.transactions), removed: Number(r.removed), bills: Number(r.bills), oldest: iso(r.oldest), newest: iso(r.newest) })),
        lastSync: last.rows[0] || null,
      };
    },

    async listItems() {
      return (await pool.query('SELECT id FROM items ORDER BY created_at')).rows.map((r) => r.id);
    },
    async addItem(id) {
      await pool.query('INSERT INTO items (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    },
    async removeItem(id) {
      await pool.query('DELETE FROM items WHERE id = $1', [id]);
    },
    async getGoals() {
      const { rows } = await pool.query('SELECT account_id, weekly, monthly FROM goals');
      return Object.fromEntries(rows.map((r) => [r.account_id, clean({ weekly: r.weekly, monthly: r.monthly })]));
    },
    // patch: { weekly?: number|null, monthly?: number|null } — só altera os campos presentes
    async setGoal(accountId, patch) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const cur = (await client.query('SELECT weekly, monthly FROM goals WHERE account_id = $1 FOR UPDATE', [accountId])).rows[0] || {};
        const next = { weekly: cur.weekly ?? null, monthly: cur.monthly ?? null };
        for (const k of ['weekly', 'monthly']) if (k in patch) next[k] = patch[k];
        if (next.weekly == null && next.monthly == null) await client.query('DELETE FROM goals WHERE account_id = $1', [accountId]);
        else await client.query(
          `INSERT INTO goals (account_id, weekly, monthly, updated_at) VALUES ($1, $2, $3, now())
           ON CONFLICT (account_id) DO UPDATE SET weekly = EXCLUDED.weekly, monthly = EXCLUDED.monthly, updated_at = now()`,
          [accountId, next.weekly, next.monthly]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

// Na primeira subida com Postgres, traz o que estava nos arquivos JSON (se o diretório existir no container).
async function importJsonIfEmpty(pool, dataDir) {
  const read = async (f) => { try { return JSON.parse(await fs.readFile(path.join(dataDir, f), 'utf8')); } catch { return null; } };
  const [items, goals] = await Promise.all([read('items.json'), read('goals.json')]);
  const { rows: [{ n }] } = await pool.query('SELECT (SELECT count(*) FROM items) + (SELECT count(*) FROM goals) AS n');
  if (Number(n) > 0 || (!items?.length && !goals)) return;
  for (const id of items || []) await pool.query('INSERT INTO items (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  for (const [acc, g] of Object.entries(goals || {})) {
    await pool.query('INSERT INTO goals (account_id, weekly, monthly) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [acc, g.weekly ?? null, g.monthly ?? null]);
  }
  console.log(`Importado de ${dataDir}: ${items?.length || 0} item(s), ${Object.keys(goals || {}).length} meta(s)`);
}

const memSessions = new Map();

function createJsonStore(dataDir) {
  const ITEMS = path.join(dataDir, 'items.json');
  const GOALS = path.join(dataDir, 'goals.json');
  const read = async (f, dflt) => { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return dflt; } };
  const write = async (f, v) => { await fs.mkdir(dataDir, { recursive: true }); await fs.writeFile(f, JSON.stringify(v, null, 2)); };
  const CATS = path.join(dataDir, 'categories.json');
  const PEOPLE = path.join(dataDir, 'people.json');
  const readPeople = async () => ({ people: [], shares: [], payments: [], ...(await read(PEOPLE, {})) });
  const readCats = async () => ({ categories: [], overrides: {}, rules: [], ...(await read(CATS, {})) });
  return {
    kind: 'json',
    hasHistory: false,
    listItems: () => read(ITEMS, []),
    async addItem(id) { const ids = await read(ITEMS, []); if (!ids.includes(id)) await write(ITEMS, [...ids, id]); },
    async removeItem(id) { await write(ITEMS, (await read(ITEMS, [])).filter((i) => i !== id)); },
    getGoals: () => read(GOALS, {}),
    async getSetting(key) { return (await read(path.join(dataDir, 'settings.json'), {}))[key] ?? null; },
    async setSetting(key, value) { const f = path.join(dataDir, 'settings.json'); const v = await read(f, {}); v[key] = value; await write(f, v); },
    async logWebhook() {},
    // sessões só em memória (perdem-se ao reiniciar)
    async createSession(hash, user, expiresAt) { memSessions.set(hash, { ...user, expiresAt }); },
    async getSession(hash) { const s = memSessions.get(hash); return s && s.expiresAt > new Date() ? { email: s.email, name: s.name, picture: s.picture } : null; },
    async deleteSession(hash) { memSessions.delete(hash); },
    async purgeSessions() { for (const [k, s] of memSessions) if (s.expiresAt <= new Date()) memSessions.delete(k); },
    async lastWebhooks() { return []; },
    // categorias em data/categories.json: { categories: [{id,name}], overrides: {txId: cat}, rules: [{id,match,category}] }
    async listCategories() { return (await readCats()).categories.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')); },
    async createCategory(id, name) {
      const c = await readCats();
      if (c.categories.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new DuplicateError('Já existe uma categoria com esse nome');
      c.categories.push({ id, name }); await write(CATS, c); return { id, name };
    },
    async renameCategory(id, name) {
      const c = await readCats();
      const cat = c.categories.find((x) => x.id === id);
      if (!cat) return false;
      if (c.categories.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new DuplicateError('Já existe uma categoria com esse nome');
      cat.name = name; await write(CATS, c); return true;
    },
    async deleteCategory(id) {
      const c = await readCats(), key = `custom:${id}`;
      const n = c.categories.length;
      c.categories = c.categories.filter((x) => x.id !== id);
      for (const [k, v] of Object.entries(c.overrides)) if (v === key) delete c.overrides[k];
      c.rules = c.rules.filter((r) => r.category !== key);
      await write(CATS, c); return c.categories.length < n;
    },
    // pessoas em data/people.json: { people: [{id,name}], shares: [{target,personId,amount,baseAmount}], payments: [...] }
    async listPeople() { return (await readPeople()).people.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')); },
    async createPerson(id, name) {
      const d = await readPeople();
      if (d.people.some((x) => x.name.toLowerCase() === name.toLowerCase())) throw new DuplicateError('Já existe uma pessoa com esse nome');
      d.people.push({ id, name }); await write(PEOPLE, d); return { id, name };
    },
    async renamePerson(id, name) {
      const d = await readPeople();
      const p = d.people.find((x) => x.id === id);
      if (!p) return false;
      if (d.people.some((x) => x.id !== id && x.name.toLowerCase() === name.toLowerCase())) throw new DuplicateError('Já existe uma pessoa com esse nome');
      p.name = name; await write(PEOPLE, d); return true;
    },
    async deletePerson(id) {
      const d = await readPeople(), n = d.people.length;
      d.people = d.people.filter((x) => x.id !== id);
      d.shares = d.shares.filter((x) => x.personId !== id);
      d.payments = d.payments.filter((x) => x.personId !== id);
      await write(PEOPLE, d); return d.people.length < n;
    },
    async getShares() { return (await readPeople()).shares; },
    async setShares(target, list) {
      const d = await readPeople();
      d.shares = [...d.shares.filter((x) => x.target !== target), ...list.map((x) => ({ target, ...x }))];
      await write(PEOPLE, d);
    },
    async listPayments() { return (await readPeople()).payments.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id); },
    async addPayment(personId, date, amount, note) {
      const d = await readPeople();
      const id = Math.max(0, ...d.payments.map((x) => x.id)) + 1;
      d.payments.push({ id, personId, date, amount, note }); await write(PEOPLE, d); return id;
    },
    async deletePayment(id) {
      const d = await readPeople(), n = d.payments.length;
      d.payments = d.payments.filter((x) => x.id !== id); await write(PEOPLE, d); return d.payments.length < n;
    },
    async getCategoryState() { const c = await readCats(); return { overrides: c.overrides, rules: c.rules }; },
    async setTxCategory(txId, category) {
      const c = await readCats();
      if (category == null) delete c.overrides[txId]; else c.overrides[txId] = category;
      await write(CATS, c);
    },
    async setRule(match, category) {
      const c = await readCats();
      const r = c.rules.find((x) => x.match === match);
      if (category == null) c.rules = c.rules.filter((x) => x.match !== match);
      else if (r) r.category = category;
      else c.rules.push({ id: Math.max(0, ...c.rules.map((x) => x.id)) + 1, match, category });
      await write(CATS, c);
    },
    async deleteRule(id) {
      const c = await readCats(), n = c.rules.length;
      c.rules = c.rules.filter((x) => x.id !== id); await write(CATS, c); return c.rules.length < n;
    },
    async setGoal(accountId, patch) {
      const goals = await read(GOALS, {});
      const cur = { ...(goals[accountId] || {}) };
      for (const k of ['weekly', 'monthly']) if (k in patch) { if (patch[k] == null) delete cur[k]; else cur[k] = patch[k]; }
      if (Object.keys(cur).length) goals[accountId] = cur; else delete goals[accountId];
      await write(GOALS, goals);
    },
    close: async () => {},
  };
}

function clean(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
}
