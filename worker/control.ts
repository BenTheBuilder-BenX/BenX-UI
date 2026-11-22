import { configurationView, withDefaultPublicHost, emptyDocument, isManagedMutation, reduceDocument, validateDocument, type ManagedDocument } from '../shared/managed';
import { validatePolicy } from '../shared/policy';
import { parseObject, type JsonObject, type RemoteRequest } from '../shared/types';
import { reportedClientTraffic } from '../shared/client-usage';
import { portableCopy } from '../shared/portable-profile';
import { operationMode } from './operation-mode';
import { callRemoteJson, type StoredServer } from './remote';
import { decrypt, encrypt, HttpError, readJson } from './security';

export interface ManagedRow { server_id: string; revision: number; document: string; applied_revision: number; phase: string; error: string; updated_at: number; checked_at: number; checkpoint_at?: number; requested_revision?: number; lease: string | null; lease_until: number; bound: number }
export async function managedRow(env: Env, id: string) { return env.DB.prepare('SELECT * FROM managed_state WHERE server_id=?').bind(id).first<ManagedRow>(); }
export async function savedDocument(env: Env, row: ManagedRow) { return decrypt<ManagedDocument>(row.document, env.ENCRYPTION_KEY); }
export async function createManaged(env: Env, id: string, document: ManagedDocument, bound = 1) {
  const secret = await encrypt(validateDocument(document), env.ENCRYPTION_KEY), now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO managed_state(server_id,document,updated_at,bound) VALUES(?,?,?,?)').bind(id, secret, now, bound),
    env.DB.prepare('INSERT INTO managed_versions(server_id,revision,document,created_at) VALUES(?,1,?,?)').bind(id, secret, now),
    env.DB.prepare('INSERT INTO server_policy(server_id,revision,data,updated_at) VALUES(?,?,?,?) ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at').bind(id, document.policy.revision, JSON.stringify(document.policy), now),
  ]);
}
export async function saveManaged(env: Env, row: ManagedRow, document: ManagedDocument) {
  const manual = await operationMode(env) === 'manual';
  if (manual && row.bound && Number(row.requested_revision || 0) > row.applied_revision && row.phase !== 'failed') throw new HttpError(409, 'Wait for the submitted job to finish before saving another batch. Refresh synchronization status.');
  const secret = await encrypt(validateDocument(document), env.ENCRYPTION_KEY), now = Date.now();
  const revision = row.revision + 1;
  const committed = 'SELECT 1 FROM managed_state WHERE server_id=? AND revision=? AND document=?';
  const guard = [row.server_id, revision, secret];
  const [updated] = await env.DB.batch([
    env.DB.prepare(`UPDATE managed_state SET document=?, revision=revision+1, phase='pending', requested_revision=applied_revision, error='', updated_at=?
      WHERE server_id=? AND revision=? AND document=? AND (lease_until<? OR lease LIKE 'sync:%')
      AND (?=0 OR bound=0 OR requested_revision<=applied_revision OR phase='failed')`)
      .bind(secret, now, row.server_id, row.revision, row.document, now, Number(manual)),
    env.DB.prepare(`INSERT INTO managed_versions(server_id,revision,document,created_at)
      SELECT server_id,revision,document,updated_at FROM managed_state WHERE server_id=? AND revision=? AND document=?`).bind(...guard),
    env.DB.prepare(`DELETE FROM managed_versions WHERE server_id=? AND revision<? AND EXISTS(${committed})`).bind(row.server_id, revision - 19, ...guard),
    env.DB.prepare(`INSERT INTO server_policy(server_id,revision,data,updated_at) SELECT ?,?,?,? WHERE EXISTS(${committed})
      ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at`)
      .bind(row.server_id, document.policy.revision, JSON.stringify(document.policy), now, ...guard),
  ]);
  if (!updated.meta.changes) throw new HttpError(409, 'This server changed or is applying a configuration. Refresh and retry.');
  return revision;
}
interface PanelBinding { serverId: string; inbounds: Record<string, number>; nodes: Record<string, number>; hosts: Record<string, string>; nodeGuids: Record<string, string>; nodeTokenHashes: Record<string, string>; outboundSubs: Record<string, number>; subBalancers: Record<string, number> }
interface PanelCollections { format: 1; groups: JsonObject[]; outboundSubs: JsonObject[]; subBalancers: JsonObject[]; fallbacks: Record<string, JsonObject[]>; subscriptionOutbounds: JsonObject[]; outboundTestUrl: string }
function bindingFor(d: ManagedDocument, serverId: string): PanelBinding {
  const saved = parseObject(d.runtime._benxPanelBinding);
  const binding: PanelBinding = { serverId, inbounds: {}, nodes: {}, hosts: {}, nodeGuids: {}, nodeTokenHashes: {}, outboundSubs: {}, subBalancers: {} };
  if (saved.serverId === serverId) {
    for (const group of ['inbounds', 'nodes', 'outboundSubs', 'subBalancers'] as const) binding[group] = Object.fromEntries(Object.entries(parseObject(saved[group])).filter(([, id]) => Number.isSafeInteger(id) && Number(id) > 0)) as Record<string, number>;
    for (const group of ['hosts', 'nodeGuids', 'nodeTokenHashes'] as const) binding[group] = Object.fromEntries(Object.entries(parseObject(saved[group])).filter(([, id]) => typeof id === 'string' && id.length > 0)) as Record<string, string>;
  }
  return binding;
}
function objectRows(value: unknown, name: string): JsonObject[] {
  if (!Array.isArray(value) || value.some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw new HttpError(502, `Panel ${name} export is incomplete. Synchronization cancelled.`);
  return value.map(v => ({ ...v }));
}
function clientPayload(raw: JsonObject): JsonObject {
  const c = { ...raw };
  // ClientRecord.id is a database integer; Client.id in write/export payloads is the UUID.
  if (typeof c.uuid === 'string' && c.uuid) c.id = c.uuid;
  else if (typeof c.id !== 'string') delete c.id;
  if (typeof c.tgId === 'string' && /^\d+$/.test(c.tgId) && Number.isSafeInteger(Number(c.tgId))) c.tgId = Number(c.tgId);
  if (typeof c.allowedIPs === 'string') c.allowedIPs = c.allowedIPs.split(',').map(v => v.trim()).filter(Boolean);
  for (const key of ['uuid', 'inboundIds', 'externalLinks', 'traffic', 'createdAt', 'updatedAt', 'created_at', 'updated_at', 'up', 'down', 'lastOnline', 'lastSubFetch', '_quotaBlocked']) delete c[key];
  return c;
}
function externalLinks(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new HttpError(409, 'Saved client external links are incomplete.');
  return value.map(raw => {
    // Row identities and fetch diagnostics belong to the destination, not to the link.
    if (typeof raw === 'string') return raw;
    const value = parseObject(raw), defaults: JsonObject = { kind: 'link', remark: '', enable: true, expiryTime: 0, namePrefix: '' };
    const row = { ...defaults, ...Object.fromEntries(['kind', 'value', 'remark', 'enable', 'expiryTime', 'namePrefix'].filter(k => value[k] !== undefined).map(k => [k, value[k]])) };
    if (row.enable === null) row.enable = true;
    return row;
  });
}
function effectiveClient(raw: JsonObject, traffic: unknown, activation: unknown) {
  const c = clientPayload(raw), counters = parseObject(traffic), total = Number(c.totalGB || 0), expiry = Number(c.expiryTime || 0);
  // A verified pending duration can naturally become a fixed expiry after first use.
  if (expiry < 0 && Number(parseObject(activation).duration) === expiry && Number(counters.expiryTime) > 0) c.expiryTime = Number(counters.expiryTime);
  if (total > 0 && Number(counters.up || 0) + Number(counters.down || 0) >= total || Number(c.expiryTime) > 0 && Number(c.expiryTime) <= Date.now()) c.enable = false;
  return c;
}
function validatePortablePeerIdentities(inbounds: JsonObject[], clients: Record<string, JsonObject>) {
  const peers: Record<string, JsonObject> = {};
  for (const inbound of inbounds.filter(i => ['wireguard', 'amneziawg'].includes(String(i.protocol)))) {
    for (const peer of (parseObject(inbound.settings).clients as JsonObject[] || [])) {
      const email = String(peer.email), previous = peers[email] || clients[email] || {};
      if (['privateKey', 'publicKey', 'preSharedKey', 'keepAlive', 'forwardedPorts'].some(k => peer[k] !== undefined && previous[k] !== undefined && stable(peer[k]) !== stable(previous[k]))) throw new HttpError(409, 'A shared client has different WireGuard/AmneziaWG peer keys or options on its inbounds. The panel API cannot restore those distinct identities through shared-client writes. Separate those clients before migration.');
      peers[email] = { ...previous, ...peer };
    }
  }
}
function clientComparable(raw: JsonObject) {
  const row = clientPayload(raw);
  // Hydrated Client includes empty defaults; ClientRecord export omits them.
  // Normalize both representations while still requiring every nonempty credential.
  for (const key of ['password', 'auth', 'flow', 'privateKey', 'publicKey', 'preSharedKey', 'forwardedPorts', 'secret', 'adTag', 'group']) row[key] ??= '';
  row.allowedIPs ??= []; row.keepAlive ??= 0; row.reverse ??= null;
  // Per-inbound addresses are write-only on Client; GET exposes them on the hydrate envelope.
  if (Object.keys(parseObject(row.allowedIPsByInbound)).length) delete row.allowedIPs;
  delete row.allowedIPsByInbound;
  return row;
}
function hasTunnelAddresses(detail: JsonObject, raw: JsonObject, binding: PanelBinding) {
  return Object.entries(parseObject(raw.allowedIPsByInbound)).every(([id, value]) => {
    const actual = parseObject(detail.tunnelAllowedIPs)[String(binding.inbounds[id])];
    const addresses = (v: unknown) => Array.isArray(v) ? v.map(String).sort() : String(v || '').split(',').map(s => s.trim()).filter(Boolean).sort();
    return stable(addresses(actual)) === stable(addresses(value));
  });
}
function portableSettings(raw: JsonObject) {
  // Panel credentials, public listeners and trust roots belong to the destination.
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !/^(web|username|password|apiToken|apiKey|session|secretKey|nodeAuth|mtls)/i.test(key)));
}
function validatePortableNodes(nodes: JsonObject[]) {
  if (nodes.some(n => n.transitive || n.parentGuid)) throw new HttpError(409, 'Transitive nodes must be adopted at their owning panel before migration. A parent panel cannot export their complete configuration.');
  if (nodes.some(n => n.tlsVerifyMode === 'mtls')) throw new HttpError(409, 'Node mTLS private credentials are not exportable through the panel API. Reconfigure those nodes before migration.');
  if (nodes.some(n => n.hasApiToken && !n.apiToken)) throw new HttpError(409, 'This panel hides saved node API tokens. Re-enter them in a complete JSON profile before migrating nodes.');
}
function panelCollections(d: ManagedDocument): PanelCollections {
  const saved = parseObject(d.runtime._benxPanelCollections);
  const c: PanelCollections = { format: 1, groups: objectRows(saved.groups || [], 'group'), outboundSubs: objectRows(saved.outboundSubs || [], 'outbound subscription'), subBalancers: objectRows(saved.subBalancers || [], 'subscription balancer'), fallbacks: {}, subscriptionOutbounds: objectRows(saved.subscriptionOutbounds || [], 'subscription outbound'), outboundTestUrl: String(saved.outboundTestUrl || 'https://www.google.com/generate_204') };
  for (const [id, rows] of Object.entries(parseObject(saved.fallbacks))) c.fallbacks[id] = objectRows(rows, 'fallback');
  return c;
}
export function managedPanelCollectionMutation(source: ManagedDocument, input: RemoteRequest): { document: ManagedDocument; result: JsonObject } | null {
  if (source.mode !== 'panel' || !['POST', 'DELETE'].includes(input.method)) return null;
  const path = input.path, group = path.match(/^\/panel\/api\/clients\/groups\/(create|rename|delete|bulkAdd|bulkRemove)$/), fallback = path.match(/^\/panel\/api\/inbounds\/(\d+)\/fallbacks$/), subscription = path.match(/^\/panel\/api\/(xray\/outbound-subs|sub-balancers)(?:\/(\d+)(?:\/(del|move))?)?$/);
  if (/^\/panel(?:\/api)?\/xray\/update$/.test(path)) {
    const next = reduceDocument(source, input), c = panelCollections(next.document);
    if (input.body?.outboundTestUrl !== undefined) { if (typeof input.body.outboundTestUrl !== 'string' || !/^https?:\/\//i.test(input.body.outboundTestUrl)) throw new HttpError(400, 'Use an HTTP(S) URL for outbound connection tests.'); c.outboundTestUrl = input.body.outboundTestUrl; }
    next.document.runtime._benxPanelCollections = c;
    return next;
  }
  if (!group && !fallback && !subscription) return null;
  const d = structuredClone(source), c = panelCollections(d), body = structuredClone(input.body || {});
  let result: JsonObject = { saved: true };
  if (group) {
    const action = group[1], name = String(body.name || body.group || body.oldName || ''), next = String(body.newName || '');
    const validName = (name: string) => name.length > 0 && name.length <= 256 && !Array.from(name).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
    if (action !== 'bulkRemove' && !validName(name) || action === 'rename' && !validName(next)) throw new HttpError(400, 'Give this group a valid name.');
    if (action === 'create') { if (c.groups.some(g => g.name === name)) throw new HttpError(409, 'A saved client group already has this name.'); c.groups.push({ name }); }
    else if (action === 'rename' || action === 'delete') {
      if (!c.groups.some(g => g.name === name) && !Object.values(d.state.clients).some(c => c.group === name)) throw new HttpError(404, 'Saved client group not found.');
      if (action === 'rename' && c.groups.some(g => g.name === next)) throw new HttpError(409, 'A saved client group already has this name.');
      c.groups = c.groups.filter(g => g.name !== name); if (action === 'rename') c.groups.push({ name: next });
      for (const client of Object.values(d.state.clients)) if (client.group === name) client.group = action === 'rename' ? next : '';
    } else {
      if (!Array.isArray(body.emails)) throw new HttpError(400, 'Choose client emails.');
      for (const email of body.emails) { const client = d.state.clients[String(email)]; if (!client) throw new HttpError(404, 'A selected client does not exist in the saved profile.'); client.group = action === 'bulkAdd' ? name : ''; }
      if (action === 'bulkAdd' && !c.groups.some(g => g.name === name)) c.groups.push({ name });
    }
  } else if (fallback) {
    if (!d.state.inbounds.some(i => Number(i.id) === Number(fallback[1]))) throw new HttpError(404, 'Saved master inbound not found.');
    const rows = objectRows(body.fallbacks, 'fallback');
    if (rows.some(r => !d.state.inbounds.some(i => Number(i.id) === Number(r.childId)) || Number(r.childId) === Number(fallback[1]))) throw new HttpError(400, 'Choose an existing child inbound for every fallback rule.');
    c.fallbacks[fallback[1]] = rows.map((r, i) => ({ name: '', alpn: '', path: '', dest: '', xver: 0, sortOrder: i, ...pickFields(r, fallbackFields) }));
  } else if (subscription) {
    const isOutbound = subscription[1] === 'xray/outbound-subs', rows = isOutbound ? c.outboundSubs : c.subBalancers, id = subscription[2] ? Number(subscription[2]) : Math.max(0, ...rows.map(r => Number(r.id))) + 1, previous = rows.find(r => Number(r.id) === id);
    if (subscription[2] && !previous) throw new HttpError(404, 'Saved subscription row not found.');
    if (input.method === 'DELETE' || subscription[3] === 'del') { if (isOutbound) c.outboundSubs = rows.filter(r => Number(r.id) !== id); else c.subBalancers = rows.filter(r => Number(r.id) !== id); }
    else if (subscription[3] === 'move') {
      if (!isOutbound) throw new HttpError(400, 'Only outbound subscriptions have a priority order.');
      rows.sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0) || Number(a.id) - Number(b.id)); const index = rows.indexOf(previous!), target = body.dir === 'up' ? index - 1 : index + 1;
      if (target >= 0 && target < rows.length) [rows[index], rows[target]] = [rows[target], rows[index]];
      rows.forEach((r, n) => r.priority = n);
    } else {
      const row: JsonObject = isOutbound ? { remark: '', tagPrefix: `sub${id}-`, userAgent: '3x-ui-outbound-sub/1.0', updateInterval: 600, enabled: true, allowPrivate: false, allowInsecure: false, prepend: false, ...pickFields(body, outboundSubFields), id, priority: previous?.priority ?? rows.length } : { strategy: 'random', memberWeights: {}, sortOrder: 1, enabled: previous?.enabled ?? true, ...pickFields(body, subBalancerFields), id };
      if (isOutbound) { if (typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url)) throw new HttpError(400, 'Give the outbound subscription a valid HTTP(S) URL.'); }
      else if (!row.remark || !Array.isArray(row.inboundIds) || !row.inboundIds.length || row.inboundIds.some(id => !d.state.inbounds.some(i => Number(i.id) === Number(id)))) throw new HttpError(400, 'Give the subscription balancer a remark and valid inbound members.');
      if (isOutbound) c.outboundSubs = [...rows.filter(r => Number(r.id) !== id), row]; else c.subBalancers = [...rows.filter(r => Number(r.id) !== id), row];
      result = { id };
    }
  }
  d.runtime._benxPanelCollections = c;
  return { document: validateDocument(d), result };
}
export function isManagedPanelCollectionMutation(input: RemoteRequest) {
  return ['POST', 'DELETE'].includes(input.method) && /^\/panel\/api\/(?:clients\/groups\/(?:create|rename|delete|bulkAdd|bulkRemove)|inbounds\/\d+\/fallbacks|(?:xray\/outbound-subs|sub-balancers)(?:\/\d+(?:\/(?:del|move))?)?)$/.test(input.path);
}
export function managedPanelCollectionView(d: ManagedDocument, input: RemoteRequest): unknown | undefined {
  if (d.mode !== 'panel') return undefined;
  const c = panelCollections(d), path = input.path;
  if (input.method === 'GET' && path === '/panel/api/xray/outbound-subs') return c.outboundSubs;
  if (input.method === 'GET' && path === '/panel/api/sub-balancers') return c.subBalancers;
  if (input.method === 'GET' && path === '/panel/api/clients/groups') return c.groups.map(g => ({ ...g, count: Object.values(d.state.clients).filter(client => client.group === g.name).length }));
  const fallback = path.match(/^\/panel\/api\/inbounds\/(\d+)\/fallbacks$/);
  if (input.method === 'GET' && fallback) return c.fallbacks[fallback[1]] || [];
  if (input.method === 'POST' && path === '/panel/api/xray/') return { xraySetting: JSON.stringify(d.state.xray), outboundTestUrl: c.outboundTestUrl, subscriptionOutbounds: c.subscriptionOutbounds, subscriptionOutboundTags: c.subscriptionOutbounds.map(o => o.tag) };
  return undefined;
}
export function cleanPanelCollections(d: ManagedDocument) {
  if (d.mode !== 'panel') return;
  const c = panelCollections(d), ids = new Set(d.state.inbounds.map(i => Number(i.id)));
  for (const [id, rules] of Object.entries(c.fallbacks)) { if (!ids.has(Number(id))) delete c.fallbacks[id]; else c.fallbacks[id] = rules.filter(r => ids.has(Number(r.childId))); }
  c.subBalancers = c.subBalancers.map(r => ({ ...r, inboundIds: (r.inboundIds as number[] || []).filter(id => ids.has(Number(id))), memberWeights: Object.fromEntries(Object.entries(parseObject(r.memberWeights)).filter(([id]) => ids.has(Number(id)))) })).filter(r => r.inboundIds.length);
  d.hosts = d.hosts.map(h => ({ ...h, inboundIds: (h.inboundIds as number[] || []).filter(id => ids.has(Number(id))) })).filter(h => h.inboundIds.length);
  d.runtime._benxPanelCollections = c;
}
async function readPanelCollections(env: Env, server: StoredServer, d: ManagedDocument, xray: JsonObject): Promise<PanelCollections> {
  const read = (path: string) => callRemoteJson(server, env, { path, method: 'GET' });
  const c: PanelCollections = { format: 1, groups: objectRows(await read('/panel/api/clients/groups'), 'group'), outboundSubs: objectRows(await read('/panel/api/xray/outbound-subs'), 'outbound subscription'), subBalancers: objectRows(await read('/panel/api/sub-balancers'), 'subscription balancer'), fallbacks: {}, subscriptionOutbounds: objectRows(xray.subscriptionOutbounds || [], 'subscription outbound'), outboundTestUrl: String(xray.outboundTestUrl || 'https://www.google.com/generate_204') };
  const masters = new Set(d.state.inbounds.filter(i => ['vless', 'trojan'].includes(String(i.protocol)) && ['tcp', 'raw'].includes(String(parseObject(i.streamSettings).network || 'tcp')) && ['tls', 'reality'].includes(String(parseObject(i.streamSettings).security))).map(i => Number(i.id)));
  for (const i of d.state.inbounds) { const parent = parseObject(i.fallbackParent); if (parent.masterId) masters.add(Number(parent.masterId)); }
  for (const id of masters) c.fallbacks[String(id)] = objectRows(await read(`/panel/api/inbounds/${id}/fallbacks`), 'fallback');
  return c;
}
export async function remoteDocument(env: Env, server: StoredServer): Promise<ManagedDocument> {
  if (server.kind === 'server') return validateDocument(await callRemoteJson(server, env, { path: '/benx/v1/control/export', method: 'GET' }));
  const d = emptyDocument(); d.mode = 'panel'; d.setup.panel = '3x-ui'; d.setup.cores = []; d.setup.bbr = false;
  const prefix = `/panel${server.version === 'v3' ? '/api' : ''}`;
  const inbounds = await callRemoteJson(server, env, { path: '/panel/api/inbounds/list', method: 'GET' });
  const inboundRows = objectRows(inbounds, 'inbound');
  d.state.inbounds = inboundRows.map(i => { const row = { ...i }, settings = { ...parseObject(row.settings) }; delete row.clientStats; delete settings.clients; row.settings = settings; return row; });
  d.state.nextId = Math.max(0, ...d.state.inbounds.map(i => Number(i.id))) + 1;
  if (server.version === 'v3') {
    const clients = await callRemoteJson(server, env, { path: '/panel/api/clients/export', method: 'GET' });
    for (const row of objectRows(clients, 'client')) {
      const c = parseObject(row.client || row), email = String(c.email || '');
      const detail = parseObject(await callRemoteJson(server, env, { path: `/panel/api/clients/get/${encodeURIComponent(email)}`, method: 'GET' }));
      const addresses = parseObject(detail.tunnelAllowedIPs);
      d.state.clients[email] = { ...clientPayload({ ...parseObject(detail.client), ...c }), inboundIds: row.inboundIds || detail.inboundIds || [], externalLinks: externalLinks(detail.externalLinks || []), ...(Object.keys(addresses).length ? { allowedIPsByInbound: Object.fromEntries(Object.entries(addresses).map(([id, value]) => [id, Array.isArray(value) ? value : String(value).split(',').map(v => v.trim()).filter(Boolean)])) } : {}) };
      d.runtime[email] = reportedClientTraffic(row) ?? reportedClientTraffic(detail) ?? {};
    }
    // Nodes/hosts must be readable in full, otherwise there is no complete migration.
    d.nodes = objectRows(await callRemoteJson(server, env, { path: '/panel/api/nodes/list', method: 'GET' }), 'node');
    d.hosts = objectRows(await callRemoteJson(server, env, { path: '/panel/api/hosts/list', method: 'GET' }), 'host').map(h => ({ ...h, id: h.groupId || h.id }));
    validatePortableNodes(d.nodes);
  } else for (const i of inboundRows) for (const raw of parseObject(i.settings).clients as JsonObject[] || []) {
    const email = String(raw.email || ''), old = d.state.clients[email];
    if (old && ['id', 'password', 'auth', 'secret', 'subId'].some(k => old[k] && raw[k] && old[k] !== raw[k])) throw new HttpError(409, 'Legacy clients with the same email have different credentials. Give those identities unique names before importing into shared clients.');
    d.state.clients[email] = { ...clientPayload(raw), ...old, email, inboundIds: [...(old?.inboundIds as number[] || []), Number(i.id)] };
    const stats = (Array.isArray(i.clientStats) ? i.clientStats : []).find((c: JsonObject) => c.email === email);
    if (stats && !d.runtime[email]) d.runtime[email] = { up: stats.up || 0, down: stats.down || 0, resetCount: stats.resetCount || 0, lastOnline: stats.lastOnline || 0 };
  }
  validatePortablePeerIdentities(inboundRows, d.state.clients);
  d.runtime._benxPanelActivation = Object.fromEntries(Object.entries(d.state.clients).filter(([, c]) => Number(c.expiryTime) < 0).map(([email, c]) => [email, { duration: Number(c.expiryTime) }]));
  d.settings = portableSettings(parseObject(await callRemoteJson(server, env, { path: prefix + '/setting/all', method: 'POST' })));
  const xray = parseObject(await callRemoteJson(server, env, { path: prefix + '/xray/', method: 'POST' }));
  d.state.xray = parseObject(xray.xraySetting);
  if (!Object.keys(d.state.xray).length) throw new HttpError(502, 'Panel global configuration is unavailable. Import cancelled.');
  const binding = bindingFor(d, server.id);
  for (const i of d.state.inbounds) binding.inbounds[String(i.id)] = Number(i.id);
  for (const n of d.nodes) { binding.nodes[String(n.id)] = Number(n.id); if (n.guid) binding.nodeGuids[String(n.guid)] = String(n.guid); }
  for (const h of d.hosts) binding.hosts[String(h.id)] = String(h.groupId || h.id);
  if (server.version === 'v3') {
    const collections = await readPanelCollections(env, server, d, xray);
    d.runtime._benxPanelCollections = collections;
    for (const row of collections.outboundSubs) binding.outboundSubs[String(row.id)] = Number(row.id);
    for (const row of collections.subBalancers) binding.subBalancers[String(row.id)] = Number(row.id);
  }
  d.runtime._benxPanelBinding = binding;
  d.runtime._benxPanelSourceVersion = server.version;
  return validateDocument(d);
}
export async function adoptServer(env: Env, server: StoredServer) {
  let row = await managedRow(env, server.id);
  if (!row) {
    const document = await remoteDocument(env, server);
    const policy = await env.DB.prepare('SELECT data FROM server_policy WHERE server_id=?').bind(server.id).first<{ data: string }>();
    if (policy) document.policy = validatePolicy(JSON.parse(policy.data));
    await createManaged(env, server.id, document);
    row = (await managedRow(env, server.id))!;
  }
  return row;
}
export async function managedRequest(env: Env, server: StoredServer, input: RemoteRequest): Promise<{ obj: unknown; revision: number; pending: boolean; mutated?: boolean } | null> {
  let row = await managedRow(env, server.id);
  if (!row && !isManagedMutation(input) && !isManagedPanelCollectionMutation(input)) return null;
  row ||= await adoptServer(env, server);
  const document = await savedDocument(env, row);
  if (!isManagedMutation(input) && !isManagedPanelCollectionMutation(input)) {
    if(document.mode === 'native' && row.bound && row.phase === 'synced' && row.applied_revision === row.revision && input.method === 'GET' && /^\/panel\/api\/clients\/get\/[^/]+$/.test(input.path)) {
      const client = document.state.clients[decodeURIComponent(input.path.split('/').at(-1)!)];
      if(Number(client?.expiryTime)<0) return null; // An opened client editor reads its activation deadline directly; no background polling.
    }
    const view = managedPanelCollectionView(document, input) ?? configurationView(document, input);
    if (view === null) throw new HttpError(404, 'This item is not in the saved configuration.');
    return view === undefined ? null : { obj: view, revision: row.revision, pending: row.phase !== 'synced' || row.applied_revision < row.revision };
  }
  let next: ReturnType<typeof reduceDocument>;
  try {
    const normalized = document.mode === 'native' && /^\/panel\/api\/inbounds\/(add|update\/\d+)$/.test(input.path) && input.method === 'POST' ? { ...input, body: withDefaultPublicHost(parseObject(input.body), server.url) } : input;
    next = managedPanelCollectionMutation(document, normalized) || reduceDocument(document, normalized);
    if (next.document.mode === 'panel') cleanPanelCollections(next.document);
  } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (JSON.stringify(next.document) === JSON.stringify(document)) return { obj: next.result, revision: row.revision, pending: row.phase !== 'synced' || row.applied_revision !== row.revision, mutated: true };
  const revision = await saveManaged(env, row, next.document);
  return { obj: next.result, revision, pending: true, mutated: true };
}
// Bot provisioning uses the same intent store. Delivery waits for the applied revision.
export async function provisioningRequest(server: StoredServer, env: Env, input: RemoteRequest): Promise<unknown> {
  const row = await managedRow(env, server.id);
  if (!row) return callRemoteJson(server, env, input);
  const saved = await managedRequest(env, server, input);
  if (saved && (isManagedMutation(input) || isManagedPanelCollectionMutation(input))) {
    await reconcileServer(env, server, undefined, true);
    const current = await managedRow(env, server.id);
    if (current?.phase !== 'synced' || current.applied_revision !== current.revision) throw new HttpError(502, 'The configuration is saved, but the server has not confirmed it yet. Delivery will retry automatically.');
  }
  if (saved) return saved.obj;
  const d = await savedDocument(env, row);
  if (isUnsupportedPanelMutation(input)) throw new HttpError(409, 'This operation cannot bypass the saved configuration.');
  const result = await callRemoteJson(server, env, d.mode === 'panel' ? translatePanelRequest(d, server.id, input) : input);
  return d.mode === 'panel' ? translatePanelResponse(d, server.id, input, result) : result;
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + stable(v)).join(',') + '}';
  return JSON.stringify(value);
}
function matchesDesired(actual: unknown, desired: unknown): boolean {
  if (Array.isArray(desired)) return Array.isArray(actual) && stable(actual) === stable(desired);
  if (desired && typeof desired === 'object') { const row = parseObject(actual); return Object.entries(desired).filter(([, v]) => v !== undefined).every(([key, v]) => ['inboundIds', 'nodeGuids', 'inboundTags'].includes(key) && Array.isArray(v) ? Array.isArray(row[key]) && stable((row[key] as unknown[]).map(stable).sort()) === stable(v.map(stable).sort()) : matchesDesired(row[key], v)); }
  return stable(actual) === stable(desired);
}
function inboundPayload(raw: JsonObject, nodeId: number | undefined): JsonObject {
  const row = { ...raw, settings: { ...parseObject(raw.settings) }, streamSettings: parseObject(raw.streamSettings), sniffing: parseObject(raw.sniffing), nodeId: nodeId || null };
  delete row.settings.clients;
  for (const key of ['id', 'userId', 'clientStats', 'up', 'down', 'createdAt', 'updatedAt', 'lastTrafficResetTime', 'nodeAddress', 'nodeRemark', 'nodeStatus', 'originNodeGuid', 'fallbackParent', '_benxApiPort']) delete (row as JsonObject)[key];
  return row;
}
const nodeFields = ['name', 'remark', 'scheme', 'address', 'port', 'basePath', 'apiToken', 'clearApiToken', 'enable', 'allowPrivateAddress', 'tlsVerifyMode', 'pinnedCertSha256', 'inboundSyncMode', 'inboundTags', 'outboundTag'];
function nodePayload(raw: JsonObject): JsonObject { return Object.fromEntries(nodeFields.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])); }
async function tokenHash(token: unknown) { return token ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(token))))).map(b => b.toString(16).padStart(2, '0')).join('') : ''; }
function mappedIds(ids: unknown, mapping: Record<string, number>, subject: string): number[] {
  if (!Array.isArray(ids)) throw new HttpError(409, `Saved ${subject} has invalid inbound attachments.`);
  return ids.map(id => { const mapped = mapping[String(id)]; if (!mapped) throw new HttpError(409, `Saved ${subject} references an inbound that has not been restored.`); return mapped; });
}
function translateReferences(value: unknown, binding: PanelBinding): unknown {
  if (Array.isArray(value)) return value.map(v => translateReferences(v, binding));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => {
    if (key === 'nodeId' && v) { const id = binding.nodes[String(v)]; if (!id) throw new HttpError(409, 'Saved configuration refers to a node that has not been restored.'); return [key, id]; }
    if (key === 'nodeGuids' && Array.isArray(v)) return [key, v.map(guid => { const mapped = binding.nodeGuids[String(guid)]; if (!mapped) throw new HttpError(409, 'Saved configuration references a node GUID that is unavailable at the destination.'); return mapped; })];
    if (['allowedIPsByInbound', 'memberWeights'].includes(key)) return [key, Object.fromEntries(Object.entries(parseObject(v)).map(([id, ips]) => { const remoteId = binding.inbounds[id]; if (!remoteId) throw new HttpError(409, 'Saved inbound-specific rule refers to an inbound that has not been restored.'); return [remoteId, ips]; }))];
    return [key, translateReferences(v, binding)];
  }));
}
export function translatePanelRequest(d: ManagedDocument, serverId: string, input: RemoteRequest): RemoteRequest {
  const binding = bindingFor(d, serverId), path = input.path;
  const translate = (group: 'inbounds' | 'nodes' | 'hosts' | 'outboundSubs' | 'subBalancers', id: string) => { const mapped = binding[group][decodeURIComponent(id)]; if (!mapped) throw new HttpError(409, 'This saved resource has not been confirmed on the server. Synchronize it before using live actions.'); return encodeURIComponent(String(mapped)); };
  let nextPath = path.replace(/^\/panel\/api\/inbounds\/(get|update|del|setEnable|resetAllClientTraffics)\/([^/]+)(?=\/|$)/, (_, action, id) => `/panel/api/inbounds/${action}/${translate('inbounds', id)}`);
  nextPath = nextPath.replace(/^\/panel\/api\/inbounds\/([^/]+)\/(subSortIndex|resetTraffic|delAllClients|fallbacks)$/, (_, id, action) => `/panel/api/inbounds/${translate('inbounds', id)}/${action}`);
  nextPath = nextPath.replace(/^\/panel\/api\/nodes\/(get|update|del|setEnable|probe|webCert|history)\/([^/]+)(?=\/|$)/, (_, action, id) => `/panel/api/nodes/${action}/${translate('nodes', id)}`);
  nextPath = nextPath.replace(/^\/panel\/api\/hosts\/(get|update|del|setEnable)\/([^/]+)(?=\/|$)/, (_, action, id) => `/panel/api/hosts/${action}/${translate('hosts', id)}`);
  nextPath = nextPath.replace(/^\/panel\/api\/hosts\/byInbound\/([^/]+)$/, (_, id) => `/panel/api/hosts/byInbound/${translate('inbounds', id)}`);
  nextPath = nextPath.replace(/^\/panel\/api\/xray\/outbound-subs\/(\d+)(?=\/|$)/, (_, id) => `/panel/api/xray/outbound-subs/${translate('outboundSubs', id)}`);
  nextPath = nextPath.replace(/^\/panel\/api\/sub-balancers\/(\d+)(?=\/|$)/, (_, id) => `/panel/api/sub-balancers/${translate('subBalancers', id)}`);
  const body = input.body ? { ...input.body } : undefined, query = input.query ? { ...input.query } : undefined;
  if (body?.inboundIds) body.inboundIds = mappedIds(body.inboundIds, binding.inbounds, 'request');
  if (body?.inboundId) body.inboundId = Number(translate('inbounds', String(body.inboundId)));
  if (body?.nodeId) body.nodeId = Number(translate('nodes', String(body.nodeId)));
  if (/\/nodes\/(updatePanel)$/.test(path) && Array.isArray(body?.ids)) body!.ids = body!.ids.map(id => Number(translate('nodes', String(id))));
  if (/\/hosts\/(reorder|bulk\/(setEnable|del))$/.test(path) && Array.isArray(body?.groupIds)) body!.groupIds = body!.groupIds.map(id => decodeURIComponent(translate('hosts', String(id))));
  if (path === '/panel/api/inbounds/bulkDel' && Array.isArray(body?.ids)) body!.ids = body!.ids.map(id => Number(translate('inbounds', String(id))));
  if (query?.inboundIds) query.inboundIds = query.inboundIds.split(',').map(id => translate('inbounds', id)).join(',');
  return { ...input, path: nextPath, ...(body ? { body } : {}), ...(query ? { query } : {}) };
}
export function translatePanelResponse(d: ManagedDocument, serverId: string, input: RemoteRequest, value: unknown): unknown {
  const binding = bindingFor(d, serverId), inverse = (group: 'inbounds' | 'nodes' | 'hosts' | 'outboundSubs' | 'subBalancers', id: unknown) => Object.entries(binding[group]).find(([, remote]) => String(remote) === String(id))?.[0];
  const group = input.path.startsWith('/panel/api/inbounds/') && !input.path.endsWith('/fallbacks') ? 'inbounds' : input.path.startsWith('/panel/api/nodes/') ? 'nodes' : input.path.startsWith('/panel/api/hosts/') ? 'hosts' : input.path.startsWith('/panel/api/xray/outbound-subs') ? 'outboundSubs' : input.path.startsWith('/panel/api/sub-balancers') ? 'subBalancers' : undefined;
  const walk = (raw: unknown, resource = false): unknown => {
    if (Array.isArray(raw)) return raw.map(v => walk(v, resource));
    if (!raw || typeof raw !== 'object') return raw;
    const row = raw as JsonObject;
    if ('obj' in row && ('success' in row || 'msg' in row)) return { ...row, obj: walk(row.obj, true) };
    return Object.fromEntries(Object.entries(row).map(([key, v]) => {
      if (resource && key === 'id' && group && group !== 'hosts') { const id = inverse(group, v); return [key, id ? Number(id) : v]; }
      if (resource && key === 'groupId' && group === 'hosts') return [key, inverse('hosts', v) || v];
      if (['inboundId', 'childId', 'masterId'].includes(key)) { const id = inverse('inbounds', v); return [key, id ? Number(id) : v]; }
      if (key === 'nodeId') { const id = inverse('nodes', v); return [key, id ? Number(id) : v]; }
      if (key === 'inboundIds' && Array.isArray(v)) return [key, v.map(id => Number(inverse('inbounds', id) || id))];
      if (['memberWeights', 'allowedIPsByInbound', 'tunnelAllowedIPs'].includes(key)) return [key, Object.fromEntries(Object.entries(parseObject(v)).map(([id, value]) => [inverse('inbounds', id) || id, value]))];
      if (key === 'nodeGuids' && Array.isArray(v)) return [key, v.map(guid => Object.entries(binding.nodeGuids).find(([, remote]) => remote === guid)?.[0] || guid)];
      return [key, walk(v, resource && ['items', 'rows', 'data'].includes(key))];
    }));
  };
  return walk(value, true);
}
export function isUnsupportedPanelMutation(input: RemoteRequest): boolean {
  if (input.method === 'GET' || isManagedMutation(input) || isManagedPanelCollectionMutation(input)) return false;
  const path = input.path;
  // Read/probe operations and explicitly transient counters may execute without changing the profile.
  return !/^(?:\/panel(?:\/api)?\/xray\/$|\/panel(?:\/api)?\/setting\/(?:all|defaultSettings|factoryDefaults|validateRegex|restartPanel|testSmtp|testTgBot|testDiscord)$|\/panel(?:\/api)?\/xray\/(?:resetOutboundsTraffic|testOutbound|testOutbounds|balancerStatus|balancerOverride|routeTest|geodata\/validate|outbound-subs\/parse)$|\/panel\/api\/server\/(?:logs\/\d+|xraylogs\/\d+|amneziawglogs\/\d+|getNewEchCert|getCertHash|getRemoteCertHash|scanRealityTarget|scanRealityTargets|clientIps)$|\/panel\/api\/nodes\/(?:probe\/\d+|test|certFingerprint|inbounds)$|\/panel\/api\/inbounds\/(?:\d+\/resetTraffic|resetAllTraffics)$|\/panel\/api\/clients\/(?:renewalPreview|resetAllTraffics|bulkResetTraffic|groups\/resetTraffic|resetTraffic\/[^/]+|updateTraffic\/[^/]+|ips\/[^/]+|clearIps\/[^/]+|hwids\/[^/]+(?:\/[^/]+)?|onlines|onlinesByGuid|clientIpsByGuid|activeInbounds|lastOnline|happLink\/[^/]+)$|\/panel\/api\/backuptotgbot$)/.test(path);
}
const outboundSubFields = ['remark', 'url', 'tagPrefix', 'userAgent', 'updateInterval', 'enabled', 'allowPrivate', 'allowInsecure', 'prepend'];
const subBalancerFields = ['remark', 'strategy', 'inboundIds', 'memberWeights', 'sortOrder', 'enabled'];
const fallbackFields = ['childId', 'name', 'alpn', 'path', 'dest', 'xver', 'sortOrder'];
function pickFields(raw: JsonObject, fields: string[]) { return Object.fromEntries(fields.filter(k => raw[k] !== undefined).map(k => [k, raw[k]])); }
async function applyPanelCollections(d: ManagedDocument, binding: PanelBinding, request: (path: string, method?: string, body?: JsonObject) => Promise<unknown>) {
  const c = panelCollections(d), readRows = async (path: string, label: string) => objectRows(await request(path), label);
  const names = new Set([...c.groups.map(g => String(g.name)), ...Object.values(d.state.clients).filter(c => c.group).map(c => String(c.group))]);
  let groups = await readRows('/panel/api/clients/groups', 'group');
  for (const name of names) if (!groups.some(g => g.name === name)) await request('/panel/api/clients/groups/create', 'POST', { name });
  for (const g of groups) if (!names.has(String(g.name))) await request('/panel/api/clients/groups/delete', 'POST', { name: g.name });
  groups = await readRows('/panel/api/clients/groups', 'group');
  if (stable(groups.map(g => String(g.name)).sort()) !== stable([...names].sort())) throw new HttpError(409, 'The panel has not confirmed every saved client group.');
  const liveSubs = await readRows('/panel/api/xray/outbound-subs', 'outbound subscription'), keptSubs = new Set<number>(), desiredOrder: number[] = [];
  for (const raw of c.outboundSubs.slice().sort((a, b) => Number(a.priority || 0) - Number(b.priority || 0) || Number(a.id) - Number(b.id))) {
    const id = String(raw.id), wanted = pickFields(raw, outboundSubFields);
    let current = liveSubs.find(row => Number(row.id) === binding.outboundSubs[id]) || liveSubs.find(row => row.tagPrefix === wanted.tagPrefix && row.url === wanted.url);
    let changed = false;
    if (!current || !matchesDesired(current, wanted)) {
      const created = parseObject(await request(`/panel/api/xray/outbound-subs${current ? `/${current.id}` : ''}`, 'POST', wanted));
      current = created.id ? created : (await readRows('/panel/api/xray/outbound-subs', 'outbound subscription')).find(row => row.tagPrefix === wanted.tagPrefix && row.url === wanted.url);
      changed = true;
    }
    if (!current?.id) throw new HttpError(502, 'The panel did not confirm an outbound subscription identity.');
    binding.outboundSubs[id] = Number(current.id); keptSubs.add(Number(current.id)); desiredOrder.push(Number(current.id));
    // This API exports URLs but hides its per-link tag cache. A replacement must re-fetch the provider.
    if (wanted.enabled !== false && (changed || Number(raw.outboundCount || 0) > 0 && !Number(current.outboundCount || 0))) await request(`/panel/api/xray/outbound-subs/${current.id}/refresh`, 'POST');
  }
  for (const row of liveSubs) if (!keptSubs.has(Number(row.id))) await request(`/panel/api/xray/outbound-subs/${row.id}/del`, 'POST');
  let ordered = await readRows('/panel/api/xray/outbound-subs', 'outbound subscription');
  for (let target = 0; target < desiredOrder.length; target++) {
    let index = ordered.findIndex(row => Number(row.id) === desiredOrder[target]);
    if (index < 0) throw new HttpError(409, 'The panel did not confirm its complete outbound subscription list.');
    while (index > target) { await request(`/panel/api/xray/outbound-subs/${desiredOrder[target]}/move`, 'POST', { dir: 'up' }); [ordered[index], ordered[index - 1]] = [ordered[index - 1], ordered[index]]; index--; }
  }
  ordered = await readRows('/panel/api/xray/outbound-subs', 'outbound subscription');
  if (stable(ordered.map(row => Number(row.id))) !== stable(desiredOrder) || c.outboundSubs.some(raw => { const actual = ordered.find(row => Number(row.id) === binding.outboundSubs[String(raw.id)]); return !actual || !matchesDesired(actual, pickFields(raw, outboundSubFields)) || raw.enabled !== false && Number(raw.outboundCount || 0) > 0 && !Number(actual.outboundCount || 0); })) throw new HttpError(409, 'The panel has not confirmed its outbound subscriptions, priority or fetched provider configurations.');
  const liveBalancers = await readRows('/panel/api/sub-balancers', 'subscription balancer'), keptBalancers = new Set<number>();
  for (const raw of c.subBalancers) {
    const id = String(raw.id), wanted = translateReferences({ ...pickFields(raw, subBalancerFields), inboundIds: mappedIds(raw.inboundIds, binding.inbounds, 'subscription balancer') }, binding) as JsonObject;
    let current = liveBalancers.find(row => Number(row.id) === binding.subBalancers[id]) || liveBalancers.find(row => row.remark === raw.remark);
    if (!current || !matchesDesired(current, wanted)) { const created = parseObject(await request(`/panel/api/sub-balancers${current ? `/${current.id}` : ''}`, 'POST', wanted)); current = created.id ? created : (await readRows('/panel/api/sub-balancers', 'subscription balancer')).find(row => row.remark === raw.remark); }
    if (!current?.id || keptBalancers.has(Number(current.id))) throw new HttpError(409, 'Subscription balancers need unique remarks to retain their identities during recovery.');
    binding.subBalancers[id] = Number(current.id); keptBalancers.add(Number(current.id));
  }
  for (const row of liveBalancers) if (!keptBalancers.has(Number(row.id))) await request(`/panel/api/sub-balancers/${row.id}/del`, 'POST');
  const confirmedBalancers = await readRows('/panel/api/sub-balancers', 'subscription balancer');
  if (confirmedBalancers.length !== c.subBalancers.length || c.subBalancers.some(raw => !matchesDesired(confirmedBalancers.find(row => Number(row.id) === binding.subBalancers[String(raw.id)]), translateReferences({ ...pickFields(raw, subBalancerFields), inboundIds: mappedIds(raw.inboundIds, binding.inbounds, 'subscription balancer') }, binding)))) throw new HttpError(409, 'The panel has not confirmed its subscription balancers and member weights.');
  for (const i of d.state.inbounds) {
    if (!(String(i.id) in c.fallbacks)) continue;
    const remoteId = binding.inbounds[String(i.id)], path = `/panel/api/inbounds/${remoteId}/fallbacks`;
    const wanted = c.fallbacks[String(i.id)].map(raw => ({ ...pickFields(raw, fallbackFields), childId: mappedIds([raw.childId], binding.inbounds, 'fallback')[0] }));
    const actual = (await readRows(path, 'fallback')).map(raw => pickFields(raw, fallbackFields));
    if (!matchesDesired(actual, wanted)) await request(path, 'POST', { fallbacks: wanted });
    if (!matchesDesired((await readRows(path, 'fallback')).map(raw => pickFields(raw, fallbackFields)), wanted)) throw new HttpError(409, 'The panel has not confirmed saved fallback routing and child attachments.');
  }
  d.runtime._benxPanelCollections = c;
  return c;
}
export async function applyPanel(env: Env, server: StoredServer, d: ManagedDocument) {
  if (server.version !== 'v3') throw new HttpError(409, 'Authoritative recovery requires 3X-UI 3.x. Legacy 2.x can be imported into 3.x but cannot retain detached clients and shared accounting through its API.');
  validatePortableNodes(d.nodes);
  validatePortablePeerIdentities(d.state.inbounds, d.state.clients);
  const activation = parseObject(d.runtime._benxPanelActivation);
  const binding = bindingFor(d, server.id), request = (path: string, method = 'GET', body?: JsonObject) => callRemoteJson(server, env, { path, method, ...(body ? { body } : {}) });
  // Restore node identities first: inbound.nodeId, host nodeGuids and routing may reference them.
  const liveNodes = objectRows(await request('/panel/api/nodes/list'), 'node'), keptNodes = new Set<number>();
  for (const raw of d.nodes) {
    const logicalId = String(raw.id), wanted = nodePayload(raw), hash = await tokenHash(wanted.apiToken);
    let current = liveNodes.find(n => Number(n.id) === binding.nodes[logicalId]) || liveNodes.find(n => n.name === wanted.name);
    const comparison = { ...wanted }; delete comparison.apiToken; delete comparison.clearApiToken;
    if (!current || !matchesDesired(current, comparison) || binding.nodeTokenHashes[logicalId] !== hash) {
      const made = parseObject(await request(`/panel/api/nodes/${current ? `update/${current.id}` : 'add'}`, 'POST', wanted));
      current = made.id ? made : objectRows(await request('/panel/api/nodes/list'), 'node').find(n => n.name === wanted.name);
    }
    if (!current?.id) throw new HttpError(502, 'Could not confirm the restored panel node.');
    binding.nodes[logicalId] = Number(current.id); binding.nodeTokenHashes[logicalId] = hash; keptNodes.add(Number(current.id));
    if (raw.guid) { if (!current.guid) current = { ...current, ...parseObject(await request(`/panel/api/nodes/get/${current.id}`)) }; if (!current.guid) throw new HttpError(502, 'The destination node did not expose its stable GUID.'); binding.nodeGuids[String(raw.guid)] = String(current.guid); }
  }
  const live = objectRows(await request('/panel/api/inbounds/list'), 'inbound'), keptInbounds = new Set<number>();
  for (const inbound of d.state.inbounds) {
    const nodeId = inbound.nodeId ? binding.nodes[String(inbound.nodeId)] : undefined;
    if (inbound.nodeId && !nodeId) throw new HttpError(409, 'Restore this inbound’s owning node before applying it.');
    const wanted: JsonObject = { ...inboundPayload(inbound, nodeId), tag: inbound.tag || `benx-inbound-${inbound.id}` };
    let current = live.find(i => Number(i.id) === binding.inbounds[String(inbound.id)]) || live.find(i => i.tag === wanted.tag) || live.find(i => Number(i.port) === Number(wanted.port) && Number(i.nodeId || 0) === Number(nodeId || 0));
    if (current && Number(current.nodeId || 0) !== Number(nodeId || 0)) throw new HttpError(409, '3X-UI cannot move an existing inbound between hosting nodes. Create the inbound on the desired node and attach its clients there.');
    if (!current) {
      const made = parseObject(await request('/panel/api/inbounds/add', 'POST', { ...wanted, settings: { ...parseObject(wanted.settings), clients: [] } }));
      current = made.id ? made : objectRows(await request('/panel/api/inbounds/list'), 'inbound').find(i => i.tag === wanted.tag && Number(i.nodeId || 0) === Number(nodeId || 0));
    } else {
      const comparison = { ...wanted }; delete comparison.enable;
      if (!matchesDesired(inboundPayload(current, Number(current.nodeId) || undefined), comparison)) await request(`/panel/api/inbounds/update/${current.id}`, 'POST', { ...wanted, id: current.id });
      // 3X-UI's update endpoint deliberately ignores enable.
      if (current.enable !== wanted.enable) await request(`/panel/api/inbounds/setEnable/${current.id}`, 'POST', { enable: wanted.enable });
    }
    if (!current?.id || keptInbounds.has(Number(current.id))) throw new HttpError(502, 'Could not uniquely confirm a restored panel inbound.');
    binding.inbounds[String(inbound.id)] = Number(current.id); keptInbounds.add(Number(current.id));
  }
  for (const row of live) if (!keptInbounds.has(Number(row.id))) await request(`/panel/api/inbounds/del/${row.id}`, 'POST');
  const collections = await applyPanelCollections(d, binding, request);
  const liveClients = objectRows(await request('/panel/api/clients/export'), 'client');
  const missing = Object.entries(d.state.clients).filter(([email]) => !liveClients.some(r => parseObject(r.client || r).email === email)).map(([email, c]) => ({ client: translateReferences(effectiveClient(c, d.runtime[email], activation[email]), binding), inboundIds: mappedIds(c.inboundIds, binding.inbounds, 'client'), traffic: d.runtime[email] }));
  if (missing.length) {
    const result = parseObject(await request('/panel/api/clients/import', 'POST', { data: JSON.stringify(missing) }));
    if (Array.isArray(result.skipped) && result.skipped.length) throw new HttpError(409, 'A restored client was skipped by the remote panel. Refresh and retry before treating this server as synchronized.');
  }
  for (const [email, raw] of Object.entries(d.state.clients)) {
    const ids = mappedIds(raw.inboundIds, binding.inbounds, 'client'), encoded = encodeURIComponent(email), prior = liveClients.find(r => parseObject(r.client || r).email === email), wanted = translateReferences(effectiveClient(raw, reportedClientTraffic(prior ?? {}) ?? d.runtime[email], activation[email]), binding) as JsonObject;
    const detail = Object.keys(parseObject(raw.allowedIPsByInbound)).length || raw.externalLinks !== undefined ? parseObject(await request(`/panel/api/clients/get/${encoded}`)) : {};
    if (prior) {
      if (!matchesDesired(clientComparable(parseObject(prior.client || prior)), clientComparable(wanted)) || !hasTunnelAddresses(detail, raw, binding)) await request(`/panel/api/clients/update/${encoded}`, 'POST', wanted);
      const previousIds = Array.isArray(prior.inboundIds) ? prior.inboundIds as number[] : [], attach = ids.filter(id => !previousIds.includes(id)), detach = previousIds.filter(id => !ids.includes(id));
      if (attach.length) await request(`/panel/api/clients/${encoded}/attach`, 'POST', { inboundIds: attach });
      if (detach.length) await request(`/panel/api/clients/${encoded}/detach`, 'POST', { inboundIds: detach });
    }
    if (raw.externalLinks !== undefined) {
      raw.externalLinks = externalLinks(raw.externalLinks);
      if (stable(externalLinks(detail.externalLinks || [])) !== stable(raw.externalLinks)) await request(`/panel/api/clients/${encoded}/externalLinks`, 'POST', { externalLinks: raw.externalLinks });
    }
  }
  for (const r of liveClients) { const email = String(parseObject(r.client || r).email); if (!d.state.clients[email]) await request('/panel/api/clients/del/' + encodeURIComponent(email), 'POST'); }
  const hosts = objectRows(await request('/panel/api/hosts/list'), 'host'), keptHosts = new Set<string>();
  for (const raw of d.hosts) {
    const logicalId = String(raw.id || raw.groupId), groupId = binding.hosts[logicalId] || String(raw.groupId || logicalId), wanted = translateReferences({ ...raw, groupId, inboundIds: mappedIds(raw.inboundIds, binding.inbounds, 'host group') }, binding) as JsonObject;
    delete wanted.id;
    const current = hosts.find(h => String(h.groupId || h.id) === groupId);
    if (!current || !matchesDesired(current, wanted)) await request(`/panel/api/hosts/${current ? `update/${encodeURIComponent(groupId)}` : 'add'}`, 'POST', wanted);
    binding.hosts[logicalId] = groupId; keptHosts.add(groupId);
  }
  for (const row of hosts) { const id = String(row.groupId || row.id); if (!keptHosts.has(id)) await request(`/panel/api/hosts/del/${encodeURIComponent(id)}`, 'POST'); }
  for (const row of liveNodes) if (!keptNodes.has(Number(row.id))) await request(`/panel/api/nodes/del/${row.id}`, 'POST');
  const desiredXray = translateReferences(d.state.xray, binding) as JsonObject;
  const config = parseObject(parseObject(await request('/panel/api/xray/', 'POST')).xraySetting);
  if (stable(config) !== stable(desiredXray)) await request('/panel/api/xray/update', 'POST', { xraySetting: JSON.stringify(desiredXray), outboundTestUrl: collections.outboundTestUrl });
  const settings = parseObject(await request('/panel/api/setting/all', 'POST')), portable = portableSettings(d.settings);
  if (!matchesDesired(settings, portable)) await request('/panel/api/setting/update', 'POST', { ...settings, ...portable });
  // Read back actual saved configuration before reporting success; a successful write alone is insufficient.
  const confirmedInbounds = objectRows(await request('/panel/api/inbounds/list'), 'inbound');
  if (confirmedInbounds.length !== d.state.inbounds.length || d.state.inbounds.some(i => { const live = confirmedInbounds.find(n => Number(n.id) === binding.inbounds[String(i.id)]); return !live || !matchesDesired(inboundPayload(live, Number(live.nodeId) || undefined), { ...inboundPayload(i, i.nodeId ? binding.nodes[String(i.nodeId)] : undefined), tag: i.tag || `benx-inbound-${i.id}` }); })) throw new HttpError(409, 'The panel has not confirmed every saved inbound and its enabled state.');
  d.runtime._inboundTraffic = Object.fromEntries(d.state.inbounds.map(i => { const live = confirmedInbounds.find(n => Number(n.id) === binding.inbounds[String(i.id)])!; return [String(i.id), { up: Number(live.up || 0), down: Number(live.down || 0) }]; }));
  const confirmedClients = objectRows(await request('/panel/api/clients/export'), 'client');
  if (confirmedClients.length !== Object.keys(d.state.clients).length) throw new HttpError(409, 'The panel has not confirmed the complete saved client list.');
  for (const [email, c] of Object.entries(d.state.clients)) {
    const actual = confirmedClients.find(r => parseObject(r.client || r).email === email), traffic = reportedClientTraffic(actual ?? {}) ?? d.runtime[email], desired = translateReferences(effectiveClient(c, traffic, activation[email]), binding) as JsonObject;
    const actualFields = clientComparable(parseObject(actual?.client || actual)), desiredFields = clientComparable(desired);
    const differentFields = Object.keys(desiredFields).filter(key => !matchesDesired(actualFields[key], desiredFields[key])).filter(key => /^[a-zA-Z][a-zA-Z0-9]{0,40}$/.test(key));
    const attachmentsMatch = actual && stable((actual.inboundIds as number[] || []).slice().sort((a, b) => a - b)) === stable(mappedIds(c.inboundIds, binding.inbounds, 'client').sort((a, b) => a - b));
    if (!actual || differentFields.length || !attachmentsMatch) throw new HttpError(409, `The panel has not confirmed every client credential and inbound attachment. Review: ${!actual ? 'missing client' : [...differentFields, ...(!attachmentsMatch ? ['inbound attachments'] : [])].join(', ')}.`);
    if (Object.keys(parseObject(c.allowedIPsByInbound)).length || c.externalLinks !== undefined) {
      const detail = parseObject(await request(`/panel/api/clients/get/${encodeURIComponent(email)}`));
      if (!hasTunnelAddresses(detail, c, binding) || c.externalLinks !== undefined && stable(externalLinks(detail.externalLinks || [])) !== stable(c.externalLinks)) throw new HttpError(409, 'The panel has not confirmed client tunnel addresses and external subscription links.');
    }
    if (Number(c.expiryTime) < 0 && Number(parseObject(actual.client || actual).expiryTime) === Number(c.expiryTime)) activation[email] = { duration: Number(c.expiryTime) };
    else if (Number(c.expiryTime) >= 0) delete activation[email];
    d.runtime[email] = traffic ?? {};
  }
  const confirmedHosts = objectRows(await request('/panel/api/hosts/list'), 'host');
  if (confirmedHosts.length !== d.hosts.length || d.hosts.some(h => { const groupId = binding.hosts[String(h.id || h.groupId)], wanted = translateReferences({ ...h, groupId, inboundIds: mappedIds(h.inboundIds, binding.inbounds, 'host group') }, binding) as JsonObject; delete wanted.id; return !matchesDesired(confirmedHosts.find(n => n.groupId === groupId || n.id === groupId), wanted); })) throw new HttpError(409, 'The panel has not confirmed the saved host groups.');
  const confirmedNodes = objectRows(await request('/panel/api/nodes/list'), 'node');
  if (confirmedNodes.length !== d.nodes.length || d.nodes.some(n => { const actual = confirmedNodes.find(row => Number(row.id) === binding.nodes[String(n.id)]), wanted = nodePayload(n); delete wanted.apiToken; delete wanted.clearApiToken; return !actual || !matchesDesired(actual, wanted) || n.apiToken && !actual.hasApiToken; })) throw new HttpError(409, 'The panel has not confirmed the saved node connections.');
  const confirmedXray = parseObject(await request('/panel/api/xray/', 'POST'));
  if (stable(parseObject(confirmedXray.xraySetting)) !== stable(desiredXray) || !matchesDesired(parseObject(await request('/panel/api/setting/all', 'POST')), portable)) throw new HttpError(409, 'The panel has not confirmed saved routing, outbounds and portable settings.');
  collections.subscriptionOutbounds = objectRows(confirmedXray.subscriptionOutbounds || [], 'subscription outbound');
  const needsXray = d.coreEnabled.xray !== false;
  let status = parseObject(await request('/panel/api/server/status'));
  if ((parseObject(status.xray).state === 'running') !== needsXray) {
    await request(`/panel/api/server/${needsXray ? 'restartXrayService' : 'stopXrayService'}`, 'POST');
    status = parseObject(await request('/panel/api/server/status'));
  }
  if ((parseObject(status.xray).state === 'running') !== needsXray || needsXray && parseObject(status.xray).errorMsg) throw new HttpError(409, 'The panel has saved the configuration but has not confirmed the requested Xray running state.');
  for (const n of d.nodes.filter(n => n.enable !== false)) {
    const probe = parseObject(await request(`/panel/api/nodes/probe/${binding.nodes[String(n.id)]}`, 'POST'));
    if (probe.status !== 'online' || probe.xrayState === 'error' || probe.xrayError) throw new HttpError(409, 'A restored node has not confirmed its connection and core health.');
  }
  if (d.nodes.length && objectRows(await request('/panel/api/nodes/list'), 'node').some(n => n.enable !== false && n.configDirty)) throw new HttpError(409, 'The panel is still pushing saved settings to its nodes. Retry after those nodes confirm synchronization.');
  // Destination IDs never replace logical IDs in the desired document or its policies.
  d.runtime._benxPanelBinding = binding;
  d.runtime._benxPanelActivation = Object.fromEntries(Object.entries(activation).filter(([email]) => d.state.clients[email]));
  return binding.inbounds;
}
async function persistCheckpoint(env: Env, row: ManagedRow, lease: string, document: ManagedDocument, destination: StoredServer) {
  const secret = await encrypt(validateDocument(document), env.ENCRYPTION_KEY);
  const guard = 'EXISTS(SELECT 1 FROM managed_state m JOIN servers s ON s.id=? WHERE m.server_id=? AND m.revision=? AND m.lease=? AND m.lease_until>? AND s.url=? AND s.credentials=?)';
  const values = [destination.id, row.server_id, row.revision, lease, Date.now(), destination.url, destination.credentials];
  await env.DB.batch([
    env.DB.prepare(`UPDATE managed_state SET document=?,checkpoint_at=?,warning=? WHERE server_id=? AND revision=? AND ${guard}`).bind(secret, Date.now(), document.runtime.certificateRenewalPending ? 'Certificate restored. Point DNS to the new VPS, then issue its domain certificate in Server setup to enable renewal.' : '', row.server_id, row.revision, ...values),
    env.DB.prepare(`UPDATE managed_versions SET document=? WHERE server_id=? AND revision=? AND ${guard}`).bind(secret, row.server_id, row.revision, ...values),
  ]);
}
export async function reconcileServer(env: Env, server: StoredServer, target?: StoredServer, explicit = false) {
  const row = await managedRow(env, server.id);
  if (!row || !row.bound && !target || !server.enabled && !target) return false;
  const mode = await operationMode(env);
  if (!target && (explicit || mode === 'automatic' && row.revision > row.applied_revision)) { await env.DB.prepare('UPDATE managed_state SET requested_revision=revision WHERE server_id=? AND revision=?').bind(server.id, row.revision).run(); row.requested_revision = row.revision; }
  if (!target && !explicit && mode === 'manual' && (Number(row.requested_revision || 0) < row.revision || row.phase === 'synced' && row.applied_revision >= Number(row.requested_revision || 0))) return false;
  if (!target && await env.DB.prepare("SELECT server_id FROM replacements WHERE (server_id=? OR server_id=?) AND state NOT IN ('completed','cancelled')").bind(server.id, server.parent_id || server.id).first()) return false;
  const lease = (target ? 'verify:' : 'sync:') + crypto.randomUUID(), now = Date.now();
  const locked = await env.DB.prepare('UPDATE managed_state SET lease=?,lease_until=? WHERE server_id=? AND revision=? AND lease_until<? RETURNING revision').bind(lease, now + 240000, server.id, row.revision, now).first();
  if (!locked) return false;
  try {
    const destination = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(target?.id || server.id).first<StoredServer>();
    if (!destination) throw new HttpError(409, 'This server connection changed during synchronization.');
    if (!target && !destination.enabled) return false;
    // A confirmed native job needs only a drift check between durable checkpoints.
    // New revisions, replacements and repairs always take the full verification path.
    if (!target && destination.kind === 'server' && row.phase === 'synced' && row.applied_revision === row.revision && Date.now() - Number(row.checkpoint_at || 0) < 300000) {
      const status = parseObject(await callRemoteJson(destination, env, { path: '/benx/v1/control/status', method: 'GET' }));
      if (status.serverId === server.id && status.revision === row.revision && parseObject(status.job).state === 'succeeded' && !status.drift) {
        const confirmed = await env.DB.prepare("UPDATE managed_state SET checked_at=? WHERE server_id=? AND revision=? AND lease=? AND lease_until>? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND url=? AND credentials=?) RETURNING server_id").bind(Date.now(), server.id, row.revision, lease, Date.now(), destination.id, destination.url, destination.credentials).first();
        return Boolean(confirmed);
      }
    }
    const document = await savedDocument(env, row);
    if (target) {
      const origin = new URL(server.url).hostname === 'unconnected.invalid' ? String(document.runtime._benxOriginURL || server.url) : server.url;
      const before = new URL(origin).hostname.replace(/^\[|\]$/g, ''), after = new URL(destination.url).protocol === 'agent:' ? before : new URL(destination.url).hostname.replace(/^\[|\]$/g, '');
      if (document.setup.certificate.ip === before) document.setup.certificate.ip = after;
      // Explicit domains stay intact; values tied to the old VPS address follow its replacement.
      for (const inbound of document.state.inbounds) {
        for (const key of ['listen', 'address']) if (inbound[key] === before) inbound[key] = after;
        const settings = parseObject(inbound.settings);
        if (settings.publicHost === before) inbound.settings = { ...settings, publicHost: after };
      }
    }
    let phase = 'applying', applied = row.applied_revision;
    if (document.mode === 'native') {
      if (destination.kind !== 'server') throw new HttpError(409, 'Native profiles require a full-access BenX agent.');
      const status = parseObject(await callRemoteJson(destination, env, { path: '/benx/v1/control/status', method: 'GET' }));
      const job = parseObject(status.job);
      if (status.serverId === server.id && status.revision === row.revision && job.state === 'succeeded' && !status.drift) {
        const checkpoint = await remoteDocument(env, destination);
        // Only after this exact revision was verified: retain generated keys/PKI and traffic checkpoints.
        document.assets = checkpoint.assets; document.runtime = checkpoint.runtime;
        for (const i of document.state.inbounds) {
          const actual = checkpoint.state.inbounds.find(n => n.id === i.id);
          if (actual && !parseObject(i.settings).privateKey && parseObject(actual.settings).privateKey) i.settings = { ...parseObject(i.settings), privateKey: parseObject(actual.settings).privateKey };
          const tls = parseObject(parseObject(i.streamSettings).tlsSettings), actualTLS = parseObject(parseObject(actual?.streamSettings).tlsSettings);
          if (actualTLS.certificates) {
            // File references stay live for renewal and stable Lab identities.
            // Portable material is kept separately for replacement before DNS cutover.
            if ((tls.certificates as JsonObject[] || []).some(c => c.certificateFile || c.keyFile)) document.runtime.tlsCertificates = { ...parseObject(document.runtime.tlsCertificates), [String(i.id)]: actualTLS.certificates };
            else i.streamSettings = { ...parseObject(i.streamSettings), tlsSettings: { ...tls, certificates: actualTLS.certificates } };
          }
        }
        for (const [email, c] of Object.entries(document.state.clients)) { const actual = checkpoint.state.clients[email]; for (const k of ['privateKey', 'publicKey']) if (actual?.[k] && !c[k]) c[k] = actual[k]; }
        await persistCheckpoint(env, row, lease, document, destination);
        phase = 'synced'; applied = row.revision;
      } else if (job.state === 'running' || job.state === 'queued') phase = 'applying';
      else if (status.serverId === server.id && status.revision === row.revision && job.state === 'failed' && (!Number(job.createdAt) || Date.now() - Number(job.createdAt) < 60000)) {
        throw new HttpError(409, 'The server rejected this saved configuration and restored its previous listeners. Review the configuration before retrying.');
      }
      else { await callRemoteJson(destination, env, { path: '/benx/v1/control/apply', method: 'POST', body: { serverId: server.id, revision: row.revision, document, replacement: Boolean(target), repair: Boolean(status.drift) } }); }
    } else {
      if (destination.kind === 'server') throw new HttpError(409, 'A 3X-UI profile must restore into the managed 3X-UI workspace.');
      await applyPanel(env, destination, document); phase = 'synced'; applied = row.revision;
      await persistCheckpoint(env, row, lease, document, destination);
    }
    const confirmed = await env.DB.prepare('UPDATE managed_state SET phase=?,applied_revision=?,error=?,checked_at=? WHERE server_id=? AND revision=? AND lease=? AND lease_until>? AND EXISTS(SELECT 1 FROM servers WHERE id=? AND url=? AND credentials=?) RETURNING server_id').bind(phase, applied, '', Date.now(), server.id, row.revision, lease, Date.now(), destination.id, destination.url, destination.credentials).first();
    return Boolean(confirmed) && phase === 'synced' && applied === row.revision;
  } catch (e) {
    // Remote error text can contain vendor excerpts/secrets. Expose a fixed operator message only.
    const error = e instanceof HttpError && e.status === 409 ? e.message : 'Server has not confirmed the saved configuration. Check its connection, installed adapters and Synchronization details, then retry.';
    await env.DB.prepare("UPDATE managed_state SET phase='failed',error=?,checked_at=? WHERE server_id=? AND revision=? AND lease=?").bind(error, Date.now(), server.id, row.revision, lease).run();
    return false;
  } finally { await env.DB.prepare('UPDATE managed_state SET lease=NULL,lease_until=0 WHERE server_id=? AND lease=?').bind(server.id, lease).run(); }
}
export async function controlRoute(request: Request, env: Env, server: StoredServer, ctx: ExecutionContext) {
  if (request.method === 'GET' && new URL(request.url).searchParams.get('summary') === '1') {
    const row = await env.DB.prepare('SELECT revision,applied_revision,requested_revision,phase,error,bound,updated_at,checked_at,warning FROM managed_state WHERE server_id=?').bind(server.id).first<ManagedRow>();
    if (row?.bound && server.enabled && Date.now() - row.checked_at > (row.phase === 'synced' ? 300000 : 15000) && (await operationMode(env) === 'automatic' || Number(row.requested_revision || 0) >= row.revision && row.phase !== 'synced')) ctx.waitUntil(reconcileServer(env, server));
    return Response.json(row ? { ...row, replacement: await env.DB.prepare('SELECT candidate_id,state,error FROM replacements WHERE server_id=?').bind(server.id).first() } : null, { headers: { 'Cache-Control': 'no-store' } });
  }
  let row = await managedRow(env, server.id);
  if (request.method === 'GET') {
    if (!row) return Response.json(null);
    if (row.bound && server.enabled && Date.now() - row.checked_at > (row.phase === 'synced' ? 300000 : 15000) && (await operationMode(env) === 'automatic' || Number(row.requested_revision || 0) >= row.revision && row.phase !== 'synced')) ctx.waitUntil(reconcileServer(env, server));
    const document = await savedDocument(env, row);
    return Response.json({ revision: row.revision, requested_revision: row.requested_revision, applied_revision: row.applied_revision, phase: row.phase, error: row.error, bound: row.bound, updated_at: row.updated_at, checked_at: row.checked_at, setup: document.setup, warning: document.runtime.certificateRenewalPending ? 'Certificate restored. Point DNS to the new VPS, then issue its domain certificate in Server setup to enable renewal.' : '', replacement: await env.DB.prepare('SELECT candidate_id,state,error FROM replacements WHERE server_id=?').bind(server.id).first() });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ action: string; sourceId?: string; revision?: number; document?: ManagedDocument }>(request);
  if (input.action === 'export') {
    if (!row) throw new HttpError(404, 'Import this server into BenX-UI first.');
    const exported = await savedDocument(env, row); if (new URL(server.url).hostname !== 'unconnected.invalid' || !exported.runtime._benxOriginURL) exported.runtime._benxOriginURL = server.url;
    return Response.json(exported, { headers: { 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="benx-server-profile.json"' } });
  }
  if (input.action === 'import') {
    if (row && input.revision !== row.revision) throw new HttpError(409, 'Refresh the saved revision before replacing it with imported data.');
    const source = input.sourceId ? await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(input.sourceId).first<StoredServer>() : server;
    if (!source) throw new HttpError(404, 'Import source not found.');
    const sourceRow = input.sourceId ? await managedRow(env, source.id) : null;
    let d = input.document ? validateDocument(input.document) : sourceRow ? await savedDocument(env, sourceRow) : await remoteDocument(env, source);
    const origin = input.document ? String(d.runtime._benxOriginURL || '') : input.sourceId ? source.url : '';
    if (origin && origin !== server.url) d = portableCopy(d, origin, server.url, false);
    if (server.kind === 'server' && d.mode === 'panel') throw new HttpError(409, 'Import this 3X-UI profile into a 3X-UI workspace to preserve its full protocol/accounting options.');
    if (row) await saveManaged(env, row, d); else await createManaged(env, server.id, d);
    row = (await managedRow(env, server.id))!;
  } else if (input.action === 'save') {
    if (!row || input.revision !== row.revision || !input.document) throw new HttpError(409, 'Supply the current revision and a complete profile.');
    await saveManaged(env, row, input.document);
  } else if (input.action !== 'sync') throw new HttpError(400, 'Unknown synchronization action.');
  if (input.action === 'sync' && row && input.revision !== undefined && input.revision !== row.revision) throw new HttpError(409, 'The saved batch changed. Refresh and review it before applying.');
  if (!row) row = await adoptServer(env, server);
  row = (await managedRow(env, server.id))!;
  const submitted = await env.DB.prepare('UPDATE managed_state SET requested_revision=CASE WHEN bound=1 AND EXISTS(SELECT 1 FROM servers WHERE id=? AND enabled=1) THEN revision ELSE applied_revision END WHERE server_id=? AND revision=? RETURNING revision').bind(server.id, server.id, row.revision).first();
  if (!submitted) throw new HttpError(409, 'The saved batch changed. Refresh and review it before applying.');
  ctx.waitUntil(reconcileServer(env, server));
  return Response.json({ saved: true, pending: true, revision: row.revision });
}
export async function profileRoute(request: Request, env: Env) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ name: string }>(request);
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new HttpError(400, 'Give your saved server a name.');
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM servers s WHERE s.is_candidate=0 AND NOT EXISTS(SELECT 1 FROM servers p WHERE p.id=s.parent_id AND p.is_candidate=1)').first<{ n: number }>(); if ((count?.n || 0) >= 50) throw new HttpError(400, 'Saved server limit reached.');
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO servers(id,name,url,version,kind,auth,credentials,enabled,created_at) VALUES(?,?,?,'v3','server','token',?,0,?)").bind(id, input.name.trim(), 'https://unconnected.invalid/', await encrypt({}, env.ENCRYPTION_KEY), Date.now()).run();
  await createManaged(env, id, emptyDocument(), 0);
  return Response.json({ id }, { status: 201 });
}
export async function reconcileFleet(env: Env) {
  const automatic = await operationMode(env) === 'automatic';
  const servers = (await env.DB.prepare("SELECT s.* FROM servers s JOIN managed_state m ON m.server_id=s.id WHERE s.enabled=1 AND m.bound=1 AND (?=1 OR m.requested_revision>=m.revision AND m.phase!='synced') AND NOT EXISTS(SELECT 1 FROM replacements r WHERE r.server_id=s.id AND r.state NOT IN ('completed','cancelled')) ORDER BY m.checked_at LIMIT 8").bind(automatic ? 1 : 0).all<StoredServer>()).results;
  for (let i = 0; i < servers.length; i += 2) await Promise.allSettled(servers.slice(i, i + 2).map(s => reconcileServer(env, s)));
}
