import { validatePolicy, newPolicy, type ServerPolicy } from '../shared/policy';
import { verifySubscriptionHost } from './subscription-domain';
import { HttpError, readJson } from './security';
import { callRemoteJson, type StoredServer } from './remote';
import { managedRow, saveManaged, savedDocument, reconcileServer } from './control';
const json = (body: unknown) => Response.json(body, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' } });
export async function policyRoute(request: Request, env: Env, server: StoredServer, ctx?: ExecutionContext): Promise<Response> {
  const row = await env.DB.prepare('SELECT data, revision FROM server_policy WHERE server_id=?').bind(server.id).first<{ data: string; revision: number }>();
  if (request.method === 'GET') return json(row ? { ...JSON.parse(row.data), revision: row.revision } : newPolicy());
  if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
  let policy: ServerPolicy;
  try { policy = validatePolicy(await readJson(request)); } catch (e) { throw new HttpError(400, (e as Error).message); }
  if (policy.revision !== (row?.revision ?? 0)) throw new HttpError(409, 'These services changed in another session. Refresh before saving.');
  if(policy.subscriptionOrigin && policy.subscriptionOrigin!== (row?JSON.parse(row.data).subscriptionOrigin:undefined)) await verifySubscriptionHost(policy.subscriptionOrigin,env);
  const next = { ...policy, revision: policy.revision + 1 };
  const managed = await managedRow(env, server.id);
  if (managed) {
    const document = await savedDocument(env, managed);
    if (document.policy.revision !== policy.revision) throw new HttpError(409, 'Saved services changed. Refresh before saving.');
    document.policy = next;
    await saveManaged(env, managed, document);
    if (ctx) ctx.waitUntil(reconcileServer(env, server));
    return json({ policy: next, syncError: managed.bound ? 'Services saved. Server confirmation is pending; check Synchronization.' : 'Services saved. Connect a VPS to apply this profile.' });
  }
  const result = await env.DB.prepare(`INSERT INTO server_policy(server_id, revision, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision, data=excluded.data, updated_at=excluded.updated_at
    WHERE server_policy.revision=? RETURNING revision`).bind(server.id, next.revision, JSON.stringify(next), Date.now(), policy.revision).first();
  if (!result) throw new HttpError(409, 'These services changed in another session. Refresh before saving.');
  let syncError = '';
  if (server.kind === 'server') {
    try { await callRemoteJson(server, env, { path: '/benx/v1/policy', method: 'POST', body: { ...next } }); }
    catch { syncError = 'Saved in BenX-UI; agent policy sync is pending. Update/reconnect the agent before relying on native quota enforcement.'; }
  }
  return json({ policy: next, syncError });
}
