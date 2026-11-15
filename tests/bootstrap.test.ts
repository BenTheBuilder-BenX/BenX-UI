import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/ssh', async importOriginal => ({ ...await importOriginal<typeof import('../worker/ssh')>(), connectSSH: vi.fn(), sshExec: vi.fn(), fingerprintSSH: vi.fn() }));
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { connectSSH, managementPublicKey, sshExec } from '../worker/ssh';
import { callRemoteJson, type StoredServer } from '../worker/remote';
import { bootstrapRoute, syncInstalledPanel } from '../worker/bootstrap';
import { decrypt, encrypt } from '../worker/security';
import { defaultSetup } from '../shared/setup';
let db: DatabaseSync, env: Env;
const closed = vi.fn(), ssh = { host: '1.1.1.1', port: 22, username: 'root', password: 'root-secret-do-not-store', fingerprint: 'SHA256:' + 'a'.repeat(43) };
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async run() { const meta = db.prepare(sql).run(...values); return { success: true, meta: { changes: meta.changes } }; } }; }, async batch(statements: Array<{ run: () => Promise<unknown> }>) { return Promise.all(statements.map(s => s.run())); } } as unknown as D1Database;
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as Env;
  vi.mocked(connectSSH).mockResolvedValue({ end: closed } as unknown as Awaited<ReturnType<typeof connectSSH>>);
  vi.mocked(sshExec).mockResolvedValue('started'); closed.mockClear();
});
afterEach(() => { db.close(); vi.clearAllMocks(); });
const request = (path: string, method = 'POST', body?: unknown) => new Request('https://benx.example.com/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
describe('Durable server bootstrap', () => {
  it('uses root login only transiently and saves a restricted management key', async () => {
    const result = await bootstrapRoute(request('/bootstrap', 'POST', { name: 'My VPS', ssh, plan: defaultSetup }), env);
    expect(result.status).toBe(201);
    const row = db.prepare('SELECT * FROM servers').get() as unknown as StoredServer;
    const credentials = await decrypt<{ token: string; ssh: { privateKey: string; password?: string } }>(row.credentials, env.ENCRYPTION_KEY);
    expect(credentials.ssh.privateKey).toContain('OPENSSH PRIVATE KEY');
    expect(JSON.stringify(credentials)).not.toContain(ssh.password);
    expect(credentials.token.length).toBeGreaterThan(32);
    expect(row.url).toBe('ssh://1.1.1.1:22/'); expect(row.enabled).toBe(0);
    expect(closed).toHaveBeenCalled();
    expect(db.prepare('SELECT state FROM bootstrap_jobs').get()).toEqual({ state: 'queued' });
  });
  it('does not save a connection when preflight fails', async () => {
    vi.mocked(sshExec).mockRejectedValueOnce(new Error('Unsupported OS'));
    await expect(bootstrapRoute(request('/bootstrap', 'POST', { name: 'My VPS', ssh, plan: defaultSetup }), env)).rejects.toThrow('Unsupported OS');
    expect(db.prepare('SELECT COUNT(*) AS n FROM servers').get()).toEqual({ n: 0 });
    expect(closed).toHaveBeenCalled();
  });
  it('does not report bootstrap success when SSH closes without its installation acknowledgement', async () => {
    vi.mocked(sshExec).mockResolvedValueOnce('Ubuntu 24.04 LTS').mockResolvedValueOnce('');
    await expect(bootstrapRoute(request('/bootstrap', 'POST', { name: 'Missing bootstrap', ssh, plan: defaultSetup }), env)).rejects.toThrow('did not confirm the bootstrap');
    expect(db.prepare('SELECT state FROM bootstrap_jobs').get()).toEqual({state:'failed'});
  });
  it('retries an unwritten bootstrap with the same saved management identity and token', async () => {
    vi.mocked(sshExec).mockResolvedValueOnce('Ubuntu 24.04 LTS').mockResolvedValueOnce('');
    await expect(bootstrapRoute(request('/bootstrap', 'POST', { name: 'Retry VPS', ssh, plan: defaultSetup }), env)).rejects.toThrow('did not confirm');
    const row = db.prepare('SELECT * FROM servers').get() as unknown as StoredServer;
    const before = await decrypt<{ token: string; ssh: { privateKey: string } }>(row.credentials, env.ENCRYPTION_KEY);
    vi.mocked(sshExec).mockResolvedValueOnce('started');
    await bootstrapRoute(request(`/bootstrap/${row.id}/retry`, 'POST', ssh), env);
    const script = vi.mocked(sshExec).mock.calls.at(-1)![2]!;
    expect(script.includes(managementPublicKey(before.ssh.privateKey))).toBe(true);
    expect(script.includes(btoa(`BENX_AGENT_TOKEN=${before.token}\n`))).toBe(true);
    expect(script).toContain('install.sh; then');
    expect(db.prepare('SELECT credentials FROM servers WHERE id=?').get(row.id)).toEqual({ credentials: row.credentials });
    expect(db.prepare('SELECT state FROM bootstrap_jobs').get()).toEqual({ state: 'queued' });
  });
  it('uses passwordless sudo for a cloud image user and restricts that user’s management key', async () => {
    await bootstrapRoute(request('/bootstrap', 'POST', { name: 'Ubuntu VPS', ssh: { ...ssh, username: 'ubuntu' }, plan: defaultSetup }), env);
    expect(vi.mocked(sshExec).mock.calls[0][1]).toBe('sudo -n /bin/sh -s');
    expect(vi.mocked(sshExec).mock.calls[1][2]).toContain('command="sudo -n /bin/cat /var/lib/benx-agent/bootstrap-status.json"');
    const row = db.prepare('SELECT credentials FROM servers').get() as { credentials: string };
    expect(await decrypt(row.credentials, env.ENCRYPTION_KEY)).toMatchObject({ ssh: { username: 'ubuntu' } });
  });
  it('exposes setup progress without leaking SSH credentials and keeps optional failures manageable', async () => {
    const response = await bootstrapRoute(request('/bootstrap', 'POST', { name: 'My VPS', ssh, plan: defaultSetup }), env);
    const { id } = await response.json() as { id: string };
    vi.mocked(sshExec).mockResolvedValue(JSON.stringify({ state: 'succeeded', message: 'Agent ready' }));
    vi.mocked(callRemoteJson).mockResolvedValue({ job: { state: 'failed', steps: [{ id: 'bbr', state: 'failed' }], message: 'Review BBR' }, panelReady: false });
    const status = await bootstrapRoute(request(`/bootstrap/${id}`, 'GET'), env);
    const json = await status.json();
    expect(json).toMatchObject({ state: 'failed', agentReady: true });
    expect(JSON.stringify(json)).not.toContain('PRIVATE KEY'); expect(JSON.stringify(json)).not.toContain(ssh.password);
    expect(db.prepare('SELECT enabled FROM servers WHERE id=?').get(id)).toEqual({ enabled: 1 });
    db.prepare('UPDATE servers SET enabled=0 WHERE id=?').run(id);
    await bootstrapRoute(request(`/bootstrap/${id}`, 'GET'), env);
    expect(db.prepare('SELECT enabled FROM servers WHERE id=?').get(id)).toEqual({ enabled: 0 });
  });
  it('creates one encrypted managed 3X-UI connection and cascades it when its VPS is removed', async () => {
    const credentials = await encrypt({ token: 'agent-secret', ssh: { ...ssh, password: undefined, privateKey: 'dedicated-key' } }, env.ENCRYPTION_KEY);
    db.prepare("INSERT INTO servers(id,name,url,kind,version,auth,credentials,created_at) VALUES('parent','VPS','ssh://1.1.1.1:22/','server','v3','token',?,0)").run(credentials);
    const parent = db.prepare("SELECT * FROM servers WHERE id='parent'").get() as unknown as StoredServer;
    await syncInstalledPanel(env, parent, true); await syncInstalledPanel(env, parent, true);
    const children = db.prepare("SELECT * FROM servers WHERE parent_id='parent'").all() as unknown as StoredServer[];
    expect(children).toHaveLength(1); expect(children[0].kind).toBe('panel');
    expect(await decrypt(children[0].credentials, env.ENCRYPTION_KEY)).toMatchObject({ installedPanel: true, token: 'agent-secret' });
    db.prepare("DELETE FROM servers WHERE id='parent'").run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM servers').get()).toEqual({ n: 0 });
  });
});
