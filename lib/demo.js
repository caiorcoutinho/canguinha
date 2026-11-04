// Dados fictícios para o modo demonstração (sem credenciais Pluggy).
const ACCOUNTS = [
  { id: 'demo-checking', itemId: 'demo', institution: 'Banco Roxo', institutionColor: '#820ad1', itemStatus: 'UPDATED', kind: 'bank', subtype: 'CHECKING_ACCOUNT', name: 'Conta corrente', number: '0001/123456-7', currency: 'BRL', balance: 8421.37 },
  { id: 'demo-savings', itemId: 'demo', institution: 'Banco Laranja', institutionColor: '#ec7000', itemStatus: 'UPDATED', kind: 'bank', subtype: 'SAVINGS_ACCOUNT', name: 'Poupança', number: '4421/99881-0', currency: 'BRL', balance: 15230.0 },
  { id: 'demo-card-1', itemId: 'demo', institution: 'Banco Roxo', institutionColor: '#820ad1', itemStatus: 'UPDATED', kind: 'credit', subtype: 'CREDIT_CARD', name: 'Cartão Platinum', number: '•••• 4821', currency: 'BRL', balance: 2874.55, creditLimit: 12000, availableLimit: 9125.45 },
  { id: 'demo-card-2', itemId: 'demo', institution: 'Banco Laranja', institutionColor: '#ec7000', itemStatus: 'UPDATED', kind: 'credit', subtype: 'CREDIT_CARD', name: 'Cartão Black', number: '•••• 0093', currency: 'BRL', balance: 1342.1, creditLimit: 20000, availableLimit: 18657.9 },
];

const CARD_SPEND = [
  ['Supermercado Pão Dourado', 'Groceries', 80, 450],
  ['iFood', 'Eating out', 30, 120],
  ['Restaurante Sabor da Casa', 'Eating out', 60, 220],
  ['Uber', 'Taxi and ride-hailing', 12, 60],
  ['Posto Shell', 'Gas stations', 120, 300],
  ['Netflix', 'Video streaming', 55.9, 55.9],
  ['Spotify', 'Music streaming', 21.9, 21.9],
  ['Amazon', 'Online shopping', 40, 600],
  ['Farmácia São Paulo', 'Pharmacy', 25, 180],
  ['Cinema Center', 'Leisure', 40, 90],
  ['Loja de Roupas Estilo', 'Clothing', 90, 400],
];

function rng(seed) {
  return () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
}

const iso = (d) => d.toISOString().slice(0, 10);
let memo = null;

export function demoAccounts() {
  const today = new Date();
  return ACCOUNTS.map((a) => ({ ...a, lastUpdatedAt: today.toISOString(), dueDate: null, closeDate: null }));
}

export function demoTransactions() {
  const key = iso(new Date());
  if (memo?.key === key) return memo.list;
  const r = rng(42);
  const list = [];
  let n = 0;
  const push = (accountId, date, description, category, signed) => {
    const amount = Math.round(Math.abs(signed) * 100) / 100;
    list.push({ id: `demo-${n++}`, accountId, date: iso(date), description, merchant: null, category, status: 'POSTED', direction: signed < 0 ? 'out' : 'in', amount, signed: signed < 0 ? -amount : amount, installment: null });
  };
  const today = new Date();
  for (let i = 0; i < 400; i++) {
    const d = new Date(today); d.setDate(today.getDate() - i);
    const day = d.getDate();
    if (day === 5) push('demo-checking', d, 'Salário — Empresa XPTO', 'Salary', 9800);
    if (day === 7) push('demo-checking', d, 'Aluguel', 'Rent', -2600);
    if (day === 10) {
      push('demo-checking', d, 'Pagamento de fatura Cartão Platinum', 'Credit card payment', -(1800 + r() * 1500));
      push('demo-checking', d, 'Conta de luz', 'Electricity', -(150 + r() * 120));
    }
    if (day === 12) push('demo-checking', d, 'Internet fibra', 'Internet', -119.9);
    if (day === 15) push('demo-savings', d, 'Aplicação automática', 'Same person transfer', 800);
    if (day === 15) push('demo-checking', d, 'Transferência para poupança', 'Same person transfer', -800);
    if (day === 20 && r() > 0.5) push('demo-checking', d, 'PIX recebido — freela', 'Transfer - PIX', 600 + r() * 1400);
    const count = Math.floor(r() * 3);
    for (let k = 0; k < count; k++) {
      const [desc, cat, min, max] = CARD_SPEND[Math.floor(r() * CARD_SPEND.length)];
      const acc = r() > 0.35 ? 'demo-card-1' : 'demo-card-2';
      push(acc, d, desc, cat, -(min + r() * (max - min)));
    }
    if (r() > 0.9) push('demo-checking', d, 'PIX enviado', 'Transfer - PIX', -(20 + r() * 200));
  }
  list.sort((a, b) => b.date.localeCompare(a.date));
  memo = { key, list };
  return list;
}

// Faturas fechadas: fecham dia 26, vencem dia 5 do mês seguinte. Total = compras da janela.
export function demoBills(accountId) {
  const tx = demoTransactions().filter((t) => t.accountId === accountId);
  const today = new Date();
  const bills = [];
  for (let k = 0; bills.length < 10 && k < 14; k++) {
    const close = new Date(today.getFullYear(), today.getMonth() - k, 26);
    if (iso(close) >= iso(today)) continue;
    const prev = new Date(close.getFullYear(), close.getMonth() - 1, 26);
    const due = new Date(close.getFullYear(), close.getMonth() + 1, 5);
    const inWin = tx.filter((t) => t.date > iso(prev) && t.date <= iso(close));
    const total = Math.round(inWin.reduce((s, t) => s + (t.direction === 'out' ? t.amount : -t.amount), 0) * 100) / 100;
    bills.push({ id: `demo-bill-${accountId}-${iso(close).slice(0, 7)}`, closeDate: iso(close), dueDate: iso(due), total, minimum: Math.round(total * 0.15 * 100) / 100, financeCharges: 0, allowsInstallments: true });
  }
  return bills;
}
