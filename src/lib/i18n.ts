import { useSyncExternalStore } from 'react';
export type Locale = 'en' | 'fa' | 'ru' | 'zh';
export const languages: Array<{ code: Locale; name: string }> = [{ code: 'en', name: 'English' }, { code: 'fa', name: 'فارسی' }, { code: 'ru', name: 'Русский' }, { code: 'zh', name: '中文' }];
const dictionaries: Partial<Record<Locale, Record<string, string>>> = {};
const loaders = {
  fa: () => import('../locales/fa.json'),
  ru: () => import('../locales/ru.json'),
  zh: () => import('../locales/zh.json'),
};
let requestedLocale = 0;
async function loadLocale(next: Locale) {
  if (next !== 'en' && !dictionaries[next]) dictionaries[next] = (await loaders[next]()).default;
}
/** Load just the saved language before rendering to avoid a translation flash. */
export async function initializeLocale() {
  try { await loadLocale(locale); } catch { locale = 'en'; apply(); }
}
let locale: Locale = 'en';
try { const saved = localStorage.getItem('benx-language') || localStorage.getItem('benx_lang'); if (languages.some(l => l.code === saved)) locale = saved as Locale; } catch { /* Storage may be disabled. */ }
const listeners = new Set<() => void>();
function apply() { if (typeof document !== 'undefined') { document.documentElement.lang = locale; document.documentElement.dir = locale === 'fa' ? 'rtl' : 'ltr'; } }
apply();
export async function setLocale(next: Locale) { const request = ++requestedLocale; await loadLocale(next); if (request !== requestedLocale) return; locale = next; try { localStorage.setItem('benx-language', next); } catch { /* Keep the session preference. */ } apply(); listeners.forEach(fn => fn()); }
export function useLocale() { return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => locale, () => 'en' as Locale); }
export function t(text: string | number | undefined, ...values: unknown[]): string {
  if (text === undefined) return '';
  if (typeof text === 'number') return String(text);
  if (!text) return '';
  const key = text.trim(), translated = locale === 'en' ? key : dictionaries[locale]?.[key] || key;
  const rendered = translated.replace(/\{(\d+)\}/g, (match, i: string) => Number(i) < values.length ? String(values[Number(i)] ?? '') : match);
  return text.slice(0, text.length - text.trimStart().length) + rendered + text.slice(text.trimEnd().length);
}
