// Despesa nova sem categoria → pergunta no Telegram: manter a categoria da Pluggy ou escolher outra.
// A resposta vira uma regra pela descrição (a mesma de "aplicar a todas com esta descrição" no app),
// então as próximas despesas com essa descrição já chegam categorizadas e não geram nova pergunta.
import crypto from 'node:crypto';
import { CATEGORY_PT, INTERNAL, PAYMENT, isoAddDays } from '../public/shared.js';

const MAX_AGE_DAYS = 7;   // só pergunta por despesas recentes (evita enxurrada ao importar o histórico)
const MAX_PER_BATCH = 10; // acima disso, um aviso só
// atalhos na primeira tela; o resto fica em "Mais categorias"
const QUICK = ['Eating out', 'Food delivery', 'Groceries', 'Taxi and ride-hailing', 'Gas stations', 'Pharmacy', 'Shopping', 'Leisure'];

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dm = (iso) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const fits = (data) => Buffer.byteLength(data) <= 64; // limite do callback_data do Telegram
const rows = (buttons, n) => Array.from({ length: Math.ceil(buttons.length / n) }, (_, i) => buttons.slice(i * n, i * n + n));

// Categorias da Pluggy com nome em português, sem repetir nomes (ex.: Health/Healthcare = Saúde).
const PLUGGY = (() => {
  const seen = new Set();
  return Object.entries(CATEGORY_PT)
    .filter(([k, v]) => k !== 'Sem categoria' && !INTERNAL.test(k) && !seen.has(v) && seen.add(v))
    .sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'))
    .map(([k]) => k);
})();

/**
 * store: createPrompt, setPromptMessages, getPrompt, answerPrompt, setRule, getCategoryState, listCategories, createCategory
 * ruleKey: mesma normalização das regras do app
 */
