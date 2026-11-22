import { masterDNSBackend } from '../shared/masterdns';
import { botText, productPrices, hydrateStore, matchesPayment, newStore, storeAmount, validateStore, type StoreConfig, type StoreProduct } from '../shared/store';
import { formatNames, newPolicy, serviceClientFields, type ServerPolicy, type ServicePlan } from '../shared/policy';
import { parseObject, type Client, type Inbound, type JsonObject, type ServerCapabilities } from '../shared/types';
import type { StoredServer } from './remote';
import { provisioningRequest as callRemoteJson, managedRow, reconcileServer } from './control';
import { decrypt, encrypt, equalSecret, HttpError, readJson, readLimited, validateUrl } from './security';
import { issueStoreSubscription, publicSubscription } from './subscriptions';
import { policyRoute } from './policy';

interface Secrets { token: string; hook: string; botId?: number }
interface Saved { config: string; secrets: string; username: string; webhook: string; connected: number; revision: number }
interface Order { id: string; update_key: number; user_id: number; product_name: string; amount: number; status: string; created_at: number; paid_at: number; email: string; snapshot: string; provision: string; delivery: string; charge_id: string; lease_until: number; currency: string; payment_method: string; receipt: string; receipt_notified: number; receipt_version: number; reviewed_at: number | null }
interface Snapshot { terms?: string; product: StoreProduct; service: ServicePlan; serverId: string }
interface Update { update_id: number; message?: { chat: { id: number; type: string }; from?: { id: number }; text?: string; photo?: { file_id: string; file_size?: number }[]; document?: { file_id: string; mime_type?: string; file_size?: number }; successful_payment?: { invoice_payload: string; currency: string; total_amount: number; telegram_payment_charge_id: string } }; callback_query?: { id: string; from: { id: number }; message?: { chat: { id: number; type: string } }; data?: string }; pre_checkout_query?: { id: string; from: { id: number }; currency: string; total_amount: number; invoice_payload: string } }
const output = (value: unknown) => Response.json(value);
async function saved(env: Env) { return env.DB.prepare('SELECT * FROM telegram_store WHERE id=1').first<Saved>(); }
async function load(env: Env) { const row = await saved(env); if (!row) throw new HttpError(409, 'Save your Telegram store first.'); return { row, config: hydrateStore(JSON.parse(row.config) as StoreConfig), secrets: await decrypt<Secrets>(row.secrets, env.ENCRYPTION_KEY) }; }
export async function telegramCall(token: string, method: string, body: JsonObject = {}) {
  let response: Response;
  try { response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) }); } catch { throw new HttpError(502, 'Telegram could not be reached. Try again.'); }
  let value: { ok?: boolean; result?: unknown }; try { value = JSON.parse(new TextDecoder().decode(await readLimited(response, 128 * 1024))); } catch { throw new HttpError(502, 'Telegram returned an invalid response.'); }
  if (!response.ok || !value.ok) throw new HttpError(502, 'Telegram rejected this action. Check the bot token and bot permissions.');
  return value.result;
}
async function policyFor(env: Env, serverId: string): Promise<ServerPolicy> { const row = await env.DB.prepare('SELECT data,revision FROM server_policy WHERE server_id=?').bind(serverId).first<{ data: string; revision: number }>(); return row ? { ...JSON.parse(row.data), revision: row.revision } : newPolicy(); }
async function target(env: Env, product: StoreProduct, checkRemote = true) {
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(product.serverId).first<StoredServer>();
  if (!server?.enabled || server.version !== 'v3') throw new HttpError(409, 'This product needs an enabled 3X-UI 3.x or full-access server.');
  const policy = await policyFor(env, server.id), service = policy.services.find(s => s.id === product.serviceId && s.enabled);
  if (Object.keys(policy.clients).length >= 10000) throw new HttpError(409, 'This server has reached its client policy limit. Choose another server.');
  if (!service || !service.inbounds.length || !service.formats.some(f => policy.subscriptions[f]?.enabled !== false)) throw new HttpError(409, 'Choose an enabled service with inbounds and subscription formats.');
  if (server.kind !== 'server' && service.inbounds.some(i => i.multiplier !== 1)) throw new HttpError(409, 'Weighted store plans require a full-access server; a panel connection counts actual traffic.');
  let passwordLength = 32;
  if (checkRemote) {
    const inbounds = await callRemoteJson(server, env, { path: '/panel/api/inbounds/list', method: 'GET' }) as Inbound[];
    const included = service.inbounds.map(i => inbounds.find(n => n.id === i.inboundId));
    for (const inbound of included) {
      if (!inbound?.enable || inbound.excludeFromSub || inbound.expiryTime > 0 && inbound.expiryTime <= Date.now()) throw new HttpError(409, 'Choose active service inbounds visible in subscriptions.');
      if (inbound.protocol === 'masterdnsvpn' && server.kind === 'server') {
        let backend;
        try { backend = masterDNSBackend(inbound, inbounds); } catch (error) { throw new HttpError(409, (error as Error).message); }
        if (!backend && (service.rules.quotaGB || service.rules.expiryDays)) throw new HttpError(409, 'Standalone MasterDNS is unmetered and uses a shared key. Pair a private VLESS backend to sell a capped or expiring plan.');
        if (!backend && included.length === 1 && (!service.formats.includes('v2box') || policy.subscriptions.v2box?.enabled === false)) throw new HttpError(409, 'Enable V2Box for a standalone MasterDNS product.');
      } else if (!['vless', 'vmess', 'trojan', 'shadowsocks'].includes(inbound.protocol)) throw new HttpError(409, 'This inbound does not support automatic store delivery.');
    }
    const ssLengths = new Set(included.filter(i => i?.protocol === 'shadowsocks').map(i => String(parseObject(i!.settings).method || '')).filter(m => m.startsWith('2022-')).map(m => m === '2022-blake3-aes-128-gcm' ? 16 : 32));
    if (ssLengths.size > 1) throw new HttpError(409, 'This service mixes incompatible Shadowsocks 2022 client key sizes. Use separate services.');
    if (ssLengths.size) passwordLength = [...ssLengths][0];
    if (server.kind === 'server') {
      if (included.some(i => i!.protocol !== 'masterdnsvpn' && !parseObject(i!.settings).publicHost)) throw new HttpError(409, 'Set a public proxy host on every service inbound.');
      const capabilities = await callRemoteJson(server, env, { path: '/benx/v1/capabilities', method: 'GET' }) as ServerCapabilities;
      if (!capabilities.features.includes('weighted-accounting') || service.rules.ipLimit || service.rules.hwidLimit) throw new HttpError(409, 'Update the accounting agent and remove unsupported IP/HWID limits before selling this service.');
    }
  }
  return { server, policy, service, passwordLength };
}
export async function storeAdmin(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  const receiptPath = path.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/receipt$/);
  if (receiptPath && request.method === 'GET') {
    const order = await env.DB.prepare('SELECT receipt FROM telegram_orders WHERE id=?').bind(receiptPath[1]).first<{ receipt: string }>();
    if (!order?.receipt) throw new HttpError(404, 'No receipt uploaded.');
    const { secrets } = await load(env), receipt = await decrypt<Receipt>(order.receipt, env.ENCRYPTION_KEY);
    const file = parseObject(await telegramCall(secrets.token, 'getFile', { file_id: receipt.fileId }));
    if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_/-]+\.(jpg|jpeg|png)$/.test(file.file_path) || file.file_path.includes('..')) throw new HttpError(502, 'Telegram did not return a supported receipt image.');
    let response: Response;
    try { response = await fetch(`https://api.telegram.org/file/bot${secrets.token}/${file.file_path}`, { redirect: 'error', signal: AbortSignal.timeout(8000) }); } catch { throw new HttpError(502, 'Receipt could not be loaded. Review it in Telegram.'); }
    if (!response.ok) throw new HttpError(502, 'Receipt could not be loaded.');
    const content = await readLimited(response, 10 * 1024 * 1024), bytes = new Uint8Array(content), png = [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b), jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if (!png && !jpeg) throw new HttpError(502, 'Unsupported receipt image.');
    return new Response(content, { headers: { 'Content-Type': png ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (path === '/api/store' && request.method === 'GET') { const row = await saved(env); return output(row ? { config: { ...hydrateStore(JSON.parse(row.config)), revision: row.revision }, hasToken: Boolean((await decrypt<Secrets>(row.secrets, env.ENCRYPTION_KEY)).token), username: row.username, webhook: row.webhook, connected: Boolean(row.connected) } : { config: newStore(), hasToken: false, username: '', webhook: '', connected: false }); }
  if (path === '/api/store' && request.method === 'PUT') {
    const input = await readJson<{ config: StoreConfig; token?: string }>(request); let config: StoreConfig;
    try { config = validateStore(input.config); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const row = await saved(env), secrets: Secrets = row ? await decrypt<Secrets>(row.secrets, env.ENCRYPTION_KEY) : { token: '', hook: crypto.randomUUID().replaceAll('-', '') };
    if (input.token !== undefined && (typeof input.token !== 'string' || input.token && !/^\d{5,20}:[a-zA-Z0-9_-]{20,120}$/.test(input.token))) throw new HttpError(400, 'Enter the bot token from BotFather.');
    const changedToken = Boolean(input.token && input.token !== secrets.token);
    let sameBot = false;
    if (changedToken && row?.connected) {
      if (config.enabled) throw new HttpError(409, 'Pause sales before rotating the bot token.');
      const me = parseObject(await telegramCall(input.token!, 'getMe'));
      sameBot = Boolean(me.is_bot && (secrets.botId ? me.id === secrets.botId : me.username === row.username));
      if (!sameBot) throw new HttpError(409, 'Existing purchases belong to this bot. Use its new token, rather than a different bot.');
    }
    if (!row && config.revision !== 0) throw new HttpError(409, 'Reload the store before saving.');
    if (changedToken && !sameBot && (await env.DB.prepare('SELECT COUNT(*) AS count FROM telegram_orders').first<{ count: number }>())?.count) throw new HttpError(409, 'Keep the original bot for purchase history. A token for another bot cannot take over existing customers.');
    if (input.token) secrets.token = input.token;
    if (changedToken && !sameBot) { secrets.hook = crypto.randomUUID().replaceAll('-', ''); delete secrets.botId; }
    if (config.enabled !== Boolean(row && JSON.parse(row.config).enabled)) throw new HttpError(400, 'Use Start or Pause to change store availability.');
    for (const p of config.products) if (p.enabled) await target(env, p, false);
    const next = { ...config, revision: config.revision + 1 };
    const result = await env.DB.prepare('INSERT INTO telegram_store(id,revision,config,secrets,username,webhook,connected) VALUES(1,?,?,?,\'\',\'\',0) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,config=excluded.config,secrets=excluded.secrets,username=CASE WHEN ? THEN \'\' ELSE telegram_store.username END,webhook=CASE WHEN ? THEN \'\' ELSE telegram_store.webhook END,connected=CASE WHEN ? THEN 0 ELSE telegram_store.connected END WHERE telegram_store.revision=? RETURNING id').bind(next.revision, JSON.stringify(next), await encrypt(secrets, env.ENCRYPTION_KEY), Number(changedToken && !sameBot), Number(changedToken && !sameBot), Number(changedToken && !sameBot), config.revision).first();
    if (!result) throw new HttpError(409, 'The store changed in another session. Reload before saving.');
    return output({ config: next });
  }
  if (path === '/api/store/orders' && request.method === 'GET') return output((await env.DB.prepare("SELECT id,user_id,product_name,amount,status,created_at,paid_at,email,error,currency,payment_method,receipt_version,receipt!='' AS has_receipt FROM telegram_orders ORDER BY created_at DESC LIMIT 100").all()).results);
  const action = path.match(/^\/api\/store\/(test|connect|start|pause)$/);
  if (action && request.method === 'POST') {
    const { row, config, secrets } = await load(env);
    if (!secrets.token) throw new HttpError(400, 'Save a bot token first.');
    if (action[1] === 'test') { const me = parseObject(await telegramCall(secrets.token, 'getMe')); if (!me.is_bot || typeof me.username !== 'string') throw new HttpError(502, 'This token does not identify a Telegram bot.'); await env.DB.prepare('UPDATE telegram_store SET username=? WHERE id=1 AND revision=?').bind(me.username, row.revision).run(); return output({ username: me.username }); }
    if (action[1] === 'start' || action[1] === 'connect') {
      const origin = new URL(request.url).origin; validateUrl(origin);
      if (action[1] === 'start') {
        if (!config.starsEnabled && !config.transfer.enabled) throw new HttpError(400, 'Enable at least one payment method before opening sales.');
        if (!config.support.trim() || !config.terms.trim() || !config.products.some(p => p.enabled)) throw new HttpError(400, 'Add support details, purchase terms, and at least one active product.');
        try { validateStore(config); } catch (e) { throw new HttpError(400, (e as Error).message); }
        for (const p of config.products.filter(p => p.enabled)) await target(env, p);
      }
      const me = parseObject(await telegramCall(secrets.token, 'getMe'));
      if (!me.is_bot || !Number.isSafeInteger(me.id) || typeof me.username !== 'string') throw new HttpError(502, 'Telegram did not identify a valid bot.');
      const webhook = origin + '/telegram/webhook';
      await telegramCall(secrets.token, 'setMyName', { name: config.name });
      await telegramCall(secrets.token, 'setMyDescription', { description: Array.from(config.welcome).slice(0, 512).join('') });
      await telegramCall(secrets.token, 'setMyCommands', { commands: [{ command: 'start', description: config.language === 'fa' ? 'فروشگاه' : 'Open store' }, { command: 'id', description: config.language === 'fa' ? 'شناسه عددی من' : 'My numeric Telegram ID' }, { command: 'myconfigs', description: config.language === 'fa' ? 'کانفیگ‌ها و سفارش‌های من' : 'My configs and orders' }, { command: 'terms', description: config.language === 'fa' ? 'قوانین خرید' : 'Purchase terms' }, { command: 'support', description: config.language === 'fa' ? 'پشتیبانی' : 'Customer support' }, { command: 'paysupport', description: config.language === 'fa' ? 'پشتیبانی پرداخت' : 'Payment support' }] });
      await telegramCall(secrets.token, 'setWebhook', { url: webhook, secret_token: secrets.hook, allowed_updates: ['message', 'callback_query', 'pre_checkout_query'], drop_pending_updates: false });
      const result = await env.DB.prepare('UPDATE telegram_store SET config=?,revision=revision+1,username=?,webhook=?,connected=1,secrets=? WHERE id=1 AND revision=? RETURNING id').bind(JSON.stringify({ ...config, enabled: action[1] === 'start' || config.enabled, revision: row.revision + 1 }), String(me.username), webhook, await encrypt({ ...secrets, botId: me.id }, env.ENCRYPTION_KEY), row.revision).first();
      if (!result) throw new HttpError(409, 'Store settings changed while connecting. Reload and check the connection.');
      return output({ connected: true });
    }
    // Keep the webhook active while paused, so already-paid orders still deliver.
    await env.DB.prepare('UPDATE telegram_store SET config=?,revision=revision+1 WHERE id=1 AND revision=?').bind(JSON.stringify({ ...config, enabled: false, revision: row.revision + 1 }), row.revision).run();
    return output({ paused: true });
  }
  const orderAction = path.match(/^\/api\/store\/orders\/([a-f0-9-]{36})\/(retry|refund|approve|reject)$/);
  if (orderAction && request.method === 'POST') {
    if (['approve', 'reject'].includes(orderAction[2])) { const body = await readJson<{ receiptVersion: number }>(request); if (!await reviewTransfer(env, orderAction[1], orderAction[2] === 'approve', 'panel admin', body.receiptVersion)) throw new HttpError(409, 'This receipt was already reviewed or replaced. Refresh Orders.'); return output({ success: true }); }
    if (orderAction[2] === 'retry') { await fulfillOrder(env, orderAction[1]); return output({ success: true }); }
    const order = await env.DB.prepare('SELECT * FROM telegram_orders WHERE id=?').bind(orderAction[1]).first<Order>();
    if (order?.payment_method === 'transfer') throw new HttpError(409, 'Return a card transfer through your bank and contact the buyer. BenX cannot refund a bank transfer automatically.');
    if (!order?.charge_id || !['paid', 'delivery_failed', 'refund_pending'].includes(order.status)) throw new HttpError(409, 'Only an undelivered paid order can be refunded.');
    const claim = await env.DB.prepare("UPDATE telegram_orders SET status='refund_pending',lease_until=? WHERE id=? AND status IN ('paid','delivery_failed','refund_pending') AND lease_until<? RETURNING id").bind(Date.now() + 120000, order.id, Date.now()).first();
    if (!claim) throw new HttpError(409, 'This order is being processed.');
    try {
      const { secrets } = await load(env);
      if (order.provision) {
        const snapshot = JSON.parse(order.snapshot) as Snapshot, server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(snapshot.serverId).first<StoredServer>();
        if (!server) throw new HttpError(409, 'Reconnect the server to disable generated access before refunding.');
        const client = await decrypt<Client>(order.provision, env.ENCRYPTION_KEY);
        await callRemoteJson(server, env, { path: `/panel/api/clients/update/${encodeURIComponent(client.email)}`, method: 'POST', body: { ...client, enable: false } });
        await env.DB.prepare('DELETE FROM subscriptions WHERE server_id=? AND email=?').bind(server.id, client.email).run();
      }
      await telegramCall(secrets.token, 'refundStarPayment', { user_id: order.user_id, telegram_payment_charge_id: order.charge_id });
      await env.DB.prepare("UPDATE telegram_orders SET status='refunded',lease_until=0,error='' WHERE id=?").bind(order.id).run();
    }
    catch (e) { await env.DB.prepare("UPDATE telegram_orders SET lease_until=0,error='Refund not confirmed. Check Telegram before retrying.' WHERE id=?").bind(order.id).run(); throw e; }
    return output({ refunded: true });
  }
  throw new HttpError(405, 'Store action not supported.');
}
function chunks<T>(rows: T[], columns: number) { return Array.from({ length: Math.ceil(rows.length / columns) }, (_, i) => rows.slice(i * columns, (i + 1) * columns)); }
function keyboard(config: StoreConfig) { return { inline_keyboard: [...chunks([{ text: config.buyLabel, callback_data: 'plans' }, { text: config.configsLabel, callback_data: 'configs' }], config.buttonColumns), ...chunks(config.buttons.map(b => ({ text: b.label, url: b.url })), config.buttonColumns), ...chunks([{ text: botText(config, 'support'), callback_data: 'support' }, { text: botText(config, 'terms'), callback_data: 'terms' }], config.buttonColumns)] }; }
interface Receipt { fileId: string; document: boolean }
async function acceptReceipt(env: Env, userId: number, message: NonNullable<Update['message']>, config: StoreConfig, token: string) {
  const session = await env.DB.prepare('SELECT order_id FROM telegram_receipt_sessions WHERE user_id=? AND expires_at>?').bind(userId, Date.now()).first<{ order_id: string }>();
  const file = message.photo?.at(-1) ?? message.document;
  if (!session || !file || !file.file_id || file.file_id.length > 1024 || (file.file_size ?? 0) > 10 * 1024 * 1024 || message.document && !['image/jpeg', 'image/png'].includes(message.document.mime_type ?? '')) {
    await telegramCall(token, 'sendMessage', { chat_id: userId, text: botText(config, 'receiptFormat') }); return;
  }
  const receipt = await encrypt({ fileId: file.file_id, document: Boolean(message.document) } satisfies Receipt, env.ENCRYPTION_KEY);
  const order = await env.DB.prepare("UPDATE telegram_orders SET receipt=?,status='awaiting_approval',receipt_notified=0,receipt_version=receipt_version+1,error='' WHERE id=? AND user_id=? AND payment_method='transfer' AND status='awaiting_receipt' AND COALESCE(reviewed_at,created_at)>? RETURNING *").bind(receipt, session.order_id, userId, Date.now() - 86400000).first<Order>();
  if (!order) return;
  await env.DB.prepare('DELETE FROM telegram_receipt_sessions WHERE user_id=? AND order_id=?').bind(userId, order.id).run();
  try { await telegramCall(token, 'sendMessage', { chat_id: userId, text: botText(config, 'received') }); } catch { /* The saved order remains visible through /myconfigs. */ }
  try { await notifyReceipt(env, order); } catch { await env.DB.prepare("UPDATE telegram_orders SET error='Admin notification pending. Make sure the admin has started this bot.' WHERE id=? AND status='awaiting_approval'").bind(order.id).run(); }
}
async function notifyReceipt(env: Env, order: Order) {
  const { config, secrets } = await load(env), receipt = await decrypt<Receipt>(order.receipt, env.ENCRYPTION_KEY), fa = config.language === 'fa';
  if (!config.transfer.adminIds.length || order.status !== 'awaiting_approval') return;
  let notified = false;
  for (const adminId of config.transfer.adminIds) { try { await telegramCall(secrets.token, receipt.document ? 'sendDocument' : 'sendPhoto', {
    chat_id: Number(adminId), [receipt.document ? 'document' : 'photo']: receipt.fileId, protect_content: true,
    caption: `${fa ? 'بررسی کارت به کارت' : 'Review card transfer'}\n${order.product_name} · ${order.id.slice(0, 8)}\n${storeAmount(order.amount, order.currency, config.language)}\nTelegram ID: ${order.user_id}\n${fa ? 'قبل از تأیید، واریز را در حساب بانکی بررسی کنید؛ عکس رسید اثبات پرداخت نیست.' : 'Check the bank transaction before approving. A receipt image is not proof of funds.'}`,
    reply_markup: { inline_keyboard: [[{ text: fa ? 'تأیید و تحویل ✅' : 'Approve & deliver ✅', callback_data: `approve:${order.id}:${order.receipt_version}` }, { text: fa ? 'رد رسید ❌' : 'Reject receipt ❌', callback_data: `reject:${order.id}:${order.receipt_version}` }]] },
  }); notified = true; } catch { /* One blocked admin must not prevent another admin receiving the receipt. */ } }
  if (!notified) throw new HttpError(502, 'Admin receipt notification pending.');
  await env.DB.prepare("UPDATE telegram_orders SET receipt_notified=1,error='' WHERE id=? AND receipt=? AND status='awaiting_approval'").bind(order.id, order.receipt).run();
}
async function reviewTransfer(env: Env, id: string, approve: boolean, reviewer: string, version: number) {
  if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid order.');
  const { config, secrets } = await load(env);
  const order = await env.DB.prepare("UPDATE telegram_orders SET status=?,paid_at=?,reviewed_by=?,reviewed_at=?,error=? WHERE id=? AND payment_method='transfer' AND status='awaiting_approval' AND receipt!='' AND receipt_version=? RETURNING *").bind(approve ? 'paid' : 'awaiting_receipt', approve ? Date.now() : null, reviewer, Date.now(), approve ? '' : 'Receipt rejected. Waiting for a new receipt.', id, version).first<Order>();
  if (!order) return false; // A replayed or concurrent approval cannot provision twice.
  if (approve) await fulfillOrder(env, order.id);
  else await telegramCall(secrets.token, 'sendMessage', { chat_id: order.user_id, text: botText(config, 'rejected'), reply_markup: { inline_keyboard: [[{ text: botText(config, 'resubmit'), callback_data: `receipt:${order.id}` }]] } });
  return true;
}
async function processUpdate(env: Env, update: Update) {
  const { config, secrets } = await load(env), send = (chat: number, text: string, extra: JsonObject = {}) => telegramCall(secrets.token, 'sendMessage', { chat_id: chat, text, ...extra });
  const query = update.pre_checkout_query;
  if (query) {
    const order = await env.DB.prepare('SELECT * FROM telegram_orders WHERE id=?').bind(query.invoice_payload).first<Order>();
    const snapshot = order ? JSON.parse(order.snapshot) as Snapshot : null;
    const current = config.starsEnabled && snapshot && config.products.find(p => p.id === snapshot.product.id && p.enabled && p.price === order!.amount && p.serverId === snapshot.serverId && p.serviceId === snapshot.service.id);
    const livePolicy = snapshot ? await policyFor(env, snapshot.serverId) : null;
    const sameService = snapshot && JSON.stringify(livePolicy?.services.find(s => s.id === snapshot.service.id)) === JSON.stringify(snapshot.service);
    const activeServer = snapshot && await env.DB.prepare('SELECT enabled FROM servers WHERE id=?').bind(snapshot.serverId).first<{ enabled: number }>();
    const hasFormat = snapshot && snapshot.service.formats.some(f => livePolicy?.subscriptions[f]?.enabled !== false);
    const ok = Boolean(config.enabled && current && sameService && hasFormat && activeServer?.enabled && order && order.status === 'pending' && Date.now() - order.created_at < 3600000 && matchesPayment(order, query, query.from.id));
    await telegramCall(secrets.token, 'answerPreCheckoutQuery', { pre_checkout_query_id: query.id, ok, ...(!ok ? { error_message: botText(config, 'expiredInvoice') } : {}) }); return;
  }
  const message = update.message, callback = update.callback_query;
  const chat = message?.chat ?? callback?.message?.chat, userId = message?.from?.id ?? callback?.from.id;
  if (!chat || chat.type !== 'private' || !Number.isSafeInteger(userId) || chat.id !== userId) return;
  const payment = message?.successful_payment;
  if (payment) {
    const order = await env.DB.prepare('SELECT * FROM telegram_orders WHERE id=?').bind(payment.invoice_payload).first<Order>();
    if (!order || !matchesPayment(order, payment, userId!) || typeof payment.telegram_payment_charge_id !== 'string' || !payment.telegram_payment_charge_id || payment.telegram_payment_charge_id.length > 256) throw new HttpError(400, 'Payment does not match its order.');
    if (order.charge_id && order.charge_id !== payment.telegram_payment_charge_id) throw new HttpError(409, 'This order already has another payment.');
    await env.DB.prepare("UPDATE telegram_orders SET status='paid',paid_at=?,charge_id=? WHERE id=? AND status='pending'").bind(Date.now(), payment.telegram_payment_charge_id, order.id).run();
    // Persist payment before delivery; failures are recoverable through Orders and the scheduled queue.
    await fulfillOrder(env, order.id); return;
  }
  const data = callback?.data ?? message?.text?.split(' ')[0] ?? '/start';
  if (callback) await telegramCall(secrets.token, 'answerCallbackQuery', { callback_query_id: callback.id });
  if (data === '/id') { await send(chat.id, `${botText(config, 'idLabel')}: ${userId}`); return; }
  if (data.startsWith('approve:') || data.startsWith('reject:')) {
    if (!config.transfer.adminIds.includes(String(userId))) { await send(chat.id, config.language === 'fa' ? 'فقط مدیر مجاز می‌تواند پرداخت را بررسی کند.' : 'Only an authorized admin can review payments.'); return; }
    const [, orderId, version] = data.split(':'), approved = data.startsWith('approve:');
    const reviewed = await reviewTransfer(env, orderId, approved, String(userId), Number(version));
    await send(chat.id, reviewed ? config.language === 'fa' ? approved ? 'پرداخت تأیید شد ✅ وضعیت تحویل در بخش سفارش‌های پنل قابل مشاهده است.' : 'رسید رد شد و مشتری می‌تواند رسید درست را ارسال کند.' : approved ? 'Payment approved. Check delivery status in panel Orders.' : 'Receipt rejected. The buyer can submit a corrected receipt.' : config.language === 'fa' ? 'این رسید قبلاً بررسی یا جایگزین شده است.' : 'This receipt has already been reviewed or replaced.'); return;
  }
  if (message?.photo || message?.document) { await acceptReceipt(env, userId!, message, config, secrets.token); return; }
  if (data.startsWith('receipt:')) {
    const order = await env.DB.prepare("SELECT * FROM telegram_orders WHERE id=? AND user_id=? AND payment_method='transfer' AND status='awaiting_receipt'").bind(data.slice(8), userId).first<Order>();
    if (!order || Date.now() - (order.reviewed_at || order.created_at) > 86400000) { await send(chat.id, botText(config, 'noReceipt')); return; }
    await env.DB.prepare('INSERT INTO telegram_receipt_sessions(user_id,order_id,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET order_id=excluded.order_id,expires_at=excluded.expires_at').bind(userId, order.id, Date.now() + 3600000).run();
    await send(chat.id, `${botText(config, 'receiptPrompt')}\n${order.id.slice(0, 8)}`); return;
  }
  if (['support', '/support', '/paysupport'].includes(data)) { await send(chat.id, config.support || botText(config, 'noSupport')); return; }
  if (['terms', '/terms'].includes(data)) { await send(chat.id, config.terms || botText(config, 'noTerms')); return; }
  if (['configs', '/myconfigs'].includes(data)) {
    const rows = (await env.DB.prepare("SELECT * FROM telegram_orders WHERE user_id=? AND status IN ('paid','processing','delivery_failed','delivered','awaiting_receipt','awaiting_approval') ORDER BY created_at DESC LIMIT 10").bind(userId).all<Order>()).results;
    if (!rows.length) await send(chat.id, botText(config, 'noPurchases'));
    for (const row of rows) {
      if (row.status === 'delivered') await send(chat.id, await decrypt<string>(row.delivery, env.ENCRYPTION_KEY), { protect_content: true });
      else if (['awaiting_receipt', 'awaiting_approval'].includes(row.status)) await send(chat.id, `${row.product_name} · ${row.id.slice(0, 8)}\n${storeAmount(row.amount, row.currency, config.language)}\n${row.status === 'awaiting_approval' ? botText(config, 'reviewing') : botText(config, 'waitingReceipt')}`, { ...(row.status === 'awaiting_receipt' ? { reply_markup: { inline_keyboard: [[{ text: botText(config, 'sendReceipt'), callback_data: `receipt:${row.id}` }]] } } : {}) });
      else await send(chat.id, `${row.product_name}\n${botText(config, 'pendingDelivery')}\n${config.support}`);
    } return;
  }
  if (!config.enabled) { await send(chat.id, botText(config, 'paused')); return; }
  if (data === 'plans') {
    if (!config.starsEnabled && !config.transfer.enabled) { await send(chat.id, botText(config, 'unavailable')); return; }
    const products = config.products.filter(p => p.enabled); await send(chat.id, botText(config, 'choose'), { reply_markup: { inline_keyboard: chunks(products.map(p => ({ text: `${p.name} · ${productPrices(p, config)}`, callback_data: `product:${p.id}` })), config.buttonColumns) } }); return;
  }
  if (data.startsWith('product:')) {
    const p = config.products.find(p => p.id === data.slice(8) && p.enabled); if (!p) { await send(chat.id, botText(config, 'planGone')); return; }
    await send(chat.id, `${p.name}\n${p.description}${config.starsEnabled ? `\n${storeAmount(p.price, 'XTR', config.language)}` : ''}\n\n${config.terms}`, { reply_markup: { inline_keyboard: [...(config.starsEnabled ? [[{ text: botText(config, 'pay'), callback_data: `buy:${p.id}` }]] : []), ...(config.transfer.enabled ? [[{ text: `${botText(config, 'transferLabel')} · ${storeAmount(p.transferPrice!, config.transfer.currency, config.language)}`, callback_data: `transfer:${p.id}` }]] : []), [{ text: botText(config, 'back'), callback_data: 'plans' }]] } }); return;
  }
  if (data.startsWith('buy:') || data.startsWith('transfer:')) {
    const manual = data.startsWith('transfer:'); if (!manual && !config.starsEnabled) { await send(chat.id, botText(config, 'starsOff')); return; } if (manual && !config.transfer.enabled) { await send(chat.id, botText(config, 'transferOff')); return; }
    const p = config.products.find(p => p.id === data.slice(manual ? 9 : 4) && p.enabled); if (!p) { await send(chat.id, botText(config, 'planGone')); return; }
    const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM telegram_orders WHERE user_id=? AND status IN ('pending','awaiting_receipt','awaiting_approval') AND created_at>?").bind(userId, Date.now() - 3600000).first<{ n: number }>();
    if ((pending?.n || 0) >= 3) { await send(chat.id, botText(config, 'invoiceLimit')); return; }
    const ready = await target(env, p), id = crypto.randomUUID();
    await env.DB.prepare('INSERT OR IGNORE INTO telegram_orders(id,update_key,user_id,product_name,amount,created_at,email,snapshot,status,currency,payment_method) VALUES(?,?,?,?,?,?,?,?,?,?,?)').bind(id, update.update_id, userId, p.name, manual ? p.transferPrice! : p.price, Date.now(), `store-${id}`, JSON.stringify({ terms: config.terms, product: p, service: ready.service, serverId: ready.server.id, ...(manual ? { transfer: config.transfer } : {}) }), manual ? 'awaiting_receipt' : 'pending', manual ? config.transfer.currency : 'XTR', manual ? 'transfer' : 'stars').run();
    const order = await env.DB.prepare('SELECT * FROM telegram_orders WHERE update_key=?').bind(update.update_id).first<Order>();
    if (!order || !['pending', 'awaiting_receipt'].includes(order.status)) return;
    if (manual) {
      const transfer = (JSON.parse(order.snapshot) as Snapshot & { transfer: StoreConfig['transfer'] }).transfer;
      const card = transfer.cardNumber.match(/.{1,4}/g)!.join(' ');
      await send(chat.id, `${p.name} · ${order.id.slice(0, 8)}\n${botText(config, 'amount')}: ${storeAmount(order.amount, order.currency, config.language)}\n${botText(config, 'card')}: \u2066${card}\u2069\n${transfer.cardHolder} · ${transfer.bankName}\n\n${transfer.instructions}\n${botText(config, 'consent')}`, { reply_markup: { inline_keyboard: [[{ text: botText(config, 'sendReceipt'), callback_data: `receipt:${order.id}` }]] } }); return;
    }
    await telegramCall(secrets.token, 'sendInvoice', { chat_id: chat.id, title: p.name, description: p.description, payload: order.id, provider_token: '', currency: 'XTR', prices: [{ label: p.name, amount: p.price }], start_parameter: `order_${order.id.replaceAll('-', '')}` }); return;
  }
  await send(chat.id, config.welcome, { reply_markup: keyboard(config) });
}
export async function fulfillOrder(env: Env, id: string) {
  const now = Date.now(), order = await env.DB.prepare("UPDATE telegram_orders SET status='processing',lease_until=?,error='' WHERE id=? AND (status IN ('paid','delivery_failed') OR status='processing' AND lease_until<?) AND lease_until<? RETURNING *").bind(now + 300000, id, now, now).first<Order>();
  if (!order) return;
  try {
    const { config, secrets, row } = await load(env);
    // Retrying a confirmed config delivery only resends the same private links.
    let delivery = order.delivery ? await decrypt<string>(order.delivery, env.ENCRYPTION_KEY) : '';
    if (!delivery) {
      const snapshot = JSON.parse(order.snapshot) as Snapshot, { server, service, passwordLength } = await target(env, snapshot.product);
      if (JSON.stringify(service) !== JSON.stringify(snapshot.service)) throw new HttpError(409, 'The purchased service changed. Restore its rules or refund this undelivered order.');
      let client: Client;
      if (order.provision) client = await decrypt<Client>(order.provision, env.ENCRYPTION_KEY);
      else {
        const identityUuid = crypto.randomUUID();
        client = { email: order.email, id: identityUuid, uuid: identityUuid, password: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(passwordLength)))), enable: false, expiryTime: 0, tgId: order.user_id, subId: crypto.randomUUID().replaceAll('-', ''), flow: '', security: 'auto', ...serviceClientFields(service, true) };
        await env.DB.prepare('UPDATE telegram_orders SET provision=? WHERE id=?').bind(await encrypt(client, env.ENCRYPTION_KEY), id).run();
      }
      // A deterministic client name plus persisted credentials prevents double provisioning after timeouts.
      const directory = await callRemoteJson(server, env, { path: '/panel/api/clients/list', method: 'GET' }) as unknown[];
      if (!Array.isArray(directory)) throw new HttpError(502, 'The server client directory is unavailable.');
      const existing = directory.map(d => parseObject(parseObject(d).client || d)).find(c => c.email === client.email);
      if (existing && ((existing.uuid || existing.id) !== client.id || existing.subId !== client.subId)) throw new HttpError(409, 'Client identity conflict. Review this order before retrying.');
      if (!existing) await callRemoteJson(server, env, { path: '/panel/api/clients/add', method: 'POST', body: { client, inboundIds: service.inbounds.map(i => i.inboundId) } });
      let synced = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const policy = await policyFor(env, server.id);
        try {
          const rule = { serviceId: service.id, multiplier: 1, overrides: Object.fromEntries(service.inbounds.map(i => [i.inboundId, i.multiplier])) };
          const managed = await managedRow(env, server.id);
          if (!managed || JSON.stringify(policy.clients[client.email]) !== JSON.stringify(rule)) {
            const result = await policyRoute(new Request('https://benx.local/policy', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...policy, clients: { ...policy.clients, [client.email]: rule } }) }), env, server);
            const value = await result.json() as { syncError: string }; if (value.syncError && !managed) throw new HttpError(502, 'Server has not confirmed the service rules.');
          }
          if (managed) { await reconcileServer(env, server, undefined, true); const applied = await managedRow(env, server.id); if (applied?.phase !== 'synced' || applied.applied_revision !== applied.revision) throw new HttpError(502, 'Saved service rules are waiting for server confirmation. Delivery will retry.'); }
          synced = true; break;
        } catch (e) { if (!(e instanceof HttpError) || e.status !== 409 || attempt === 2) throw e; }
      }
      if (!synced) throw new HttpError(409, 'Service rules could not be saved.');
      await callRemoteJson(server, env, { path: `/panel/api/clients/update/${encodeURIComponent(client.email)}`, method: 'POST', body: { ...client, enable: true } });
      const token = await issueStoreSubscription(env, server, client.email, client.subId!);
      const policy = await policyFor(env, server.id);
      const root = policy.subscriptionOrigin || new URL(row.webhook).origin, links: string[] = [];
      for (const format of service.formats.filter(f => policy.subscriptions[f]?.enabled !== false)) {
        const url = `${root}/sub/${token}/${format}`;
        // Confirm this format can actually be rendered before offering it to the buyer.
        try { await publicSubscription(new Request(url), env); links.push(`${formatNames[format]}:\n${url}`); } catch { /* Unrepresentable transports are omitted, never advertised as working. */ }
      }
      if (!links.length) { await callRemoteJson(server, env, { path: `/panel/api/clients/update/${encodeURIComponent(client.email)}`, method: 'POST', body: { ...client, enable: false } }); throw new HttpError(409, 'No subscription format can render this service.'); }
      links.unshift(botText(config, 'page') + ':\n' + root + '/sub/' + token + '/page');
      delivery = `${config.thankYou}\n\n${order.product_name}\n${service.rules.quotaGB || '∞'} ${config.language === 'fa' ? 'گیگابایت' : 'GB'} · ${service.rules.expiryDays || '∞'} ${config.language === 'fa' ? 'روز' : 'days'}\n\n${links.join('\n\n')}`;
      await env.DB.prepare('UPDATE telegram_orders SET delivery=? WHERE id=?').bind(await encrypt(delivery, env.ENCRYPTION_KEY), id).run();
    }
    await telegramCall(secrets.token, 'sendMessage', { chat_id: order.user_id, text: delivery, protect_content: true });
    await env.DB.prepare("UPDATE telegram_orders SET status='delivered',lease_until=0,error='' WHERE id=?").bind(id).run();
  } catch (e) {
    await env.DB.prepare("UPDATE telegram_orders SET status='delivery_failed',lease_until=0,error=? WHERE id=?").bind(e instanceof HttpError ? e.message : 'Delivery failed. Check the server and retry.', id).run();
    // A paid order stays durable even when the remote server or Telegram is unavailable.
  }
}
async function consumeUpdate(env: Env, id: number) {
  const row = await env.DB.prepare("UPDATE telegram_updates SET status='processing',lease_until=? WHERE id=? AND status!='done' AND lease_until<? RETURNING payload,created_at").bind(Date.now() + 120000, id, Date.now()).first<{ payload: string; created_at: number }>();
  if (!row) return;
  try {
    const update = await decrypt<Update>(row.payload, env.ENCRYPTION_KEY);
    // Old chat actions and expired pre-checkout questions must not resurrect new invoices.
    if (update.message?.successful_payment || !update.pre_checkout_query && Date.now() - row.created_at < 3600000 || update.pre_checkout_query && Date.now() - row.created_at < 9000) await processUpdate(env, update);
    await env.DB.prepare("UPDATE telegram_updates SET status='done',lease_until=0 WHERE id=?").bind(id).run();
  } catch (e) {
    if (e instanceof HttpError && [400, 403, 404, 409].includes(e.status)) { await env.DB.prepare("UPDATE telegram_updates SET status='done',lease_until=0 WHERE id=?").bind(id).run(); return; }
    await env.DB.prepare("UPDATE telegram_updates SET status='pending',lease_until=0 WHERE id=?").bind(id).run(); throw e;
  }
}
export async function telegramWebhook(request: Request, env: Env, ctx: ExecutionContext) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const { secrets, row } = await load(env);
  if (!row.connected || !await equalSecret(request.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', secrets.hook)) throw new HttpError(403, 'Invalid webhook signature.');
  const update = await readJson<Update>(request);
  if (!update || !Number.isSafeInteger(update.update_id) || update.update_id < 0) throw new HttpError(400, 'Invalid Telegram update.');
  await env.DB.prepare('INSERT OR IGNORE INTO telegram_updates(id,payload,created_at) VALUES(?,?,?)').bind(update.update_id, await encrypt(update, env.ENCRYPTION_KEY), Date.now()).run();
  if (update.pre_checkout_query) await consumeUpdate(env, update.update_id);
  else ctx.waitUntil(consumeUpdate(env, update.update_id).catch(() => { /* The scheduled queue retries durable updates. */ }));
  return output({ ok: true });
}
export async function retryStoreQueue(env: Env) {
  const row = await saved(env); if (!row?.connected) return;
  const updates = (await env.DB.prepare("SELECT id FROM telegram_updates WHERE status!='done' AND lease_until<? ORDER BY created_at LIMIT 3").bind(Date.now()).all<{ id: number }>()).results;
  for (const update of updates) { try { await consumeUpdate(env, update.id); } catch { /* Leave queued for the next scheduled run. */ } }
  const receipts = (await env.DB.prepare("SELECT * FROM telegram_orders WHERE status='awaiting_approval' AND receipt_notified=0 ORDER BY created_at LIMIT 2").all<Order>()).results;
  for (const receipt of receipts) { try { await notifyReceipt(env, receipt); } catch { /* Retry notifications on the next scheduled run. */ } }
  const orders = (await env.DB.prepare("SELECT id FROM telegram_orders WHERE status IN ('paid','delivery_failed','processing') AND lease_until<? ORDER BY created_at LIMIT 2").bind(Date.now()).all<{ id: string }>()).results;
  for (const order of orders) await fulfillOrder(env, order.id);
  await env.DB.prepare('DELETE FROM telegram_receipt_sessions WHERE expires_at<?').bind(Date.now()).run();
  await env.DB.batch([env.DB.prepare("DELETE FROM telegram_updates WHERE status='done' AND created_at<?").bind(Date.now() - 7 * 86400000), env.DB.prepare("UPDATE telegram_orders SET status='expired' WHERE status IN ('pending','awaiting_receipt') AND COALESCE(reviewed_at,created_at)<?").bind(Date.now() - 86400000)]);
}
