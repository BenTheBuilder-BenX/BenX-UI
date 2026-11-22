import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { storeAdmin, telegramWebhook, fulfillOrder, retryStoreQueue } from '../worker/store';
import { decrypt, encrypt, issueSession } from '../worker/security';
import { newStore, storeLanguage, validateStore, matchesPayment, normalizeDigits, storeAmount } from '../shared/store';
import { newPolicy, type ServerPolicy } from '../shared/policy';
import type { Client, JsonObject } from '../shared/types';
import worker from '../worker/index';

const remote = vi.mocked(callRemoteJson), key = btoa('k'.repeat(32)), botToken = '123456789:' + 'a'.repeat(32), hook = 'h'.repeat(32);
let sqlite: DatabaseSync, env: Env, requests: Array<{ method: string; body: JsonObject }>, clients: Client[], policy: ServerPolicy;
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) || null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
}
const req = (path: string, method = 'GET', body?: unknown) => new Request('https://benx.example.com/api/store' + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
async function setup() {
  const config = newStore(); config.enabled = true; config.support = '@support'; config.terms = 'Thirty day access. Contact support for refunds.'; config.products = [{ id: 'pro', name: 'Pro', description: '100 GB for 30 days', serverId: 's', serviceId: 'pro', price: 100, enabled: true }];
  sqlite.prepare('INSERT INTO telegram_store(id,revision,config,secrets,username,webhook,connected) VALUES(1,0,?,?,?,?,1)').run(JSON.stringify(config), await encrypt({ token: botToken, hook }, key), 'benx_test_bot', 'https://benx.example.com/telegram/webhook');
}
async function update(id: number, body: JsonObject, secret = hook) {
  const pending: Promise<unknown>[] = [], ctx = { waitUntil(p: Promise<unknown>) { pending.push(p); } } as ExecutionContext;
  const response = await telegramWebhook(new Request('https://benx.example.com/telegram/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify({ update_id: id, ...body }) }), env, ctx);
  await Promise.all(pending); return response;
}
const callback = (data: string, user = 123) => ({ callback_query: { id: 'cb', from: { id: user }, message: { chat: { id: user, type: 'private' } }, data } });
const pay = (payload: string, amount = 100, user = 123, charge = 'charge-one') => ({ message: { chat: { id: user, type: 'private' }, from: { id: user }, successful_payment: { invoice_payload: payload, currency: 'XTR', total_amount: amount, telegram_payment_charge_id: charge } } });
const order = () => sqlite.prepare('SELECT * FROM telegram_orders').get() as { id: string; status: string; provision: string; charge_id: string; error: string };
async function transferSetup() {
  await setup(); const row = sqlite.prepare('SELECT config FROM telegram_store').get() as { config: string }, config = JSON.parse(row.config);
  config.language = 'fa'; config.transfer = { enabled: true, currency: 'IRT', cardNumber: '6037997512345678', cardHolder: 'فروشنده آزمایشی', bankName: 'بانک آزمایشی', instructions: 'مبلغ دقیق واریز شود', adminIds: ['789'] }; config.products[0].transferPrice = 150000;
  sqlite.prepare('UPDATE telegram_store SET config=?').run(JSON.stringify(config));
}
const receipt = (user = 123, file = 'test-receipt-file') => ({ message: { chat: { id: user, type: 'private' }, from: { id: user }, photo: [{ file_id: file, file_size: 1000 }] } });
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) sqlite.exec(readFileSync('migrations/' + file, 'utf8'));
  env = { DB: database(sqlite), ENCRYPTION_KEY: key, ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a'.repeat(20), SESSION_SECRET: 's'.repeat(32), ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
  sqlite.prepare("INSERT INTO servers(id,name,url,credentials,auth,created_at) VALUES('s','Test','https://server.example.com/','secret','token',1)").run();
  policy = newPolicy(); policy.services = [{ id: 'pro', name: 'Pro', description: '', enabled: true, inbounds: [{ inboundId: 1, multiplier: 1 }], rules: { quotaGB: 100, expiryDays: 30, ipLimit: 0, hwidLimit: 0 }, formats: ['v2ray', 'singbox', 'clash'] }];
  sqlite.prepare('INSERT INTO server_policy(server_id,revision,data,updated_at) VALUES(?,?,?,?)').run('s', 0, JSON.stringify(policy), 1);
  requests = []; clients = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init.body)) }); return Response.json({ ok: true, result: url.endsWith('/getMe') ? { id: 123456789, is_bot: true, username: 'benx_test_bot' } : true }); }));
  remote.mockImplementation(async (_s, _e, input) => {
    if (input.path.endsWith('/inbounds/list')) return [{ id: 1, protocol: 'vless', enable: true, expiryTime: 0, settings: { publicHost: 'vpn.example.com', clients }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'vpn.example.com' } } }];
    if (input.path.endsWith('/clients/list')) return structuredClone(clients);
    if (input.path.endsWith('/clients/add')) { clients.push(structuredClone(input.body!.client as Client)); return null; }
    if (input.path.includes('/clients/update/')) { clients[0] = structuredClone(input.body as Client); return null; }
    if (input.path.includes('/clients/get/')) return structuredClone(clients[0]);
    if (input.path.includes('/clients/links/')) return [`vless://${clients[0].id}@vpn.example.com:443?security=tls&sni=vpn.example.com#Pro`];
    throw new Error('Unexpected remote operation');
  });
});
afterEach(() => { sqlite.close(); vi.unstubAllGlobals(); remote.mockReset(); });

