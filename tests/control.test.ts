import { refreshUsageFleet, refreshUsage, usageRefreshRoute } from '../worker/usage-refresh';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { controlRoute, createManaged, managedRequest, managedRow, reconcileServer, saveManaged, savedDocument } from '../worker/control';
import { operationModeRoute } from '../worker/operation-mode';
import { dashboard } from '../worker/dashboard';
import { emptyDocument, type ManagedDocument } from '../shared/managed';
import { parseObject } from '../shared/types';
import { decrypt, encrypt } from '../worker/security';

const key = btoa('k'.repeat(32));
let db: DatabaseSync, env: Env, server: StoredServer;
const remote = vi.mocked(callRemoteJson);
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { db.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; } catch (error) { db.exec('ROLLBACK'); throw error; } } } as unknown as D1Database;
}
async function seedServer(id = 's', url = 'ssh://1.1.1.1:22/') {
  db.prepare('INSERT INTO servers(id,name,url,version,kind,auth,credentials,created_at) VALUES(?,?,?,\'v3\',\'server\',\'token\',?,0)').run(id, id, url, await encrypt({ token: 'agent-token-' + id, ssh: { username: 'root', password: 'ssh-password-' + id } }, key));
  return db.prepare('SELECT * FROM servers WHERE id=?').get(id) as unknown as StoredServer;
}
function profile() {
  const d = emptyDocument(); d.state.nextId = 3;
  d.state.inbounds = [
    { id: 1, protocol: 'wireguard', port: 51820, enable: true, settings: { address: ['10.88.0.1/24'] }, streamSettings: {}, sniffing: {} },
    { id: 2, protocol: 'vless', port: 443, enable: true, settings: { decryption: 'none', publicHost: 'vpn.example.com' }, streamSettings: { network: 'tcp', security: 'tls', tlsSettings: { serverName: 'vpn.example.com', certificates: [] } }, sniffing: {} },
  ];
  d.state.clients.alice = { email: 'alice', id: '11111111-1111-4111-8111-111111111111', password: 'client-secret-password', subId: 'private-subscription', enable: true, inboundIds: [1, 2] };
  d.setup.cores = ['xray', 'wireguard'];
  return d;
}
async function desired() { return savedDocument(env, (await managedRow(env, 's'))!); }
function succeed(revision: number, document: ManagedDocument, serverId = 's') {
  remote.mockImplementation(async (_server, _env, request) => {
    if (request.path === '/benx/v1/control/status') return { serverId, revision, drift: false, job: { state: 'succeeded' } };
    if (request.path === '/benx/v1/control/export') return structuredClone(document);
    if (request.path === '/benx/v1/control/apply') return { state: 'queued' };
    throw new Error('Unexpected agent operation: ' + request.path);
  });
}
beforeEach(async () => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  db.exec("UPDATE operation_settings SET mode='automatic'");
  env = { DB: database(db), ENCRYPTION_KEY: key } as Env;
  server = await seedServer(); remote.mockReset();
});
afterEach(() => { db.close(); remote.mockReset(); });

