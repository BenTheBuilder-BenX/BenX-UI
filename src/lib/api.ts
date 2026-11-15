import type { RemoteRequest, Status } from '../../shared/types';
export const workspaceHeaders = () => ({ 'X-Benx-Workspace': location.pathname });
export class ApiError extends Error {
  constructor(message: string, public status: number, public code = 'request_failed', public requestId?: string) { super(message); this.name = 'ApiError'; }
}
const transient = new Set([500, 502, 503, 504]);
function unavailable(response: Response, text: string) {
  const cpu = /1102|exceeded.*(?:CPU|resource)|CPU.*limit/i.test(text);
  return new ApiError(cpu
    ? 'Cloudflare stopped this request because the Worker exceeded its CPU limit. The panel is still available; check the deployment CPU allowance.'
    : 'The connection returned an unexpected page instead of server data. Please retry; your saved settings have not been changed.', response.status || 502, cpu ? 'worker_cpu_limit' : 'invalid_response', response.headers.get('CF-Ray') ?? undefined);
}
async function decode<T>(response: Response): Promise<T> {
  const text = await response.text(); let data: unknown;
  try { data = JSON.parse(text); } catch { throw unavailable(response, text); }
  if (!response.ok) {
    const msg = data && typeof data === 'object' && 'msg' in data && typeof data.msg === 'string' ? data.msg : 'Request failed. Please retry.';
    throw new ApiError(msg, response.status);
  }
  return data as T;
}
/** Retry only known reads. A mutation is never replayed after an uncertain response. */
async function request<T>(path: string, init: RequestInit, safeRead: boolean, binary = false): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(45000) });
      if (response.status === 401 && path !== '/api/login') window.dispatchEvent(new Event('benx:session-expired'));
      if (binary && response.ok && response.headers.get('Content-Disposition')?.startsWith('attachment') && !/json|html/i.test(response.headers.get('Content-Type') || '')) return await response.blob() as T;
      return await decode<T>(response);
    } catch (cause) {
      const error = cause instanceof ApiError ? cause : new ApiError(cause instanceof Error && /Timeout|Abort/.test(cause.name)
        ? 'The server took too long to respond. You can keep using the panel and retry.'
        : 'The connection was interrupted. Please retry.', 0, 'connection_failed');
      if (!safeRead || attempt >= 1 || !(transient.has(error.status) || error.status === 0 || error.code === 'invalid_response')) throw error;
      await new Promise(resolve => setTimeout(resolve, 700 + Math.random() * 300));
    }
  }
}
export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  return request<T>(`/api${path}`, { method, headers: body instanceof FormData ? workspaceHeaders() : { ...workspaceHeaders(), 'Content-Type': 'application/json' }, body: body instanceof FormData ? body : body === undefined ? undefined : JSON.stringify(body) }, method === 'GET');
}
export async function panelRequest<T>(serverId: string, input: RemoteRequest): Promise<T> {
  const result = await request<T | { obj?: T; success?: boolean; msg?: string }>(`/api/servers/${serverId}/request`, { method: 'POST', headers: { ...workspaceHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, input.method === 'GET' || input.method === 'POST' && /\/(?:clients|inbounds)\/onlines$/.test(input.path), true);
  if (result instanceof Blob) return result as T;
  if (!result || typeof result !== 'object') throw new ApiError('The server returned invalid data. Please retry.', 502, 'invalid_response');
  const envelope = result as { obj?: T; success?: boolean; msg?: string };
  if (envelope.success === false) throw new ApiError(envelope.msg ?? 'Remote panel rejected this request.', 502);
  if ('revision' in result && 'pending' in result && input.method !== 'GET') window.dispatchEvent(new CustomEvent('benx:configuration-saved', {detail:{serverId,revision:result.revision,pending:result.pending}}));
  const value = envelope.obj ?? result;
  if (input.path === '/panel/api/server/status' && (!value || typeof (value as Status).cpu !== 'number' || !Number.isFinite((value as Status).cpu))) throw new ApiError('Server metrics are temporarily unavailable. Other panel features remain available.', 502, 'invalid_metrics');
  if (input.path === '/panel/api/inbounds/list' && !Array.isArray(value)) throw new ApiError('The server returned an invalid inbound list. Please retry.', 502, 'invalid_response');
  return value as T;
}
export async function backupDownload(serverId: string) {
  const result = await panelRequest<Blob>(serverId, { path: '/panel/api/server/getDb', method: 'GET' });
  if (!(result instanceof Blob)) throw new ApiError('The panel did not return a database backup.', 502);
  return result;
}
