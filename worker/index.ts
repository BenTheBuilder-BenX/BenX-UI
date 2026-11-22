import { subscriptionHostProof } from './subscription-domain';
import { ensureSchema } from './schema';
import { accountRoute, activateOwner, claimInstallation, setupStatus } from './account';
import { ownerLogin, readOwner } from './owner-credentials';
import { agentChannel, enrollmentRoute } from './outbound-agent';
import { domainsRoute } from './cloudflare-domains';
import { usageRefreshRoute, refreshUsageFleet, recordTrafficReset } from './usage-refresh';
import { workspace } from '../shared/workspaces';
import { dashboard } from './dashboard';
import { reconcileStandbys, standbyRoute } from './standby';
import { ownerPath, entryPath, checkWorkspace } from './workspaces';
import { adminAccess, canManageStore, canUseServer } from './admin-access';
import type { JsonObject, RemoteRequest, ServerInput } from '../shared/types';
import { coreCatalog, isAgentOperation } from '../shared/cores';
import { controlRoute, isUnsupportedPanelMutation, managedRequest, managedRow, profileRoute, reconcileFleet, reconcileServer, savedDocument, translatePanelRequest, translatePanelResponse } from './control';
import { operationMode, operationModeRoute } from './operation-mode';
import { replacementRoute, resumeReplacements } from './replacement';
import { cleanupRetiredServers } from './retirement';
import { fleetInbound } from './fleet';
import { policyRoute } from './policy';
import { publicSubscription, subscriptionAdmin } from './subscriptions';
import { reconcileTunnels, tunnelsRoute } from './tunnels';
import { assistantRoute } from './assistant';
import { principal, memberLogin, teamRoute, reconcileTeam } from './team';
import { labRoute, publicLab } from './lab';
import { pageDesignRoute } from './subscription-page';
import { resumeTunnelTests, tunnelTestsRoute } from './tunnel-tests';
import { discoverLocations, locationsRoute } from './locations';
import { storeAdmin, telegramWebhook, retryStoreQueue } from './store';
import { bootstrapRoute, syncInstalledPanel, resumeBootstraps } from './bootstrap';
import { callRemote, callRemoteJson, findOperation, type StoredServer, type Credentials } from './remote';
import { assertOrigin, configured, decrypt, encrypt, equalSecret, HttpError, issueSession, readJson, readLimited, validateUrl } from './security';

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { ...securityHeaders, ...extra } });
}
async function audit(env: Env, actor: string, serverId: string | null, action: string, success: boolean) {
  await env.DB.prepare('INSERT INTO audit (timestamp, actor, server_id, action, success) VALUES (?, ?, ?, ?, ?)')
    .bind(Date.now(), actor, serverId, action, Number(success)).run();
}
function sessionCookie(request: Request, token: string, age = 43200, path?: string) {
  return `${workspace(path ?? request.headers.get('X-Benx-Workspace')).cookie}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
export async function validateServer(input: ServerInput, env: Env, previous?: StoredServer): Promise<StoredServer> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, 'Expected a server configuration object.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new HttpError(400, 'Server name must be between 1 and 80 characters.');
  if (!['v2', 'v3'].includes(input.version) || !['panel', 'gateway', 'server'].includes(input.kind) || !['token', 'password'].includes(input.auth)) throw new HttpError(400, 'Invalid connection type, API version, or authentication.');
  if (input.kind === 'server' && (input.version !== 'v3' || input.auth !== 'token')) throw new HttpError(400, 'Full-access servers require the BenX agent and its access token.');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new HttpError(400, 'Enabled must be a boolean.');
  if (input.version === 'v2' && input.auth === 'token') throw new HttpError(400, '3X-UI 2.x requires username and password authentication.');
  const prior = previous ? await decrypt<Credentials>(previous.credentials, env.ENCRYPTION_KEY) : {};
  if (previous?.url.startsWith('ssh://') || previous?.url.startsWith('agent://')) {
    if (input.url !== previous.url || input.kind !== previous.kind || input.auth !== 'token' || input.version !== 'v3' || input.token || input.password || input.username || input.accessId || input.accessSecret) throw new HttpError(400, 'SSH-managed connections retain their dedicated private key. Add a new connection to change the SSH destination.');
    return { ...previous, name: input.name.trim(), location: String(input.location ?? '').slice(0, 100), subscription_url: input.subscription_url ? validateUrl(input.subscription_url) : '', enabled: input.enabled === undefined ? previous.enabled : Number(input.enabled) };
  }
  const sameAuth = previous?.auth === input.auth && previous?.kind === input.kind;
  const credentials: Credentials = {
    token: input.token || (sameAuth ? prior.token : undefined),
    username: input.username || (sameAuth ? prior.username : undefined),
    password: input.password || (sameAuth ? prior.password : undefined),
    accessId: input.accessId === undefined ? prior.accessId : input.accessId,
    accessSecret: input.accessSecret === undefined ? prior.accessSecret : input.accessSecret,
  };
  if (input.auth === 'token' ? !credentials.token : (!credentials.username || !credentials.password)) throw new HttpError(400, 'Enter the remote panel credentials.');
  if (JSON.stringify(credentials).length > 16000) throw new HttpError(400, 'Credentials are too long.');
  if (Boolean(credentials.accessId) !== Boolean(credentials.accessSecret)) throw new HttpError(400, 'Cloudflare Access needs both service token fields.');
  const url = validateUrl(input.url);
  // Changing the destination must never send an old credential to a new host/base path.
  if (previous && url !== previous.url && (input.auth === 'token' ? !input.token : (!input.username || !input.password))) throw new HttpError(400, 'Re-enter credentials when changing the panel address.');
  if (previous && url !== previous.url && prior.accessSecret && (input.accessId === undefined || input.accessSecret === undefined)) throw new HttpError(400, 'Re-enter or explicitly remove Cloudflare Access credentials when changing the panel address.');
  return {
    id: previous?.id ?? crypto.randomUUID(), name: input.name.trim(), url,
    version: input.version, kind: input.kind, auth: input.auth, location: String(input.location ?? '').slice(0, 100),
    subscription_url: input.subscription_url ? validateUrl(input.subscription_url) : '',
    enabled: input.enabled === undefined ? previous?.enabled ?? 1 : Number(input.enabled),
    created_at: previous?.created_at ?? Date.now(), credentials: await encrypt(credentials, env.ENCRYPTION_KEY),
  };
}
async function getServer(env: Env, id: string) {
  const server = await env.DB.prepare('SELECT * FROM servers WHERE id = ?').bind(id).first<StoredServer>();
  if (!server) throw new HttpError(404, 'Server connection not found.');
  return server;
}
async function login(request: Request, env: Env) {
  const input = await readJson<{ username?: unknown; password?: unknown }>(request);
  if (!input || typeof input.username !== 'string' || typeof input.password !== 'string' || input.username.length > 100 || input.password.length > 1024) throw new HttpError(400, 'Enter your username and password.');
  const now = Date.now();
  const ip = request.headers.get('CF-Connecting-IP') ?? 'local';
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const limit = await env.DB.prepare(`INSERT INTO login_limits (key, attempts, expires) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET attempts = CASE WHEN expires < ? THEN 1 ELSE attempts + 1 END,
    expires = CASE WHEN expires < ? THEN excluded.expires ELSE expires END RETURNING attempts`)
    .bind(key, now + 15 * 60 * 1000, now, now).first<{ attempts: number }>();
  if ((limit?.attempts ?? 100) > 10) throw new HttpError(429, 'Too many sign-in attempts. Try again in 15 minutes.');
  const ownerName = (await readOwner(env))?.username || env.ADMIN_USERNAME;
  const isOwnerName = await equalSecret(input.username, ownerName);
  const owner = isOwnerName ? await ownerLogin(env, input.username, input.password) : null;
  const member = isOwnerName ? null : await memberLogin(env, input.username, input.password);
  if (!owner && !member) { await audit(env, 'anonymous', null, 'Sign-in attempt', false); throw new HttpError(401, 'Incorrect username or password.'); }
  const actor = { username: member?.username ?? owner!, role: member ? member.is_admin ? 'admin' as const : member.role : 'root' as const, ...(member ? { member } : {}) };
  await checkWorkspace(request, env, actor);
  const canonical = await entryPath(env, actor);
  await env.DB.prepare('DELETE FROM login_limits WHERE key = ?').bind(key).run();
  await audit(env, actor.username, null, 'Signed in', true);
  const entry = workspace(request.headers.get('X-Benx-Workspace'));
  return json({ success: true, entryPath: canonical }, 200, { 'Set-Cookie': sessionCookie(request, await issueSession(env, member ?? undefined, canonical), 43200, entry.kind === 'legacy' ? '' : canonical) });
}
async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (/^\/(?:api|sub|lab|telegram|owner)\//.test(url.pathname)) await ensureSchema(env);
  if (url.pathname === '/api/install/claim') return json(await claimInstallation(request, env));
  if(url.pathname==='/api/public/subscription-host' && request.method==='GET' && configured(env)) return subscriptionHostProof(request,env);
  if (url.pathname === '/telegram/webhook') { if (!configured(env)) throw new HttpError(503, 'Store unavailable.'); return telegramWebhook(request, env, ctx); }
  if (url.pathname.startsWith('/lab/')) { if (!configured(env)) throw new HttpError(503, 'Testing subscriptions unavailable.'); return publicLab(request, env); }
  if (url.pathname.startsWith('/sub/')) { if (!configured(env)) throw new HttpError(503, 'Subscriptions unavailable.'); return publicSubscription(request, env); }
  if (!url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/owner/') && (workspace(url.pathname).kind !== 'owner' || url.pathname !== await ownerPath(env))) throw new HttpError(404, 'Page not found.');
    return env.ASSETS.fetch(request);
  }
  if (url.pathname.startsWith('/api/agent/')) {
    if (!configured(env)) throw new HttpError(503, 'Worker setup is incomplete.');
    return agentChannel(request, env);
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') assertOrigin(request);
  if (url.pathname === '/api/session' && request.method === 'GET') {
    let user: Awaited<ReturnType<typeof principal>> | null = null;
    if (configured(env)) { try { user = await principal(request, env); await checkWorkspace(request, env, user); } catch { user = null; } }
    const canonical = user ? await entryPath(env, user) : null;
    const migration: Record<string, string> = user && workspace(request.headers.get('X-Benx-Workspace')).kind === 'legacy' ? { 'Set-Cookie': sessionCookie(request, await issueSession(env, user.member, canonical!), 43200, canonical!) } : {};
    const response = json({ configured: configured(env), ...await setupStatus(env), authenticated: Boolean(user), username: user?.username ?? null, role: user?.role ?? null, manageStore: canManageStore(user), entryPath: canonical }, 200, migration);
    if (migration['Set-Cookie']) response.headers.append('Set-Cookie', sessionCookie(request, '', 0, ''));
    return response;
  }
  if (/^\/api\/setup\/(activate|recover)$/.test(url.pathname) && request.method === 'POST') {
    const credentials = await activateOwner(request, env, url.pathname.endsWith('/recover'));
    const canonical = await ownerPath(env);
    await audit(env, credentials.username, null, url.pathname.endsWith('/recover') ? 'Recovered owner access' : 'Activated owner account', true);
    return json({ ...credentials, entryPath: canonical }, 200, { 'Set-Cookie': sessionCookie(request, await issueSession(env, undefined, canonical), 43200, canonical) });
  }
  if (!configured(env)) throw new HttpError(503, 'Panel installation is finishing. Refresh shortly or open the latest private setup link.');
  if (url.pathname === '/api/login' && request.method === 'POST') return login(request, env);
  if (url.pathname === '/api/logout' && request.method === 'POST') return json({ success: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  const identity = await principal(request, env);
  await checkWorkspace(request, env, identity);
  if (url.pathname === '/api/account' || url.pathname === '/api/account/recovery') {
    const result = await accountRoute(request, env, identity);
    if (request.method === 'PUT') {
      const member = 'member' in result ? result.member : undefined;
      const { username, version, owner } = result;
      const canonical = await entryPath(env, identity);
      await audit(env, identity.username, null, 'Changed own login credentials', true);
      return json({ username, version, owner }, 200, { 'Set-Cookie': sessionCookie(request, await issueSession(env, member, canonical), 43200, canonical) });
    }
    if (request.method === 'POST') { await audit(env, identity.username, null, 'Exported private installation recovery information', true); return json(result, 200, { 'Content-Disposition': 'attachment; filename="benx-installation-recovery.json"' }); }
    return json(result);
  }
  if (/^\/api\/(?:team|portal)(?:\/|$)/.test(url.pathname)) { if (identity.role === 'admin') throw new HttpError(403, 'Use your server administration workspace.'); return teamRoute(request, env, ctx, identity); }
  await adminAccess(request, env, identity);
  const actor = identity.username;
  if (/^\/api\/cloudflare(?:\/(?:preview|apply))?$/.test(url.pathname)) {
    if (identity.role !== 'root') throw new HttpError(403, 'Only the workspace owner can manage Cloudflare domains.');
    const response = await domainsRoute(request, env);
    if (url.pathname.endsWith('/apply')) await audit(env, actor, null, 'Applied reviewed Cloudflare domain change', response.ok);
    return response;
  }
  if (url.pathname === '/api/enrollments') {
    if (identity.role !== 'root') throw new HttpError(403, 'Only the workspace owner can pair a VPS.');
    const response = await enrollmentRoute(request, env);
    if (request.method === 'POST') await audit(env, actor, null, 'Created private outbound agent enrollment', response.ok);
    return response;
  }
  if (/^\/api\/lab(?:\/|$)/.test(url.pathname)) return labRoute(request, env, ctx, id => canUseServer(identity, id));
  if (url.pathname.startsWith('/api/assistant/')) { const response = await assistantRoute(request, env, ctx); if (request.method !== 'GET') await audit(env, actor, null, 'AI assistant ' + url.pathname.split('/').at(-1), response.ok); return response; }
  if (/^\/api\/tunnel-tests(?:\/[a-f0-9-]{36})?$/.test(url.pathname)) return tunnelTestsRoute(request, env, ctx, id => canUseServer(identity, id));
  if (url.pathname === '/api/usage-refresh') return usageRefreshRoute(request, env, identity.role === 'root');
  if (url.pathname === '/api/operation-mode') return operationModeRoute(request, env, identity.role === 'root');
  if (url.pathname === '/api/profiles') { const response = await profileRoute(request, env); await audit(env, actor, null, 'Created saved server profile', response.ok); return response; }
  if (url.pathname === '/api/fleet/inbounds') { const response = await fleetInbound(request, env, ctx); await audit(env, actor, null, 'Saved multi-server inbound deployment', response.ok); return response; }
  if (url.pathname.startsWith('/api/bootstrap')) { const response = await bootstrapRoute(request, env); if (request.method !== 'GET') await audit(env, actor, null, 'SSH server setup action', response.ok); return response; }
  if (url.pathname === '/api/store' || url.pathname.startsWith('/api/store/')) { const response = await storeAdmin(request, env); if (request.method !== 'GET') await audit(env, actor, null, `${request.method} Telegram store action`, true); return response; }
  if (url.pathname === '/api/providers/vpnjantit' && request.method === 'GET') return discoverLocations();
  if (/^\/api\/tunnels(?:\/[a-f0-9-]{36})?$/.test(url.pathname)) { const response = await tunnelsRoute(request, env, id => canUseServer(identity, id)); if (request.method !== 'GET') await audit(env, actor, null, `${request.method} tunnel configuration`, true); return response; }

  if (url.pathname === '/api/audit' && request.method === 'GET') return json((await env.DB.prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all<{ server_id: string | null }>()).results.filter(r => identity.role === 'root' || r.server_id && canUseServer(identity, r.server_id)));
  if (url.pathname === '/api/servers' && request.method === 'GET') {
    const result = await env.DB.prepare(`SELECT s.id, s.name, s.url, s.version, s.kind, s.auth, s.location, s.subscription_url, s.enabled, s.created_at, s.parent_id,
      CASE WHEN m.server_id IS NULL THEN 0 ELSE 1 END AS managed,m.bound,m.phase AS sync_phase,m.revision AS desired_revision,m.applied_revision,
      h.online, h.latency, h.timestamp AS last_checked FROM servers s LEFT JOIN health h ON h.id =
      (SELECT id FROM health WHERE server_id = s.id ORDER BY timestamp DESC LIMIT 1) LEFT JOIN managed_state m ON m.server_id=s.id WHERE s.is_candidate=0 AND NOT EXISTS(SELECT 1 FROM servers parent WHERE parent.id=s.parent_id AND parent.is_candidate=1) AND NOT EXISTS(SELECT 1 FROM replacements r WHERE r.candidate_id=s.id) AND NOT EXISTS(SELECT 1 FROM replacements r WHERE r.candidate_id=s.parent_id) ORDER BY s.created_at`).all();
    return json(result.results.filter(r => canUseServer(identity, String(r.id))).map(row => ({
      ...row, online: row.online ?? undefined, latency: row.latency ?? undefined, last_checked: row.last_checked ?? undefined,
    })));
  }
  if (url.pathname === '/api/servers/test' && request.method === 'POST') {
    const input = await readJson<ServerInput & { id?: string }>(request);
    const server = await validateServer(input, env, input.id ? await getServer(env, input.id) : undefined);
    const start = Date.now();
    const status = await callRemoteJson({ ...server, enabled: 1 }, env, { path: '/panel/api/server/status', method: 'GET' });
    if (server.kind === 'server') {
      const capabilities = await callRemoteJson({ ...server, enabled: 1 }, env, { path: '/benx/v1/capabilities', method: 'GET' }) as { agent?: string; fullAccess?: boolean };
      if (capabilities.agent !== 'benx-agent' || !capabilities.fullAccess) throw new HttpError(400, 'This endpoint is not a full-access BenX management agent.');
    }
    return json({ status, latency: Date.now() - start });
  }
  if (url.pathname === '/api/servers' && request.method === 'POST') {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM servers s WHERE s.is_candidate=0 AND NOT EXISTS(SELECT 1 FROM servers p WHERE p.id=s.parent_id AND p.is_candidate=1)').first<{ n: number }>();
    if ((count?.n ?? 0) >= 50) throw new HttpError(400, 'This panel supports up to 50 saved servers.');
    const server = await validateServer(await readJson<ServerInput>(request), env);
    await env.DB.prepare('INSERT INTO servers (id, name, url, version, kind, auth, credentials, location, subscription_url, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(server.id, server.name, server.url, server.version, server.kind, server.auth, server.credentials, server.location, server.subscription_url, server.enabled, server.created_at).run();
    await audit(env, actor, server.id, 'Added connection', true);
    return json({ id: server.id }, 201);
  }
  const match = url.pathname.match(/^\/api\/servers\/([^/]+)(?:\/(request|health|probe|restore|upload|policy|subscriptions|subscription-page|locations|control|replacement|dashboard|standbys))?$/);
  if (!match) throw new HttpError(404, 'API endpoint not found.');
  const server = await getServer(env, match[1]);
  const route = match[2];
  if (route === 'dashboard') return dashboard(request, env, server, ctx);
  if (route === 'standbys') { const response = await standbyRoute(request, env, server, ctx); if (request.method !== 'GET') await audit(env, actor, server.id, 'Changed approved standby copy', response.ok); return response; }
  if (route === 'subscription-page') return pageDesignRoute(request, env, server.id);
  if (route === 'control') { const response = await controlRoute(request, env, server, ctx); if (request.method !== 'GET') await audit(env, actor, server.id, 'Saved server synchronization action', response.ok); return response; }
  if (route === 'replacement') { const response = await replacementRoute(request, env, server, ctx); if (request.method !== 'GET') await audit(env, actor, server.id, 'VPS replacement action', response.ok); return response; }
  if (!route && request.method === 'PUT') {
    const next = await validateServer(await readJson<ServerInput>(request), env, server);
    const now = Date.now();
    const updated = await env.DB.prepare("UPDATE servers SET name=?,url=?,version=?,kind=?,auth=?,credentials=?,location=?,subscription_url=?,enabled=? WHERE id=? AND url=? AND credentials=? AND NOT EXISTS(SELECT 1 FROM replacements r WHERE (r.server_id=? OR r.server_id=? OR r.candidate_id=? OR r.candidate_id=?) AND r.state NOT IN ('completed','cancelled')) AND NOT EXISTS(SELECT 1 FROM managed_state m WHERE (m.server_id=? OR m.server_id=?) AND m.lease_until>?) AND NOT EXISTS(SELECT 1 FROM tunnel_tests t WHERE (t.source_id=? OR t.target_id=?) AND t.state NOT IN ('completed','cancelled')) RETURNING id")
      .bind(next.name, next.url, next.version, next.kind, next.auth, next.credentials, next.location, next.subscription_url, next.enabled, server.id, server.url, server.credentials, server.id, server.parent_id || server.id, server.id, server.parent_id || server.id, server.id, server.parent_id || server.id, now, server.id, server.id).first();
    if (!updated) throw new HttpError(409, 'This connection is changing or its VPS replacement is active. Finish replacement, then refresh before editing the connection.');
    await audit(env, actor, server.id, 'Updated connection', true);
    return json({ success: true });
  }
  if (!route && request.method === 'DELETE') {
    if (await env.DB.prepare("SELECT server_id FROM replacements WHERE (server_id=? OR server_id=?) AND state NOT IN ('completed','cancelled')").bind(server.id, server.parent_id || server.id).first()) throw new HttpError(409, 'Finish the active replacement before deleting this server.');
    const linked = await env.DB.prepare("SELECT COUNT(*) AS n FROM tunnels WHERE (source_id=? OR target_id=?) AND state!='removed'").bind(server.id, server.id).first<{ n: number }>();
    if (await env.DB.prepare("SELECT id FROM tunnel_tests WHERE (source_id=? OR target_id=?) AND state NOT IN ('completed','cancelled')").bind(server.id, server.id).first()) throw new HttpError(409, 'Finish tunnel comparison and cleanup before deleting this server.');
    if (linked?.n) throw new HttpError(409, 'Remove this server’s related tunnels before deleting its connection.');
    await env.DB.prepare("DELETE FROM tunnels WHERE (source_id=? OR target_id=?) AND state='removed'").bind(server.id, server.id).run();
    const removed = await env.DB.prepare("DELETE FROM servers WHERE id=? AND url=? AND credentials=? AND NOT EXISTS(SELECT 1 FROM replacements r WHERE (r.server_id=? OR r.server_id=? OR r.candidate_id=? OR r.candidate_id=?) AND r.state NOT IN ('completed','cancelled')) AND NOT EXISTS(SELECT 1 FROM managed_state m WHERE (m.server_id=? OR m.server_id=?) AND m.lease_until>?) AND NOT EXISTS(SELECT 1 FROM tunnel_tests t WHERE (t.source_id=? OR t.target_id=?) AND t.state NOT IN ('completed','cancelled')) RETURNING id")
      .bind(server.id, server.url, server.credentials, server.id, server.parent_id || server.id, server.id, server.parent_id || server.id, server.id, server.parent_id || server.id, Date.now(), server.id, server.id).first();
    if (!removed) throw new HttpError(409, 'This server is applying settings or starting a replacement. Finish that operation before deleting it.');
    await audit(env, actor, server.id, 'Removed connection', true);
    return json({ success: true });
  }
  if (route === 'health' && request.method === 'GET') return json((await env.DB.prepare('SELECT timestamp, online, latency, snapshot, error FROM health WHERE server_id=? ORDER BY timestamp DESC LIMIT 288').bind(server.id).all()).results.reverse());
  if (route === 'policy') { const response = await policyRoute(request, env, server, ctx); if (request.method !== 'GET') await audit(env, actor, server.id, 'Updated services and traffic policy', true); return response; }
  if (route === 'subscriptions' && ['GET', 'POST'].includes(request.method)) { const response = await subscriptionAdmin(request, env, server); if (request.method !== 'GET') await audit(env, actor, server.id, 'Changed subscription access', true); return response; }
  if (route === 'locations') { const response = await locationsRoute(request, env, server, ctx); if (request.method !== 'GET') await audit(env, actor, server.id, 'Changed location configuration', true); return response; }
  if (route === 'probe' && request.method === 'POST') return json(await probe(env, server));
  if ((route === 'restore' || route === 'upload') && request.method === 'POST') {
    if (await managedRow(env, server.id)) throw new HttpError(409, 'Import a complete profile through Synchronization. Direct database replacement would bypass the saved configuration.');
    const bytes = await readLimited(request, 20 * 1024 * 1024);
    const form = await new Request(request.url, { method: 'POST', headers: { 'Content-Type': request.headers.get('content-type') ?? '' }, body: bytes }).formData();
    const file = form.get('db') ?? form.get('file');
    if (!(file instanceof File) || file.size === 0) throw new HttpError(400, 'Select a database backup file.');
    const path = route === 'restore' ? '/panel/api/server/importDB' : String(form.get('_path') ?? '');
    const method = route === 'restore' ? 'POST' : String(form.get('_method') ?? 'POST');
    form.delete('_path'); form.delete('_method');
    if (path.endsWith('/importDB')) { form.set('db', file); form.delete('file'); }
    const response = await callRemote(server, env, { path, method }, form);
    const result = JSON.parse(new TextDecoder().decode(await readLimited(response, 4 * 1024 * 1024))) as JsonObject;
    await audit(env, actor, server.id, `${method} ${path} (file upload)`, response.ok && result.success !== false);
    return json(result, response.ok ? 200 : 502);
  }
  if (route === 'request' && request.method === 'POST') {
    const input = await readJson<RemoteRequest>(request);
    if (!input || typeof input.path !== 'string' || typeof input.method !== 'string' || (input.body != null && (typeof input.body !== 'object' || Array.isArray(input.body)))) throw new HttpError(400, 'Invalid remote request.');
    if (input.path.startsWith('/benx/v1/control/')) throw new HttpError(400, 'Use Synchronization to manage saved server configuration.');
    if (input.path.startsWith('/benx/')) { if (!isAgentOperation(input.path, input.method)) throw new HttpError(400, 'Unsupported server management operation.'); }
    else findOperation(input.path, input.method, server.version);
    const managed = await managedRequest(env, server, input);
    if (managed) {
      if (managed.pending && await operationMode(env) === 'automatic') ctx.waitUntil(reconcileServer(env, server));
      if (managed.mutated) await audit(env, actor, server.id, `Saved ${input.method} ${input.path}`, true);
      return json({ success: true, ...managed });
    }
    const profile = await managedRow(env, server.id);
    const document = profile ? await savedDocument(env, profile) : null;
    if (document && isUnsupportedPanelMutation(input)) throw new HttpError(409, 'This change is not covered by saved configuration yet. Use the matching BenX-UI settings page or import a complete profile through Synchronization.');
    if (profile && !profile.bound) {
      if (input.path === '/benx/v1/capabilities') return json({ success: true, obj: { agent: 'benx-agent', version: '0.5.0', fullAccess: false, platform: 'Saved profile · VPS not connected', features: ['server-setup', 'desired-state'], cores: coreCatalog.map(c => ({ id: c.id, installed: false, state: 'not connected', version: '', installable: Boolean(c.protocols.length), instances: 0, protocols: c.id === 'xray' ? ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks', 'tunnel'] : c.protocols })) } });
      if (/\/clients\/onlines$/.test(input.path) || input.path === '/benx/v1/jobs') return json({ success: true, obj: [] });
      if (input.path === '/benx/v1/setup' && input.method === 'GET') return json({ success: true, obj: { plan: (await savedDocument(env, profile)).setup, job: { id: 'desired', state: 'queued', steps: [], message: 'Settings saved. Connect a VPS to apply this profile.', createdAt: profile.updated_at } } });
      throw new HttpError(409, 'This saved server has no VPS yet. Configure its inbounds and routes, then connect a VPS from Servers.');
    }
    try {
      const upstream = await callRemote(server, env, document?.mode === 'panel' ? translatePanelRequest(document, server.id, input) : input);
      const type = upstream.headers.get('Content-Type') ?? '';
      if (type.includes('json') || type.startsWith('text/')) {
        const bytes = await readLimited(upstream, 4 * 1024 * 1024);
        let result: JsonObject;
        try { result = JSON.parse(new TextDecoder().decode(bytes)) as JsonObject; }
        catch { throw new HttpError(502, 'Remote panel returned an unexpected response.'); }
        if (document?.mode === 'panel') result = translatePanelResponse(document, server.id, input, result) as JsonObject;
        const success = upstream.ok && result.success !== false;
        if (success && profile && document && input.method === 'POST') await recordTrafficReset(env, server, profile, document, input.path, ctx);
        if (success && input.path === '/benx/v1/setup' && input.method === 'GET') await syncInstalledPanel(env, server, Boolean((result.obj as JsonObject)?.panelReady));
        if (success && input.method === 'POST' && /^\/panel\/api\/clients\/del\/[^/]+$/.test(input.path)) await env.DB.prepare('DELETE FROM subscriptions WHERE server_id=? AND email=?').bind(server.id, decodeURIComponent(input.path.split('/').at(-1)!)).run();
        if (success && input.method === 'POST' && /^\/panel\/api\/clients\/update\/[^/]+$/.test(input.path) && typeof input.body?.email === 'string' && input.body.email !== decodeURIComponent(input.path.split('/').at(-1)!)) await env.DB.prepare('DELETE FROM subscriptions WHERE server_id=? AND email=?').bind(server.id, decodeURIComponent(input.path.split('/').at(-1)!)).run();
        if (input.method !== 'GET') await audit(env, actor, server.id, `${input.method} ${input.path}`, success);
        return json(result, success ? 200 : 502);
      }
      if (!upstream.ok) { await upstream.body?.cancel(); throw new HttpError(502, 'Remote download failed.'); }
      ctx.waitUntil(audit(env, actor, server.id, `Downloaded ${input.path}`, true));
      const filename = upstream.headers.get('Content-Disposition')?.match(/filename="?([a-zA-Z0-9_.-]{1,100})"?/)?.[1] ?? (input.path.endsWith('/getDb') ? '3x-ui-backup.db' : 'benx-export.bin');
      return new Response(upstream.body, { headers: { ...securityHeaders, 'Content-Type': type || 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` } });
    } catch (e) {
      if (input.method !== 'GET') await audit(env, actor, server.id, `${input.method} ${input.path}`, false);
      throw e;
    }
  }
  throw new HttpError(405, 'Method not allowed.');
}
async function probe(env: Env, server: StoredServer) {
  const start = Date.now();
  let status: unknown = null;
  let error: string | null = null;
  try { status = await callRemoteJson(server, env, { path: '/panel/api/server/status', method: 'GET' }); }
  catch (e) { error = e instanceof HttpError ? e.message : 'Monitoring failed.'; }
  const result = { timestamp: Date.now(), online: error ? 0 : 1, latency: Date.now() - start, snapshot: status ? JSON.stringify(status) : null, error };
  await env.DB.prepare('INSERT INTO health (server_id, timestamp, online, latency, snapshot, error) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(server.id, result.timestamp, result.online, result.latency, result.snapshot, result.error).run();
  if (!error && server.kind === 'server' && server.url.startsWith('ssh://')) await syncInstalledPanel(env, server);
  return result;
}
export default {
  async fetch(request, env, ctx) {
    try { const response = await handle(request, env, ctx); if (/^\/(api|sub|telegram)\//.test(new URL(request.url).pathname)) { const safe = new Response(response.body, response); for (const [key, value] of Object.entries(securityHeaders)) safe.headers.set(key, value); return safe; } return response; }
    catch (e) {
      if (e instanceof HttpError) return json({ success: false, msg: e.message }, e.status);
      console.error(JSON.stringify({ event: 'request_error', message: e instanceof Error ? e.name : 'UnknownError', path: (/^\/(sub|lab)\//.test(new URL(request.url).pathname)) ? '/subscription/[redacted]' : new URL(request.url).pathname }));
      return json({ success: false, msg: 'BenX-UI could not complete the request. Verify the database migrations and Worker secrets.' }, 500);
    }
  },
  async scheduled(_event, env, ctx) {
    await ensureSchema(env);
    if (!configured(env)) return;
    ctx.waitUntil(refreshUsageFleet(env).catch(() => { console.error(JSON.stringify({event:'usage_refresh_error'})); }));
    ctx.waitUntil(resumeBootstraps(env).catch(() => { console.error(JSON.stringify({ event: 'bootstrap_poll_error' })); }));
    ctx.waitUntil(reconcileFleet(env).catch(() => { console.error(JSON.stringify({ event: 'configuration_sync_error' })); }));
    ctx.waitUntil((async () => { if (await operationMode(env) === 'automatic') await reconcileStandbys(env); })().catch(() => { console.error(JSON.stringify({ event: 'standby_sync_error' })); }));
    ctx.waitUntil(resumeReplacements(env).catch(() => { console.error(JSON.stringify({ event: 'replacement_sync_error' })); }));
    ctx.waitUntil(reconcileTunnels(env).catch(() => { console.error(JSON.stringify({ event: 'tunnel_sync_error' })); }));
    ctx.waitUntil(resumeTunnelTests(env).catch(() => { console.error(JSON.stringify({ event: 'tunnel_test_error' })); }));
    ctx.waitUntil(cleanupRetiredServers(env).catch(() => { console.error(JSON.stringify({ event: 'retirement_sync_error' })); }));
    ctx.waitUntil(reconcileTeam(env).catch(() => { console.error(JSON.stringify({ event: 'team_accounting_error' })); }));
    ctx.waitUntil(retryStoreQueue(env).catch(() => { console.error(JSON.stringify({ event: 'store_queue_error' })); }));
    ctx.waitUntil((async () => {
      const automatic = await operationMode(env) === 'automatic';
      const servers = await env.DB.prepare('SELECT s.* FROM servers s LEFT JOIN health h ON h.id=(SELECT id FROM health WHERE server_id=s.id ORDER BY timestamp DESC LIMIT 1) WHERE ?=1 AND s.enabled=1 AND s.is_candidate=0 AND (h.timestamp IS NULL OR h.timestamp<?) ORDER BY COALESCE(h.timestamp,0) LIMIT 4').bind(automatic ? 1 : 0, Date.now() - 900000).all<StoredServer>();
      // Limit concurrency so a large fleet does not open every remote login at once.
      for (let i = 0; i < servers.results.length; i += 4) {
        const batch = await Promise.allSettled(servers.results.slice(i, i + 4).map(server => probe(env, server)));
        for (const result of batch) if (result.status === 'rejected') console.error(JSON.stringify({ event: 'probe_storage_error' }));
      }
      await env.DB.batch([
        env.DB.prepare('DELETE FROM health WHERE timestamp < ?').bind(Date.now() - 7 * 86400000),
        env.DB.prepare('DELETE FROM audit WHERE timestamp < ?').bind(Date.now() - 90 * 86400000),
        env.DB.prepare('DELETE FROM login_limits WHERE expires < ?').bind(Date.now()),
        env.DB.prepare('DELETE FROM agent_commands WHERE created_at < ?').bind(Date.now() - 86400000),
      ]);
    })());
  },
} satisfies ExportedHandler<Env>;
