// Canguinha — dashboard
import * as G from './shared.js';
const { CATEGORY_PT } = G;
const $ = (s) => document.querySelector(s);
const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const BRL0 = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmt = (v) => BRL.format(v);
const PAGE = 100;

// categorias personalizadas chegam como "custom:<id>"
const catName = (c) => {
  if (String(c).startsWith('custom:')) return state.cats.custom.find((x) => `custom:${x.id}` === c)?.name || 'Categoria removida';
  return CATEGORY_PT[c] || c;
};
const isCustom = (c) => String(c).startsWith('custom:');
const ruleKey = (d) => String(d || '').toLowerCase()
  .replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, ' ') // datas e parcelas (04/11, 3/10)
  .replace(/\b\d{1,2}:\d{2}(:\d{2})?\b/g, ' ')        // horários
  .replace(/\b\d{6,}\b/g, ' ')                        // documentos, códigos
  .replace(/\bparc(ela)?\b\.?/g, ' ')
  .replace(/\s+/g, ' ').trim();  // igual ao server.js
// chip clicável que abre o seletor de categoria do lançamento
// attr: data-cat-tx (lançamento) ou data-cat-up (parcela prevista, pelo id da parcela que a originou)
function catChip(t, attr = 'data-cat-tx') {
  const src = { manual: 'escolhida por você', purchase: 'escolhida para todas as parcelas da compra', rule: 'por regra' }[t.categorySource] || 'da Pluggy';
  const orig = t.categorySource ? ` · original: ${catName(t.pluggyCategory)}` : '';
  return `<button type="button" class="chip${isCustom(t.category) ? ' custom' : ''}" ${attr}="${esc(t.id)}" title="Categoria ${src}${esc(orig)} — clique para alterar">${esc(catName(t.category))}${t.categorySource ? ' ✎' : ''}</button>`;
}
const { INTERNAL } = G;

const state = {
  accounts: [],
  transactions: [],
  selected: new Set(), // vazio = todas
  preset: 'month',
  from: null,
  to: null,
  excludeInternal: true,
  shown: PAGE,
  loadedRange: null,
  bills: [],
  view: 'today',
  billCard: null,
  billSel: 'open',
  goals: {},
  weekTx: [],
  calTx: [],     // lançamentos do mês aberto no calendário
  calKey: null,  // `${cartão}|${YYYY-MM}` de calTx
  calMonth: null, // 'YYYY-MM'; null = mês atual
  calDay: null,
  billTx: [],
  cats: { custom: [], rules: [] },
  people: [],
  myShare: true,
};
const charts = {};

// ---------------------------------------------------------------- datas
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
// fatura aberta = o que já foi lançado + parcelas de compras antigas que ainda vão cair até o fechamento
const openTotal = (o) => (o?.total || 0) + (o?.upcomingTotal || 0);
const brDate = (s) => { const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; };
// no ano corrente a data vai sem o ano (15/11); de outros anos, completa
const shortDate = (s) => s.slice(0, 4) === String(new Date().getFullYear()) ? brDate(s).slice(0, 5) : brDate(s);

function presetRange(p) {
  const t = new Date();
  const today = new Date(t.getFullYear(), t.getMonth(), t.getDate());
  switch (p) {
    case 'month': return [new Date(today.getFullYear(), today.getMonth(), 1), today];
    case 'lastmonth': return [new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0)];
    case '30': case '90': { const f = new Date(today); f.setDate(f.getDate() - Number(p) + 1); return [f, today]; }
    case 'year': return [new Date(today.getFullYear(), 0, 1), today];
    default: return [parse(state.from), parse(state.to)];
  }
}

