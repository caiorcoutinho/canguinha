// Comandos do bot (Telegram): respostas em HTML simples, com os mesmos cálculos do dashboard (public/shared.js).
// Estilo: título em negrito, o número principal em destaque, poucas linhas curtas; alerta só quando há problema.
import * as G from '../public/shared.js';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const fmt = (v) => BRL.format(v);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dm = (iso) => (iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—');
const pct = (v) => `${Math.round(v)}%`;
const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const desc = (t) => esc(G.tidyDescription(t.description)) + (t.installment ? ` ${t.installment}` : '');
const name = (acc) => esc(G.titleCase(acc.name));
const days = (n) => `${n} dia${n === 1 ? '' : 's'}`;
const due = (iso, today) => {
  const n = G.daysBetween(today, iso);
  return n < 0 ? `venceu ${dm(iso)}` : n === 0 ? '<b>vence hoje</b>' : n === 1 ? 'vence amanhã' : `vence ${dm(iso)}`;
};
// "05/11/2026", "5/11/26", "05/11" (ano atual), "05-11-2026", "ontem", "anteontem", "" (hoje). Inválida → undefined.
function parseDay(arg, today) {
  const a = plain(arg).trim();
  if (!a || a === 'hoje') return today;
  if (a === 'ontem') return G.isoAddDays(today, -1);
  if (a === 'anteontem') return G.isoAddDays(today, -2);
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(a);
  if (!m) return undefined;
  const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +today.slice(0, 4);
  const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(`${iso}T12:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === iso ? iso : undefined;
}

// ---- meses ('YYYY-MM')
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const MONTHS_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const shiftMonth = (ym, n) => { const i = +ym.slice(0, 4) * 12 + +ym.slice(5) - 1 + n; return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`; };
// mesmo cálculo do servidor: dia limitado ao último do mês
const addMonths = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  const last = new Date(Date.UTC(y, m - 1 + n + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + n, Math.min(d, last))).toISOString().slice(0, 10);
};
const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5) - +a.slice(5));
const monthLabel = (ym) => `${MONTHS_PT[+ym.slice(5) - 1]}/${ym.slice(0, 4)}`;
// "dez", "dezembro", "dez/27", "dez 2027", "12", "12/2026", "12/26", "2026-12", "proximo", "+2". Sem ano: a próxima ocorrência (a partir do mês atual).
function parseMonth(s, today) {
  const a = plain(s).trim().replace(/\s+/, '/');
  const cur = today.slice(0, 7);
  if (/^(prox(imo)?|seguinte)$/.test(a)) return shiftMonth(cur, 1);
  if (/^(este|atual|mes)$/.test(a)) return cur;
  let m = /^\+(\d{1,2})$/.exec(a);
  if (m) return shiftMonth(cur, +m[1]);
  if ((m = /^(\d{4})-(\d{1,2})$/.exec(a))) return +m[2] >= 1 && +m[2] <= 12 ? `${m[1]}-${m[2].padStart(2, '0')}` : undefined;
  m = /^([a-z]+|\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(a);
  if (!m) return undefined;
  const mo = /^\d+$/.test(m[1]) ? +m[1] : (m[1].length >= 3 ? MONTHS.findIndex((x) => x.startsWith(m[1])) + 1 : 0);
  if (!(mo >= 1 && mo <= 12)) return undefined;
  const ym = (y) => `${y}-${String(mo).padStart(2, '0')}`;
  if (m[2]) return ym(m[2].length === 2 ? 2000 + +m[2] : +m[2]);
  const y = +today.slice(0, 4);
  return ym(y) >= cur ? ym(y) : ym(y + 1);
}
// Separa o mês (primeira palavra que é mês, com o ano logo depois, se houver) do resto do argumento.
// month: 'YYYY-MM'; undefined se parecia mês mas é inválido (13/2026).
function monthArg(arg, today) {
  const words = String(arg || '').trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const two = words[i + 1] && /^\d{4}$/.test(words[i + 1]) ? `${words[i]} ${words[i + 1]}` : null;
    const hit = (two && parseMonth(two, today)) || parseMonth(words[i], today);
    if (hit) return { month: hit, rest: words.filter((_, j) => j !== i && !(two && j === i + 1)).join(' ') };
    if (/^\d{1,2}([/.-]\d{2,4})?$/.test(words[i])) return { month: undefined, rest: '' };
  }
  return { month: today.slice(0, 7), rest: words.join(' ') };
}

