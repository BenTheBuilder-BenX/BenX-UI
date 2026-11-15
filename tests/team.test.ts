import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/control', async original => ({ ...await original<typeof import('../worker/control')>(), reconcileServer: vi.fn(async () => true) }));
vi.mock('../worker/remote', async original => ({ ...await original<typeof import('../worker/remote')>(), callRemoteJson: vi.fn() }));
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { teamRoute, memberLogin, principal, captureUsage, reconcileTeam, accountSubscriptionAllowed, type MemberRow, type Principal, type CustomerRow } from '../worker/team';
import { issueSession, authenticate, encrypt } from '../worker/security';
import { createManaged, managedRow, savedDocument } from '../worker/control';
import { emptyDocument } from '../shared/managed';
import { defaultLimits, defaultPermissions, type TeamMember } from '../shared/team';
import worker from '../worker/index';
import { teamFixture } from './team-fixture';
let f: ReturnType<typeof teamFixture>, member: TeamMember;
const remote = vi.mocked(callRemoteJson), root: Principal = { role: 'root', username: 'owner' }, GB = 1024 ** 3;
const request = (path: string, method = 'GET', b?: unknown, actor = root) => teamRoute(new Request('https://benx.example/api/' + path, { method, headers: { 'Content-Type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) }), f.env, f.ctx, actor);
async function acting(id = member.id): Promise<Principal> { const m = (await f.env.DB.prepare('SELECT * FROM team_members WHERE id=?').bind(id).first<MemberRow>())!; return { member: m, username: m.username, role: m.role }; }
const body = (serverId = 's') => ({ serverId, name: 'مشتری تست', quotaGB: 30, days: 30, ip: 0, hwid: 0, enabled: true, inboundIds: [1] });
async function customers() { return (await f.env.DB.prepare('SELECT * FROM team_customers').all<CustomerRow>()).results; }
beforeEach(async () => {
  f = teamFixture(); remote.mockReset();
  for (const id of ['s', 'other']) { f.db.prepare("INSERT INTO servers(id,name,url,kind,auth,credentials,created_at) VALUES(?,?,?,'server','token','encrypted-fixture',0)").run(id, 'Fixture ' + id, 'https://fixture.invalid/'); const d = emptyDocument(); d.state.inbounds = [{ id: 1, port: 443, protocol: 'vless', remark: 'Granted', settings: {}, streamSettings: {}, sniffing: {}, enable: true }, { id: 2, port: 444, protocol: 'vless', remark: 'Private', settings: {}, streamSettings: {}, sniffing: {}, enable: true }]; d.state.nextId = 3; await createManaged(f.env, id, d); }
  member = await (await request('team', 'POST', { username: 'seller', password: 'fixture-seller-password', role: 'reseller', enabled: true, limits: { ...defaultLimits, customers: 2, quotaGB: 50, days: 60, allocationGB: 50, consumptionGB: 100 }, permissions: { ...defaultPermissions, remove: true }, grants: [{ serverId: 's', inboundIds: [1] }, { serverId: 'other', inboundIds: [1] }] })).json() as TeamMember;
  await Promise.allSettled(f.waits); f.waits.length = 0;
  remote.mockImplementation(async (s, _env, r) => { if (r.path.endsWith('/onlines')) return []; const d = await savedDocument(f.env, (await managedRow(f.env, s.id))!); const email = decodeURIComponent(r.path.split('/').at(-1)!); return { client: d.state.clients[email], traffic: { up: 0, down: 0 } }; });
});
afterEach(async () => { await Promise.allSettled(f.waits); f.db.close(); });
describe('Restricted customer accounts', () => {
  it('hashes passwords, signs a scoped session and revokes it on an account change', async () => {
    const row = f.db.prepare('SELECT * FROM team_members').get() as unknown as MemberRow; expect(JSON.stringify(row)).not.toContain('fixture-seller-password'); expect(await memberLogin(f.env, 'seller', 'wrong')).toBeNull(); expect(await memberLogin(f.env, 'seller', 'fixture-seller-password')).toMatchObject({ id: member.id });
    const token = await issueSession(f.env, row), req = new Request('https://benx.example/api/session', { headers: { cookie: 'benx_session=' + token } });
    expect(await principal(req, f.env)).toMatchObject({ role: 'reseller' }); await expect(authenticate(req, f.env)).rejects.toMatchObject({ status: 401 });
    f.db.prepare('UPDATE team_members SET version=version+1 WHERE id=?').run(row.id); await expect(principal(req, f.env)).rejects.toMatchObject({ status: 401 });
  });
  it('blocks a reseller from the owner API even when a URL is entered directly', async () => {
    const row = (await acting()).member!, token = await issueSession(f.env, row);
    for (const path of ['servers', 'assistant/settings', 'lab', 'team', 'audit', 'store']) { const response = await worker.fetch(new Request('https://benx.example/api/' + path, { headers: { cookie: 'benx_session=' + token } }) as Parameters<typeof worker.fetch>[0], f.env, f.ctx); expect(response.status, path).toBe(403); }
    const response = await worker.fetch(new Request('https://benx.example/api/session', { headers: { cookie: 'benx_session=' + token } }) as Parameters<typeof worker.fetch>[0], f.env, f.ctx); expect(await response.json()).toMatchObject({ authenticated: true, role: 'reseller' });
  });
  it('creates real managed credentials and excludes unassigned inbounds and secrets from the portal', async () => {
    await request('portal/customers', 'POST', body(), await acting());
    const c = (await customers())[0], d = await savedDocument(f.env, (await managedRow(f.env, 's'))!); expect(d.state.clients[c.email]).toMatchObject({ totalGB: 30 * GB, inboundIds: [1], comment: 'مشتری تست' }); expect(d.state.clients[c.email].password).toBeTruthy();
    const response = await (await request('portal', 'GET', undefined, await acting())).json() as { servers: Array<{ inbounds: unknown[] }> }; expect(response.servers[0].inbounds).toHaveLength(1); expect(JSON.stringify(response)).not.toContain('encrypted-fixture'); expect(JSON.stringify(response)).not.toContain(d.state.clients[c.email].password);
    await expect(request('portal/customers', 'POST', { ...body(), inboundIds: [2] }, await acting())).rejects.toMatchObject({ status: 403 });
  });
  it('does not let URL owner parameters or another customer ID change ownership', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0];
    const other = await (await request('team', 'POST', { ...member, id: undefined, username: 'other-seller', password: 'fixture-other-password' })).json() as TeamMember;
    await expect(request('portal/customers/' + c.id + '?owner=' + member.id, 'PUT', body(), await acting(other.id))).rejects.toMatchObject({ status: 404 });
    const result = await (await request('portal?owner=' + member.id, 'GET', undefined, await acting(other.id))).json() as { customers: unknown[] }; expect(result.customers).toHaveLength(0);
  });
  it('atomically caps allocation across two different servers without partially adding clients', async () => {
    const actor = await acting(), result = await Promise.allSettled([request('portal/customers', 'POST', body('s'), actor), request('portal/customers', 'POST', body('other'), actor)]);
    expect(result.filter(r => r.status === 'fulfilled')).toHaveLength(1); expect((await customers())).toHaveLength(1);
    let count = 0; for (const id of ['s', 'other']) count += Object.keys((await savedDocument(f.env, (await managedRow(f.env, id))!)).state.clients).length; expect(count).toBe(1);
  });
  it('applies permission, duration, unlimited-quota and unsupported-security checks', async () => {
    const a = await acting();
    await expect(request('portal/customers', 'POST', { ...body(), days: 90 }, a)).rejects.toMatchObject({ status: 403 });
    await expect(request('portal/customers', 'POST', { ...body(), quotaGB: 0 }, a)).rejects.toMatchObject({ status: 403 });
    await expect(request('portal/customers', 'POST', { ...body(), ip: 1 }, a)).rejects.toMatchObject({ status: 400 });
    f.db.prepare('UPDATE team_members SET permissions=? WHERE id=?').run(JSON.stringify({ ...defaultPermissions, create: false }), member.id); await expect(request('portal/customers', 'POST', body(), await acting())).rejects.toMatchObject({ status: 403 });
  });
  it('blocks subscription access immediately after grant removal or consumed cap', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0]; expect(await accountSubscriptionAllowed(f.env, 's', c.email)).toBe(true);
    f.db.prepare('UPDATE team_members SET grants=? WHERE id=?').run('[]', member.id); expect(await accountSubscriptionAllowed(f.env, 's', c.email)).toBe(false);
    f.db.prepare('UPDATE team_members SET grants=?,consumed_bytes=? WHERE id=?').run(JSON.stringify(member.grants), 100 * GB, member.id); expect(await accountSubscriptionAllowed(f.env, 's', c.email)).toBe(false);
    await reconcileTeam(f.env); expect((await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.clients[c.email].enable).toBe(false);
  });
  it('keeps cumulative consumption through resets and customer deletion', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0], server = f.db.prepare('SELECT * FROM servers WHERE id=?').get('s') as unknown as StoredServer;
    remote.mockImplementation(async () => ({ client: { subId: c.identity }, traffic: { up: 1000, down: 500 } })); await captureUsage(f.env, c, server); await captureUsage(f.env, c, server); expect(f.db.prepare('SELECT consumed_bytes FROM team_members').get()!.consumed_bytes).toBe(1500);
    remote.mockImplementation(async () => ({ client: { subId: c.identity }, traffic: { up: 20, down: 10 } })); await captureUsage(f.env, c, server); expect(f.db.prepare('SELECT consumed_bytes FROM team_members').get()!.consumed_bytes).toBe(1530);
    await request('portal/customers/' + c.id, 'DELETE', undefined, await acting()); expect((await customers())).toHaveLength(0); expect(f.db.prepare('SELECT consumed_bytes FROM team_members').get()!.consumed_bytes).toBe(1530);
  });
  it('preserves an expiry on normal edits and renews only when explicitly selected', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0], first = (await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.clients[c.email].expiryTime;
    await request('portal/customers/' + c.id, 'PUT', { ...body(), days: 10 }, await acting()); expect((await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.clients[c.email].expiryTime).toBe(first);
    await request('portal/customers/' + c.id, 'PUT', { ...body(), days: 10, renew: true }, await acting()); expect(Number((await savedDocument(f.env, (await managedRow(f.env, 's'))!)).state.clients[c.email].expiryTime)).toBeLessThan(Number(first));
  });
  it('archives an account without discarding its customers or consumption and restores with a new session version', async () => {
    await request('portal/customers', 'POST', body(), await acting());
    const token = await issueSession(f.env, (await acting()).member!), req = new Request('https://benx.example/api/session', { headers: { cookie: 'benx_session=' + token } });
    f.db.prepare('UPDATE team_members SET consumed_bytes=1234 WHERE id=?').run(member.id);
    await request('team/' + member.id, 'DELETE', { version: member.version });
    await expect(principal(req, f.env)).rejects.toMatchObject({ status: 401 });
    expect(await memberLogin(f.env, member.username, 'fixture-seller-password')).toBeNull(); expect(await customers()).toHaveLength(1);
    expect(await (await request('team')).json()).toEqual([]);
    const archived = await (await request('team?archived=1')).json() as TeamMember[];
    expect(archived[0]).toMatchObject({ archived: true, enabled: false, consumedGB: 1234 / GB });
    const restored = await (await request('team/' + member.id, 'PUT', { ...archived[0], enabled: true })).json() as TeamMember;
    expect(restored).toMatchObject({ archived: false, enabled: true, version: member.version + 2 });
    await expect(principal(req, f.env)).rejects.toMatchObject({ status: 401 });
  });
  it('resets customer quota counters while retaining consumption and blocking concurrent polls', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0];
    f.db.prepare("UPDATE managed_state SET phase='synced',applied_revision=revision").run();
    const server = f.db.prepare('SELECT * FROM servers WHERE id=?').get('s') as unknown as StoredServer;
    remote.mockImplementation(async (_s, _e, r) => {
      if (r.path.includes('resetTraffic')) { await expect(captureUsage(f.env, c, server)).rejects.toMatchObject({ status: 409 }); return { success: true }; }
      return { client: { subId: c.identity }, traffic: { rawUp: 1000, rawDown: 500, up: 2000, down: 1000 } };
    });
    await request('portal/customers/' + c.id + '/resetTraffic', 'POST', undefined, await acting());
    const current = (await customers())[0]; expect(current).toMatchObject({ quota_up: 0, quota_down: 0, last_up: 0, last_down: 0, consumed_bytes: 1500, operation_until: 0 });
    expect(f.db.prepare('SELECT consumed_bytes FROM team_members').get()!.consumed_bytes).toBe(1500);
    const portal = await (await request('portal', 'GET', undefined, await acting())).json() as { customers: Array<{ usedGB: number }> }; expect(portal.customers[0].usedGB).toBe(0);
  });

  it('reflects owner quota edits and frees deleted identities without refunding consumption', async () => {
    await request('portal/customers', 'POST', body(), await acting()); const c = (await customers())[0];
    f.db.prepare('UPDATE team_members SET consumed_bytes=1234 WHERE id=?').run(member.id);
    const row = (await managedRow(f.env, 's'))!, d = await savedDocument(f.env, row);
    Object.assign(d.state.clients[c.email], { totalGB: 10 * GB, comment: 'Owner renamed', enable: false });
    f.db.prepare('UPDATE managed_state SET document=?,revision=revision+1').run(await encrypt(d, f.env.ENCRYPTION_KEY));
    await reconcileTeam(f.env); expect((await customers())[0]).toMatchObject({ quota_bytes: 10 * GB, name: 'Owner renamed', enabled: 0 });
    delete d.state.clients[c.email]; f.db.prepare('UPDATE managed_state SET document=?,revision=revision+1').run(await encrypt(d, f.env.ENCRYPTION_KEY));
    await reconcileTeam(f.env); expect(await customers()).toHaveLength(0); expect(f.db.prepare('SELECT consumed_bytes FROM team_members').get()!.consumed_bytes).toBe(1234);
  });

});
