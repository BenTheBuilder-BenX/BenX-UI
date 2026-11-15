import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { createManaged, managedRow, profileRoute, saveManaged, savedDocument } from '../worker/control';
import { fleetInbound } from '../worker/fleet';
import { emptyDocument, reduceDocument, type ManagedDocument } from '../shared/managed';
import type { JsonObject } from '../shared/types';
import { encrypt } from '../worker/security';

let db: DatabaseSync, env: Env, pending: Promise<unknown>[], ctx: ExecutionContext;
let runFault: ((sql: string, values: SQLInputValue[]) => void) | undefined;
const remote = vi.mocked(callRemoteJson);
function database(db: DatabaseSync): D1Database {
  return {
    prepare(sql: string) {
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) { values = args; return this; },
        async first() { return db.prepare(sql).get(...values) ?? null; },
        async all() { return { results: db.prepare(sql).all(...values), success: true }; },
        async run() { runFault?.(sql, values); const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: Number(result.changes) } }; },
      };
    },
    async batch(statements: Array<{ run: () => Promise<unknown> }>) {
      db.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); db.exec('COMMIT'); return results; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  } as unknown as D1Database;
}
const request = (body: unknown) => new Request('https://benx.example.com/api/fleet/inbounds', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const listener = (port = 443): JsonObject => ({ protocol: 'vless', port, remark: 'Fleet listener', enable: true, listen: '', settings: { decryption: 'none', clients: [{ email: 'alice', id: '11111111-1111-4111-8111-111111111111', password: 'portable-client-password', subId: 'portable-subscription', enable: true }] }, streamSettings: { network: 'tcp', security: 'none' }, sniffing: {} });
async function profile(name: string) {
  const response = await profileRoute(request({ name }), env);
  return (await response.json() as { id: string }).id;
}
async function document(id: string) { return savedDocument(env, (await managedRow(env, id))!); }
async function deploy(id: string, serverIds: string[], inbound = listener(), multiplier = 2) {
  const response = await fleetInbound(request({ id, serverIds, inbound, multiplier }), env, ctx);
  await Promise.all(pending);
  return await response.json() as { id: string; results: Array<{ serverId: string; inboundId?: number; saved: boolean; error?: string }> };
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as Env;
  pending = []; ctx = { waitUntil(promise: Promise<unknown>) { pending.push(promise); } } as ExecutionContext;
  runFault = undefined; remote.mockReset(); remote.mockRejectedValue(new Error('A saved unbound profile must not contact a VPS.'));
});
afterEach(async () => { await Promise.allSettled(pending); db.close(); });

