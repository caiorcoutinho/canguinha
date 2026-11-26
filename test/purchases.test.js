import { test } from 'node:test';
import assert from 'node:assert/strict';
import { purchaseKey, purchaseKeyChanges } from '../lib/purchases.js';

const tx = (description, n, extra = {}) => ({
  accountId: 'acc1', purchaseDate: '2026-10-03', totalInstallments: 3, installmentNumber: n, description,
  purchaseKey: purchaseKey('acc1', '2026-10-03', 3, description), ...extra,
});

test('as parcelas da mesma compra têm a mesma etiqueta', () => {
  assert.equal(tx('TENIS LOJA X PARC 01/03 SALVADOR BR', 1).purchaseKey, tx('TENIS LOJA X PARC 02/03 SALVADOR BR', 2).purchaseKey);
});

test('dois pedidos no mesmo dia com códigos diferentes são compras diferentes', () => {
  assert.notEqual(tx('AMAZON 1234567 PARC 01/03', 1).purchaseKey, tx('AMAZON 7654321 PARC 01/03', 1).purchaseKey);
});

test('migração: etiqueta antiga que juntava dois pedidos vira as duas novas', () => {
  const changes = purchaseKeyChanges([tx('AMAZON 1234567 PARC 01/03', 1), tx('AMAZON 7654321 PARC 01/03', 1)]);
  assert.deepEqual([...changes], [[
    'purchase:acc1|2026-10-03|3|amazon',
    ['purchase:acc1|2026-10-03|3|amazon 1234567', 'purchase:acc1|2026-10-03|3|amazon 7654321'],
  ]]);
});

test('migração: etiqueta que não mudou fica de fora', () => {
  assert.equal(purchaseKeyChanges([tx('LEAO DE OURO PARC 01/03 SALVADOR BR', 1)]).size, 0);
});
