import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

vi.mock('../worker/bootstrap', async importOriginal => ({ ...await importOriginal<typeof import('../worker/bootstrap')>(), bootstrapRoute: vi.fn() }));
vi.mock('../worker/control', async importOriginal => ({ ...await importOriginal<typeof import('../worker/control')>(), reconcileServer: vi.fn(), adoptServer: vi.fn() }));
vi.mock('../worker/remote', async importOriginal => ({ ...await importOriginal<typeof import('../worker/remote')>(), callRemoteJson: vi.fn() }));
vi.mock('../worker/retirement', () => ({ cleanupRetiredServers: vi.fn() }));
import { bootstrapRoute } from '../worker/bootstrap';
import { createManaged, managedRow, reconcileServer, saveManaged, savedDocument } from '../worker/control';
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { advanceReplacement, replacementRoute } from '../worker/replacement';
import { cleanupRetiredServers } from '../worker/retirement';
import worker from '../worker/index';
import { decrypt, encrypt, issueSession } from '../worker/security';
import { emptyDocument } from '../shared/managed';

let db: DatabaseSync, env: Env, ctx: ExecutionContext, pending: Promise<unknown>[];
let runFault: ((sql: string) => void) | undefined;
let beforeBatch: (() => Promise<void>) | undefined;
const original = 'logical-server', candidate = 'candidate-server', panel = 'logical-panel', candidatePanel = 'candidate-panel';
const oldCredentials = { token: 'old-management-token', ssh: { host: '1.1.1.1', port: 22, username: 'root', privateKey: 'old-key', fingerprint: 'old-pin' } };
const nextCredentials = { token: 'new-management-token', ssh: { host: '8.8.8.8', port: 22, username: 'root', privateKey: 'new-key', fingerprint: 'new-pin' } };

function database(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        sql,
        bind(...args: SQLInputValue[]) { values = args; return this; },
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...values), success: true }; },
        async run() { runFault?.(sql); const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements: Array<{ sql?: string; run: () => Promise<unknown> }>) {
      if (statements.some(s => s.sql?.startsWith('UPDATE servers SET url='))) await beforeBatch?.();
      db.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  } as unknown as D1Database;
}
const request = (body: unknown, method = 'POST') => new Request(`https://benx.example.com/api/servers/${original}/replacement`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'POST' ? JSON.stringify(body) : undefined });
function server(id = original) { return db.prepare('SELECT * FROM servers WHERE id=?').get(id) as unknown as StoredServer; }
async function insert(id: string, credentials: unknown, kind = 'server', parentId: string | null = null) {
  const replacement = id.startsWith('candidate');
  db.prepare('INSERT INTO servers(id,name,url,version,kind,auth,credentials,location,subscription_url,created_at,parent_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, replacement ? 'Fresh VPS' : 'My server', replacement ? 'ssh://8.8.8.8:22/' : 'ssh://1.1.1.1:22/', 'v3', kind, 'token', await encrypt(credentials, env.ENCRYPTION_KEY), 'Frankfurt', 'https://subscription.example.com/sub/', 42, parentId);
}
async function fixture({ child = false, state = 'installing', bound = 1 }: { child?: boolean; state?: string; bound?: number } = {}) {
  await insert(original, oldCredentials); await insert(candidate, nextCredentials);
  const document = emptyDocument();
  if (child) document.setup.panel = '3x-ui';
  await createManaged(env, original, document, bound);
  db.prepare('INSERT INTO replacements(server_id,candidate_id,state,error,created_at,updated_at) VALUES(?,?,?,\'\',0,0)').run(original, candidate, state);
  if (child) {
    await insert(panel, { ...oldCredentials, installedPanel: true }, 'panel', original);
    await insert(candidatePanel, { ...nextCredentials, installedPanel: true }, 'panel', candidate);
    const panelDocument = emptyDocument(); panelDocument.mode = 'panel'; panelDocument.setup.panel = '3x-ui';
    await createManaged(env, panel, panelDocument);
  }
  return server();
}
function replacement() { return db.prepare('SELECT * FROM replacements WHERE server_id=?').get(original) as { state: string; candidate_id: string; error: string }; }
async function cutover() { return replacementRoute(request({ action: 'cutover' }), env, server(), ctx); }

beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db), ENCRYPTION_KEY: btoa('k'.repeat(32)), ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-strong-test-password', SESSION_SECRET: '12345678901234567890123456789012' } as Env;
  pending = []; ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext;
  runFault = undefined; beforeBatch = undefined; vi.clearAllMocks();
  vi.mocked(bootstrapRoute).mockResolvedValue(Response.json({ state: 'succeeded', agentReady: true }));
  vi.mocked(callRemoteJson).mockResolvedValue({ xray: { state: 'running' } });
  vi.mocked(cleanupRetiredServers).mockResolvedValue(undefined);
  vi.mocked(reconcileServer).mockImplementation(async (_env, logical, target) => {
    if (logical.kind === 'panel') {
      const row = (await managedRow(env, logical.id))!, document = await savedDocument(env, row);
      document.runtime._benxPanelBinding = { serverId: target!.id, inbounds: { 7: 91 }, nodes: { 2: 51 }, hosts: { h: 'restored-host' } };
      db.prepare('UPDATE managed_state SET document=? WHERE server_id=?').run(await encrypt(document, env.ENCRYPTION_KEY), logical.id);
    }
    db.prepare("UPDATE managed_state SET phase='synced',applied_revision=revision,error='' WHERE server_id=?").run(logical.id);
    return true;
  });
});
afterEach(async () => { await Promise.allSettled(pending); db.close(); });

