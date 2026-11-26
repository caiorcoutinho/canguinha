// Tarefa diária às HH:MM (no fuso `tz`). Confere a cada minuto; o dia da última execução fica gravado em settings
// (`key`), então reiniciar não repete. Se o app estava fora do ar no horário, roda ao voltar (até `catchUpMin` depois).
// Se `run` falhar, tenta de novo após `retryMs` (ainda dentro da janela). Devolve null se `at` for inválido.
export function scheduleDaily({ name, at, tz, catchUpMin, retryMs = 15 * 60_000, key, store, run, log = console, now = () => new Date() }) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(at);
  if (!m || +m[1] > 23 || +m[2] > 59) { log.error(`[${name}] horário inválido: "${at}" (use HH:MM)`); return null; }
  const target = +m[1] * 60 + +m[2];
  const clock = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
  let doneDay = null, busy = false, retryAt = 0;

  const tick = async () => {
    const d = now();
    if (busy || d.getTime() < retryAt) return;
    const [h, mi] = clock.format(d).split(':').map(Number);
    const minutes = h * 60 + mi, day = dayFmt.format(d);
    if (minutes < target || minutes > target + catchUpMin || doneDay === day) return;
    busy = true;
    try {
      doneDay = await store.getSetting(key);
      if (doneDay === day) return;
      await run();
      await store.setSetting(key, day);
      doneDay = day;
    } catch (err) {
      log.error(`[${name}]`, err.message, `· nova tentativa em ${Math.round(retryMs / 60_000)} min`);
      retryAt = d.getTime() + retryMs;
    } finally { busy = false; }
  };
  tick();
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
