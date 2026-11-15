import { memberPath, workspace, matchesWorkspace } from '../shared/workspaces';
import type { Principal } from './team';
import { HttpError } from './security';
export async function ownerPath(env: Env) {
  let row = await env.DB.prepare('SELECT owner_path FROM workspace_settings WHERE id=1').first<{ owner_path: string }>();
  if (!row) {
    await env.DB.prepare('INSERT OR IGNORE INTO workspace_settings(id,owner_path) VALUES(1,?)').bind('/owner/' + crypto.randomUUID().replaceAll('-', '')).run();
    row = await env.DB.prepare('SELECT owner_path FROM workspace_settings WHERE id=1').first<{ owner_path: string }>();
  }
  return row!.owner_path;
}
export async function entryPath(env: Env, actor: Principal) { return actor.role === 'root' ? ownerPath(env) : memberPath(actor.role, actor.member!.id); }
export async function checkWorkspace(request: Request, env: Env, actor: Principal) {
  const entry = workspace(request.headers.get('X-Benx-Workspace'));
  if (!matchesWorkspace(entry, actor.role, actor.member?.id) || entry.kind === 'owner' && entry.path !== await ownerPath(env)) throw new HttpError(403, 'This account cannot use this workspace.');
}
