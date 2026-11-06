// Código compartilhado entre o dashboard (navegador) e o servidor (bot do Telegram).
// Sem DOM nem Node: só funções puras. Datas são strings ISO 'YYYY-MM-DD' (dia local).

export const CATEGORY_PT = {
  'Groceries': 'Supermercado', 'Eating out': 'Restaurantes', 'Food and drinks': 'Alimentação', 'Food delivery': 'Delivery',
  'Taxi and ride-hailing': 'Táxi e apps', 'Transportation': 'Transporte', 'Gas stations': 'Combustível', 'Parking': 'Estacionamento',
  'Public transportation': 'Transporte público', 'Video streaming': 'Streaming de vídeo', 'Music streaming': 'Streaming de música',
  'Online shopping': 'Compras online', 'Shopping': 'Compras', 'Clothing': 'Vestuário', 'Electronics': 'Eletrônicos',
  'Pharmacy': 'Farmácia', 'Health': 'Saúde', 'Leisure': 'Lazer', 'Entertainment': 'Entretenimento', 'Travel': 'Viagem',
  'Salary': 'Salário', 'Income': 'Receitas', 'Rent': 'Aluguel', 'Housing': 'Moradia', 'Electricity': 'Energia', 'Water': 'Água',
  'Internet': 'Internet', 'Telecommunications': 'Telecom', 'Utilities': 'Contas da casa', 'Education': 'Educação',
  'Credit card payment': 'Pagamento de fatura', 'Same person transfer': 'Transferência própria', 'Transfers': 'Transferências',
  'Transfer - PIX': 'PIX', 'Transfer - TED': 'TED', 'Taxes': 'Impostos', 'Bank fees': 'Tarifas bancárias', 'Investments': 'Investimentos',
  'Services': 'Serviços', 'Digital services': 'Serviços digitais', 'Insurance': 'Seguros', 'Pets': 'Pets', 'Gym': 'Academia',
  'Accomodation': 'Hospedagem', 'Accommodation': 'Hospedagem', 'Donations': 'Doações', 'Healthcare': 'Saúde', 'Tolls and in vehicle payment': 'Pedágio e veículo',
  'Sem categoria': 'Sem categoria',
};