describe('Telegram store configuration and isolation', () => {
  it('localizes default storefront text while preserving an owner’s custom messages', () => { const config = storeLanguage({ ...newStore(), welcome: 'My own welcome' }, 'fa'); expect(config.welcome).toBe('My own welcome'); expect(config.buyLabel).toBe('خرید سرویس'); expect(config.thankYou).toContain('سپاسگزاریم'); expect(storeLanguage(config, 'en').buyLabel).toBe('Browse plans'); });
  it('uses saved menu, checkout and delivery labels in the buyer chat', async () => {
    await setup();
    const config = (await (await storeAdmin(req(''), env)).json() as {config: ReturnType<typeof newStore>}).config;
    config.copy = {support: 'میز کمک', terms: 'شرایط ما', choose: 'پلن را انتخاب کن', pay: 'خرید با ستاره', page: 'راهنمای من', noPurchases: 'سابقه خرید خالی است'};
    await storeAdmin(req('', 'PUT', {config}), env);
    await update(1, {message: {chat: {id: 123, type: 'private'}, from: {id: 123}, text: '/start'}});
    expect(JSON.stringify(requests.at(-1)?.body.reply_markup)).toContain('میز کمک');
    expect(JSON.stringify(requests.at(-1)?.body.reply_markup)).toContain('شرایط ما');
    await update(8, callback('configs')); expect(requests.at(-1)?.body.text).toBe('سابقه خرید خالی است');
    await update(2, callback('plans')); expect(requests.at(-1)?.body.text).toBe('پلن را انتخاب کن');
    await update(3, callback('product:pro')); expect(JSON.stringify(requests.at(-1)?.body.reply_markup)).toContain('خرید با ستاره');
    await update(4, callback('buy:pro')); await update(5, pay(order().id));
    expect(requests.at(-1)?.body.text).toContain('راهنمای من');
    expect(() => validateStore({...config, copy: {pay: 'x'.repeat(61)}})).toThrow('labels');
    expect(storeLanguage(newStore(), 'fa').terms).toContain('اشتراک');
    expect(storeLanguage({...config, terms: 'My policy'}, 'fa').terms).toBe('My policy');
  });
  it('keeps bot secrets encrypted and never returns them to the editor', async () => {
    const config = newStore(); await storeAdmin(req('', 'PUT', { config, token: botToken }), env);
    const raw = sqlite.prepare('SELECT secrets FROM telegram_store').get() as { secrets: string };
    expect(raw.secrets).not.toContain(botToken); expect(await decrypt(raw.secrets, key)).toMatchObject({ token: botToken });
    const view = await storeAdmin(req(''), env); const text = await view.text(); expect(text).not.toContain(botToken); expect(JSON.parse(text).hasToken).toBe(true);
  });
  it('rejects a stale save without overwriting another session', async () => {
    const config = newStore(); await storeAdmin(req('', 'PUT', { config }), env);
    await expect(storeAdmin(req('', 'PUT', { config: { ...config, name: 'Stale' } }), env)).rejects.toThrow('another session');
    expect((await (await storeAdmin(req(''), env)).json() as { config: { name: string } }).config.name).toBe('BenX Store');
  });
  it('requires admin authentication and same-origin writes', async () => {
    expect((await worker.fetch(req('') as never, env, {} as ExecutionContext)).status).toBe(401);
    const token = await issueSession(env);
    const request = new Request('https://benx.example.com/api/store', { method: 'PUT', headers: { Cookie: `benx_session=${token}`, Origin: 'https://evil.example.com', 'Content-Type': 'application/json' }, body: JSON.stringify({ config: newStore() }) });
    expect((await worker.fetch(request as never, env, {} as ExecutionContext)).status).toBe(403);
  });
  it('rejects an unsigned webhook without storing or acting on its update', async () => { await setup(); await expect(update(1, callback('plans'), 'wrong')).rejects.toThrow('signature'); expect(sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_updates').get()?.n).toBe(0); expect(requests).toHaveLength(0); });
  it('blocks checkout and invoices while paused but retains existing purchases', async () => { await setup(); await storeAdmin(req('/pause', 'POST'), env); await update(1, callback('buy:pro')); expect(requests.some(r => r.method === 'sendInvoice')).toBe(false); expect(sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_orders').get()?.n).toBe(0); });
  it('validates prices and custom buttons instead of accepting unsafe links', () => { const config = newStore(); config.buttons = [{ label: 'Help', url: 'javascript:alert(1)' }]; expect(() => validateStore(config)).toThrow('HTTPS'); config.buttons = []; config.products = [{ id: 'p', name: 'P', description: 'Plan', price: 0.5, serverId: 's', serviceId: 'pro', enabled: true }]; expect(() => validateStore(config)).toThrow('whole-number'); });
  it('starts only with ready products and installs a signed public webhook', async () => {
    await setup(); await storeAdmin(req('/pause', 'POST'), env); await storeAdmin(req('/start', 'POST'), env);
    const hookCall = requests.find(r => r.method === 'setWebhook'); expect(hookCall?.body.url).toBe('https://benx.example.com/telegram/webhook'); expect(hookCall?.body.secret_token).toBe(hook); expect(hookCall?.body.drop_pending_updates).toBe(false);
    expect(requests.find(r => r.method === 'setMyName')?.body.name).toBe('BenX Store');
    const row = sqlite.prepare('SELECT connected,secrets FROM telegram_store').get() as { connected: number; secrets: string }; expect(row.connected).toBe(1); expect(await decrypt(row.secrets, key)).toMatchObject({ botId: 123456789 });
  });
  it('rotates a paused store token only for the same bot identity', async () => {
    await setup(); await storeAdmin(req('/pause', 'POST'), env); const config = (await (await storeAdmin(req(''), env)).json() as { config: ReturnType<typeof newStore> }).config;
    await storeAdmin(req('', 'PUT', { config, token: '123456789:' + 'b'.repeat(32) }), env); const row = sqlite.prepare('SELECT secrets,connected FROM telegram_store').get() as { secrets: string; connected: number }; expect(row.connected).toBe(1); expect(await decrypt(row.secrets, key)).toMatchObject({ hook });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, result: { is_bot: true, id: 999, username: 'different_bot' } })));
    const latest = (await (await storeAdmin(req(''), env)).json() as { config: ReturnType<typeof newStore> }).config; await expect(storeAdmin(req('', 'PUT', { config: latest, token: '999999999:' + 'c'.repeat(32) }), env)).rejects.toThrow('different bot');
  });
});
describe('Seller-reviewed Iranian card transfers', () => {
  it('connects for setup before products or admin IDs exist, without opening sales', async () => { const config = newStore(); await storeAdmin(req('', 'PUT', { config, token: botToken }), env); await storeAdmin(req('/connect', 'POST'), env); const view = await (await storeAdmin(req(''), env)).json() as { config: { enabled: boolean }; connected: boolean }; expect(view.connected).toBe(true); expect(view.config.enabled).toBe(false); await update(1, { message: { chat: { id: 789, type: 'private' }, from: { id: 789 }, text: '/id' } }, (await decrypt<{ hook: string }>((sqlite.prepare('SELECT secrets FROM telegram_store').get() as { secrets: string }).secrets, key)).hook); expect(requests.at(-1)?.body.text).toContain('789'); });
  it('accepts Persian digits, validates admins, and keeps Stars and transfer prices separate', () => {
    expect(normalizeDigits('۱۲٣۴۵')).toBe('12345'); expect(storeAmount(150000, 'IRT', 'fa')).toContain('تومان');
    const config = newStore(); config.transfer = { ...config.transfer, enabled: true, cardNumber: '۶۰۳۷ ۹۹۷۵ ۱۲۳۴ ۵۶۷۸', cardHolder: 'Test', adminIds: ['۷۸۹'] }; expect(validateStore(config).transfer).toMatchObject({ cardNumber: '6037997512345678', adminIds: ['789'] });
    config.transfer.adminIds = ['@admin']; expect(() => validateStore(config)).toThrow('numeric'); config.transfer.adminIds = []; expect(() => validateStore(config)).toThrow('admin ID');
  });
  it('creates a pending transfer with frozen amount/currency and waits for a photo and an admin', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); expect(o.status).toBe('awaiting_receipt'); expect(clients).toHaveLength(0); expect(requests.some(r => r.method === 'sendInvoice')).toBe(false);
    expect(requests.at(-1)?.body.text).toContain('تومان'); expect(requests.at(-1)?.body.text).toContain('6037 9975 1234 5678');
    await update(2, callback(`receipt:${o.id}`)); await update(3, receipt()); expect(order().status).toBe('awaiting_approval'); expect(clients).toHaveLength(0);
    const stored = sqlite.prepare('SELECT receipt FROM telegram_orders').get() as { receipt: string }; expect(stored.receipt).not.toContain('test-receipt-file'); expect(await decrypt(stored.receipt, key)).toMatchObject({ fileId: 'test-receipt-file' });
    expect(requests.find(r => r.method === 'sendPhoto')?.body).toMatchObject({ chat_id: 789, photo: 'test-receipt-file', protect_content: true });
  });
  it('rejects unauthorized admin callbacks and another buyer’s receipt attempts', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`, 456)); await update(3, receipt(456)); expect(order().status).toBe('awaiting_receipt');
    await update(4, callback(`receipt:${o.id}`)); await update(5, receipt()); await update(6, callback(`approve:${o.id}:1`, 456)); expect(order().status).toBe('awaiting_approval'); expect(clients).toHaveLength(0);
    await update(7, callback(`approve:${o.id}:1`, 789)); expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1);
    await update(8, callback(`approve:${o.id}:1`, 789)); await update(9, callback(`reject:${o.id}:1`, 789)); expect(clients).toHaveLength(1); expect(order().status).toBe('delivered');
  });
  it('allows corrected receipts but an old approval button cannot approve the replacement', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`)); await update(3, receipt());
    await update(4, callback(`reject:${o.id}:1`, 789)); expect(order().status).toBe('awaiting_receipt'); await update(5, callback(`receipt:${o.id}`)); await update(6, receipt(123, 'corrected-photo'));
    await update(7, callback(`approve:${o.id}:1`, 789)); expect(order().status).toBe('awaiting_approval'); expect(clients).toHaveLength(0);
    await update(8, callback(`approve:${o.id}:2`, 789)); expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1);
  });
  it('does not accept Stars payment events for transfer orders and never calls Stars refunds for them', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, pay(o.id, 150000)); expect(order().status).toBe('awaiting_receipt'); expect(clients).toHaveLength(0);
    await expect(storeAdmin(req(`/orders/${o.id}/refund`, 'POST'), env)).rejects.toThrow('bank'); expect(requests.some(r => r.method === 'refundStarPayment')).toBe(false);
  });
  it('lets an authenticated panel admin review the same version, with durable failed-delivery recovery', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`)); await update(3, receipt());
    remote.mockRejectedValueOnce(new Error('Panel unavailable')); await storeAdmin(req(`/orders/${o.id}/approve`, 'POST', { receiptVersion: 1 }), env); expect(order().status).toBe('delivery_failed');
    await fulfillOrder(env, o.id); expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1);
    const rows = await (await storeAdmin(req('/orders'), env)).json() as { has_receipt: number; currency: string }[]; expect(rows[0]).toMatchObject({ has_receipt: 1, currency: 'IRT' }); expect(JSON.stringify(rows)).not.toContain('test-receipt-file');
  });
  it('rejects oversized/non-image documents and expires receipt upload sessions', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`));
    await update(3, { message: { chat: { id: 123, type: 'private' }, from: { id: 123 }, document: { file_id: 'script', mime_type: 'text/html', file_size: 100 } } }); expect(order().status).toBe('awaiting_receipt');
    sqlite.prepare('UPDATE telegram_receipt_sessions SET expires_at=0').run(); await update(4, receipt()); expect(order().status).toBe('awaiting_receipt'); expect(requests.some(r => r.method === 'sendPhoto')).toBe(false);
  });
  it('keeps /id and pending receipt submissions available while sales are paused', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await storeAdmin(req('/pause', 'POST'), env);
    await update(2, { message: { chat: { id: 789, type: 'private' }, from: { id: 789 }, text: '/id' } }); expect(requests.at(-1)?.body.text).toContain('789');
    await update(3, callback(`receipt:${o.id}`)); await update(4, receipt()); expect(order().status).toBe('awaiting_approval');
  });
  it('serves receipt images only to panel admins without exposing the bot token or caching private media', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`)); await update(3, receipt());
    expect((await worker.fetch(req(`/orders/${o.id}/receipt`) as never, env, {} as ExecutionContext)).status).toBe(401);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.endsWith('/getFile') ? Response.json({ ok: true, result: { file_path: 'photos/test.jpg' } }) : new Response(new Uint8Array([255, 216, 255, 0]))));
    const response = await storeAdmin(req(`/orders/${o.id}/receipt`), env); expect(response.headers.get('Content-Type')).toBe('image/jpeg'); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual([255, 216, 255, 0]); expect([...response.headers].join()).not.toContain(botToken);
  });
  it('rejects a stale panel approval and unsafe receipt download paths', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`)); await update(3, receipt());
    await expect(storeAdmin(req(`/orders/${o.id}/approve`, 'POST', { receiptVersion: 2 }), env)).rejects.toThrow('replaced'); expect(order().status).toBe('awaiting_approval');
    const fetcher = vi.fn(async () => Response.json({ ok: true, result: { file_path: '../secret.jpg' } })); vi.stubGlobal('fetch', fetcher); await expect(storeAdmin(req(`/orders/${o.id}/receipt`), env)).rejects.toThrow('supported'); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retains receipts when admin notification fails and retries notification without asking the buyer to upload again', async () => {
    await transferSetup(); await update(1, callback('transfer:pro')); const o = order(); await update(2, callback(`receipt:${o.id}`)); let blocked = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json(url.endsWith('/sendPhoto') && blocked ? { ok: false } : { ok: true, result: true })));
    await update(3, receipt()); expect(order().status).toBe('awaiting_approval'); expect(order().error).toContain('notification'); expect(sqlite.prepare('SELECT status FROM telegram_updates WHERE id=3').get()?.status).toBe('done');
    blocked = false; await retryStoreQueue(env); expect(sqlite.prepare('SELECT receipt_notified FROM telegram_orders').get()?.receipt_notified).toBe(1); expect(order().error).toBe(''); expect(clients).toHaveLength(0);
  });
});
describe('Confirmed payment and recoverable delivery', () => {
  it('does not provision on pre-checkout, rejects changed plans, and validates owner/price/currency', async () => {
    await setup(); await update(1, callback('buy:pro')); const o = order(); expect(clients).toHaveLength(0);
    await update(2, { pre_checkout_query: { id: 'q', from: { id: 123 }, invoice_payload: o.id, currency: 'XTR', total_amount: 100 } });
    expect(requests.at(-1)?.body.ok).toBe(true); expect(clients).toHaveLength(0);
    policy.services[0].rules.quotaGB = 200; sqlite.prepare('UPDATE server_policy SET data=?').run(JSON.stringify(policy));
    await update(3, { pre_checkout_query: { id: 'q2', from: { id: 123 }, invoice_payload: o.id, currency: 'XTR', total_amount: 100 } }); expect(requests.at(-1)?.body.ok).toBe(false);
    policy.services[0].rules.quotaGB = 100; policy.subscriptions = Object.fromEntries(policy.services[0].formats.map(f => [f, { baseUrl: '', enabled: false, options: {} }])); sqlite.prepare('UPDATE server_policy SET data=?').run(JSON.stringify(policy));
    await update(6, { pre_checkout_query: { id: 'q3', from: { id: 123 }, invoice_payload: o.id, currency: 'XTR', total_amount: 100 } }); expect(requests.at(-1)?.body.ok).toBe(false);
    expect(matchesPayment({ ...o, user_id: 123, amount: 100 }, { invoice_payload: o.id, currency: 'USD', total_amount: 100 }, 123)).toBe(false);
    await update(4, pay(o.id, 99)); await update(5, pay(o.id, 100, 456)); expect(order().status).toBe('pending'); expect(clients).toHaveLength(0);
  });
  it('delivers all representable app links once and ignores duplicate payment updates', async () => {
    await setup(); await update(1, callback('buy:pro')); const o = order(); await update(2, pay(o.id));
    expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1); expect(clients[0].enable).toBe(true); expect(clients[0].totalGB).toBe(100 * 1024 ** 3);
    expect(clients[0].tgId).toBe(123); expect(clients[0].uuid).toBe(clients[0].id);
    const deliveries = requests.filter(r => r.method === 'sendMessage'); expect(deliveries.at(-1)?.body.text).toContain('/v2ray'); expect(deliveries.at(-1)?.body.text).toContain('/singbox'); expect(deliveries.at(-1)?.body.text).toContain('/clash'); expect(deliveries.at(-1)?.body.protect_content).toBe(true);
    await update(2, pay(o.id)); await update(3, pay(o.id)); expect(clients).toHaveLength(1); expect(requests.filter(r => r.method === 'sendMessage')).toHaveLength(deliveries.length);
  });
  it('recovers an ambiguous client-create timeout with the same identity', async () => {
    await setup(); await update(1, callback('buy:pro')); const o = order(); const original = remote.getMockImplementation()!; let timeout = true;
    remote.mockImplementation(async (...args) => { const value = await original(...args); if (timeout && args[2].path.endsWith('/clients/add')) { timeout = false; throw new Error('Network timeout after creation'); } return value; });
    await update(2, pay(o.id)); expect(order().status).toBe('delivery_failed'); expect(clients).toHaveLength(1);
    const id = clients[0].id; await fulfillOrder(env, o.id); expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1); expect(clients[0].id).toBe(id);
  });
  it('keeps delivery failures visible and disables created access before a refund', async () => {
    await setup(); await update(1, callback('buy:pro')); const o = order();
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { requests.push({ method: url.split('/').at(-1)!, body: JSON.parse(String(init.body)) }); return Response.json({ ok: !url.endsWith('/sendMessage'), result: true }); }));
    await update(2, pay(o.id)); expect(order().status).toBe('delivery_failed'); expect(clients[0].enable).toBe(true);
    await storeAdmin(req(`/orders/${o.id}/refund`, 'POST'), env); expect(order().status).toBe('refunded'); expect(clients[0].enable).toBe(false); expect(sqlite.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()?.n).toBe(0); expect(requests.at(-1)?.method).toBe('refundStarPayment');
  });
  it('never discloses another customer’s subscription through My configs', async () => {
    await setup(); await update(1, callback('buy:pro')); await update(2, pay(order().id)); const count = requests.length;
    await update(3, callback('configs', 456)); const messages = requests.slice(count).filter(r => r.method === 'sendMessage'); expect(messages).toHaveLength(1); expect(messages[0].body.text).not.toContain('/sub/');
  });
});

