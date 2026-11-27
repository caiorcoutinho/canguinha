import { test } from 'node:test';
import assert from 'node:assert/strict';
import { botCommands } from '../lib/bot.js';

test('/maria: reconhece pelo nome e calcula o saldo uma vez só', async () => {
  let summaries = 0;
  const people = [{ id: 'p1', name: 'Maria' }, { id: 'p2', name: 'Ana Clara' }];
  const cmds = botCommands({
    today: () => '2026-11-26',
    listPeople: async () => people,
    peopleSummary: async () => { summaries++; return people.map((p) => ({ ...p, owed: 10, paid: 0, balance: 10, items: [], payments: [] })); },
  });
  const cmd = await cmds.resolve('maria');
  assert.equal(summaries, 0); // reconhecer o comando não lê transações
  assert.match(await cmd.run(''), /A pagar: <b>R\$\s10,00<\/b>/);
  assert.equal(summaries, 1);
  assert.equal(await cmds.resolve('ninguem'), null);
  assert.deepEqual((await cmds.menu()).filter((c) => !['resumo', 'diaria', 'semana', 'mes', 'fatura', 'parcelas', 'saldo', 'pessoas', 'pessoa', 'ajuda'].includes(c.command)).map((c) => c.command), ['maria', 'ana_clara']);
  assert.ok(await cmds.resolve('ana')); // atalho: única Ana
  assert.equal(summaries, 1); // o menu também não
});

test('/maria dez: só as despesas das faturas que vencem no mês', async () => {
  const people = [{ id: 'p1', name: 'Ana Clara' }];
  const item = (id, amount) => ({ id, date: '2026-11-10', description: `compra ${id}`, total: amount * 2, amount });
  const cmds = botCommands({
    today: () => '2026-11-26',
    listPeople: async () => people,
    listBills: async () => [{ account: { id: 'c1' }, bills: [{ id: 'b11', dueDate: '2026-11-05' }], open: { dueDate: '2026-12-05' } }],
    billTransactions: async (_, billId) => (billId === 'open' ? [{ id: 't2' }] : [{ id: 't1' }]),
    peopleSummary: async () => people.map((p) => ({ ...p, owed: 30, paid: 0, balance: 30, items: [item('t1', 10), item('t2', 20)], payments: [] })),
  });
  const cmd = await cmds.resolve('ana');
  const dez = await cmd.run('dez');
  assert.match(dez, /fatura de dezembro\/2026/);
  assert.match(dez, /compra t2/i);
  assert.doesNotMatch(dez, /compra t1/i);
  assert.match(await cmd.run('11'), /compra t1/i);
  assert.match(await cmds.commands.find((c) => c.name === 'pessoa').run('ana clara 11'), /Total: <b>R\$\s10,00/);
  assert.match(await cmds.commands.find((c) => c.name === 'pessoa').run('ana clara tudo'), /A pagar/);
  assert.match(await cmd.run('xyz'), /Mês inválido/);
});
