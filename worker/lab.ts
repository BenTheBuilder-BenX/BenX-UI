import { previewLab, validateLabSpec, type LabSpec, type LabVariant } from '../shared/lab';
import { reduceDocument, validateDocument, type ManagedDocument } from '../shared/managed';
import { inboundClients, parseObject, type Client, type Inbound, type JsonObject } from '../shared/types';
import { subscription } from '../shared/subscriptions';
import { realityKeys, randomSecret, validateInboundSecurity } from '../src/lib/inbound-setup';
import { shareLink } from '../src/lib/links';
import { managedRow, savedDocument, reconcileServer } from './control';
import { callRemoteJson, type StoredServer } from './remote';
import { decrypt, encrypt, HttpError, readJson } from './security';
interface ExperimentData { spec: LabSpec; token: string; variants: Array<LabVariant & { inboundId: number; email: string; identity: string; resourceHash: string }>; report?: unknown }
interface ExperimentRow { id: string; server_id: string; name: string; data: string; revision: number; state: string; created_at: number }
async function digest(s: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))), b => b.toString(16).padStart(2, '0')).join(''); }
export async function generateLab(source: ManagedDocument, spec: LabSpec, experimentId: string) {
  const preview = previewLab(spec), d = structuredClone(source), variants: ExperimentData['variants'] = [], occupied = new Set(d.state.inbounds.map(i => Number(i.port)));
  const keys = preview.variants.some(v => v.security === 'reality') ? await realityKeys() : undefined;
  let port = spec.firstPort;
  for (const [n, v] of preview.variants.entries()) {
    while (occupied.has(port) && port <= 65535) port++; if (port > 65535) throw new HttpError(400, 'Not enough available listener ports after the selected start port.'); occupied.add(port);
    const email = `lab-${experimentId.slice(0, 8)}-${n + 1}`, client: JsonObject = { email, id: crypto.randomUUID(), subId: crypto.randomUUID().replaceAll('-', ''), password: v.protocol === 'shadowsocks' && v.cipher.startsWith('2022-') ? randomSecret(v.cipher.includes('aes-128') ? 16 : 32) : randomSecret(32), enable: true, totalGB: Math.round(spec.quotaGB * 1024 ** 3), expiryTime: Date.now() + spec.hours * 3600000 };
    if (['http', 'socks'].includes(v.protocol)) { client.proxyUsername = 'benx_' + (await digest(email)).slice(0, 20); client.totalGB = 0; }
    let settings: JsonObject = v.protocol === 'vless' ? { decryption: 'none', encryption: 'none' } : v.protocol === 'shadowsocks' ? { method: v.cipher, network: 'tcp,udp', password: v.cipher.startsWith('2022-') ? randomSecret(v.cipher.includes('aes-128') ? 16 : 32) : client.password } : {};
    let stream: JsonObject = { network: v.network, security: v.security };
    if (['ws', 'httpupgrade', 'xhttp'].includes(v.network)) stream[v.network + 'Settings'] = { path: v.path || '/', ...(v.network === 'xhttp' ? { mode: v.mode || 'auto', extra: { xPaddingBytes: v.padding || '100-1000' } } : {}) };
    if (v.network === 'grpc') stream.grpcSettings = { serviceName: v.service, multiMode: false };
    if (v.network === 'kcp') stream.kcpSettings = { mtu: 1350, tti: 50, uplinkCapacity: 5, downlinkCapacity: 20, congestion: false, readBufferSize: 2, writeBufferSize: 2 };
    if (v.security === 'reality') { stream.realitySettings = { show: false, target: `${v.sni}:443`, xver: 0, serverNames: [v.sni], privateKey: keys!.privateKey, publicKey: keys!.publicKey, shortIds: [crypto.randomUUID().replaceAll('-', '').slice(0, 8)], settings: { publicKey: keys!.publicKey, fingerprint: v.fingerprint || 'chrome', serverName: v.sni, spiderX: '/' } }; if (v.network === 'tcp') client.flow = 'xtls-rprx-vision'; }
    if (v.security === 'tls') stream.tlsSettings = { serverName: spec.tlsSni, minVersion: '1.2', maxVersion: '1.3', alpn: v.protocol === 'http' ? ['http/1.1'] : ['h2', 'http/1.1'], settings: { fingerprint: v.fingerprint || 'chrome' }, certificates: [{ certificateFile: spec.certificateFile, keyFile: spec.keyFile, usage: 'encipherment' }] };
    if (v.recipe) { settings = parseObject(v.recipe.settings); stream = parseObject(v.recipe.streamSettings); if (v.protocol === 'shadowsocks' && !['aes-128-gcm','aes-256-gcm','chacha20-poly1305','2022-blake3-aes-128-gcm','2022-blake3-aes-256-gcm'].includes(String(settings.method))) throw new Error('This Shadowsocks cipher is not supported in managed multi-user tests.'); if ((!stream.security || stream.security === 'none') && v.protocol === 'vless') throw new Error('Public plain VLESS recipes need compatible VLESS Encryption keys. Use TLS or REALITY instead.'); if (stream.security === 'reality') { const r = parseObject(stream.realitySettings); const keys = await realityKeys(); stream.realitySettings = { ...r, ...keys, settings: { ...parseObject(r.settings), publicKey: keys.publicKey } }; } if (v.protocol === 'shadowsocks' && String(settings.method).startsWith('2022-')) { const size = String(settings.method).includes('aes-128') ? 16 : 32; settings.password = randomSecret(size); client.password = randomSecret(size); } }
    if (['http', 'socks'].includes(v.protocol)) settings = { ...settings, auth: 'password', udp: false };
    const inbound: JsonObject = { ...(v.recipe || {}), id: d.state.nextId, remark: `${spec.name} Â· ${String(n + 1).padStart(3, '0')} Â· ${v.protocol}/${v.network}/${v.security}`, protocol: v.protocol, port: port++, enable: true, listen: '', total: 0, expiryTime: Date.now() + spec.hours * 3600000, settings: { ...settings, publicHost: spec.host }, streamSettings: stream, sniffing: { enabled: true, destOverride: ['http', 'tls'] } };
    validateInboundSecurity(inbound as unknown as Inbound);
    d.state.inbounds.push(inbound); d.state.nextId++;
    d.state.clients[email] = { ...client, uuid: client.id, inboundIds: [Number(inbound.id)] };
    variants.push({ ...v, inboundId: Number(inbound.id), email, identity: String(client.subId), resourceHash: await digest(JSON.stringify(inbound)) });
  }
  return { document: validateDocument(d), variants, preview };
}
async function view(env: Env, row: ExperimentRow, origin: string) {
  const data = await decrypt<ExperimentData>(row.data, env.ENCRYPTION_KEY), managed = await managedRow(env, row.server_id);
  const current = managed ? await savedDocument(env, managed) : null;
  const intact = (await Promise.all(data.variants.map(async v => { const i = current?.state.inbounds.find(i => i.id === v.inboundId); return current?.state.clients[v.email]?.subId === v.identity && i && await digest(JSON.stringify(i)) === v.resourceHash; }))).every(Boolean);
  const state = row.state === 'removed' ? 'removed' : !intact ? 'changed' : (managed?.applied_revision ?? 0) >= row.revision && managed?.phase === 'synced' ? 'ready' : 'pending';
  return { id: row.id, serverId: row.server_id, name: row.name, count: data.variants.length, revision: row.revision, appliedRevision: managed?.applied_revision || 0, state, syncPhase: managed?.phase, syncError: managed?.error, createdAt: row.created_at, spec: data.spec, manifest: data.variants.map(v => ({ key: v.key, protocol: v.protocol, network: v.network, security: v.security, sni: v.sni, fingerprint: v.fingerprint, path: v.path, service: v.service, mode: v.mode, padding: v.padding, cipher: v.cipher, inboundId: v.inboundId })), report: data.report, url: state === 'ready' ? `${origin}/lab/${row.id}/${data.token}/v2ray` : '' };
}
export async function labRoute(request: Request, env: Env, ctx: ExecutionContext, allowed: (id: string) => boolean = () => true) {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/lab/preview' && request.method === 'POST') { try { return Response.json(previewLab(await readJson(request))); } catch (e) { throw new HttpError(400, (e as Error).message); } }
  if (path === '/api/lab' && request.method === 'GET') return Response.json(await Promise.all((await env.DB.prepare('SELECT * FROM lab_experiments ORDER BY created_at DESC LIMIT 100').all<ExperimentRow>()).results.filter(r => allowed(r.server_id)).map(r => view(env, r, url.origin))));
  if (path === '/api/lab' && request.method === 'POST') {
    let spec: LabSpec; try { spec = validateLabSpec(await readJson(request)); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1 AND is_candidate=0').bind(spec.serverId).first<StoredServer>(), row = await managedRow(env, spec.serverId);
    if (!server || !row?.bound) throw new HttpError(409, 'Choose a connected, imported server with full saved configuration.');
    if (server.kind !== 'server') throw new HttpError(400, 'Testing Lab requires full server access. Use a dedicated VPS.');
    const d = await savedDocument(env, row); if (d.mode !== 'native' || !d.setup.cores.includes('xray')) throw new HttpError(400, 'Choose a native server with the Xray core.');
    const id = crypto.randomUUID(); let generated;
    try { generated = await generateLab(d, spec, id); } catch (e) { throw new HttpError(400, (e as Error).message); }
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join(''), secret = await encrypt(generated.document, env.ENCRYPTION_KEY), now = Date.now(), data = await encrypt({ spec, token, variants: generated.variants }, env.ENCRYPTION_KEY);
    const fence = 'EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND revision=? AND document=?)', values = [server.id, row.revision + 1, secret];
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE managed_state SET document=?,revision=revision+1,phase='pending',error='',updated_at=? WHERE server_id=? AND revision=? AND document=? AND lease_until<? AND bound=1 AND EXISTS(SELECT 1 FROM servers WHERE id=? AND enabled=1 AND is_candidate=0)").bind(secret, now, server.id, row.revision, row.document, now, server.id),
      env.DB.prepare(`INSERT INTO lab_experiments(id,server_id,name,data,revision,created_at) SELECT ?,?,?,?,?,? WHERE ${fence}`).bind(id, server.id, spec.name.trim(), data, row.revision + 1, now, ...values),
      env.DB.prepare(`INSERT INTO managed_versions(server_id,revision,document,created_at) SELECT ?,?,?,? WHERE ${fence}`).bind(server.id, row.revision + 1, secret, now, ...values),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, 'Server configuration changed. Preview again before deploying.');
    ctx.waitUntil(reconcileServer(env, server, undefined, true).catch(() => undefined));
    return Response.json(await view(env, (await env.DB.prepare('SELECT * FROM lab_experiments WHERE id=?').bind(id).first<ExperimentRow>())!, url.origin), { status: 201 });
  }
  const match = path.match(/^\/api\/lab\/([a-f0-9-]{36})(?:\/(report|manifest))?$/); if (!match) throw new HttpError(404, 'Experiment endpoint not found.');
  const row = await env.DB.prepare('SELECT * FROM lab_experiments WHERE id=?').bind(match[1]).first<ExperimentRow>(); if (!row) throw new HttpError(404, 'Experiment not found.');
  const data = await decrypt<ExperimentData>(row.data, env.ENCRYPTION_KEY);
  if (request.method === 'GET') return Response.json(await view(env, row, url.origin));
  if (match[2] === 'report' && request.method === 'PUT') {
    const report = await readJson<{ results: Array<{ key: string; reachable: boolean; latencyMs?: number; downloadMbps?: number; lossPercent?: number }>; measuredAt: string }>(request);
    if (!Array.isArray(report.results) || report.results.length > 1000 || new Set(report.results.map(r => r?.key)).size !== report.results.length || typeof report.measuredAt !== 'string' || !Number.isFinite(Date.parse(report.measuredAt)) || report.results.some(r => !r || !data.variants.some(v => v.key === r.key) || (r.lossPercent !== undefined && r.lossPercent > 100) || typeof r.reachable !== 'boolean' || [r.latencyMs, r.downloadMbps, r.lossPercent].some(n => n !== undefined && (!Number.isFinite(n) || n < 0)))) throw new HttpError(400, 'Import a tester report with measuredAt and results keyed by this experiment manifest.');
    data.report = { source: 'Imported BenX-Tester report', measuredAt: report.measuredAt, importedAt: Date.now(), results: report.results };
    const saved = await env.DB.prepare('UPDATE lab_experiments SET data=? WHERE id=? AND data=? RETURNING id').bind(await encrypt(data, env.ENCRYPTION_KEY), row.id, row.data).first(); if (!saved) throw new HttpError(409, 'Experiment changed. Reload before importing.');
    return Response.json(await view(env, (await env.DB.prepare('SELECT * FROM lab_experiments WHERE id=?').bind(row.id).first<ExperimentRow>())!, url.origin));
  }
  if (request.method !== 'DELETE') throw new HttpError(405, 'Method not allowed.');
  if (row.state === 'removed') return Response.json({ removed: true });
  const managed = await managedRow(env, row.server_id); if (!managed) throw new HttpError(404, 'Server profile missing.');
  let d = await savedDocument(env, managed);
  const granted = (await env.DB.prepare('SELECT grants FROM team_members WHERE archived=0').all<{ grants: string }>()).results.some(m => (JSON.parse(m.grants) as Array<{ serverId: string; inboundIds: number[] }>).some(g => g.serverId === row.server_id && data.variants.some(v => g.inboundIds.includes(v.inboundId))));
  if (granted) throw new HttpError(409, 'Experiment inbounds are assigned to a team account. Remove those grants before cleanup.');
  for (const v of data.variants) {
    const i = d.state.inbounds.find(i => i.id === v.inboundId), c = d.state.clients[v.email];
    if (i && await digest(JSON.stringify(i)) !== v.resourceHash || c && (c.subId !== v.identity || (c.inboundIds as number[]).some(id => id !== v.inboundId)) || Object.entries(d.state.clients).some(([email, c]) => email !== v.email && (c.inboundIds as number[]).includes(v.inboundId)) || d.policy.services.some(s => s.inbounds.some(i => i.inboundId === v.inboundId))) throw new HttpError(409, 'An experiment resource was changed or reused. Detach other customers/services and restore its configuration before cleanup.');
    if (c) d = reduceDocument(d, { path: '/panel/api/clients/del/' + v.email, method: 'POST' }).document;
    if (i) d = reduceDocument(d, { path: '/panel/api/inbounds/del/' + v.inboundId, method: 'POST' }).document;
  }
  const secret = await encrypt(d, env.ENCRYPTION_KEY), now = Date.now();
  const result = await env.DB.batch([
    env.DB.prepare("UPDATE managed_state SET document=?,revision=revision+1,phase='pending',error='',updated_at=? WHERE server_id=? AND revision=? AND document=? AND lease_until<?").bind(secret, now, row.server_id, managed.revision, managed.document, now),
    env.DB.prepare("UPDATE lab_experiments SET state='removed' WHERE id=? AND data=? AND EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND document=?)").bind(row.id, row.data, row.server_id, secret),
    env.DB.prepare('INSERT INTO managed_versions(server_id,revision,document,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND document=?)').bind(row.server_id, managed.revision + 1, secret, now, row.server_id, secret),
  ]);
  if (!result[0].meta.changes) throw new HttpError(409, 'Server changed or is applying settings. Retry cleanup.');
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(row.server_id).first<StoredServer>(); if (server) ctx.waitUntil(reconcileServer(env, server, undefined, true).catch(() => undefined));
  return Response.json({ removed: true, revision: managed.revision + 1, pending: true });
}
export async function publicLab(request: Request, env: Env) {
  const match = new URL(request.url).pathname.match(/^\/lab\/([a-f0-9-]{36})\/([a-f0-9]{64})\/(v2ray|v2box|happ)$/); if (!match || request.method !== 'GET') throw new HttpError(404, 'Experiment subscription not found.');
  const row = await env.DB.prepare("SELECT * FROM lab_experiments WHERE id=? AND state!='removed'").bind(match[1]).first<ExperimentRow>(); if (!row) throw new HttpError(404, 'Experiment unavailable.');
  const data = await decrypt<ExperimentData>(row.data, env.ENCRYPTION_KEY); if (!await (await import('./security')).equalSecret(data.token, match[2])) throw new HttpError(404, 'Experiment subscription not found.');
  const managed = await managedRow(env, row.server_id); if (!managed || managed.applied_revision < row.revision || managed.phase !== 'synced') throw new HttpError(409, 'Experiment deployment is not confirmed.');
  const state = await savedDocument(env, managed);
  for (const v of data.variants) { const i = state.state.inbounds.find(i => i.id === v.inboundId); if (!i || state.state.clients[v.email]?.subId !== v.identity || await digest(JSON.stringify(i)) !== v.resourceHash) throw new HttpError(409, 'Experiment settings changed. Review the run before testing.'); }
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1').bind(row.server_id).first<StoredServer>(); if (!server) throw new HttpError(404, 'Server unavailable.');
  const inbounds = await callRemoteJson(server, env, { path: '/panel/api/inbounds/list', method: 'GET' }) as Inbound[], links: string[] = [];
  for (const v of data.variants) { const i = inbounds.find(i => i.id === v.inboundId), client = i ? inboundClients(i).find(c => c.email === v.email && c.subId === v.identity) : null; if (!i || !client) throw new HttpError(409, 'Experiment configuration is missing from the VPS. Reconcile the server.'); const traffic = i.clientStats?.find(t => t.email === v.email), used = Number(traffic?.up || 0) + Number(traffic?.down || 0); if (!(Number(client.totalGB) > 0 && used >= Number(client.totalGB)) && i.enable && client.enable !== false && client._quotaBlocked !== true && !(i.expiryTime > 0 && i.expiryTime <= Date.now()) && !(Number(client.expiryTime) > 0 && Number(client.expiryTime) <= Date.now())) links.push(shareLink(i, client as Client, data.spec.host)); }
  const output = subscription(links, match[3]);
  return new Response(output.body, { headers: { 'Content-Type': output.type, 'Cache-Control': 'no-store', 'profile-update-interval': '1' } });
}