describe('Optional Stars checkout', () => {
  const disableStars = () => { const row = sqlite.prepare('SELECT config FROM telegram_store').get() as { config: string }; const config = JSON.parse(row.config); config.starsEnabled = false; sqlite.prepare('UPDATE telegram_store SET config=?').run(JSON.stringify(config)); };
  it('defaults older configurations to Stars enabled and prevents a running store without payment methods', () => { const old = JSON.parse(JSON.stringify(newStore())); delete old.starsEnabled; expect(validateStore(old).starsEnabled).toBe(true); expect(() => validateStore({ ...newStore(), enabled: true, starsEnabled: false })).toThrow('payment method'); });
  it('hides Stars buttons and prices and rejects previously shared buy callbacks', async () => {
    await transferSetup(); disableStars(); await update(1, callback('product:pro'));
    const message = requests.find(r => r.method === 'sendMessage')!; expect(JSON.stringify(message.body)).not.toContain('buy:pro'); expect(String(message.body.text)).not.toContain('⭐'); expect(JSON.stringify(message.body)).toContain('transfer:pro');
    await update(2, callback('buy:pro')); expect(sqlite.prepare('SELECT COUNT(*) AS n FROM telegram_orders').get()?.n).toBe(0); expect(requests.some(r => r.method === 'sendInvoice')).toBe(false);
  });
  it('rejects outstanding pre-checkout after disabling Stars but still delivers a payment that already settled', async () => {
    await setup(); await update(1, callback('buy:pro')); const id = order().id; disableStars();
    await update(2, { pre_checkout_query: { id: 'pre', from: { id: 123 }, currency: 'XTR', total_amount: 100, invoice_payload: id } }); expect(requests.find(r => r.method === 'answerPreCheckoutQuery')?.body.ok).toBe(false);
    await update(3, pay(id)); expect(order().status).toBe('delivered'); expect(clients).toHaveLength(1);
  });
});