// ---------------------------------------------------------------- api
async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('Sessão expirada'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro ${res.status}`);
  return data;
}

function showError(msg) {
  const el = $('#error-banner');
  el.hidden = !msg;
  el.textContent = msg || '';
}

async function loadAll(refresh = false) {
  const btn = $('#btn-refresh');
  btn.disabled = true; btn.classList.add('loading'); btn.querySelector('.lbl').textContent = 'Atualizando…';
  showError('');
  try {
    const q = refresh ? '?refresh=1' : '';
    const [status, accounts, cats] = await Promise.all([api(`/api/status${q}`), api(`/api/accounts${q}`), api('/api/categories').catch(() => state.cats)]);
    state.cats = cats;
    state.people = await api('/api/people').catch(() => state.people);
    state.billsPromise = api(`/api/bills${q}`).catch((err) => { showError(`Faturas: ${err.message}`); return []; });
    $('#demo-banner').hidden = !status.demo;
    state.status = status;
    state.accounts = accounts;
    watchItems(status.items.filter((i) => i.watching).map((i) => i.id)); // retoma após recarregar a página
    if (!status.demo && !status.items.length) showError('Nenhuma conexão configurada. Clique em “Conexões” e adicione o ID do seu item Pluggy (MeuPluggy).');
    const ITEM_MSG = { LOGIN_ERROR: 'erro de login', OUTDATED: 'desatualizada', NOT_FOUND: 'não encontrada', WAITING_USER_INPUT: 'o banco pede uma ação sua', WAITING_USER_ACTION: 'o banco pede uma ação sua' };
    const bad = status.items.filter((i) => i.error || ITEM_MSG[i.status]);
    if (bad.length) showError(`Atenção, conexão: ${bad.map((i) => `${i.connector || i.id} — ${ITEM_MSG[i.status] || i.status}${i.error ? ': ' + i.error : ''}`).join('; ')}. Reconecte em meu.pluggy.ai se necessário.`);
    const last = accounts.map((a) => a.lastUpdatedAt).filter(Boolean).sort().pop();
    state.lastSync = last;
    $('#updated').textContent = last ? `Sincronizado ${syncAgo(last)}` : '';
    $('#updated').title = last ? new Date(last).toLocaleString('pt-BR') : '';
    await loadTransactions(refresh);
    state.bills = await state.billsPromise;
    await loadGoalData(refresh);
    renderBillAlert();
    render();
    renderToday();
    if (state.view === 'bills') renderBills();
  } catch (err) {
    showError(err.message);
  } finally {
    btn.disabled = false; btn.classList.remove('loading'); btn.querySelector('.lbl').textContent = 'Atualizar';
  }
}

async function loadTransactions(refresh = false) {
  const [f, t] = presetRange(state.preset);
  state.from = iso(f); state.to = iso(t);
  $('#from').value = state.from; $('#to').value = state.to;
  const key = `${state.from}|${state.to}`;
  if (refresh || state.loadedRange !== key) {
    state.transactions = await api(`/api/transactions?from=${state.from}&to=${state.to}${refresh ? '&refresh=1' : ''}`);
    state.loadedRange = key;
  }
  state.shown = PAGE;
  render();
}

// ---------------------------------------------------------------- derivação
const accById = () => Object.fromEntries(state.accounts.map((a) => [a.id, a]));
const selectedAccounts = () => state.selected.size ? state.accounts.filter((a) => state.selected.has(a.id)) : state.accounts;

function periodTx() {
  const ids = new Set(selectedAccounts().map((a) => a.id));
  return state.transactions.filter((t) => ids.has(t.accountId) &&
    !(state.excludeInternal && (INTERNAL.test(t.category) || INTERNAL.test(t.description))))
    .map((t) => state.myShare && t.myAmount != null ? { ...t, amount: t.myAmount, signed: -t.myAmount, fullAmount: t.amount } : t);
}

// ---------------------------------------------------------------- despesas divididas
const personName = (id) => state.people.find((p) => p.id === id)?.name || '?';
// attr: data-share-tx (lançamento) ou data-share-up (parcela prevista, pelo id da parcela que a originou)
function shareChip(t, attr = 'data-share-tx') {
  if (t.direction !== 'out' || !t.id) return '';
  if (!t.shares) return ` <button type="button" class="chip share-add" ${attr}="${esc(t.id)}" title="Registrar que esta despesa é (em parte) de outra pessoa">+ dividir</button>`;
  const names = t.shares.map((x) => `${personName(x.personId)} ${fmt(x.amount)}`).join(' · ');
  return ` <button type="button" class="chip share" ${attr}="${esc(t.id)}" title="Sua parte: ${fmt(t.myAmount)}${t.shareScope === 'purchase' ? ' · vale para todas as parcelas' : ''} — clique para alterar">👥 ${esc(names)}</button>`;
}
const D = (t) => `<span title="${esc(t.description)}">${esc(G.tidyDescription(t.description))}</span>`;
const instLabel = (a) => /meupluggy/i.test(a?.institution || '') ? '' : (a?.institution || '');
const fullNote = (t) => t.fullAmount != null && t.fullAmount !== t.amount ? `<small>de ${fmt(t.fullAmount)}</small>` : '';

function tableTx(list) {
  const q = $('#search').value.trim().toLowerCase();
  const cat = $('#cat-filter').value;
  const dir = $('#dir-filter').value;
  return list.filter((t) =>
    (!q || t.description.toLowerCase().includes(q) || (t.merchant || '').toLowerCase().includes(q)) &&
    (!cat || t.category === cat) && (!dir || t.direction === dir));
}

// ---------------------------------------------------------------- render
function render() {
  const tx = periodTx();
  renderKpis(tx);
  renderAccounts();
  renderCharts(tx);
  renderCategoryFilter(tx);
  renderTable(tx);
}

function renderKpis(tx) {
  const banks = selectedAccounts().filter((a) => a.kind === 'bank');
  const saldo = banks.reduce((s, a) => s + a.balance, 0);
  const inc = tx.filter((t) => t.direction === 'in').reduce((s, t) => s + t.amount, 0);
  const out = tx.filter((t) => t.direction === 'out').reduce((s, t) => s + t.amount, 0);
  const res = inc - out;
  const days = Math.max(1, Math.round((parse(state.to) - parse(state.from)) / 864e5) + 1);
  const tile = (label, value, hint, cls = '') =>
    `<div class="kpi"><div class="label">${label}</div><div class="value ${cls}">${value}</div><div class="hint">${hint}</div></div>`;
  $('#kpis').innerHTML = [
    tile('Saídas', fmt(out), `média ${fmt(out / days)}/dia`),
    tile('Entradas', fmt(inc), `${brDate(state.from).slice(0, 5)} – ${brDate(state.to).slice(0, 5)}`),
    tile('Resultado', (res >= 0 ? '+' : '−') + fmt(Math.abs(res)), res >= 0 ? 'sobrou no período' : 'gastou mais do que entrou', res >= 0 ? 'pos' : 'neg'),
    tile('Saldo em conta', banks.length ? fmt(saldo) : '—', banks.length ? 'hoje' : 'nenhuma conta selecionada'),
  ].join('');
}

function accLabel(a) {
  return a.kind === 'credit' ? 'Cartão de crédito' : a.subtype === 'SAVINGS_ACCOUNT' ? 'Poupança' : 'Conta corrente';
}

// cartão sem limite, sem fatura e sem lançamento no período não serve como filtro: fica de fora
const accountUsed = (a) => a.kind !== 'credit' || a.balance || state.transactions.some((t) => t.accountId === a.id)
  || state.bills.some((c) => c.account.id === a.id && (c.bills.length || c.open?.txCount));
function renderAccounts() {
  const sorted = state.accounts.filter(accountUsed).sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  $('#accounts').classList.toggle('filtering', state.selected.size > 0);
  $('#accounts').innerHTML = sorted.map((a) => {
    const off = state.selected.size && !state.selected.has(a.id);
    let meta = accLabel(a) + (instLabel(a) ? ` · ${esc(instLabel(a))}` : '');
    let meter = '';
    if (a.kind === 'credit' && a.creditLimit) {
      const used = Math.min(100, ((a.creditLimit - (a.availableLimit ?? a.creditLimit - a.balance)) / a.creditLimit) * 100);
      meter = `<div class="meter" title="${used.toFixed(0)}% do limite usado"><span style="width:${used}%"></span></div>`;
      meta = `disponível ${fmt(a.availableLimit ?? 0)} de ${BRL0.format(a.creditLimit)}`;
    }
    return `<button class="acc ${off ? 'off' : ''}" data-id="${a.id}" style="${a.institutionColor ? `--inst:${a.institutionColor}` : ''}" aria-pressed="${!off}">
      <span class="name">${esc(a.name)}</span>
      <span class="bal">${a.kind === 'credit' ? 'usado ' : ''}${fmt(a.balance)}</span>
      ${meter}<span class="meta">${meta}</span></button>`;
  }).join('') || '<p class="muted">Nenhuma conta encontrada.</p>';
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function bucketing() {
  const days = Math.round((parse(state.to) - parse(state.from)) / 864e5) + 1;
  if (days <= 45) return { unit: 'day', key: (s) => s, label: (k) => k.slice(8) + '/' + k.slice(5, 7) };
  if (days <= 180) return {
    unit: 'week',
    key: (s) => { const d = parse(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return iso(d); },
    label: (k) => 'sem ' + k.slice(8) + '/' + k.slice(5, 7),
  };
  const M = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  return { unit: 'month', key: (s) => s.slice(0, 7), label: (k) => `${M[Number(k.slice(5)) - 1]}/${k.slice(2, 4)}` };
}

function bucketKeys(b) {
  const keys = [];
  const end = parse(state.to);
  const d = parse(b.key(state.from).length === 7 ? b.key(state.from) + '-01' : b.key(state.from));
  while (d <= end) {
    keys.push(b.key(iso(d)));
    if (b.unit === 'day') d.setDate(d.getDate() + 1);
    else if (b.unit === 'week') d.setDate(d.getDate() + 7);
    else d.setMonth(d.getMonth() + 1);
  }
  return [...new Set(keys)];
}

function baseOptions(horizontal = false) {
  const grid = cssVar('--grid'), muted = cssVar('--muted'), text = cssVar('--text');
  const valueAxis = { grid: { color: grid, drawTicks: false }, border: { display: false }, ticks: { color: muted, padding: 6, maxRotation: 0, maxTicksLimit: horizontal ? 5 : 8, callback: (v) => BRL0.format(v) } };
  const catAxis = { grid: { display: false }, border: { color: cssVar('--axis') }, ticks: { color: horizontal ? text : muted, autoSkip: !horizontal, maxRotation: 0 } };
  return {
    responsive: true, maintainAspectRatio: false, animation: { duration: 200 },
    indexAxis: horizontal ? 'y' : 'x',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: cssVar('--surface'), titleColor: text, bodyColor: cssVar('--text-2'),
        borderColor: cssVar('--border'), borderWidth: 1, padding: 10, boxPadding: 4,
        callbacks: { label: (c) => ` ${c.dataset.label}: ${fmt(c.parsed[horizontal ? 'x' : 'y'])}` },
      },
    },
    scales: horizontal ? { x: valueAxis, y: catAxis } : { x: catAxis, y: valueAxis },
  };
}

function setChart(id, config, empty) {
  charts[id]?.destroy();
  const box = document.getElementById(id).parentElement;
  box.querySelector('.empty')?.remove();
  if (empty) { box.insertAdjacentHTML('beforeend', '<div class="empty">Sem dados</div>'); charts[id] = null; return; }
  if (config.options.indexAxis === 'y') box.style.height = `${Math.max(160, config.data.labels.length * 34 + 40)}px`;
  // o clique costuma redesenhar o próprio gráfico: roda depois que o Chart.js termina o evento,
  // senão ele segue processando o clique num gráfico já destruído (TypeError 'handleEvent')
  const click = config.options?.onClick;
  if (click) config.options.onClick = (...a) => setTimeout(() => click(...a));
  charts[id] = new Chart(document.getElementById(id), config);
}

function renderCharts(tx) {
  const bar = { borderRadius: 4, borderSkipped: 'start', maxBarThickness: 28, categoryPercentage: 0.7, barPercentage: 0.9 };
  // fluxo
  const b = bucketing();
  const keys = bucketKeys(b);
  const inc = Object.fromEntries(keys.map((k) => [k, 0]));
  const out = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const t of tx) { const k = b.key(t.date); if (k in inc) (t.direction === 'in' ? inc : out)[k] += t.amount; }
  setChart('chart-flow', {
    type: 'bar',
    data: {
      labels: keys.map(b.label),
      datasets: [
        { label: 'Entradas', data: keys.map((k) => inc[k]), backgroundColor: cssVar('--series-1'), ...bar },
        { label: 'Saídas', data: keys.map((k) => out[k]), backgroundColor: cssVar('--series-2'), ...bar },
      ],
    },
    options: baseOptions(),
  }, !tx.length);

  // categorias (só saídas)
  const byCat = {};
  for (const t of tx) if (t.direction === 'out') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  let cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  if (cats.length > 9) cats = [...cats.slice(0, 8), ['Outros', cats.slice(8).reduce((s, [, v]) => s + v, 0)]];
  const hbar = { ...bar, maxBarThickness: 22, categoryPercentage: 0.8 };
  const hopts = baseOptions(true);
  hopts.interaction = { mode: 'nearest', axis: 'y', intersect: false };
  const selCat = $('#cat-filter').value;
  const copts = { ...hopts, onClick: (_, els) => {
    if (!els[0]) return;
    const c = cats[els[0].index][0];
    if (c === 'Outros') return;
    filterByCategory($('#cat-filter').value === c ? '' : c);
  }, onHover: (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; } };
  const base = cssVar('--series-2');
  setChart('chart-cat', {
    type: 'bar',
    data: { labels: cats.map(([c]) => c === 'Outros' ? 'Outros' : catName(c)), datasets: [{ label: 'Gasto', data: cats.map(([, v]) => v), backgroundColor: cats.map(([c]) => !selCat || c === selCat ? base : base + '55'), ...hbar }] },
    options: copts,
  }, !cats.length);

  // por conta (painel removido da tela; mantido se voltar)
  if (!document.getElementById('chart-acc')) return;
  const accs = accById();
  const byAcc = {};
  for (const t of tx) if (t.direction === 'out') byAcc[t.accountId] = (byAcc[t.accountId] || 0) + t.amount;
  const accRows = Object.entries(byAcc).sort((a, b) => b[1] - a[1]);
  setChart('chart-acc', {
    type: 'bar',
    data: {
      labels: accRows.map(([id]) => innerWidth < 600 ? (accs[id]?.name ?? id) : `${accs[id]?.name ?? id} · ${accs[id]?.institution ?? ''}`),
      datasets: [{ label: 'Gasto', data: accRows.map(([, v]) => v), backgroundColor: cssVar('--series-2'), ...hbar }],
    },
    options: hopts,
  }, !accRows.length);
}

function filterByCategory(c) {
  renderCategoryFilter(periodTx());
  $('#cat-filter').value = c;
  state.shown = PAGE;
  renderTable(periodTx());
  renderCharts(periodTx());
  if (c) $('#tx-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function renderCategoryFilter(tx) {
  const sel = $('#cat-filter');
  const cur = sel.value;
  const cats = [...new Set(tx.map((t) => t.category))].sort((a, b) => catName(a).localeCompare(catName(b)));
  sel.innerHTML = '<option value="">Todas as categorias</option>' +
    cats.map((c) => `<option value="${esc(c)}"${c === cur ? ' selected' : ''}>${esc(catName(c))}</option>`).join('');
}

function renderTable(tx) {
  const rows = tableTx(tx);
  const accs = accById();
  const total = rows.reduce((s, t) => s + t.signed, 0);
  $('#tx-count').textContent = `· ${rows.length} de ${tx.length}`;
  $('#tx-total').innerHTML = `<span class="${total >= 0 ? 'pos' : ''}">${total >= 0 ? '+' : '−'}${fmt(Math.abs(total))}</span>`;
  $('#tx-body').innerHTML = rows.slice(0, state.shown).map((t) => {
    const a = accs[t.accountId] || {};
    return `<tr>
      <td class="date" title="${brDate(t.date)}">${shortDate(t.date)}</td>
      <td class="desc">${D(t)}${t.installment ? ` <span class="chip">${t.installment}</span>` : ''}${shareChip(t)}${t.merchant && t.merchant !== t.description ? `<small>${esc(t.merchant)}</small>` : ''}</td>
      <td class="cat">${catChip(t)}</td>
      <td class="acct" style="${a.institutionColor ? `--inst:${a.institutionColor}` : ''}"><span class="dot"></span>${esc(a.name || '')}</td>
      <td class="num ${t.direction === 'in' ? 'pos' : ''}">${t.direction === 'in' ? '+' : '−'}${fmt(t.amount)}${fullNote(t)}</td></tr>`;
  }).join('') || '<tr><td colspan="5" class="muted">Nenhuma transação no período.</td></tr>';
  $('#btn-more').hidden = rows.length <= state.shown;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function exportCsv() {
  const accs = accById();
  const rows = tableTx(periodTx());
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['data', 'descricao', 'categoria', 'conta', 'instituicao', 'tipo', 'valor'].join(';'),
    ...rows.map((t) => [t.date, q(t.description), q(catName(t.category)), q(accs[t.accountId]?.name), q(accs[t.accountId]?.institution), t.direction === 'in' ? 'entrada' : 'saida', t.signed.toFixed(2).replace('.', ',')].join(';'))];
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `transacoes_${state.from}_${state.to}.csv` });
  a.click(); URL.revokeObjectURL(a.href);
}

// ---------------------------------------------------------------- faturas
const todayLocal = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };
const daysUntil = (s) => Math.round((parse(s) - todayLocal()) / 864e5);
const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (s) => `${MONTHS[Number(s.slice(5, 7)) - 1]}/${s.slice(2, 4)}`;
const inDays = (n) => n === 0 ? 'hoje' : n === 1 ? 'amanhã' : `em ${n} dias`;
const cardsWithBills = () => state.bills.filter((c) => c.bills.length || c.open?.txCount);

function billStatus(b) {
  if (b.status === 'open') return { cls: 'open', text: b.closeDate ? `Aberta · fecha ${inDays(Math.max(0, daysUntil(b.closeDate)))}` : 'Aberta' };
  if (b.status === 'due') { const n = daysUntil(b.dueDate); return { cls: n <= 3 ? 'soon' : 'due', text: `Fechada · vence ${inDays(n)}` }; }
  return { cls: '', text: 'Encerrada' };
}

function renderBillAlert() {
  $('#bill-alert').hidden = true; return; // o conteúdo vive nos cartões da aba Hoje
  // eslint-disable-next-line no-unreachable
  const items = [];
  for (const c of state.bills) {
    for (const b of c.bills) {
      if (b.status !== 'due') continue;
      const n = daysUntil(b.dueDate);
      if (n <= 7) items.push(`<li><strong>${esc(c.account.name)}</strong>: fatura de <strong>${fmt(b.total)}</strong> vence ${inDays(n)} (${brDate(b.dueDate)})${b.minimum ? ` · mínimo ${fmt(b.minimum)}` : ''}</li>`);
    }
    const o = c.open;
    if (o?.closeDate && o.txCount && daysUntil(o.closeDate) <= 3) items.push(`<li><strong>${esc(c.account.name)}</strong>: fatura aberta fecha ${inDays(Math.max(0, daysUntil(o.closeDate)))} (~${brDate(o.closeDate)}) · ${fmt(openTotal(o))} com as parcelas previstas</li>`);
  }
  for (const c of state.bills) {
    const w = weekStatus(c.account.id);
    if (!w) continue;
    const pace = w.ahead ? ` · média de ${fmt(w.avgDaily)}/dia, acima dos ${fmt(w.goalDaily)}/dia da meta` : '';
    if (w.pct > 100) items.push(`<li><strong>${esc(c.account.name)}</strong>: meta semanal estourada em ${fmt(w.spent - w.goal)} (${fmt(w.spent)} de ${fmt(w.goal)})</li>`);
    else if (w.pct >= 80) items.push(`<li><strong>${esc(c.account.name)}</strong>: ${w.pct.toFixed(0)}% da meta semanal usada · restam ${fmt(w.goal - w.spent)} até domingo${pace}</li>`);
    else if (w.ahead) items.push(`<li><strong>${esc(c.account.name)}</strong>: ▲ média diária da semana em ${fmt(w.avgDaily)}, acima da meta diária de ${fmt(w.goalDaily)} (meta semanal ${fmt(w.goal)})</li>`);
  }
  for (const c of state.bills) {
    const m = monthStatus(c);
    if (!m) continue;
    if (m.spent > m.goal) items.push(`<li><strong>${esc(c.account.name)}</strong>: meta mensal estourada em ${fmt(m.spent - m.goal)} (${fmt(m.spent)} de ${fmt(m.goal)})</li>`);
    else if (m.ahead || (m.elapsed >= 3 && m.projected > m.goal)) items.push(`<li><strong>${esc(c.account.name)}</strong>: ${m.ahead ? `▲ média diária do ciclo em ${fmt(m.avgDaily)}, acima da meta diária de ${fmt(m.goalDaily)}` : `no ritmo atual a fatura fecha em ~${fmt(m.projected)}, acima da meta de ${fmt(m.goal)}`} · para manter a meta mensal, gaste até ${fmt(m.perDay)}/dia</li>`);
  }
  const el = $('#bill-alert');
  el.hidden = !items.length;
  el.innerHTML = items.length ? `<strong>Atenção</strong><ul>${items.join('')}</ul>` : '';
}

function stripes(color) {
  const c = document.createElement('canvas'); c.width = c.height = 8;
  const g = c.getContext('2d');
  g.strokeStyle = color; g.lineWidth = 2;
  g.beginPath(); g.moveTo(-2, 10); g.lineTo(10, -2); g.moveTo(-2, 2); g.lineTo(2, -2); g.moveTo(6, 10); g.lineTo(10, 6); g.stroke();
  return g.createPattern(c, 'repeat');
}

function renderBills() {
  const cards = cardsWithBills();
  if (!cards.length) {
    $('#card-select').innerHTML = '';
    $('#bill-kpis').innerHTML = '<p class="muted">Nenhuma fatura encontrada nos seus cartões.</p>';
    $('#bills-body').innerHTML = ''; $('#bill-detail').hidden = true;
    setChart('chart-bills', null, true);
    return;
  }
  if (!cards.some((c) => c.account.id === state.billCard)) { state.billCard = cards[0].account.id; state.billSel = 'open'; }
  const c = cards.find((x) => x.account.id === state.billCard);
  // nome do cartão basta; o banco só entra quando dois cartões têm o mesmo nome
  const dupName = (x) => cards.filter((y) => y.account.name === x.account.name).length > 1;
  $('#card-select').innerHTML = cards.map((x) => `<button data-card="${x.account.id}" class="${x === c ? 'active' : ''}" title="${esc(x.account.name)}${instLabel(x.account) ? ` · ${esc(instLabel(x.account))}` : ''}">${esc(x.account.name)}${dupName(x) && instLabel(x.account) ? ` · ${esc(instLabel(x.account))}` : ''}</button>`).join('');
  $('#card-select-box').hidden = cards.length < 2;

  const a = c.account;
  const next = [...c.bills].filter((b) => b.status === 'due').sort((x, y) => x.dueDate.localeCompare(y.dueDate))[0];
  const recent = c.bills.slice(0, 6);
  const avg = recent.length ? recent.reduce((s, b) => s + b.total, 0) / recent.length : 0;
  const o = c.open;
  const total = openTotal(o), posted = o?.total || 0, up = o?.upcomingTotal || 0;
  const scale = Math.max(total, avg, 1);
  const used = a.creditLimit ? Math.min(100, (a.balance / a.creditLimit) * 100) : null;
  const closeIn = o?.closeDate ? Math.max(0, daysUntil(o.closeDate)) : null;
  $('#bill-kpis').innerHTML = `
    <div class="panel bh-main">
      <div class="bh-top"><span class="label">Fatura aberta${cards.length < 2 ? ` · ${esc(a.name)}` : ''}</span>
        ${o?.closeDate ? `<span class="pill">fecha ${inDays(closeIn)} · ${brDate(o.closeDate).slice(0, 5)}</span>` : ''}</div>
      <div class="bh-big">${fmt(total)}</div>
      <div class="bh-bar" role="img" aria-label="Lançado ${fmt(posted)}, parcelas que ainda vão cair ${fmt(up)}${avg ? `, média das faturas ${fmt(avg)}` : ''}">
        <span class="seg-posted" style="width:${(posted / scale) * 100}%"></span><span class="seg-up" style="width:${(up / scale) * 100}%"></span>
        ${avg ? `<i class="bh-mark" style="left:${(avg / scale) * 100}%" title="Média das últimas faturas"></i>` : ''}
      </div>
      <div class="bh-legend">
        <span><i class="sw" style="background:var(--series-2)"></i>Lançado <strong>${fmt(posted)}</strong></span>
        ${up ? `<span><i class="sw sw-open"></i>Parcelas que vão cair <strong>${fmt(up)}</strong></span>` : ''}
        ${avg ? `<span><i class="sw sw-mark"></i>Média das faturas <strong>${fmt(avg)}</strong></span>` : ''}
      </div>
      ${o?.dueDate ? `<p class="muted small" style="margin:8px 0 0">Vence ~${brDate(o.dueDate)} · ${o.txCount || 0} lançamento(s)</p>` : ''}
    </div>
    <div class="bh-side">
      <div class="kpi"><div class="label">Próxima a pagar</div>${next
        ? `<div class="value">${fmt(next.total)}</div><div class="hint ${daysUntil(next.dueDate) <= 3 ? 'neg' : ''}">vence ${inDays(daysUntil(next.dueDate))} · ${brDate(next.dueDate)}${next.minimum ? ` · mínimo ${fmt(next.minimum)}` : ''}</div>`
        : '<div class="value-sm"><span class="ok-dot" aria-hidden="true">✓</span> Nada a pagar</div><div class="hint">nenhuma fatura fechada a vencer</div>'}</div>
      ${a.creditLimit ? `<div class="kpi"><div class="label">Limite disponível</div><div class="value">${fmt(a.availableLimit ?? 0)}</div>
        <div class="meter"><span style="width:${used}%"></span></div><div class="hint">usado ${fmt(a.balance)} de ${BRL0.format(a.creditLimit)} (inclui parcelas futuras)</div></div>` : ''}
    </div>`;

  // histórico: mais antiga → mais nova, aberta no fim
  const hist = [...c.bills].reverse();
  const rows = o?.dueDate ? [...hist, o] : hist;
  const color = cssVar('--series-2');
  const opts = baseOptions();
  opts.interaction = { mode: 'nearest', axis: 'x', intersect: false };
  opts.plugins.tooltip.callbacks = {
    title: (it) => { const b = rows[it[0].dataIndex]; return `Vencimento ${b.id === 'open' ? '~' : ''}${brDate(b.dueDate)}`; },
    label: (it) => { const b = rows[it.dataIndex]; return b.id === 'open' ? ` Até agora, com parcelas previstas: ${fmt(openTotal(b))}` : ` Total: ${fmt(b.total)}`; },
    afterLabel: (it) => { const b = rows[it.dataIndex]; return b.closeDate ? ` Fechamento ${b.id === 'open' ? '~' : ''}${brDate(b.closeDate)}` : ''; },
  };
  opts.onClick = (_, els) => { if (els[0]) selectBill(rows[els[0].index].id); };
  setChart('chart-bills', {
    type: 'bar',
    data: {
      labels: rows.map((b) => monthLabel(b.dueDate)),
      datasets: [{
        label: 'Fatura', data: rows.map((b) => b.id === 'open' ? openTotal(b) : b.total),
        backgroundColor: rows.map((b) => b.id === 'open' ? stripes(color) : color),
        borderColor: color, borderWidth: rows.map((b) => b.id === 'open' ? 1.5 : 0),
        borderRadius: 4, borderSkipped: 'start', maxBarThickness: 36, categoryPercentage: 0.7,
      }],
    },
    options: opts,
  }, !rows.length);

  const all = o ? [o, ...c.bills] : c.bills;
  $('#bill-pick').innerHTML = all.map((b) => `<option value="${esc(b.id)}"${b.id === state.billSel ? ' selected' : ''}>${b.id === 'open' ? 'Fatura aberta' : `Venc. ${brDate(b.dueDate)} · ${fmt(b.total)}`}</option>`).join('');
  $('#bills-body').innerHTML = all.map((b) => {
    const st = billStatus(b), est = b.id === 'open' ? '~' : '';
    return `<tr data-bill="${b.id}" class="${b.id === state.billSel ? 'sel' : ''}">
      <td class="date">${b.dueDate ? est + brDate(b.dueDate) : '—'}</td>
      <td class="date opt">${b.closeDate ? est + brDate(b.closeDate) : '—'}</td>
      <td><span class="status ${st.cls}">${st.text}</span></td>
      <td class="num opt">${b.txCount}</td>
      <td class="num opt">${b.minimum != null ? fmt(b.minimum) : '—'}</td>
      <td class="num"><strong>${fmt(b.id === 'open' ? openTotal(b) : b.total)}</strong>${b.id === 'open' ? ' <span class="chip">parcial</span>' : ''}</td></tr>`;
  }).join('');
  renderGoal(c);
  renderMonthlyGoal(c);
  renderCalendar(c);
  loadBillDetail();
}

function selectBill(id) {
  state.billSel = id;
  $('#bill-pick').value = id;
  document.querySelectorAll('#bills-body tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.bill === id));
  loadBillDetail();
}

async function loadBillDetail() {
  const c = state.bills.find((x) => x.account.id === state.billCard);
  const b = state.billSel === 'open' ? c?.open : c?.bills.find((x) => x.id === state.billSel);
  if (!b) { $('#bill-detail').hidden = true; return; }
  $('#bill-detail').hidden = false;
  $('#bill-detail-title').textContent = 'O que tem na fatura';
  $('#bill-detail-sub').textContent = b.closeDate ? `fechamento ${b.id === 'open' ? '~' : ''}${brDate(b.closeDate)}` : '';
  $('#bill-tx-body').innerHTML = '<tr><td colspan="4" class="muted">Carregando…</td></tr>';
  const key = `${state.billCard}|${b.id}`;
  state.billKey = key;
  let tx;
  try { tx = await api(`/api/bills/transactions?accountId=${state.billCard}&billId=${b.id}`); }
  catch (err) { $('#bill-tx-body').innerHTML = `<tr><td colspan="4">${esc(err.message)}</td></tr>`; return; }
  if (state.billKey !== key) return;
  state.billTx = tx;
  const sum = tx.reduce((s, t) => s + (G.isCardPayment(t) ? 0 : t.direction === 'out' ? t.amount : -t.amount), 0);
  const hasPay = tx.some(G.isCardPayment);
  $('#bill-tx-body').innerHTML = tx.map((t) => G.isCardPayment(t) ? `<tr class="muted">
      <td class="date" title="${brDate(t.date)}">${shortDate(t.date)}</td>
      <td class="desc">${D(t)} <span class="chip">pagamento</span></td>
      <td class="cat"></td>
      <td class="num">${fmt(t.amount)}</td></tr>` : `<tr>
      <td class="date" title="${brDate(t.date)}">${shortDate(t.date)}</td>
      <td class="desc">${D(t)}${t.installment ? ` <span class="chip">${t.installment}</span>` : ''}${shareChip(t)}</td>
      <td class="cat">${catChip(t)}</td>
      <td class="num ${t.direction === 'in' ? 'pos' : ''}">${t.direction === 'in' ? '−' : ''}${fmt(t.amount)}</td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">Nenhum lançamento.</td></tr>';
  const up = b.id === 'open' ? (b.upcoming || []) : [];
  state.billUp = up;
  if (up.length) {
    $('#bill-tx-body').insertAdjacentHTML('afterbegin', up.map((u) => `<tr class="predicted">
      <td class="date">prevista</td>
      <td class="desc">${D(u)} <span class="chip">${u.installment}</span>${shareChip(upTx(u), 'data-share-up')}<small>compra em ${u.purchaseDate ? brDate(u.purchaseDate) : '—'}</small></td>
      <td class="cat">${catChip(upTx(u), 'data-cat-up')}</td>
      <td class="num">${fmt(u.amount)}</td></tr>`).join(''));
  }
  // lista longa: mostra as primeiras linhas e um botão para abrir o resto (sem rolagem dentro da página)
  const nRows = $('#bill-tx-body').children.length;
  $('#bill-tx-body').classList.toggle('clip', nRows > BILL_ROWS);
  $('#btn-bill-more').hidden = nRows <= BILL_ROWS;
  $('#btn-bill-more').textContent = `Mostrar todos os ${nRows} lançamentos`;
  $('#bill-tx-total').textContent = up.length ? `${fmt(sum)} + ${fmt(up.reduce((s, u) => s + u.amount, 0))} previstas` : fmt(sum);
  $('#bill-tx-note').textContent = b.id === 'open'
    ? (up.length ? `As ${up.length} linhas "prevista" são próximas parcelas de compras que estavam na última fatura; o valor é o da parcela anterior. ` : '')
      + (hasPay ? 'Pagamentos de fatura anterior aparecem na lista mas não abatem o total. ' : '') + 'Fatura ainda aberta: o valor sobe até o fechamento.'
    : Math.abs(sum - b.total) > 0.01 ? `O total da fatura (${fmt(b.total)}) difere da soma dos lançamentos: ele inclui saldo anterior, pagamentos, juros e encargos.` : '';
  const byCat = {};
  for (const t of tx) if (t.direction === 'out') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  let cats = Object.entries(byCat).sort((x, y) => y[1] - x[1]).map(([k, v]) => [k, v, [k]]);
  if (cats.length > 9) cats = [...cats.slice(0, 8), [OTHER_CAT, cats.slice(8).reduce((s, [, v]) => s + v, 0), cats.slice(8).map(([k]) => k)]];
  state.billCats = cats;
  // mantém a categoria aberta se continuar na mesma fatura (ex.: depois de recategorizar)
  if (state.billCatSel?.bill !== key || !cats.some(([k]) => k === state.billCatSel.cat)) state.billCatSel = null;
  renderBillCatChart();
}

