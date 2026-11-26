import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/control', async original => ({ ...await original<typeof import('../worker/control')>(), reconcileServer: vi.fn(async () => true) }));
vi.mock('../worker/remote', async original => ({ ...await original<typeof import('../worker/remote')>(), callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { createManaged, managedRow, savedDocument } from '../worker/control';
import { labRoute, publicLab, generateLab } from '../worker/lab';
import { emptyDocument, configurationView } from '../shared/managed';
import { defaultLabSpec, previewLab, type LabSpec } from '../shared/lab';
import { customSubscriptionStarter, defaultPageDesign, validatePageDesign } from '../shared/subscription-page';
import { pageDesignRoute, subscriptionLanding } from '../worker/subscription-page';
import { subscriptionSettings } from '../worker/subscription-settings';
import { originalThemeNames } from '../shared/original-subscription-page';
import { publicSubscription, issueStoreSubscription, subscriptionAdmin } from '../worker/subscriptions';
import { encrypt, decrypt } from '../worker/security';
import { currentAIModel } from '../shared/assistant';
import { parseObject } from '../shared/types';
import { shareLink } from '../src/lib/links';
import { parseProxy, xrayOutbound, subscription } from '../shared/subscriptions';
import type { Inbound, Client } from '../shared/types';
import { teamFixture } from './team-fixture';
let f: ReturnType<typeof teamFixture>;
const spec = (): LabSpec => ({ ...structuredClone(defaultLabSpec), serverId: 's', host: 'vpn.example.com', snis: ['www.microsoft.com', 'www.cloudflare.com'], budget: 20 });
const request = (path: string, method = 'GET', b?: unknown) => labRoute(new Request('https://benx.example/api/lab' + path, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }), f.env, f.ctx);
beforeEach(async () => { f = teamFixture(); f.db.prepare("INSERT INTO servers(id,name,url,kind,auth,credentials,created_at) VALUES('s','Fixture','https://fixture.invalid/','server','token','synthetic-secret',0)").run(); await createManaged(f.env, 's', emptyDocument()); vi.mocked(callRemoteJson).mockReset(); });
afterEach(async () => { await Promise.allSettled(f.waits); f.db.close(); });
describe('Config testing matrix', () => {
  it('excludes TLS 1.2 Android fingerprints from REALITY while preserving ordinary TLS', () => {
    const result = previewLab({ ...spec(), protocols: ['vless'], transports: ['tcp'], fingerprints: ['android', 'chrome'], tls: true, certificateFile: '/cert.pem', keyFile: '/key.pem', tlsSni: 'vpn.example.com' });
    expect(result.variants.some(v => v.security === 'tls' && v.fingerprint === 'android')).toBe(true);
    expect(result.variants.some(v => v.security === 'reality' && v.fingerprint === 'android')).toBe(false);
    expect(result.variants.some(v => v.security === 'reality' && v.fingerprint === 'chrome')).toBe(true);
    expect(result.warnings.join(' ')).toContain('excluded from REALITY');
  });
  it('does not advertise HTTP/2 on an HTTP/1 CONNECT proxy', async () => {
    const result = await generateLab(emptyDocument(), { ...spec(), protocols: ['http'], transports: ['tcp'], plain: false, tls: true, reality: false, tlsSni: 'vpn.example.com', certificateFile: '/private/fullchain.pem', keyFile: '/private/key.pem', budget: 1 }, crypto.randomUUID());
    expect(parseObject(parseObject(result.document.state.inbounds[0].streamSettings).tlsSettings).alpn).toEqual(['http/1.1']);
  });
  it('generates current mKCP settings without removed header and seed options', async () => {
    const result = await generateLab(emptyDocument(), { ...spec(), protocols: ['vmess'], transports: ['kcp'], plain: true, tls: false, reality: false, budget: 1 }, crypto.randomUUID());
    const stream = parseObject(result.document.state.inbounds[0].streamSettings);
    expect(stream.network).toBe('kcp');
    expect(parseObject(stream.kcpSettings)).not.toHaveProperty('header');
    expect(parseObject(stream.kcpSettings)).not.toHaveProperty('seed');
  });
  it('uses authenticated TCP-only HTTP/SOCKS credentials that match the agent and converters', async () => {
    const result = await generateLab(emptyDocument(), { ...spec(), protocols: ['http', 'socks'], reality: false, budget: 10 }, crypto.randomUUID());
    expect(result.variants).toHaveLength(2);
    expect(result.variants.every(v => v.network === 'tcp')).toBe(true);
    expect(result.preview.warnings.join(' ')).toContain('quotas are unavailable');
    for (const variant of result.variants) {
      const inbound = result.document.state.inbounds.find(i => i.id === variant.inboundId)!;
      const client = result.document.state.clients[variant.email];
      expect(client.totalGB).toBe(0); expect(client.expiryTime).toBeGreaterThan(Date.now());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(variant.email))), n => n.toString(16).padStart(2, '0')).join('');
      expect(client.proxyUsername).toBe('benx_' + hash.slice(0, 20));
      expect(parseObject(inbound.settings)).toMatchObject({ auth: 'password', udp: false });
      const link = shareLink(inbound as unknown as Inbound, client as Client, 'vpn.example.com'), parsed = parseProxy(link);
      expect(parsed).toMatchObject({ username: client.proxyUsername, password: client.password, type: variant.protocol });
      const outbound = xrayOutbound(parsed, 'test');
      expect(parseObject(outbound.settings)).toEqual({ servers: [{ address: 'vpn.example.com', port: inbound.port, users: [{ user: client.proxyUsername, pass: client.password }] }] });
      const sing = JSON.parse(subscription([link], 'singbox').body).outbounds[1]; expect(sing.username).toBe(client.proxyUsername); expect(sing).not.toHaveProperty('tls');
      const clash = JSON.parse(subscription([link], 'clash').body).proxies[0]; expect(clash.type).toBe(variant.protocol === 'socks' ? 'socks5' : 'http'); expect(clash).not.toHaveProperty('tls');
      expect(subscription([link], 'v2ray').count).toBe(1);
    }
    expect(() => subscription(['socks://user:pass@vpn.example.com:1080?security=tls'], 'singbox')).toThrow('do not support TLS');
    expect(() => parseProxy('socks://vpn.example.com:1080')).toThrow('username/password');
    expect(() => previewLab({ ...spec(), fingerprints: ['chromee'] })).toThrow('uTLS');
    expect(() => previewLab({ ...spec(), modes: ['typo'] })).toThrow('XHTTP');
    expect(() => previewLab({ ...spec(), padding: ['99-11'] })).toThrow('padding');
  });
  it('requires SNI targets, caps the matrix and samples different method families first', () => {
    expect(() => previewLab({ ...spec(), snis: [] })).toThrow('SNI');
    const p = previewLab(spec()); expect(p.variants).toHaveLength(20); expect(new Set(p.variants.map(v => v.protocol))).toEqual(new Set(['vless', 'vmess', 'shadowsocks'])); expect(p.truncated).toBe(true);
    expect(p.variants.some(v => v.protocol === 'vless' && v.security === 'none')).toBe(false); expect(p.variants.filter(v => v.security === 'reality').every(v => ['tcp', 'grpc', 'xhttp'].includes(v.network))).toBe(true);
    expect(() => previewLab({ ...spec(), budget: 1001 })).toThrow('1000');
  });
  it('rejects a combinatorial explosion before looping through it', () => { expect(() => previewLab({ ...spec(), snis: Array.from({ length: 100 }, (_, n) => `x${n}.example.com`), fingerprints: ['chrome', 'firefox', 'safari', 'ios', 'android', 'edge'], modes: ['auto', 'packet-up'], paths: Array.from({ length: 100 }, (_, n) => '/path' + n) })).toThrow('10,000'); });
  it('generates unique listeners and secure credentials while preserving an existing customer', async () => {
    const d = emptyDocument(); d.state.inbounds = [{ id: 1, port: 20000, protocol: 'vless', enable: true, settings: {}, streamSettings: {}, sniffing: {} }]; d.state.nextId = 2; d.state.clients.existing = { email: 'existing', subId: 'existing-identity', inboundIds: [1] };
    const result = await generateLab(d, spec(), '12345678-1234-1234-1234-123456789abc'); expect(result.document.state.clients.existing).toEqual(d.state.clients.existing); expect(result.document.state.inbounds).toHaveLength(21); expect(new Set(result.document.state.inbounds.map(i => i.port)).size).toBe(21);
    const reality = result.document.state.inbounds.find(i => parseObject(i.streamSettings).security === 'reality')!, keys = parseObject(parseObject(reality.streamSettings).realitySettings); expect(String(keys.privateKey)).toHaveLength(43); expect(String(keys.publicKey)).toHaveLength(43);
    expect(new Set(Object.values(result.document.state.clients).filter(c => c.email !== 'existing').map(c => c.id)).size).toBe(20); expect(result.variants[0].fingerprint).toBe('chrome'); expect(result.variants[0].resourceHash).toHaveLength(64);
  });
  it('uses correctly sized SS2022 server/client keys and applies XHTTP sampling', async () => {
    const b = { ...spec(), protocols: ['shadowsocks'], transports: ['tcp'], reality: false, ciphers: ['2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm'] };
    const r = await generateLab(emptyDocument(), b, crypto.randomUUID()); const first = r.document.state.inbounds[0]; expect(atob(String(parseObject(first.settings).password))).toHaveLength(16); expect(atob(String(Object.values(r.document.state.clients)[0].password))).toHaveLength(16);
    const x = await generateLab(emptyDocument(), { ...spec(), protocols: ['vless'], transports: ['xhttp'], budget: 1 }, crypto.randomUUID()); expect(parseObject(parseObject(x.document.state.inbounds[0].streamSettings).xhttpSettings)).toMatchObject({ mode: 'auto', extra: { xPaddingBytes: '100-1000' } });
  });
  it('persists an encrypted experiment, waits for deployment and revokes it at cleanup', async () => {
    const result = await (await request('', 'POST', { ...spec(), budget: 3 })).json() as { id: string; url: string; state: string }; expect(result.url).toBe(''); expect(result.state).toBe('pending');
    const encrypted = f.db.prepare('SELECT data FROM lab_experiments').get()!.data as string; expect(encrypted).not.toContain('www.microsoft.com');
    const data = await decrypt<{ token: string }>(encrypted, f.env.ENCRYPTION_KEY), url = `https://benx.example/lab/${result.id}/${data.token}/v2ray`; await expect(publicLab(new Request(url), f.env)).rejects.toMatchObject({ status: 409 });
    f.db.prepare("UPDATE managed_state SET applied_revision=revision,phase='synced'").run(); const d = await savedDocument(f.env, (await managedRow(f.env, 's'))!); vi.mocked(callRemoteJson).mockResolvedValue(configurationView(d, { path: '/panel/api/inbounds/list', method: 'GET' }));
    const subscription = await publicLab(new Request(url), f.env); expect(subscription.status).toBe(200); expect(atob(await subscription.text()).split('\n')).toHaveLength(3);
    f.db.prepare("UPDATE managed_state SET error='Previous configuration failed'").run();
    await request('/' + result.id, 'DELETE'); expect((await managedRow(f.env, 's'))!.error).toBe(''); expect((await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.inbounds).toHaveLength(0); await expect(publicLab(new Request(url), f.env)).rejects.toMatchObject({ status: 404 });
  });
  it('refuses cleanup when a generated inbound was reused by another customer', async () => {
    const result = await (await request('', 'POST', { ...spec(), budget: 1 })).json() as { id: string };
    const row = (await managedRow(f.env, 's'))!, d = await savedDocument(f.env, row); d.state.clients.production = { email: 'production', subId: 'production', inboundIds: [1] }; f.db.prepare('UPDATE managed_state SET document=?').run(await encrypt(d, f.env.ENCRYPTION_KEY));
    await expect(request('/' + result.id, 'DELETE')).rejects.toMatchObject({ status: 409 }); expect((await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.clients.production).toBeTruthy();
  });
  it('links tester results to the experiment manifest and rejects unrelated measurements', async () => {
    const result = await (await request('', 'POST', { ...spec(), budget: 1 })).json() as { id: string; manifest: Array<{ key: string }> };
    await expect(request('/' + result.id + '/report', 'PUT', { measuredAt: new Date().toISOString(), results: [{ key: 'another-run', reachable: true }] })).rejects.toMatchObject({ status: 400 });
    const r = await (await request('/' + result.id + '/report', 'PUT', { measuredAt: new Date().toISOString(), results: [{ key: result.manifest[0].key, reachable: true, downloadMbps: 15, latencyMs: 200, lossPercent: 0 }] })).json() as { report: { source: string } }; expect(r.report.source).toContain('Imported');
  });
  it('rejects duplicate measurements and impossible packet loss', async () => {
    const run = await (await request('', 'POST', { ...spec(), budget: 1 })).json() as { id: string; manifest: Array<{ key: string }> };
    const result = { key: run.manifest[0].key, reachable: true };
    for (const results of [[result, result], [{ ...result, lossPercent: 101 }]]) await expect(request('/' + run.id + '/report', 'PUT', { measuredAt: new Date().toISOString(), results })).rejects.toMatchObject({ status: 400 });
  });
  it('does not advertise a modified experiment as ready', async () => {
    const run = await (await request('', 'POST', { ...spec(), budget: 1 })).json() as { id: string };
    const d = await savedDocument(f.env, (await managedRow(f.env, 's'))!); d.state.inbounds[0].port = 25000;
    f.db.prepare("UPDATE managed_state SET document=?,applied_revision=revision,phase='synced'").run(await encrypt(d, f.env.ENCRYPTION_KEY));
    expect(await (await request('/' + run.id)).json()).toMatchObject({ state: 'changed', url: '' });
  });
  it('rejects public plain VLESS recipes and deduplicates matrix lists', () => {
    expect(() => previewLab({ ...spec(), mode: 'recipes', recipes: JSON.stringify([{ protocol: 'vless', settings: {}, streamSettings: { network: 'tcp' } }]) })).toThrow('recipe');
    expect(previewLab({ ...spec(), protocols: ['vless', 'vless'], transports: ['tcp'], snis: ['www.example.com', 'www.example.com'] }).possible).toBe(2);
  });
  it('handles large encrypted profile data without exceeding argument limits', async () => { const data = { sample: 'x'.repeat(600000) }; expect(await decrypt(await encrypt(data, f.env.ENCRYPTION_KEY), f.env.ENCRYPTION_KEY)).toEqual(data); });
});
describe('Designed customer subscription pages', () => {
  it('returns the same usable link to simultaneous share requests, including after an identity change', async () => {
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    let subId = 'first-identity';
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, req) => req.path.includes('/inbounds/') ? [] : { email: 'alice', subId, enable: true });
    const share = async (reuse: boolean) => {
      const req = new Request('https://benx.example/api/servers/s/subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice', reuse }) });
      return (await (await subscriptionAdmin(req, f.env, server)).json() as { token: string }).token;
    };
    const open = (token: string) => publicSubscription(new Request('https://benx.example/sub/' + token + '/page'), f.env);
    for (const identity of ['first-identity', 'second-identity']) {
      subId = identity;
      const tokens = await Promise.all([share(true), share(true), issueStoreSubscription(f.env, server, 'alice', subId)]);
      expect(new Set(tokens).size).toBe(1);
      expect((await open(tokens[0])).status).toBe(200);
    }
    const previous = await share(true), rotated = await share(false);
    expect(rotated).not.toBe(previous);
    await expect(open(previous)).rejects.toMatchObject({ status: 404 });
    expect(await share(true)).toBe(rotated);
  });
  it('uses the same panel traffic and first-use deadline for the customer page and app feed', async () => {
    f.db.exec("UPDATE servers SET kind='panel' WHERE id='s'");
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token = await issueStoreSubscription(f.env, server, 'alice', 'identity');
    const url = 'https://benx.example/sub/' + token;
    const traffic = { up: 10, down: 20, expiryTime: Date.now() + 86400000 };
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, req) => req.path.includes('/links/') ? ['vless://11111111-1111-4111-8111-111111111111@example.com:443#test'] : {
      client: { email: 'alice', subId: 'identity', totalGB: 100, enable: true, expiryTime: -86400000, traffic }, inboundIds: [1],
    });
    const feed = () => publicSubscription(new Request(url + '/v2box'), f.env);
    const page = async () => (await publicSubscription(new Request(url + '/page?lang=en'), f.env)).text();
    expect((await feed()).headers.get('subscription-userinfo')).toBe(`upload=10; download=20; total=100; expire=${Math.floor(traffic.expiryTime / 1000)}`);
    expect(await page()).toContain('"download":20');
    traffic.down = 90;
    await expect(feed()).rejects.toMatchObject({ status: 403 });
    expect(await page()).toContain('"active":false');
    traffic.down = 0;
    traffic.expiryTime = Date.now() - 1000;
    await expect(feed()).rejects.toMatchObject({ status: 403 });
    expect(await page()).toContain('"active":false');
  });
  it('serves one general link as HTML in browsers and as V2Box data in an app', async () => {
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token = await issueStoreSubscription(f.env, server, 'alice', 'identity');
    vi.mocked(callRemoteJson).mockImplementation(async (_server, _env, req) => req.path === '/panel/api/inbounds/list' ? [{ id: 1, protocol: 'socks', enable: true, remark: 'SOCKS', port: 1080, settings: { publicHost: 'vpn.example.com', clients: [{ email: 'alice', id: '11111111-1111-4111-8111-111111111111', password: 'secret' }] }, streamSettings: {} }] : { email: 'alice', subId: 'identity', enable: true });
    const url = 'https://benx.example/sub/' + token;
    const browser = await publicSubscription(new Request(url, { headers: { Accept: 'text/html' } }), f.env);
    expect(browser.headers.get('Content-Type')).toContain('text/html');
    expect(await browser.text()).toContain('id="cp"');
    const app = await publicSubscription(new Request(url), f.env);
    expect(app.headers.get('Content-Type')).toContain('text/plain');
    expect(atob(await app.text())).toContain('socks://benx_');
    const explicit = await publicSubscription(new Request(url + '/singbox', { headers: { Accept: 'text/html' } }), f.env);
    expect((await explicit.json() as { outbounds: { type: string }[] }).outbounds.some(p => p.type === 'socks')).toBe(true);
  });
  it('renders seller actions on all themes and updates one rating without changing any app payload', async () => {
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token = await issueStoreSubscription(f.env, server, 'alice', 'identity');
    const origin = 'https://benx.example', url = origin + '/sub/' + token;
    let subId = 'identity';
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, req) => req.path.endsWith('/inbounds/list')
      ? [{ id: 1, protocol: 'socks', enable: true, port: 1080, settings: { publicHost: 'vpn.example.com', clients: [{ email: 'alice', password: 'secret' }] } }]
      : { email: 'alice', subId, enable: true });
    const feed = async (suffix: string) => (await publicSubscription(new Request(url + suffix, { headers: { Accept: suffix ? 'text/html' : '*/*' } }), f.env)).text();
    const formats = ['', '/v2box', '/v2ray', '/happ', '/singbox', '/clash'];
    const before = await Promise.all(formats.map(feed));
    for (const theme of [...originalThemeNames, 'custom']) {
      const design = { ...defaultPageDesign, theme, customHTML: customSubscriptionStarter, support: 'https://support.example/help', purchase: 'https://shop.example/buy', announcements: [{ title: 'Maintenance', message: 'Sunday', enabled: true }] };
      f.db.prepare('INSERT OR REPLACE INTO subscription_pages(server_id,data) VALUES(?,?)').run('s',JSON.stringify(design));
      const page = await publicSubscription(new Request(url, { headers: { Accept: 'text/html' } }), f.env);
      expect(page.headers.get('Content-Security-Policy')).toContain("form-action 'self'");
      const html = await page.text();
      for (const marker of [design.support, design.purchase, 'Maintenance', 'name="rating"', '/rating?lang=en']) expect(html, theme).toContain(marker);
    }
    const rate = (value: string, from = origin) => publicSubscription(new Request(url + '/rating?lang=fa', {
      method: 'POST', headers: { Origin: from, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'rating=' + value,
    }), f.env);
    await expect(rate('0')).rejects.toMatchObject({ status: 400 });
    await expect(rate('4', 'https://elsewhere.example')).rejects.toMatchObject({ status: 403 });
    const response = await rate('4');
    expect(response.status).toBe(303);
    expect(response.headers.get('Location')).toBe(url + '/page?lang=fa#rating');
    expect(await feed('/page?lang=fa')).toContain('value="4" selected');
    await rate('5');
    const settings = await subscriptionSettings(new Request(origin), f.env, 'server', 's');
    expect(await settings.json()).toMatchObject({ count: 1, average: 5 });
    expect(await Promise.all(formats.map(feed))).toEqual(before);
    subId = 'replacement';
    await expect(rate('3')).rejects.toMatchObject({ status: 404 });
    await issueStoreSubscription(f.env, server, 'alice', subId);
    await expect(rate('4')).rejects.toMatchObject({ status: 404 });
    expect(f.db.prepare('SELECT rating FROM subscriptions').get()?.rating).toBeNull();
  });
  it('exposes Unicode announcements as standard metadata and individual safe connection copying with true usage',async()=>{
    const server=f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token=await issueStoreSubscription(f.env,server,'alice','identity');
    f.db.prepare('INSERT INTO subscription_pages(server_id,data) VALUES(?,?)').run('s',JSON.stringify({...defaultPageDesign,announcements:[{title:'اطلاعیه',message:'Hello\nتست',enabled:true},{title:'Hidden',message:'Draft',enabled:false}]}));
    vi.mocked(callRemoteJson).mockImplementation(async(_s,_e,req)=>req.path==='/panel/api/inbounds/list'?[{id:1,protocol:'socks',enable:true,remark:'<img src=x>',port:1080,settings:{publicHost:'vpn.example.com',clients:[{email:'alice',password:'secret'}]},streamSettings:{}}]:{client:{email:'alice',subId:'identity',enable:true,totalGB:1000,expiryTime:2000000000000},traffic:{up:100,down:200}});
    const url='https://benx.example/sub/'+token;
    const feed=await publicSubscription(new Request(url),f.env);
    const announce=new TextDecoder().decode(Uint8Array.from(atob(feed.headers.get('announce')!.slice(7)),c=>c.charCodeAt(0)));
    expect(announce).toBe('اطلاعیه\nHello\nتست');expect(feed.headers.get('subscription-userinfo')).toBe('upload=100; download=200; total=1000; expire=2000000000');expect(feed.headers.get('profile-web-page-url')).toBe(url+'/page');
    const html=await(await publicSubscription(new Request(url,{headers:{Accept:'text/html'}}),f.env)).text();
    expect(html).toContain('Individual connections');expect(html).toContain('data-copy="socks://');expect(html).toContain('"download":200');expect(html).toContain('linear-gradient');expect(html).not.toContain('<img src=x>');
  });
  it('hides disabled configurations from every app feed and restores them on enable', async () => {
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token = await issueStoreSubscription(f.env, server, 'alice', 'identity');
    let enabled = false;
    const row = {protocol: 'socks', remark: 'Always', enable: true, port: 1080, settings: {publicHost: 'vpn.example.com', clients: [{email: 'alice', password: 'secret'}]}, streamSettings: {}};
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, req) => req.path === '/panel/api/inbounds/list' ? [{...row, id: 1}, {...row, id: 2, remark: 'Optional', port: 1081, enable: enabled}] : {email: 'alice', subId: 'identity', enable: true});
    for (const format of ['v2box', 'v2ray', 'happ', 'singbox', 'clash']) {
      const r = await publicSubscription(new Request(`https://benx.example/sub/${token}/${format}`), f.env);
      const body = await r.text();
      expect(['singbox', 'clash'].includes(format) ? body : atob(body)).not.toContain('Optional');
    }
    enabled = true;
    const r = await publicSubscription(new Request(`https://benx.example/sub/${token}/v2box`), f.env);
    expect(atob(await r.text())).toContain('Optional');
  });
  it('protects native downloads by identity, listener attachment, state and service access', async () => {
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    const token = await issueStoreSubscription(f.env, server, 'alice', 'identity');
    let enabled = true;
    vi.mocked(callRemoteJson).mockImplementation(async (_server, _env, req) => req.path === '/panel/api/inbounds/list' ? [{ id: 7, protocol: 'openvpn', enable: enabled, port: 1194, settings: { publicHost: 'vpn.example.com', clients: [{ email: 'alice' }] } }] : req.path.includes('/links/') ? ['client\nproto udp\nremote vpn.example.com 1194\nauth-user-pass\n'] : { email: 'alice', subId: 'identity', enable: true });
    const get = (id: number) => publicSubscription(new Request(`https://benx.example/sub/${token}/download?inbound=${id}`), f.env);
    const file = await get(7);
    expect(file.headers.get('Content-Disposition')).toContain('.ovpn');
    expect(await file.text()).toContain('auth-user-pass');
    await expect(get(8)).rejects.toMatchObject({ status: 404 });
    enabled = false;
    await expect(get(7)).rejects.toMatchObject({ status: 404 });
  });
  it('stores announcements with branding, escapes content and hides disabled messages', async () => {
    const design = { ...defaultPageDesign, language: 'fa' as const, announcements: [{ title: '<script>title</script>', message: 'اطلاعیه <img src=x onerror=alert(1)>', enabled: true }, { title: 'Hidden notice', message: 'Private draft', enabled: false }] };
    const put = (version: number) => pageDesignRoute(new Request('https://benx.example/api/servers/s/subscription-page', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, design }) }), f.env, 's');
    expect(await (await put(0)).json()).toMatchObject({ design, version: 1 });
    await expect(put(0)).rejects.toMatchObject({ status: 409 });
    vi.mocked(callRemoteJson).mockResolvedValue({ client: { email: 'test', subId: 'identity', enable: true } });
    const identity = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('identity'))), n => n.toString(16).padStart(2, '0')).join('');
    const server = { id: 's' } as Parameters<typeof subscriptionLanding>[2];
    const html = await (await subscriptionLanding(new Request('https://benx.example/sub/token/page'), f.env, server, 'test', 'token', identity)).text();
    expect(html).toContain('اطلاعیه'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('<img src=x'); expect(html).not.toContain('Private draft'); expect(html).toContain('dir="rtl"');
    expect(() => validatePageDesign({ ...design, announcements: [{ title: 'x', message: '', enabled: true }] })).toThrow('announcement');
    expect(() => validatePageDesign({ ...design, announcements: Array.from({ length: 9 }, () => design.announcements[0]) })).toThrow('eight');
  });
  it('persists custom HTML, renders real first-use terms and retains app copying', async () => {
    const design = {...defaultPageDesign,theme:'custom',customHTML:customSubscriptionStarter};
    await pageDesignRoute(new Request('https://benx.example/api/servers/s/subscription-page',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:0,design})}),f.env,'s');
    vi.mocked(callRemoteJson).mockResolvedValue({client:{email:'alice',subId:'identity',enable:true,expiryTime:-30*86400000,totalGB:1000},traffic:{up:100,down:200}});
    const identity = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('identity'))), b => b.toString(16).padStart(2, '0')).join('');
    const response = await subscriptionLanding(new Request('https://benx.example/sub/token/page'),f.env,{id:'s'} as Parameters<typeof subscriptionLanding>[2],'alice','token',identity), html = await response.text();
    expect(html).toContain('Welcome to my network');expect(html).toContain('300 B');expect(html).toContain('30 days after first connection');expect(html).not.toContain('{{subscription}}');
    expect(html).toContain('data-copy="https://benx.example/sub/token/singbox"');expect(response.headers.get('Content-Security-Policy')).toContain("script-src 'nonce-");
    expect(html).not.toContain('46.2');
  });
  it('validates simple themes and rejects injected styles or unsafe support links', () => { expect(validatePageDesign({ ...defaultPageDesign, theme: 'candy' }).theme).toBe('candy'); expect(() => validatePageDesign({ ...defaultPageDesign, accent: 'red;display:none' })).toThrow(); expect(() => validatePageDesign({ ...defaultPageDesign, support: 'javascript:alert(1)' })).toThrow(); });
  it('guards concurrent branding edits by version', async () => {
    const req = (version: number) => pageDesignRoute(new Request('https://benx.example/api/servers/s/subscription-page', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version, design: { ...defaultPageDesign, theme: 'nature' } }) }), f.env, 's');
    expect(await (await req(0)).json()).toMatchObject({ version: 1 }); await expect(req(0)).rejects.toMatchObject({ status: 409 }); expect(await (await req(1)).json()).toMatchObject({ version: 2 });
  });
  it('serves an escaped Persian customer page with actual identity and a nonce CSP', async () => {
    f.db.prepare('INSERT INTO subscription_pages(server_id,data) VALUES(?,?)').run('s', JSON.stringify({ ...defaultPageDesign, theme: 'candy', language: 'fa', title: '<script>alert(1)</script>' }));
    const server = f.db.prepare('SELECT * FROM servers').get() as unknown as import('../worker/remote').StoredServer;
    vi.mocked(callRemoteJson).mockImplementation(async (_server, _env, req) => req.path === '/panel/api/inbounds/list' ? [] : ({ client: { email: 'alice', subId: 'alice-sub', enable: true, comment: 'کاربر نمونه', totalGB: 1024 ** 3 }, traffic: { up: 10, down: 20 } }));
    const identity = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('alice-sub'))), b => b.toString(16).padStart(2, '0')).join('');
    const r = await subscriptionLanding(new Request('https://benx.example/sub/' + 'a'.repeat(64) + '/page'), f.env, server, 'alice', 'a'.repeat(64), identity), html = await r.text(); expect(html).toContain('dir="rtl"'); expect(html).not.toContain('<script>alert(1)</script>'); expect(html).toContain('/singbox'); expect(r.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
  });
  it('upgrades only former AI defaults and preserves custom model choices', () => { expect(currentAIModel('gemini', 'gemini-2.5-flash')).toBe('gemini-3.5-flash-lite'); expect(currentAIModel('openai', 'gpt-4.1-mini')).toBe('gpt-6-luna'); expect(currentAIModel('openai', 'custom-model')).toBe('custom-model'); });
});
