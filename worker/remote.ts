import operations from '../shared/operations.json';
import { Buffer } from 'node:buffer';
import { isAgentOperation } from '../shared/cores';
import type { JsonObject, RemoteRequest, Server } from '../shared/types';
import { decrypt, HttpError, readLimited, verifyPublicDns } from './security';
import { agentOverSSH, type SSHConnection } from './ssh';
import { outboundRequest } from './outbound-agent';

export interface StoredServer extends Server { credentials: string }
export interface Credentials { username?: string; password?: string; token?: string; accessId?: string; accessSecret?: string; ssh?: SSHConnection; installedPanel?: boolean }
export function findOperation(path: string, method: string, version: string) {
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('\\')) throw new HttpError(400, 'Invalid API path.');
  let segments: string[];
  try { segments = path.split('/').map(decodeURIComponent); } catch { throw new HttpError(400, 'Invalid API path encoding.'); }
  if (segments.some(s => s === '.' || s === '..' || s.includes('/') || s.includes('\\') || Array.from(s).some(c => c.charCodeAt(0) < 32) || /%[0-9a-f]{2}/i.test(s))) throw new HttpError(400, 'Invalid API path segment.');
  const exact = operations.find(o => o.version === version && o.method === method && o.path === path);
  if (exact) return exact;
  const operation = operations.find(o => o.version === version && o.method === method &&
    new RegExp('^' + o.path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/]+') + '$').test(path));
  if (!operation) throw new HttpError(400, 'This operation is not supported by the selected API version.');
  return operation;
}
export function formBody(body: JsonObject, path = ''): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (path.startsWith('/panel/api/sub-balancers') && key === 'inboundIds' && Array.isArray(value)) {
      for (const id of value) form.append(key, String(id));
    } else form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value ?? ''));
  }
  return form;
}
function targetUrl(server: StoredServer, path: string): string {
  const base = new URL(server.url);
  const target = new URL(base.toString().replace(/\/$/, '') + path);
  if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) throw new HttpError(400, 'API path escaped the configured panel.');
  return target.toString();
}
async function remoteFetch(url: string, init: RequestInit) {
  try {
    const response = await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, 'Panel redirected the request. Check its HTTPS URL and full base path.'); }
    return response;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'Cannot reach the remote panel. Check its address, certificate, firewall, and Cloudflare Access service token.');
  }
}
async function remoteJson(response: Response) {
  const bytes = await readLimited(response, 4 * 1024 * 1024);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as JsonObject; }
  catch { throw new HttpError(502, 'Panel returned a non-JSON response. Check the base path, API version, and authentication.'); }
}
export async function remoteHeaders(server: StoredServer, env: Env): Promise<Headers> {
  const credentials = await decrypt<Credentials>(server.credentials, env.ENCRYPTION_KEY);
  const headers = new Headers({ accept: 'application/json' });
  if (credentials.accessId && credentials.accessSecret) {
    headers.set('CF-Access-Client-Id', credentials.accessId);
    headers.set('CF-Access-Client-Secret', credentials.accessSecret);
  }
  if (server.auth === 'token') { headers.set('Authorization', `Bearer ${credentials.token}`); return headers; }
  const login = await remoteFetch(targetUrl(server, '/login'), {
    method: 'POST', headers: new Headers([...headers, ['content-type', 'application/x-www-form-urlencoded']]),
    body: formBody({ username: credentials.username, password: credentials.password }),
  });
  const cookieHeaders = login.headers.getSetCookie();
  const cookies = cookieHeaders.map(c => c.split(';')[0]).filter(c => c && !c.endsWith('=')).join('; ');
  const result = await remoteJson(login);
  if (!result.success || !cookies) throw new HttpError(502, 'Remote panel login failed. Check its credentials; 2FA panels require an API token.');
  headers.set('Cookie', cookies);
  if (server.version === 'v3') {
    const csrf = await remoteFetch(targetUrl(server, '/csrf-token'), { headers });
    const data = await remoteJson(csrf);
    if (!csrf.ok || !data.success || typeof data.obj !== 'string') throw new HttpError(502, 'Unable to obtain remote CSRF token.');
    headers.set('X-CSRF-Token', data.obj);
  }
  return headers;
}
export async function callRemote(server: StoredServer, env: Env, input: RemoteRequest, upload?: FormData): Promise<Response> {
  if (input.path.startsWith('/benx/')) {
    if (server.kind !== 'server') throw new HttpError(403, 'Core management requires a full-access server connection.');
    if (!isAgentOperation(input.path, input.method)) throw new HttpError(400, 'Unsupported server management operation.');
  }
  const operation = input.path.startsWith('/benx/') ? { encoding: 'application/json' } : findOperation(input.path, input.method, server.version);
  if (!server.enabled) throw new HttpError(409, 'This server connection is disabled.');
  if (server.parent_id && !(await env.DB.prepare('SELECT enabled FROM servers WHERE id=?').bind(server.parent_id).first<{ enabled: number }>())?.enabled) throw new HttpError(409, 'The full-access connection for this managed panel is disabled.');
  if (server.url.startsWith('agent://')) {
    if (server.kind !== 'server' || upload || operation.encoding === 'multipart/form-data') throw new HttpError(400, 'Outbound agents support native JSON operations only.');
    if (input.path === '/benx/v1/setup' && input.method === 'POST' && input.body?.panel === '3x-ui') throw new HttpError(400, 'Outbound mode manages native cores. Optional private panel installation requires the SSH bridge.');
    return outboundRequest(server.id, env, input);
  }
  if (server.url.startsWith('ssh://')) {
    const credentials = await decrypt<Credentials>(server.credentials, env.ENCRYPTION_KEY);
    if (!credentials.ssh || !credentials.token || server.kind !== 'server' && !credentials.installedPanel) throw new HttpError(400, 'Invalid private agent connection.');
    if (upload || operation.encoding === 'multipart/form-data') throw new HttpError(400, 'File uploads are unavailable on the native management agent.');
    const query = new URLSearchParams(input.query).toString();
    if (credentials.installedPanel) {
      const result = await agentOverSSH(credentials.ssh, credentials.token, '/benx/v1/installed-panel/request', 'POST', JSON.stringify({ path: input.path, method: input.method, query: input.query ?? {}, body: input.body ?? {}, encoding: operation.encoding }), env);
      const data = await remoteJson(result);
      if (!result.ok || data.success === false) throw new HttpError(502, String(data.msg || 'Private 3X-UI request failed.'));
      const payload = data.obj as { status: number; contentType: string; body: string; disposition?: string };
      if (!payload || !Number.isInteger(payload.status) || typeof payload.body !== 'string') throw new HttpError(502, 'Invalid private panel response.');
      if (payload.status === 401 || payload.status === 403) throw new HttpError(502, 'Remote panel denied access. Check credentials, token scopes, or Cloudflare Access.');
      return new Response(new Uint8Array(Buffer.from(payload.body, 'base64')), { status: payload.status, headers: { 'Content-Type': payload.contentType, ...(payload.disposition ? { 'Content-Disposition': payload.disposition } : {}) } });
    }
    const response = await agentOverSSH(credentials.ssh, credentials.token, input.path + (query ? `?${query}` : ''), input.method, input.method === 'GET' ? undefined : JSON.stringify(input.body ?? {}), env);
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new HttpError(502, 'Remote agent denied access. Check its connection credentials.'); }
    return response;
  }
  await verifyPublicDns(server.url);
  const headers = await remoteHeaders(server, env);
  const url = new URL(targetUrl(server, input.path));
  for (const [key, value] of Object.entries(input.query ?? {})) url.searchParams.set(key, value);
  let body: BodyInit | undefined;
  if (input.method !== 'GET') {
    if (upload) { body = upload; }
    else if (operation.encoding === 'multipart/form-data') throw new HttpError(400, 'This operation requires a file upload. Use Backup & Restore.');
    else if (operation.encoding === 'application/x-www-form-urlencoded' || server.version === 'v2') {
      headers.set('Content-Type', 'application/x-www-form-urlencoded');
      body = formBody(input.body ?? {}, input.path);
    } else { headers.set('Content-Type', 'application/json'); body = JSON.stringify(input.body ?? {}); }
  }
  const response = await remoteFetch(url.toString(), { method: input.method, headers, body });
  if (response.status === 404) { await response.body?.cancel(); throw new HttpError(404, 'The remote panel does not expose this endpoint. Check the selected API version and panel release.'); }
  if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new HttpError(502, 'Remote panel denied access. Check credentials, token scopes, or Cloudflare Access.'); }
  return response;
}
export async function callRemoteJson(server: StoredServer, env: Env, input: RemoteRequest): Promise<unknown> {
  const response = await callRemote(server, env, input);
  const result = await remoteJson(response);
  if (!response.ok || result.success === false) throw new HttpError(502, typeof result.msg === 'string' ? result.msg.slice(0, 1000) : 'Remote operation failed.');
  return result.obj ?? result;
}