describe('Durable multi-server inbound deployment', () => {
  it('saves identical listener settings and credentials on multiple unconnected profiles without remote calls', async () => {
    const first = await profile('Primary'), second = await profile('Recovery'), id = crypto.randomUUID();
    const result = await deploy(id, [first, second]);
    expect(result).toEqual({ id, results: [{ serverId: first, inboundId: 1, saved: true }, { serverId: second, inboundId: 1, saved: true }] });
    const a = await document(first), b = await document(second);
    expect(a.state.inbounds).toEqual(b.state.inbounds);
    expect(a.state.clients.alice).toMatchObject({ id: '11111111-1111-4111-8111-111111111111', password: 'portable-client-password', subId: 'portable-subscription', inboundIds: [1] });
    expect(b.state.clients).toEqual(a.state.clients);
    expect(a.policy.inboundMultipliers).toEqual({ 1: 2 }); expect(b.policy.inboundMultipliers).toEqual({ 1: 2 });
    expect(await managedRow(env, first)).toMatchObject({ revision: 2, bound: 0, phase: 'pending', applied_revision: 0 });
    expect(remote).not.toHaveBeenCalled();
  });
  it('recovers a lost assignment write after the desired configuration was saved without creating a duplicate', async () => {
    const serverId = await profile('Recovery'), id = crypto.randomUUID();
    let failOnce = true;
    runFault = sql => { if (failOnce && sql.includes('INSERT OR IGNORE INTO fleet_inbounds')) { failOnce = false; throw new Error('Assignment write interrupted'); } };
    const interrupted = await deploy(id, [serverId]);
    expect(interrupted.results).toEqual([{ serverId, saved: false, error: 'Assignment write interrupted' }]);
    expect((await document(serverId)).state.inbounds).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM fleet_inbounds').get()).toEqual({ n: 0 });
    const recovered = await deploy(id, [serverId]);
    expect(recovered.results).toEqual([{ serverId, inboundId: 1, saved: true }]);
    expect((await document(serverId)).state.inbounds).toHaveLength(1);
    expect((await document(serverId)).state.nextId).toBe(2);
    expect(await managedRow(env, serverId)).toMatchObject({ revision: 2 });
    expect(await deploy(id, [serverId])).toEqual(recovered);
    expect(remote).not.toHaveBeenCalled();
  });
  it('isolates one server’s occupied-port failure and retries the same group after that port is freed', async () => {
    const healthy = await profile('Healthy'), conflict = await profile('Occupied port'), id = crypto.randomUUID();
    const occupied = reduceDocument(await document(conflict), { path: '/panel/api/inbounds/add', method: 'POST', body: listener() }).document;
    await saveManaged(env, (await managedRow(env, conflict))!, occupied);
    const first = await deploy(id, [healthy, conflict]);
    expect(first.results[0]).toEqual({ serverId: healthy, inboundId: 1, saved: true });
    expect(first.results[1]).toMatchObject({ serverId: conflict, saved: false });
    expect(first.results[1].error).toContain('listener ports');
    expect((await document(healthy)).state.inbounds).toHaveLength(1);
    const freed = reduceDocument(await document(conflict), { path: '/panel/api/inbounds/del/1', method: 'POST' }).document;
    await saveManaged(env, (await managedRow(env, conflict))!, freed);
    const retried = await deploy(id, [healthy, conflict]);
    expect(retried.results).toEqual([{ serverId: healthy, inboundId: 1, saved: true }, { serverId: conflict, inboundId: 2, saved: true }]);
    expect((await document(healthy)).state.inbounds).toHaveLength(1);
    expect((await document(conflict)).state.inbounds).toHaveLength(1);
    expect(remote).not.toHaveBeenCalled();
  });
  it('keeps server-specific logical IDs while saving the same new configuration', async () => {
    const first = await profile('Empty'), second = await profile('Existing listener');
    await saveManaged(env, (await managedRow(env, second))!, reduceDocument(await document(second), { path: '/panel/api/inbounds/add', method: 'POST', body: listener(8443) }).document);
    const result = await deploy(crypto.randomUUID(), [first, second], listener(), 1.5);
    expect(result.results.map(r => r.inboundId)).toEqual([1, 2]);
    expect((await document(first)).policy.inboundMultipliers).toEqual({ 1: 1.5 });
    expect((await document(second)).policy.inboundMultipliers).toEqual({ 2: 1.5 });
    expect((await document(second)).state.clients.alice.inboundIds).toEqual([1, 2]);
  });
  it('rejects a stale revision and an active apply lease without altering saved configuration', async () => {
    const id = await profile('Lease protected'), original = (await managedRow(env, id))!, first = await document(id);
    const updated = reduceDocument(first, { path: '/panel/api/inbounds/add', method: 'POST', body: listener() }).document;
    await saveManaged(env, original, updated);
    await expect(saveManaged(env, original, emptyDocument())).rejects.toMatchObject({ status: 409 });
    const current = (await managedRow(env, id))!;
    db.prepare('UPDATE managed_state SET lease=?,lease_until=? WHERE server_id=?').run('active-apply', Date.now() + 60000, id);
    await expect(saveManaged(env, current, emptyDocument())).rejects.toMatchObject({ status: 409 });
    expect((await document(id)).state.inbounds).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM managed_versions WHERE server_id=?').get(id)).toEqual({ n: 2 });
  });
  it('never stores credentials or listener secrets as plaintext in saved versions', async () => {
    const id = await profile('Encrypted recovery');
    await deploy(crypto.randomUUID(), [id]);
    const rows = db.prepare('SELECT document FROM managed_versions WHERE server_id=?').all(id) as { document: string }[];
    expect(rows).toHaveLength(2);
    for (const row of rows) { expect(row.document).not.toContain('portable-client-password'); expect(row.document).not.toContain('portable-subscription'); expect(row.document).not.toContain('11111111-1111'); }
    expect((await document(id)).state.clients.alice.password).toBe('portable-client-password');
  });
  it('retains panel node selection in a singleton deployment', async () => {
    const id = crypto.randomUUID(), d: ManagedDocument = emptyDocument(); d.mode = 'panel'; d.setup.panel = '3x-ui'; d.setup.cores = []; d.setup.bbr = false;
    d.nodes = [{ id: 7, name: 'Imported node' }];
    db.prepare("INSERT INTO servers(id,name,url,version,kind,auth,credentials,enabled,created_at) VALUES(?,?,'https://panel.example.com/','v3','panel','token',?,0,0)").run(id, 'Panel with nodes', await encrypt({ token: 'panel-token' }, env.ENCRYPTION_KEY));
    await createManaged(env, id, d, 0);
    const result = await deploy(crypto.randomUUID(), [id], { ...listener(), nodeId: 7 });
    expect(result.results[0].saved).toBe(true);
    expect((await document(id)).state.inbounds[0].nodeId).toBe(7);
    expect(remote).not.toHaveBeenCalled();
  });
  it('keeps a deployment manifest immutable while accepting retries with canonical key and server order', async () => {
    const first = await profile('First'), second = await profile('Second'), id = crypto.randomUUID(), inbound = listener();
    await deploy(id, [first, second], inbound);
    const reordered = Object.fromEntries(Object.entries(inbound).reverse());
    expect((await deploy(id, [second, first], reordered)).results.every(r => r.saved)).toBe(true);
    await expect(deploy(id, [first, second], { ...inbound, port: 8443 })).rejects.toMatchObject({ status: 409 });
    await expect(deploy(id, [first, second], inbound, 3)).rejects.toMatchObject({ status: 409 });
    await expect(deploy(id, [first], inbound)).rejects.toMatchObject({ status: 409 });
    expect((await document(first)).state.inbounds).toHaveLength(1); expect((await document(second)).state.inbounds).toHaveLength(1);
  });
});
