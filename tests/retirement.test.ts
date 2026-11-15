import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { cleanupRetiredServers } from '../worker/retirement';
import { decrypt, encrypt } from '../worker/security';

const key = btoa('k'.repeat(32));
let db: DatabaseSync, env: Env, current: StoredServer, previous: StoredServer;
const remote = vi.mocked(callRemoteJson);
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { const result = db.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; } }; } } as unknown as D1Database;
}
function retired() { return db.prepare("SELECT * FROM retired_servers WHERE id='old-vps'").get() as { state: string; connection: string; error: string }; }
beforeEach(async () => {
  db = new DatabaseSync(':memory:'); for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db), ENCRYPTION_KEY: key } as Env;
  db.prepare("INSERT INTO servers(id,name,url,version,kind,auth,credentials,created_at) VALUES('s','Replaced server','ssh://2.2.2.2:22/','v3','server','token',?,0)").run(await encrypt({ token: 'new-agent-token', ssh: { username: 'root', password: 'new-ssh-password' } }, key));
  current = db.prepare("SELECT * FROM servers WHERE id='s'").get() as unknown as StoredServer;
  previous = { ...current, url: 'ssh://1.1.1.1:22/', enabled: 0, credentials: await encrypt({ token: 'previous-agent-token', ssh: { username: 'root', password: 'previous-ssh-password' } }, key) };
  db.prepare("INSERT INTO retired_servers(id,server_id,connection,created_at,updated_at) VALUES('old-vps','s',?,0,0)").run(await encrypt(previous, key)); remote.mockReset();
});
afterEach(() => { db.close(); remote.mockReset(); });

describe('Replaced VPS retirement queue', () => {
  it('retains the previous encrypted connection and retires that identity after the active server changed', async () => {
    const pending = retired(); expect(pending.connection).not.toContain('previous-agent-token'); expect(pending.connection).not.toContain('previous-ssh-password'); expect(pending.connection).not.toContain(previous.url);
    const restored = await decrypt<StoredServer>(pending.connection, key); expect(restored).toEqual(previous); expect(await decrypt(restored.credentials, key)).toMatchObject({ token: 'previous-agent-token' });
    remote.mockResolvedValue({ retired: true }); await cleanupRetiredServers(env);
    expect(remote).toHaveBeenCalledWith({ ...previous, enabled: 1 }, env, { path: '/benx/v1/control/retire', method: 'POST', body: { serverId: 's' } });
    expect(retired()).toMatchObject({ state: 'retired', error: '', connection: pending.connection });
    expect(db.prepare("SELECT * FROM servers WHERE id='s'").get()).toEqual(current);
  });
  it('keeps unreachable cleanup pending, retries the prior identity, and waits for explicit retirement confirmation', async () => {
    const identity = retired().connection;
    remote.mockRejectedValueOnce(new Error('Unreachable old VPS: previous-agent-token')); await cleanupRetiredServers(env);
    expect(retired()).toMatchObject({ state: 'pending', connection: identity }); expect(retired().error).toContain('Cleanup will retry'); expect(retired().error).not.toContain('previous-agent-token');
    remote.mockResolvedValueOnce({ retired: false }); await cleanupRetiredServers(env); expect(retired()).toMatchObject({ state: 'pending', connection: identity });
    remote.mockResolvedValueOnce({ state: 'accepted' }); await cleanupRetiredServers(env); expect(retired().state).toBe('pending');
    remote.mockResolvedValueOnce({ retired: true }); await cleanupRetiredServers(env); expect(retired()).toMatchObject({ state: 'retired', error: '' });
    expect(remote).toHaveBeenCalledTimes(4); expect(remote.mock.calls.every(c => c[0].url === previous.url && c[0].credentials === previous.credentials)).toBe(true);
    await cleanupRetiredServers(env); expect(remote).toHaveBeenCalledTimes(4); expect(db.prepare("SELECT credentials FROM servers WHERE id='s'").get()).toEqual({ credentials: current.credentials });
  });
});
