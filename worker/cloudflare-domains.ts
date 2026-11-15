import { isIP } from 'node:net';
import { SignJWT, jwtVerify } from 'jose';
import { HttpError, isPublicIp, readJson } from './security';

interface Zone { id: string; name: string; status: string; account: { id: string } }
interface DNSRecord { id: string; name: string; type: string; content: string; proxied: boolean }
export interface DomainIntent { kind: 'vps' | 'worker'; zoneId: string; hostname: string; address?: string }
interface Preview extends DomainIntent { zoneName: string; record?: { type: string; name: string; content: string; proxied: false; ttl: number }; service?: string }
const configured = (env: Env) => Boolean(env.CF_API_TOKEN && /^[a-f0-9]{32}$/.test(env.CF_ACCOUNT_ID || ''));
async function cf<T>(env: Env, path: string, method = 'GET', body?: unknown): Promise<{ result: T; result_info?: { total_pages?: number } }> {
  if (!configured(env)) throw new HttpError(503, 'Optional Cloudflare integration is not configured. Use the manual DNS instructions.');
  let response: Response;
  try { response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(12000), headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); }
  catch { throw new HttpError(502, 'Cloudflare did not confirm this request. Check its dashboard before retrying a change.'); }
  const data = await response.json() as { success: boolean; result: T; result_info?: { total_pages?: number }; errors?: { code: number }[] };
  if (!response.ok || !data.success) throw new HttpError(502, `Cloudflare rejected the request (${data.errors?.[0]?.code ?? response.status}). Check account, zone and token permissions.`);
  return data;
}
export function validateDomainIntent(input: DomainIntent, zoneName: string): DomainIntent {
  if (!input || !['vps', 'worker'].includes(input.kind) || !/^[a-f0-9]{32}$/.test(input.zoneId)) throw new HttpError(400, 'Choose a Cloudflare zone and domain purpose.');
  const hostname = typeof input.hostname === 'string' ? input.hostname.toLowerCase().trim().replace(/\.$/, '') : '';
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname) || hostname !== zoneName && !hostname.endsWith('.' + zoneName)) throw new HttpError(400, 'The hostname must belong to the selected zone.');
  const address = String(input.address || '').trim();
  if (input.kind === 'vps' && (!isIP(address) || !isPublicIp(address))) throw new HttpError(400, 'Enter the VPS public IPv4 or IPv6 address.');
  return { kind: input.kind, zoneId: input.zoneId, hostname, ...(input.kind === 'vps' ? { address } : {}) };
}
async function preview(env: Env, value: DomainIntent): Promise<Preview> {
  if (!value || !/^[a-f0-9]{32}$/.test(value.zoneId || '')) throw new HttpError(400, 'Choose a valid zone.');
  const zone = (await cf<Zone>(env, `/zones/${value.zoneId}`)).result;
  if (zone.account?.id !== env.CF_ACCOUNT_ID || zone.status !== 'active') throw new HttpError(409, 'Use an active zone in the configured Cloudflare account.');
  const input = validateDomainIntent(value, zone.name);
  if (input.kind === 'worker' && !/^[a-zA-Z0-9_-]{1,63}$/.test(env.CF_WORKER_NAME || '')) throw new HttpError(503, 'Set CF_WORKER_NAME to the deployed BenX Worker name.');
  return { ...input, zoneName: zone.name, ...(input.kind === 'vps' ? { record: { type: isIP(input.address!) === 6 ? 'AAAA' : 'A', name: input.hostname, content: input.address!, proxied: false, ttl: 1 } } : { service: env.CF_WORKER_NAME }) };
}
export async function domainsRoute(request: Request, env: Env) {
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (!configured(env)) return Response.json({ configured: false, zones: [], worker: Boolean(env.CF_WORKER_NAME) });
    const page = Number(url.searchParams.get('page') || '1');
    if (!Number.isInteger(page) || page < 1 || page > 100) throw new HttpError(400, 'Invalid zone page.');
    const data = await cf<Zone[]>(env, `/zones?account.id=${env.CF_ACCOUNT_ID}&status=active&per_page=50&page=${page}`);
    return Response.json({ configured: true, zones: data.result.map(z => ({ id: z.id, name: z.name })), nextPage: page < (data.result_info?.total_pages || 1) ? page + 1 : null, worker: Boolean(env.CF_WORKER_NAME) });
  }
  if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
  const secret = new TextEncoder().encode(env.SESSION_SECRET);
  if (url.pathname === '/api/cloudflare/preview') {
    const plan = await preview(env, await readJson<DomainIntent>(request));
    const intent = await new SignJWT({ plan }).setProtectedHeader({ alg: 'HS256' }).setAudience('benx-domain-change').setIssuedAt().setExpirationTime('5m').sign(secret);
    return Response.json({ plan, intent });
  }
  if (url.pathname !== '/api/cloudflare/apply') throw new HttpError(404, 'Domain route not found.');
  const input = await readJson<{ intent: string }>(request);
  let planned: Preview;
  try { const token = await jwtVerify(input.intent, secret, { algorithms: ['HS256'], audience: 'benx-domain-change' }); planned = token.payload.plan as Preview; }
  catch { throw new HttpError(409, 'The preview expired. Preview the domain change again.'); }
  const plan = await preview(env, planned);
  if (JSON.stringify(plan) !== JSON.stringify(planned)) throw new HttpError(409, 'The deployment or zone changed after preview. Review a fresh preview.');
  // Recheck the exact target just before a write. Never overwrite another record/service.
  const records = (await cf<DNSRecord[]>(env, `/zones/${plan.zoneId}/dns_records?name=${encodeURIComponent(plan.hostname)}&per_page=100`)).result;
  if (plan.kind === 'vps') {
    const same = records.length === 1 && records[0].type === plan.record!.type && records[0].content === plan.address && records[0].proxied === false;
    if (records.length && !same) throw new HttpError(409, 'This hostname already has DNS records. Use an unused name or review them manually in Cloudflare.');
    const record = same ? records[0] : (await cf<DNSRecord>(env, `/zones/${plan.zoneId}/dns_records`, 'POST', plan.record)).result;
    return Response.json({ confirmed: true, unchanged: same, hostname: plan.hostname, record, message: 'DNS record saved. Propagation, firewall access and VPN connectivity still need verification.' });
  }
  const domains = (await cf<Array<{ hostname: string; service: string; enabled: boolean }>>(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`)).result;
  const existing = domains.find(d => d.hostname === plan.hostname);
  if (existing && existing.service !== plan.service || !existing && records.length) throw new HttpError(409, 'This hostname is already in use. Choose a new hostname; existing services are preserved.');
  if (existing && !existing.enabled) throw new HttpError(409, 'This Worker domain is disabled. Review it in Cloudflare before enabling.');
  if (!existing) await cf(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`, 'PUT', { hostname: plan.hostname, service: plan.service, enabled: true, zone_id: plan.zoneId, zone_name: plan.zoneName });
  return Response.json({ confirmed: true, unchanged: Boolean(existing), hostname: plan.hostname, message: 'Worker domain attached. Wait for TLS activation, then verify sign-in and a private subscription. Existing URLs and server addresses were not rewritten.' });
}
