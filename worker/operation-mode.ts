import { HttpError, readJson } from './security';
export type OperationMode = 'manual' | 'automatic';
export async function operationMode(env: Env): Promise<OperationMode> {
  return (await env.DB.prepare('SELECT mode FROM operation_settings WHERE id=1').first<{mode: OperationMode}>())?.mode || 'manual';
}
export async function operationModeRoute(request: Request, env: Env, owner: boolean) {
  if (request.method === 'GET') return Response.json(await env.DB.prepare('SELECT mode,version FROM operation_settings WHERE id=1').first(), {headers:{'Cache-Control':'no-store'}});
  if (!owner) throw new HttpError(403, 'Only the owner can change the deployment operation mode.');
  if (request.method !== 'PUT') throw new HttpError(405, 'Method not allowed.');
  const body = await readJson<{mode: OperationMode; version: number}>(request);
  if (!['manual','automatic'].includes(body.mode) || !Number.isInteger(body.version)) throw new HttpError(400, 'Choose Manual or Automatic.');
  const row = await env.DB.prepare('UPDATE operation_settings SET mode=?,version=version+1 WHERE id=1 AND version=? RETURNING mode,version').bind(body.mode, body.version).first();
  if (!row) throw new HttpError(409, 'Operation mode changed. Refresh and retry.');
  return Response.json(row);
}
