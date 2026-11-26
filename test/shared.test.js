import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMonths, monthlyOnOrAfter } from '../public/shared.js';

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
