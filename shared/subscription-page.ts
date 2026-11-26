export const pageThemes = {
  crazy: {name:'Crazy',description:'Neon orbit with two live progress rings',accent:'#a78bfa',background:'#05040c',symbol:'✺'},
  infinity: {name:'Infinity',description:'Flowing infinity loops for data and time',accent:'#6366f1',background:'#05040c',symbol:'∞'},
  wave: {name:'Wave',description:'Layered luminous waves and glass connection cards',accent:'#6366f1',background:'#06060f',symbol:'≋'},
  jungle: {name:'Jungle',description:'Tropical foliage and green wave meters',accent:'#14856b',background:'#051710',symbol:'❧'},
  ocean: {name:'Ocean',description:'Underwater light rays and blue wave meters',accent:'#0284c7',background:'#08407a',symbol:'≈'},
  flower: {name:'Flower',description:'Floating blossoms and soft floral wave meters',accent:'#c53983',background:'#241024',symbol:'✿'},
  aurora: { name: "Aurora", description: "Your supplied design · glowing rings and a glass dashboard", accent: "#6366f1", background: "#07070d", symbol: "✦" },
  custom: { name: "Your HTML", description: "Upload your own layout with live account and connection blocks", accent: "#2563eb", background: "#f3f5fa", symbol: "◇" },
  gaming: { name: 'Gaming', description: 'Angular arena with a dedicated account scoreboard', accent: '#8b5cf6', background: '#0c1023', symbol: '🎮' },
  nature: { name: 'Nature', description: 'Organic welcome card and a vertical connection path', accent: '#14856b', background: '#eef7ef', symbol: '🌿' },
  tech: { name: 'Tech', description: 'Split dashboard with an account sidebar and app workspace', accent: '#2563eb', background: '#edf3fd', symbol: '◈' },
  candy: { name: 'Candy', description: 'Rounded connection cards, a usage ticket and two shelves', accent: '#c53983', background: '#fff0f7', symbol: '🍬' },
  classic: { name: 'Classic', description: 'Quiet editorial layout with a clear account ledger', accent: '#77583e', background: '#f7f4ef', symbol: '◎' },
} as const;
export interface SubscriptionAnnouncement { title: string; message: string; enabled: boolean }
export interface SubscriptionPageDesign { theme: keyof typeof pageThemes; title: string; subtitle: string; accent: string; support: string; purchase?: string; language: 'en' | 'fa' | 'ru' | 'zh'; customHTML?: string; announcements?: SubscriptionAnnouncement[] }
export function sellerLink(value: unknown): string {
  if (value === '') return '';
  if (typeof value === 'string' && value.length <= 250 && /^https:\/\//i.test(value) && !/\s/.test(value)) {
    try {
      const url = new URL(value);
      if (!url.username && !url.password) return value;
    } catch { /* Show the same guidance for malformed URLs. */ }
  }
  throw new Error('Seller links must use HTTPS without embedded credentials.');
}
export const defaultPageDesign: SubscriptionPageDesign = { theme: 'crazy', title: 'Your connection', subtitle: 'Choose your app to connect.', accent: '#6366f1', support: '', language: 'en' };
export function validatePageDesign(value: unknown): SubscriptionPageDesign {
  const b = value as SubscriptionPageDesign;
  if (!b || !Object.hasOwn(pageThemes, b.theme) || !['en', 'fa', 'ru', 'zh'].includes(b.language) || typeof b.title !== 'string' || !b.title.trim() || b.title.length > 80 || typeof b.subtitle !== 'string' || b.subtitle.length > 240 || typeof b.accent !== 'string' || !/^#[\da-f]{6}$/i.test(b.accent) || typeof b.support !== 'string' || b.support.length > 250) throw new Error('Choose a template and valid branding options.');
  const support = sellerLink(b.support), purchase = sellerLink(b.purchase ?? '');
  if (b.theme === "custom") validateCustomSubscriptionHTML(b.customHTML);
  const announcements = b.announcements ?? [];
  if (!Array.isArray(announcements) || announcements.length > 8 || announcements.some(a => !a || typeof a.title !== 'string' || a.title.length > 100 || typeof a.message !== 'string' || !a.message.trim() || a.message.length > 2000 || typeof a.enabled !== 'boolean')) throw new Error('Add up to eight announcements with a title and message (maximum 2000 characters).');
  return { ...(b.theme === "custom" ? { customHTML: b.customHTML } : {}), ...(b.announcements !== undefined ? { announcements: announcements.map(a => ({ title: a.title.trim(), message: a.message.trim(), enabled: a.enabled })) } : {}), theme: b.theme, title: b.title.trim(), subtitle: b.subtitle, accent: b.accent, support, ...(b.purchase !== undefined ? { purchase } : {}), language: b.language };
}
export function escapeHTML(s: unknown) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!); }

export const subscriptionSlots = ['header', 'meter', 'account', 'subscription', 'files', 'footer'] as const;
export function validateCustomSubscriptionHTML(html: unknown): asserts html is string {
  if (typeof html !== 'string' || new TextEncoder().encode(html).length > 200000 || !/<html[\s>]/i.test(html) || !/<body[\s>]/i.test(html) || !/<\/body\s*>/i.test(html)) throw Error('Choose an HTML document up to 200 KB.');
  if (/<\s*(?:script|iframe|object|embed|base|form|foreignObject)\b|\bon[a-z]+\s*=|(?:javascript|vbscript)\s*:|<meta[^>]+http-equiv|@import|url\s*\(/i.test(html)) throw Error('Use HTML and CSS only. Scripts, forms, embedded pages and external CSS resources are not supported.');
  const body = html.split(/<body[^>]*>/i)[1]?.split(/<\/body\s*>/i)[0] || '';
  const plain = body.replace(/<!--[\s\S]*?-->|<style\b[^>]*>[\s\S]*?<\/style>|<[^>]*>/gi, '');
  for (const slot of subscriptionSlots) {
    const token = '{{' + slot + '}}';
    if (html.split(token).length !== 2 || !plain.includes(token) || !new RegExp('(?:^|\\n)[ \t]*\\{\\{' + slot + '\\}\\}[ \t]*(?:\\r?\\n|$)').test(body)) throw Error('Include {{' + slot + '}} once on its own line inside the body. Download the starter for an example.');
  }
  if (/\{\{(?!header\}\}|meter\}\}|account\}\}|subscription\}\}|files\}\}|footer\}\})/.test(html)) throw Error('Use only the six supported content placeholders.');
}
export const customSubscriptionStarter = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>My subscription</title><style>
body{margin:0;background:#f4f1ea;color:#24332d;font:16px/1.6 system-ui}.my-page{max-width:960px;margin:auto;padding:24px}.my-grid{display:grid;grid-template-columns:1fr 1.5fr;gap:24px}.panel,header,.meter{border-radius:24px!important;background:#fff!important;color:#24332d!important}.my-note{letter-spacing:.15em;text-transform:uppercase;font-size:12px}@media(max-width:720px){.my-grid{grid-template-columns:1fr}}
</style></head><body><div class="my-page"><p class="my-note">Welcome to my network</p>
{{header}}
{{meter}}
<div class="my-grid"><div>
{{account}}
</div><div>
{{subscription}}
{{files}}
</div></div>
{{footer}}
</div></body></html>`;
