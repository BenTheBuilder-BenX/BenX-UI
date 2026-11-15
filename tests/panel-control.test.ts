import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { applyPanel, cleanPanelCollections, isManagedPanelCollectionMutation, isUnsupportedPanelMutation, managedPanelCollectionMutation, managedPanelCollectionView, remoteDocument, translatePanelRequest, translatePanelResponse } from '../worker/control';
import { emptyDocument, type ManagedDocument } from '../shared/managed';
import { parseObject, type JsonObject, type RemoteRequest } from '../shared/types';

const server = { id: 'destination', version: 'v3', kind: 'panel', enabled: 1 } as StoredServer;
const env = {} as Env;
function document() {
  const d = emptyDocument(); d.mode = 'panel'; d.setup.panel = '3x-ui'; d.setup.cores = []; d.setup.bbr = false;
  return d;
}
function inbound(id = 1, port = 443): JsonObject {
  return { id, port, tag: `profile-${id}`, remark: 'Saved inbound', protocol: 'vless', enable: true, listen: '', total: 0, expiryTime: 0, settings: { decryption: 'none', clients: [{ email: 'removed-client', id: 'must-not-resurrect' }] }, streamSettings: { network: 'tcp', security: 'none' }, sniffing: { enabled: false } };
}
class Panel {
  inbounds: JsonObject[] = []; nodes: JsonObject[] = []; hosts: JsonObject[] = []; clients: JsonObject[] = [];
  groups: JsonObject[] = []; outboundSubs: JsonObject[] = []; subBalancers: JsonObject[] = []; fallbacks: Record<string, JsonObject[]> = {}; nextCollectionId = 301;
  xray: JsonObject = { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } };
  settings: JsonObject = { webPort: 2053, webBasePath: '/destination/', webCertFile: '/keep-this.pem', apiToken: 'destination-auth', subEnable: true };
  calls: RemoteRequest[] = []; nextInbound = 101; nextNode = 201; ignoreEnable = false;
  writeClient(row: JsonObject, client: JsonObject) {
    const payload = structuredClone(client);
    if (payload.allowedIPsByInbound) row.tunnelAllowedIPs = Object.fromEntries(Object.entries(parseObject(payload.allowedIPsByInbound)).map(([id, addresses]) => [id, (addresses as string[]).join(',')]));
    delete payload.allowedIPsByInbound; row.client = payload;
    if (payload.expiryTime !== undefined && row.traffic) row.traffic = { ...parseObject(row.traffic), expiryTime: payload.expiryTime };
  }
  async request(input: RemoteRequest): Promise<unknown> {
    this.calls.push(structuredClone(input)); const { path, body = {} } = input;
    const tail = decodeURIComponent(path.split('/').at(-1)!);
    if (path === '/panel/api/inbounds/list') return this.inbounds.map(i => ({ ...i, up: 12, down: 15, clientStats: [], settings: { ...parseObject(i.settings), clients: this.clients.filter(c => (c.inboundIds as number[]).includes(Number(i.id))).map(c => c.client) } }));
    if (/\/inbounds\/\d+\/fallbacks$/.test(path)) { const id = path.split('/').at(-2)!; if (input.method === 'POST') this.fallbacks[id] = structuredClone(body.fallbacks as JsonObject[]); return this.fallbacks[id] || []; }
    if (path === '/panel/api/inbounds/add') { const i = { ...structuredClone(body), id: this.nextInbound++ }; this.inbounds.push(i); return i; }
    if (/\/inbounds\/update\//.test(path)) { const i = this.inbounds.find(i => Number(i.id) === Number(tail))!; const enabled = i.enable, nodeId = i.nodeId; Object.assign(i, structuredClone(body), { id: Number(tail), enable: enabled, nodeId }); return i; }
    if (/\/inbounds\/setEnable\//.test(path)) { if (!this.ignoreEnable) this.inbounds.find(i => Number(i.id) === Number(tail))!.enable = body.enable; return null; }
    if (/\/inbounds\/del\//.test(path)) { this.inbounds = this.inbounds.filter(i => Number(i.id) !== Number(tail)); for (const c of this.clients) c.inboundIds = (c.inboundIds as number[]).filter(i => i !== Number(tail)); return null; }
    if (path === '/panel/api/clients/export') return this.clients;
    if (path === '/panel/api/clients/groups') return this.groups;
    if (path === '/panel/api/clients/groups/create') { this.groups.push({ name: body.name }); return null; }
    if (path === '/panel/api/clients/groups/delete') { this.groups = this.groups.filter(g => g.name !== body.name); return null; }
    if (path === '/panel/api/clients/import') { for (const source of JSON.parse(String(body.data)) as JsonObject[]) { const row = structuredClone(source); this.writeClient(row, parseObject(source.client)); this.clients.push(row); } return { imported: this.clients.length, skipped: [] }; }
    if (/\/clients\/get\//.test(path)) { const c = this.clients.find(c => parseObject(c.client).email === tail)!; return { client: { ...parseObject(c.client), id: 999, uuid: parseObject(c.client).id }, inboundIds: c.inboundIds, externalLinks: c.externalLinks || [], tunnelAllowedIPs: c.tunnelAllowedIPs || {} }; }
    if (/\/clients\/update\//.test(path)) { this.writeClient(this.clients.find(c => parseObject(c.client).email === tail)!, body); return null; }
    if (/\/clients\/del\//.test(path)) { this.clients = this.clients.filter(c => parseObject(c.client).email !== tail); return null; }
    if (/\/clients\/[^/]+\/(attach|detach|externalLinks)$/.test(path)) {
      const email = decodeURIComponent(path.split('/').at(-2)!), c = this.clients.find(c => parseObject(c.client).email === email)!;
      if (tail === 'externalLinks') c.externalLinks = body.externalLinks;
      else c.inboundIds = tail === 'attach' ? [...new Set([...(c.inboundIds as number[]), ...(body.inboundIds as number[])])] : (c.inboundIds as number[]).filter(i => !(body.inboundIds as number[]).includes(i));
      return null;
    }
    if (path === '/panel/api/nodes/list') return this.nodes.map(n => { const row = { ...n }; delete row.apiToken; return row; });
    if (path === '/panel/api/nodes/add') { const node = { ...structuredClone(body), id: this.nextNode++, guid: 'destination-node-guid', hasApiToken: !!body.apiToken, status: 'online', xrayState: 'running', configDirty: false }; this.nodes.push(node); const row = { ...node }; delete (row as JsonObject).apiToken; return row; }
    if (/\/nodes\/get\//.test(path)) return this.nodes.find(n => Number(n.id) === Number(tail));
    if (/\/nodes\/update\//.test(path)) { const node = this.nodes.find(n => Number(n.id) === Number(tail))!; Object.assign(node, structuredClone(body)); if (body.apiToken) node.hasApiToken = true; const row = { ...node }; delete row.apiToken; return row; }
    if (/\/nodes\/del\//.test(path)) { this.nodes = this.nodes.filter(n => Number(n.id) !== Number(tail)); return null; }
    if (/\/nodes\/probe\//.test(path)) return { status: 'online', xrayState: 'running' };
    if (path === '/panel/api/hosts/list') return this.hosts;
    if (path === '/panel/api/hosts/add') { this.hosts.push(structuredClone(body)); return []; }
    if (/\/hosts\/update\//.test(path)) { const index = this.hosts.findIndex(h => h.groupId === tail); this.hosts[index] = structuredClone(body); return []; }
    if (/\/hosts\/del\//.test(path)) { this.hosts = this.hosts.filter(h => h.groupId !== tail); return null; }
    if (path === '/panel/api/xray/outbound-subs' || path === '/panel/api/sub-balancers') {
      const rows = path.endsWith('sub-balancers') ? this.subBalancers : this.outboundSubs;
      if (input.method === 'POST') { const made = { ...structuredClone(body), id: this.nextCollectionId++, priority: rows.length }; rows.push(made); return made; }
      return rows;
    }
    const collection = path.match(/^\/panel\/api\/(xray\/outbound-subs|sub-balancers)\/(\d+)(?:\/(del|refresh|move))?$/);
    if (collection) {
      const rows = collection[1] === 'sub-balancers' ? this.subBalancers : this.outboundSubs, index = rows.findIndex(r => Number(r.id) === Number(collection[2]));
      if (collection[3] === 'del') { rows.splice(index, 1); return null; }
      if (collection[3] === 'refresh') { rows[index].outboundCount = 2; return []; }
      if (collection[3] === 'move') { const next = body.dir === 'up' ? index - 1 : index + 1; if (next >= 0 && next < rows.length) [rows[index], rows[next]] = [rows[next], rows[index]]; return null; }
      Object.assign(rows[index], structuredClone(body)); return rows[index];
    }
    if (path === '/panel/api/xray/' || path === '/panel/xray/') return { xraySetting: JSON.stringify(this.xray) };
    if (/\/xray\/update$/.test(path)) { this.xray = parseObject(body.xraySetting); return null; }
    if (/\/setting\/all$/.test(path)) return this.settings;
    if (/\/setting\/update$/.test(path)) { this.settings = { ...this.settings, ...body }; return null; }
    if (path === '/panel/api/server/status') return { xray: { state: 'running', errorMsg: '' } };
    throw new Error('Unexpected operation ' + path);
  }
  attach() { vi.mocked(callRemoteJson).mockImplementation(async (_server, _env, input) => structuredClone(await this.request(input))); }
}
beforeEach(() => vi.clearAllMocks());
describe('3X-UI authoritative profile adapter', () => {
  it('imports normalized credentials and excludes hidden destination access settings and embedded clients', async () => {
    const panel = new Panel(); panel.inbounds = [inbound(7)]; panel.clients = [{ client: { email: 'alice', id: 'keep-uuid', password: 'keep-password', subId: 'keep-sub', enable: true }, inboundIds: [7], traffic: { up: 100, down: 200 } }]; panel.attach();
    const d = await remoteDocument(env, server);
    expect(d.state.clients.alice).toMatchObject({ id: 'keep-uuid', password: 'keep-password', subId: 'keep-sub', inboundIds: [7] });
    expect(parseObject(d.state.inbounds[0].settings).clients).toBeUndefined();
    expect(d.settings).toEqual({ subEnable: true }); expect(d.runtime.alice).toEqual({ up: 100, down: 200 });
  });
  it('restores remote IDs before referenced inbounds, hosts, clients and routing; repeat application is idempotent', async () => {
    const panel = new Panel(); panel.inbounds = [{ ...inbound(555), nodeId: null, enable: false }]; panel.clients = [{ client: { email: 'removed-client', id: 'old-secret' }, inboundIds: [555] }]; panel.attach();
    const d = document(); d.state.inbounds = [inbound(1), { ...inbound(2, 8443), nodeId: 9 }];
    d.state.clients.alice = { email: 'alice', id: 42, uuid: 'same-uuid', password: 'same-password', subId: 'same-sub', enable: true, inboundIds: [1, 2], externalLinks: ['https://subscription.example.com/alice'] };
    d.runtime.alice = { up: 111, down: 222, resetCount: 1 };
    d.nodes = [{ id: 9, guid: 'source-node-guid', name: 'my-node', scheme: 'https', address: 'node.example.com', port: 2053, basePath: '/', enable: true, hasApiToken: true, apiToken: 'node-token', status: 'offline', cpuPct: 80 }];
    d.hosts = [{ id: 'logical-host', groupId: 'source-host-group', inboundIds: [1, 2], hosts: ['vpn.example.com'], remark: 'Standard', nodeGuids: ['source-node-guid'] }];
    d.state.xray.routing = { rules: [{ inboundTag: ['profile-2'], outboundTag: 'direct', nodeId: 9 }] };
    d.settings = { subEnable: false, webPort: 9999, apiToken: 'source-auth', webCertFile: '/unavailable.pem' };
    const mapping = await applyPanel(env, server, d);
    expect(mapping).toEqual({ '1': 555, '2': 101 }); expect(panel.inbounds.find(i => i.id === 555)?.enable).toBe(true);
    expect(panel.inbounds.find(i => i.id === 101)?.nodeId).toBe(201);
    expect(panel.clients).toEqual([{ client: { email: 'alice', id: 'same-uuid', password: 'same-password', subId: 'same-sub', enable: true }, inboundIds: [555, 101], traffic: { up: 111, down: 222, resetCount: 1 }, externalLinks: ['https://subscription.example.com/alice'] }]);
    expect(panel.hosts[0]).toMatchObject({ groupId: 'source-host-group', inboundIds: [555, 101], nodeGuids: ['destination-node-guid'] });
    expect(parseObject(panel.xray.routing).rules).toEqual([{ inboundTag: ['profile-2'], outboundTag: 'direct', nodeId: 201 }]);
    expect(panel.settings).toMatchObject({ webPort: 2053, apiToken: 'destination-auth', webCertFile: '/keep-this.pem', subEnable: false });
    expect(d.state.inbounds[0].id).toBe(1); expect(d.state.clients.alice.inboundIds).toEqual([1, 2]);
    const last = panel.calls.length; await applyPanel(env, server, d);
    expect(panel.calls.slice(last).filter(c => /\/(add|update(?:\/|$)|del(?:\/|$)|setEnable\/|import$|attach$|detach$|externalLinks$)/.test(c.path))).toEqual([]);
  });
  it('does not claim success when enable writes are ignored', async () => {
    const panel = new Panel(); panel.inbounds = [{ ...inbound(), nodeId: null, enable: false }]; panel.ignoreEnable = true; panel.attach();
    const d = document(); d.state.inbounds = [inbound()];
    await expect(applyPanel(env, server, d)).rejects.toThrow('enabled state');
  });
  it('accepts omitted empty ClientRecord fields but still verifies nonempty credentials', async () => {
    const panel = new Panel(); panel.inbounds = [inbound()];
    panel.clients = [{ client: { email: 'alice', id: 'keep-uuid', enable: true }, inboundIds: [1] }]; panel.attach();
    const d = document(); d.state.inbounds = [inbound()];
    d.state.clients.alice = { email: 'alice', id: 'keep-uuid', enable: true, inboundIds: [1], password: '', auth: '', flow: '', privateKey: '', publicKey: '', allowedIPs: [], preSharedKey: '', keepAlive: 0, forwardedPorts: '', secret: '', adTag: '', group: '', reverse: null };
    await applyPanel(env, server, d);
    expect(panel.calls.some(c => c.path.startsWith('/panel/api/clients/update/'))).toBe(false);
    d.state.clients.alice.password = 'required-password';
    await applyPanel(env, server, d);
    expect(parseObject(panel.clients[0].client).password).toBe('required-password');
    expect(panel.calls.some(c => c.path.startsWith('/panel/api/clients/update/'))).toBe(true);
  });
  it('retains the live traffic checkpoint and does not reenable a quota-depleted client', async () => {
    const panel = new Panel(); panel.inbounds = [{ ...inbound(), nodeId: null }]; panel.clients = [{ client: { email: 'alice', id: 'uuid', enable: false, totalGB: 100 }, inboundIds: [1], traffic: { up: 70, down: 50 } }]; panel.attach();
    const d = document(); d.state.inbounds = [inbound()]; d.state.clients.alice = { email: 'alice', id: 'uuid', enable: true, totalGB: 100, inboundIds: [1] };
    await applyPanel(env, server, d);
    expect(panel.calls.some(c => c.path === '/panel/api/clients/update/alice')).toBe(false);
    expect(d.runtime.alice).toEqual({ up: 70, down: 50 }); expect(d.state.clients.alice.enable).toBe(true);
  });
  it('refuses incomplete node migration and legacy authority before making writes', async () => {
    const d = document(); d.nodes = [{ id: 1, hasApiToken: true }];
    await expect(applyPanel(env, server, d)).rejects.toThrow('Re-enter');
    await expect(applyPanel(env, { ...server, version: 'v2' }, document())).rejects.toThrow('Legacy 2.x');
    expect(callRemoteJson).not.toHaveBeenCalled();
  });
  it('fails a legacy import when the same email has incompatible protocol credentials', async () => {
    const panel = new Panel(); panel.inbounds = [inbound(1), inbound(2, 8443)];
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, input) => input.path === '/panel/api/inbounds/list' ? [
      { ...inbound(1), settings: { clients: [{ email: 'alice', id: 'first-uuid' }] } }, { ...inbound(2, 8443), settings: { clients: [{ email: 'alice', id: 'other-uuid' }] } },
    ] : panel.request(input));
    await expect(remoteDocument(env, { ...server, version: 'v2' })).rejects.toThrow('different credentials');
  });
  it('translates live paths and attachment filters while preserving logical desired IDs', () => {
    const d: ManagedDocument = document(); d.runtime._benxPanelBinding = { serverId: server.id, inbounds: { 7: 91 }, nodes: { 2: 51 }, hosts: { h: 'remote-h' } };
    expect(translatePanelRequest(d, server.id, { path: '/panel/api/nodes/history/2/cpu/minute', method: 'GET' }).path).toBe('/panel/api/nodes/history/51/cpu/minute');
    expect(translatePanelRequest(d, server.id, { path: '/panel/api/clients/links/alice', method: 'GET', query: { inboundIds: '7' } }).query).toEqual({ inboundIds: '91' });
    expect(translatePanelRequest(d, server.id, { path: '/panel/api/hosts/get/h', method: 'GET' }).path).toBe('/panel/api/hosts/get/remote-h');
    expect(() => translatePanelRequest(d, 'unconfirmed-server', { path: '/panel/api/inbounds/get/7', method: 'GET' })).toThrow('Synchronize');
    expect(translatePanelResponse(d, server.id, { path: '/panel/api/inbounds/options', method: 'GET' }, { success: true, obj: [{ id: 91, nodeId: 51 }] })).toEqual({ success: true, obj: [{ id: 7, nodeId: 2 }] });
    expect(translatePanelResponse(d, server.id, { path: '/panel/api/clients/list/paged', method: 'GET' }, { items: [{ id: 777, email: 'alice', inboundIds: [91] }] })).toEqual({ items: [{ id: 777, email: 'alice', inboundIds: [7] }] });
  });
  it('imports and restores empty groups, provider subscriptions, balancer costs and table-based fallbacks', async () => {
    const source = new Panel(); source.inbounds = [{ ...inbound(7), streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { certificates: [{ certificate: ['PEM'], key: ['PRIVATE KEY'] }] } } }, inbound(8, 8080)];
    source.groups = [{ name: 'Empty group', count: 0 }];
    source.outboundSubs = [{ id: 10, url: 'https://provider.example.com/sub', remark: 'Provider', tagPrefix: 'stable-', enabled: true, priority: 0, outboundCount: 2 }];
    source.subBalancers = [{ id: 20, remark: 'Pro auto', strategy: 'leastLoad', inboundIds: [7, 8], memberWeights: { 7: 0.5 }, sortOrder: 1, enabled: false }];
    source.fallbacks['7'] = [{ id: 33, masterId: 7, childId: 8, name: '', alpn: '', path: '/app', dest: '', xver: 2, sortOrder: 1 }]; source.attach();
    const d = await remoteDocument(env, { ...server, id: 'source-panel' });
    const target = new Panel(); target.attach(); await applyPanel(env, server, d);
    expect(target.groups).toEqual([{ name: 'Empty group' }]);
    expect(target.outboundSubs[0]).toMatchObject({ url: 'https://provider.example.com/sub', tagPrefix: 'stable-', outboundCount: 2 });
    expect(target.subBalancers[0]).toMatchObject({ inboundIds: [101, 102], memberWeights: { 101: 0.5 }, enabled: false });
    expect(target.fallbacks['101']).toEqual([{ childId: 102, name: '', alpn: '', path: '/app', dest: '', xver: 2, sortOrder: 1 }]);
    expect(target.calls.some(c => c.path.endsWith('/refresh'))).toBe(true);
    const before = target.calls.length; await applyPanel(env, server, d);
    expect(target.calls.slice(before).filter(c => c.method === 'POST' && !['/panel/api/xray/', '/panel/api/setting/all'].includes(c.path))).toEqual([]);
  });
  it('saves collection edits and removes stale inbound references before reconciliation', () => {
    const d = document(); d.state.inbounds = [inbound(1), inbound(2, 8080)]; d.state.nextId = 3; d.state.clients.alice = { email: 'alice', id: 'uuid', enable: true, inboundIds: [1] };
    const group = managedPanelCollectionMutation(d, { path: '/panel/api/clients/groups/bulkAdd', method: 'POST', body: { group: 'Standard', emails: ['alice'] } })!.document;
    expect(group.state.clients.alice.group).toBe('Standard'); expect(managedPanelCollectionView(group, { path: '/panel/api/clients/groups', method: 'GET' })).toEqual([{ name: 'Standard', count: 1 }]);
    const fallback = managedPanelCollectionMutation(group, { path: '/panel/api/inbounds/1/fallbacks', method: 'POST', body: { fallbacks: [{ childId: 2, path: '/app' }] } })!.document;
    const balancer = managedPanelCollectionMutation(fallback, { path: '/panel/api/sub-balancers', method: 'POST', body: { remark: 'Standard', inboundIds: [1, 2], strategy: 'leastLoad', memberWeights: { 2: 0.2 } } })!.document;
    balancer.state.inbounds = balancer.state.inbounds.filter(i => i.id === 1); cleanPanelCollections(balancer);
    expect(managedPanelCollectionView(balancer, { path: '/panel/api/inbounds/1/fallbacks', method: 'GET' })).toEqual([]);
    expect(managedPanelCollectionView(balancer, { path: '/panel/api/sub-balancers', method: 'GET' })).toMatchObject([{ inboundIds: [1], memberWeights: {} }]);
    expect(isManagedPanelCollectionMutation({ path: '/panel/api/sub-balancers/1/del', method: 'POST' })).toBe(true);
  });
  it('classifies unsupported config bypasses while allowing actual read and counter operations', () => {
    expect(isUnsupportedPanelMutation({ path: '/panel/api/clients/bulkAdjust', method: 'POST' })).toBe(true);
    expect(isUnsupportedPanelMutation({ path: '/panel/api/server/importDB', method: 'POST' })).toBe(true);
    expect(isUnsupportedPanelMutation({ path: '/panel/api/xray/warp/reg', method: 'POST' })).toBe(true);
    expect(isUnsupportedPanelMutation({ path: '/panel/api/inbounds/1/resetTraffic', method: 'POST' })).toBe(false);
    expect(isUnsupportedPanelMutation({ path: '/panel/api/clients/groups/rename', method: 'POST' })).toBe(false);
    expect(isUnsupportedPanelMutation({ path: '/panel/api/xray/outbound-subs/parse', method: 'POST' })).toBe(false);
  });
  it('preserves distinct tunnel addresses across migrated shared attachments and repairs address drift', async () => {
    const source = new Panel(); source.inbounds = [{ ...inbound(7), protocol: 'wireguard', settings: { secretKey: 'server-private', clients: [{ email: 'alice', privateKey: 'peer-private', publicKey: 'peer-public', allowedIPs: ['10.0.0.2/32'] }] } }, { ...inbound(8, 8443), protocol: 'amneziawg', settings: { clients: [{ email: 'alice', privateKey: 'peer-private', publicKey: 'peer-public', allowedIPs: ['10.1.0.2/32'] }] } }];
    source.clients = [{ client: { email: 'alice', privateKey: 'peer-private', publicKey: 'peer-public', allowedIPs: '10.0.0.2/32', enable: true }, inboundIds: [7, 8], tunnelAllowedIPs: { 7: '10.0.0.2/32', 8: '10.1.0.2/32' } }]; source.attach();
    const d = await remoteDocument(env, { ...server, id: 'source' });
    expect(d.state.clients.alice.allowedIPsByInbound).toEqual({ 7: ['10.0.0.2/32'], 8: ['10.1.0.2/32'] });
    const target = new Panel(); target.attach(); await applyPanel(env, server, d);
    expect(target.clients[0].tunnelAllowedIPs).toEqual({ 101: '10.0.0.2/32', 102: '10.1.0.2/32' });
    const count = target.calls.length; await applyPanel(env, server, d);
    expect(target.calls.slice(count).filter(c => c.path.startsWith('/panel/api/clients/update/'))).toEqual([]);
    target.clients[0].tunnelAllowedIPs = { 101: '10.0.0.99/32', 102: '10.1.0.2/32' };
    await applyPanel(env, server, d);
    expect(target.clients[0].tunnelAllowedIPs).toEqual({ 101: '10.0.0.2/32', 102: '10.1.0.2/32' });
    expect(translatePanelResponse(d, server.id, { path: '/panel/api/clients/get/alice', method: 'GET' }, { tunnelAllowedIPs: { 101: '10.0.0.2/32' } })).toEqual({ tunnelAllowedIPs: { 7: '10.0.0.2/32' } });
  });
  it('rejects different tunnel peer identities before exporting a deceptively shared client', async () => {
    const panel = new Panel(); panel.inbounds = [{ ...inbound(7), protocol: 'wireguard', settings: { clients: [{ email: 'alice', publicKey: 'first-key' }] } }, { ...inbound(8, 8443), protocol: 'amneziawg', settings: { clients: [{ email: 'alice', publicKey: 'different-key' }] } }];
    panel.clients = [{ client: { email: 'alice', publicKey: 'first-key', enable: true }, inboundIds: [7, 8] }]; panel.attach();
    vi.mocked(callRemoteJson).mockImplementation(async (_s, _e, input) => structuredClone(input.path === '/panel/api/inbounds/list' ? panel.inbounds : await panel.request(input)));
    await expect(remoteDocument(env, server)).rejects.toThrow('different WireGuard/AmneziaWG peer keys');
    expect(panel.calls.filter(c => c.method === 'POST' && !['/panel/api/xray/', '/panel/api/setting/all'].includes(c.path))).toEqual([]);
  });
  it('preserves a verified first-use activation across synchronization and replacement but honors a new duration', async () => {
    const panel = new Panel(); panel.inbounds = [inbound()]; panel.clients = [{ client: { email: 'alice', id: 'uuid', enable: true, expiryTime: -86400000 }, inboundIds: [1], traffic: { up: 0, down: 0, expiryTime: -86400000 } }]; panel.attach();
    const d = await remoteDocument(env, server), activatedExpiry = Date.now() + 86400000;
    parseObject(panel.clients[0].client).expiryTime = activatedExpiry; parseObject(panel.clients[0].traffic).expiryTime = activatedExpiry;
    const before = panel.calls.length; await applyPanel(env, server, d);
    expect(panel.calls.slice(before).filter(c => c.path.startsWith('/panel/api/clients/update/'))).toEqual([]);
    expect(d.state.clients.alice.expiryTime).toBe(-86400000);
    expect(parseObject(d.runtime.alice).expiryTime).toBe(activatedExpiry);
    const replacement = new Panel(); replacement.attach(); await applyPanel(env, { ...server, id: 'replacement' }, d);
    expect(parseObject(replacement.clients[0].client).expiryTime).toBe(activatedExpiry);
    d.state.clients.alice.expiryTime = -172800000;
    await applyPanel(env, { ...server, id: 'replacement' }, d);
    expect(parseObject(replacement.clients[0].client).expiryTime).toBe(-172800000);
    expect(parseObject(d.runtime._benxPanelActivation).alice).toEqual({ duration: -172800000 });
  });
  it('ignores destination IDs and changing fetch diagnostics when reconciling external links', async () => {
    const source = new Panel(); source.inbounds = [inbound()];
    source.clients = [{ client: { email: 'alice', id: 'uuid', enable: true }, inboundIds: [1], externalLinks: [{ id: 7, kind: 'subscription', value: 'https://provider.example.com/alice', lastFetchAt: 123, lastFetchError: 'temporary error' }] }]; source.attach();
    const d = await remoteDocument(env, { ...server, id: 'source' });
    expect(d.state.clients.alice.externalLinks).toEqual([{ kind: 'subscription', value: 'https://provider.example.com/alice', remark: '', enable: true, expiryTime: 0, namePrefix: '' }]);
    const target = new Panel(); target.attach(); await applyPanel(env, server, d);
    target.clients[0].externalLinks = [{ ...parseObject((target.clients[0].externalLinks as unknown[])[0]), id: 99, lastFetchAt: 456, lastFetchError: '' }];
    const before = target.calls.length; await applyPanel(env, server, d);
    expect(target.calls.slice(before).filter(c => c.path.endsWith('/externalLinks'))).toEqual([]);
  });
});