describe('Verified VPS replacement', () => {
  it('keeps installation candidates and their panel children out of the authenticated server picker', async () => {
    await fixture({ child: true });
    const token = await issueSession(env);
    const incoming = new Request('https://benx.example.com/api/servers', { headers: { Cookie: `benx_session=${token}` } }) as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(incoming, env, ctx);
    expect(response.status).toBe(200);
    const rows = await response.json() as Array<{ id: string; credentials?: string }>;
    expect(rows.map(s => s.id)).toEqual([original, panel]);
    expect(rows.every(s => s.credentials === undefined)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('management-token');
  });

  it('refuses switching while installation has not completed without sending credentials elsewhere', async () => {
    await fixture(); const before = server();
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before);
    expect(bootstrapRoute).not.toHaveBeenCalled(); expect(callRemoteJson).not.toHaveBeenCalled(); expect(reconcileServer).not.toHaveBeenCalled();
  });

  it('marks a restored candidate ready while keeping the original VPS connection active until cutover', async () => {
    await fixture(); const before = server();
    expect(await advanceReplacement(env, server())).toMatchObject({ state: 'ready', candidate_id: candidate });
    expect(server()).toEqual(before);
    expect(replacement().state).toBe('ready');
    expect(await decrypt(server().credentials, env.ENCRYPTION_KEY)).toEqual(oldCredentials);
  });

  it('rechecks the latest saved revision and preserves the original when the candidate has an older revision', async () => {
    await fixture({ state: 'ready' }); const before = server();
    db.prepare("UPDATE managed_state SET revision=2,applied_revision=1,phase='synced' WHERE server_id=?").run(original);
    vi.mocked(reconcileServer).mockResolvedValue(false);
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before);
    expect(replacement().state).toBe('restoring');
    expect(callRemoteJson).not.toHaveBeenCalled();
  });

  it('restores every private panel first and cuts over only credentials while preserving logical IDs and related data', async () => {
    await fixture({ child: true, state: 'ready' });
    await insert('peer-server', { token: 'peer-token' });
    db.prepare('INSERT INTO subscriptions(server_id,email,token_hash,secret,identity,created_at) VALUES(?,?,?,?,?,0)').run(original, 'alice', 'keep-public-token-hash', 'keep-encrypted-subscription-secret', 'keep-client-identity');
    db.prepare('UPDATE server_policy SET revision=4,data=? WHERE server_id=?').run('{"keep":"policy"}', original);
    db.prepare('INSERT INTO locations(id,server_id,name,provider,country,secret,created_at) VALUES(?,?,?,?,?,?,0)').run('location', original, 'Free location', 'vpnjantit', 'DE', 'keep-location-secret');
    db.prepare('INSERT INTO fleet_inbounds(id,server_id,inbound_id) VALUES(?,?,7)').run('fleet-config', original);
    db.prepare('INSERT INTO tunnels(id,source_id,target_id,state,data,updated_at) VALUES(?,?,?,\'active\',?,0)').run('tunnel', original, 'peer-server', '{"keep":"tunnel-profile"}');
    const preserved = ['subscriptions', 'server_policy', 'locations', 'fleet_inbounds'].map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const prior = server(), childPrior = server(panel), documentBefore = await savedDocument(env, (await managedRow(env, original))!);
    vi.mocked(callRemoteJson).mockImplementation(async () => {
      expect(server().credentials).toBe(prior.credentials);
      expect(server(panel).credentials).toBe(childPrior.credentials);
      return { xray: { state: 'running' } };
    });
    const response = await cutover();
    expect(await response.json()).toEqual({ id: original, replaced: true, tunnelsPending: true, retirementPending: true });
    expect(server()).toMatchObject({ id: original, name: prior.name, location: prior.location, subscription_url: prior.subscription_url, created_at: prior.created_at, url: 'ssh://8.8.8.8:22/', enabled: 1 });
    expect(await decrypt(server().credentials, env.ENCRYPTION_KEY)).toEqual(nextCredentials);
    expect(await decrypt(server(panel).credentials, env.ENCRYPTION_KEY)).toEqual({ ...nextCredentials, installedPanel: true });
    expect(server(panel).parent_id).toBe(original); expect(server(candidate).enabled).toBe(0); expect(server(candidatePanel).enabled).toBe(0);
    expect(replacement().state).toBe('completed');
    expect(await managedRow(env, original)).toMatchObject({ bound: 1, phase: 'synced', applied_revision: 1, revision: 1 });
    expect(await savedDocument(env, (await managedRow(env, original))!)).toEqual(documentBefore);
    const restoredPanel = await savedDocument(env, (await managedRow(env, panel))!);
    expect(restoredPanel.runtime._benxPanelBinding).toEqual({ serverId: panel, inbounds: { 7: 91 }, nodes: { 2: 51 }, hosts: { h: 'restored-host' } });
    const history = db.prepare('SELECT document FROM managed_versions WHERE server_id=? AND revision=1').get(panel) as { document: string };
    expect(await decrypt(history.document, env.ENCRYPTION_KEY)).toEqual(restoredPanel);
    expect(['subscriptions', 'server_policy', 'locations', 'fleet_inbounds'].map(table => db.prepare(`SELECT * FROM ${table}`).all())).toEqual(preserved);
    expect(db.prepare('SELECT source_id,target_id,state,data FROM tunnels').get()).toEqual({ source_id: original, target_id: 'peer-server', state: 'pending', data: '{"keep":"tunnel-profile"}' });
    expect(vi.mocked(reconcileServer).mock.calls.map(([, logical, target]) => [logical.id, target?.id])).toEqual([[original, candidate], [panel, candidatePanel]]);
    const retired = db.prepare('SELECT server_id,connection,state FROM retired_servers').get() as { server_id: string; connection: string; state: string };
    expect(retired).toMatchObject({ server_id: original, state: 'pending' });
    expect(await decrypt(retired.connection, env.ENCRYPTION_KEY)).toEqual(prior);
    expect(cleanupRetiredServers).toHaveBeenCalledOnce();
  });

  it('retains original credentials when the restored candidate fails its final health check', async () => {
    await fixture({ state: 'ready' }); const before = server();
    vi.mocked(callRemoteJson).mockRejectedValue(new Error('Private upstream exception with a credential excerpt'));
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before);
    expect(replacement().state).toBe('failed');
    expect(replacement().error).not.toContain('credential excerpt');
    expect(server(candidate).enabled).toBe(1);
  });

  it('keeps the original active when a private panel has not been fully saved or restored', async () => {
    await fixture({ child: true, state: 'ready' }); const before = server(), childBefore = server(panel);
    db.prepare('DELETE FROM managed_state WHERE server_id=?').run(panel);
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before); expect(server(panel)).toEqual(childBefore);
    expect(replacement()).toMatchObject({ state: 'failed' });
    expect(replacement().error).toContain('no saved profile');
    expect(callRemoteJson).not.toHaveBeenCalled();
  });

  it('rolls back the complete cutover if the credential transaction fails', async () => {
    await fixture({ child: true, state: 'ready' }); const before = server(), childBefore = server(panel);
    let updates = 0;
    runFault = sql => { if (sql.startsWith('UPDATE servers SET url=') && ++updates === 2) throw new Error('Simulated interrupted credential transaction'); };
    await expect(cutover()).rejects.toThrow('interrupted credential transaction');
    expect(server()).toEqual(before); expect(server(panel)).toEqual(childBefore);
    expect(server(candidate).enabled).toBe(1); expect(server(candidatePanel).enabled).toBe(1);
    expect(replacement().state).toBe('ready');
  });

  it('binds an unconnected saved server on cutover without changing its identity', async () => {
    await fixture({ bound: 0, state: 'ready' });
    db.prepare('UPDATE servers SET enabled=0 WHERE id=?').run(original);
    await cutover();
    expect(server()).toMatchObject({ id: original, enabled: 1, url: 'ssh://8.8.8.8:22/' });
    expect(await managedRow(env, original)).toMatchObject({ bound: 1, phase: 'synced' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM retired_servers').get()).toEqual({ n: 0 });
    expect(cleanupRetiredServers).not.toHaveBeenCalled();
  });

  it('does not confuse an acknowledgement from the previous VPS with a busy candidate reconciler', async () => {
    await fixture({ state: 'ready' }); const before = server();
    db.prepare("UPDATE managed_state SET applied_revision=revision,phase='synced' WHERE server_id=?").run(original);
    vi.mocked(reconcileServer).mockResolvedValue(false);
    expect(await advanceReplacement(env, server())).toMatchObject({ state: 'restoring', verified_revisions: '{}' });
    expect(server()).toEqual(before); expect(callRemoteJson).not.toHaveBeenCalled();
    expect(replacement().state).not.toBe('ready');
  });

  it('serializes concurrent replacement polling and cutover requests', async () => {
    await fixture({ state: 'ready' }); const before = server();
    let resolve!: (response: Response) => void;
    vi.mocked(bootstrapRoute).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const first = cutover();
    await vi.waitFor(() => expect(bootstrapRoute).toHaveBeenCalledOnce());
    expect(server()).toEqual(before);
    expect(await advanceReplacement(env, server())).toMatchObject({ state: 'ready' });
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(bootstrapRoute).toHaveBeenCalledOnce();
    resolve(Response.json({ state: 'succeeded', agentReady: true }));
    await first;
    expect(replacement()).toMatchObject({ state: 'completed', lease: null, lease_until: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM retired_servers').get()).toEqual({ n: 1 });
  });

  it('invalidates readiness when saved settings change during the final health check', async () => {
    await fixture({ state: 'ready' }); const before = server();
    vi.mocked(callRemoteJson).mockImplementationOnce(async () => {
      const row = (await managedRow(env, original))!, document = await savedDocument(env, row);
      document.state.xray.outbounds = [{ protocol: 'blackhole', tag: 'direct' }];
      await saveManaged(env, row, document);
      return { xray: { state: 'running' } };
    });
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before); expect(replacement().state).toBe('restoring');
    expect(await managedRow(env, original)).toMatchObject({ revision: 2, phase: 'pending', lease: null });
    expect(db.prepare('SELECT COUNT(*) AS n FROM retired_servers').get()).toEqual({ n: 0 });
  });

  it('holds both desired profile leases until the atomic cutover transaction finishes', async () => {
    await fixture({ child: true, state: 'ready' });
    const blocked: string[] = [];
    beforeBatch = async () => {
      for (const id of [original, panel]) {
        const row = (await managedRow(env, id))!, document = await savedDocument(env, row);
        expect(row.lease).toBeTruthy(); expect(row.lease_until).toBeGreaterThan(Date.now());
        await expect(saveManaged(env, row, document)).rejects.toMatchObject({ status: 409 });
        blocked.push(id);
      }
    };
    await cutover();
    expect(blocked).toEqual([original, panel]);
    expect(await managedRow(env, original)).toMatchObject({ lease: null, lease_until: 0 });
    expect(await managedRow(env, panel)).toMatchObject({ lease: null, lease_until: 0 });
  });

  it('fails every cutover write together if a noncooperating writer changes the revision immediately before commit', async () => {
    await fixture({ child: true, state: 'ready' }); const before = server(), childBefore = server(panel);
    beforeBatch = async () => { db.prepare("UPDATE managed_state SET revision=revision+1,phase='pending' WHERE server_id=?").run(panel); };
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toEqual(before); expect(server(panel)).toEqual(childBefore);
    expect(server(candidate).enabled).toBe(1); expect(replacement().state).toBe('ready');
    expect(db.prepare('SELECT COUNT(*) AS n FROM retired_servers').get()).toEqual({ n: 0 });
    expect(await managedRow(env, panel)).toMatchObject({ revision: 2, phase: 'pending', lease: null });
  });

  it('preserves removal intent while queueing configured tunnels for the replacement', async () => {
    await fixture({ state: 'ready' }); await insert('peer-server', { token: 'peer-token' });
    db.prepare("INSERT INTO tunnels(id,source_id,target_id,state,data,updated_at,desired_state) VALUES('remove',?,?, 'cleanup-required','{}',0,'removed')").run(original, 'peer-server');
    await cutover();
    expect(db.prepare("SELECT state,desired_state FROM tunnels WHERE id='remove'").get()).toEqual({ state: 'cleanup-required', desired_state: 'removed' });
  });

  it('serializes initial replacement creation before any second VPS installation can start', async () => {
    await fixture({ state: 'completed' }); await insert('candidate-next', nextCredentials);
    let resolve!: (response: Response) => void;
    vi.mocked(bootstrapRoute).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const ssh = { host: '8.8.8.8', port: 22, username: 'root', password: 'temporary-install-password', fingerprint: 'SHA256:' + 'a'.repeat(43) };
    const first = replacementRoute(request({ ssh }), env, server(), ctx);
    await vi.waitFor(() => expect(bootstrapRoute).toHaveBeenCalledOnce());
    await expect(replacementRoute(request({ ssh }), env, server(), ctx)).rejects.toMatchObject({ status: 409 });
    expect(bootstrapRoute).toHaveBeenCalledOnce();
    resolve(Response.json({ id: 'candidate-next' }, { status: 201 }));
    expect((await first).status).toBe(201);
    expect(replacement()).toMatchObject({ candidate_id: 'candidate-next', state: 'installing' });
    expect(await managedRow(env, original)).toMatchObject({ lease: null, lease_until: 0 });
  });

  it('does not let an expired poll clear or overwrite a subsequent replacement lease', async () => {
    await fixture();
    let resolve!: (response: Response) => void;
    vi.mocked(bootstrapRoute).mockImplementationOnce(() => new Promise<Response>(done => { resolve = done; }));
    const first = advanceReplacement(env, server());
    await vi.waitFor(() => expect(bootstrapRoute).toHaveBeenCalledOnce());
    db.prepare("UPDATE replacements SET lease='new-owner',lease_until=?,state='restoring' WHERE server_id=?").run(Date.now() + 60000, original);
    resolve(Response.json({ state: 'succeeded', agentReady: true }));
    await first;
    expect(replacement()).toMatchObject({ lease: 'new-owner', state: 'restoring' });
    expect(reconcileServer).not.toHaveBeenCalled();
  });
  it('refuses switching if the original connection changes immediately before the transaction', async () => {
    await fixture({ child: true, state: 'ready' });
    const editedCredentials = await encrypt({ ...oldCredentials, token: 'operator-edited-token' }, env.ENCRYPTION_KEY);
    const priorPanel = server(panel);
    beforeBatch = async () => { db.prepare('UPDATE servers SET url=?,credentials=? WHERE id=?').run('ssh://9.9.9.9:22/', editedCredentials, original); };
    await expect(cutover()).rejects.toMatchObject({ status: 409 });
    expect(server()).toMatchObject({ url: 'ssh://9.9.9.9:22/', credentials: editedCredentials });
    expect(server(panel)).toEqual(priorPanel);
    expect(server(candidate).enabled).toBe(1);
    expect(replacement().state).toBe('ready');
    expect(db.prepare('SELECT COUNT(*) AS n FROM retired_servers').get()).toEqual({ n: 0 });
  });
  it('keeps every previous installation candidate hidden after three successive replacements', async () => {
    await fixture({ child: true, state: 'ready' });
    vi.mocked(bootstrapRoute).mockImplementation(async () => Response.json({ state: 'succeeded', agentReady: true }));
    db.prepare('UPDATE servers SET is_candidate=1 WHERE id=? OR parent_id=?').run(candidate, candidate);
    await cutover();
    for (const n of [2, 3]) {
      const next = `candidate-${n}`, nextPanel = `candidate-panel-${n}`;
      await insert(next, { ...nextCredentials, token: `management-token-${n}` });
      await insert(nextPanel, { ...nextCredentials, token: `management-token-${n}`, installedPanel: true }, 'panel', next);
      db.prepare('UPDATE servers SET is_candidate=1 WHERE id=? OR parent_id=?').run(next, next);
      vi.mocked(bootstrapRoute).mockResolvedValueOnce(Response.json({ id: next }, { status: 201 }));
      const ssh = { host: '8.8.8.8', port: 22, username: 'root', password: 'temporary-install-password', fingerprint: 'SHA256:' + 'a'.repeat(43) };
      await replacementRoute(request({ ssh }), env, server(), ctx);
      expect(await advanceReplacement(env, server())).toMatchObject({ state: 'ready', error: '' });
      await cutover();
    }
    const token = await issueSession(env);
    const incoming = new Request('https://benx.example.com/api/servers', { headers: { Cookie: `benx_session=${token}` } }) as Parameters<typeof worker.fetch>[0];
    const response = await worker.fetch(incoming, env, ctx);
    expect(response.status).toBe(200);
    expect((await response.json() as Array<{ id: string }>).map(s => s.id)).toEqual([original, panel]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM servers WHERE is_candidate=1').get()).toEqual({ n: 6 });
  });
});
