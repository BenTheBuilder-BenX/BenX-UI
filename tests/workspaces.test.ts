import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import worker from '../worker/index';
import { teamFixture } from './team-fixture';
import { teamRoute, type MemberRow, type Principal } from '../worker/team';
import { defaultLimits, defaultPermissions, type TeamMember } from '../shared/team';
import { issueSession } from '../worker/security';
import { memberPath } from '../shared/workspaces';
import { ownerPath } from '../worker/workspaces';
let f: ReturnType<typeof teamFixture>;
const root: Principal = { username: 'owner', role: 'root' };
async function account(role = 'reseller', all = false, store = false) {
  const response = await teamRoute(new Request('https://benx.example/api/team', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: role + '-fixture', password: 'synthetic-password-123', role, enabled: true, limits: defaultLimits, permissions: defaultPermissions, grants: [], serverScope: { all, ids: ['assigned'], store } }) }), f.env, f.ctx, root);
  return response.json() as Promise<TeamMember>;
}
async function call(path: string, entry = '', cookie = '', method = 'GET', body?: unknown) {
  return worker.fetch(new Request('https://benx.example' + path, { method, headers: { 'Content-Type': 'application/json', origin: 'https://benx.example', 'X-Benx-Workspace': entry, cookie }, body: body === undefined ? undefined : JSON.stringify(body) }) as Parameters<typeof worker.fetch>[0], f.env, f.ctx);
}
beforeEach(() => {
  f = teamFixture();
  for (const id of ['assigned', 'hidden']) f.db.prepare("INSERT INTO servers(id,name,url,kind,auth,credentials,created_at) VALUES(?,?,?,'server','token','synthetic-private',0)").run(id, id, 'https://fixture.invalid/');
});
afterEach(async () => { await Promise.allSettled(f.waits); f.db.close(); });
describe('Separated workspaces and server administrators', () => {
  it('gives members their own entry and cookie without revealing the owner path', async () => {
    const member = await account(), privateOwner = await ownerPath(f.env);
    const login = await call('/api/login', '/resellers', '', 'POST', { username: member.username, password: 'synthetic-password-123' });
    expect(login.status).toBe(200); expect(await login.clone().json()).toEqual({ success: true, entryPath: memberPath('reseller', member.id) });
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0]; expect(cookie).toMatch(/^benx_customer=/);
    const session = await call('/api/session', memberPath('reseller', member.id), cookie);
    expect(await session.clone().json()).toMatchObject({ authenticated: true, role: 'reseller' }); expect(await session.text()).not.toContain(privateOwner);
    for (const path of ['/api/servers', '/api/team', '/api/lab', '/api/store', '/api/audit']) expect((await call(path, memberPath('reseller', member.id), cookie)).status).toBe(403);
    expect(await (await call('/api/session', privateOwner, cookie)).json()).toMatchObject({ authenticated: false, entryPath: null });
    expect(await (await call('/api/session')).json()).toMatchObject({ authenticated: false, entryPath: null });
  });
  it('rejects the wrong account role and another member entry', async () => {
    const member = await account(), admin = await account('admin');
    expect((await call('/api/login', '/admins', '', 'POST', { username: member.username, password: 'synthetic-password-123' })).status).toBe(403);
    expect((await call('/api/login', '/resellers', '', 'POST', { username: admin.username, password: 'synthetic-password-123' })).status).toBe(403);
    const row = f.db.prepare('SELECT * FROM team_members WHERE id=?').get(member.id) as unknown as MemberRow;
    const cookie = 'benx_customer=' + await issueSession(f.env, row, memberPath('reseller', member.id));
    expect((await call('/api/portal', '/resellers/' + crypto.randomUUID(), cookie)).status).toBe(401);
    expect((await call('/owner/' + 'a'.repeat(32))).status).toBe(404);
  });
  it('filters servers and activity and denies direct access to unassigned resources', async () => {
    const admin = await account('admin'), row = f.db.prepare('SELECT * FROM team_members WHERE id=?').get(admin.id) as unknown as MemberRow;
    const entry = memberPath('admin', admin.id), cookie = 'benx_admin=' + await issueSession(f.env, row, entry);
    const servers = await (await call('/api/servers', entry, cookie)).json() as Array<{ id: string }>;
    expect(servers.map(s => s.id)).toEqual(['assigned']);
    f.db.prepare('INSERT INTO audit(timestamp,actor,server_id,action,success) VALUES(0,?,?,?,1)').run('owner', 'hidden', 'secret activity');
    f.db.prepare('INSERT INTO audit(timestamp,actor,server_id,action,success) VALUES(0,?,?,?,1)').run('owner', 'assigned', 'visible activity');
    expect(await (await call('/api/audit', entry, cookie)).text()).not.toContain('secret activity');
    expect((await call('/api/servers/assigned/policy', entry, cookie)).status).toBe(200);
    for (const path of ['/api/servers/hidden/policy', '/api/servers/hidden/request', '/api/team', '/api/portal', '/api/assistant/settings', '/api/store', '/api/bootstrap']) expect((await call(path, entry, cookie)).status).toBe(403);
    expect((await call('/api/fleet/inbounds', entry, cookie, 'POST', { serverIds: ['assigned', 'hidden'], inbound: {} })).status).toBe(403);
    expect((await call('/api/tunnels', entry, cookie, 'POST', { sourceId: 'assigned', targetId: 'hidden' })).status).toBe(403);
    expect((await call('/api/tunnel-tests', entry, cookie, 'POST', { input: { sourceId: 'assigned', targetId: 'hidden' } })).status).toBe(403);
    expect((await call('/api/servers/assigned/control', entry, cookie, 'POST', { action: 'import', sourceId: 'hidden' })).status).toBe(403);
    expect((await call('/api/servers/assigned', entry, cookie, 'DELETE')).status).toBe(403);
  });
  it.each([false, true])('requires an explicit owner grant for an all-server administrator to manage the global shop (%s)', async store => {
    const admin = await account('admin', true, store), entry = memberPath('admin', admin.id);
    const row = f.db.prepare('SELECT * FROM team_members WHERE id=?').get(admin.id) as unknown as MemberRow;
    const cookie = 'benx_admin=' + await issueSession(f.env, row, entry);
    expect(await (await call('/api/session', entry, cookie)).json()).toMatchObject({ manageStore: store });
    expect((await call('/api/store', entry, cookie)).status).toBe(store ? 200 : 403);
    if (store) expect((await call('/api/store', entry, cookie, 'PUT', {config: (await (await call('/api/store', entry, cookie)).json() as {config: object}).config})).status).toBe(200);
    expect((await call('/api/team', entry, cookie)).status).toBe(403);
  });
  it('includes future connections with all-server access and revokes changed admin sessions', async () => {
    const admin = await account('admin', true), row = f.db.prepare('SELECT * FROM team_members WHERE id=?').get(admin.id) as unknown as MemberRow;
    expect(admin.role).toBe('admin'); expect(row.role).toBe('manager');
    const entry = memberPath('admin', admin.id), cookie = 'benx_admin=' + await issueSession(f.env, row, entry);
    f.db.prepare("INSERT INTO servers(id,name,url,kind,auth,credentials,created_at) VALUES('future','Future','https://fixture.invalid/','server','token','synthetic',0)").run();
    expect((await (await call('/api/servers', entry, cookie)).json() as unknown[])).toHaveLength(3);
    f.db.prepare('UPDATE team_members SET server_scope=?,version=version+1 WHERE id=?').run('{"all":false,"ids":[]}', admin.id);
    expect((await call('/api/servers', entry, cookie)).status).toBe(401);
  });
  it('filters cross-server tunnels, experiments and comparisons before exposing or scheduling them', async () => {
    const admin = await account('admin'), row = f.db.prepare('SELECT * FROM team_members WHERE id=?').get(admin.id) as unknown as MemberRow;
    const entry = memberPath('admin', admin.id), cookie = 'benx_admin=' + await issueSession(f.env, row, entry), tunnel = crypto.randomUUID(), test = crypto.randomUUID(), lab = crypto.randomUUID();
    f.db.prepare("INSERT INTO tunnels(id,source_id,target_id,state,data,updated_at) VALUES(?,?,?,'configured','private-pair-settings',0)").run(tunnel, 'assigned', 'hidden');
    f.db.prepare("INSERT INTO tunnel_tests(id,source_id,target_id,data,updated_at,created_at) VALUES(?,?,?,'private-comparison',0,0)").run(test, 'assigned', 'hidden');
    f.db.prepare("INSERT INTO lab_experiments(id,server_id,name,data,revision,created_at) VALUES(?,'hidden','Private lab','private-recipes',1,0)").run(lab);
    await Promise.allSettled(f.waits); f.waits.length = 0;
    for (const path of ['/api/tunnels', '/api/lab', '/api/tunnel-tests']) expect(await (await call(path, entry, cookie)).json()).toEqual([]);
    expect(f.waits).toHaveLength(0);
    for (const path of ['/api/tunnels/' + tunnel, '/api/lab/' + lab, '/api/tunnel-tests/' + test]) expect((await call(path, entry, cookie)).status).toBe(403);
    expect((await call('/api/lab/' + lab + '/report', entry, cookie, 'PUT', {})).status).toBe(403);
  });
  it('migrates owner sign-in to a persistent private path with a separate cookie', async () => {
    const login = await call('/api/login', '', '', 'POST', { username: 'owner', password: f.env.ADMIN_PASSWORD });
    const entry = (await login.clone().json() as { entryPath: string }).entryPath;
    expect(entry).toMatch(/^\/owner\/[a-f0-9]{32}$/); expect(await ownerPath(f.env)).toBe(entry);
    const session = await call('/api/session', '', login.headers.get('Set-Cookie')!.split(';')[0]);
    expect(session.headers.get('Set-Cookie')).toContain('benx_owner='); expect(session.headers.get('Set-Cookie')).toContain('benx_session=;');
    const ownerCookie = session.headers.get('Set-Cookie')!.split(';')[0];
    expect((await call('/api/servers', entry, ownerCookie)).status).toBe(200);
    expect(await (await call('/api/session', '/admins', ownerCookie)).json()).toMatchObject({ authenticated: false });
  });
});
