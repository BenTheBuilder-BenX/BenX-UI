import { HttpError } from './security';
export interface RelayEnvironment { SSH_RELAY_URL?: string; SSH_RELAY_BACKUP_URL?: string; SSH_RELAY_TOKEN?: string }
async function endpoint(env: RelayEnvironment): Promise<URL> {
  for (const address of [env.SSH_RELAY_URL, env.SSH_RELAY_BACKUP_URL]) {
    if (!address) continue;
    const url = new URL(address);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(503, 'SSH relay requires a secure HTTPS endpoint.');
    try {
      const response = await fetch(url.toString(), { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${env.SSH_RELAY_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation: 'health', input: {} }), signal: AbortSignal.timeout(3000) });
      if (!response.ok) { console.error(JSON.stringify({ event: 'relay_health_rejected', status: response.status })); await response.body?.cancel(); continue; }
      const result = await response.json() as { success?: boolean; obj?: { ready?: boolean } };
      if (response.ok && result.success && result.obj?.ready) return url;
      console.error(JSON.stringify({ event: 'relay_health_rejected', status: response.status }));
    } catch (e) { console.error(JSON.stringify({ event: 'relay_health_unreachable', category: e instanceof Error ? e.name : 'UnknownError' })); }
  }
  throw new HttpError(503, 'Neither SSH relay is available. Saved settings are retained; check relay health before retrying.');
}
export async function relayRequest<T>(env: RelayEnvironment, operation: string, input: unknown): Promise<T> {
  if (!env.SSH_RELAY_URL || !env.SSH_RELAY_TOKEN) throw new HttpError(503, 'SSH relay is not configured.');
  const url = await endpoint(env);
  let response: Response;
  try { response = await fetch(url.toString(), { method: 'POST', redirect: 'manual', headers: { Authorization: `Bearer ${env.SSH_RELAY_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operation, input }), signal: AbortSignal.timeout(35000) }); }
  catch { throw new HttpError(502, 'SSH relay could not be reached. Saved settings are retained; check relay health before retrying.'); }
  let result: { success?: boolean; obj?: T; msg?: string; status?: number };
  try { result = await response.json(); } catch { throw new HttpError(502, response.ok ? 'SSH relay returned an invalid response.' : 'The SSH relay could not complete this request. Check relay health and VPS connectivity before retrying.'); }
  if (!response.ok || result.success !== true) throw new HttpError([400, 409, 502, 503, 504].includes(result.status ?? 0) ? result.status! : 502, result.msg || 'SSH relay operation failed. Check its connection and server identity.');
  return result.obj as T;
}