const BILL_ROWS = 10;
$('#btn-bill-more').addEventListener('click', (e) => { $('#bill-tx-body').classList.remove('clip'); e.currentTarget.hidden = true; });
const OTHER_CAT = '__outros';
function renderBillCatChart() {
  const cats = state.billCats || [];
  const sel = state.billCatSel?.cat;
  const hopts = baseOptions(true);
  hopts.interaction = { mode: 'nearest', axis: 'y', intersect: false };
  hopts.onClick = (_, els) => { if (els[0]) toggleBillCat(cats[els[0].index][0]); };
  hopts.onHover = (e, els) => { e.native.target.style.cursor = els.length ? 'pointer' : 'default'; };
  const base = cssVar('--series-2');
  setChart('chart-bill-cat', {
    type: 'bar',
    data: {
      labels: cats.map(([k]) => k === OTHER_CAT ? 'Outros' : catName(k)),
      datasets: [{
        label: 'Gasto', data: cats.map(([, v]) => v),
        backgroundColor: cats.map(([k]) => !sel || k === sel ? base : base + '55'),
        borderRadius: 4, borderSkipped: 'start', maxBarThickness: 22, categoryPercentage: 0.8, barPercentage: 0.9,
      }],
    },
    options: hopts,
  }, !cats.length);
  $('#bill-cat-hint').hidden = !cats.length || !!sel;
  renderBillCatDetail();
}

function toggleBillCat(cat) {
  state.billCatSel = state.billCatSel?.cat === cat ? null : { bill: state.billKey, cat };
  renderBillCatChart();
  if (state.billCatSel) $('#bill-cat-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderBillCatDetail() {
  const sel = state.billCatSel && state.billCats?.find(([k]) => k === state.billCatSel.cat);
  $('#bill-cat-detail').hidden = !sel;
  if (!sel) return;
  const [cat, total, keys] = sel;
  const rows = state.billTx.filter((t) => t.direction === 'out' && keys.includes(t.category))
    .sort((a, b) => b.amount - a.amount);
  $('#bill-cat-title').textContent = `${cat === OTHER_CAT ? 'Outros' : catName(cat)} · ${rows.length} ${rows.length === 1 ? 'gasto' : 'gastos'}`;
  $('#bill-cat-body').innerHTML = rows.map((t) => `<tr>
      <td class="date" title="${brDate(t.date)}">${shortDate(t.date)}</td>
      <td class="desc">${D(t)}${t.installment ? ` <span class="chip">${t.installment}</span>` : ''}${shareChip(t)}</td>
      <td class="cat">${catChip(t)}</td>
      <td class="num">${fmt(t.amount)}</td></tr>`).join('');
  $('#bill-cat-total').textContent = fmt(total);
}
$('#btn-bill-cat-close').addEventListener('click', () => { state.billCatSel = null; renderBillCatChart(); });

// ---------------------------------------------------------------- meta semanal
const { WEEKS } = G;
const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

async function loadGoalData(refresh) {
  const cards = state.accounts.filter((a) => a.kind === 'credit').map((a) => a.id);
  const from = iso(addDays(weekStart(new Date()), -7 * (WEEKS - 1)));
  const [goals, tx] = await Promise.all([
    api('/api/goals').catch(() => ({})),
    cards.length ? api(`/api/transactions?from=${from}&to=${iso(todayLocal())}&accountIds=${cards.join(',')}${refresh ? '&refresh=1' : ''}`).catch(() => []) : [],
  ]);
  state.goals = goals; state.weekTx = tx;
  state.calKey = null; // recarrega o calendário junto
}

// Cálculos das metas em shared.js (os mesmos do bot do Telegram)
const todayIso = () => iso(todayLocal());
const spendTx = (accountId) => G.spendItems(state.weekTx, accountId);
const weeklySpend = (accountId) => G.weeklySpend(spendTx(accountId), todayIso());
const weekStatus = (accountId) => G.weekStatus(spendTx(accountId), state.goals[accountId]?.weekly, todayIso(), state.bills.find((x) => x.account.id === accountId));

// Sinal de ritmo: média diária acumulada vs. meta diária
function paceBadge(x, what) {
  const diff = x.avgDaily - x.goalDaily;
  const pct = x.goalDaily ? (diff / x.goalDaily) * 100 : 0;
  return x.ahead
    ? `<div class="pace ahead" role="status"><span class="ico">▲</span><div><strong>Média diária acima da meta</strong>: ${fmt(x.avgDaily)}/dia ${what}, contra ${fmt(x.goalDaily)}/dia da meta (+${pct.toFixed(0)}%, ${fmt(diff)}/dia a mais)</div></div>`
    : `<div class="pace" role="status"><span class="ico">✓</span><div>Média diária de ${fmt(x.avgDaily)}/dia ${what}, dentro da meta de ${fmt(x.goalDaily)}/dia</div></div>`;
}

function renderGoal(c) {
  const id = c.account.id;
  const goal = state.goals[id]?.weekly;
  const weeks = weeklySpend(id);
  const past = weeks.slice(0, -1).slice(-4);
  const avg = past.length ? past.reduce((s, w) => s + Math.max(0, w.spent), 0) / past.length : 0;
  // o quadro de meta é um só: com meta por fatura, quem desenha é renderMonthlyGoal
  if (goal && !state.goals[id]?.monthly) {
    const w = weekStatus(id);
    const today = todayLocal();
    const end = addDays(parse(w.start), 6);
    const daysLeft = Math.round((end - today) / 864e5) + 1; // inclui hoje
    const left = w.goal - w.spent;
    const cls = w.pct > 100 ? 'over' : (w.pct >= 80 || w.ahead) ? 'warn' : '';
    const status = w.pct > 100 ? `<span class="ico neg">✕</span> Meta estourada em ${fmt(-left)}`
      : w.pct >= 80 ? `<span class="ico">!</span> ${w.pct.toFixed(0)}% da meta usada · restam ${fmt(left)}`
      : w.ahead ? `<span class="ico">!</span> Dentro da meta por enquanto · restam ${fmt(left)}`
      : `<span class="ico pos">✓</span> Dentro da meta · restam ${fmt(left)}`;
    const hits = past.filter((x) => x.spent <= w.goal).length;

    // meta proporcional ao ciclo da fatura aberta
    const lastClose = c.bills.map((b) => b.closeDate).filter(Boolean).sort().at(-1);
    let cycle = '';
    if (lastClose && c.open?.closeDate) {
      const days = Math.round((parse(c.open.closeDate) - parse(lastClose)) / 864e5);
      const cycleGoal = (w.goal * days) / 7;
      const diff = cycleGoal - openTotal(c.open);
      cycle = `<div class="wide"><div class="label">Fatura aberta vs. meta</div><div class="v">${fmt(openTotal(c.open))} <span class="muted small">de ${fmt(cycleGoal)}</span></div>
        <div class="h">${(days / 7).toFixed(1).replace('.', ',')} semanas de ciclo · ${diff >= 0 ? `folga de ${fmt(diff)}` : `${fmt(-diff)} acima`}</div></div>`;
    }
    $('#goal-title').textContent = 'Meta semanal';
    $('#goal-body').innerHTML = `
      <div class="goal-big">${fmt(w.spent)} <small>de ${fmt(w.goal)} nesta semana</small></div>
      ${w.installments > 0.004 ? `<p class="small muted" style="margin:2px 0 6px">${fmt(w.posted)} lançados + <strong>${fmt(w.installments)}</strong> de parcelas que ainda vão cair (a parte desta semana)</p>` : ''}
      <div class="goal-meter ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, w.pct).toFixed(0)}"><span style="width:${Math.min(100, w.pct)}%"></span></div>
      <div class="goal-status">${status}</div>
      ${paceBadge(w, `nesta semana (${w.elapsed} dia${w.elapsed > 1 ? 's' : ''})`)}
      <div class="goal-facts">
        <div><div class="label">Semana</div><div class="v">${brDate(w.start).slice(0, 5)} – ${brDate(iso(end)).slice(0, 5)}</div><div class="h">${daysLeft === 1 ? 'último dia' : `faltam ${daysLeft} dias`} · ${w.count} compra(s)</div></div>
        <div><div class="label">Pode gastar por dia</div><div class="v">${left > 0 ? fmt(left / daysLeft) : fmt(0)}</div><div class="h">até domingo</div></div>
        <div><div class="label">Últimas ${past.length} semanas</div><div class="v">${hits} de ${past.length}</div><div class="h">dentro da meta · média ${fmt(avg)}</div></div>
        ${cycle}
      </div>`;
  }
}

const WEEKDAYS = ['seg', 'ter', 'qua', 'qui', 'sex', 'sáb', 'dom'];

// ---------------------------------------------------------------- calendário do mês
// Mês do calendário (seg–dom) com o gasto de cada dia no cartão; clicar num dia lista os lançamentos.
// Mesmas regras das metas: sem pagamento de fatura, estorno abate, compra dividida conta só a sua parte.
const MONTHS_FULL = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const NUM0 = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
const calCard = () => state.bills.find((x) => x.account.id === state.billCard);
const monthShift = (ym, n) => { const d = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)) - 1 + n, 1); return iso(d).slice(0, 7); };