const NO_GOAL = 'Sem meta definida. Crie na aba Faturas do app.';

/**
 * deps: { today(), listAccounts(), listBills(), listTransactions({from,to,accountIds}), billTransactions(accountId, billId),
 *         getGoals(), listCategories(), listPeople(), peopleSummary() }
 * Devolve { commands, resolve(name), menu() }: `resolve` acha comandos dinâmicos (/<nome da pessoa>),
 * `menu` lista os comandos para o menu do Telegram (fixos + pessoas).
 */
export function botCommands(deps) {
  // Cartões (com faturas) + metas + lançamentos recentes; `filter` escolhe cartões pelo nome ou instituição.
  // `day` (opcional, no passado): calcula tudo como se hoje fosse esse dia (ciclo e faturas daquela data).
  async function cardContext(filter, day) {
    const today = day || deps.today();
    const [all, goals] = await Promise.all([deps.listBills(), deps.getGoals()]);
    const q = plain(filter);
    const cards = all
      .filter((c) => c.error || c.bills.length || c.open?.txCount)
      .filter((c) => !q || plain(`${c.account.name} ${c.account.institution}`).includes(q));
    const ok = cards.filter((c) => !c.error);
    const tx = ok.length
      ? await deps.listTransactions({ from: G.isoAddDays(today, -7 * G.WEEKS - 7), to: today, accountIds: ok.map((c) => c.account.id) })
      : [];
    const asOf = (c) => {
      if (!day) return c;
      // faturas que já tinham fechado naquele dia; a "aberta" é a primeira que fecha a partir dele
      const bills = c.bills.filter((b) => b.closeDate && b.closeDate < day);
      const next = c.bills.filter((b) => b.closeDate && b.closeDate >= day).sort((a, b) => a.closeDate.localeCompare(b.closeDate))[0];
      const open = next ? { closeDate: next.closeDate, dueDate: next.dueDate, upcoming: [] } : c.open;
      const win = G.cycleWindow({ bills, open }, day);
      // fatura na manhã daquele dia (como as metas): lançamentos dessa fatura até a véspera (valor cheio, sem pagamentos).
      // Usa o vínculo com a fatura (billId; sem billId = aberta); se o banco não informa, a janela do ciclo.
      const mine = tx.filter((t) => t.accountId === c.account.id);
      const linked = mine.some((t) => t.billId);
      const inBill = (t) => (linked ? (next?.id ? t.billId === next.id : !t.billId) : t.date >= win.start);
      const total = mine.filter((t) => t.date < day && inBill(t) && !G.isCardPayment(t))
        .reduce((s, t) => s + (t.direction === 'out' ? t.amount : -t.amount), 0);
      return { ...c, bills, open: open && { ...open, total } };
    };
    return {
      today,
      empty: !cards.length && (q ? `Nenhum cartão com "${esc(filter)}".` : 'Nenhum cartão com faturas.'),
      cards: cards.map((c0) => {
        if (c0.error) return c0;
        const c = asOf(c0);
        const all = G.spendItems(tx, c.account.id);
        // dia passado: metas como na manhã daquele dia (sem o gasto dele); o gasto do dia vai à parte
        const items = day ? all.filter((t) => t.date < day) : all;
        const spentDay = day ? all.filter((t) => t.date === day).reduce((s, t) => s + t.net, 0) : 0;
        const g = goals[c.account.id] || {};
        return { ...c, items, spentDay, week: G.weekStatus(items, g.weekly, today, c), month: G.monthStatus(c, g.monthly, items, today) };
      }),
    };
  }

  const perCard = (fn) => async (arg) => {
    const ctx = await cardContext(arg);
    if (ctx.empty) return ctx.empty;
    return ctx.cards.map((c) => (c.error ? `<b>${name(c.account)}</b>\nNão consegui ler as faturas: ${esc(c.error)}` : fn(c, ctx.today))).join('\n\n');
  };

  // ---- /diaria
  const diaria = perCard((c, today) => {
    const a = G.todayAllowance(c.items, today, { week: c.week, month: c.month });
    const lines = [`<b>${name(c.account)}</b> · hoje`];
    if (!c.week && !c.month) return [...lines, `Gasto: ${fmt(a.spentToday)}`, NO_GOAL].join('\n');
    // com as duas metas, vale a mais apertada
    const useWeek = c.week && (!c.month || a.week < a.month);
    const limit = useWeek ? a.week : a.month;
    const left = limit - a.spentToday;
    lines.push(
      `Gasto: ${fmt(a.spentToday)} de ${fmt(limit)}`,
      left >= 0 ? `<b>Sobra ${fmt(left)}</b>` : `<b>Passou ${fmt(-left)}</b>`,
    );
    if (c.week && c.month) lines.push(`<i>pela meta ${useWeek ? 'semanal' : 'mensal'}, a mais apertada</i>`);
    const pace = c.month || c.week;
    if (pace.ahead) lines.push(`⚠️ Média de ${fmt(pace.avgDaily)}/dia, acima da meta (${fmt(pace.goalDaily)}/dia)`);
    return lines.join('\n');
  });

  // ---- /semana
  const semana = perCard((c) => {
    const w = c.week;
    if (!w) return `<b>${name(c.account)}</b>\n${NO_GOAL}`;
    const lines = [
      `<b>${name(c.account)}</b> · semana ${dm(w.start)} a ${dm(w.end)}`,
      `${fmt(w.spent)} de ${fmt(w.goal)} (${pct(w.pct)})`,
      w.remaining >= 0
        ? `<b>Restam ${fmt(w.remaining)}</b> · ${fmt(w.remaining / w.daysLeft)}/dia até domingo`
        : `<b>Passou ${fmt(-w.remaining)}</b>`,
    ];
    if (w.ahead && w.remaining >= 0) lines.push(`⚠️ Média de ${fmt(w.avgDaily)}/dia, acima da meta (${fmt(w.goalDaily)}/dia)`);
    return lines.join('\n');
  });

  // ---- /mes
  const mes = perCard((c) => {
    const m = c.month;
    if (!m) return `<b>${name(c.account)}</b>\n${NO_GOAL}`;
    const lines = [
      `<b>${name(c.account)}</b> · ${m.fallback ? 'mês' : 'ciclo'} ${dm(m.start)} a ${dm(m.end)}`,
      `${fmt(m.spent)} de ${fmt(m.goal)} (${pct(m.pct)})`,
      m.remaining >= 0
        ? `<b>Restam ${fmt(m.remaining)}</b> · ${fmt(m.perDay)}/dia por ${days(m.daysLeft)}`
        : `<b>Passou ${fmt(-m.remaining)}</b>`,
    ];
    if (m.committed) lines.push(`<i>inclui ${fmt(m.committed)} em parcelas que ainda vão cair</i>`);
    if (m.elapsed >= 3 && m.projected > m.goal) lines.push(`⚠️ No ritmo atual, fecha em ${fmt(m.projected)}`);
    return lines.join('\n');
  });

  // ---- /resumo: como o dia começa (também é enviado todo dia no horário de TELEGRAM_DAILY_SUMMARY)
  const WEEKDAY = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  // `/resumo 05/11/2026` (ou 05/11, ontem): o resumo como seria na manhã daquele dia, mais o que foi gasto nele.
  async function resumo(arg = '') {
    const real = deps.today();
    const day = parseDay(arg, real);
    if (day === undefined) return 'Data inválida. Use /resumo 05/11/2026, /resumo 05/11 ou /resumo ontem.';
    if (day > real) return 'Essa data ainda não chegou.';
    const past = day < real;
    const ctx = await cardContext('', past ? day : undefined);
    const today = ctx.today, yesterday = G.isoAddDays(today, -1);
    const wd = `${WEEKDAY[new Date(`${today}T12:00:00Z`).getUTCDay()]}, ${dm(today)}`;
    const head = past ? `📅 <b>Resumo de ${wd}/${today.slice(0, 4)}</b>` : `☀️ <b>Bom dia!</b> ${wd}`;
    if (ctx.empty) return `${head}\n\n${ctx.empty}`;
    const blocks = ctx.cards.map((c) => {
      if (c.error) return `<b>${name(c.account)}</b>\nNão consegui ler as faturas: ${esc(c.error)}`;
      const lines = [`<b>${name(c.account)}</b>`];
      if (c.week || c.month) {
        // máximo de hoje: com as duas metas, vale a mais apertada (igual ao /diaria)
        const a = G.todayAllowance(c.items, today, { week: c.week, month: c.month });
        const useWeek = c.week && (!c.month || a.week < a.month);
        const limit = useWeek ? a.week : a.month;
        if (past) lines.push(`No dia: podia até <b>${fmt(limit)}</b> · gastou ${fmt(Math.max(0, c.spentDay))}`);
        else lines.push(`Hoje: até <b>${fmt(Math.max(0, limit - a.spentToday))}</b>`);
        // máximo da semana (até domingo): meta semanal; sem ela, o que a meta mensal permite até domingo
        // (num dia passado, como estava de manhã)
        const w = c.week, m = c.month;
        if (w) lines.push(w.remaining >= 0 ? `Semana: até ${fmt(w.remaining)} de ${fmt(w.goal)}` : `Semana: passou ${fmt(-w.remaining)} da meta`);
        else if (m.remaining >= 0) {
          // orçamento da semana pela meta mensal, fixado no início da semana (ver monthStatus)
          lines.push(m.untilSunday >= 0
            ? `Semana: ${fmt(m.untilSunday)} de ${fmt(m.weekBudget)} <i>pela meta mensal</i>`
            : `Semana: passou ${fmt(-m.untilSunday)} de ${fmt(m.weekBudget)} <i>pela meta mensal</i>`);
        }
        else lines.push(`Mês: passou ${fmt(-m.remaining)} da meta`);
      } else lines.push(NO_GOAL);
      const o = c.open;
      if (past) lines.push(o?.closeDate ? `Fatura: <b>${fmt(o.total + (o.upcomingTotal || 0))}</b> · fechava ${dm(o.closeDate)}` : 'Fatura: nenhuma aberta');
      else lines.push(o ? `Fatura: <b>${fmt(o.total + (o.upcomingTotal || 0))}</b> · fecha ${dm(o.closeDate)}` : 'Fatura: nenhuma aberta');
      const ontem = c.items.filter((t) => t.date === yesterday).reduce((s, t) => s + t.net, 0);
      if (ontem > 0.004) lines.push(`<i>${past ? 'na véspera' : 'ontem'} gastou ${fmt(ontem)}</i>`);
      return lines.join('\n');
    });
    return [head, ...blocks].join('\n\n');
  }

  // ---- /fatura
  async function fatura(arg) {
    const ctx = await cardContext(arg);
    if (ctx.empty) return ctx.empty;
    const custom = new Map((await deps.listCategories()).map((x) => [`custom:${x.id}`, x.name]));
    const catName = (k) => custom.get(k) || (String(k).startsWith('custom:') ? 'Categoria removida' : G.CATEGORY_PT[k] || k);
    const blocks = await Promise.all(ctx.cards.map(async (c) => {
      if (c.error) return `<b>${name(c.account)}</b>\nNão consegui ler as faturas: ${esc(c.error)}`;
      const o = c.open, last = c.bills[0], a = c.account;
      const lines = [`<b>${name(a)}</b>`];
      if (o) {
        lines.push('', `Fatura aberta: <b>${fmt(o.total + (o.upcomingTotal || 0))}</b>`, `fecha ${dm(o.closeDate)} · vence ${dm(o.dueDate)}`);
        if (o.upcomingTotal) lines.push(`<i>${fmt(o.total)} lançados + ${fmt(o.upcomingTotal)} em parcelas que ainda vão cair</i>`);
      }
      if (last) {
        lines.push('', `Última fatura: <b>${fmt(last.total)}</b>`, `${due(last.dueDate, ctx.today)}${last.minimum ? ` · mínimo ${fmt(last.minimum)}` : ''}`);
      }
      if (a.availableLimit != null && a.creditLimit) lines.push('', `Limite livre: ${fmt(a.availableLimit)} de ${fmt(a.creditLimit)}`);

      const tx = o?.txCount ? await deps.billTransactions(a.id, 'open') : [];
      const byCat = {};
      for (const t of tx) if (t.direction === 'out') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
      const cats = Object.entries(byCat).sort((x, y) => y[1] - x[1]).slice(0, 5);
      if (cats.length) lines.push('', '<b>Onde mais gastou</b>', ...cats.map(([k, v]) => `${esc(catName(k))} · ${fmt(v)}`));
      if (tx.length) {
        lines.push('', '<b>Últimos lançamentos</b>');
        for (const t of tx.slice(0, 8)) lines.push(`${dm(t.date)} · ${desc(t)} · ${G.isCardPayment(t) ? `pagamento ${fmt(t.amount)}` : `${t.direction === 'in' ? '−' : ''}${fmt(t.amount)}`}`);
        if (tx.length > 8) lines.push(`<i>e mais ${tx.length - 8} no app</i>`);
      }
      return lines.join('\n');
    }));
    return blocks.join('\n\n');
  }

  // ---- /parcelas: suas parcelas na fatura que vence no mês (atual por padrão; `/parcelas dez`, `/parcelas 03/2027`,
  // `/parcelas proximo`). Conta só a sua parte. `/parcelas fulano`: a parte de fulano. Outro texto filtra o cartão.
  // Fatura fechada ou aberta: as parcelas já lançadas nela (+ as previstas, na aberta); faturas futuras: a previsão.
  async function parcelas(arg = '') {
    const today = deps.today();
    const { month, rest } = monthArg(arg, today);
    if (month === undefined) return 'Mês inválido. Ex.: /parcelas dez, /parcelas 03/2027 ou /parcelas proximo';
    const [all, people] = await Promise.all([deps.listBills(), deps.listPeople()]);
    const person = rest ? findPerson(people, rest)?.p : null;
    const q = person ? '' : plain(rest);
    const cards = all.filter((c) => !q || plain(`${c.account.name} ${c.account.institution}`).includes(q));
    if (!cards.length) return `Nenhuma pessoa ou cartão com "${esc(rest)}". Pessoas: /pessoas`;
    const part = (t) => (person ? t.shares?.find((x) => x.personId === person.id)?.amount ?? 0 : t.myAmount ?? t.amount);
    const label = monthLabel(month);
    const LIMIT = 20;
    let total = 0;
    const blocks = (await Promise.all(cards.map(async (c) => {
      if (c.error) return `<b>${name(c.account)}</b>\nNão consegui ler as faturas: ${esc(c.error)}`;
      const items = []; // { description, n, of, amount }
      let bill = null;
      const posted = async (billId) => {
        for (const t of await deps.billTransactions(c.account.id, billId)) {
          if (t.direction !== 'out' || !(t.totalInstallments > 1) || !t.installmentNumber) continue;
          items.push({ description: t.description, n: t.installmentNumber, of: t.totalInstallments, amount: part(t) });
        }
      };
      const planned = (k) => {
        for (const p of c.installments?.purchases || []) {
          if (p.offset == null || k < p.offset || k >= p.offset + p.left) continue;
          items.push({ description: p.rawDescription || p.description, n: p.next + k - p.offset, of: p.totalInstallments, amount: part(p) });
        }
      };
      const closed = c.bills.find((b) => b.dueDate?.slice(0, 7) === month);
      const openDue = c.open?.dueDate;
      if (closed) { bill = { due: closed.dueDate }; await posted(closed.id); }
      else if (openDue && openDue.slice(0, 7) === month) { bill = { due: openDue, est: true }; await posted('open'); planned(0); }
      else if (openDue && month > openDue.slice(0, 7)) {
        const k = monthsBetween(openDue.slice(0, 7), month);
        bill = { due: addMonths(openDue, k), est: true };
        planned(k);
      }
      const list = items.filter((x) => x.amount > 0.004).sort((a, b) => b.amount - a.amount);
      if (!list.length) return null;
      const sum = list.reduce((s, x) => s + x.amount, 0);
      total += sum;
      const lines = [`<b>${name(c.account)}</b>`, `${bill.due < today ? 'venceu' : 'vence'} ${bill.est ? '~' : ''}${dm(bill.due)} · <b>${fmt(sum)}</b>`, ''];
      for (const x of list.slice(0, LIMIT)) lines.push(`${esc(G.tidyDescription(x.description))} (${x.n}/${x.of}): ${fmt(x.amount)}`);
      if (list.length > LIMIT) lines.push(`<i>e mais ${list.length - LIMIT} no app</i>`);
      return lines.join('\n');
    }))).filter(Boolean);
    const who = person ? ` de ${esc(person.name)}` : '';
    const head = `<b>Parcelas${who} · ${label}</b>`;
    const next = monthLabel(shiftMonth(month, 1)).split('/')[0];
    const hint = `<i>Outro mês: /parcelas ${next.slice(0, 3)} ou /parcelas MM/AAAA</i>`;
    if (!blocks.length) return [head, `Nenhuma parcela${person ? '' : ' sua'} nas faturas que vencem em ${label}.`, hint].join('\n\n');
    if (blocks.length > 1) blocks.push(`Total · <b>${fmt(total)}</b>`);
    return [head, ...blocks, hint].join('\n\n');
  }

  // ---- /saldo
  async function saldo() {
    const accounts = await deps.listAccounts();
    const banks = accounts.filter((a) => a.kind === 'bank');
    const cards = accounts.filter((a) => a.kind === 'credit' && (a.balance || a.availableLimit));
    const lines = [];
    if (banks.length) {
      lines.push('<b>Contas</b>', ...banks.map((a) => `${name(a)} · ${fmt(a.balance)}`));
      if (banks.length > 1) lines.push(`Total · <b>${fmt(banks.reduce((s, a) => s + a.balance, 0))}</b>`);
    }
    if (cards.length) {
      lines.push('', '<b>Cartões</b>', ...cards.map((a) => `${name(a)} · ${fmt(a.balance)} usado${a.availableLimit != null ? `, ${fmt(a.availableLimit)} livre` : ''}`));
    }
    return lines.join('\n').trim() || 'Nenhuma conta conectada.';
  }

  // ---- pessoas: /<nome> = mini fatura do que a pessoa te deve
  // Nome do comando: minúsculas, sem acento, só letras/números/_ (regra do Telegram). "Ana Clara" → /ana_clara.
  const slug = (s) => plain(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  const RESERVED = new Set();
  // Para cada pessoa: o comando completo e, se ninguém mais tiver o mesmo primeiro nome, o primeiro nome.
  function personSlugs(people) {
    const first = (p) => slug(p.name).split('_')[0];
    const count = {};
    for (const p of people) count[first(p)] = (count[first(p)] || 0) + 1;
    return people.map((p) => {
      const full = slug(p.name);
      const short = count[first(p)] === 1 ? first(p) : null;
      const cmd = [full, short].find((x) => x && !RESERVED.has(x)) || null;
      return { p, full, short, cmd };
    });
  }
  const findPerson = (people, q) => {
    const k = slug(q);
    if (!k) return null;
    const list = personSlugs(people);
    return list.find((x) => x.full === k || x.full.replace(/_/g, '') === k.replace(/_/g, '')) || list.find((x) => x.short === k) || null;
  };

  // Mini fatura: saldo, despesas divididas (a parte da pessoa) e pagamentos. `tudo` lista tudo.
  function personBill(p, all) {
    const LIMIT = 15;
    const items = all ? p.items : p.items.slice(0, LIMIT);
    const pays = all ? p.payments : p.payments.slice(0, 5);
    const lines = [`<b>${esc(p.name)}</b>`];
    lines.push(p.balance > 0.004 ? `A pagar: <b>${fmt(p.balance)}</b>` : p.balance < -0.004 ? `Crédito de <b>${fmt(-p.balance)}</b>` : '<b>Tudo pago</b> ✅');
    if (p.paid) lines.push(`<i>${fmt(p.owed)} em despesas − ${fmt(p.paid)} já pago</i>`);
    if (items.length) {
      lines.push('', `<b>Despesas</b>`);
      for (const x of items) {
        const part = Math.abs(x.amount - x.total) > 0.004 ? ` <i>de ${fmt(x.total)}</i>` : '';
        lines.push(`${dm(x.date)} · ${desc(x)} · ${fmt(x.amount)}${part}`);
      }
      if (items.length < p.items.length) lines.push(`<i>e mais ${p.items.length - items.length} antigas</i>`);
    }
    if (pays.length) {
      lines.push('', '<b>Pagamentos</b>');
      for (const x of pays) lines.push(`${dm(x.date)} · ${fmt(x.amount)}${x.note ? ` · ${esc(x.note)}` : ''}`);
    }
    if (!all && (items.length < p.items.length || pays.length < p.payments.length)) lines.push('', `Lista completa: /${slug(p.name)} tudo`);
    return lines.join('\n');
  }
  const personCmd = (person) => async (arg) => {
    const p = (await deps.peopleSummary()).find((x) => x.id === person.id);
    return p ? personBill(p, /^(tudo|todas?)$/i.test(arg.trim())) : 'Pessoa não encontrada.';
  };

  async function pessoas() {
    const people = await deps.peopleSummary();
    if (!people.length) return 'Nenhuma pessoa cadastrada. Use o botão Pessoas no app.';
    const cmds = new Map(personSlugs(people).map((x) => [x.p.id, x.cmd]));
    const total = people.reduce((s, p) => s + Math.max(0, p.balance), 0);
    return [
      '<b>A receber</b>',
      ...people.map((p) => `${cmds.get(p.id) ? `/${cmds.get(p.id)}` : esc(p.name)} · ${p.balance > 0.004 ? fmt(p.balance) : p.balance < -0.004 ? `crédito de ${fmt(-p.balance)}` : 'em dia'}`),
      ...(people.length > 1 ? ['', `Total · <b>${fmt(total)}</b>`] : []),
    ].join('\n');
  }

  async function pessoa(arg) {
    if (!arg.trim()) return 'Use /pessoa e o nome. Lista: /pessoas';
    const words = arg.trim().split(/\s+/);
    const all = words.length > 1 && /^(tudo|todas?)$/i.test(words.at(-1));
    const q = (all ? words.slice(0, -1) : words).join(' ');
    const people = await deps.peopleSummary();
    const hit = findPerson(people, q) || findPerson(people, words[0]);
    return hit ? personBill(hit.p, all) : `Ninguém chamado "${esc(q)}". Lista: /pessoas`;
  }

  const commands = [
    { name: 'resumo', aliases: ['bomdia'], description: 'Resumo do dia: máximo de hoje e da semana, fatura (ou de uma data)', run: resumo },
    { name: 'diaria', aliases: ['hoje', 'dia'], description: 'Quanto ainda pode gastar hoje', run: diaria },
    { name: 'semana', description: 'Meta semanal', run: semana },
    { name: 'mes', aliases: ['mensal', 'meta'], description: 'Meta mensal (ciclo da fatura)', run: mes },
    { name: 'fatura', description: 'Fatura aberta, última fatura e lançamentos', run: fatura },
    { name: 'parcelas', description: 'Parcelas da fatura que vence no mês (ou de outro mês)', run: parcelas },
    { name: 'saldo', description: 'Saldo das contas e limite dos cartões', run: saldo },
    { name: 'pessoas', description: 'Quanto cada pessoa te deve', run: pessoas },
    { name: 'pessoa', description: 'Mini fatura de uma pessoa', run: pessoa },
    { name: 'ajuda', aliases: ['start', 'help'], description: 'Lista os comandos' },
  ];
  commands.at(-1).run = async () => [
    '<b>Canguinha</b> 🦘',
    '',
    ...commands.filter((c) => c.name !== 'ajuda').map((c) => `/${c.name} · ${c.description.toLowerCase()}`),
    '',
    '<i>Um cartão só: /fatura elo</i>',
    '<i>Parcelas de outro mês: /parcelas dez ou /parcelas 03/2027</i>',
    '<i>Parcelas de uma pessoa: /parcelas nome</i>',
    '<i>Outro dia: /resumo 05/11/2026 ou /resumo ontem</i>',
    '<i>Uma pessoa: /nome (veja em /pessoas)</i>',
  ].join('\n');
  for (const c of commands) { RESERVED.add(c.name); for (const a of c.aliases || []) RESERVED.add(a); }

  return {
    commands,
    summary: resumo,
    async resolve(cmd) {
      const hit = personSlugs(await deps.peopleSummary()).find((x) => x.cmd === cmd || x.full === cmd);
      return hit ? { name: cmd, run: personCmd(hit.p) } : null;
    },
    async menu() {
      const people = personSlugs(await deps.peopleSummary()).filter((x) => x.cmd);
      return [
        ...commands.filter((c) => c.description).map((c) => ({ command: c.name, description: c.description })),
        ...people.map((x) => ({ command: x.cmd, description: `Quanto ${x.p.name} te deve`.slice(0, 256) })),
      ].slice(0, 100);
    },
  };
}
