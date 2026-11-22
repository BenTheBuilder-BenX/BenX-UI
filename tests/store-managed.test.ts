import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { createManaged, managedRow, saveManaged, savedDocument } from '../worker/control';
import { publicSubscription } from '../worker/subscriptions';
import { fulfillOrder, retryStoreQueue, storeAdmin } from '../worker/store';
import { emptyDocument, type ManagedDocument } from '../shared/managed';
import { newStore } from '../shared/store';
import { parseObject, type Client, type JsonObject } from '../shared/types';
import { decrypt, encrypt } from '../worker/security';

const key = btoa('k'.repeat(32)), orderId = '11111111-1111-4111-8111-111111111111', email = `store-${orderId}`;
let db: DatabaseSync, env: Env, live: ManagedDocument, liveRevision: number, unavailable: boolean, loseApplyResponse: boolean, blockDelivery: boolean, incompleteDNS: boolean;
let applications: Array<{ revision: number; document: ManagedDocument }>, telegram: Array<{ method: string; body: JsonObject }>;
const remote = vi.mocked(callRemoteJson);
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { const results = []; for (const statement of statements) results.push(await statement.run()); return results; } } as unknown as D1Database;
}
async function document() { return savedDocument(env, (await managedRow(env, 's'))!); }
function order() { return db.prepare('SELECT * FROM telegram_orders WHERE id=?').get(orderId) as { status: string; error: string; provision: string; delivery: string }; }
async function settleOrder() { for (let n = 0; n < 8 && order().status !== 'delivered'; n++) await retryStoreQueue(env); }
const refund = () => storeAdmin(new Request(`https://benx.example.com/api/store/orders/${orderId}/refund`, { method: 'POST' }), env);
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  db.exec("UPDATE operation_settings SET mode='automatic'");
  env = { DB: database(db), ENCRYPTION_KEY: key } as Env;
  db.prepare("INSERT INTO servers(id,name,url,version,kind,auth,credentials,created_at) VALUES('s','Managed store server','ssh://1.1.1.1:22/','v3','server','token','encrypted',0)").run();
  const d = emptyDocument(); d.state.nextId = 2;
  d.state.inbounds = [{ id: 1, protocol: 'vless', port: 443, enable: true, expiryTime: 0, listen: '', settings: { publicHost: 'vpn.example.com', decryption: 'none' }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'vpn.example.com', certificates: [{ certificateFile: '/cert.pem', keyFile: '/key.pem' }] } }, sniffing: {} }];
  d.policy.services = [{ id: 'pro', name: 'Pro', description: '', enabled: true, inbounds: [{ inboundId: 1, multiplier: 1 }], rules: { quotaGB: 100, expiryDays: 30, ipLimit: 0, hwidLimit: 0 }, formats: ['v2ray', 'singbox', 'clash'] }];
  await createManaged(env, 's', d);
  live = structuredClone(d); liveRevision = 1; unavailable = false; loseApplyResponse = false; blockDelivery = false; incompleteDNS = false; applications = []; telegram = [];
  const config = newStore(); config.enabled = true; config.support = '@support'; config.terms = 'Test purchase terms.';
  const product = { id: 'pro', name: 'Pro', description: '100 GB', price: 100, enabled: true, serverId: 's', serviceId: 'pro' }; config.products = [product];
  db.prepare("INSERT INTO telegram_store(id,revision,config,secrets,username,webhook,connected) VALUES(1,0,?,?,'test_bot','https://benx.example.com/telegram/webhook',1)").run(JSON.stringify(config), await encrypt({ token: '123456789:' + 'a'.repeat(32), hook: 'h'.repeat(32) }, key));
  db.prepare("INSERT INTO telegram_orders(id,update_key,user_id,product_name,amount,status,created_at,paid_at,email,snapshot,charge_id) VALUES(?,1,123,'Pro',100,'paid',?,?,?,?,'confirmed-charge')").run(orderId, Date.now(), Date.now(), email, JSON.stringify({ product, service: d.policy.services[0], serverId: 's' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => { const method = url.split('/').at(-1)!; telegram.push({ method, body: JSON.parse(String(init.body)) }); return Response.json({ ok: !(blockDelivery && method === 'sendMessage'), result: true }); }));
  remote.mockReset(); remote.mockImplementation(async (_server, _env, request) => {
    if (request.path === '/benx/v1/capabilities') return { features: ['weighted-accounting', 'desired-state'] };
    if (request.path === '/benx/v1/control/status') { if (unavailable) throw new Error('VPS offline'); return { serverId: 's', revision: liveRevision, drift: false, job: { state: 'succeeded' } }; }
    if (request.path === '/benx/v1/control/export') return structuredClone(live);
    if (request.path === '/benx/v1/control/apply') {
      live = structuredClone(request.body!.document as ManagedDocument); liveRevision = Number(request.body!.revision); applications.push({ revision: liveRevision, document: structuredClone(live) });
      if (loseApplyResponse) { loseApplyResponse = false; throw new Error('Response lost after agent accepted configuration'); }
      return { state: 'queued' };
    }
    if (request.path.includes('/clients/links/')) {
      const id = live.state.clients[email]?.id;
      if (!parseObject(live.state.inbounds[0].settings).meteredInboundId && live.state.inbounds[0].protocol === 'masterdnsvpn') {
        return ['masterdns://' + btoa(JSON.stringify({ domain: 'dns.example.com', key: 'shared-key', protocol: 'SOCKS5' })), JSON.stringify({ DOMAINS: ['dns.example.com'], PROTOCOL_TYPE: 'SOCKS5', ENCRYPTION_KEY: 'shared-key' })];
      }
      if (incompleteDNS) return ['vless://wrong-id@127.0.0.1:18000#MasterDNSVPN-metered'];
      return [`vless://${id}@127.0.0.1:18000?encryption=none&security=none&type=tcp#MasterDNSVPN-metered`, 'vless://wrong-id@127.0.0.1:18000#MasterDNSVPN-metered', JSON.stringify({ DOMAINS: ['dns.example.com'], PROTOCOL_TYPE: 'TCP', ENCRYPTION_KEY: 'fixture-key', LISTEN_PORT: 18000 })];
    }
    if (request.path.includes('/clients/get/')) return { ...structuredClone(live.state.clients[decodeURIComponent(request.path.split('/').at(-1)!)]), up: 0, down: 0 };
    if (request.path.endsWith('/inbounds/list')) return live.state.inbounds.map(i => ({ ...i, settings: { ...parseObject(i.settings), clients: Object.values(live.state.clients).filter(c => (c.inboundIds as number[]).includes(Number(i.id))) } }));
    throw new Error(`Unexpected bypass operation: ${request.path}`);
  });
});
afterEach(() => { db.close(); vi.unstubAllGlobals(); remote.mockReset(); });