async function renderCalendar(c) {
  const id = c.account.id;
  const today = todayIso();
  const ym = state.calMonth || today.slice(0, 7);
  const first = `${ym}-01`;
  const last = iso(new Date(Number(ym.slice(0, 4)), Number(ym.slice(5)), 0));
  const key = `${id}|${ym}`;
  $('#cal-title').textContent = `${MONTHS_FULL[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
  $('#btn-cal-today').hidden = ym === today.slice(0, 7);
  $('#btn-cal-next').disabled = ym >= today.slice(0, 7);
  if (state.calKey !== key) {
    $('#cal-grid').setAttribute('aria-busy', 'true');
    let tx;
    // semanas inteiras (seg–dom) que o mês toca: o total da semana conta os dias do mês vizinho
    const from = G.weekStartIso(first), to = G.isoAddDays(G.weekStartIso(last), 6);
    try { tx = await api(`/api/transactions?from=${from}&to=${to}&accountIds=${id}`); }
    catch (err) { $('#cal-note').textContent = `Não foi possível carregar o mês: ${err.message}`; return; }
    finally { $('#cal-grid').removeAttribute('aria-busy'); }
    // trocou de cartão/mês enquanto carregava: a chamada mais nova desenha
    if (`${state.billCard}|${state.calMonth || todayIso().slice(0, 7)}` !== key) return;
    state.calTx = tx; state.calKey = key;
  }

  const byDay = {};
  for (const t of G.spendItems(state.calTx, id)) {
    const d = (byDay[t.date] ||= { spent: 0, count: 0 });
    d.spent += t.net; if (t.out) d.count++;
  }
  const n = Number(last.slice(8));
  const days = Array.from({ length: n }, (_, i) => `${ym}-${pad(i + 1)}`);
  const max = Math.max(0, ...days.map((d) => byDay[d]?.spent || 0));
  const weekly = state.goals[id]?.weekly;
  const daily = weekly ? weekly / 7 : null;
  if (!days.includes(state.calDay) || state.calDay > today) state.calDay = null;

  const lead = (parse(first).getDay() + 6) % 7; // segunda = 0
  const head = WEEKDAYS.map((w) => `<div class="cal-h" role="columnheader">${w}</div>`).join('')
    + '<div class="cal-h cal-wk-h" role="columnheader">semana</div>';
  const blank = '<div class="cal-blank" aria-hidden="true"></div>';
  const cells = days.map((d) => {
    const v = byDay[d]?.spent || 0, cnt = byDay[d]?.count || 0, future = d > today;
    const lvl = v > 0 && max > 0 ? Math.max(0.12, v / max) : 0;
    const cls = ['cal-d', future && 'future', d === today && 'today', d === state.calDay && 'sel', daily && v > daily && 'over'].filter(Boolean).join(' ');
    const label = `${brDate(d)}: ${future ? 'dia futuro' : v ? `${fmt(v)} em ${cnt} compra(s)` : 'sem gastos'}`;
    return `<button type="button" role="gridcell" class="${cls}" data-day="${d}" style="--lvl:${(lvl * 100).toFixed(0)}%" aria-label="${label}" aria-pressed="${d === state.calDay}"${future ? ' disabled' : ''}>
      <span class="n">${Number(d.slice(8))}</span>${!future && v ? `<span class="v">${v < 0 ? '−' : ''}${NUM0.format(Math.abs(v))}</span>` : ''}</button>`;
  });
  // total de cada semana (seg–dom) no fim da linha; a semana atual soma a parte das parcelas que ainda vão cair (como na meta)
  const curWeek = G.weekStartIso(today);
  const inst = G.weekStatus(spendTx(id), 1, today, c)?.installments || 0;
  const slots = [...Array(lead).fill(blank), ...cells];
  while (slots.length % 7) slots.push(blank);
  let grid = head;
  for (let r = 0; r < slots.length / 7; r++) {
    const start = G.isoAddDays(first, 7 * r - lead);
    if (start > today) { grid += slots.slice(7 * r, 7 * r + 7).join('') + blank; continue; }
    const wkDays = Array.from({ length: 7 }, (_, i) => G.isoAddDays(start, i));
    const posted = wkDays.reduce((s, d) => s + (byDay[d]?.spent || 0), 0);
    const extra = start === curWeek ? inst : 0;
    const tot = posted + extra;
    const over = weekly && tot > weekly;
    const label = `Semana de ${brDate(start).slice(0, 5)} a ${brDate(wkDays[6]).slice(0, 5)}: ${fmt(tot)}${extra > 0.004 ? `, com ${fmt(extra)} de parcelas que ainda vão cair` : ''}${weekly ? (over ? `, ${fmt(tot - weekly)} acima da meta` : `, dentro da meta de ${fmt(weekly)}`) : ''}`;
    grid += slots.slice(7 * r, 7 * r + 7).join('')
      + `<div class="cal-wk${over ? ' over' : ''}${start === curWeek ? ' cur' : ''}" role="gridcell" title="${label}" aria-label="${label}"><span class="v">${tot < 0 ? '−' : ''}${NUM0.format(Math.abs(tot))}</span></div>`;
  }
  $('#cal-grid').innerHTML = grid;

  const past = days.filter((d) => d <= today);
  const total = past.reduce((s, d) => s + (byDay[d]?.spent || 0), 0);
  const top = past.slice().sort((a, b) => (byDay[b]?.spent || 0) - (byDay[a]?.spent || 0))[0];
  const over = daily ? past.filter((d) => (byDay[d]?.spent || 0) > daily).length : 0;
  $('#cal-note').textContent = !past.length ? 'Mês ainda não começou.'
    : total > 0 ? `Total ${fmt(total)} · média de ${fmt(total / past.length)}/dia · maior gasto: ${brDate(top).slice(0, 5)}, ${fmt(byDay[top].spent)}${daily ? ` · ${over} dia(s) acima da meta diária de ${fmt(daily)} (em vermelho)` : ''}.`
    : 'Nenhum gasto neste mês.';
  renderCalDay(id, state.calDay);
}

function renderCalDay(id, day) {
  $('#cal-detail').hidden = !day;
  $('#cal-empty').hidden = !!day;
  if (!day) return;
  const rows = state.calTx.filter((t) => t.accountId === id && t.date === day && !G.isCardPayment(t))
    .map((t) => ({ t, v: t.direction === 'out' ? (t.myAmount ?? t.amount) : -t.amount }))
    .sort((a, b) => b.v - a.v);
  const dow = WEEKDAYS[(parse(day).getDay() + 6) % 7];
  $('#cal-day-title').textContent = `${dow}, ${brDate(day)} · ${rows.length} ${rows.length === 1 ? 'lançamento' : 'lançamentos'}`;
  $('#cal-day-body').innerHTML = rows.map(({ t, v }) => `<div class="dl-row">
      <div class="dl-desc">${D(t)}${t.installment ? ` <span class="chip">${t.installment}</span>` : ''}
        <div class="dl-meta">${catChip(t)}${shareChip(t)}</div></div>
      <div class="dl-val ${v < 0 ? 'pos' : ''}">${v < 0 ? '−' : ''}${fmt(Math.abs(v))}${t.myAmount != null && t.direction === 'out' && t.myAmount !== t.amount ? `<small>de ${fmt(t.amount)}</small>` : ''}</div></div>`).join('')
    || '<p class="muted small">Nenhum gasto neste dia.</p>';
  $('#cal-day-total').textContent = fmt(rows.reduce((s, r) => s + r.v, 0));
}

$('#cal-grid').addEventListener('click', (e) => {
  const d = e.target.closest('[data-day]')?.dataset.day;
  if (!d) return;
  state.calDay = state.calDay === d ? null : d;
  renderCalendar(calCard());
  // no celular o detalhe fica abaixo do calendário: rola até ele; no desktop já está ao lado
  if (state.calDay && innerWidth < 1000) $('#cal-detail').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
const calGo = (ym) => { state.calMonth = ym; state.calDay = null; renderCalendar(calCard()); };
$('#btn-cal-prev').addEventListener('click', () => calGo(monthShift(state.calMonth || todayIso().slice(0, 7), -1)));
$('#btn-cal-next').addEventListener('click', () => {
  const next = monthShift(state.calMonth || todayIso().slice(0, 7), 1);
  calGo(next >= todayIso().slice(0, 7) ? null : next);
});
$('#btn-cal-today').addEventListener('click', () => calGo(null));
$('#btn-cal-day-close').addEventListener('click', () => { state.calDay = null; renderCalendar(calCard()); });

// ---------------------------------------------------------------- meta mensal (ciclo da fatura)
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);

const cycleWindow = (c) => G.cycleWindow(c, todayIso());
const monthStatus = (c) => G.monthStatus(c, state.goals[c.account.id]?.monthly, spendTx(c.account.id), todayIso());

function renderMonthlyGoal(c) {
  const id = c.account.id;
  const goal = state.goals[id]?.monthly;
  const any = goal || state.goals[id]?.weekly;
  $('#btn-goal-open').textContent = any ? 'Editar meta' : 'Definir meta';
  if (!any) { $('#goal-title').textContent = 'Meta'; $('#goal-body').innerHTML = goalEmpty(c); }

  const m = monthStatus(c);
  const win = m || cycleWindow(c);
  $('#mburn-title').textContent = win.fallback ? 'Gasto acumulado no mês' : 'Gasto acumulado no ciclo da fatura';

  if (m) {
    const cls = m.pct > 100 ? 'over' : (m.pct >= 80 || m.ahead || (m.elapsed >= 3 && m.projected > m.goal)) ? 'warn' : '';
    const status = m.spent > m.goal ? `<span class="ico neg">✕</span> Meta estourada em ${fmt(m.spent - m.goal)}`
      : m.elapsed >= 3 && m.projected > m.goal ? `<span class="ico">!</span> No ritmo atual fecha em ~${fmt(m.projected)} (${fmt(m.projected - m.goal)} acima)`
      : `<span class="ico ${m.ahead ? '' : 'pos'}">${m.ahead ? '!' : '✓'}</span> ${m.elapsed >= 3 ? `No ritmo atual fecha em ~${fmt(m.projected)}` : m.ahead ? 'Dentro da meta por enquanto' : 'Dentro da meta'} · restam ${fmt(m.remaining)}`;
    const est = m.estimated ? '~' : '';
    const over = m.remaining <= 0;
    // metas antigas podem ter as duas: a semanal aparece como uma linha extra
    const w = state.goals[id]?.weekly ? weekStatus(id) : null;
    const weekLine = w ? `<div class="wide"><div class="label">Meta semanal</div><div class="v">${fmt(w.spent)} <span class="muted small">de ${fmt(w.goal)} nesta semana</span></div>
        <div class="h">${w.goal - w.spent < m.untilSunday ? `mais apertada que a meta por fatura: até domingo vale ${fmt(Math.max(0, w.goal - w.spent))}` : 'a meta por fatura é mais apertada: siga o "até domingo" acima'}</div></div>` : '';
    $('#goal-title').textContent = 'Meta por fatura';
    $('#goal-body').innerHTML = `
      <div class="goal-big">${fmt(m.spent)} <small>de ${fmt(m.goal)} ${m.fallback ? 'neste mês' : `no ciclo ${brDate(m.start).slice(0, 5)} – ${est}${brDate(m.end).slice(0, 5)}`}</small></div>
      <div class="goal-meter ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.min(100, m.pct).toFixed(0)}"><span style="width:${Math.min(100, m.pct)}%"></span></div>
      <div class="goal-status">${status}</div>
      ${paceBadge(m, `no ciclo (${m.elapsed} dia${m.elapsed > 1 ? 's' : ''}${m.committed ? ', com parcelas previstas' : ''})`)}
      ${m.committed ? `<p class="small muted" style="margin:6px 0 0">${fmt(m.posted)} já lançados + <strong>${fmt(m.committed)}</strong> em ${m.upcoming.length} parcela(s) que ainda vão cair neste ciclo · <a href="#" id="see-upcoming">ver parcelas</a></p>` : ''}
      <div class="goal-allow">
        <div><div class="label">Pode gastar por dia</div><div class="v">${fmt(m.perDay)}</div></div>
        <div><div class="label">Por semana</div><div class="v">${fmt(m.perWeek)}</div></div>
        <div><div class="label">Até domingo${m.weekDays > 1 ? ` (${m.weekDays} dias)` : ' (hoje)'}</div><div class="v">${fmt(Math.max(0, m.untilSunday))} <span class="muted small">de ${fmt(m.weekBudget)}</span></div></div>
      </div>
      ${over ? '<p class="small neg">A meta deste ciclo já foi atingida: qualquer gasto novo fica acima dela.</p>' : ''}
      <div class="goal-facts">
        <div><div class="label">Faltam</div><div class="v">${m.daysLeft} dia(s)</div><div class="h">fecha ${est}${brDate(m.end)}</div></div>
        <div><div class="label">Média por dia até agora</div><div class="v ${m.ahead ? 'neg' : ''}">${fmt(m.avgDaily)}${m.ahead ? ' ▲' : ''}</div><div class="h">${m.elapsed} de ${m.total} dias</div></div>
        <div><div class="label">Ritmo da meta</div><div class="v">${fmt(m.goal / m.total)}/dia</div><div class="h">${fmt((m.goal / m.total) * 7)}/semana</div></div>
        ${weekLine}
      </div>
      ${m.fallback ? '<p class="muted small">Sem faturas fechadas para estimar o ciclo: usando o mês do calendário.</p>' : '<p class="muted small">Dia e semana já descontam o que você gastou e as parcelas previstas: são o máximo para fechar a fatura dentro da meta. Despesas divididas contam só a sua parte.</p>'}`;
  }

  // gráfico: acumulado diário vs. ritmo linear da meta
  const total = daysBetween(win.start, win.end) + 1;
  const today = iso(todayLocal());
  const byDay = {};
  for (const t of (m ? m.tx : spendTx(id).filter((t) => t.date >= win.start && t.date <= win.end))) byDay[t.date] = (byDay[t.date] || 0) + t.net;
  const days = Array.from({ length: total }, (_, i) => iso(addDays(parse(win.start), i)));
  let acc = 0;
  const cum = days.map((d) => { acc += byDay[d] || 0; return d <= today ? Math.max(0, acc) : null; });
  const base = m?.committed || 0;
  for (let i = 0; i < cum.length; i++) if (cum[i] != null) cum[i] += base;
  const datasets = [{ label: base ? 'Gasto acumulado + parcelas previstas' : 'Gasto acumulado', data: cum, borderColor: cssVar('--series-2'), backgroundColor: cssVar('--series-2'), borderWidth: 2, pointRadius: 0, pointHoverRadius: 5, tension: 0, spanGaps: false }];
  if (goal) datasets.push({ label: 'Ritmo da meta', data: days.map((_, i) => (goal * (i + 1)) / total), borderColor: cssVar('--text-2'), borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0 });
  const opts = baseOptions();
  opts.plugins.tooltip.callbacks.title = (it) => brDate(days[it[0].dataIndex]);
  opts.scales.x.ticks.maxTicksLimit = 8;
  setChart('chart-mburn', { type: 'line', data: { labels: days.map((d) => d.slice(8) + '/' + d.slice(5, 7)), datasets }, options: opts }, false);
}

// ---------------------------------------------------------------- meta (modal)
// Meta por fatura, por semana ou por dia são o mesmo limite em escalas diferentes. O modal deixa escolher
// a escala mais natural, mostra o equivalente nas outras e guarda uma meta só: por fatura (mensal) ou semanal.
// "Por dia" vira meta por fatura: valor × dias do ciclo.
const round2 = (v) => Math.round(v * 100) / 100;
const cycleDays = (c) => { const w = cycleWindow(c); return daysBetween(w.start, w.end) + 1; };
const GOAL_MODES = {
  monthly: { per: (N) => N, label: 'Quanto quer gastar por fatura (de um fechamento ao outro)?', name: 'por fatura' },
  weekly: { per: () => 7, label: 'Quanto quer gastar por semana (segunda a domingo)?', name: 'por semana' },
  daily: { per: () => 1, label: 'Quanto quer gastar por dia, em média?', name: 'por dia' },
};
// daily: valor exato por dia; shown: o que o campo mostrava ao converter (se não mudou, vale o exato, sem perder centavos)
const goalDlg = { card: null, mode: 'monthly', daily: null, shown: null };
// valor por dia do que está no campo: o exato da última conversão, se o campo não foi editado depois
function gdDaily() {
  const raw = $('#gd-input').value, v = Number(raw);
  if (!(v > 0)) return null;
  return raw === goalDlg.shown && goalDlg.daily ? goalDlg.daily : v / GOAL_MODES[goalDlg.mode].per(cycleDays(goalDlg.card));
}
function gdSet(daily) {
  goalDlg.daily = daily;
  goalDlg.shown = daily ? String(round2(daily * GOAL_MODES[goalDlg.mode].per(cycleDays(goalDlg.card)))) : '';
  $('#gd-input').value = goalDlg.shown;
}

function goalSuggestions(c) {
  const recent = c.bills.slice(0, 3);
  const weeks = weeklySpend(c.account.id).slice(0, -1).slice(-4);
  return {
    monthly: recent.length ? { v: recent.reduce((s, b) => s + b.total, 0) / recent.length, t: `média das últimas ${recent.length} faturas` } : null,
    weekly: weeks.length ? { v: weeks.reduce((s, w) => s + Math.max(0, w.spent), 0) / weeks.length, t: `sua média nas últimas ${weeks.length} semanas` } : null,
  };
}

// quadro sem meta: convida a definir, sugerindo a média das últimas faturas (ou semanas)
function goalEmpty(c) {
  const sgs = goalSuggestions(c);
  const kind = sgs.monthly ? 'monthly' : 'weekly';
  const sg = sgs[kind];
  return `<div class="goal-empty-box">
    <p>Sem meta neste cartão. Com uma meta, você vê quanto ainda pode gastar por dia e se está no ritmo.</p>
    <div class="btn-row"><button type="button" class="btn" data-goal-dlg>Definir meta</button>
      ${sg ? `<button type="button" class="btn ghost" data-goal-dlg="${kind}" data-goal-value="${sg.v.toFixed(2)}">Começar pela média: ${fmt(sg.v)}${kind === 'weekly' ? '/semana' : ''}</button>` : ''}</div>
    ${sg ? `<p class="muted small">Sugestão: ${esc(sg.t)}.</p>` : ''}
  </div>`;
}

function openGoalDialog(id, mode, value) {
  const c = state.bills.find((x) => x.account.id === id);
  if (!c) return;
  const g = state.goals[id] || {};
  const N = cycleDays(c);
  goalDlg.card = c;
  goalDlg.mode = mode || (g.monthly ? 'monthly' : g.weekly ? 'weekly' : 'monthly');
  const per = GOAL_MODES[goalDlg.mode].per(N);
  gdSet(value != null ? Number(value) / per : g.monthly ? g.monthly / N : g.weekly ? g.weekly / 7 : null);
  $('#gd-card').textContent = `· ${c.account.name}`;
  const w = cycleWindow(c);
  $('#gd-cycle').textContent = w.fallback ? `Sem faturas fechadas: o ciclo considerado é o mês do calendário (${N} dias).`
    : `Ciclo da fatura atual: ${brDate(w.start).slice(0, 5)} a ${w.estimated ? '~' : ''}${brDate(w.end).slice(0, 5)} (${N} dias).`;
  $('#gd-msg').textContent = '';
  $('#btn-gd-remove').hidden = !g.monthly && !g.weekly;
  renderGoalDialog();
  if (!$('#dlg-goal').open) $('#dlg-goal').showModal();
  $('#gd-input').focus(); $('#gd-input').select();
}

function renderGoalDialog() {
  const c = goalDlg.card, N = cycleDays(c), mode = goalDlg.mode;
  const g = state.goals[c.account.id] || {};
  document.querySelectorAll('#gd-mode button').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  $('#gd-label').textContent = GOAL_MODES[mode].label;
  const daily = gdDaily();
  $('#gd-eq').innerHTML = Object.entries(GOAL_MODES).map(([k, m]) => `<div class="${k === mode ? 'on' : ''}">
      <div class="label">${k === 'monthly' ? 'Por fatura' : k === 'weekly' ? 'Por semana' : 'Por dia'}</div>
      <div class="v">${daily ? fmt(daily * m.per(N)) : '—'}</div></div>`).join('');
  const sg = goalSuggestions(c);
  $('#gd-sugg').innerHTML = [['monthly', sg.monthly], ['weekly', sg.weekly]].filter(([, x]) => x)
    .map(([k, x]) => `<button type="button" class="chip" data-gd-sugg="${k}" data-v="${x.v.toFixed(2)}">${esc(x.t[0].toUpperCase() + x.t.slice(1))}: ${fmt(x.v)}</button>`).join('');
  const notes = {
    monthly: 'Vale de um fechamento ao outro; as parcelas que ainda vão cair na fatura já contam.',
    weekly: 'Cada semana começa do zero na segunda-feira.',
    daily: `Guardada como meta por fatura: ${daily ? fmt(daily * N) : 'o valor'} no ciclo de ${N} dias.`,
  };
  const both = g.monthly && g.weekly ? ` Hoje há duas metas (${fmt(g.monthly)} por fatura e ${fmt(g.weekly)} por semana): ao salvar, fica só esta.` : '';
  $('#gd-note').textContent = notes[mode] + both;
}

$('#gd-mode').addEventListener('click', (e) => {
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (!m || m === goalDlg.mode) return;
  const daily = gdDaily();
  goalDlg.mode = m;
  if (daily) gdSet(daily);
  renderGoalDialog();
});
$('#gd-input').addEventListener('input', renderGoalDialog);
$('#gd-sugg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-gd-sugg]');
  if (!b) return;
  goalDlg.mode = b.dataset.gdSugg;
  gdSet(Number(b.dataset.v) / GOAL_MODES[goalDlg.mode].per(cycleDays(goalDlg.card)));
  renderGoalDialog();
});

async function putGoal(id, body) {
  state.goals = await api(`/api/goals/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const c = calCard();
  if (c) { renderGoal(c); renderMonthlyGoal(c); }
  renderBillAlert(); renderToday();
}
$('#goal-dlg-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const daily = gdDaily();
  if (!daily) { $('#gd-msg').textContent = 'Informe um valor maior que zero.'; return; }
  const N = cycleDays(goalDlg.card);
  const body = goalDlg.mode === 'weekly' ? { weekly: round2(daily * 7), monthly: null } : { monthly: round2(daily * N), weekly: null };
  try { await putGoal(goalDlg.card.account.id, body); $('#dlg-goal').close(); }
  catch (err) { $('#gd-msg').textContent = err.message; }
});
$('#btn-gd-remove').addEventListener('click', async () => {
  if (!confirm(`Remover a meta do ${goalDlg.card.account.name}?`)) return;
  try { await putGoal(goalDlg.card.account.id, { monthly: null, weekly: null }); $('#dlg-goal').close(); }
  catch (err) { $('#gd-msg').textContent = err.message; }
});
$('#btn-gd-cancel').addEventListener('click', () => $('#dlg-goal').close());
$('#btn-goal-open').addEventListener('click', () => openGoalDialog(state.billCard));
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-goal-dlg]');
  if (b) openGoalDialog(state.billCard, b.dataset.goalDlg || undefined, b.dataset.goalValue);
});

