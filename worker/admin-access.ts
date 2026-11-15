import { HttpError, readJson } from './security';
import type { Principal } from './team';
import type { ServerScope } from '../shared/team';
export function canUseServer(actor: Principal, id: string) {
  if (actor.role === 'root') return true;
  const scope: ServerScope = JSON.parse(actor.member?.server_scope || '{"all":false,"ids":[]}');
  return actor.role === 'admin' && (scope.all || scope.ids.includes(id));
}
export function requireServer(actor: Principal, id: unknown) {
  if (typeof id !== 'string' || !canUseServer(actor, id)) throw new HttpError(403, 'This server is outside your assigned access.');
}
export async function adminAccess(request: Request, env: Env, actor: Principal) {
  if (actor.role === 'root') return;
  if (actor.role !== 'admin') throw new HttpError(403, 'Use your customer workspace.');
  const path = new URL(request.url).pathname;
  if (['/api/servers', '/api/audit', '/api/providers/vpnjantit', '/api/operation-mode'].includes(path) && request.method === 'GET') return;
  const server = path.match(/^\/api\/servers\/([^/]+)\/(request|health|probe|restore|upload|policy|subscriptions|subscription-page|locations|control|dashboard)$/);
  if (server) {
    requireServer(actor, server[1]);
    if (server[2] === 'control' && request.method !== 'GET') {
      const body = await readJson<{ sourceId?: string; action: string }>(request.clone() as Request);
      if (body.sourceId) requireServer(actor, body.sourceId);
    }
    return;
  }
  const global = path.match(/^\/api\/(lab|tunnels|tunnel-tests)(?:\/([a-f0-9-]{36})(?:\/(report|manifest))?)?$/);
  if (global) {
    if (global[2]) {
      const table = { lab: 'lab_experiments', tunnels: 'tunnels', 'tunnel-tests': 'tunnel_tests' }[global[1]]!;
      const row = await env.DB.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(global[2]).first<Record<string, unknown>>();
      if (!row) throw new HttpError(404, 'Resource not found.');
      if (global[1] === 'lab') requireServer(actor, row.server_id);
      else { requireServer(actor, row.source_id); requireServer(actor, row.target_id); }
    } else if (request.method !== 'GET') {
      const body = await readJson<Record<string, unknown>>(request.clone() as Request);
      if (global[1] === 'lab') requireServer(actor, body.serverId);
      else {
        const input = global[1] === 'tunnel-tests' ? body.input as Record<string, unknown> : body;
        requireServer(actor, input?.sourceId); requireServer(actor, input?.targetId);
      }
    }
    return;
  }
  if (path === '/api/fleet/inbounds' && request.method === 'POST') {
    const body = await readJson<{ serverIds: string[] }>(request.clone() as Request);
    if (!Array.isArray(body.serverIds)) throw new HttpError(400, 'Choose servers.');
    for (const id of body.serverIds) requireServer(actor, id);
    return;
  }
  throw new HttpError(403, 'Only the owner can change connections, team accounts and workspace secrets.');
}
