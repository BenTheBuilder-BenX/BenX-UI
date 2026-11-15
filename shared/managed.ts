import { validateStorefront } from './storefront';
import { validateDNS } from './dns';
import { clientExpiry } from './client-expiry';
import { validateMasterDNS, withDNSBackends } from './masterdns';
import { coreForProtocol } from './cores';
import { newPolicy, validClientName, validatePolicy, type ServerPolicy } from './policy';
import { defaultSetup, validatePlan, type SetupPlan } from './setup';
import { parseObject, type JsonObject, type RemoteRequest } from './types';

export interface ManagedDocument {
  format: 1; mode: 'native' | 'panel';
  state: { inbounds: JsonObject[]; clients: Record<string, JsonObject>; nextId: number; xray: JsonObject; storefront?: JsonObject };
  policy: ServerPolicy; setup: SetupPlan; coreEnabled: Record<string, boolean>;
  assets: Record<string, string>; runtime: JsonObject;
  settings: JsonObject; nodes: JsonObject[]; hosts: JsonObject[];
}
export interface ManagedStatus { revision: number; applied_revision: number; requested_revision?: number; phase: string; error: string; warning?: string; bound: number; updated_at: number; checked_at: number; replacement?: { candidate_id: string; state: string; error: string } | null }
export function emptyDocument(plan: SetupPlan = structuredClone(defaultSetup)): ManagedDocument {
  return { format: 1, mode: 'native', state: { inbounds: [], clients: {}, nextId: 1, xray: { outbounds: [{ protocol: 'freedom', tag: 'direct' }], routing: { rules: [] } } }, policy: newPolicy(), setup: plan, coreEnabled: {}, assets: {}, runtime: {}, settings: {}, nodes: [], hosts: [] };
}
export function validateDocument(raw: unknown): ManagedDocument {
  const d = raw as ManagedDocument;
  if (!d || d.format !== 1 || !['native', 'panel'].includes(d.mode) || !d.state || !Array.isArray(d.state.inbounds) || d.state.inbounds.length > 1000 || !d.state.clients || Array.isArray(d.state.clients) || Object.keys(d.state.clients).length > 10000 || !Number.isSafeInteger(d.state.nextId) || d.state.nextId < 1) throw new Error('Invalid saved server configuration.');
  const ids = new Set<number>(), ports = new Set<string>();
  for (const row of d.state.inbounds) {
    const id = Number(row.id), port = Number(row.port), key = `${row.nodeId || 0}:${port}`;
    if (!Number.isSafeInteger(id) || id < 1 || ids.has(id) || !Number.isInteger(port) || port < 1 || port > 65535 || ports.has(key) || typeof row.protocol !== 'string') throw new Error('Inbound IDs and listener ports must be valid and unique on each server.');
    ids.add(id); ports.add(key);
    for (const field of ['settings', 'streamSettings', 'sniffing']) row[field] = parseObject(row[field]);
  }
  if (d.mode === 'native' && d.state.storefront) d.state.storefront = validateStorefront(d.state.storefront, d.state.inbounds);
  if (d.mode === 'native') validateDNS(d.state.inbounds);
  const resolverIds = new Set(d.state.inbounds.filter(i => i.protocol === 'dns-resolver').map(i => i.id));
  if (Object.values(d.state.clients).some(c => Array.isArray(c.inboundIds) && c.inboundIds.some(id => resolverIds.has(id)))) throw new Error('DNS resolvers use network access rules and cannot be attached to customers.');
  for (const [email, c] of Object.entries(d.state.clients)) if (!validClientName(email) || c.email !== email || !Array.isArray(c.inboundIds) || c.inboundIds.some(id => typeof id !== 'number' || !ids.has(id))) throw new Error('A saved client has invalid inbound attachments.');
  if (d.mode === 'native') validateMasterDNS(d.state.inbounds, d.state.clients);
  if(d.mode==='native') for(const c of Object.values(d.state.clients)) {
    const expiry=Number(c.expiryTime || 0);
    if(Number(c.totalGB)>0 && !(c.inboundIds as number[]).some(id=>['vless','vmess','trojan','shadowsocks','wireguard-native'].includes(String(d.state.inbounds.find(i=>i.id===id)?.protocol)) || d.state.inbounds.find(i=>i.id===id)?.protocol==='masterdnsvpn' && parseObject(d.state.inbounds.find(i=>i.id===id)?.settings).meteredInboundId))throw new Error(`Customer ${c.email} needs a measured inbound for traffic limits. Attach Xray or native WireGuard, or use unlimited traffic.`);
    if(c.firstUseId !== undefined && (typeof c.firstUseId !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(c.firstUseId)))throw new Error('Invalid first-use renewal identity.');
    if(!Number.isSafeInteger(expiry) || expiry < -3650*86400000)throw new Error('Set a valid expiry date or 1–3650 days after first use.');
    if(expiry<0 && (expiry>-86400000 || expiry%86400000!==0 || !(c.inboundIds as number[]).some(id=>['vless','vmess','trojan','shadowsocks','wireguard-native'].includes(String(d.state.inbounds.find(i=>i.id===id)?.protocol)) || d.state.inbounds.find(i=>i.id===id)?.protocol==='masterdnsvpn' && parseObject(d.state.inbounds.find(i=>i.id===id)?.settings).meteredInboundId)))throw new Error('First-use expiry needs at least one measured attachment: Xray, native WireGuard or a metered MasterDNS backend. Use a fixed date for other native protocols.');
  }
  if (d.state.nextId <= Math.max(0, ...ids)) throw new Error('The next inbound ID must follow the existing listeners.');
  d.policy = validatePolicy(d.policy);
  if (!d.assets || Array.isArray(d.assets) || !d.runtime || Array.isArray(d.runtime) || !d.coreEnabled || Array.isArray(d.coreEnabled) || !Array.isArray(d.nodes) || !Array.isArray(d.hosts)) throw new Error('Invalid profile credentials or linked configuration.');
  for(const h of d.hosts) {
    if(d.mode === 'native' && Array.isArray(h.inboundIds) && h.inboundIds.some(id=>!['vless','vmess','trojan','shadowsocks','http','socks','hysteria'].includes(String(d.state.inbounds.find(i=>i.id===id)?.protocol))))throw new Error('Native Hosts apply to Xray subscription links. Other protocols keep their native export settings.');
    if(!Array.isArray(h.inboundIds) || h.inboundIds.some(id=>!ids.has(Number(id))) || !Array.isArray(h.hosts) || !h.hosts.length || h.hosts.length>30 || !['same','none','tls','reality'].includes(String(h.security || 'same')) || !Number.isInteger(h.port ?? 0) || Number(h.port || 0)<0 || Number(h.port || 0)>65535)throw new Error('Host settings need valid inbounds, addresses, security and port.');
    for(const address of h.hosts) { if(typeof address !== 'string' || /[\s/@?#]/.test(address) || address.length>260)throw new Error('Use a hostname or IP, optionally followed by :port.'); try { new URL(`https://${address}`); } catch { throw new Error('Invalid advertised host address.'); } }
  }
  d.setup = validatePlan(d.setup);
  if (new TextEncoder().encode(JSON.stringify(d)).length > 700000) throw new Error('Saved configuration exceeds the 700 KB encrypted storage limit. Split this server into smaller profiles.');
  return d;
}
export function isManagedMutation(input: RemoteRequest): boolean {
  if (input.path === '/benx/v1/storefront' && input.method === 'POST') return true;
  if (input.method !== 'POST' && input.method !== 'DELETE') return false;
  return /^\/panel\/api\/inbounds\/(add|update\/\d+|del\/\d+|setEnable\/\d+|\d+\/clients)$/.test(input.path) ||
    /^\/panel\/api\/clients\/(add|update\/[^/]+|del\/[^/]+|[^/]+\/(attach|detach|externalLinks))$/.test(input.path) ||
    /^\/panel(?:\/api)?\/(xray|setting)\/update$/.test(input.path) ||
    /^\/panel\/api\/(nodes|hosts)\/(add|update\/[^/]+|del\/[^/]+|setEnable\/[^/]+)$/.test(input.path) ||
    /^\/benx\/v1\/(setup|cores\/[a-z0-9-]+\/(install|start|stop|restart))$/.test(input.path) ||
    /^\/panel\/api\/server\/(restartXrayService|stopXrayService)$/.test(input.path);
}
export function reduceDocument(source: ManagedDocument, input: RemoteRequest): { document: ManagedDocument; result: JsonObject } {
  const d = structuredClone(source), b = structuredClone(input.body || {}), path = input.path;
  let result: JsonObject = { saved: true };
  const inbound = path.match(/^\/panel\/api\/inbounds\/(add|update\/(\d+)|del\/(\d+)|setEnable\/(\d+))$/);
  const customerBatch = path.match(/^\/panel\/api\/inbounds\/(\d+)\/clients$/);
  if (path === '/benx/v1/storefront') { if(d.mode !== 'native') throw new Error('Storefront requires full server access.'); d.state.storefront = validateStorefront(b, d.state.inbounds);
  } else if (customerBatch) {
    const id = Number(customerBatch[1]), row = d.state.inbounds.find(i => i.id === id);
    if (!row || row.protocol === 'dns-resolver') throw new Error('Choose an existing customer inbound.');
    if (!['attach', 'detach'].includes(String(b.action)) || !Array.isArray(b.emails) || !b.emails.length || b.emails.length > 10000 || new Set(b.emails).size !== b.emails.length || b.emails.some(email => typeof email !== 'string' || !d.state.clients[email])) throw new Error('Choose existing customers and an attach or detach action.');
    const settings = parseObject(row.settings), primary = row.protocol === 'openvpn' && settings.pairedUdpId ? d.state.inbounds.find(i => i.id === Number(settings.pairedUdpId)) : row;
    const ids = [id];
    if (d.mode === 'native' && primary?.protocol === 'openvpn') ids.push(Number(primary.id), Number(parseObject(primary.settings).pairedTcpId || 0));
    if (d.mode === 'native' && row.protocol === 'masterdnsvpn' && settings.meteredInboundId) ids.push(Number(settings.meteredInboundId));
    for (const email of b.emails as string[]) {
      const client = d.state.clients[email], prior = client.inboundIds as number[];
      if (d.mode === 'native' && b.action === 'attach' && Number(client.totalGB) > 0 && !['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard-native'].includes(String(row.protocol)) && !(row.protocol === 'masterdnsvpn' && settings.meteredInboundId)) throw new Error(`Customer ${email} has a traffic quota that this inbound cannot enforce. Choose a metered inbound or remove the quota first.`);
      client.inboundIds = b.action === 'attach' ? [...new Set([...prior, ...ids.filter(n => n > 0)])] : prior.filter(n => !ids.includes(n));
    }
    result = { id, customers: b.emails.length, action: b.action };
  } else if (inbound) {
    const action = inbound[1].split('/')[0], id = action === 'add' ? d.state.nextId++ : Number(inbound[2] || inbound[3] || inbound[4]);
    const previous = d.state.inbounds.find(i => i.id === id);
    if (action !== 'add' && !previous) throw new Error('Inbound not found in the saved configuration.');
    if (action === 'del') {
      const pair = previous?.protocol === 'openvpn' ? Number(parseObject(previous.settings).pairedTcpId || 0) : 0;
      const ownedPair = d.state.inbounds.find(i => i.id === pair && i.protocol === 'openvpn' && Number(parseObject(i.settings).pairedUdpId) === id);
      const removed = [id, ...(ownedPair ? [pair] : [])];
      d.state.inbounds = d.state.inbounds.filter(i => !removed.includes(Number(i.id)));
      for (const row of d.state.inbounds) if (Number(parseObject(row.settings).pairedTcpId) === id) { const settings = parseObject(row.settings); delete settings.pairedTcpId; settings.transport = 'udp'; }
      for (const c of Object.values(d.state.clients)) c.inboundIds = (c.inboundIds as number[]).filter(n => !removed.includes(n));
      for (const number of removed) delete d.policy.inboundMultipliers[number];
      for (const s of d.policy.services) s.inbounds = s.inbounds.filter(i => !removed.includes(i.inboundId));
    } else {
      const row: JsonObject = action === 'setEnable' ? { ...previous, enable: b.enable } : { ...b, id };
      if (d.mode === 'native' && row.protocol === 'masterdnsvpn' && d.state.inbounds.some(i => i.id !== id && i.protocol === 'masterdnsvpn')) throw new Error('Use the existing MasterDNSVPN inbound for this server. It supports multiple domains and customers.');
      const settings = parseObject(row.settings), incoming = Array.isArray(settings.clients) ? settings.clients as JsonObject[] : [];
      delete settings.clients; row.settings = settings;
      d.state.inbounds = [...d.state.inbounds.filter(i => i.id !== id), row];
      if (d.mode === 'native' && previous?.protocol === 'openvpn' && settings.transport !== 'both') {
        const pair = Number(parseObject(previous.settings).pairedTcpId || 0);
        if (d.state.inbounds.some(i => i.id === pair && i.protocol === 'openvpn' && Number(parseObject(i.settings).pairedUdpId) === id)) {
          d.state.inbounds = d.state.inbounds.filter(i => i.id !== pair);
          for (const client of Object.values(d.state.clients)) client.inboundIds = (client.inboundIds as number[]).filter(n => n !== pair);
          for (const service of d.policy.services) service.inbounds = service.inbounds.filter(i => i.inboundId !== pair);
          delete d.policy.inboundMultipliers[pair];
        }
        delete settings.pairedTcpId;
      }
      if (d.mode === 'native' && row.protocol === 'openvpn' && settings.transport === 'both') {
        const priorPair = Number(parseObject(previous?.settings).pairedTcpId || 0), paired = d.state.inbounds.find(i => i.id === priorPair && i.protocol === 'openvpn' && Number(parseObject(i.settings).pairedUdpId) === id);
        let port = Number(settings.tcpPort || paired?.port || Number(row.port) + 1);
        if (!settings.tcpPort && !paired) while (d.state.inbounds.some(i => Number(i.port) === port)) port++;
        if (!Number.isInteger(port) || port < 1 || port > 65535 || d.state.inbounds.some(i => i.id !== priorPair && Number(i.port) === port)) throw new Error('Choose an unused TCP companion port.');
        const pairId = paired ? Number(paired.id) : d.state.nextId++;
        let subnet = String(settings.tcpSubnet || parseObject(paired?.settings).subnet || '');
        if (!subnet) { let n = 0; do { subnet = `10.90.${n++}.0/24`; } while (d.state.inbounds.some(i => parseObject(i.settings).subnet === subnet) && n < 256); }
        settings.pairedTcpId = pairId; settings.tcpPort = port;
        const tcp = { ...structuredClone(row), id: pairId, port, remark: `${row.remark} · TCP`, settings: { ...settings, transport: 'tcp', subnet, pairedUdpId: id } as JsonObject };
        delete tcp.settings.pairedTcpId;
        d.state.inbounds = [...d.state.inbounds.filter(i => i.id !== pairId), tcp];
      }
      if (action === 'add') for (const client of incoming) {
        const email = String(client.email || '');
        const existing = d.state.clients[email];
        d.state.clients[email] = { ...client, ...existing, email, inboundIds: [...new Set([...(existing?.inboundIds as number[] || []), id])] };
      }
      if (d.mode === 'native') d.setup.cores = [...new Set([...d.setup.cores, coreForProtocol(String(row.protocol))])];
    }
    result = { id };
  } else if (/^\/panel\/api\/clients\//.test(path)) {
    const attach = path.match(/^\/panel\/api\/clients\/([^/]+)\/(attach|detach|externalLinks)$/);
    const action = attach?.[2] || path.split('/')[4], email = decodeURIComponent(attach?.[1] || path.split('/').at(-1)!);
    const prior = d.state.clients[email];
    if (action !== 'add' && !prior) throw new Error('Client not found in the saved configuration.');
    if (action === 'del') { delete d.state.clients[email]; delete d.policy.clients[email]; delete d.runtime[email]; }
    else if (action === 'attach' || action === 'detach') {
      if (!Array.isArray(b.inboundIds)) throw new Error('Select inbound IDs.');
      prior.inboundIds = action === 'attach' ? [...new Set([...(prior.inboundIds as number[]), ...b.inboundIds])] : (prior.inboundIds as number[]).filter(i => !(b.inboundIds as number[]).includes(i));
    } else if (action === 'externalLinks') prior.externalLinks = b.externalLinks || b.links || [];
    else {
      const raw = parseObject(b.client || b), name = String(raw.email || email);
      if (!validClientName(name)) throw new Error('Invalid client name.');
      if (name !== email && d.state.clients[name] || action === 'add' && d.state.clients[name]) throw new Error('A client with this name already exists.');
      const client: JsonObject = { ...prior, ...raw, email: name, inboundIds: d.mode === 'native' && Array.isArray(raw.inboundIds) ? raw.inboundIds : prior?.inboundIds || b.inboundIds || raw.inboundIds || [] };
      client.id ||= crypto.randomUUID(); client.uuid ||= client.id; client.password ||= crypto.randomUUID() + crypto.randomUUID(); client.subId ||= crypto.randomUUID().replace(/-/g, '').slice(0, 16); client.enable ??= true;
      delete client.traffic;
      if (action === 'update') {
        delete d.state.clients[email];
        if (name !== email && d.runtime[email]) { d.runtime[name] = d.runtime[email]; delete d.runtime[email]; }
      }
      d.state.clients[name] = client;
    }
  } else if (/\/xray\/update$/.test(path)) {
    if (b.expectedXraySetting && JSON.stringify(parseObject(b.expectedXraySetting)) !== JSON.stringify(d.state.xray)) throw new Error('Configuration changed. Refresh before saving.');
    d.state.xray = parseObject(b.xraySetting);
    if (!Array.isArray(d.state.xray.outbounds) || !d.state.xray.outbounds.length) throw new Error('Set at least one outbound.');
  } else if (/\/setting\/update$/.test(path)) {
    if (d.mode === 'native') throw new Error('Remote panel settings need a 3X-UI workspace. Use Server setup for native server options.');
    d.settings = { ...d.settings, ...b };
  } else if (/\/benx\/v1\/setup$/.test(path)) {
    const plan = validatePlan(b);
    d.setup = { ...plan, cores: [...new Set([...d.setup.cores, ...plan.cores])], bbr: plan.bbr || d.setup.bbr, panel: plan.panel === '3x-ui' ? '3x-ui' : d.setup.panel, certificate: plan.certificate.enabled ? plan.certificate : d.setup.certificate };
    result = { id: 'desired', state: 'queued', message: 'Choices saved in BenX-UI. Applying to the server.', steps: [], createdAt: Date.now() };
  } else if (/\/cores\//.test(path) || /XrayService$/.test(path)) {
    const core = /XrayService$/.test(path) ? 'xray' : path.split('/')[4], action = /XrayService$/.test(path) ? path.includes('stop') ? 'stop' : 'restart' : path.split('/')[5];
    if (action === 'install') d.setup.cores = [...new Set([...d.setup.cores, core])];
    else d.coreEnabled[core] = action !== 'stop';
    result = { id: 'desired', core, action, state: 'queued', message: 'Server action saved and queued.', createdAt: Date.now() };
  } else {
    const group = path.includes('/nodes/') ? 'nodes' : 'hosts', action = path.split('/')[4], id = path.split('/')[5];
    if (d.mode !== 'panel' && group === 'nodes') throw new Error('Nodes require a panel workspace.');
    const prior = d[group].find(i => String(i.id) === id);
    if (action !== 'add' && !prior) throw new Error('Saved row not found.');
    if (action === 'del') d[group] = d[group].filter(i => String(i.id) !== id);
    else if (action === 'setEnable') { if(group === 'hosts') prior!.isDisabled = !b.enable; else prior!.enable = b.enable; }
    else { const row = { ...prior, ...b, id: action === 'add' ? group === 'nodes' ? Math.max(0, ...d.nodes.map(n => Number(n.id))) + 1 : crypto.randomUUID() : prior!.id }; d[group] = [...d[group].filter(i => String(i.id) !== String(row.id)), row]; result = { id: row.id }; }
  }
  if (d.mode === 'native') for (const client of Object.values(d.state.clients)) {
    const ids = withDNSBackends(client.inboundIds as number[], d.state.inbounds);
    client.inboundIds = [...new Set([...ids, ...d.state.inbounds.filter(i => ids.includes(Number(i.id)) && i.protocol === 'openvpn').flatMap(i => { const paired = Number(parseObject(i.settings).pairedTcpId || 0); return paired ? [paired] : []; })])];
  }
  return { document: validateDocument(d), result };
}
export function configurationView(d: ManagedDocument, input: RemoteRequest): unknown | undefined {
  if (input.path === '/benx/v1/storefront' && input.method === 'GET') return structuredClone(d.state.storefront || { enabled: false, template: 'arcade', domain: '', port: 443, mode: 'direct', inboundIds: [] });
  const counter = (value: unknown): number => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
  const traffic = (value: unknown): JsonObject => { const row = structuredClone(parseObject(value)); return { ...row, up: counter(row.up), down: counter(row.down) }; };
  const clientTraffic = (email: string): JsonObject => traffic(d.mode === 'native' ? parseObject(d.runtime.usage)[email] : d.runtime[email]);
  const clientView = (c: JsonObject): JsonObject => {
    const client = structuredClone(c), usage = clientTraffic(String(c.email));
    if(d.mode==='native')client.expiryTime=clientExpiry(c,parseObject(d.runtime.firstUse)[String(c.email)]);
    return d.mode === 'panel' ? { client, inboundIds: structuredClone(c.inboundIds), traffic: usage, externalLinks: structuredClone(c.externalLinks || []) } : { ...client, traffic: usage };
  };
  if (input.path === '/panel/api/inbounds/list' && input.method === 'GET') {
    const attached = new Map<number, JsonObject[]>();
    for (const c of Object.values(d.state.clients)) for (const id of c.inboundIds as number[]) { const group = attached.get(id) || []; group.push(c); attached.set(id, group); }
    return d.state.inbounds.map(i => {
    const row = structuredClone(i), clients = (attached.get(Number(i.id)) || []).map(c => {const value=structuredClone(c);if(d.mode==='native')value.expiryTime=clientExpiry(c,parseObject(d.runtime.firstUse)[String(c.email)]);return value;});
    const checkpoint = d.mode === 'native' ? parseObject(d.runtime.inbounds)[String(i.id)] : parseObject(d.runtime._inboundTraffic)[String(i.id)];
    const usage = traffic(checkpoint ?? (d.mode === 'panel' ? i : undefined));
    return { ...row, up: usage.up, down: usage.down, settings: { ...parseObject(row.settings), clients }, clientStats: clients.map(c => ({ ...clientTraffic(String(c.email)), email: c.email })) };
  });
  }
  if (input.path === '/panel/api/clients/list' && input.method === 'GET') return Object.values(d.state.clients).map(clientView);
  if (/^\/panel\/api\/inbounds\/get\/\d+$/.test(input.path) && input.method === 'GET') return (configurationView(d, { path: '/panel/api/inbounds/list', method: 'GET' }) as JsonObject[]).find(i => i.id === Number(input.path.split('/').at(-1))) ?? null;
  if (/^\/panel\/api\/clients\/get\/[^/]+$/.test(input.path) && input.method === 'GET') { const c = d.state.clients[decodeURIComponent(input.path.split('/').at(-1)!)]; return c ? clientView(c) : null; }
  if (/^\/panel(?:\/api)?\/xray\/$/.test(input.path) && input.method === 'POST') return { xraySetting: JSON.stringify(d.state.xray) };
  if (/^\/panel(?:\/api)?\/setting\/all$/.test(input.path) && input.method === 'POST') return structuredClone(d.settings);
  if (/^\/panel\/api\/(nodes|hosts)\/list$/.test(input.path) && input.method === 'GET') return structuredClone(input.path.includes('/nodes/') ? d.nodes : d.hosts);
  return undefined;
}

// Each full-access deployment resolves its own public endpoint. Explicit overrides win.
export function withDefaultPublicHost(inbound: JsonObject, serverURL: string): JsonObject {
  if (new URL(serverURL).protocol === 'agent:') {
    if (!['masterdnsvpn', 'dns-resolver'].includes(String(inbound.protocol)) && !inbound.excludeFromSub && !['127.0.0.1', '::1'].includes(String(inbound.listen)) && !String(parseObject(inbound.settings).publicHost || '').trim()) throw new Error('Set the actual VPS public host in Protocol options. An outbound agent identity is not a VPN address.');
    return inbound;
  }
  if (!['ssh', 'openvpn', 'openconnect', 'wireguard-native', 'wireguard'].includes(String(inbound.protocol))) return inbound;
  const settings = parseObject(inbound.settings);
  if (String(settings.publicHost || '').trim()) return inbound;
  return { ...inbound, settings: { ...settings, publicHost: new URL(serverURL).hostname.replace(/^\[|\]$/g, '') } };
}