$('#card-select').addEventListener('click', (e) => {
  const id = e.target.dataset.card;
  if (!id || id === state.billCard) return;
  state.billCard = id; state.billSel = 'open';
  renderBills();
});
$('#goal-body').addEventListener('click', (e) => {
  if (e.target.id !== 'see-upcoming') return;
  e.preventDefault();
  selectBill('open');
  $('#bill-detail').scrollIntoView({ behavior: 'smooth' });
});
$('#bills-body').addEventListener('click', (e) => { const id = e.target.closest('tr')?.dataset.bill; if (id) { selectBill(id); $('#bill-detail').scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
$('#bill-pick').addEventListener('change', (e) => selectBill(e.target.value));

// Navegação por hash (#hoje, #visao-geral, #faturas): o Voltar do navegador/celular volta à aba anterior.
const VIEW_HASH = { today: '#hoje', overview: '#visao-geral', bills: '#faturas' };
const viewFromHash = () => Object.keys(VIEW_HASH).find((k) => VIEW_HASH[k] === location.hash) || 'today';
function setView(v, { push = true } = {}) {
  const changed = state.view !== v;
  state.view = v;
  document.querySelectorAll('.tabs [data-view]').forEach((b) => {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  for (const k of Object.keys(VIEW_HASH)) $(`#view-${k}`).hidden = k !== v;
  if (push && location.hash !== VIEW_HASH[v]) history.pushState(null, '', VIEW_HASH[v]);
  if (changed) window.scrollTo({ top: 0 });
  if (!state.accounts.length) return;
  if (v === 'bills') renderBills();
  if (v === 'overview') renderCharts(periodTx());
  if (v === 'today') renderToday();
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-view]');
  if (!a || e.ctrlKey || e.metaKey) return;
  e.preventDefault();
  setView(a.dataset.view);
});
window.addEventListener('popstate', () => setView(viewFromHash(), { push: false }));

// abre a aba Faturas num cartão
function openCard(id) {
  state.billCard = id; state.billSel = 'open';
  setView('bills');
}

// ---------------------------------------------------------------- hoje
// O mesmo que o /resumo do bot: quanto ainda pode gastar hoje em cada cartão (pela meta mais apertada),
// como está a semana e o ciclo da fatura, e os últimos gastos para categorizar/dividir.
const WEEKDAY_FULL = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
function syncAgo(ts) {
  const min = Math.round((Date.now() - new Date(ts)) / 6e4);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  if (min < 24 * 60) return `há ${Math.round(min / 60)} h`;
  return `em ${new Date(ts).toLocaleDateString('pt-BR')}`;
}
// cartões que importam no dia a dia: com fatura, lançamentos ou meta
const activeCards = () => state.bills.filter((c) => c.account && (c.error || c.bills.length || c.open?.txCount
  || state.goals[c.account.id]?.weekly || state.goals[c.account.id]?.monthly));

// barra do período: gasto vs. meta, com a marca de onde deveria estar hoje no ritmo da meta
function paceBar(spent, goal, expected) {
  const max = Math.max(goal, spent) || 1;
  const cls = spent > goal ? 'over' : spent > expected ? 'warn' : '';
  return `<div class="pbar ${cls}" role="progressbar" aria-valuemin="0" aria-valuemax="${goal.toFixed(0)}" aria-valuenow="${spent.toFixed(0)}">
    <span class="fill" style="width:${(Math.min(spent, max) / max) * 100}%"></span>
    ${goal < max ? `<i class="goal" style="left:${(goal / max) * 100}%"></i>` : ''}
    <i class="exp" style="left:${(Math.min(expected, max) / max) * 100}%" title="Ritmo da meta até hoje: ${fmt(expected)}"></i></div>`;
}

// últimos 7 dias em barras (HTML puro): mostra o padrão de gasto num relance
function weekBars(items, today, dailyGoal) {
  const days = Array.from({ length: 7 }, (_, i) => G.isoAddDays(today, i - 6));
  const v = days.map((d) => Math.max(0, items.filter((t) => t.date === d).reduce((s, t) => s + t.net, 0)));
  const max = Math.max(dailyGoal || 0, ...v, 1);
  const wd = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
  return `<div class="wbars" role="img" aria-label="Gasto nos últimos 7 dias: ${days.map((d, i) => `${brDate(d).slice(0, 5)} ${fmt(v[i])}`).join(', ')}">
    ${dailyGoal ? `<i class="wline" style="bottom:${(dailyGoal / max) * 100}%" title="Meta por dia: ${fmt(dailyGoal)}"></i>` : ''}
    ${days.map((d, i) => `<div class="wb ${d === today ? 'today' : ''} ${dailyGoal && v[i] > dailyGoal ? 'over' : ''}">
      <span class="wv">${v[i] ? NUM0.format(v[i]) : ''}</span>
      <span class="wcol"><span style="height:${(v[i] / max) * 100}%"></span></span>
      <span class="wd">${d === today ? 'hoje' : wd[parse(d).getDay()]}</span></div>`).join('')}
  </div>`;
}

function renderToday() {
  const today = todayIso();
  const d = todayLocal();
  const wdName = WEEKDAY_FULL[d.getDay()];
  $('#today-title').textContent = `${wdName[0].toUpperCase()}${wdName.slice(1)}, ${d.getDate()} de ${MONTHS_FULL[d.getMonth()]}`;
  $('#today-sub').textContent = state.lastSync ? `Dados sincronizados ${syncAgo(state.lastSync)}` : '';
  const yesterday = G.isoAddDays(today, -1);

  const cards = activeCards();
  $('#today-cards').innerHTML = cards.map((c) => {
    const a = c.account, id = a.id;
    const inst = instLabel(a);
    const head = `<header class="tc-head"><div><span class="tc-name">${esc(a.name)}</span>${inst ? ` <span class="muted small">${esc(inst)}</span>` : ''}</div>
      <button type="button" class="btn ghost" data-open-card="${esc(id)}">Fatura <span aria-hidden="true">→</span></button></header>`;
    if (c.error) return `<article class="today-card">${head}<p class="neg small">Não foi possível ler as faturas: ${esc(c.error)}</p></article>`;
    const items = spendTx(id);
    const week = weekStatus(id), month = monthStatus(c);
    const al = G.todayAllowance(items, today, { week, month });
    const o = c.open;
    const closeIn = o?.closeDate ? Math.max(0, daysUntil(o.closeDate)) : null;
    const ontem = items.filter((t) => t.date === yesterday).reduce((s, t) => s + t.net, 0);
    const spentToday = Math.max(0, al.spentToday);
    const daily = month ? month.goalDaily : week ? week.goalDaily : null;

    if (!week && !month) {
      // sem meta: o número que importa é a fatura aberta; hoje/7 dias/limite ficam nos blocos menores
      const since = G.isoAddDays(today, -6);
      const last7 = items.filter((t) => t.date >= since).reduce((s, t) => s + t.net, 0);
      const tiles = [
        `<div class="tc-tile"><div class="label">Hoje</div><div class="v">${fmt(spentToday)}</div><div class="h">${ontem > 0.004 ? `ontem ${fmt(ontem)}` : 'nada ontem'}</div></div>`,
        `<div class="tc-tile"><div class="label">Últimos 7 dias</div><div class="v">${fmt(Math.max(0, last7))}</div><div class="h">${fmt(Math.max(0, last7) / 7)}/dia</div></div>`,
        a.creditLimit ? `<div class="tc-tile"><div class="label">Limite livre</div><div class="v">${BRL0.format(a.availableLimit ?? 0)}</div><div class="h">de ${BRL0.format(a.creditLimit)}</div></div>` : '',
      ].join('');
      return `<article class="today-card">${head}
        <div class="tc-hero"><div class="label">Fatura aberta</div><div class="tc-big">${fmt(openTotal(o))}</div>
          <div class="muted small">${o?.closeDate ? `fecha ${inDays(closeIn)} · ${brDate(o.closeDate).slice(0, 5)}` : 'nenhuma fatura aberta'}${o?.txCount ? ` · ${o.txCount} lançamento(s)` : ''}</div></div>
        <div class="tc-tiles">${tiles}</div>
        ${last7 > 0.004 ? `<div class="tc-chart"><div class="tc-cycle-top"><span>Últimos 7 dias</span></div>${weekBars(items, today, null)}</div>` : ''}
        <div class="tc-cta"><span class="small">Defina uma meta para ver quanto pode gastar por dia.</span>
          <button type="button" class="btn ghost sm" data-goal-card="${esc(id)}">Definir meta</button></div>
      </article>`;
    }

    const useWeek = week && (!month || al.week < al.month);
    const limit = useWeek ? al.week : al.month;
    const left = limit - al.spentToday;
    // até domingo: meta semanal; sem ela, a parte da semana na meta mensal
    const wk = week ? { left: week.remaining, of: week.goal } : { left: Math.min(month.untilSunday, month.remaining), of: month.weekBudget };
    const tiles = [
      `<div class="tc-tile"><div class="label">Até domingo</div><div class="v ${wk.left < 0 ? 'neg' : ''}">${wk.left < 0 ? '−' : ''}${fmt(Math.abs(wk.left))}</div><div class="h">de ${fmt(wk.of)}${week ? '' : ' pela meta mensal'}</div></div>`,
      month ? `<div class="tc-tile"><div class="label">Até fechar a fatura</div><div class="v ${month.remaining < 0 ? 'neg' : ''}">${month.remaining < 0 ? '−' : ''}${fmt(Math.abs(month.remaining))}</div><div class="h">${month.daysLeft} dia(s) · ${fmt(month.perDay)}/dia</div></div>` : '',
      `<div class="tc-tile"><div class="label">Fatura aberta</div><div class="v">${fmt(openTotal(o))}</div><div class="h">${o?.closeDate ? `fecha ${inDays(closeIn)}` : 'nenhuma aberta'}</div></div>`,
    ].join('');

    const p = month || week;
    const expected = p.goalDaily * p.elapsed;
    const diff = p.spent - expected;
    const barTitle = month ? `Ciclo ${brDate(month.start).slice(0, 5)} – ${month.estimated ? '~' : ''}${brDate(month.end).slice(0, 5)}` : `Semana ${brDate(week.start).slice(0, 5)} – ${brDate(week.end).slice(0, 5)}`;
    const verdict = p.spent > p.goal ? `<span class="neg">meta estourada em ${fmt(p.spent - p.goal)}</span>`
      : diff > 0.5 ? `<span class="neg">${fmt(diff)} acima do ritmo</span>${month && month.elapsed >= 3 ? ` · nesse passo fecha em ~${fmt(month.projected)}` : ''}`
      : `<span class="pos">${fmt(-diff)} abaixo do ritmo</span>`;

    return `<article class="today-card ${left < 0 ? 'is-over' : ''}">${head}
      <div class="tc-hero">
        <div class="label">${left >= 0 ? 'Pode gastar hoje' : 'Passou do limite de hoje'}</div>
        <div class="tc-big ${left < 0 ? 'neg' : ''}">${fmt(Math.abs(left))}</div>
        <div class="muted small">gastou ${fmt(spentToday)} hoje${ontem > 0.004 ? ` · ontem ${fmt(ontem)}` : ''}${week && month ? ` · vale a meta ${useWeek ? 'semanal' : 'mensal'} (a mais apertada)` : ''}</div>
      </div>
      <div class="tc-tiles">${tiles}</div>
      <div class="tc-cycle">
        <div class="tc-cycle-top"><span>${barTitle}</span><span><strong>${fmt(p.spent)}</strong> <span class="muted">de ${fmt(p.goal)}</span></span></div>
        ${paceBar(p.spent, p.goal, expected)}
        <div class="small">${verdict}</div>
      </div>
      <div class="tc-chart"><div class="tc-cycle-top"><span>Últimos 7 dias</span>${daily ? `<span class="muted small">linha = ${fmt(daily)}/dia da meta</span>` : ''}</div>${weekBars(items, today, daily)}</div>
    </article>`;
  }).join('') || '<p class="muted">Nenhum cartão de crédito com fatura.</p>';

  // faturas fechadas a pagar
  const due = state.bills.flatMap((c) => c.bills.filter((b) => b.status === 'due').map((b) => ({ c, b })))
    .sort((x, y) => x.b.dueDate.localeCompare(y.b.dueDate));
  $('#today-due-panel').hidden = !due.length;
  $('#today-due').innerHTML = due.map(({ c, b }) => {
    const n = daysUntil(b.dueDate);
    return `<li><span class="grow"><strong>${esc(c.account.name)}</strong><br>
      <span class="small ${n <= 3 ? 'neg' : 'muted'}">vence ${inDays(n)} · ${brDate(b.dueDate)}${b.minimum ? ` · mínimo ${fmt(b.minimum)}` : ''}</span></span><strong class="num">${fmt(b.total)}</strong></li>`;
  }).join('');

  // quem te deve: toque abre a pessoa para registrar o pagamento
  const owing = state.people.filter((p) => p.balance > 0.004).sort((x, y) => y.balance - x.balance);
  $('#today-people-panel').hidden = !owing.length;
  $('#today-people-total').textContent = fmt(owing.reduce((s, p) => s + p.balance, 0));
  $('#today-people').innerHTML = owing.map((p) => `<li><button type="button" class="rowbtn" data-person="${esc(p.id)}">
      <span class="grow"><strong>${esc(p.name)}</strong><br><span class="muted small">${p.items.length} despesa(s) dividida(s)</span></span>
      <strong class="num">${fmt(p.balance)}</strong><span class="chev" aria-hidden="true">›</span></button></li>`).join('');

  // saldo das contas
  const banks = state.accounts.filter((a) => a.kind === 'bank');
  $('#today-balance-panel').hidden = !banks.length;
  $('#today-balance').innerHTML = banks.map((a) => `<li><span class="grow">${esc(a.name)}<br><span class="muted small">${accLabel(a)}</span></span><strong class="num ${a.balance < 0 ? 'neg' : ''}">${fmt(a.balance)}</strong></li>`).join('');

  // últimos gastos, agrupados por dia, com o total de cada dia
  const accs = accById();
  const multi = cards.length > 1;
  const since = G.isoAddDays(today, -6);
  const recent = state.weekTx.filter((t) => t.date >= since && !G.isCardPayment(t)).sort((x, y) => y.date.localeCompare(x.date));
  const byDay = new Map();
  for (const t of recent) (byDay.get(t.date) || byDay.set(t.date, []).get(t.date)).push(t);
  const dayName = (s) => s === today ? 'Hoje' : s === yesterday ? 'Ontem' : `${WEEKDAYS[(parse(s).getDay() + 6) % 7]}, ${brDate(s).slice(0, 5)}`;
  $('#today-recent').innerHTML = [...byDay].map(([day, list]) => {
    const tot = list.reduce((s, t) => s + (t.direction === 'out' ? (t.myAmount ?? t.amount) : -t.amount), 0);
    return `<div class="dl-day"><div class="dl-head"><span>${dayName(day)}</span><span>${fmt(tot)}</span></div>
      ${list.map((t) => {
        const v = t.direction === 'out' ? (t.myAmount ?? t.amount) : -t.amount;
        return `<div class="dl-row">
          <div class="dl-desc">${D(t)}${t.installment ? ` <span class="chip">${t.installment}</span>` : ''}
            <div class="dl-meta">${multi ? `<span class="dl-acc" style="${accs[t.accountId]?.institutionColor ? `--inst:${accs[t.accountId].institutionColor}` : ''}"><span class="dot"></span>${esc(accs[t.accountId]?.name || '')}</span>` : ''}${catChip(t)}${shareChip(t)}</div></div>
          <div class="dl-val ${v < 0 ? 'pos' : ''}">${v < 0 ? '+' : ''}${fmt(Math.abs(v))}${t.myAmount != null && t.direction === 'out' && t.myAmount !== t.amount ? `<small>de ${fmt(t.amount)}</small>` : ''}</div>
        </div>`;
      }).join('')}</div>`;
  }).join('') || '<p class="muted small">Nenhum gasto nos cartões nos últimos 7 dias.</p>';
}
document.addEventListener('click', (e) => {
  const p = e.target.closest('[data-person]');
  if (p) { peopleDlg.sel = p.dataset.person; $('#pay-date').value = ''; openPeople(); }
});
document.addEventListener('click', (e) => {
  const g = e.target.closest('[data-goal-card]');
  if (g) return openGoalDialog(g.dataset.goalCard);
  const o = e.target.closest('[data-open-card]');
  if (o) openCard(o.dataset.openCard);
});

// menu do topo (no celular vira lista suspensa)
const menuBtn = $('#btn-menu');
const closeMenu = () => { document.body.classList.remove('menu-open'); menuBtn.setAttribute('aria-expanded', 'false'); };
menuBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = document.body.classList.toggle('menu-open');
  menuBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!e.target.closest('#btn-menu')) closeMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });

// ---------------------------------------------------------------- conexões
async function openConnections() {
  const dlg = $('#dlg-connections');
  $('#item-msg').textContent = '';
  const items = state.status?.items || [];
  $('#items-list').innerHTML = state.status?.demo
    ? '<li class="muted">Modo demonstração: configure as credenciais no .env.</li>'
    : items.map((i) => `<li><div><strong>${esc(i.connector || 'Item')}</strong> <span class="chip">${esc(i.status)}</span><br><code>${esc(i.id)}</code>
        ${i.lastUpdatedAt ? `<div class="muted small">atualizado ${new Date(i.lastUpdatedAt).toLocaleString('pt-BR')}</div>` : ''}</div>
        <div style="display:flex;gap:6px"><button type="button" class="btn ghost" data-sync="${esc(i.id)}"${i.watching ? ' disabled' : ''}>${i.watching ? 'Atualizando…' : 'Atualizar do banco'}</button>
        ${i.removable ? `<button type="button" class="btn ghost" data-del="${esc(i.id)}">Remover</button>` : ''}</div></li>`).join('') || '<li class="muted">Nenhuma conexão.</li>';
  if (!dlg.open) dlg.showModal();
  renderHistory();
  renderWebhooks();
}

async function renderWebhooks() {
  let w;
  try { w = await api('/api/webhooks'); } catch { return; }
  const box = $('#webhook-box');
  box.hidden = state.status?.demo;
  if (box.hidden) return;
  $('#webhook-sub').innerHTML = !w.configured
    ? 'Desativados: defina <code>PUBLIC_URL</code> (https) no <code>.env</code> para a Pluggy avisar o app quando houver dados novos.'
    : w.error ? `<span class="neg">Erro: ${esc(w.error)}</span>`
    : `Ativos em <code>${esc(w.url)}</code> · ${w.registered.length} evento(s) cadastrados na Pluggy.`;
  $('#webhook-events').innerHTML = (w.events || []).map((e) => `<li><span>${esc(e.event)}</span><span class="muted small">${new Date(e.received_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span></li>`).join('')
    || (w.configured && !w.error ? '<li class="muted small">Nenhum aviso recebido ainda.</li>' : '');
}