describe('Native desired-state reconciliation', () => {
  it('reads existing native listeners on a live dashboard refresh before a profile is imported', async () => {
    const listeners = profile().state.inbounds;
    remote.mockImplementation(async (_server, _env, input) => input.path.endsWith('/inbounds/list') ? listeners : { cpu: 12 });
    const snapshot = async (saved: boolean) => (await dashboard(new Request('https://benx.test/?saved=' + Number(saved)), env, server, {} as ExecutionContext)).json();
    expect(await snapshot(true)).toMatchObject({ inbounds: [], control: null });
    expect(remote).not.toHaveBeenCalled();
    expect(await snapshot(false)).toMatchObject({ status: { cpu: 12 }, inbounds: listeners, error: '' });
    expect(await managedRow(env, server.id)).toBeNull();
    remote.mockImplementation(async (_server, _env, input) => input.path.endsWith('/inbounds/list') ? null : { cpu: 12 });
    expect(await snapshot(false)).toMatchObject({ status: { cpu: 12 }, inboundsAvailable: false, error: expect.stringMatching(/inbound/i) });
  });
  it('rolls back a profile edit when writing its revision history fails', async () => {
    const d = profile();
    await createManaged(env, 's', d);
    const before = (await managedRow(env, 's'))!;
    db.exec("CREATE TEMP TRIGGER fail_history BEFORE INSERT ON managed_versions BEGIN SELECT RAISE(ABORT, 'fixture history unavailable'); END");
    d.state.inbounds[0].remark = 'Proposed edit';
    await expect(saveManaged(env, before, d)).rejects.toThrow('fixture history unavailable');
    expect(await managedRow(env, 's')).toEqual(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_versions').get()).toEqual({ n: 1 });
  });
  it('keeps fresh traffic checkpoints when an edit began from the same configuration revision', async () => {
    await createManaged(env, 's', profile());
    const before = (await managedRow(env, 's'))!, edited = await savedDocument(env, before);
    remote.mockResolvedValue({ usage: { alice: { up: 100, down: 50 } } });
    expect(await refreshUsage(env, server)).toBe(true);
    edited.state.clients.alice.comment = 'My edit';
    await expect(saveManaged(env, before, edited)).rejects.toMatchObject({ status: 409 });
    const latest = (await managedRow(env, 's'))!, retry = await savedDocument(env, latest);
    retry.state.clients.alice.comment = 'My edit';
    expect(await saveManaged(env, latest, retry)).toBe(2);
    expect(await desired()).toMatchObject({ state: { clients: { alice: { comment: 'My edit' } } }, runtime: { usage: { alice: { up: 100, down: 50 } } } });
  });
  it('keeps saved inbounds available when live metrics have an invalid CPU value', async () => {
    db.exec("UPDATE operation_settings SET mode='manual'");
    await createManaged(env, 's', profile());
    remote.mockResolvedValue({ cpu: 'unavailable' });
    const response = await dashboard(new Request('https://benx.test/'), env, server, {} as ExecutionContext);
    const snapshot = await response.json() as { status: unknown; error: string; inbounds: unknown[] };
    expect(snapshot.status).toBeNull();
    expect(snapshot.error).toContain('metrics');
    expect(snapshot.inbounds).toHaveLength(2);
  });
  it('holds ten manual edits with no VPS calls, then sends the final batch once and confirms it', async () => {
    db.exec("UPDATE operation_settings SET mode='manual'");
    await createManaged(env, 's', profile());
    for(let n=0;n<10;n++) {
      const row=(await managedRow(env,'s'))!, document=await desired();document.state.inbounds[1].remark='Draft '+n;
      await saveManaged(env,row,document);expect(await reconcileServer(env,server)).toBe(false);
    }
    expect(remote).not.toHaveBeenCalled();
    const final=await desired(), waits:Promise<unknown>[]=[],ctx={waitUntil(p:Promise<unknown>){waits.push(p);}} as ExecutionContext;
    remote.mockResolvedValue({serverId:'s',revision:0,job:{state:'succeeded'}});
    const snapshot=await (await dashboard(new Request('https://benx.test/?saved=1'),env,server,ctx)).json();
    expect(snapshot).toMatchObject({status:null,control:{revision:11,requested_revision:0}});expect(remote).not.toHaveBeenCalled();expect(waits).toHaveLength(0);
    await expect(controlRoute(new Request('https://benx.test/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sync',revision:10})}),env,server,ctx)).rejects.toMatchObject({status:409});
    await controlRoute(new Request('https://benx.test/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sync',revision:11})}),env,server,ctx);
    await Promise.all(waits);
    const applies=remote.mock.calls.filter(c=>c[2].path.endsWith('/apply'));expect(applies).toHaveLength(1);expect(applies[0][2].body).toMatchObject({revision:11,document:final});
    await expect(saveManaged(env,(await managedRow(env,'s'))!,final)).rejects.toThrow('submitted job');
    succeed(11,final);expect(await reconcileServer(env,server)).toBe(true);
    expect(await managedRow(env,'s')).toMatchObject({revision:11,applied_revision:11,requested_revision:11,phase:'synced'});
  });
  it('atomically prevents an old editor snapshot from changing a newly submitted batch', async()=>{
    db.exec("UPDATE operation_settings SET mode='manual'");await createManaged(env,'s',profile());const stale=(await managedRow(env,'s'))!;
    db.exec("UPDATE managed_state SET requested_revision=revision");
    await expect(saveManaged(env,stale,profile())).rejects.toMatchObject({status:409});
    expect((await managedRow(env,'s'))!.revision).toBe(1);
  });
  it('continues an automatically submitted job after switching to Manual',async()=>{
    const document=profile();await createManaged(env,'s',document);
    remote.mockResolvedValue({serverId:'s',revision:0,job:{state:'succeeded'}});
    expect(await reconcileServer(env,server)).toBe(false);
    expect((await managedRow(env,'s'))!.requested_revision).toBe(1);
    db.exec("UPDATE operation_settings SET mode='manual'");succeed(1,document);
    expect(await reconcileServer(env,server)).toBe(true);
  });
  it('protects operation settings by owner access and version',async()=>{
    const req=(mode:string,version:number)=>new Request('https://benx.test/api/operation-mode',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode,version})});
    await expect(operationModeRoute(req('manual',1),env,false)).rejects.toMatchObject({status:403});
    expect(await (await operationModeRoute(req('manual',1),env,true)).json()).toEqual({mode:'manual',version:2});
    await expect(operationModeRoute(req('automatic',1),env,true)).rejects.toMatchObject({status:409});
  });
  it('uses a status-only check between checkpoints, but never skips a changed revision or drift', async () => {
    const d = profile(); await createManaged(env, 's', d); succeed(1, d); expect(await reconcileServer(env, server)).toBe(true);
    remote.mockClear(); expect(await reconcileServer(env, server)).toBe(true);
    expect(remote.mock.calls.map(([, , r]) => r.path)).toEqual(['/benx/v1/control/status']);
    await saveManaged(env, (await managedRow(env, 's'))!, d); remote.mockClear(); expect(await reconcileServer(env, server)).toBe(false);
    expect(remote.mock.calls.some(([, , r]) => r.path.endsWith('/apply'))).toBe(true);
  });
  it('cannot overwrite an edit queued while a previous revision is being confirmed', async () => {
    const initial = profile(); await createManaged(env, 's', initial);
    remote.mockImplementation(async (_server, _env, request) => {
      if (request.path.endsWith('/status')) return { serverId: 's', revision: 1, drift: false, job: { state: 'succeeded' } };
      if (request.path.endsWith('/export')) {
        const edited = structuredClone(initial); edited.state.inbounds[1].remark = 'New saved remark';
        await saveManaged(env, (await managedRow(env, 's'))!, edited);
        return initial;
      }
      throw new Error('Unexpected request');
    });
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await managedRow(env, 's')).toMatchObject({ revision: 2, applied_revision: 0, phase: 'pending', lease: null });
    expect((await desired()).state.inbounds[1].remark).toBe('New saved remark');
  });
  it('queues edits during routine reconciliation but preserves migration locks and revision conflicts', async () => {
    await createManaged(env, 's', profile());
    const before = (await managedRow(env, 's'))!;
    db.prepare("UPDATE managed_state SET lease='sync:background',lease_until=? WHERE server_id='s'").run(Date.now() + 60000);
    await saveManaged(env, before, profile());
    expect(await managedRow(env, 's')).toMatchObject({ revision: 2, phase: 'pending' });
    await expect(saveManaged(env, before, profile())).rejects.toThrow('changed');
    db.prepare("UPDATE managed_state SET lease='verify:replacement',lease_until=? WHERE server_id='s'").run(Date.now() + 60000);
    await expect(saveManaged(env, (await managedRow(env, 's'))!, profile())).rejects.toThrow('changed');
  });
  it('surfaces rejected configuration without exposing logs and retries after a cooldown', async () => {
    await createManaged(env, 's', profile());
    const createdAt = Date.now();
    remote.mockResolvedValue({ serverId: 's', revision: 1, job: { state: 'failed', createdAt, message: 'private credential vendor excerpt' } });
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await managedRow(env, 's')).toMatchObject({ phase: 'failed', applied_revision: 0 });
    expect((await managedRow(env, 's'))!.error).toContain('rejected');
    expect((await managedRow(env, 's'))!.error).not.toContain('credential');
    expect(remote.mock.calls.some(c => c[2].path.endsWith('/apply'))).toBe(false);
    remote.mockClear();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(createdAt + 61000);
    try {
      expect(await reconcileServer(env, server)).toBe(false);
      expect(remote.mock.calls.some(c => c[2].path.endsWith('/apply'))).toBe(true);
      expect(await managedRow(env, 's')).toMatchObject({ phase: 'applying' });
    } finally { clock.mockRestore(); }
  });
  it('does not fall through to a live server for items absent from the saved configuration', async () => {
    await createManaged(env, 's', profile());
    for (const path of ['/panel/api/inbounds/get/99', '/panel/api/clients/get/missing']) {
      await expect(managedRequest(env, server, { path, method: 'GET' })).rejects.toMatchObject({ status: 404 });
    }
    expect(remote).not.toHaveBeenCalled();
  });
  it('encrypts client and private-key secrets in both current configuration and revision history', async () => {
    const d = profile(); d.assets['/etc/benx/private.pem'] = 'PRIVATE-PKI-SECRET';
    await createManaged(env, 's', d);
    d.state.clients.alice.password = 'new-client-secret-password';
    await saveManaged(env, (await managedRow(env, 's'))!, d);
    const row = (await managedRow(env, 's'))!, versions = db.prepare('SELECT revision,document FROM managed_versions ORDER BY revision').all() as Array<{ revision: number; document: string }>;
    expect(row).toMatchObject({ revision: 2, applied_revision: 0, phase: 'pending' });
    for (const ciphertext of [row.document, ...versions.map(v => v.document)]) {
      expect(ciphertext).not.toContain('client-secret-password'); expect(ciphertext).not.toContain('PRIVATE-PKI-SECRET'); expect(ciphertext).not.toContain('private-subscription');
      expect(await decrypt<ManagedDocument>(ciphertext, key)).toMatchObject({ assets: { '/etc/benx/private.pem': 'PRIVATE-PKI-SECRET' } });
    }
    expect((await decrypt<ManagedDocument>(versions[0].document, key)).state.clients.alice.password).toBe('client-secret-password');
    expect((await desired()).state.clients.alice.password).toBe('new-client-secret-password'); expect(remote).not.toHaveBeenCalled();
  });
  it('retains the exact saved revision and identity when the server is offline', async () => {
    await createManaged(env, 's', profile()); const before = (await managedRow(env, 's'))!;
    remote.mockRejectedValue(new Error('Offline vendor error with secret=do-not-expose'));
    expect(await reconcileServer(env, server)).toBe(false);
    const after = (await managedRow(env, 's'))!;
    expect(after).toMatchObject({ revision: 1, document: before.document, applied_revision: 0, phase: 'failed', lease: null, lease_until: 0 });
    expect(after.error).toContain('has not confirmed'); expect(after.error).not.toContain('do-not-expose'); expect(await desired()).toEqual(profile());
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_versions').get()).toEqual({ n: 1 });
  });
  it('keeps an accepted apply pending until the agent confirms the exact server and revision', async () => {
    const d = profile(); await createManaged(env, 's', d); succeed(0, d);
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await managedRow(env, 's')).toMatchObject({ phase: 'applying', revision: 1, applied_revision: 0 });
    expect(remote.mock.calls.find(c => c[2].path === '/benx/v1/control/apply')?.[2].body).toMatchObject({ serverId: 's', revision: 1, document: d, replacement: false, repair: false });
    expect(remote.mock.calls.some(c => c[2].path.endsWith('/export'))).toBe(false);
    remote.mockClear(); succeed(1, d, 'another-logical-server');
    expect(await reconcileServer(env, server)).toBe(false); expect(await managedRow(env, 's')).toMatchObject({ phase: 'applying', applied_revision: 0 });
    remote.mockClear(); succeed(1, d);
    expect(await reconcileServer(env, server)).toBe(true); expect(await managedRow(env, 's')).toMatchObject({ phase: 'synced', applied_revision: 1, lease: null });
    expect(remote.mock.calls.map(c => c[2].path)).toEqual(['/benx/v1/control/status', '/benx/v1/control/export']);
    const changed = await desired(); changed.state.clients.alice.comment = 'Updated client'; await saveManaged(env, (await managedRow(env, 's'))!, changed); remote.mockClear();
    expect(await reconcileServer(env, server)).toBe(false); expect(await managedRow(env, 's')).toMatchObject({ revision: 2, phase: 'applying', applied_revision: 1 });
    expect(remote.mock.calls.find(c => c[2].path.endsWith('/apply'))?.[2].body?.revision).toBe(2); expect(remote.mock.calls.some(c => c[2].path.endsWith('/export'))).toBe(false);
  });
  it('checkpoints generated PKI and WireGuard identities at the same verified revision', async () => {
    const d = profile(); await createManaged(env, 's', d); const checkpoint = structuredClone(d);
    checkpoint.assets = { '/etc/benx/wg-private.key': 'SERVER-GENERATED-WG-SECRET', '/etc/benx/cert.pem': 'GENERATED-CERTIFICATE' };
    checkpoint.runtime = { alice: { up: 7, down: 11 }, certificateRenewalPending: true };
    checkpoint.state.inbounds[0].settings = { ...parseObject(checkpoint.state.inbounds[0].settings), privateKey: 'GENERATED-INBOUND-KEY' };
    const tls = parseObject(parseObject(checkpoint.state.inbounds[1].streamSettings).tlsSettings); tls.certificates = [{ certificateFile: '/etc/benx/cert.pem', keyFile: '/etc/benx/private.pem' }];
    checkpoint.state.clients.alice.privateKey = 'GENERATED-CLIENT-KEY'; checkpoint.state.clients.alice.publicKey = 'GENERATED-CLIENT-PUBLIC';
    succeed(1, checkpoint); expect(await reconcileServer(env, server)).toBe(true);
    const row = (await managedRow(env, 's'))!, saved = await desired();
    expect(row).toMatchObject({ revision: 1, applied_revision: 1, phase: 'synced' }); expect(saved.assets).toEqual(checkpoint.assets); expect(saved.runtime).toEqual(checkpoint.runtime);
    expect(parseObject(saved.state.inbounds[0].settings).privateKey).toBe('GENERATED-INBOUND-KEY');
    expect(parseObject(parseObject(saved.state.inbounds[1].streamSettings).tlsSettings).certificates).toEqual(tls.certificates);
    expect(saved.state.clients.alice).toMatchObject({ id: d.state.clients.alice.id, password: d.state.clients.alice.password, privateKey: 'GENERATED-CLIENT-KEY', publicKey: 'GENERATED-CLIENT-PUBLIC' });
    const versions = db.prepare('SELECT document FROM managed_versions').all() as Array<{ document: string }>; expect(versions).toHaveLength(1);
    expect(await decrypt<ManagedDocument>(versions[0].document, key)).toEqual(saved); expect(row.document).not.toContain('GENERATED-CLIENT-KEY');
  });
  it('keeps renewing TLS file references and saves portable certificates separately', async () => {
    const d = profile();
    const tls = parseObject(parseObject(d.state.inbounds[1].streamSettings).tlsSettings);
    tls.certificates = [{ certificateFile: '/etc/letsencrypt/live/domain/fullchain.pem', keyFile: '/etc/letsencrypt/live/domain/privkey.pem' }];
    await createManaged(env, 's', d);
    const checkpoint = structuredClone(d), portable = [{ certificate: ['CERTIFICATE'], key: ['PRIVATE KEY'] }];
    parseObject(parseObject(checkpoint.state.inbounds[1].streamSettings).tlsSettings).certificates = portable;
    succeed(1, checkpoint); expect(await reconcileServer(env, server)).toBe(true);
    const saved = await desired();
    expect(parseObject(parseObject(saved.state.inbounds[1].streamSettings).tlsSettings).certificates).toEqual(tls.certificates);
    expect(parseObject(saved.runtime.tlsCertificates)['2']).toEqual(portable);
  });
  it('does not call the server or report confirmation while another reconciliation owns the lease', async () => {
    await createManaged(env, 's', profile()); db.prepare("UPDATE managed_state SET phase='applying',lease='other-worker',lease_until=? WHERE server_id='s'").run(Date.now() + 60000);
    expect(await reconcileServer(env, server)).toBe(false); expect(remote).not.toHaveBeenCalled();
    expect(await managedRow(env, 's')).toMatchObject({ phase: 'applying', applied_revision: 0, lease: 'other-worker' });
  });
  it('never treats an unbound saved profile as a live VPS', async () => {
    await createManaged(env, 's', profile(), 0); expect(await reconcileServer(env, server)).toBe(false); expect(remote).not.toHaveBeenCalled();
    expect(await managedRow(env, 's')).toMatchObject({ bound: 0, phase: 'pending', applied_revision: 0 });
  });
  it('keeps unbound profiles editable in Manual after a sync request', async () => {
    db.exec("UPDATE operation_settings SET mode='manual'");
    await createManaged(env, 's', profile(), 0);
    db.exec('UPDATE managed_state SET requested_revision=revision');
    const document=await desired(); document.state.inbounds[1].remark='Saved for a future VPS';
    await saveManaged(env,(await managedRow(env,'s'))!,document);
    expect(await managedRow(env,'s')).toMatchObject({bound:0,revision:2,requested_revision:0});
    expect(await reconcileServer(env,server)).toBe(false); expect(remote).not.toHaveBeenCalled();
  });
  it('blocks ordinary synchronization during replacement while allowing explicit candidate verification', async () => {
    const d = profile(); await createManaged(env, 's', d); const candidate = await seedServer('replacement', 'ssh://2.2.2.2:22/');
    db.prepare("INSERT INTO replacements(server_id,candidate_id,state,created_at,updated_at) VALUES('s','replacement','installing',0,0)").run();
    expect(await reconcileServer(env, server)).toBe(false); expect(remote).not.toHaveBeenCalled();
    succeed(1, d); expect(await reconcileServer(env, server, candidate)).toBe(true);
    expect(remote.mock.calls.every(c => c[0].id === 'replacement' && c[0].url === candidate.url)).toBe(true);
    expect(await managedRow(env, 's')).toMatchObject({ phase: 'synced', applied_revision: 1 });
  });
  it('does not report a verified revision after its reconciliation lease was superseded', async () => {
    const d = profile(); await createManaged(env, 's', d); const checkpoint = structuredClone(d); checkpoint.assets['/etc/benx/private.key'] = 'UNOWNED-CHECKPOINT-SECRET';
    remote.mockImplementation(async (_server, _env, request) => {
      if (request.path.endsWith('/status')) return { serverId: 's', revision: 1, drift: false, job: { state: 'succeeded' } };
      if (request.path.endsWith('/export')) { db.prepare("UPDATE managed_state SET lease='new-worker',lease_until=?,phase='applying' WHERE server_id='s'").run(Date.now() + 60000); return structuredClone(checkpoint); }
      throw new Error('Unexpected agent request');
    });
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await managedRow(env, 's')).toMatchObject({ applied_revision: 0, phase: 'applying', lease: 'new-worker' });
    expect(await desired()).toEqual(d);
    const version = db.prepare("SELECT document FROM managed_versions WHERE server_id='s' AND revision=1").get() as { document: string };
    expect(await decrypt<ManagedDocument>(version.document, key)).toEqual(d);
  });
  it('never reconciles a retired connection snapshot after the logical server connection changed', async () => {
    const d = profile(); await createManaged(env, 's', d);
    db.prepare("UPDATE servers SET url='ssh://8.8.8.8:22/' WHERE id='s'").run();
    succeed(1, d);
    await reconcileServer(env, server);
    expect(remote.mock.calls.every(([destination]) => destination.url === 'ssh://8.8.8.8:22/')).toBe(true);
  });
  it('does not checkpoint or confirm an old destination after the connection changes during export', async () => {
    const d = profile(); await createManaged(env, 's', d);
    const checkpoint = structuredClone(d); checkpoint.runtime = { usage: { alice: { up: 7, down: 11 } } };
    remote.mockImplementation(async (_server, _env, request) => {
      if (request.path.endsWith('/status')) return { serverId: 's', revision: 1, drift: false, job: { state: 'succeeded' } };
      if (request.path.endsWith('/export')) { db.prepare("UPDATE servers SET url='ssh://8.8.8.8:22/' WHERE id='s'").run(); return checkpoint; }
      throw new Error('Unexpected agent request');
    });
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await desired()).toEqual(d);
    expect(await managedRow(env, 's')).toMatchObject({ applied_revision: 0 });
  });
  it('rewrites native VPS IPv6 addresses without carrying URL brackets into listener fields', async () => {
    const oldAddress = '2001:4860:4860::8888', newAddress = '2606:4700:4700::1111';
    db.prepare('UPDATE servers SET url=? WHERE id=?').run(`ssh://[${oldAddress}]:22/`, 's');
    server = db.prepare("SELECT * FROM servers WHERE id='s'").get() as unknown as StoredServer;
    const d = profile(); d.state.inbounds[1].listen = oldAddress; d.state.inbounds[1].address = oldAddress; d.state.inbounds[1].settings = { ...parseObject(d.state.inbounds[1].settings), publicHost: oldAddress };
    await createManaged(env, 's', d);
    const candidate = await seedServer('candidate-ipv6', `ssh://[${newAddress}]:22/`);
    succeed(0, d); expect(await reconcileServer(env, server, candidate)).toBe(false);
    const submitted = remote.mock.calls.find(([, , request]) => request.path.endsWith('/apply'))?.[2].body?.document as ManagedDocument;
    expect(submitted.state.inbounds[1]).toMatchObject({ listen: newAddress, address: newAddress, settings: { publicHost: newAddress } });
  });
  it('does not import a checkpoint after the reconciliation lease expires even without a new owner', async () => {
    const d = profile(); await createManaged(env, 's', d);
    const checkpoint = structuredClone(d); checkpoint.runtime = { usage: { alice: { up: 15, down: 23 } } };
    remote.mockImplementation(async (_server, _env, request) => {
      if (request.path.endsWith('/status')) return { serverId: 's', revision: 1, drift: false, job: { state: 'succeeded' } };
      if (request.path.endsWith('/export')) { db.prepare("UPDATE managed_state SET lease_until=0 WHERE server_id='s'").run(); return checkpoint; }
      throw new Error('Unexpected agent request');
    });
    expect(await reconcileServer(env, server)).toBe(false);
    expect(await desired()).toEqual(d);
    const version = db.prepare("SELECT document FROM managed_versions WHERE server_id='s' AND revision=1").get() as { document: string };
    expect(await decrypt<ManagedDocument>(version.document, key)).toEqual(d);
  });
});


