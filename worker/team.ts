import { defaultPermissions, validateMember, type TeamMember, type MemberLimits, type MemberPermissions, type MemberGrant, type PortalCustomer } from '../shared/team';
import { reduceDocument, validateDocument, type ManagedDocument } from '../shared/managed';
import { primaryAttachmentIds } from '../shared/masterdns';
import { parseObject } from '../shared/types';
import { managedRow, savedDocument, reconcileServer, type ManagedRow } from './control';
import { encrypt, equalSecret, HttpError, readJson, sessionClaims } from './security';
import { callRemoteJson, type StoredServer } from './remote';
import { issueStoreSubscription } from './subscriptions';
import { reportedClientTraffic } from '../shared/client-usage';
import { recordTrafficReset } from './usage-refresh';
import { readOwner } from './owner-credentials';
const GB = 1024 ** 3;
export interface MemberRow { id: string; username: string; role: 'manager' | 'reseller'; enabled: number; version: number; password_hash: string; salt: string; limits: string; permissions: string; grants: string; consumed_bytes: number; archived: number; is_admin?: number; server_scope?: string }
export interface CustomerRow { id: string; owner_id: string; server_id: string; email: string; name: string; quota_bytes: number; days: number; ip: number; hwid: number; enabled: number; paused: number; last_up: number; last_down: number; consumed_bytes: number; version: number; identity: string; quota_up?: number; quota_down?: number; operation_id?: string; operation_until?: number }
export interface Principal { username: string; role: 'root' | 'admin' | 'manager' | 'reseller'; member?: MemberRow }
export async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: new TextEncoder().encode(salt), iterations: 100000 }, key, 256);
  return Array.from(new Uint8Array(bits), b => b.toString(16).padStart(2, '0')).join('');
}
export async function memberLogin(env: Env, username: string, password: string) {
  const row = await env.DB.prepare('SELECT * FROM team_members WHERE username=?').bind(username).first<MemberRow>();
  const hash = await passwordHash(password, row?.salt ?? 'benx-unknown-account');
  return row?.enabled && !row.archived && await equalSecret(hash, row.password_hash) ? row : null;
}
export async function principal(request: Request, env: Env): Promise<Principal> {
  const claims = await sessionClaims(request, env);
  if (!claims.memberId && claims.sub) return { username: claims.sub, role: 'root' };
  if (typeof claims.memberId !== 'string') throw new HttpError(401, 'Invalid account session.');
  const row = await env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(claims.memberId).first<MemberRow>();
  if (!row?.enabled || row.archived || row.version !== claims.version || row.username !== claims.sub) throw new HttpError(401, 'Your account changed or was paused. Sign in again.');
  return { username: row.username, role: row.is_admin ? 'admin' : row.role, member: row };
}
async function memberView(env: Env, row: MemberRow): Promise<TeamMember> {
  const stats = await env.DB.prepare('SELECT COUNT(*) AS n,COALESCE(SUM(quota_bytes),0) AS allocated FROM team_customers WHERE owner_id=?').bind(row.id).first<{ n: number; allocated: number }>();
  return { id: row.id, username: row.username, role: row.is_admin ? 'admin' : row.role, enabled: !!row.enabled, archived: !!row.archived, version: row.version, limits: JSON.parse(row.limits), permissions: JSON.parse(row.permissions), grants: JSON.parse(row.grants), serverScope: JSON.parse(row.server_scope || '{"all":false,"ids":[]}'), allocatedGB: (stats?.allocated ?? 0) / GB, consumedGB: row.consumed_bytes / GB, customers: stats?.n ?? 0 };
}
async function catalog(env: Env, member?: MemberRow) {
  const grants: MemberGrant[] | undefined = member ? JSON.parse(member.grants) : undefined;
  const rows = (await env.DB.prepare('SELECT s.* FROM servers s JOIN managed_state m ON m.server_id=s.id WHERE s.is_candidate=0 AND s.enabled=1 AND m.bound=1').all<StoredServer>()).results;
  const result = [];
  for (const s of rows) {
    const grant = grants?.find(g => g.serverId === s.id); if (grants && !grant) continue;
    const row = await managedRow(env, s.id); if (!row) continue;
    const d = await savedDocument(env, row);
    result.push({ id: s.id, name: s.name, location: s.location, securityLimits: d.mode === 'panel', inbounds: d.state.inbounds.filter(i => !grants || grant!.inboundIds.includes(Number(i.id))).map(i => ({ id: Number(i.id), remark: String(i.remark || ''), protocol: String(i.protocol), port: Number(i.port), enabled: i.enable !== false })) });
  }
  return result;
}
type CustomerSnapshot = Promise<{ state: ManagedRow | null; d: ManagedDocument | null }>;
async function customerView(env: Env, row: CustomerRow, cache: Map<string, CustomerSnapshot>): Promise<PortalCustomer> {
  if (!cache.has(row.server_id)) cache.set(row.server_id, (async () => { const state = await managedRow(env, row.server_id); return { state, d: state ? await savedDocument(env, state) : null }; })());
  const { state, d } = await cache.get(row.server_id)!, c = d?.state.clients[row.email];
  const attached = c?.inboundIds as number[] || [], visible = d?.mode === 'native' ? primaryAttachmentIds(attached, d.state.inbounds) : attached;
  const usage = parseObject(d?.runtime.usage), t = parseObject(usage[row.email] || d?.runtime[row.email]);
  return { id: row.id, owner: row.owner_id, serverId: row.server_id, email: row.email, name: row.name, quotaGB: row.quota_bytes / GB, days: row.days, ip: row.ip, hwid: row.hwid, enabled: !!row.enabled, paused: !!row.paused, usedGB: ((row.quota_up ?? 0) + (row.quota_down ?? 0)) / GB, online: typeof t.online === "boolean" ? t.online : null, expiryTime: Number(c?.expiryTime || 0), inboundIds: visible, revision: state?.revision };
}
async function customerViews(env: Env, rows: CustomerRow[]) { const cache = new Map<string, CustomerSnapshot>(); return Promise.all(rows.map(c => customerView(env, c, cache))); }
function limitsOf(m: MemberRow): MemberLimits { return JSON.parse(m.limits); }
function exhausted(m: MemberRow) { return !m.enabled || limitsOf(m).consumptionGB > 0 && m.consumed_bytes >= limitsOf(m).consumptionGB * GB; }
export function validateCustomer(b: unknown, m: MemberRow, existing?: CustomerRow) {
  const input = b as { name: string; serverId: string; quotaGB: number; days: number; ip: number; hwid: number; enabled: boolean; inboundIds: number[]; renew?: boolean };
  const l = limitsOf(m);
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100 || typeof input.serverId !== 'string' || typeof input.enabled !== 'boolean' || !Array.isArray(input.inboundIds) || !input.inboundIds.length || input.inboundIds.length > 1000 || input.inboundIds.some(id => !Number.isSafeInteger(id))) throw new HttpError(400, 'Enter a name and choose allowed inbounds.');
  for (const key of ['quotaGB', 'days', 'ip', 'hwid'] as const) if (!Number.isFinite(input[key]) || input[key] < 0 || input[key] > 10000000 || key !== 'quotaGB' && !Number.isInteger(input[key])) throw new HttpError(400, 'Enter valid quota, duration and security limits.');
  for (const [key, max] of [['quotaGB', l.quotaGB], ['days', l.days], ['ip', l.ip], ['hwid', l.hwid]] as const) if (max > 0 && (input[key] === 0 || input[key] > max)) throw new HttpError(403, `${key} exceeds your account limit. Zero means unlimited.`);
  if (l.allocationGB > 0 && input.quotaGB === 0) throw new HttpError(403, 'An unlimited customer cannot be issued under an allocation cap.');
  if (existing && existing.server_id !== input.serverId) throw new HttpError(400, 'A customer cannot be moved to another server. Create a new customer there.');
  const grant = (JSON.parse(m.grants) as MemberGrant[]).find(g => g.serverId === input.serverId);
  if (!grant || input.inboundIds.some(id => !grant.inboundIds.includes(id))) throw new HttpError(403, 'An inbound is outside your assigned access.');
  if (exhausted(m) && input.enabled) throw new HttpError(403, 'This account is paused or its consumed traffic cap has been reached.');
  return input;
}
// One D1 transaction guards the profile revision, account version, quota reservation and ownership.
// No remote mutation occurs before the authoritative profile and customer ledger are committed.
async function commitCustomer(env: Env, m: MemberRow, row: ManagedRow, d: ManagedDocument, customer: CustomerRow, old?: CustomerRow, remove = false) {
  const now = Date.now(), secret = await encrypt(validateDocument(d), env.ENCRYPTION_KEY), l = limitsOf(m), bytes = remove ? 0 : customer.quota_bytes;
  const fence = 'EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND document=? AND revision=?)';
  const guardValues = [row.server_id, secret, row.revision + 1];
  const result = await env.DB.batch([
    env.DB.prepare(`UPDATE managed_state SET document=?,revision=revision+1,phase='pending',error='',updated_at=? WHERE server_id=? AND revision=? AND document=? AND lease_until<? AND bound=1 AND EXISTS(SELECT 1 FROM team_members WHERE id=? AND version=? AND (enabled=1 OR ?=1)) AND (?=0 OR (SELECT COALESCE(SUM(quota_bytes),0) FROM team_customers WHERE owner_id=? AND id!=?)+?<=?) AND (?=0 OR (SELECT COUNT(*) FROM team_customers WHERE owner_id=? AND id!=?)+?<=?) AND (?=0 OR (SELECT consumed_bytes FROM team_members WHERE id=?)<?) AND (?='' OR EXISTS(SELECT 1 FROM team_customers WHERE id=? AND owner_id=? AND version=? AND operation_until<${now}))`)
      .bind(secret, now, row.server_id, row.revision, row.document, now, m.id, m.version, Number(remove), remove ? 0 : l.allocationGB, m.id, customer.id, bytes, l.allocationGB * GB, remove ? 0 : l.customers, m.id, customer.id, remove ? 0 : 1, l.customers, remove || !customer.enabled ? 0 : l.consumptionGB, m.id, l.consumptionGB * GB, old?.id ?? '', old?.id ?? '', m.id, old?.version ?? 0),
    remove ? env.DB.prepare(`DELETE FROM team_customers WHERE id=? AND owner_id=? AND ${fence}`).bind(customer.id, m.id, ...guardValues) : env.DB.prepare(`INSERT INTO team_customers(id,owner_id,server_id,email,name,quota_bytes,days,ip,hwid,enabled,paused,identity,created_at) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${fence} ON CONFLICT(id) DO UPDATE SET name=excluded.name,quota_bytes=excluded.quota_bytes,days=excluded.days,ip=excluded.ip,hwid=excluded.hwid,enabled=excluded.enabled,paused=excluded.paused,version=team_customers.version+1`)
      .bind(customer.id, m.id, row.server_id, customer.email, customer.name, customer.quota_bytes, customer.days, customer.ip, customer.hwid, customer.enabled, customer.paused, customer.identity, now, ...guardValues),
    env.DB.prepare(`INSERT INTO managed_versions(server_id,revision,document,created_at) SELECT ?,?,?,? WHERE ${fence}`).bind(row.server_id, row.revision + 1, secret, now, ...guardValues),
    env.DB.prepare(`INSERT INTO server_policy(server_id,revision,data,updated_at) SELECT ?,?,?,? WHERE ${fence} ON CONFLICT(server_id) DO UPDATE SET revision=excluded.revision,data=excluded.data,updated_at=excluded.updated_at`).bind(row.server_id, d.policy.revision, JSON.stringify(d.policy), now, ...guardValues),
    env.DB.prepare(`INSERT INTO audit(timestamp,actor,server_id,action,success) SELECT ?,?,?,?,1 WHERE ${fence}`).bind(now, m.username, row.server_id, `${remove ? 'Removed' : old ? 'Updated' : 'Created'} reseller customer`, ...guardValues),
  ]);
  if (!result[0].meta.changes) throw new HttpError(409, 'The server, account or quota changed. Refresh and check your limits.');
  return row.revision + 1;
}
export async function teamRoute(request: Request, env: Env, ctx: ExecutionContext, actor: Principal) {
  const path = new URL(request.url).pathname, root = actor.role === 'root';
  if (path.startsWith('/api/team') && !root) throw new HttpError(403, 'Only the owner can manage team access.');
  if (path === '/api/team/catalog' && request.method === 'GET') return Response.json(await catalog(env));
  if (path === '/api/team' && request.method === 'GET') return Response.json(await Promise.all((await env.DB.prepare('SELECT * FROM team_members WHERE archived=? ORDER BY created_at').bind(Number(new URL(request.url).searchParams.get('archived') === '1')).all<MemberRow>()).results.map(m => memberView(env, m))));
  const accountId = path.match(/^\/api\/team\/([a-f0-9-]{36})$/)?.[1];
  if (accountId && request.method === 'DELETE') {
    const b = await readJson<{ version: number }>(request);
    if (!Number.isSafeInteger(b?.version) || b.version < 1) throw new HttpError(400, 'Refresh the account before archiving.');
    const r = await env.DB.prepare('UPDATE team_members SET enabled=0,archived=1,version=version+1 WHERE id=? AND version=? RETURNING id').bind(accountId, b.version).first();
    if (!r) throw new HttpError(409, 'Account changed. Refresh before archiving.');
    await env.DB.prepare('INSERT INTO audit(timestamp,actor,action,success) VALUES(?,?,?,1)').bind(Date.now(), actor.username, 'Archived team account').run();
    ctx.waitUntil(reconcileTeam(env)); return Response.json({ archived: true });
  }
  if (path === '/api/team' && request.method === 'POST' || accountId && request.method === 'PUT') {
    let b; try { b = validateMember(await readJson(request)); } catch (e) { throw new HttpError(400, (e as Error).message); }
    if (b.username === ((await readOwner(env))?.username || env.ADMIN_USERNAME)) throw new HttpError(400, 'This name belongs to the panel owner.');
    const previous = accountId ? await env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(accountId).first<MemberRow>() : null;
    if (await env.DB.prepare('SELECT id FROM team_members WHERE username=? AND id!=?').bind(b.username, accountId ?? '').first()) throw new HttpError(409, 'Account name already exists.');
    if (accountId && !previous) throw new HttpError(404, 'Account not found.');
    if (previous && (!Number.isSafeInteger(b.version) || b.version < 1)) throw new HttpError(400, 'Refresh the account before editing.');
    if (!previous && !b.password) throw new HttpError(400, 'Set an account password.');
    const all = await catalog(env);
    for (const g of b.grants) { const s = all.find(s => s.id === g.serverId); if (!s || g.inboundIds.some(id => !s.inbounds.some(i => i.id === id))) throw new HttpError(400, 'Grant only existing managed servers and inbounds.'); }
    const id = previous?.id ?? crypto.randomUUID(), salt = b.password ? crypto.randomUUID() : previous!.salt, hash = b.password ? await passwordHash(b.password, salt) : previous!.password_hash;
    if (b.role === 'admin') { const ids = (await env.DB.prepare('SELECT id FROM servers WHERE is_candidate=0').all<{ id: string }>()).results.map(s => s.id); if (b.serverScope!.ids.some(id => !ids.includes(id))) throw new HttpError(400, 'Choose existing servers.'); }
    const args = [Number(b.role === 'admin'), JSON.stringify(b.role === 'admin' ? b.serverScope : { all: false, ids: [] }), b.username, b.role === 'admin' ? 'manager' : b.role, Number(b.enabled), hash, salt, JSON.stringify(b.limits), JSON.stringify(b.permissions), JSON.stringify(b.role === 'admin' ? [] : b.grants)];
    if (previous) { const r = await env.DB.prepare('UPDATE team_members SET is_admin=?,server_scope=?,username=?,role=?,enabled=?,password_hash=?,salt=?,limits=?,permissions=?,grants=?,archived=0,version=version+1 WHERE id=? AND version=? RETURNING id').bind(...args, id, b.version).first(); if (!r) throw new HttpError(409, 'Account changed. Refresh before editing.'); }
    else { if (await env.DB.prepare('SELECT id FROM team_members WHERE username=?').bind(b.username).first()) throw new HttpError(409, 'Account name already exists.'); await env.DB.prepare('INSERT INTO team_members(is_admin,server_scope,username,role,enabled,password_hash,salt,limits,permissions,grants,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').bind(...args, id, Date.now()).run(); }
    await env.DB.prepare('INSERT INTO audit(timestamp,actor,action,success) VALUES(?,?,?,1)').bind(Date.now(), actor.username, (previous ? 'Updated' : 'Created') + ' team account ' + b.username).run();
    ctx.waitUntil(reconcileTeam(env));
    return Response.json(await memberView(env, (await env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(id).first<MemberRow>())!));
  }
  const ownerId = root ? new URL(request.url).searchParams.get('owner') : actor.member!.id;
  const m = ownerId ? await env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(ownerId).first<MemberRow>() : null;
  if (path === '/api/portal' && request.method === 'GET') {
    if (!m) throw new HttpError(404, 'Account not found.');
    const customers = (await env.DB.prepare('SELECT * FROM team_customers WHERE owner_id=? ORDER BY created_at DESC').bind(m.id).all<CustomerRow>()).results;
    const servers = await catalog(env, m), views = await customerViews(env, customers);
    for (let n = 0; n < servers.length; n += 4) await Promise.all(servers.slice(n, n + 4).map(async s => {
      try { const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(s.id).first<StoredServer>(); if (!server) return; const online = await callRemoteJson(server, env, { path: '/panel/api/clients/onlines', method: 'POST' }); if (!Array.isArray(online)) return; for (const c of views) if (c.serverId === s.id) c.online = online.includes(c.email); } catch { /* Leave unavailable online status explicit. */ }
    }));
    return Response.json({ member: await memberView(env, m), servers, customers: views, activity: (await env.DB.prepare('SELECT timestamp,action,success FROM audit WHERE actor=? ORDER BY id DESC LIMIT 100').bind(m.username).all()).results });
  }
  if (path === '/api/team/customers' && request.method === 'GET') return Response.json(await customerViews(env, (await env.DB.prepare('SELECT * FROM team_customers ORDER BY created_at DESC').all<CustomerRow>()).results));
  const match = path.match(/^\/api\/portal\/customers(?:\/([a-f0-9-]{36})(?:\/(share|security|resetTraffic))?)?$/);
  if (!match || !m) throw new HttpError(404, 'Account endpoint not found.');
  let c = match[1] ? await env.DB.prepare('SELECT * FROM team_customers WHERE id=? AND owner_id=?').bind(match[1], m.id).first<CustomerRow>() : null;
  if (match[1] && !c) throw new HttpError(404, 'Customer not found.');
  const permissions: MemberPermissions = JSON.parse(m.permissions || JSON.stringify(defaultPermissions));
  const operation = match[2] === 'share' ? 'share' : request.method === 'DELETE' ? 'remove' : c ? 'edit' : 'create';
  if (!root && !permissions[operation]) throw new HttpError(403, 'Your account does not allow this action.');
  const serverId = c?.server_id ?? (request.method === 'POST' ? '' : null);
  if (match[2] === 'security' || match[2] === 'resetTraffic') {
    if (!c) throw new HttpError(404, 'Customer not found.');
    if (exhausted(m) || !await accountSubscriptionAllowed(env, c.server_id, c.email)) throw new HttpError(403, 'Customer account access is paused.');
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1').bind(c.server_id).first<StoredServer>(); if (!server) throw new HttpError(404, 'Server unavailable.');
    const row = await managedRow(env, server.id), d = row ? await savedDocument(env, row) : null;
    if (d?.state.clients[c.email]?.subId !== c.identity) throw new HttpError(409, 'Customer identity changed.');
    const encoded = encodeURIComponent(c.email);
    if (match[2] === 'security') {
      if (d.mode !== 'panel') throw new HttpError(400, 'IP/HWID tracking is not available on native cores.');
      if (request.method === 'GET') return Response.json({ ips: await callRemoteJson(server, env, { path: '/panel/api/clients/ips/' + encoded, method: 'POST' }), hwids: await callRemoteJson(server, env, { path: '/panel/api/clients/hwids/' + encoded, method: 'POST' }) });
      const b = await readJson<{ action: string }>(request);
      if (request.method !== 'POST' || !['clearIps', 'clearHwids'].includes(b.action)) throw new HttpError(400, 'Choose clear IPs or clear devices.');
      await callRemoteJson(server, env, { path: '/panel/api/clients/' + (b.action === 'clearIps' ? 'clearIps/' : 'hwids/') + encoded, method: b.action === 'clearIps' ? 'POST' : 'DELETE' });
    } else {
      if (request.method !== 'POST') throw new HttpError(405, 'Method not allowed.');
      if (!row || row.lease_until >= Date.now() || row.applied_revision !== row.revision) throw new HttpError(409, 'Wait for server synchronization before resetting traffic.');
      const operation = crypto.randomUUID(), now = Date.now();
      const lock = await env.DB.prepare('UPDATE team_customers SET operation_id=?,operation_until=?,version=version+1 WHERE id=? AND version=? AND operation_until<? RETURNING id').bind(operation, now + 120000, c.id, c.version, now).first();
      if (!lock) throw new HttpError(409, 'Traffic is being updated. Refresh before resetting.');
      try {
        await captureUsage(env, c, server, operation);
        const path = '/panel/api/clients/resetTraffic/' + encoded;
        await callRemoteJson(server, env, { path, method: 'POST' });
        await env.DB.prepare('UPDATE team_customers SET last_up=0,last_down=0,quota_up=0,quota_down=0,version=version+1 WHERE id=? AND operation_id=?').bind(c.id, operation).run();
        await recordTrafficReset(env, server, row, d, path, ctx);
      } finally { await env.DB.prepare("UPDATE team_customers SET operation_id='',operation_until=0 WHERE id=? AND operation_id=?").bind(c.id, operation).run(); }
    }
    await env.DB.prepare('INSERT INTO audit(timestamp,actor,server_id,action,success) VALUES(?,?,?,?,1)').bind(Date.now(), m.username, server.id, 'Customer ' + match[2]).run();
    return Response.json({ success: true });
  }
  if (operation === 'share' && request.method === 'POST') {
    if (!await accountSubscriptionAllowed(env, c!.server_id, c!.email)) throw new HttpError(403, 'Customer access is paused.');
    const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1').bind(serverId).first<StoredServer>(); if (!server) throw new HttpError(404, 'Server unavailable.');
    const detail = parseObject(await callRemoteJson(server, env, { path: '/panel/api/clients/get/' + encodeURIComponent(c!.email), method: 'GET' })), live = parseObject(detail.client || detail);
    if (live.subId !== c!.identity) throw new HttpError(409, 'Customer identity changed. Contact the owner.');
    return Response.json({ token: await issueStoreSubscription(env, server, c!.email, c!.identity) });
  }
  if (!['POST', 'PUT', 'DELETE'].includes(request.method) || request.method === 'PUT' && !c || request.method === 'DELETE' && !c) throw new HttpError(405, 'Method not allowed.');
  const b = request.method === 'DELETE' ? null : validateCustomer(await readJson(request), m, c ?? undefined);
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1').bind(c?.server_id ?? b!.serverId).first<StoredServer>(); if (!server) throw new HttpError(404, 'Server unavailable.');
  const row = await managedRow(env, server.id); if (!row?.bound) throw new HttpError(409, 'Import this server into Synchronization first.');
  const document = await savedDocument(env, row);
  if (c && request.method === 'DELETE') { await captureUsage(env, c, server); c = (await env.DB.prepare('SELECT * FROM team_customers WHERE id=?').bind(c.id).first<CustomerRow>())!; }
  if (b && document.mode === 'native' && (b.ip || b.hwid)) throw new HttpError(400, 'IP/device limits require a panel that supports them. This native core cannot enforce these limits.');
  if (c && document.state.clients[c.email]?.subId !== c.identity) throw new HttpError(409, 'Customer identity changed. Contact the owner.');
  const email = c?.email ?? 'customer-' + crypto.randomUUID().slice(0, 12), id = c?.id ?? crypto.randomUUID();
  const next = request.method === 'DELETE' ? reduceDocument(document, { path: '/panel/api/clients/del/' + email, method: 'POST' }).document : reduceDocument(document, { path: c ? '/panel/api/clients/update/' + email : '/panel/api/clients/add', method: 'POST', body: { client: { email, comment: b!.name.trim(), totalGB: Math.round(b!.quotaGB * GB), expiryTime: c && !b!.renew ? Number(document.state.clients[email].expiryTime || 0) : b!.days ? Date.now() + b!.days * 86400000 : 0, limitIp: b!.ip, limitHwid: b!.hwid, enable: b!.enabled, ...(c ? { inboundIds: [...new Set(b!.inboundIds)] } : {}) }, inboundIds: [...new Set(b!.inboundIds)] } }).document;
  const customer: CustomerRow = c ? { ...c } : { id, owner_id: m.id, server_id: server.id, email, name: '', quota_bytes: 0, days: 0, ip: 0, hwid: 0, enabled: 1, paused: 0, last_up: 0, last_down: 0, consumed_bytes: 0, version: 1, identity: String(next.state.clients[email]?.subId || '') };
  if (b) Object.assign(customer, { name: b.name.trim(), quota_bytes: Math.round(b.quotaGB * GB), days: b.days, ip: b.ip, hwid: b.hwid, enabled: Number(b.enabled), paused: 0 });
  const revision = await commitCustomer(env, m, row, next, customer, c ?? undefined, request.method === 'DELETE');
  ctx.waitUntil(reconcileServer(env, server).catch(() => undefined));
  return Response.json({ id, revision, saved: true });
}
// Account traffic is cumulative: deleting/resetting customers does not refund consumed traffic.
export async function captureUsage(env: Env, customer: CustomerRow, server: StoredServer, operation = '') {
  const current = await env.DB.prepare('SELECT * FROM team_customers WHERE id=?').bind(customer.id).first<CustomerRow>();
  if (!current) return;
  if ((current.operation_until ?? 0) >= Date.now() && current.operation_id !== operation) throw new HttpError(409, 'A customer traffic operation is in progress.');
  const detail = parseObject(await callRemoteJson(server, env, { path: '/panel/api/clients/get/' + encodeURIComponent(current.email), method: 'GET' })), live = parseObject(detail.client || detail);
  if (live.subId !== current.identity) throw new HttpError(409, 'Customer identity changed.');
  const reported = reportedClientTraffic(detail), t = reported ?? {};
  const unused = !reported && (live.traffic === null || detail.traffic === null) && current.last_up === 0 && current.last_down === 0;
  const up = Number(t.rawUp ?? t.up ?? live.up ?? (unused ? 0 : NaN)), down = Number(t.rawDown ?? t.down ?? live.down ?? (unused ? 0 : NaN));
  if (!Number.isSafeInteger(up) || !Number.isSafeInteger(down) || up < 0 || down < 0) throw new HttpError(502, 'Invalid traffic counters.');
  const quotaUp = Number(t.up ?? up), quotaDown = Number(t.down ?? down);
  if (![quotaUp, quotaDown].every(value => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)) throw new HttpError(502, 'Invalid quota counters.');
  const delta = (up >= current.last_up ? up - current.last_up : up) + (down >= current.last_down ? down - current.last_down : down), fence = crypto.randomUUID();
  const result = await env.DB.batch([
    env.DB.prepare('UPDATE team_customers SET last_up=?,last_down=?,quota_up=?,quota_down=?,consumed_bytes=consumed_bytes+?,version=version+1,poll_id=?,checked_at=? WHERE id=? AND version=? AND identity=? AND (operation_until<? OR operation_id=?)').bind(up, down, quotaUp, quotaDown, delta, fence, Date.now(), current.id, current.version, current.identity, Date.now(), operation),
    env.DB.prepare('UPDATE team_members SET consumed_bytes=consumed_bytes+? WHERE id=? AND EXISTS(SELECT 1 FROM team_customers WHERE id=? AND poll_id=?)').bind(delta, current.owner_id, current.id, fence),
  ]);
  if (!result[0].meta.changes) throw new HttpError(409, 'Traffic was updated by another request. Refresh and retry.');
}
export async function reconcileTeam(env: Env) {
  // Bounded oldest-first polling avoids exhausting Worker subrequests on large customer lists.
  const poll = (await env.DB.prepare('SELECT * FROM team_customers ORDER BY checked_at LIMIT 50').all<CustomerRow>()).results;
  for (let n = 0; n < poll.length; n += 4) await Promise.all(poll.slice(n, n + 4).map(async c => {
    try { const server = await env.DB.prepare('SELECT * FROM servers WHERE id=? AND enabled=1').bind(c.server_id).first<StoredServer>(); if (server) await captureUsage(env, c, server); }
    catch { await env.DB.prepare('UPDATE team_customers SET checked_at=? WHERE id=?').bind(Date.now(), c.id).run(); }
  }));
  const accounts = (await env.DB.prepare('SELECT * FROM team_members').all<MemberRow>()).results;
  for (const m of accounts) {
    const grants = JSON.parse(m.grants) as MemberGrant[];
    const customers = (await env.DB.prepare('SELECT * FROM team_customers WHERE owner_id=?').bind(m.id).all<CustomerRow>()).results;
    for (const serverId of new Set(customers.map(c => c.server_id))) {
      try {
        const row = await managedRow(env, serverId); if (!row?.bound || row.lease_until >= Date.now()) continue;
        const d = await savedDocument(env, row), updates: Array<{ customer: CustomerRow; paused: boolean }> = [];
        for (const c of customers.filter(c => c.server_id === serverId)) {
          const client = d.state.clients[c.email];
          // Owner edits in Clients and imported/replaced profiles also update the member ledger.
          // A deleted/replaced identity no longer belongs to the member; cumulative account use remains.
          if (client?.subId !== c.identity) {
            await env.DB.prepare('DELETE FROM team_customers WHERE id=? AND version=? AND operation_until<? AND EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND revision=? AND document=?)').bind(c.id, c.version, Date.now(), serverId, row.revision, row.document).run();
            continue;
          }
          const fields = { name: String(client.comment || c.name), quota_bytes: Number(client.totalGB || 0), ip: Number(client.limitIp || 0), hwid: Number(client.limitHwid || 0), enabled: c.paused ? c.enabled : Number(client.enable !== false) };
          if (Object.entries(fields).some(([k, v]) => c[k as keyof CustomerRow] !== v)) {
            const updated = await env.DB.prepare('UPDATE team_customers SET name=?,quota_bytes=?,ip=?,hwid=?,enabled=?,version=version+1 WHERE id=? AND version=? AND operation_until<? AND EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND revision=? AND document=?) RETURNING version').bind(fields.name, fields.quota_bytes, fields.ip, fields.hwid, fields.enabled, c.id, c.version, Date.now(), serverId, row.revision, row.document).first<{ version: number }>();
            if (!updated) continue;
            Object.assign(c, fields, { version: updated.version });
          }
          const assigned = client.inboundIds as number[], visible = d.mode === 'native' ? primaryAttachmentIds(assigned, d.state.inbounds) : assigned;
          const grant = grants.find(g => g.serverId === serverId), paused = exhausted(m) || !grant || visible.some(id => !grant.inboundIds.includes(id));
          // Only restore access that was paused by this account overlay. An owner's manual disable is retained.
          if (!!c.paused === paused && (!paused || client.enable === false)) continue;
          client.enable = !!c.enabled && !paused; updates.push({ customer: c, paused });
        }
        if (!updates.length) continue;
        const secret = await encrypt(validateDocument(d), env.ENCRYPTION_KEY), now = Date.now();
        const snapshot = JSON.stringify(updates.map(u => ({ id: u.customer.id, version: u.customer.version, paused: Number(u.paused) })));
        const customerGuards = "NOT EXISTS(SELECT 1 FROM json_each(?) j LEFT JOIN team_customers c ON c.id=json_extract(j.value,'$.id') WHERE c.id IS NULL OR c.version!=json_extract(j.value,'$.version'))";
        const fence = 'EXISTS(SELECT 1 FROM managed_state WHERE server_id=? AND document=?)';
        const result = await env.DB.batch([
          env.DB.prepare("UPDATE managed_state SET document=?,revision=revision+1,phase='pending',updated_at=? WHERE server_id=? AND revision=? AND document=? AND lease_until<? AND EXISTS(SELECT 1 FROM team_members WHERE id=? AND version=? AND consumed_bytes=?) AND " + customerGuards).bind(secret, now, serverId, row.revision, row.document, now, m.id, m.version, m.consumed_bytes, snapshot),
          env.DB.prepare("UPDATE team_customers SET paused=json_extract(j.value,'$.paused'),version=team_customers.version+1 FROM json_each(?) j WHERE team_customers.id=json_extract(j.value,'$.id') AND " + fence).bind(snapshot, serverId, secret),
          env.DB.prepare('INSERT INTO managed_versions(server_id,revision,document,created_at) SELECT ?,?,?,? WHERE ' + fence).bind(serverId, row.revision + 1, secret, now, serverId, secret),
        ]);
        if (result[0].meta.changes) { const server = await env.DB.prepare('SELECT * FROM servers WHERE id=?').bind(serverId).first<StoredServer>(); if (server?.enabled) await reconcileServer(env, server, undefined, true); }
      } catch { /* Persisted pauses retry on the next poll; subscription access fails closed immediately. */ }
    }
  }
}
export async function accountSubscriptionAllowed(env: Env, serverId: string, email: string) {
  const row = await env.DB.prepare('SELECT m.*,c.paused AS customer_paused,c.enabled AS customer_enabled,c.identity AS customer_identity FROM team_customers c JOIN team_members m ON m.id=c.owner_id WHERE c.server_id=? AND c.email=?').bind(serverId, email).first<MemberRow & { customer_paused: number; customer_enabled: number; customer_identity: string }>();
  if (!row) return true;
  if (exhausted(row) || row.customer_paused || !row.customer_enabled) return false;
  const managed = await managedRow(env, serverId); if (!managed) return false;
  const d = await savedDocument(env, managed), c = d.state.clients[email], grant = (JSON.parse(row.grants) as MemberGrant[]).find(g => g.serverId === serverId);
  if (!grant || !c || c.subId !== row.customer_identity) return false;
  const assigned = c.inboundIds as number[], visible = d.mode === 'native' ? primaryAttachmentIds(assigned, d.state.inbounds) : assigned;
  return visible.every(id => grant.inboundIds.includes(id));
}
