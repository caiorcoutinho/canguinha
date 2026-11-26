import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleDaily } from '../lib/daily.js';

// Horário falso em São Paulo (UTC−3): `at('2026-11-26', '08:30')`.
const at = (day, hm) => new Date(`${day}T${hm}:00-03:00`);
const quiet = { error() {} };
function setup({ time, fail = 0, saved = null }) {
  const settings = { k: saved };
  const store = { getSetting: async (k) => settings[k] ?? null, setSetting: async (k, v) => { settings[k] = v; } };
  const clock = { now: time };
  let runs = 0;
  const job = scheduleDaily({
    name: 'teste', at: '08:00', tz: 'America/Sao_Paulo', catchUpMin: 120, key: 'k', store, log: quiet,
    now: () => clock.now, run: async () => { runs++; if (fail-- > 0) throw new Error('falhou'); },
  });
  job.stop();
  return { job, clock, settings, runs: () => runs };
}
const settle = () => new Promise((r) => setImmediate(r));

test('roda uma vez no horário e não repete no mesmo dia', async () => {
  const s = setup({ time: at('2026-11-26', '08:00') });
  await settle();
  s.clock.now = at('2026-11-26', '08:01'); await s.job.tick();
  assert.equal(s.runs(), 1);
  assert.equal(s.settings.k, '2026-11-26');
  s.clock.now = at('2026-11-27', '08:00'); await s.job.tick();
  assert.equal(s.runs(), 2);
});

test('antes do horário e depois da janela de atraso não roda', async () => {
  const s = setup({ time: at('2026-11-26', '07:59') });
  await settle();
  s.clock.now = at('2026-11-26', '10:01'); await s.job.tick();
  assert.equal(s.runs(), 0);
});

test('app voltou dentro da janela: roda atrasado', async () => {
  const s = setup({ time: at('2026-11-26', '09:45') });
  await settle();
  assert.equal(s.runs(), 1);
});

test('já rodou hoje antes de reiniciar: não repete', async () => {
  const s = setup({ time: at('2026-11-26', '08:30'), saved: '2026-11-26' });
  await settle();
  assert.equal(s.runs(), 0);
});

test('falhou: tenta de novo só depois de 15 min e não marca o dia', async () => {
  const s = setup({ time: at('2026-11-26', '08:00'), fail: 1 });
  await settle();
  assert.equal(s.settings.k, null);
  s.clock.now = at('2026-11-26', '08:10'); await s.job.tick();
  assert.equal(s.runs(), 1);
  s.clock.now = at('2026-11-26', '08:15'); await s.job.tick();
  assert.equal(s.runs(), 2);
  assert.equal(s.settings.k, '2026-11-26');
});

test('horário inválido não agenda', () => {
  assert.equal(scheduleDaily({ name: 'x', at: '25:00', tz: 'UTC', catchUpMin: 1, key: 'k', store: {}, run() {}, log: quiet }), null);
});
