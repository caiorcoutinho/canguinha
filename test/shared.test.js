import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, monthlyOnOrAfter, weekStatus, monthStatus, todayAllowance, isCardPayment, ruleKey } from '../public/shared.js';

test('addMonths limita ao último dia do mês', () => {
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonths('2028-01-31', 1), '2028-02-29'); // bissexto
  assert.equal(addMonths('2026-12-15', 1), '2027-01-15');
});

test('fechamento no dia 31 não escorrega quando pula meses', () => {
  // última fatura fechou 31/01, hoje 30/03: o próximo fechamento é 31/03, não 28/04
  assert.equal(monthlyOnOrAfter('2026-01-31', '2026-03-30', 1), '2026-03-31');
  assert.equal(monthlyOnOrAfter('2026-01-31', '2026-04-01', 1), '2026-04-30');
});

test('fechamento ainda no futuro é o mês seguinte', () => {
  assert.equal(monthlyOnOrAfter('2026-01-31', '2026-02-10', 1), '2026-02-28');
  assert.equal(monthlyOnOrAfter('2026-03-05', '2026-03-05', 0), '2026-03-05'); // hoje conta como "não passou"
});

test('vencimento sem fechamento conhecido não avança', () => {
  assert.equal(monthlyOnOrAfter('2026-01-10', '', 1), '2026-02-10');
});

// ---------------------------------------------------------------- metas
// Cenário: hoje é quinta 26/11/2026; semana de seg 23/11 a dom 29/11.
// Ciclo da fatura: última fechou 05/11, a aberta fecha 05/12 (06/11 a 05/12 = 30 dias).
const close = (a, b) => assert.ok(Math.abs(a - b) < 0.01, `${a} ≠ ${b}`);
const TODAY = '2026-11-26';
const card = (upcoming = []) => ({ bills: [{ closeDate: '2026-11-05' }], open: { closeDate: '2026-12-05', upcoming } });

test('meta semanal: soma a semana, estorno abate, semana anterior fica de fora', () => {
  const items = [
    { date: '2026-11-22', net: 999, out: true }, // domingo anterior
    { date: '2026-11-23', net: 100, out: true },
    { date: '2026-11-24', net: -20, out: false }, // estorno
    { date: '2026-11-25', net: 50, out: true },
  ];
  const w = weekStatus(items, 700, TODAY);
  close(w.spent, 130);
  assert.equal(w.elapsed, 4);   // seg..qui
  assert.equal(w.daysLeft, 4);  // qui..dom
  close(w.remaining, 570);
  assert.equal(w.ahead, false); // 32,50/dia < 100/dia
});

test('meta semanal: parcelas previstas entram proporcionais aos dias da semana até o fechamento', () => {
  // 300 em parcelas, 10 dias de hoje até 05/12, 4 deles nesta semana → 120
  close(weekStatus([], 700, TODAY, card([{ amount: 300 }])).installments, 120);
  // dividida com outra pessoa: conta só a sua parte (150) → 60
  close(weekStatus([], 700, TODAY, card([{ amount: 300, myAmount: 150 }])).installments, 60);
});

test('meta mensal: ciclo da fatura, parcelas previstas, por dia e projeção', () => {
  const items = [
    { date: '2026-11-05', net: 500 }, // dia do fechamento anterior: outro ciclo
    { date: '2026-11-10', net: 600 },
    { date: '2026-11-24', net: 300 },
    { date: '2026-11-26', net: 100 },
  ];
  const m = monthStatus(card([{ amount: 200 }]), 3000, items, TODAY);
  assert.equal(m.start, '2026-11-06');
  assert.equal(m.total, 30);
  assert.equal(m.elapsed, 21);
  assert.equal(m.daysLeft, 10);
  close(m.posted, 1000);
  close(m.spent, 1200);       // lançado + parcelas previstas
  close(m.perDay, 180);       // (3000 − 1200) / 10
  close(m.projected, 200 + (1000 / 21) * 30);
  // orçamento da semana fixado na segunda: (3000 − 600 antes da semana − 200 previstas) / 13 dias × 7
  close(m.weekBudget, (2200 / 13) * 7);
  close(m.untilSunday, (2200 / 13) * 7 - 400);
  // quanto pode gastar hoje: sem contar o gasto de hoje (100)
  close(todayAllowance(items, TODAY, { month: m }).month, 190);
});

test('meta mensal sem fatura fechada usa o mês do calendário e ignora previstas', () => {
  const m = monthStatus({ bills: [], open: { closeDate: '2026-12-05', upcoming: [{ amount: 999 }] } }, 3000, [], TODAY);
  assert.equal(m.fallback, true);
  assert.equal(m.start, '2026-11-01');
  assert.equal(m.end, '2026-11-30');
  close(m.committed, 0);
});

test('pagamento de fatura não conta como estorno', () => {
  assert.equal(isCardPayment({ direction: 'in', description: 'PGTO. CASH AG 1234' }), true);
  assert.equal(isCardPayment({ direction: 'in', category: 'Credit card payment', description: 'x' }), true);
  assert.equal(isCardPayment({ direction: 'in', description: 'ESTORNO LOJA X' }), false);
  assert.equal(isCardPayment({ direction: 'out', category: 'Credit card payment', description: 'x' }), false);
});

// ---------------------------------------------------------------- regras de categoria
test('ruleKey: a mesma despesa em dias diferentes gera a mesma chave', () => {
  assert.equal(ruleKey('PIX - ENVIADO 04/11 09:48 FULANO'), 'pix - enviado fulano');
  assert.equal(ruleKey('PIX - ENVIADO 12/11 18:03 FULANO'), 'pix - enviado fulano');
  assert.equal(ruleKey('LOJA X PARC 02/10'), 'loja x');
  assert.equal(ruleKey('BOLETO 12345678901 ENERGIA'), 'boleto energia');
  assert.equal(ruleKey(null), '');
});

// ---------------------------------------------------------------- ritmo no início do ciclo
// Fatura fechou 25/11; hoje 26/11 é o dia 1 de 30 do ciclo, nada lançado, R$ 554,34 em parcelas previstas.
test('ritmo: parcelas previstas no 1º dia do ciclo não viram média diária', () => {
  const c = { bills: [{ closeDate: '2026-11-25' }], open: { closeDate: '2026-12-25', upcoming: [{ amount: 554.34 }] } };
  const m = monthStatus(c, 2000, [], TODAY);
  assert.equal(m.elapsed, 1);
  close(m.avgDaily, 554.34 / 30);              // antes: 554,34/dia
  assert.equal(m.ahead, false);
  close(m.expected, 554.34 + (2000 - 554.34) / 30);
  // acima do ritmo só quando o lançado por dia passa do que sobra da meta por dia: (2000 − 554,34) / 30 = 48,19
  assert.equal(monthStatus(c, 2000, [{ date: TODAY, net: 40 }], TODAY).ahead, false);
  assert.equal(monthStatus(c, 2000, [{ date: TODAY, net: 50 }], TODAY).ahead, true);
});

test('ritmo semanal: segunda-feira com parcelas da semana inteira', () => {
  // segunda 23/11, ciclo fecha domingo 29/11: as R$ 350 em parcelas caem todas nesta semana
  const c = { bills: [{ closeDate: '2026-10-29' }], open: { closeDate: '2026-11-29', upcoming: [{ amount: 350 }] } };
  const w = weekStatus([], 700, '2026-11-23', c);
  close(w.installments, 350);
  close(w.avgDaily, 50);                       // antes: 350/dia, contra 100/dia da meta
  assert.equal(w.ahead, false);
});
