// Comandos do bot (Telegram): respostas em HTML simples, com os mesmos cálculos do dashboard (public/shared.js).
import * as G from '../public/shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (v) => BRL.format(v);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—');
const pct = (v) => `${Math.round(v)}%`;
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const sobra = (v) => (v >= 0 ? `sobra <b>${fmt(v)}</b>` : `<b>passou ${fmt(-v)}</b>`);
const inDays = (iso, today) => {
  const n = G.daysBetween(today, iso);
  return n < 0 ? `venceu ${dm(iso)}` : n === 0 ? 'vence <b>hoje</b>' : `vence ${dm(iso)} (em ${n} dia${n > 1 ? 's' : ''})`;
};

/**
 * deps: { today(), listAccounts(), listBills(), listTransactions({from,to,accountIds}), billTransactions(accountId, billId),
 *         getGoals(), listCategories() }
 */
export function botCommands(deps) {
  // Cartões (com faturas) + metas + lançamentos recentes; `filter` escolhe cartões pelo nome ou instituição.
  async function cardContext(filter) {
    const today = deps.today();
    const [all, goals] = await Promise.all([deps.listBills(), deps.getGoals()]);
    const q = plain(filter);
    const cards = all
      .filter((c) => c.error || c.bills.length || c.open?.txCount)
      .filter((c) => !q || plain(`${c.account.name} ${c.account.institution}`).includes(q));
    const ok = cards.filter((c) => !c.error);
    const tx = ok.length
      ? await deps.listTransactions({ from: G.isoAddDays(today, -7 * G.WEEKS - 7), to: today, accountIds: ok.map((c) => c.account.id) })
      : [];
    return {
      today,
      empty: !cards.length && (q ? `Nenhum cartão encontrado com "${esc(filter)}".` : 'Nenhum cartão com faturas.'),
      cards: cards.map((c) => {
        if (c.error) return { ...c, title: `<b>💳 ${esc(c.account.name)}</b>` };
        const items = G.spendItems(tx, c.account.id);
        const g = goals[c.account.id] || {};
        const week = G.weekStatus(items, g.weekly, today);
        const month = G.monthStatus(c, g.monthly, items, today);
        return { ...c, title: `<b>💳 ${esc(c.account.name)}</b>`, items, week, month };
      }),
    };
  }

  const perCard = (fn) => async (arg) => {
    const ctx = await cardContext(arg);
    if (ctx.empty) return ctx.empty;
    return ctx.cards.map((c) => (c.error ? `${c.title}\nErro ao ler as faturas: ${esc(c.error)}` : fn(c, ctx.today))).join('\n\n');
  };
  const noGoal = (c, which) => `${c.title}\nSem meta ${which}. Defina na aba <b>Faturas</b> do app.`;

  const diaria = perCard((c, today) => {
    const a = G.todayAllowance(c.items, today, { week: c.week, month: c.month });
    const lines = [`${c.title} · hoje ${dm(today)}`, `Gasto hoje: <b>${fmt(a.spentToday)}</b>${a.count ? ` (${a.count} compra${a.count > 1 ? 's' : ''})` : ''}`];
    if (!c.week && !c.month) return [...lines, 'Sem metas: defina na aba <b>Faturas</b> do app.'].join('\n');
    if (c.month) lines.push(`Meta mensal: pode gastar ${fmt(a.month)} hoje · ${sobra(a.month - a.spentToday)}`);
    if (c.week) lines.push(`Meta semanal: pode gastar ${fmt(a.week)} hoje · ${sobra(a.week - a.spentToday)}`);
    if (c.week && c.month) {
      const min = Math.min(a.week, a.month);
      lines.push(`➜ Vale a mais apertada (${a.week <= a.month ? 'semanal' : 'mensal'}): ${sobra(min - a.spentToday)}`);
    }
    const pace = c.month || c.week;
    lines.push(`${pace.ahead ? '▲ ' : ''}Média de ${fmt(pace.avgDaily)}/dia ${c.month ? 'no ciclo' : 'na semana'}, meta de ${fmt(pace.goalDaily)}/dia`);
    return lines.join('\n');
  });

  const semana = perCard((c) => {
    const w = c.week;
    if (!w) return noGoal(c, 'semanal');
    const st = w.pct > 100 ? `❌ estourou em ${fmt(-w.remaining)}` : `${w.pct >= 80 ? '⚠️' : '✅'} restam <b>${fmt(w.remaining)}</b>`;
    return [
      `${c.title} · semana ${dm(w.start)}–${dm(w.end)}`,
      `<b>${fmt(w.spent)}</b> de ${fmt(w.goal)} (${pct(w.pct)}) · ${st}`,
      `Pode gastar ${fmt(Math.max(0, w.remaining) / w.daysLeft)}/dia até domingo (${w.daysLeft === 1 ? 'só hoje' : `${w.daysLeft} dias`}) · ${w.count} compra(s)`,
      `${w.ahead ? '▲ ' : ''}Média de ${fmt(w.avgDaily)}/dia, meta de ${fmt(w.goalDaily)}/dia`,
    ].join('\n');
  });

  const mes = perCard((c) => {
    const m = c.month;
    if (!m) return noGoal(c, 'mensal');
    const est = m.estimated ? '~' : '';
    const st = m.spent > m.goal ? `❌ estourou em ${fmt(m.spent - m.goal)}` : `${m.pct >= 80 || m.ahead ? '⚠️' : '✅'} restam <b>${fmt(m.remaining)}</b>`;
    const lines = [
      `${c.title} · ${m.fallback ? 'mês' : 'ciclo'} ${dm(m.start)}–${est}${dm(m.end)}`,
      `<b>${fmt(m.spent)}</b> de ${fmt(m.goal)} (${pct(m.pct)}) · ${st}`,
    ];
    if (m.committed) lines.push(`(${fmt(m.posted)} lançados + ${fmt(m.committed)} em ${m.upcoming.length} parcela(s) prevista(s))`);
    lines.push(`Pode gastar: <b>${fmt(m.perDay)}/dia</b> · ${fmt(m.perWeek)}/semana · ${fmt(m.untilSunday)} até domingo`);
    lines.push(`Faltam ${m.daysLeft} dia(s) · média ${fmt(m.avgDaily)}/dia${m.ahead ? ' ▲' : ''}, meta ${fmt(m.goalDaily)}/dia`);
    if (m.elapsed >= 3) lines.push(`${m.projected > m.goal ? '⚠️ ' : ''}No ritmo atual fecha em ~${fmt(m.projected)}`);
    return lines.join('\n');
  });

  async function fatura(arg) {
    const ctx = await cardContext(arg);
    if (ctx.empty) return ctx.empty;
    const custom = new Map((await deps.listCategories()).map((x) => [`custom:${x.id}`, x.name]));
    const catName = (k) => custom.get(k) || (String(k).startsWith('custom:') ? 'Categoria removida' : G.CATEGORY_PT[k] || k);
    const blocks = await Promise.all(ctx.cards.map(async (c) => {
      if (c.error) return `${c.title}\nErro ao ler as faturas: ${esc(c.error)}`;
      const o = c.open, last = c.bills[0], a = c.account;
      const lines = [c.title];
      if (o) {
        lines.push(`<b>Fatura aberta: ${fmt(o.total)}</b>${o.upcomingTotal ? ` + ${fmt(o.upcomingTotal)} em parcelas previstas` : ''}`);
        lines.push(`Fecha ~${dm(o.closeDate)} · vence ~${dm(o.dueDate)} · ${o.txCount} lançamento(s)`);
      }
      if (last) lines.push(`Última fechada: <b>${fmt(last.total)}</b> · ${inDays(last.dueDate, ctx.today)}${last.minimum ? ` · mínimo ${fmt(last.minimum)}` : ''}`);
      if (a.creditLimit) lines.push(`Limite: ${fmt(a.balance)} usado de ${fmt(a.creditLimit)}${a.availableLimit != null ? ` · disponível ${fmt(a.availableLimit)}` : ''}`);
      if (c.month) lines.push(`Meta mensal: ${fmt(c.month.spent)} de ${fmt(c.month.goal)} · ${sobra(c.month.remaining)}`);

      const tx = o?.txCount ? await deps.billTransactions(a.id, 'open') : [];
      const byCat = {};
      for (const t of tx) if (t.direction === 'out') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      const cats = Object.entries(byCat).sort((x, y) => y[1] - x[1]).slice(0, 6);
      if (cats.length) lines.push('', '<b>Por categoria</b>', ...cats.map(([k, v]) => `• ${esc(catName(k))}: ${fmt(v)}`));
      if (tx.length) {
        lines.push('', `<b>Últimos lançamentos</b>${tx.length > 10 ? ` (10 de ${tx.length})` : ''}`);
        for (const t of tx.slice(0, 10)) {
          lines.push(`${dm(t.date)} ${esc(t.description.replace(/\s+/g, ' '))}${t.installment ? ` ${t.installment}` : ''} · ${t.direction === 'in' ? '−' : ''}${fmt(t.amount)}`);
        }
      }
      return lines.join('\n');
    }));
    return blocks.join('\n\n');
  }

  async function saldo() {
    const accounts = await deps.listAccounts();
    const banks = accounts.filter((a) => a.kind === 'bank');
    const cards = accounts.filter((a) => a.kind === 'credit');
    const lines = [];
    if (banks.length) {
      lines.push('<b>🏦 Contas</b>', ...banks.map((a) => `${esc(a.name)} (${esc(a.institution)}): ${fmt(a.balance)}`));
      lines.push(`Total: <b>${fmt(banks.reduce((s, a) => s + a.balance, 0))}</b>`);
    }
    if (cards.length) {
      lines.push('', '<b>💳 Cartões</b>', ...cards.map((a) => `${esc(a.name)}: ${fmt(a.balance)} usado${a.availableLimit != null ? ` · disponível ${fmt(a.availableLimit)}` : ''}`));
    }
    return lines.join('\n').trim() || 'Nenhuma conta conectada.';
  }

  const commands = [
    { name: 'diaria', aliases: ['hoje', 'dia'], description: 'Gasto de hoje e quanto ainda pode gastar', run: diaria },
    { name: 'semana', description: 'Meta semanal do cartão', run: semana },
    { name: 'mes', aliases: ['mensal', 'meta'], description: 'Meta mensal (ciclo da fatura)', run: mes },
    { name: 'fatura', description: 'Fatura aberta, última fechada e lançamentos', run: fatura },
    { name: 'saldo', description: 'Saldo das contas e limite dos cartões', run: saldo },
    { name: 'ajuda', aliases: ['start', 'help'], description: 'Lista os comandos' },
  ];
  commands.at(-1).run = async () => [
    '<b>🦘 Canguinha</b>',
    ...commands.filter((c) => c.name !== 'ajuda').map((c) => `/${c.name}: ${c.description}`),
    '',
    'Para ver um cartão só, escreva o nome depois do comando: <code>/fatura nubank</code>',
  ].join('\n');
  return commands;
}
