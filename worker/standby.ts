import { portableCopy } from '../shared/portable-profile';
export { portableCopy } from '../shared/portable-profile';
import { managedRow, reconcileServer, saveManaged, savedDocument } from './control';
import type { StoredServer } from './remote';
import { HttpError, readJson } from './security';

interface Copy { target_id: string; source_id: string; enabled: number; source_revision: number; target_revision: number; phase: string; error: string; checked_at: number }
async function connection(env: Env, id: string) { return env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(id).first<StoredServer & { is_candidate: number }>(); }
async function activeReplacement(env: Env, id: string) { return env.DB.prepare("SELECT server_id FROM replacements WHERE (server_id=? OR candidate_id=?) AND state NOT IN ('completed','cancelled')").bind(id, id).first(); }
async function copyProfile(env: Env, copy: Copy, activate = false) {
  const lease = crypto.randomUUID();
  const claimed = await env.DB.prepare('UPDATE standby_copies SET lease=?,lease_until=? WHERE target_id=? AND enabled=1 AND lease_until<? RETURNING target_id').bind(lease, Date.now() + 240000, copy.target_id, Date.now()).first();
  if (!claimed) throw new HttpError(409, 'This standby is being prepared. Retry when it finishes.');
  try {
    const source = await connection(env, copy.source_id), target = await connection(env, copy.target_id);
    const from = await managedRow(env, copy.source_id), to = await managedRow(env, copy.target_id);
    if (!source || !target || !from || !to) throw new HttpError(409, 'Both servers need a saved configuration first.');
    if (await activeReplacement(env, source.id) || await activeReplacement(env, target.id)) throw new HttpError(409, 'Finish the VPS replacement before updating this standby.');
    if (from.bound && from.applied_revision !== from.revision) throw new HttpError(409, 'Waiting for the source server to confirm its current revision and recovery assets.');
    if (copy.target_revision && to.revision !== copy.target_revision) throw new HttpError(409, 'The target was edited independently. Reapprove its backup before replacing those changes.');
    if (!activate && copy.source_revision === from.revision) {
      await env.DB.prepare('UPDATE standby_copies SET phase=?,checked_at=?,error=? WHERE target_id=? AND lease=?').bind(to.bound && to.phase === 'synced' && to.applied_revision === copy.target_revision ? 'ready' : 'preparing', Date.now(), to.error || '', target.id, lease).run();
      return;
    }
    const d = portableCopy(await savedDocument(env, from), source.url, target.url, !activate);
    if (source.kind !== target.kind || source.version !== target.version) throw new HttpError(409, 'Choose a matching native server or matching panel API version.');
    // Source revisions and credentials are guarded; no copy can save a stale source after an edit.
    const fresh = await managedRow(env, source.id);
    if (fresh?.revision !== from.revision || fresh.document !== from.document) throw new HttpError(409, 'The source changed while preparing its backup. Retry.');
    if (!await env.DB.prepare('SELECT target_id FROM standby_copies WHERE target_id=? AND enabled=1 AND lease=? AND lease_until>?').bind(target.id, lease, Date.now()).first()) throw new HttpError(409, 'Standby approval changed or expired. Refresh and retry.');
    const revision = await saveManaged(env, to, d);
    const design = await env.DB.prepare('SELECT data FROM subscription_pages WHERE server_id=?').bind(source.id).first<{ data: string }>();
    if (design) await env.DB.prepare('INSERT INTO subscription_pages(server_id,data,version) VALUES(?,?,1) ON CONFLICT(server_id) DO UPDATE SET data=excluded.data,version=subscription_pages.version+1').bind(target.id, design.data).run();
    await env.DB.prepare('UPDATE standby_copies SET source_revision=?,target_revision=?,phase=?,enabled=?,checked_at=?,error=? WHERE target_id=? AND lease=?').bind(from.revision, revision, activate ? 'activated' : 'preparing', activate ? 0 : 1, Date.now(), '', target.id, lease).run();
    await reconcileServer(env, target, undefined, true);
  } catch (e) {
    await env.DB.prepare('UPDATE standby_copies SET phase=?,error=?,checked_at=? WHERE target_id=? AND lease=?').bind('waiting', e instanceof HttpError ? e.message : 'Standby update was not confirmed. Its previous saved profile is retained.', Date.now(), copy.target_id, lease).run();
    if (activate) throw e;
  } finally { await env.DB.prepare('UPDATE standby_copies SET lease=NULL,lease_until=0 WHERE target_id=? AND lease=?').bind(copy.target_id, lease).run(); }
}
export async function standbyRoute(request: Request, env: Env, source: StoredServer, ctx: ExecutionContext) {
  if (request.method === 'GET') return Response.json((await env.DB.prepare('SELECT c.*,s.name AS target_name FROM standby_copies c JOIN servers s ON s.id=c.target_id WHERE source_id=?').bind(source.id).all()).results);
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const b = await readJson<{ targetId: string; revision: number; action: string }>(request);
  const target = await connection(env, b.targetId);
  if (!target || target.id === source.id || target.is_candidate) throw new HttpError(400, 'Choose another saved server.');
  const old = await env.DB.prepare('SELECT * FROM standby_copies WHERE source_id=? AND target_id=?').bind(source.id, target.id).first<Copy>();
  if (b.action === 'pause') { if (!old) throw new HttpError(404, 'Standby not found.'); const paused = await env.DB.prepare('UPDATE standby_copies SET enabled=0,phase=? WHERE source_id=? AND target_id=? AND lease_until<? RETURNING target_id').bind('paused', source.id, target.id, Date.now()).first(); if (!paused) throw new HttpError(409, 'Wait for standby preparation to finish before pausing.'); return Response.json({ paused: true }); }
  if (b.action === 'activate') {
    if (!old?.enabled || old.phase !== 'ready') throw new HttpError(409, 'Wait for standby verification before activating it.');
    if ((await managedRow(env, target.id))?.revision !== b.revision) throw new HttpError(409, 'Standby configuration changed. Refresh before activating.');
    // Owner approval is required by this explicit POST; cron never activates listeners.
    await copyProfile(env, old, true); return Response.json({ activated: true, pending: true });
  }
  if (b.action !== 'approve') throw new HttpError(400, 'Choose approve, pause or activate.');
  if (source.kind !== 'server' || target.kind !== 'server') throw new HttpError(409, 'Standby copies currently require two full-access native servers. Use Import & migrate for panel workspaces.');
  if (await env.DB.prepare('SELECT target_id FROM standby_copies WHERE enabled=1 AND (target_id=? OR source_id=?)').bind(source.id, target.id).first()) throw new HttpError(409, 'Standby chains or cycles are not allowed. Choose a primary source and independent backup targets.');
  const to = await managedRow(env, target.id);
  if (!to || to.revision !== b.revision) throw new HttpError(409, 'Import or create the target profile and refresh before approving.');
  const document = await savedDocument(env, to);
  if (!old && (document.state.inbounds.length || Object.keys(document.state.clients).length || document.setup.panel === '3x-ui')) throw new HttpError(409, 'Use an empty target server. Standby preparation cannot overwrite existing customers or a private panel.');
  const from = await managedRow(env, source.id);
  if (!from || (await savedDocument(env, from)).setup.panel === '3x-ui') throw new HttpError(409, 'This source contains a private panel workspace. Use Replace server to restore its native and panel workspaces together.');
  const approved = await env.DB.prepare("INSERT INTO standby_copies(source_id,target_id,target_revision) SELECT ?,?,? WHERE NOT EXISTS(SELECT target_id FROM standby_copies WHERE enabled=1 AND (target_id=? OR source_id=?)) ON CONFLICT(target_id) DO UPDATE SET enabled=1,phase='pending',source_revision=0,target_revision=excluded.target_revision WHERE source_id=excluded.source_id AND lease_until<? RETURNING target_id").bind(source.id, target.id, to.revision, source.id, target.id, Date.now()).first();
  if (!approved) throw new HttpError(409, 'Standby approval changed, is busy, or would create a cycle. Refresh and retry.');
  const copy = await env.DB.prepare('SELECT * FROM standby_copies WHERE source_id=? AND target_id=?').bind(source.id, target.id).first<Copy>();
  if (!copy) throw new HttpError(409, 'The target already backs up another server.');
  ctx.waitUntil(copyProfile(env, copy)); return Response.json({ approved: true, pending: true });
}
export async function reconcileStandbys(env: Env) {
  const copies = (await env.DB.prepare('SELECT * FROM standby_copies WHERE enabled=1 AND lease_until<? ORDER BY checked_at LIMIT 4').bind(Date.now()).all<Copy>()).results;
  for (const copy of copies) await copyProfile(env, copy).catch(() => undefined);
}
