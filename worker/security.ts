import { workspace } from '../shared/workspaces';
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Buffer } from 'node:buffer';
import { SignJWT, jwtVerify } from 'jose';
import { readOwner } from './owner-credentials';

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function equalSecret(a: string, b: string): Promise<boolean> {
  const hash = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return timingSafeEqual(await hash(a), await hash(b));
}
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  try {
    const bytes = Uint8Array.from(atob(key), c => c.charCodeAt(0));
    if (bytes.length !== 32) throw new Error();
    return bytes;
  } catch { throw new HttpError(503, 'ENCRYPTION_KEY must be a base64-encoded 32-byte key.'); }
}
export function configured(env: Env): boolean {
  try { keyBytes(env.ENCRYPTION_KEY); } catch { return false; }
  return Boolean(env.ADMIN_PASSWORD?.length >= 16 && env.SESSION_SECRET?.length >= 32);
}
export async function encrypt(value: unknown, key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey('raw', keyBytes(key), 'AES-GCM', false, ['encrypt']);
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify(value)));
  const bytes = new Uint8Array(iv.length + data.byteLength); bytes.set(iv); bytes.set(new Uint8Array(data), iv.length);
  return Buffer.from(bytes).toString('base64');
}
export async function decrypt<T>(value: string, key: string): Promise<T> {
  const data = Buffer.from(value, 'base64');
  const aes = await crypto.subtle.importKey('raw', keyBytes(key), 'AES-GCM', false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, aes, data.slice(12));
  return JSON.parse(new TextDecoder().decode(clear)) as T;
}
async function sessionKey(env: Env) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.SESSION_SECRET + env.ADMIN_PASSWORD)));
}
export async function issueSession(env: Env, member?: { id: string; version: number; username: string }, entry = ''): Promise<string> {
  const owner = member ? null : await readOwner(env);
  return new SignJWT({ ...(member ? { memberId: member.id, version: member.version } : owner ? { ownerVersion: owner.version } : {}), ...(entry ? { entry } : {}) }).setProtectedHeader({ alg: 'HS256' }).setSubject(member?.username ?? owner?.username ?? env.ADMIN_USERNAME)
    .setIssuer('benx-ui').setAudience('benx-ui').setIssuedAt().setExpirationTime('12h').sign(await sessionKey(env));
}
export async function authenticate(request: Request, env: Env): Promise<string> {
  const payload = await sessionClaims(request, env);
  if (payload.memberId || !payload.sub) throw new HttpError(401, 'Owner sign-in required.');
  return payload.sub;
}
export async function sessionClaims(request: Request, env: Env) {
  const entry = workspace(request.headers.get('X-Benx-Workspace'));
  const token = request.headers.get('cookie')?.split(';').map(s => s.trim()).find(s => s.startsWith(entry.cookie + '='))?.slice(entry.cookie.length + 1);
  if (!token) throw new HttpError(401, 'Please sign in.');
  try {
    const payload = (await jwtVerify(token, await sessionKey(env), { algorithms: ['HS256'], issuer: 'benx-ui', audience: 'benx-ui' })).payload;
    if (!payload.memberId) {
      const owner = await readOwner(env);
      if (owner ? payload.sub !== owner.username || payload.ownerVersion !== owner.version : Boolean(env.OWNER_SETUP_TOKEN) || payload.sub !== env.ADMIN_USERNAME) throw new Error();
    }
    if (entry.kind !== 'legacy' && payload.entry !== entry.path && !( !entry.accountId && ['customer', 'admin'].includes(entry.kind) && workspace(String(payload.entry)).kind === entry.kind)) throw new Error();
    return payload;
  } catch { throw new HttpError(401, 'Your session expired. Please sign in again.'); }
}
export function assertOrigin(request: Request): void {
  const origin = request.headers.get('origin');
  const url = new URL(request.url);
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (origin === url.origin || (local && ['http://127.0.0.1:5173', 'http://localhost:5173', 'http://127.0.0.1:4173', 'http://localhost:4173'].includes(origin ?? ''))) return;
  throw new HttpError(403, 'Request origin does not match BenX-UI.');
}
export function isPublicIp(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, '').toLowerCase();
  const version = isIP(ip);
  if (version === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113));
  }
  // IPv6 global unicast only; mapped, loopback, unique-local and link-local are excluded.
  return version === 6 && /^[23][0-9a-f]{3}:/.test(ip) && !ip.startsWith('2001:db8:');
}
export function validateUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new HttpError(400, 'Enter a valid HTTPS panel URL.'); }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(400, 'Use HTTPS with no embedded credentials, query, or fragment. Include the panel base path.');
  if ((isIP(host) && !isPublicIp(host)) || (!isIP(host) && (!host.includes('.') || /(?:^|\.)(localhost|local|internal|test|invalid)$/.test(host))) || host.endsWith('.')) {
    throw new HttpError(400, 'A publicly reachable HTTPS address is required. Use Cloudflare Tunnel for private servers.');
  }
  const decoded = decodeURIComponent(url.pathname);
  if (decoded.includes('\\') || /(?:^|\/)\.\.?($|\/)/.test(decoded)) throw new HttpError(400, 'Invalid panel base path.');
  return url.toString().replace(/\/?$/, '/');
}
export async function verifyPublicDns(url: string): Promise<void> {
  const hostname = new URL(validateUrl(url)).hostname.replace(/^\[|\]$/g, '');
  if (isIP(hostname)) return;
  const results = await Promise.all(['A', 'AAAA'].map(async type => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new HttpError(502, 'Unable to verify panel DNS.');
    const data = await response.json() as { Answer?: Array<{ type: number; data: string }> };
    return (data.Answer ?? []).filter(a => a.type === 1 || a.type === 28).map(a => a.data);
  }));
  const addresses = results.flat();
  if (!addresses.length || addresses.some(a => !isPublicIp(a))) throw new HttpError(400, 'Panel DNS must resolve exclusively to public addresses.');
}
export async function readLimited(response: Response | Request, limit = 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Payload is too large.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) { buffer.set(c, offset); offset += c.length; }
  return buffer;
}
export async function readJson<T>(request: Request): Promise<T> {
  if (!request.headers.get('content-type')?.includes('application/json')) throw new HttpError(415, 'Expected JSON.');
  try { return JSON.parse(new TextDecoder().decode(await readLimited(request))) as T; }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid JSON.'); }
}
