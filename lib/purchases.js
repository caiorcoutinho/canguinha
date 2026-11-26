// Compras parceladas: a Pluggy manda cada parcela como um lançamento solto, sem id da compra.
// A "etiqueta" (purchaseKey) junta as parcelas da mesma compra: conta + data da compra + nº de parcelas + descrição
// sem o "PARC 01/03". Divisões com pessoas e categorias por compra ficam gravadas por ela ("purchase:<etiqueta>").
import { ruleKey } from '../public/shared.js';

// Descrição sem o marcador de parcela ("LOJA PARC 02/10 CIDADE BR" → "LOJA CIDADE BR").
export const stripInstallment = (d) => String(d || '').replace(/\s*(parc(ela)?\.?\s*)?\d{1,2}\s*\/\s*\d{1,2}\s*/gi, ' ').replace(/\s+/g, ' ').trim();

// Mantém códigos longos da descrição: dois pedidos no mesmo dia ("AMAZON 1234567" e "AMAZON 7654321") são compras diferentes.
export const purchaseKey = (accountId, purchaseDate, totalInstallments, description) =>
  [accountId, purchaseDate || '', totalInstallments, stripInstallment(description).toLowerCase()].join('|');

// Etiqueta antiga (até 11/2026): usava ruleKey, que apaga códigos longos e juntava pedidos diferentes. Só para a migração.
const legacyPurchaseKey = (accountId, purchaseDate, totalInstallments, description) =>
  [accountId, purchaseDate || '', totalInstallments, ruleKey(description)].join('|');

// Antiga → novas, a partir das parcelas gravadas. `list`: transações normalizadas (com accountId e purchaseKey).
// Uma antiga pode virar várias novas (pedidos que a antiga juntava): a divisão é copiada para todas, como valia antes.
export function purchaseKeyChanges(list) {
  const map = new Map();
  for (const t of list) {
    if (!t.purchaseKey) continue;
    const old = legacyPurchaseKey(t.accountId, t.purchaseDate, t.totalInstallments, t.description);
    if (old === t.purchaseKey) continue;
    if (!map.has(old)) map.set(old, new Set());
    map.get(old).add(t.purchaseKey);
  }
  return new Map([...map].map(([k, v]) => [`purchase:${k}`, [...v].map((x) => `purchase:${x}`)]));
}

// Roda uma vez (marcada em settings): renomeia as divisões e categorias por compra gravadas com a etiqueta antiga.
export async function migratePurchaseKeys(store, normalize, log = console) {
  const DONE = 'migration:purchase_key_v2';
  if (await store.getSetting(DONE)) return;
  const list = (await store.listInstallmentTransactions()).map(({ accountId, raw }) => normalize(raw, accountId));
  const moved = await store.renamePurchaseTargets(purchaseKeyChanges(list));
  await store.setSetting(DONE, new Date().toISOString());
  log.log(`[migração] etiqueta das compras parceladas: ${moved.shares} divisão(ões) e ${moved.categories} categoria(s) atualizadas`);
}