describe('Managed Telegram provisioning and recovery', () => {
  async function dnsOffer(metered: boolean) {
    const doc = await document();
    const backend = { ...doc.state.inbounds[0], id: 2, port: 14443, listen: '127.0.0.1', excludeFromSub: true, settings: { decryption: 'none' }, streamSettings: { network: 'tcp', security: 'none' } };
    doc.state.nextId = 3;
    doc.state.inbounds = [{ id: 1, port: 53, enable: true, protocol: 'masterdnsvpn', remark: 'DNS plan', settings: { DOMAIN: ['dns.example.com'], ...(metered ? { meteredInboundId: 2 } : {}) } }, backend];
    doc.policy.subscriptionOrigin = 'https://subs.example.com';
    await saveManaged(env, (await managedRow(env, 's'))!, doc);
  }
  it('delivers the metered DNS customer page and compatible feeds with a private, per-buyer VLESS link', async () => {
    await dnsOffer(true); await settleOrder();
    expect(order()).toMatchObject({ status: 'delivered', error: '' });
    expect(live.state.clients[email].inboundIds).toEqual([1, 2]);
    const text = String(telegram.at(-1)?.body.text), pageUrl = text.match(/https:\/\/subs\.example\.com\/sub\/[a-f0-9]{64}\/page/)?.[0];
    expect(pageUrl).toBeTruthy();
    const url = pageUrl!.slice(0, -5);
    expect(atob(await (await publicSubscription(new Request(url), env)).text())).toContain('127.0.0.1:18000');
    const feed = await publicSubscription(new Request(url + '/v2ray'), env);
    expect(atob(await feed.text())).toContain('vless://' + live.state.clients[email].id + '@127.0.0.1:18000');
    expect(atob(await (await publicSubscription(new Request(url + '/v2ray'), env)).text())).not.toContain('wrong-id');
    const page = await (await publicSubscription(new Request(pageUrl!), env)).text();
    expect(page).toContain('client_resolvers.txt'); expect(page).toContain('18000'); expect(page).toContain('TCP');
    expect(await (await publicSubscription(new Request(url + '/download?inbound=1'), env)).text()).toContain('fixture-key');
    incompleteDNS = true;
    await expect(publicSubscription(new Request(url + '/v2ray'), env)).rejects.toMatchObject({ status: 409 });
    live.state.clients[email].enable = false;
    await expect(publicSubscription(new Request(url + '/download?inbound=1'), env)).rejects.toMatchObject({ status: 403 });
  });
  it('delivers a standalone DNS plan only as unlimited and warns the customer in both languages', async () => {
    await dnsOffer(false);
    const next = await document(), plan = next.policy.services[0];
    plan.rules.quotaGB = 0; plan.rules.expiryDays = 0; plan.formats = ['v2box', 'v2ray'];
    await saveManaged(env, (await managedRow(env, 's'))!, next);
    const snapshot = JSON.parse((db.prepare('SELECT snapshot FROM telegram_orders WHERE id=?').get(orderId) as {snapshot: string}).snapshot);
    db.prepare('UPDATE telegram_orders SET snapshot=? WHERE id=?').run(JSON.stringify({...snapshot, service: plan}), orderId);
    await settleOrder(); expect(order().status).toBe('delivered');
    const delivery = String(telegram.at(-1)?.body.text), url = delivery.match(/https:\/\/subs\.example\.com\/sub\/[a-f0-9]{64}/)![0];
    expect(delivery).toContain('/v2box'); expect(delivery).not.toContain('/v2ray');
    expect(atob(await (await publicSubscription(new Request(url), env)).text())).toContain('masterdns://');
    expect(await (await publicSubscription(new Request(url + '/page?lang=en'), env)).text()).toContain('unmetered and can be unlimited');
    expect(await (await publicSubscription(new Request(url + '/page?lang=fa'), env)).text()).toContain('می‌تواند نامحدود باشد');
  });
  it('rejects a capped standalone shared-key DNS plan before creating a paid client', async () => {
    await dnsOffer(false); await fulfillOrder(env, orderId);
    expect(order().error).toMatch(/unmetered/i); expect(order().provision).toBe(''); expect(live.state.clients[email]).toBeUndefined();
  });
  it('retains encrypted client intent while the VPS is offline and delivers the same identity after confirmation', async () => {
    unavailable = true; await fulfillOrder(env, orderId);
    expect(order().status).toBe('delivery_failed'); expect(order().delivery).toBe('');
    const provision = await decrypt<Client>(order().provision, key), pending = await document();
    expect(pending.state.clients[email]).toMatchObject({ id: provision.id, uuid: provision.uuid, password: provision.password, subId: provision.subId, enable: false, inboundIds: [1] });
    expect(order().provision).not.toContain(String(provision.password));
    unavailable = false; await settleOrder();
    expect(order().status).toBe('delivered'); expect(Object.keys((await document()).state.clients)).toEqual([email]);
    expect((await document()).state.clients[email]).toMatchObject({ id: provision.id, uuid: provision.uuid, password: provision.password, subId: provision.subId, enable: true });
    expect(await managedRow(env, 's')).toMatchObject({ phase: 'synced' });
    expect(applications[0].document.state.clients[email].enable).toBe(false);
    expect(applications[0].document.policy.clients[email].serviceId).toBe('pro');
    expect(applications.at(-1)?.document.state.clients[email].enable).toBe(true);
    expect(remote.mock.calls.some(c => /\/clients\/(add|update\/)/.test(c[2].path))).toBe(false);
    expect(telegram.at(-1)?.body.text).toContain('/v2ray'); expect(telegram.at(-1)?.body.protect_content).toBe(true);
  });
  it('recovers an ambiguous accepted agent apply without generating another client or subscription identity', async () => {
    loseApplyResponse = true; await fulfillOrder(env, orderId);
    expect(order().status).toBe('delivery_failed'); expect(Object.keys(live.state.clients)).toEqual([email]);
    const original = structuredClone(live.state.clients[email]); await settleOrder();
    expect(order().status).toBe('delivered');
    for (const application of applications) expect(application.document.state.clients[email]).toMatchObject({ id: original.id, password: original.password, subId: original.subId });
    expect((await document()).state.clients[email].id).toBe(original.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()).toEqual({ n: 1 });
  });
  it('resends an already prepared delivery without reapplying settings or rotating its share URL', async () => {
    blockDelivery = true; await settleOrder();
    expect(order().status).toBe('delivery_failed'); expect(order().delivery).not.toBe('');
    const delivery = order().delivery, identity = (await document()).state.clients[email], revisions = applications.length;
    const subscription = db.prepare('SELECT token_hash,secret FROM subscriptions').get(); remote.mockClear(); blockDelivery = false;
    await fulfillOrder(env, orderId);
    expect(order().status).toBe('delivered'); expect(order().delivery).toBe(delivery); expect(applications).toHaveLength(revisions);
    expect(remote).not.toHaveBeenCalled(); expect((await document()).state.clients[email]).toEqual(identity);
    expect(db.prepare('SELECT token_hash,secret FROM subscriptions').get()).toEqual(subscription);
  });
  it('stops delivery when the deterministic client name belongs to a different saved identity', async () => {
    unavailable = true; await fulfillOrder(env, orderId); const original = await decrypt<Client>(order().provision, key);
    const d = await document(); d.state.clients[email].id = '22222222-2222-4222-8222-222222222222'; d.state.clients[email].uuid = d.state.clients[email].id;
    await saveManaged(env, (await managedRow(env, 's'))!, d); unavailable = false; remote.mockClear();
    await fulfillOrder(env, orderId);
    expect(order().status).toBe('delivery_failed'); expect(order().error).toContain('identity conflict');
    expect((await document()).state.clients[email].id).not.toBe(original.id);
    expect(remote.mock.calls.every(c => c[2].method === 'GET')).toBe(true); expect(order().delivery).toBe('');
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()).toEqual({ n: 0 });
  });
  it('persists disabled access before refunding and waits for the server to confirm that revision', async () => {
    blockDelivery = true; await settleOrder(); expect(order().status).toBe('delivery_failed');
    const original = (await document()).state.clients[email];
    await expect(refund()).rejects.toThrow('server has not confirmed');
    expect(order().status).toBe('refund_pending'); expect((await document()).state.clients[email].enable).toBe(false);
    expect(telegram.some(t => t.method === 'refundStarPayment')).toBe(false);
    blockDelivery = false; await refund();
    expect(order().status).toBe('refunded'); expect(live.state.clients[email]).toMatchObject({ id: original.id, password: original.password, subId: original.subId, enable: false });
    expect(db.prepare('SELECT COUNT(*) AS n FROM subscriptions').get()).toEqual({ n: 0 });
    expect(telegram.filter(t => t.method === 'refundStarPayment')).toHaveLength(1);
  });
});