async function renderHistory() {
  let h;
  try { h = await api('/api/history'); } catch { return; }
  $('#history-box').hidden = !h.enabled;
  if (!h.enabled) return;
  const ls = h.lastSync;
  $('#history-sub').textContent = (ls
    ? `Última sincronização ${new Date(ls.finished_at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} (${ls.trigger}): ${ls.inserted} nova(s), ${ls.updated} alterada(s), ${ls.removed} removida(s)${ls.error ? ' · erro: ' + ls.error : ''}.`
    : 'Ainda não sincronizado.') + ` Sincroniza sozinho a cada ${h.intervalHours}h.${h.syncing ? ' Sincronizando agora…' : ''}`;
  $('#history-body').innerHTML = h.accounts.map((a) => `<tr>
      <td>${esc(a.name)} <span class="muted small">${esc(a.institution || '')}</span></td>
      <td class="num">${a.transactions}${a.removed ? ` <span class="muted small" title="sumiram da Pluggy; mantidas no banco">(+${a.removed} removidas)</span>` : ''}</td>
      <td class="date">${a.oldest ? `${brDate(a.oldest)} – ${brDate(a.newest)}` : '—'}</td>
      <td class="num">${a.kind === 'credit' ? a.bills : '—'}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">Nada salvo ainda.</td></tr>';
}

$('#btn-sync-history').addEventListener('click', async (e) => {
  e.target.disabled = true; $('#history-msg').textContent = 'Sincronizando…';
  try {
    const r = await api('/api/history/sync', { method: 'POST' });
    $('#history-msg').textContent = `${r.fetched} lida(s) da Pluggy · ${r.inserted} nova(s) · ${r.updated} alterada(s) · ${r.removed} removida(s)${r.error ? ' · erro: ' + r.error : ''}`;
    await renderHistory();
    await loadAll();
  } catch (err) { $('#history-msg').textContent = err.message; }
  e.target.disabled = false;
});

// Itens que a Pluggy está atualizando no banco: o servidor acompanha e sincroniza ao final;
// aqui só consultamos o status até terminar e então recarregamos a tela.
const watchedItems = new Set();
let watchTimer = null;
function watchItems(ids) {
  ids.forEach((id) => watchedItems.add(id));
  clearTimeout(watchTimer);
  if (!watchedItems.size) return;
  watchTimer = setTimeout(async () => {
    let s;
    try { s = await api('/api/status'); } catch { return watchItems([]); }
    state.status = s;
    const done = [...watchedItems].filter((id) => !s.items.find((i) => i.id === id)?.watching);
    done.forEach((id) => watchedItems.delete(id));
    if (done.length) {
      const names = s.items.filter((i) => done.includes(i.id)).map((i) => `${i.connector || i.id}: ${i.status}`).join('; ');
      await refreshData();
      if ($('#dlg-connections').open) openConnections();
      $('#item-msg').textContent = `Atualização concluída (${names}).`;
    }
    watchItems([]);
  }, 5000);
}

$('#items-list').addEventListener('click', async (e) => {
  const sync = e.target.dataset.sync, del = e.target.dataset.del;
  if (!sync && !del) return;
  e.target.disabled = true;
  try {
    if (sync) {
      const r = await api(`/api/items/${sync}/sync`, { method: 'POST' });
      watchItems([sync]);
      $('#item-msg').textContent = `Atualização pedida ao banco (${r.status}). Pode levar alguns minutos; os dados entram sozinhos quando terminar.`;
      return; // botão fica desabilitado até o fim
    }
    if (del) { await api(`/api/items/${del}`, { method: 'DELETE' }); await loadAll(true); openConnections(); }
  } catch (err) { $('#item-msg').textContent = err.message; }
  e.target.disabled = false;
});

$('#btn-add-item').addEventListener('click', async () => {
  const id = $('#new-item').value.trim();
  if (!id) return;
  try {
    await api('/api/items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ itemId: id }) });
    $('#new-item').value = '';
    await loadAll(true);
    openConnections();
  } catch (err) { $('#item-msg').textContent = err.message; }
});

// ---------------------------------------------------------------- categorias
const catDlg = { tx: null };
function findTx(id) {
  return state.transactions.find((t) => t.id === id) || state.billTx.find((t) => t.id === id) || state.weekTx.find((t) => t.id === id) || state.calTx.find((t) => t.id === id);
}
function categoryOptions(selected) {
  const pluggy = new Set(Object.keys(CATEGORY_PT));
  for (const t of [...state.transactions, ...state.weekTx, ...state.billTx, ...state.calTx]) {
    for (const c of [t.pluggyCategory, t.category]) if (c && !isCustom(c)) pluggy.add(c);
  }
  const byName = (a, b) => catName(a).localeCompare(catName(b), 'pt-BR');
  const opt = (c) => `<option value="${esc(c)}"${c === selected ? ' selected' : ''}>${esc(catName(c))}</option>`;
  const custom = state.cats.custom.map((c) => `custom:${c.id}`);
  return (custom.length ? `<optgroup label="Minhas categorias">${custom.map(opt).join('')}</optgroup>` : '') +
    `<optgroup label="Categorias da Pluggy">${[...pluggy].sort(byName).map(opt).join('')}</optgroup>`;
}
function openCategoryDialog(id, predicted = false) {
  const u = predicted && (state.billUp || []).find((x) => x.sourceId === id);
  const t = u ? upTx(u) : findTx(id);
  if (!t) return;
  catDlg.tx = t;
  $('#cat-tx').innerHTML = `<strong>${D(t)}</strong> · ${t.predicted ? 'parcela prevista' : brDate(t.date)} · ${t.direction === 'in' ? '+' : '−'}${fmt(t.amount)}${t.installment ? ` · parcela ${t.installment}` : ''}`;
  $('#cat-select').innerHTML = categoryOptions(t.category);
  $('#cat-new').value = ''; $('#cat-msg').textContent = '';
  const key = ruleKey(t.description);
  const rule = state.cats.rules.find((r) => r.match === key);
  $('#cat-similar').checked = t.categorySource === 'rule';
  $('#cat-similar').disabled = !key;
  $('#cat-similar-label').textContent = `Aplicar a todas com a descrição “${key}”, inclusive as futuras`;
  // compra parcelada: a escolha pode valer para todas as parcelas; na prevista é sempre assim (ela não tem lançamento próprio)
  $('#cat-purchase-box').hidden = !t.purchaseKey;
  $('#cat-purchase').checked = !!t.predicted || t.categorySource === 'purchase';
  $('#cat-purchase').disabled = !!t.predicted;
  $('#cat-purchase-label').textContent = `Aplicar a todas as parcelas desta compra${t.installment ? ` (${t.installment.split('/')[1]}x)` : ''}, inclusive as previstas`;
  $('#cat-hint').textContent = rule ? `Já existe uma regra para essa descrição → ${catName(rule.category)}.` : '';
  $('#btn-cat-reset').hidden = !t.categorySource;
  $('#btn-cat-reset').textContent = `Voltar à categoria da Pluggy (${catName(t.pluggyCategory ?? t.category)})`;
  $('#dlg-category').showModal();
}
async function saveTxCategory(category, similar, purchase = false) {
  const t = catDlg.tx;
  await api(`/api/transactions/${encodeURIComponent(t.id)}/category`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ category, similar, description: t.description, scope: purchase && t.purchaseKey ? 'purchase' : 'tx' }),
  });
  $('#dlg-category').close();
  await refreshData();
}
async function createCategory(name) {
  const c = await api('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  state.cats = await api('/api/categories');
  return c;
}
document.addEventListener('click', (e) => {
  const id = e.target.closest('[data-cat-tx]')?.dataset.catTx;
  if (id) openCategoryDialog(id);
  const up = e.target.closest('[data-cat-up]')?.dataset.catUp;
  if (up) openCategoryDialog(up, true);
});
$('#btn-cat-create').addEventListener('click', async () => {
  const name = $('#cat-new').value.trim();
  if (!name) return;
  try {
    const c = await createCategory(name);
    $('#cat-select').innerHTML = categoryOptions(`custom:${c.id}`);
    $('#cat-new').value = ''; $('#cat-msg').textContent = '';
  } catch (err) { $('#cat-msg').textContent = err.message; }
});
$('#cat-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-cat-create').click(); } });
$('#cat-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const t = catDlg.tx;
  const cat = $('#cat-select').value;
  const similar = $('#cat-similar').checked;
  const purchase = !$('#cat-purchase-box').hidden && $('#cat-purchase').checked;
  // escolher de volta a própria categoria da Pluggy, sem regra, só remove a escolha manual
  const category = !similar && cat === (t.pluggyCategory ?? t.category) && t.categorySource !== 'rule' ? null : cat;
  try { await saveTxCategory(category, similar, purchase); } catch (err) { $('#cat-msg').textContent = err.message; }
});
$('#btn-cat-reset').addEventListener('click', async () => {
  const t = catDlg.tx;
  // regra: remove a regra da descrição; compra: remove a escolha da compra; manual: remove só a escolha desta transação
  try { await saveTxCategory(null, t.categorySource === 'rule', t.categorySource === 'purchase'); } catch (err) { $('#cat-msg').textContent = err.message; }
});
$('#btn-cat-cancel').addEventListener('click', () => $('#dlg-category').close());

function renderCategoriesDialog() {
  const used = {};
  for (const t of state.transactions) used[t.category] = (used[t.category] || 0) + 1;
  $('#cats-list').innerHTML = state.cats.custom.map((c) => `<li data-id="${esc(c.id)}">
      <span class="grow"><span class="chip custom">${esc(c.name)}</span> <span class="muted small">${used[`custom:${c.id}`] || 0} no período</span></span>
      <span class="actions"><button type="button" class="btn ghost" data-rename>Renomear</button><button type="button" class="btn ghost" data-delete>Excluir</button></span></li>`).join('')
    || '<li class="muted small">Nenhuma categoria criada ainda.</li>';
  $('#rules-list').innerHTML = state.cats.rules.map((r) => `<li data-rule="${r.id}">
      <span class="grow"><code>${esc(r.match)}</code> → <span class="chip${isCustom(r.category) ? ' custom' : ''}">${esc(catName(r.category))}</span></span>
      <span class="actions"><button type="button" class="btn ghost" data-delrule>Remover</button></span></li>`).join('')
    || '<li class="muted small">Nenhuma regra. Marque “aplicar a todas com esta descrição” ao categorizar um lançamento.</li>';
}
async function openCategories() {
  $('#cats-msg').textContent = '';
  try { state.cats = await api('/api/categories'); } catch (err) { $('#cats-msg').textContent = err.message; }
  renderCategoriesDialog();
  if (!$('#dlg-categories').open) $('#dlg-categories').showModal();
}
$('#btn-categories').addEventListener('click', openCategories);
$('#btn-cats-add').addEventListener('click', async () => {
  const name = $('#cats-new').value.trim();
  if (!name) return;
  try { await createCategory(name); $('#cats-new').value = ''; $('#cats-msg').textContent = ''; renderCategoriesDialog(); }
  catch (err) { $('#cats-msg').textContent = err.message; }
});
$('#cats-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-cats-add').click(); } });
$('#cats-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const cat = state.cats.custom.find((c) => c.id === li.dataset.id);
  try {
    if ('rename' in e.target.dataset) {
      const name = prompt('Novo nome da categoria', cat.name)?.trim();
      if (!name || name === cat.name) return;
      await api(`/api/categories/${cat.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    } else if ('delete' in e.target.dataset) {
      if (!confirm(`Excluir a categoria “${cat.name}”? Os lançamentos dela (e as regras que apontam para ela) voltam à categoria da Pluggy.`)) return;
      await api(`/api/categories/${cat.id}`, { method: 'DELETE' });
    } else return;
    await openCategories();
    await refreshData();
  } catch (err) { $('#cats-msg').textContent = err.message; }
});
$('#rules-list').addEventListener('click', async (e) => {
  const id = e.target.closest('li[data-rule]')?.dataset.rule;
  if (!id || !('delrule' in e.target.dataset)) return;
  try { await api(`/api/categories/rules/${id}`, { method: 'DELETE' }); await openCategories(); await refreshData(); }
  catch (err) { $('#cats-msg').textContent = err.message; }
});