describe('Scheduled read-only usage refresh', () => {
  it('reflects native resets in the saved dashboard and keeps unreported optional ledgers', async () => {
    db.exec("UPDATE operation_settings SET mode='manual'");
    const d = profile();
    d.runtime = { usage: { alice: { up: 90, down: 10 } }, inbounds: { '2': { up: 90, down: 10 } }, firstUse: { alice: { startedAt: 123 } } };
    await createManaged(env, 's', d);
    remote.mockResolvedValue({ usage: {}, inbounds: {} });
    expect(await refreshUsage(env, server)).toBe(true);
    const refreshed = await desired();
    expect(refreshed.runtime.usage).toEqual({});
    expect(refreshed.runtime.inbounds).toEqual({});
    expect(refreshed.runtime.firstUse).toEqual(d.runtime.firstUse);
    const snapshot = await dashboard(new Request('https://benx.test/?saved=1'), env, server, {} as ExecutionContext);
    expect(await snapshot.json()).toMatchObject({ inbounds: [
      { up: 0, down: 0, clientStats: [{ email: 'alice', up: 0, down: 0 }] },
      { up: 0, down: 0, clientStats: [{ email: 'alice', up: 0, down: 0 }] },
    ] });
    remote.mockResolvedValue({ usage: {}, firstUse: {} });
    await refreshUsage(env, server);
    expect((await desired()).runtime.firstUse).toEqual({});
  });
  it('keeps the last native snapshot when a reported counter collection is malformed', async () => {
    const d = profile();
    d.runtime = { usage: { alice: { up: 10, down: 20 } }, inbounds: { '2': { up: 10, down: 20 } } };
    await createManaged(env, 's', d);
    remote.mockResolvedValue({ usage: {}, inbounds: [] });
    await expect(refreshUsage(env, server)).rejects.toThrow();
    expect((await desired()).runtime).toEqual(d.runtime);
  });
  it('refreshes counters in Manual mode without applying drafts or changing the saved revision', async () => {
    db.exec("UPDATE operation_settings SET mode='manual'");
    await createManaged(env,'s',profile());
    const before=(await managedRow(env,'s'))!;
    remote.mockResolvedValue({usage:{alice:{up:123,down:456}},inbounds:{'2':{up:123,down:456}},firstUse:{}});
    await refreshUsageFleet(env);
    const after=(await managedRow(env,'s'))!, d=await desired();
    expect(after.revision).toBe(before.revision);expect(after.phase).toBe(before.phase);expect(after.requested_revision).toBe(before.requested_revision);
    expect(d.state).toEqual(profile().state);expect(d.runtime.usage).toMatchObject({alice:{up:123,down:456}});
    expect(remote.mock.calls.map(c=>c[2].path)).toEqual(['/benx/v1/accounting']);
    await refreshUsageFleet(env);expect(remote).toHaveBeenCalledTimes(1);
  });
  it('preserves concurrent edits and busy jobs rather than replacing them with a usage snapshot', async () => {
    await createManaged(env,'s',profile());
    remote.mockImplementation(async()=>{const row=(await managedRow(env,'s'))!;const d=await desired();d.state.clients.alice.comment='concurrent edit';await saveManaged(env,row,d);return {usage:{alice:{up:999}}};});
    expect(await refreshUsage(env,server)).toBe(false);expect((await desired()).state.clients.alice.comment).toBe('concurrent edit');
    remote.mockClear();db.exec("UPDATE managed_state SET phase='applying'");expect(await refreshUsage(env,server)).toBe(false);expect(remote).not.toHaveBeenCalled();db.prepare('UPDATE managed_state SET lease_until=?').run(Date.now()+60000);
    expect(await refreshUsage(env,server)).toBe(false);expect(remote).not.toHaveBeenCalled();
  });
  it('keeps the previous counters when a server is offline and reports a safe error', async () => {
    const d=profile();d.runtime.usage={alice:{up:100,down:20}};await createManaged(env,'s',d);
    remote.mockRejectedValue(new Error('private credentials in provider error'));
    await refreshUsageFleet(env);expect((await desired()).runtime.usage).toEqual(d.runtime.usage);
    expect(db.prepare('SELECT error FROM usage_refresh_state').get()?.error).not.toContain('private');
    db.exec('UPDATE usage_refresh_settings SET interval_minutes=0');remote.mockClear();await refreshUsageFleet(env);expect(remote).not.toHaveBeenCalled();
  });
  it('restricts interval edits to the owner and rejects unsupported cadences or stale versions', async () => {
    const request=(minutes:number,version=1)=>new Request('https://benx.test/api/usage-refresh',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({interval_minutes:minutes,version})});
    await expect(usageRefreshRoute(request(60),env,false)).rejects.toMatchObject({status:403});
    await expect(usageRefreshRoute(request(1),env,true)).rejects.toMatchObject({status:400});
    expect(await (await usageRefreshRoute(request(180),env,true)).json()).toMatchObject({interval_minutes:180,version:2});
    await expect(usageRefreshRoute(request(60),env,true)).rejects.toMatchObject({status:409});
  });
});
