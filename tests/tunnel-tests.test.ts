import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { stepTunnelTest, tunnelTestsRoute } from '../worker/tunnel-tests';
import { encrypt, decrypt } from '../worker/security';
const remote = vi.mocked(callRemoteJson), id = '11111111-1111-4111-8111-111111111111';
let db: DatabaseSync, env: Env;
function database(): D1Database { return { prepare(sql: string) { let args: SQLInputValue[] = []; return { bind(...v: SQLInputValue[]) { args = v; return this; }, async first() { return db.prepare(sql).get(...args) ?? null; }, async all() { return { results: db.prepare(sql).all(...args) }; }, async run() { return { success: true, meta: { changes: db.prepare(sql).run(...args).changes } }; } }; } } as unknown as D1Database; }
async function seed(method = 'wireguard') {
  const peers = ['source', 'target'].map(id => ({ id, name: id, kind: 'server', enabled: 1, credentials: 'PRIVATE-SSH-CREDENTIALS', url: `ssh://${id}.example.com:22/` }));
  const input = { name: 'test', sourceId: 'source', targetId: 'target', method, sourceHost: '1.1.1.1', targetHost: '8.8.8.8', port: 40001, listenPort: 40002, destinationPort: 40003, destinationHost: '127.0.0.1', subnet: '10.254.13.0/30' };
  await env.DB.prepare('INSERT INTO tunnel_tests(id,source_id,target_id,data,updated_at,created_at) VALUES(?,?,?,?,0,0)').bind(id, 'source', 'target', await encrypt({ input, peers, methods: [method], byteLimit: 65536 }, env.ENCRYPTION_KEY)).run();
}
const row = () => db.prepare('SELECT * FROM tunnel_tests').get()!;
beforeEach(() => {
  db = new DatabaseSync(':memory:'); for (const file of readdirSync('migrations').filter(f => f.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + file, 'utf8'));
  env = { DB: database(), ENCRYPTION_KEY: btoa('k'.repeat(32)) } as Env;
  for (const id of ['source', 'target']) db.prepare("INSERT INTO servers(id,name,url,auth,credentials,kind,created_at) VALUES(?,?,?,'token','secret','server',0)").run(id, id, `ssh://${id}.example.com:22/`);
  remote.mockReset(); remote.mockImplementation(async (_s, _e, req) => {
    if (req.path.endsWith('/capabilities')) return { features: ['tunnel-tests'] };
    if (req.path.endsWith('/prepare')) return { publicKey: 'PEER' };
    if (req.path.endsWith('/commit')) return { state: 'running' };
    if (req.path.endsWith('/test-start')) return { ready: true };
    if (req.path.endsWith('/test-run')) return { state: 'passed', message: 'Verified', uploadMbps: 50, downloadMbps: 45, latencyMs: 20, lossPercent: 0, bytes: 131072, scope: 'Selected VPS pair' };
    if (req.path.endsWith('/test-stop')) return { stopped: true };
    if (req.path.endsWith('/remove')) return { removed: true };
    throw new Error('Unexpected call');
  });
});
afterEach(() => db.close());
describe('Durable tunnel comparison', () => {
  it('queues a comparison atomically and rejects another comparison on the same peers', async () => {
    const base = remote.getMockImplementation()!;
    remote.mockImplementation(async (...args) => args[2].path.endsWith('/prepare') ? { pending: true } : base(...args));
    const input = { name: 'test', sourceId: 'source', targetId: 'target', method: 'wireguard', sourceHost: '1.1.1.1', targetHost: '8.8.8.8', port: 40001, listenPort: 40002, destinationPort: 40003, destinationHost: '127.0.0.1', subnet: '10.254.13.0/30' };
    const pending: Promise<unknown>[] = [], ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext;
    const request = () => new Request('https://benx.example/api/tunnel-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, methods: ['wireguard'] }) });
    expect((await tunnelTestsRoute(request(), env, ctx)).status).toBe(202);
    await Promise.all(pending);
    await expect(tunnelTestsRoute(request(), env, ctx)).rejects.toThrow('existing comparison');
    expect(row().data).not.toContain('1.1.1.1');
  });
  it('does not queue resources while a server profile is leased for replacement or synchronization', async () => {
    db.prepare("INSERT INTO managed_state(server_id,document,revision,updated_at,lease_until) VALUES('source','encrypted',1,0,?)").run(Date.now() + 60000);
    const input = { name: 'test', sourceId: 'source', targetId: 'target', method: 'wireguard', sourceHost: '1.1.1.1', targetHost: '8.8.8.8', port: 40001, listenPort: 40002, destinationPort: 40003, destinationHost: '127.0.0.1', subnet: '10.254.13.0/30' };
    await expect(tunnelTestsRoute(new Request('https://benx.example/api/tunnel-tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, methods: ['wireguard'] }) }), env, { waitUntil: vi.fn() } as unknown as ExecutionContext)).rejects.toThrow('changing');
    expect(db.prepare('SELECT COUNT(*) AS n FROM tunnel_tests').get()!.n).toBe(0);
    expect(remote).not.toHaveBeenCalled();
  });
  it('records real adapter output, uses the tunnel path and confirms both cleanups', async () => {
    await seed(); expect(row().data).not.toContain('PRIVATE-SSH-CREDENTIALS'); await stepTunnelTest(env, id);
    expect(row().state).toBe('completed'); expect(JSON.parse(row().results as string)[0]).toMatchObject({ method: 'wireguard', uploadMbps: 50, cleanup: 'Confirmed on both servers' });
    expect(remote.mock.calls.find(c => c[2].path.endsWith('/test-run'))![0].id).toBe('source'); expect(remote.mock.calls.filter(c => c[2].path.endsWith('/remove'))).toHaveLength(2);
  });
  it('probes Backhaul reverse forwards from the target to the source',async()=>{
    await seed('backhaul-tcpmux');await stepTunnelTest(env,id);
    expect(row().state).toBe('completed');
    expect(remote.mock.calls.find(c=>c[2].path.endsWith('/test-start'))![0].id).toBe('source');
    expect(remote.mock.calls.find(c=>c[2].path.endsWith('/test-run'))![0].id).toBe('target');
  });
  it('retries cleanup against stored original endpoints before calling another test', async () => {
    await seed(); let broken = true;
    const base = remote.getMockImplementation()!;
    remote.mockImplementation(async (...args) => { if (broken && args[2].path.endsWith('/remove') && args[0].id === 'target') throw new Error('Offline secret'); return base(...args); });
    await stepTunnelTest(env, id); expect(row().state).toBe('cleanup-required'); expect(row().error).not.toContain('Offline secret');
    db.prepare("UPDATE servers SET url='ssh://new.example.com:22/' WHERE id='target'").run(); broken = false; remote.mockClear(); await stepTunnelTest(env, id);
    expect(row().state).toBe('completed'); expect(remote.mock.calls.filter(c => c[2].path.endsWith('/test-run'))).toHaveLength(0); expect(remote.mock.calls.find(c => c[0].id === 'target')![0].url).toBe('ssh://target.example.com:22/');
  });
  it('keeps installation pending and reuses the same disposable resource identity on retry', async () => {
    await seed('phormal-relay'); const base = remote.getMockImplementation()!;
    remote.mockImplementation(async (...args) => args[2].path.endsWith('/prepare') ? { pending: true } : base(...args));
    await stepTunnelTest(env, id); const saved = await decrypt<{ current: { id: string } }>(row().data as string, env.ENCRYPTION_KEY); expect(row().state).toBe('running'); expect(JSON.parse(row().results as string)).toEqual([]);
    remote.mockImplementation(base); remote.mockClear(); await stepTunnelTest(env, id); expect(remote.mock.calls.find(c => c[2].path.endsWith('/prepare'))![2].path).toContain(saved.current.id); expect(row().state).toBe('completed');
  });
  it('rejects a passed result without the requested bytes in both directions and still cleans up', async () => {
    await seed('ssh-direct'); const base = remote.getMockImplementation()!;
    remote.mockImplementation(async (...args) => args[2].path.endsWith('/test-run') ? {state: 'passed', bytes: 0} : base(...args));
    await stepTunnelTest(env, id);
    expect(JSON.parse(row().results as string)[0]).toMatchObject({state: 'failed', cleanup: 'Confirmed on both servers'});
  });
  it.each([
    ['wireguard', 'target', 'source'], ['ssh-direct', 'target', 'source'], ['ssh-reverse', 'source', 'target'],
    ['frp-tls', 'source', 'target'], ['frp-wss', 'source', 'target'],
  ])('measures %s in the forwarding direction and confirms cleanup', async (method, responder, initiator) => {
    await seed(method); await stepTunnelTest(env, id);
    expect(remote.mock.calls.find(c => c[2].path.endsWith('/test-start'))![0].id).toBe(responder);
    expect(remote.mock.calls.find(c => c[2].path.endsWith('/test-run'))![0].id).toBe(initiator);
    expect(JSON.parse(row().results as string)[0]).toMatchObject({state: 'passed', cleanup: 'Confirmed on both servers'});
  });
  it('uses an explicit authenticated public target probe for Hedioum', async () => {
    await seed('hedioum'); await stepTunnelTest(env, id);
    expect(row().state).toBe('running'); expect(remote.mock.calls.some(c => c[2].path.endsWith('/test-run'))).toBe(false);
    const saved = await decrypt<{ current: { id: string; warmupUntil: number } }>(row().data as string, env.ENCRYPTION_KEY);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(saved.current.warmupUntil + 1);
    try { await stepTunnelTest(env, id); } finally { clock.mockRestore(); }
    expect(row().state).toBe('completed');
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/prepare')).every(c => c[2].path.includes(saved.current.id))).toBe(true);
    expect(remote.mock.calls.find(c => c[2].path.endsWith('/test-start'))![2].body).toMatchObject({ publicProbe: true });
  });
});