// ---------------------------------------------------------------- dividir despesa
const shareDlg = { tx: null };
const shareRow = (personId = '', amount = '') => `<div class="share-row">
    <select class="share-person" aria-label="Pessoa"><option value="">Escolha a pessoa…</option>${state.people.map((p) => `<option value="${esc(p.id)}"${p.id === personId ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}<option value="__new">+ Nova pessoa…</option></select>
    <input class="share-amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Valor" aria-label="Valor da parte" value="${amount}">
    <button type="button" class="btn ghost icon share-del" title="Remover" aria-label="Remover pessoa">✕</button></div>`;
function shareRows() {
  return [...document.querySelectorAll('#share-rows .share-row')].map((r) => ({ el: r, personId: r.querySelector('.share-person').value, amount: Number(r.querySelector('.share-amount').value) || 0 }));
}
function updateShareMine() {
  const t = shareDlg.tx;
  const others = shareRows().reduce((s, r) => s + r.amount, 0);
  const mine = Math.round((t.amount - others) * 100) / 100;
  $('#share-mine').innerHTML = mine < -0.004 ? `<span class="neg">As partes passam do valor da despesa em ${fmt(-mine)}</span>` : `Sua parte: <strong>${fmt(Math.max(0, mine))}</strong> de ${fmt(t.amount)}`;
}
// parcela prevista vista como despesa: dividi-la é dividir a compra (todas as parcelas)
const upTx = (u) => ({ id: u.sourceId, date: null, description: u.description, amount: u.amount, installment: u.installment, purchaseKey: u.purchaseKey,
  category: u.category, pluggyCategory: u.pluggyCategory, categorySource: u.categorySource,
  shares: u.shares, shareScope: u.shares ? 'purchase' : undefined, myAmount: u.myAmount, direction: 'out', predicted: true });
function openShareDialog(id, predicted = false) {
  const u = predicted && (state.billUp || []).find((x) => x.sourceId === id);
  const t = u ? upTx(u) : findTx(id);
  if (!t) return;
  shareDlg.tx = t;
  $('#share-tx').innerHTML = `<strong>${D(t)}</strong> · ${t.predicted ? 'parcela prevista' : brDate(t.date)} · ${fmt(t.amount)}${t.installment ? ` · parcela ${t.installment}` : ''}`;
  $('#share-rows').innerHTML = (t.shares || [{ personId: state.people.length === 1 ? state.people[0].id : '', amount: '' }]).map((x) => shareRow(x.personId, x.amount)).join('');
  $('#share-scope-box').hidden = !t.purchaseKey;
  $('#share-scope').checked = !t.shares || t.shareScope === 'purchase';
  $('#share-scope').disabled = !!t.predicted; // prevista não tem lançamento próprio: sempre vale para a compra
  $('#share-scope-label').textContent = `Aplicar a todas as parcelas desta compra${t.installment ? ` (${t.installment.split('/')[1]}x)` : ''}, proporcional ao valor de cada uma`;
  $('#btn-share-remove').hidden = !t.shares;
  $('#share-msg').textContent = '';
  updateShareMine();
  $('#dlg-share').showModal();
}
async function refreshData() {
  state.loadedRange = null; // força recarregar as transações
  await loadAll();
}
async function saveShares(shares) {
  const t = shareDlg.tx;
  const scope = t.purchaseKey && (t.predicted || (shares.length ? $('#share-scope').checked : t.shareScope === 'purchase')) ? 'purchase' : 'tx';
  await api(`/api/transactions/${encodeURIComponent(t.id)}/shares`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shares, scope }) });
  $('#dlg-share').close();
  await refreshData();
  if ($('#dlg-people').open) renderPeople();
}
async function createPerson(name) {
  const p = await api('/api/people', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  state.people = await api('/api/people');
  return p;
}
document.addEventListener('click', (e) => {
  const id = e.target.closest('[data-share-tx]')?.dataset.shareTx;
  if (id) openShareDialog(id);
  const up = e.target.closest('[data-share-up]')?.dataset.shareUp;
  if (up) openShareDialog(up, true);
  if (e.target.id === 'kpi-people') { e.preventDefault(); openPeople(); }
});
$('#share-rows').addEventListener('input', updateShareMine);
$('#share-rows').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('share-person') || e.target.value !== '__new') return;
  const sel = e.target;
  const name = prompt('Nome da pessoa')?.trim();
  if (!name) { sel.value = ''; return; }
  try {
    const p = await createPerson(name);
    // atualiza as opções de todas as linhas mantendo as escolhas
    for (const r of shareRows()) r.el.outerHTML = shareRow(r.el.querySelector('.share-person') === sel ? p.id : r.personId, r.amount || '');
    updateShareMine();
  } catch (err) { $('#share-msg').textContent = err.message; sel.value = ''; }
});
$('#share-rows').addEventListener('click', (e) => {
  if (!e.target.classList.contains('share-del')) return;
  e.target.closest('.share-row').remove();
  updateShareMine();
});
$('#btn-share-add').addEventListener('click', () => { $('#share-rows').insertAdjacentHTML('beforeend', shareRow()); updateShareMine(); });
// distribui em centavos, sobra vai para as primeiras pessoas
function splitCents(total, n) {
  const c = Math.round(total * 100), base = Math.floor(c / n);
  return Array.from({ length: n }, (_, i) => (base + (i < c - base * n ? 1 : 0)) / 100);
}
$('#btn-share-equal').addEventListener('click', () => {
  const rows = shareRows();
  if (!rows.length) return;
  const parts = splitCents(shareDlg.tx.amount, rows.length + 1).slice(1); // a primeira parte (com a sobra) é sua
  rows.forEach((r, i) => { r.el.querySelector('.share-amount').value = parts[i].toFixed(2); });
  updateShareMine();
});
$('#btn-share-all').addEventListener('click', () => {
  const rows = shareRows();
  if (!rows.length) return;
  const parts = splitCents(shareDlg.tx.amount, rows.length);
  rows.forEach((r, i) => { r.el.querySelector('.share-amount').value = parts[i].toFixed(2); });
  updateShareMine();
});
$('#share-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const rows = shareRows().filter((r) => r.personId || r.amount);
  if (rows.some((r) => !r.personId || r.personId === '__new')) { $('#share-msg').textContent = 'Escolha a pessoa de cada linha.'; return; }
  if (rows.some((r) => !(r.amount > 0))) { $('#share-msg').textContent = 'Informe o valor de cada parte.'; return; }
  try { await saveShares(rows.map((r) => ({ personId: r.personId, amount: r.amount }))); } catch (err) { $('#share-msg').textContent = err.message; }
});
$('#btn-share-remove').addEventListener('click', async () => {
  try { await saveShares([]); } catch (err) { $('#share-msg').textContent = err.message; }
});
$('#btn-share-cancel').addEventListener('click', () => $('#dlg-share').close());

// ---------------------------------------------------------------- pessoas
const peopleDlg = { sel: null };
function renderPeople() {
  $('#people-list').innerHTML = state.people.map((p) => `<li data-id="${esc(p.id)}"${p.id === peopleDlg.sel ? ' class="sel"' : ''}>
      <span class="grow"><strong>${esc(p.name)}</strong><br><span class="muted small">${p.items.length} despesa(s) · ${fmt(p.owed)} − ${fmt(p.paid)} pagos</span></span>
      <span class="person-bal ${p.balance > 0.004 ? '' : 'pos'}" title="${p.balance < -0.004 ? 'Pagou a mais' : ''}">${p.balance > 0.004 ? `deve ${fmt(p.balance)}` : p.balance < -0.004 ? `crédito ${fmt(-p.balance)}` : 'quite'}</span>
      <span class="actions"><button type="button" class="btn ghost" data-detail>Detalhes</button><button type="button" class="btn ghost" data-rename>Renomear</button><button type="button" class="btn ghost" data-delete>Excluir</button></span></li>`).join('')
    || '<li class="muted small">Ninguém cadastrado. Adicione abaixo ou direto ao dividir uma despesa.</li>';
  const p = state.people.find((x) => x.id === peopleDlg.sel);
  $('#person-detail').hidden = !p;
  if (!p) return;
  const accs = accById();
  $('#pd-title').textContent = `${p.name} · ${p.balance > 0.004 ? `deve ${fmt(p.balance)}` : p.balance < -0.004 ? `crédito de ${fmt(-p.balance)}` : 'quite'}`;
  $('#pay-amount').value = p.balance > 0.004 ? p.balance.toFixed(2) : '';
  if (!$('#pay-date').value) $('#pay-date').value = iso(todayLocal());
  $('#pd-items').innerHTML = p.items.map((x) => `<tr>
      <td class="date">${brDate(x.date)}</td>
      <td class="desc">${D(x)}${x.installment ? ` <span class="chip">${x.installment}</span>` : ''}<small>${esc(accs[x.accountId]?.name || '')}</small></td>
      <td class="num">${fmt(x.total)}</td><td class="num"><strong>${fmt(x.amount)}</strong></td></tr>`).join('')
    || '<tr><td colspan="4" class="muted">Nenhuma despesa dividida com esta pessoa.</td></tr>';
  $('#pd-payments').innerHTML = p.payments.map((x) => `<li data-pay="${x.id}"><span class="grow">${brDate(x.date)} · <strong>${fmt(x.amount)}</strong>${x.note ? ` <span class="muted small">${esc(x.note)}</span>` : ''}</span>
      <span class="actions"><button type="button" class="btn ghost" data-delpay>Remover</button></span></li>`).join('')
    || '<li class="muted small">Nenhum pagamento registrado.</li>';
}
async function openPeople() {
  $('#people-msg').textContent = '';
  try { state.people = await api('/api/people'); } catch (err) { $('#people-msg').textContent = err.message; }
  renderPeople();
  if (!$('#dlg-people').open) $('#dlg-people').showModal();
}
async function peopleChanged() {
  state.people = await api('/api/people');
  renderPeople();
  render();
  renderToday();
  if (state.view === 'bills') renderBills();
}
$('#btn-people').addEventListener('click', openPeople);
$('#btn-people-add').addEventListener('click', async () => {
  const name = $('#people-new').value.trim();
  if (!name) return;
  try { await createPerson(name); $('#people-new').value = ''; $('#people-msg').textContent = ''; renderPeople(); render(); }
  catch (err) { $('#people-msg').textContent = err.message; }
});
$('#people-new').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#btn-people-add').click(); } });
$('#people-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const p = state.people.find((x) => x.id === li.dataset.id);
  const d = e.target.dataset;
  try {
    if ('detail' in d) { peopleDlg.sel = peopleDlg.sel === p.id ? null : p.id; $('#pay-date').value = ''; renderPeople(); return; }
    if ('rename' in d) {
      const name = prompt('Novo nome', p.name)?.trim();
      if (!name || name === p.name) return;
      await api(`/api/people/${p.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
    } else if ('delete' in d) {
      if (!confirm(`Excluir ${p.name}? As divisões (${p.items.length}) e os pagamentos registrados dela também serão apagados, e essas despesas voltam a ser só suas.`)) return;
      await api(`/api/people/${p.id}`, { method: 'DELETE' });
      if (peopleDlg.sel === p.id) peopleDlg.sel = null;
      await refreshData();
    } else return;
    await peopleChanged();
  } catch (err) { $('#people-msg').textContent = err.message; }
});
$('#btn-pay-add').addEventListener('click', async () => {
  const amount = Number($('#pay-amount').value);
  if (!(amount > 0)) { $('#people-msg').textContent = 'Informe o valor recebido.'; return; }
  try {
    await api(`/api/people/${peopleDlg.sel}/payments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount, date: $('#pay-date').value || undefined, note: $('#pay-note').value.trim() || undefined }) });
    $('#pay-note').value = ''; $('#people-msg').textContent = '';
    await peopleChanged();
  } catch (err) { $('#people-msg').textContent = err.message; }
});
$('#pd-payments').addEventListener('click', async (e) => {
  const id = e.target.closest('li[data-pay]')?.dataset.pay;
  if (!id || !('delpay' in e.target.dataset)) return;
  try { await api(`/api/people/payments/${id}`, { method: 'DELETE' }); await peopleChanged(); }
  catch (err) { $('#people-msg').textContent = err.message; }
});
$('#my-share').addEventListener('change', (e) => { state.myShare = e.target.checked; render(); });

// ---------------------------------------------------------------- eventos
$('#period-presets').addEventListener('click', (e) => {
  const p = e.target.dataset.preset;
  if (!p) return;
  document.querySelectorAll('#period-presets button').forEach((b) => b.classList.toggle('active', b === e.target));
  $('#custom-range').hidden = p !== 'custom';
  state.preset = p;
  loadTransactions().catch((err) => showError(err.message));
});
['#from', '#to'].forEach((s) => $(s).addEventListener('change', () => {
  if (!$('#from').value || !$('#to').value || $('#from').value > $('#to').value) return;
  state.from = $('#from').value; state.to = $('#to').value;
  loadTransactions().catch((err) => showError(err.message));
}));
$('#exclude-internal').addEventListener('change', (e) => { state.excludeInternal = e.target.checked; render(); });
$('#accounts').addEventListener('click', (e) => {
  const id = e.target.closest('.acc')?.dataset.id;
  if (!id) return;
  if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
  if (state.selected.size === state.accounts.length) state.selected.clear();
  state.shown = PAGE;
  render();
});
$('#select-all').addEventListener('click', (e) => { e.preventDefault(); state.selected.clear(); render(); });
['#search', '#cat-filter', '#dir-filter'].forEach((s) => $(s).addEventListener('input', () => { state.shown = PAGE; renderTable(periodTx()); if (s === '#cat-filter') renderCharts(periodTx()); }));
$('#btn-more').addEventListener('click', () => { state.shown += PAGE; renderTable(periodTx()); });
$('#btn-csv').addEventListener('click', exportCsv);
$('#btn-refresh').addEventListener('click', () => loadAll(true));
$('#btn-connections').addEventListener('click', openConnections);

// tema
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  if (state.accounts.length) { if (state.view === 'bills') renderBills(); else if (state.view === 'overview') renderCharts(periodTx()); }
}
$('#btn-theme').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', next); } catch {}
  applyTheme(next);
});
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(document.documentElement.dataset.theme));
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch {}

const urlPreset = new URLSearchParams(location.search).get('periodo');
if (urlPreset && document.querySelector(`[data-preset="${CSS.escape(urlPreset)}"]`) && urlPreset !== 'custom') {
  state.preset = urlPreset;
  document.querySelectorAll('#period-presets button').forEach((b) => b.classList.toggle('active', b.dataset.preset === urlPreset));
}
if (window.Chart) Chart.defaults.font.family = 'system-ui, -apple-system, "Segoe UI", sans-serif';
// usuário logado
api('/api/me').then(({ authEnabled, user }) => {
  if (!authEnabled || !user) return;
  $('#user-box').hidden = false;
  $('#user-email').textContent = user.name || user.email;
  $('#user-email').title = user.email;
  if (user.picture) $('#user-pic').src = user.picture; else $('#user-pic').hidden = true;
}).catch(() => {});
$('#btn-logout').addEventListener('click', async () => {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  location.href = '/login.html';
});

if (location.hash === '#visao') history.replaceState(null, '', '#visao-geral');
setView(viewFromHash(), { push: false });
loadAll();
