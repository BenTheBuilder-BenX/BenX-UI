import { multiplier } from '../shared/policy';
import { reduceDocument, withDefaultPublicHost } from '../shared/managed';
import type { JsonObject } from '../shared/types';
import { adoptServer, managedRow, reconcileServer, saveManaged, savedDocument } from './control';
import type { StoredServer } from './remote';
import { HttpError, readJson } from './security';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, v]) => v !== undefined).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',')}}`;
  return JSON.stringify(value);
}

export async function fleetInbound(request: Request, env: Env, ctx: ExecutionContext) {
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const input = await readJson<{ id?: string; serverIds: string[]; inbound: JsonObject; multiplier?: number }>(request);
  if (!Array.isArray(input.serverIds) || !input.serverIds.length || input.serverIds.length > 50 || new Set(input.serverIds).size !== input.serverIds.length || !input.inbound) throw new HttpError(400, 'Choose one or more saved servers and an inbound configuration.');
  const id = input.id || crypto.randomUUID();
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new HttpError(400, 'Invalid inbound deployment ID.');
  let rate: number; try { rate = multiplier(input.multiplier ?? 1); } catch (e) { throw new HttpError(400, (e as Error).message); }
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical({ serverIds: [...input.serverIds].sort(), inbound: input.inbound, multiplier: rate })));
  const fingerprint = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2, '0')).join('');
  await env.DB.prepare('INSERT OR IGNORE INTO fleet_requests(id,fingerprint,created_at) VALUES(?,?,?)').bind(id, fingerprint, Date.now()).run();
  const manifest = await env.DB.prepare('SELECT fingerprint FROM fleet_requests WHERE id=?').bind(id).first<{ fingerprint: string }>();
  if (manifest?.fingerprint !== fingerprint) throw new HttpError(409, 'This deployment already has a different saved configuration. Start a new inbound to change its settings.');
  const results: Array<{ serverId: string; inboundId?: number; saved: boolean; error?: string }> = [];
  for (const serverId of input.serverIds) {
    try {
      const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(serverId).first<StoredServer>();
      if (!server) throw new HttpError(404, 'Saved server not found.');
      const done = await env.DB.prepare('SELECT inbound_id FROM fleet_inbounds WHERE id=? AND server_id=?').bind(id, serverId).first<{ inbound_id: number }>();
      if (done) { results.push({ serverId, inboundId: done.inbound_id, saved: true }); continue; }
      const row = await managedRow(env, serverId) || await adoptServer(env, server), d = await savedDocument(env, row);
      const marked = d.state.inbounds.find(i => i._benxDeployment === id);
      const next = marked ? { document: d, result: { id: marked.id } } : reduceDocument(d, { path: '/panel/api/inbounds/add', method: 'POST', body: { ...(d.mode === 'native' ? withDefaultPublicHost(input.inbound, server.url) : input.inbound), id: undefined, _benxDeployment: id, nodeId: input.serverIds.length === 1 && d.mode === 'panel' ? input.inbound.nodeId || 0 : 0 } });
      const inboundId = Number(next.result.id);
      next.document.policy.inboundMultipliers[inboundId] = rate; next.document.policy.revision++;
      if (!marked) await saveManaged(env, row, next.document);
      await env.DB.prepare('INSERT OR IGNORE INTO fleet_inbounds(id,server_id,inbound_id) VALUES(?,?,?)').bind(id, serverId, inboundId).run();
      ctx.waitUntil(reconcileServer(env, server));
      results.push({ serverId, inboundId, saved: true });
    } catch (e) { results.push({ serverId, saved: false, error: e instanceof HttpError ? e.message : (e as Error).message }); }
  }
  return Response.json({ id, results });
}
