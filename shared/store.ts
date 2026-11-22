export interface StoreProduct { id: string; name: string; description: string; serverId: string; serviceId: string; price: number; transferPrice?: number; enabled: boolean }
export interface TransferSettings { enabled: boolean; currency: 'IRT' | 'IRR'; cardNumber: string; cardHolder: string; bankName: string; instructions: string; adminIds: string[] }
export interface StoreButton { label: string; url: string }
export const defaultBotText = {
  en: { support: 'Support', terms: 'Terms', choose: 'Choose your plan:', pay: 'Agree & pay with Stars ⭐', page: 'Customer page and connection guide' },
  fa: { support: 'پشتیبانی', terms: 'قوانین', choose: 'سرویس خود را انتخاب کنید:', pay: 'پذیرش قوانین و پرداخت با استارز ⭐', page: 'صفحهٔ اشتراک و راهنمای اتصال' },
};
export const orderMessages = {
  noPurchases: { en: "You have no purchases yet.", fa: "هنوز خریدی ندارید.", max: 350 },
  pendingDelivery: { en: "Payment received. Delivery is pending.", fa: "پرداخت تأیید شده؛ تحویل سرویس در حال انجام است.", max: 350 },
  paused: { en: "The store is paused. Use /myconfigs for existing purchases.", fa: "فروشگاه موقتاً بسته است. برای خریدهای قبلی از /myconfigs استفاده کنید.", max: 350 },
  unavailable: { en: "Payments are currently unavailable.", fa: "پرداخت در حال حاضر فعال نیست.", max: 350 },
  planGone: { en: "This plan is no longer available.", fa: "این سرویس دیگر در دسترس نیست.", max: 350 },
  invoiceLimit: { en: "You already have three open invoices. Complete one or try again later.", fa: "سه فاکتور باز دارید. یکی را تکمیل کنید یا بعداً دوباره تلاش کنید.", max: 350 },
  starsOff: { en: "Stars payments are disabled.", fa: "پرداخت با استارز غیرفعال است.", max: 350 },
  transferOff: { en: "Card transfers are unavailable.", fa: "پرداخت کارت به کارت در دسترس نیست.", max: 350 },
  noSupport: { en: "Customer support is being configured.", fa: "اطلاعات پشتیبانی در حال تنظیم است.", max: 350 },
  noTerms: { en: "Purchase terms are being configured.", fa: "شرایط خرید در حال تنظیم است.", max: 350 },
  reviewing: { en: "Awaiting admin review", fa: "در انتظار بررسی مدیر", max: 350 },
  waitingReceipt: { en: "Awaiting your receipt", fa: "در انتظار ارسال رسید", max: 350 },
  sendReceipt: { en: "Send receipt", fa: "ارسال رسید", max: 60 },
  resubmit: { en: "Resubmit receipt", fa: "ارسال مجدد رسید", max: 60 },
  rejected: { en: "Your receipt was not approved. Contact support or submit a corrected receipt.", fa: "رسید شما تأیید نشد. با پشتیبانی تماس بگیرید یا رسید درست را دوباره ارسال کنید.", max: 350 },
  received: { en: "Receipt received. Your admin will verify the bank transaction before delivering your config.", fa: "رسید دریافت شد ✅ پس از بررسی تراکنش بانکی توسط مدیر، نتیجه و کانفیگ برایتان ارسال می‌شود.", max: 350 },
  receiptFormat: { en: "Tap Send receipt on your order first, then send a JPG or PNG image up to 10 MB.", fa: "ابتدا دکمه «ارسال رسید» سفارش را بزنید، سپس عکس JPG یا PNG تا ۱۰ مگابایت ارسال کنید.", max: 350 },
  noReceipt: { en: "This order is not awaiting a receipt.", fa: "این سفارش قابل ارسال رسید نیست.", max: 350 },
  receiptPrompt: { en: "Send a receipt photo for this order. Uploading a receipt does not confirm payment.", fa: "عکس رسید این سفارش را همین‌جا بفرستید. ارسال عکس به معنی تأیید پرداخت نیست.", max: 350 },
  transferLabel: { en: "Card transfer", fa: "کارت به کارت", max: 60 },
  back: { en: "←", fa: "←", max: 60 },
  consent: { en: "Choosing card transfer accepts the purchase terms. After transferring, tap Send receipt. Access activates after admin approval.", fa: "با انتخاب کارت به کارت، قوانین خرید را پذیرفته‌اید. پس از انتقال، روی «ارسال رسید» بزنید. سرویس پس از بررسی و تأیید مدیر فعال می‌شود.", max: 350 },
  expiredInvoice: { en: "This order is no longer available. Please choose your plan again.", fa: "این سفارش دیگر در دسترس نیست. سرویس را دوباره انتخاب کنید.", max: 180 },
  amount: { en: "Exact amount", fa: "مبلغ دقیق", max: 60 },
  card: { en: "Card number", fa: "شماره کارت", max: 60 },
  idLabel: { en: "Your numeric Telegram ID", fa: "شناسه عددی تلگرام شما", max: 60 },
} as const;
export type OrderMessageKey = keyof typeof orderMessages;
export type BotTextKey = keyof typeof defaultBotText.en | OrderMessageKey;
export const botTextFields = { support: 'Support button', terms: 'Terms button', choose: 'Plan selection message', pay: 'Stars checkout button', page: 'Customer page link label' };
const defaultTerms = { en: 'Each purchase creates one subscription with the data and duration shown for your plan. After payment, use My configs to retrieve it. For order or payment questions use /paysupport.', fa: 'با هر خرید یک اشتراک با حجم و مدت درج‌شده در سرویس ساخته می‌شود. پس از پرداخت از «کانفیگ‌های من» دوباره به آن دسترسی دارید. برای پیگیری سفارش یا پرداخت، /paysupport را بفرستید.' };
export function botText(config: StoreConfig, key: BotTextKey) {
  const defaults = Object.hasOwn(orderMessages, key) ? orderMessages[key as OrderMessageKey][config.language] : defaultBotText[config.language][key as keyof typeof defaultBotText.en];
  return config.copy?.[key]?.trim() || defaults;
}
export interface StoreConfig { copy?: Partial<Record<BotTextKey, string>>; revision: number; name: string; welcome: string; language: 'en' | 'fa'; support: string; terms: string; thankYou: string; buyLabel: string; configsLabel: string; buttonColumns: number; buttons: StoreButton[]; products: StoreProduct[]; enabled: boolean; starsEnabled: boolean; transfer: TransferSettings }
export interface StoreView { config: StoreConfig; hasToken: boolean; username: string; webhook: string; connected: boolean }
export interface StoreOrder { id: string; user_id: number; product_name: string; amount: number; status: string; created_at: number; paid_at: number | null; email: string; error: string; currency: string; payment_method: string; has_receipt: boolean; receipt_version: number }
export function newStore(): StoreConfig { return { revision: 0, name: 'BenX Store', welcome: 'Welcome! Choose a plan and get your connection in seconds.', language: 'en', support: '', terms: defaultTerms.en, thankYou: 'Thank you for your purchase. Your connection is ready.', buyLabel: 'Browse plans', configsLabel: 'My configs', buttonColumns: 2, buttons: [], products: [], enabled: false, starsEnabled: true, transfer: { enabled: false, currency: 'IRT', cardNumber: '', cardHolder: '', bankName: '', instructions: '', adminIds: [] } }; }
export function normalizeDigits(value: string) { return value.replace(/[۰-۹٠-٩]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.includes(c) ? '۰۱۲۳۴۵۶۷۸۹'.indexOf(c) : '٠١٢٣٤٥٦٧٨٩'.indexOf(c))); }
export function storeAmount(amount: number, currency: string, language: 'en' | 'fa' = 'en') { return `${amount.toLocaleString(language === 'fa' ? 'fa-IR' : 'en-US')} ${currency === 'XTR' ? '⭐' : currency === 'IRT' ? language === 'fa' ? 'تومان' : 'toman' : language === 'fa' ? 'ریال' : 'rial'}`; }
export function productPrices(product: StoreProduct, config: StoreConfig) {
  return [config.starsEnabled && storeAmount(product.price, 'XTR', config.language), config.transfer.enabled && storeAmount(product.transferPrice || 0, config.transfer.currency, config.language)].filter(Boolean).join(' / ');
}
export function hydrateStore(value: StoreConfig): StoreConfig { return { ...value, starsEnabled: value?.starsEnabled ?? true, transfer: { ...newStore().transfer, ...value?.transfer } }; }
export function storeLanguage(config: StoreConfig, language: 'en' | 'fa'): StoreConfig {
  const defaults = { en: { welcome: newStore().welcome, thankYou: newStore().thankYou, buyLabel: 'Browse plans', configsLabel: 'My configs' }, fa: { welcome: 'خوش آمدید! سرویس خود را انتخاب کنید و تنظیمات اتصال را دریافت کنید.', thankYou: 'از خرید شما سپاسگزاریم. اتصال شما آماده است.', buyLabel: 'خرید سرویس', configsLabel: 'کانفیگ‌های من' } };
  const next = { ...config, language };
  if (config.terms === defaultTerms[config.language]) next.terms = defaultTerms[language];
  for (const key of ['welcome', 'thankYou', 'buyLabel', 'configsLabel'] as const) if (config[key] === defaults[config.language][key]) next[key] = defaults[language][key];
  return next;
}
export function validateStore(value: unknown): StoreConfig {
  const s = hydrateStore(value as StoreConfig);
  if (!s || typeof s !== 'object' || !Number.isSafeInteger(s.revision) || s.revision < 0 || typeof s.enabled !== 'boolean' || typeof s.starsEnabled !== 'boolean' || !['en', 'fa'].includes(s.language) || ![1, 2].includes(s.buttonColumns)) throw new Error('Invalid store settings.');
  if (s.copy !== undefined && (!s.copy || typeof s.copy !== 'object' || Array.isArray(s.copy) || Object.entries(s.copy).some(([key, text]) => !Object.hasOwn(botTextFields, key) && !Object.hasOwn(orderMessages, key) || typeof text !== 'string' || text.length > (Object.hasOwn(orderMessages, key) ? orderMessages[key as OrderMessageKey].max : key === 'choose' ? 250 : 60)))) throw new Error('Check the custom bot labels and messages.');
  for (const [key, max] of Object.entries({ name: 64, welcome: 2000, support: 500, terms: 3000, thankYou: 1000, buyLabel: 40, configsLabel: 40 })) {
    const text = s[key as keyof StoreConfig]; if (typeof text !== 'string' || text.length > max || ['name', 'welcome', 'buyLabel', 'configsLabel'].includes(key) && !text.trim()) throw new Error(`Check the store ${key}.`);
  }
  if (!Array.isArray(s.buttons) || s.buttons.length > 8 || !Array.isArray(s.products) || s.products.length > 50) throw new Error('Use up to 8 custom buttons and 50 products.');
  for (const b of s.buttons) { if (!b || typeof b.label !== 'string' || !b.label.trim() || b.label.length > 40 || typeof b.url !== 'string' || b.url.length > 1000) throw new Error('Check the custom button label and link.'); const u = new URL(b.url); if (u.protocol !== 'https:' || u.username || u.password) throw new Error('Custom buttons require an HTTPS link.'); }
  const ids = new Set<string>();
  for (const p of s.products) { if (!p || !/^[a-zA-Z0-9_-]{1,40}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 32 || typeof p.description !== 'string' || !p.description.trim() || p.description.length > 255 || typeof p.serverId !== 'string' || typeof p.serviceId !== 'string' || !p.serverId || !p.serviceId || !Number.isSafeInteger(p.price) || p.price < (s.starsEnabled ? 1 : 0) || p.price > 1000000 || typeof p.enabled !== 'boolean') throw new Error('Products need a unique ID, name, description, server, service and a valid whole-number price for each enabled payment method.'); ids.add(p.id); }
  const t = s.transfer;
  if (typeof t.enabled !== 'boolean' || !['IRT', 'IRR'].includes(t.currency) || !Array.isArray(t.adminIds) || t.adminIds.length > 10 || [t.cardNumber, t.cardHolder, t.bankName, t.instructions, ...t.adminIds].some(v => typeof v !== 'string')) throw new Error('Check card-transfer settings.');
  t.cardNumber = normalizeDigits(t.cardNumber).replace(/[\s-]/g, '');
  t.adminIds = [...new Set(t.adminIds.map(v => normalizeDigits(v).trim()).filter(Boolean))];
  if (t.cardHolder.length > 100 || t.bankName.length > 100 || t.instructions.length > 1500 || t.cardNumber && !/^\d{16}$/.test(t.cardNumber) || t.adminIds.some(v => !/^[1-9]\d{0,15}$/.test(v) || !Number.isSafeInteger(Number(v)))) throw new Error('Use a 16-digit card number and numeric personal Telegram admin IDs.');
  if (t.enabled && (!t.cardNumber || !t.cardHolder.trim() || !t.adminIds.length)) throw new Error('Card transfers need the seller’s card number, cardholder name and Telegram admin ID.');
  if (s.products.some(p => p.transferPrice !== undefined && (!Number.isSafeInteger(p.transferPrice) || p.transferPrice < 0 || p.transferPrice > 1e12) || t.enabled && p.enabled && !p.transferPrice)) throw new Error('Set a whole-number transfer price for each active plan.');
  if (s.enabled && !s.starsEnabled && !t.enabled) throw new Error('Enable at least one payment method before opening sales.');
  return s;
}
export function matchesPayment(order: { id: string; user_id: number; amount: number; status: string; currency?: string; payment_method?: string }, payment: { invoice_payload?: unknown; currency?: unknown; total_amount?: unknown }, userId: number): boolean { return (!order.currency || order.currency === 'XTR') && (!order.payment_method || order.payment_method === 'stars') && order.id === payment.invoice_payload && order.user_id === userId && payment.currency === 'XTR' && payment.total_amount === order.amount && ['pending', 'paid', 'processing', 'delivery_failed', 'delivered'].includes(order.status); }