export function createCategorizer({ store, ruleKey, today, log = console }) {
  let bot = null;
  const awaitingName = new Map(); // `${chatId}:${messageId}` da pergunta "nome da nova categoria" → promptId

  const customMap = async () => new Map((await store.listCategories()).map((c) => [`custom:${c.id}`, c.name]));
  const nameOf = (cat, custom) => custom.get(cat) || (String(cat).startsWith('custom:') ? 'Categoria removida' : CATEGORY_PT[cat] || cat);
  const btn = (text, data) => (fits(data) ? { text, callback_data: data } : null);

  async function keyboard(p, full) {
    const custom = await customMap();
    const kb = [];
    if (p.category && p.category !== 'Sem categoria') kb.push([btn(`✅ Manter: ${nameOf(p.category, custom)}`, `k:${p.id}`)]);
    const customBtns = [...custom].map(([k, name]) => btn(name, `c:${p.id}:${k}`)).filter(Boolean);
    kb.push(...rows(customBtns, 2));
    const pluggy = (full ? PLUGGY : QUICK).filter((k) => k !== p.category).map((k) => btn(CATEGORY_PT[k] || k, `c:${p.id}:${k}`)).filter(Boolean);
    kb.push(...rows(pluggy, full ? 3 : 2));
    kb.push(full
      ? [btn('« Voltar', `b:${p.id}`), btn('➕ Nova categoria', `n:${p.id}`)]
      : [btn('Mais categorias…', `m:${p.id}`), btn('➕ Nova categoria', `n:${p.id}`)]);
    return { inline_keyboard: kb };
  }

  // Chamado com as transações recém-inseridas (já normalizadas, com `accountName`).
  async function onNewTransactions(list) {
    if (!bot || !bot.chats.length || !list.length) return;
    const minDate = isoAddDays(today(), -MAX_AGE_DAYS);
    const { overrides, rules } = await store.getCategoryState();
    const ruled = new Set(rules.map((r) => r.match));
    const seen = new Set();
    const pending = list
      .filter((t) => t.direction === 'out' && t.date >= minDate && !overrides[t.id])
      .filter((t) => !INTERNAL.test(t.category) && !INTERNAL.test(t.description) && !PAYMENT.test(t.category) && !PAYMENT.test(t.description))
      .map((t) => ({ t, match: ruleKey(t.description) }))
      .filter(({ match }) => match && !ruled.has(match) && !seen.has(match) && seen.add(match))
      .sort((a, b) => a.t.date.localeCompare(b.t.date));

    const custom = await customMap();
    let sent = 0;
    for (const { t, match } of pending) {
      if (sent >= MAX_PER_BATCH) break;
      const body = [
        '🧾 <b>Despesa nova sem categoria</b>',
        `<b>${esc(t.description.replace(/\s+/g, ' '))}</b>${t.installment ? ` ${t.installment}` : ''}`,
        `${BRL.format(t.amount)} · ${dm(t.date)} · ${esc(t.accountName || '')}`,
        `Categoria da Pluggy: <b>${esc(nameOf(t.category, custom))}</b>`,
      ].join('\n');
      const id = await store.createPrompt({ match, txId: t.id, description: t.description, category: t.category, body });
      if (!id) continue; // já existe pergunta aberta para essa descrição
      const p = { id, category: t.category };
      const text = `${body}\n\n<i>Responda uma vez: as próximas com essa descrição seguem a mesma categoria.</i>`;
      const kb = await keyboard(p, false);
      const messages = [];
      for (const chatId of bot.chats) {
        try { messages.push({ chatId, messageId: (await bot.send(chatId, text, { reply_markup: kb })).message_id }); }
        catch (err) { log.error(`[categorizar] envio para ${chatId}:`, err.message); }
      }
      await store.setPromptMessages(id, messages);
      sent++;
    }
    const rest = pending.length - sent;
    if (sent >= MAX_PER_BATCH && rest > 0) {
      for (const chatId of bot.chats) {
        await bot.send(chatId, `…e mais ${rest} despesa(s) nova(s) sem categoria. Responda as de cima e categorize o resto no app.`).catch(() => {});
      }
    }
    if (sent) log.log(`[categorizar] ${sent} pergunta(s) enviada(s)`);
  }

  // Aplica a escolha: vira regra, fecha a pergunta e atualiza a mensagem em todos os chats.
  async function choose(p, category) {
    const custom = await customMap();
    const name = nameOf(category, custom);
    if (!(await store.answerPrompt(p.id, category))) return `Já tinha sido respondida`;
    await store.setRule(p.match, category);
    const done = `${p.body}\n\n✅ Categoria: <b>${esc(name)}</b>\n<i>As próximas com “${esc(p.match)}” vão direto para ${esc(name)}. Para mudar, use as regras em Categorias, no app.</i>`;
    for (const m of p.messages || []) await bot.edit(m.chatId, m.messageId, done).catch((err) => log.error('[categorizar] editar:', err.message));
    log.log(`[categorizar] "${p.match}" → ${category}`);
    return `Salvo: ${name}`;
  }

  async function validCategory(cat, p) {
    if (cat.startsWith('custom:')) return (await customMap()).has(cat);
    return cat === p.category || Object.hasOwn(CATEGORY_PT, cat);
  }

  async function onCallback(q) {
    const m = /^([kcmbn]):(\d+)(?::(.+))?$/.exec(q.data || '');
    if (!m) return null;
    const [, action, id, cat] = m;
    const p = await store.getPrompt(Number(id));
    if (!p) return 'Pergunta não encontrada';
    const chatId = q.message.chat.id, messageId = q.message.message_id;
    if (p.answered_at) {
      const custom = await customMap();
      await bot.editKeyboard(chatId, messageId, { inline_keyboard: [] }).catch(() => {});
      return `Já categorizada como ${nameOf(p.chosen, custom)}`;
    }
    if (action === 'k') return choose(p, p.category);
    if (action === 'c') {
      if (!(await validCategory(cat, p))) return 'Categoria não existe mais';
      return choose(p, cat);
    }
    if (action === 'm' || action === 'b') { await bot.editKeyboard(chatId, messageId, await keyboard(p, action === 'm')); return null; }
    if (action === 'n') {
      const ask = await bot.send(chatId, `Nome da nova categoria para <b>${esc(p.description)}</b>:`, {
        reply_markup: { force_reply: true, input_field_placeholder: 'Ex.: Lanches' },
      });
      awaitingName.set(`${chatId}:${ask.message_id}`, p.id);
      return 'Digite o nome da categoria';
    }
    return null;
  }

  // Resposta à pergunta "nome da nova categoria": cria (ou reaproveita) a categoria e aplica.
  async function onReply(msg) {
    const key = `${msg.chat.id}:${msg.reply_to_message.message_id}`;
    const promptId = awaitingName.get(key);
    if (!promptId) return false;
    const name = msg.text.replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40 || name.startsWith('/')) {
      await bot.send(msg.chat.id, 'O nome deve ter de 1 a 40 caracteres. Toque em ➕ Nova categoria de novo.');
      return true;
    }
    awaitingName.delete(key);
    const p = await store.getPrompt(promptId);
    if (!p || p.answered_at) { await bot.send(msg.chat.id, 'Essa despesa já foi categorizada.'); return true; }
    let cat = (await store.listCategories()).find((c) => c.name.toLowerCase() === name.toLowerCase());
    const created = !cat;
    if (!cat) cat = await store.createCategory(crypto.randomUUID(), name);
    const res = await choose(p, `custom:${cat.id}`);
    await bot.send(msg.chat.id, `${created ? 'Categoria criada e aplicada' : 'Categoria já existia: aplicada'}: <b>${esc(cat.name)}</b>${res.startsWith('Salvo') ? '' : ` (${esc(res)})`}`);
    return true;
  }

  return {
    attach(b) { bot = b; },
    onNewTransactions,
    onCallback,
    onReply,
  };
}
