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
