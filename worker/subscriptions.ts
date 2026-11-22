import { managedRow, savedDocument } from './control';
import { advertisedHosts } from '../shared/hosts';
import { enabledSubscriptionFormats, formatNames, newPolicy, validClientName, type ServerPolicy } from '../shared/policy';
import { subscriptionMetadata, subscriptionUsage, utf8Base64 } from './subscription-metadata';
import { subscriptionLanding } from './subscription-page';
import { accountSubscriptionAllowed } from './team';
import { subscription } from '../shared/subscriptions';
import { inboundClients, parseObject, type Inbound } from '../shared/types';
import { shareLink } from '../src/lib/links';
import { callRemoteJson, type StoredServer } from './remote';
import { decrypt, encrypt, HttpError, readJson } from './security';
async function hash(token: string) { return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))), b => b.toString(16).padStart(2, '0')).join(''); }
export async function issueStoreSubscription(env: Env, server: StoredServer, email: string, subId: string, reuse = true) {
  const identity = await hash(subId);
  const lookup = () => env.DB.prepare('SELECT secret,identity FROM subscriptions WHERE server_id=? AND email=?').bind(server.id, email).first<{ secret: string; identity: string }>();
  const prior = reuse ? await lookup() : null;
  if (prior?.identity === identity) return decrypt<string>(prior.secret, env.ENCRYPTION_KEY);
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, '0')).join('');
  const result = await env.DB.prepare(`INSERT INTO subscriptions(server_id,email,token_hash,secret,created_at,identity) VALUES(?,?,?,?,?,?)
    ON CONFLICT(server_id,email) DO UPDATE SET token_hash=excluded.token_hash,secret=excluded.secret,created_at=excluded.created_at,identity=excluded.identity
    WHERE ?=0 OR (subscriptions.identity=? AND subscriptions.identity!=excluded.identity)`)
    .bind(server.id, email, await hash(token), await encrypt(token, env.ENCRYPTION_KEY), Date.now(), identity, Number(reuse), prior?.identity ?? null).run();
  if (result.meta.changes) return token;
  const current = await lookup();
  if (current?.identity === identity) return decrypt<string>(current.secret, env.ENCRYPTION_KEY);
  throw new HttpError(409, 'The subscription changed while sharing. Open Share again.');
}
export async function subscriptionAdmin(request: Request, env: Env, server: StoredServer) {
  if (request.method === 'GET') { const rows = (await env.DB.prepare('SELECT email,secret FROM subscriptions WHERE server_id=?').bind(server.id).all<{ email: string; secret: string }>()).results; return Response.json(await Promise.all(rows.map(async r => ({ email: r.email, token: await decrypt<string>(r.secret, env.ENCRYPTION_KEY) })))); }
  const { email, revoke, reuse } = await readJson<{ email: string; revoke?: boolean; reuse?: boolean }>(request);
  if (!validClientName(email) || server.version !== 'v3') throw new HttpError(400, 'Worker subscriptions require a 3.x or full-access client identity.');
  if (revoke === true) { await env.DB.prepare('DELETE FROM subscriptions WHERE server_id=? AND email=?').bind(server.id, email).run(); return Response.json({ revoked: true }); }
  const detail = parseObject(await callRemoteJson(server, env, { path: `/panel/api/clients/get/${encodeURIComponent(email)}`, method: 'GET' })), client = parseObject(detail.client || detail);
  if (typeof client.subId !== 'string' || !client.subId || client.subId.length > 128) throw new HttpError(400, 'Set a unique subscription ID on this client before issuing Worker access.');
  return Response.json({ email, token: await issueStoreSubscription(env, server, email, client.subId, reuse === true) });
}
export async function nativeSubscriptionLinks(server: StoredServer, env: Env, email: string, allowed: Inbound[], format = 'raw') {
  const profile = await managedRow(env, server.id), document = profile ? profile.applied_revision === profile.revision ? await savedDocument(env, profile) : await callRemoteJson(server, env, {path:'/benx/v1/control/export', method:'GET'}) as import('../shared/managed').ManagedDocument : undefined;
  const storefront = document?.state?.storefront;
  const proxyUsername = `benx_${(await hash(email)).slice(0,20)}`;
    let links: string[];
    try { links = allowed.filter(i => ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks', 'hysteria'].includes(i.protocol)).flatMap(original => { const i = structuredClone(original); let address = String(parseObject(i.settings).publicHost || (server.url.startsWith("agent://") ? "" : new URL(server.url).hostname)).replace(/^\[|\]$/g, '');
      if(storefront?.enabled && (storefront.inboundIds as number[]).includes(i.id)) { address=String(storefront.domain); i.port=Number(storefront.port); i.streamSettings={...parseObject(i.streamSettings), security:'tls', tlsSettings:{serverName:address}, wsSettings:{...parseObject(parseObject(i.streamSettings).wsSettings),headers:{Host:address}}}; }
      return advertisedHosts(i, document?.hosts || [], address, format).map(h=>{ if (!h.address) throw new Error("Set the actual VPS public host before sharing this inbound. The agent identity is not a VPN address."); return shareLink(h.inbound, { ...inboundClients(i).find(c => c.email === email)!, proxyUsername }, h.address); }); }); } catch (e) { throw new HttpError(409, (e as Error).message); }
    if (allowed.some(i => ['ssh', 'wireguard-native', 'wireguard', 'masterdnsvpn'].includes(i.protocol))) {
      const profiles = await callRemoteJson(server, env, { path: `/panel/api/clients/links/${encodeURIComponent(email)}`, method: 'GET' }) as string[];
      if (!Array.isArray(profiles) || profiles.some(profile => typeof profile !== 'string')) throw new HttpError(502, 'The server returned invalid connection profiles.');
      const dns = allowed.find(i => i.protocol === 'masterdnsvpn');
      const dnsCustomer = dns && inboundClients(dns).find(c => c.email === email);
      if (dns && parseObject(dns.settings).meteredInboundId) {
        const uuid = dnsCustomer?.uuid || dnsCustomer?.id;
        const inner = profiles.find(profile => {
          if (!profile.startsWith('vless://') || !profile.endsWith('#MasterDNSVPN-metered')) return false;
          try {
            const uri = new URL(profile);
            return uri.username === uuid && uri.hostname === '127.0.0.1' && uri.port === '18000' && !uri.password;
          } catch { return false; }
        });
        if (!inner) throw new HttpError(409, 'The server has not supplied this customer’s metered MasterDNS link. Synchronize the server and retry.');
        links.push(inner);
      }
      for (const link of profiles.filter(p => /^(ssh|wireguard|masterdns):\/\//.test(p))) {
        const protocol = link.startsWith('ssh:') ? 'ssh' : link.startsWith('wireguard:') ? 'wireguard-native' : 'masterdnsvpn';
        if (allowed.some(i => (i.protocol === protocol || protocol === 'wireguard-native' && i.protocol === 'wireguard') && (protocol === 'masterdnsvpn' ? !parseObject(i.settings).meteredInboundId && JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(link.slice(12)), c => c.charCodeAt(0)))).domain === (parseObject(i.settings).DOMAIN as string[])?.[0] : new URL(link).port === String(i.port)))) links.push(link);
      }
    }
  return links;
}
function matchingDNSConfig(profile: string, inbound: Inbound) {
  if (!profile.startsWith('{')) return false;
  const data = parseObject(profile), settings = parseObject(inbound.settings);
  return typeof data.ENCRYPTION_KEY === 'string' && Boolean(data.ENCRYPTION_KEY)
    && Array.isArray(data.DOMAINS) && Array.isArray(settings.DOMAIN) && data.DOMAINS.includes(settings.DOMAIN[0])
    && data.PROTOCOL_TYPE === (settings.meteredInboundId ? 'TCP' : 'SOCKS5');
}
export async function publicSubscription(request: Request, env: Env) {
  const match = new URL(request.url).pathname.match(/^\/sub\/([a-f0-9]{64})(?:\/(v2ray|v2box|singbox|clash|happ|page|download))?$/);
  if (!match || request.method !== 'GET') throw new HttpError(404, 'Subscription not found.');
  const row = await env.DB.prepare('SELECT server_id,email,identity FROM subscriptions WHERE token_hash=?').bind(await hash(match[1])).first<{ server_id: string; email: string; identity: string }>();
  if (!row) throw new HttpError(404, 'Subscription not found or revoked.');
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(row.server_id).first<StoredServer>();
  if (!await accountSubscriptionAllowed(env, row.server_id, row.email)) throw new HttpError(403, 'Customer account is paused or depleted.');
  if (!server || !server.enabled) throw new HttpError(404, 'Subscription unavailable.');
  const requested = match[2] || (request.headers.get('Accept')?.includes('text/html') ? 'page' : undefined);
  if (requested === 'page') return subscriptionLanding(request, env, server, row.email, match[1], row.identity);
  const stored = await env.DB.prepare('SELECT data FROM server_policy WHERE server_id=?').bind(server.id).first<{ data: string }>();
  const policy: ServerPolicy = stored ? JSON.parse(stored.data) : newPolicy();
  const plan = policy.services.find(s => s.id === policy.clients[row.email]?.serviceId);
  const permitted = enabledSubscriptionFormats(policy, plan);
  const format = requested || (permitted.includes('v2box') ? 'v2box' : permitted[0] || 'v2box');
  if (format !== 'download' && !permitted.some(f => f === format)) throw new HttpError(403, 'This service does not include this subscription format.');
  const detail = parseObject(await callRemoteJson(server, env, { path: `/panel/api/clients/get/${encodeURIComponent(row.email)}`, method: 'GET' }));
  const usage = subscriptionUsage(detail), { client } = usage;
  if (typeof client.subId !== 'string' || !row.identity || await hash(client.subId) !== row.identity) throw new HttpError(404, 'Subscription identity changed. Ask the administrator to issue a new access URL.');
  if (!usage.active) throw new HttpError(403, 'Client disabled, depleted or expired.');
  let links: string[];
  if (server.kind === 'server') {
    const inbounds = await callRemoteJson(server, env, { path: '/panel/api/inbounds/list', method: 'GET' }) as Inbound[];
    const allowed = inbounds.filter(i => i.enable && !i.excludeFromSub && !(i.expiryTime > 0 && i.expiryTime < Date.now()) && (!plan || plan.inbounds.some(p => p.inboundId === i.id)) && inboundClients(i).some(c => c.email === row.email));
    if (format === 'download') {
      const id = Number(new URL(request.url).searchParams.get('inbound')), inbound = allowed.find(i => i.id === id);
      if (!inbound || !['openvpn', 'openconnect', 'ssh', 'wireguard-native', 'wireguard', 'masterdnsvpn'].includes(inbound.protocol)) throw new HttpError(404, 'Profile unavailable.');
      if (inbound.protocol === 'masterdnsvpn' && new URL(request.url).searchParams.get('file') === 'resolvers') {
        const resolvers = parseObject(inbound.settings).clientResolvers || ['1.1.1.1:53', '8.8.8.8:53', '9.9.9.9:53'];
        return new Response((resolvers as string[]).join('\n') + '\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="client_resolvers.txt"', 'X-Content-Type-Options': 'nosniff' } });
      }
      const profiles = await callRemoteJson(server, env, { path: `/panel/api/clients/links/${encodeURIComponent(row.email)}`, method: 'GET' }) as string[];
      // The agent exports profiles in listener order. Match each listener by its public endpoint;
      // never return another listener's certificate or a disabled/excluded profile.
      const endpoint = `${String(parseObject(inbound.settings).publicHost || (server.url.startsWith("agent://") ? "" : new URL(server.url).hostname))} ${inbound.port}`;
      const profile = profiles.find(p => inbound.protocol === 'openvpn' ? p.startsWith('client\n') && p.includes(`remote ${endpoint}\n`) : ['wireguard-native', 'wireguard'].includes(inbound.protocol) ? p.startsWith('[Interface]') && p.includes(`:${inbound.port}\n`) : inbound.protocol === 'ssh' ? p.startsWith('SSH tunnel\n') && p.includes(`Port: ${inbound.port}\n`) : inbound.protocol === 'openconnect' ? p.startsWith('OpenConnect\n') && p.includes(`:${inbound.port}\n`) : matchingDNSConfig(p, inbound));
      if (!profile) throw new HttpError(409, 'The server has not produced this profile yet.');
      const ext = inbound.protocol === 'openvpn' ? 'ovpn' : ['wireguard-native', 'wireguard'].includes(inbound.protocol) ? 'conf' : inbound.protocol === 'masterdnsvpn' ? 'json' : 'txt';
      return new Response(profile, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="BenX-${inbound.id}.${ext}"`, 'X-Content-Type-Options': 'nosniff' } });
    }
    links = await nativeSubscriptionLinks(server, env, row.email, allowed, format === 'clash' ? 'clash' : format === 'singbox' ? 'json' : 'raw');
  } else if (format === 'download') throw new HttpError(404, 'Native profile download requires full server access.');
  else links = await callRemoteJson(server, env, { path: `/panel/api/clients/links/${encodeURIComponent(row.email)}`, method: 'GET' }) as string[];
  if (!Array.isArray(links) || links.length > 1000 || links.some(l => typeof l !== 'string')) throw new HttpError(502, 'Invalid remote subscription links.');
  let result: ReturnType<typeof subscription>; try { result = subscription(links, format, policy.subscriptions[format]?.options); } catch (e) { throw new HttpError(422, (e as Error).message); }
  const interval = Number(policy.subscriptions[format]?.options.updateHours || 6);
  const headers = await subscriptionMetadata(env, server.id, usage, (policy.subscriptionOrigin || new URL(request.url).origin) + '/sub/' + match[1]);
  return new Response(result.body, { headers: { ...headers, 'Content-Type': result.type, 'Cache-Control': 'no-store', 'Vary': 'Accept', 'X-BenX-Excluded-Connections': String(result.excluded || 0), 'X-Content-Type-Options': 'nosniff', 'profile-update-interval': String(Number.isInteger(interval) && interval >= 1 && interval <= 168 ? interval : 6), 'profile-title': `base64:${utf8Base64('BenX-UI - ' + formatNames[format])}` } });
}
