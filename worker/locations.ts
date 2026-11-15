import { importOutbound, providers, publicDirectory } from '../shared/locations';
import { parseObject, type JsonObject } from '../shared/types';
import { callRemoteJson, type StoredServer } from './remote';
import { decrypt, encrypt, HttpError, readJson, readLimited } from './security';
import { managedRequest, reconcileServer } from './control';
export async function discoverLocations() { const response = await fetch('https://www.vpnjantit.com/', { redirect: 'manual', signal: AbortSignal.timeout(12000), headers: { Accept: 'text/html' } }); if (!response.ok) { await response.body?.cancel(); throw new HttpError(502, 'Provider directory unavailable. Use the official guide and import your own configuration.'); } const bytes = await readLimited(response, 2 * 1024 * 1024); return Response.json({ listings: publicDirectory(new TextDecoder().decode(bytes)), checkedAt: Date.now(), note: 'Public directory only. Listings are not verified working configurations.' }); }
export async function locationsRoute(request: Request, env: Env, server: StoredServer, ctx?: ExecutionContext) {
  if (request.method === 'GET') { const rows = (await env.DB.prepare('SELECT * FROM locations WHERE server_id=? ORDER BY created_at DESC').bind(server.id).all<{ id: string; secret: string }>()).results; return Response.json(await Promise.all(rows.map(async r => { const { secret, ...rest } = r; return { ...rest, outbound: await decrypt<JsonObject>(secret, env.ENCRYPTION_KEY) }; }))); }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ action: string; id?: string; name?: string; provider?: string; country?: string; config?: string; tag?: string; domains?: string[]; inboundIds?: number[] }>(request);
  if (input.action === 'import') {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || !providers.some(p => p.id === input.provider) || typeof input.country !== 'string' || input.country.length > 80 || typeof input.config !== 'string' || typeof input.tag !== 'string') throw new HttpError(400, 'Set a name, provider, location and configuration.');
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM locations WHERE server_id=?').bind(server.id).first<{ n: number }>(); if ((count?.n || 0) >= 100) throw new HttpError(400, 'Location library limit reached.');
    let outbound: JsonObject; try { outbound = importOutbound(input.config, input.tag); } catch (e) { throw new HttpError(400, (e as Error).message); } const id = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO locations(id,server_id,name,provider,country,secret,created_at) VALUES(?,?,?,?,?,?,?)').bind(id, server.id, input.name.trim(), input.provider, input.country, await encrypt(outbound, env.ENCRYPTION_KEY), Date.now()).run();
    return Response.json({ id, imported: true, tested: false });
  }
  const row = await env.DB.prepare('SELECT * FROM locations WHERE id=? AND server_id=?').bind(input.id || '', server.id).first<{ id: string; secret: string; tested_at: number; delay: number | null }>(); if (!row) throw new HttpError(404, 'Saved location not found.');
  if (input.action === 'delete') { await env.DB.prepare('DELETE FROM locations WHERE id=?').bind(row.id).run(); return Response.json({ deleted: true }); }
  const outbound = await decrypt<JsonObject>(row.secret, env.ENCRYPTION_KEY), path = `/panel${server.version === 'v3' ? '/api' : ''}/xray/`;
  if (input.action === 'test') {
    const result = parseObject(await callRemoteJson(server, env, { path: path + 'testOutbound', method: 'POST', body: { outbound: JSON.stringify(outbound), mode: 'real' } }));
    const delay = Number(result.delay), status = Number(result.status || result.statusCode || result.httpStatus || 0);
    const verified = Number.isFinite(delay) && delay >= 0 && Number.isInteger(status) && status >= 200 && status < 400;
    await env.DB.prepare('UPDATE locations SET tested_at=?,delay=? WHERE id=?').bind(verified ? Date.now() : 0, verified ? Math.round(delay) : null, row.id).run();
    if (!verified) throw new HttpError(502, 'Outbound was not verified by a successful HTTP test. Check the provider profile, expiry and core support.');
    return Response.json({ verified: true, delay, status });
  }
  if (input.action !== 'apply') throw new HttpError(400, 'Unknown location action.');
  if (!row.tested_at || Date.now() - row.tested_at > 3600000) throw new HttpError(409, 'Run a successful location test within the last hour before applying it.');
  if (input.domains !== undefined && (!Array.isArray(input.domains) || input.domains.length > 100 || input.domains.some(d => typeof d !== 'string' || !/^[a-zA-Z0-9.*:_-]{1,253}$/.test(d)))) throw new HttpError(400, 'Invalid destination domains.');
  const readConfiguration = async () => {
    const desired = await managedRequest(env, server, { path, method: 'POST' });
    return parseObject(desired ? desired.obj : await callRemoteJson(server, env, { path, method: 'POST' }));
  };
  const response = await readConfiguration(), config = parseObject(response.xraySetting);
  if (!Object.keys(config).length) throw new HttpError(502, 'Server configuration unavailable.');
  const outbounds = Array.isArray(config.outbounds) ? config.outbounds as JsonObject[] : [];
  if (outbounds.some(o => o.tag === outbound.tag)) throw new HttpError(409, 'An outbound with this tag already exists. Remove it or import with another tag.');
  const routing = parseObject(config.routing), rules = Array.isArray(routing.rules) ? routing.rules : [];
  let inboundTags: string[] = [];
  if (input.inboundIds !== undefined) {
    if (!Array.isArray(input.inboundIds) || input.inboundIds.length > 100 || input.inboundIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new HttpError(400, 'Select valid inbound IDs.');
    const listRequest = { path: '/panel/api/inbounds/list', method: 'GET' };
    const view = await managedRequest(env, server, listRequest);
    const list = (view ? view.obj : await callRemoteJson(server, env, listRequest)) as JsonObject[];
    if (!Array.isArray(list)) throw new HttpError(502, 'Could not read inbounds.');
    inboundTags = input.inboundIds.map(id => { const i = list.find(i => i.id === id); if (!i || i.protocol === 'dns-resolver' || server.kind === 'server' && !['vless','vmess','trojan','shadowsocks','http','socks','hysteria','tunnel'].includes(String(i.protocol))) throw new HttpError(400, 'Selected proxy inbound not found.'); return String(i.tag || `inbound-${id}`); });
  }
  const routed = Boolean(input.domains?.length || inboundTags.length);
  const next = { ...config, outbounds: [...outbounds, outbound], ...(routed ? { routing: { ...routing, rules: [{ type: 'field', ...(input.domains?.length ? { domain: input.domains } : {}), ...(inboundTags.length ? { inboundTag: inboundTags } : {}), outboundTag: outbound.tag }, ...rules] } } : {}) };
  const latest = await readConfiguration(); if (JSON.stringify(parseObject(latest.xraySetting)) !== JSON.stringify(config)) throw new HttpError(409, 'Configuration changed during preparation. Retry after refreshing.');
  const update = { path: path + 'update', method: 'POST', body: { xraySetting: JSON.stringify(next), outboundTestUrl: response.outboundTestUrl || '', expectedXraySetting: JSON.stringify(config) } };
  const saved = await managedRequest(env, server, update);
  if (saved) { if (ctx) ctx.waitUntil(reconcileServer(env, server)); } else await callRemoteJson(server, env, update);
  return Response.json({ applied: !saved?.pending, saved: true, pending: Boolean(saved?.pending), routed });
}