// ---------------------------------------------------------------- datas ISO
const D = (s) => new Date(`${s}T00:00:00Z`);
export const isoAddDays = (s, n) => { const d = D(s); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const daysBetween = (a, b) => Math.round((D(b) - D(a)) / 864e5);
export const weekStartIso = (s) => isoAddDays(s, -((D(s).getUTCDay() + 6) % 7)); // segunda-feira

// ---------------------------------------------------------------- metas
export const WEEKS = 8;
// Movimentações internas (pagamento de fatura, transferência entre contas próprias): não são gasto.
export const INTERNAL = /credit card payment|same person transfer|pagamento de fatura|pagto\.? fatura|transfer[eê]ncia (entre contas|mesma titularidade|para poupan)/i;
export const PAYMENT = /credit card payment|pagamento (de )?fatura|pagto\.? fatura|pagamento recebido/i;

// Entrada no cartão que é pagamento de fatura (não estorno). Alguns bancos mandam como transferência
// ("PGTO. CASH AG. ...", "PGTO. QR CODE PIX ..."), então também vale descrição começando com "PGTO".
export const isCardPayment = (t) => t.direction === 'in'
  && (PAYMENT.test(t.category) || PAYMENT.test(t.description) || /^pgto\b/i.test(t.description || ''));

// Lançamentos do cartão que contam para metas, com valor líquido (compra +, estorno −). Pagamentos da fatura ficam de fora.
// Compras divididas com outras pessoas contam só a sua parte (`myAmount`).
export function spendItems(tx, accountId) {
  return tx
    .filter((t) => t.accountId === accountId && !isCardPayment(t))
    .map((t) => ({ date: t.date, net: t.direction === 'out' ? (t.myAmount ?? t.amount) : -t.amount, out: t.direction === 'out' }));
}

// Gasto por semana (seg–dom) nas últimas WEEKS semanas; a última é a atual.
export function weeklySpend(items, today) {
  const start0 = isoAddDays(weekStartIso(today), -7 * (WEEKS - 1));
  const weeks = Array.from({ length: WEEKS }, (_, i) => ({ start: isoAddDays(start0, 7 * i), spent: 0, count: 0 }));
  for (const t of items) {
    const w = weeks.find((x) => x.start === weekStartIso(t.date));
    if (!w) continue;
    w.spent += t.net;
    if (t.out) w.count++;
  }
  return weeks;
}

export function weekStatus(items, goal, today) {
  if (!goal) return null;
  const cur = weeklySpend(items, today).at(-1);
  const spent = Math.max(0, cur.spent);
  const elapsed = Math.min(7, daysBetween(cur.start, today) + 1); // seg..hoje
  const daysLeft = 7 - elapsed + 1;                                // hoje..dom
  const avgDaily = spent / elapsed, goalDaily = goal / 7;
  return {
    goal, spent, pct: (spent / goal) * 100, start: cur.start, end: isoAddDays(cur.start, 6), count: cur.count, elapsed, daysLeft,
    remaining: goal - spent, avgDaily, goalDaily, ahead: avgDaily > goalDaily,
  };
}

// Ciclo atual = dia seguinte ao último fechamento até o fechamento estimado da fatura aberta.
// `card` = { bills: [{ closeDate }], open: { closeDate } } (formato de /api/bills).
export function cycleWindow(card, today) {
  const lastClose = card.bills.map((b) => b.closeDate).filter(Boolean).sort().at(-1);
  if (lastClose && card.open?.closeDate) return { start: isoAddDays(lastClose, 1), end: card.open.closeDate, estimated: true };
  const first = `${today.slice(0, 7)}-01`;
  const nextMonth = isoAddDays(first, 32).slice(0, 7);
  return { start: first, end: isoAddDays(`${nextMonth}-01`, -1), fallback: true };
}

export function monthStatus(card, goal, items, today) {
  if (!goal) return null;
  const win = cycleWindow(card, today);
  const total = daysBetween(win.start, win.end) + 1;
  const elapsed = Math.min(total, Math.max(1, daysBetween(win.start, today) + 1)); // inclui hoje
  const daysLeft = Math.max(1, daysBetween(today, win.end) + 1);                    // inclui hoje
  const tx = items.filter((t) => t.date >= win.start && t.date <= win.end);
  const posted = Math.max(0, tx.reduce((s, t) => s + t.net, 0));
  const upcoming = win.fallback ? [] : (card.open?.upcoming || []);
  const committed = upcoming.reduce((s, u) => s + (u.myAmount ?? u.amount), 0); // parcelas que ainda vão cair neste ciclo (só a sua parte)
  const spent = posted + committed;
  const remaining = goal - spent;
  const perDay = Math.max(0, remaining) / daysLeft;
  // até domingo, sem passar do fim do ciclo
  const sunday = isoAddDays(weekStartIso(today), 6);
  const weekDays = daysBetween(today, sunday < win.end ? sunday : win.end) + 1;
  return {
    goal, ...win, total, elapsed, daysLeft, spent, remaining, perDay,
    perWeek: Math.max(0, remaining) * Math.min(1, 7 / daysLeft),
    untilSunday: perDay * weekDays, weekDays,
    projected: committed + (posted / elapsed) * total,
    posted, committed, upcoming,
    avgDaily: spent / elapsed, goalDaily: goal / total, ahead: spent / elapsed > goal / total,
    pct: (spent / goal) * 100,
    tx,
  };
}

// Quanto ainda pode gastar hoje: o que sobra da meta sem contar o gasto de hoje, dividido pelos dias que faltam (com hoje).
export function todayAllowance(items, today, { week, month }) {
  const spentToday = items.filter((t) => t.date === today).reduce((s, t) => s + t.net, 0);
  const res = { spentToday, count: items.filter((t) => t.date === today && t.out).length };
  if (week) res.week = Math.max(0, week.goal - (week.spent - spentToday)) / week.daysLeft;
  if (month) res.month = Math.max(0, month.goal - (month.spent - spentToday)) / month.daysLeft;
  return res;
}

// ---------------------------------------------------------------- textos
const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'a', 'o']);
// "LEAO DE OURO" → "Leao de Ouro"; siglas curtas sem vogal (PF, MP) ficam em maiúsculas.
export const titleCase = (s) => String(s || '').toLowerCase().split(' ').map((w, i) => {
  if (i && SMALL.has(w)) return w;
  if (/^[a-z]{2,3}$/.test(w) && !/[aeiouy]/.test(w)) return w.toUpperCase();
  if (/^[a-z]\/[a-z]$/.test(w)) return w.toUpperCase(); // S/A, C/C
  return w.replace(/[a-zà-ÿ]/, (c) => c.toUpperCase());
}).join(' ');

const PARC = /\bPARC(?:ELA)?\s*\d{1,2}\s*\/\s*\d{1,2}\b/i;
// Descrição legível para mensagens: sem cidade/país do formato de cartão (23 + 13 caracteres + " BR"),
// sem "PARC 01/03" e sem data/hora/documento de Pix e compras no débito.
export function tidyDescription(d) {
  const orig = String(d || '').trim();
  let s = orig, m, prefix = '';
  if ((m = new RegExp(`^(.*?)\\s*${PARC.source}.*\\sBR$`, 'i').exec(s))) s = m[1];   // "LOJA PARC 01/03 CIDADE BR"
  else if ((m = /^(.{23})([A-Za-z .'-]{13}) BR$/.exec(s))) s = m[1];                 // "LOJA (23) CIDADE (13) BR"
  s = s.replace(PARC, ' ').replace(/\s+BR$/, '');
  if ((m = /^PIX\s*-\s*(ENVIADO|RECEBIDO|AGEND\w*)\s+(\d{2}\/\d{2}\s+)?(\d{2}:\d{2}\s+)?(\d{6,}\s+)?/i.exec(s))) {
    prefix = `Pix ${/^agend/i.test(m[1]) ? 'agendado' : m[1].toLowerCase()} · `; s = s.slice(m[0].length);
  } else if ((m = /^COMPRA C\/CARTAO\s+(\d{2}\/\d{2}\s+)?(\d{2}:\d{2}\s+)?/i.exec(s))) {
    prefix = 'Débito · '; s = s.slice(m[0].length);
  }
  s = titleCase(s.replace(/\s+/g, ' ').replace(/[\s\-–·*]+$/, '').trim());
  return s ? prefix + s : orig;
}
