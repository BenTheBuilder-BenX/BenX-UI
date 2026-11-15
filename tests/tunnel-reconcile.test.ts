import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { reconcileTunnels, tunnelsRoute, type TunnelInput, type TunnelRow } from '../worker/tunnels';
let db: DatabaseSync, env: Env;
const remote = vi.mocked(callRemoteJson), tunnelId = '11111111-1111-4111-8111-111111111111';
const input: TunnelInput = { name: 'Recovery pair', sourceId: 'source', targetId: 'target', method: 'wireguard', sourceHost: '1.1.1.1', targetHost: '8.8.8.8', port: 51830, listenPort: 1080, destinationHost: '127.0.0.1', destinationPort: 443, subnet: '10.83.0.0/30' };
function database(db: DatabaseSync): D1Database {
  return { prepare(sql: string) { let values: SQLInputValue[] = []; return { bind(...args: SQLInputValue[]) { values = args; return this; }, async first() { return db.prepare(sql).get(...values) ?? null; }, async all() { return { results: db.prepare(sql).all(...values) }; }, async run() { return { success: true, meta: db.prepare(sql).run(...values) }; } }; } } as unknown as D1Database;
}
function saved(state = 'configured', extra: Record<string, unknown> = {}) {
  db.prepare('INSERT INTO tunnels(id,source_id,target_id,state,data,updated_at) VALUES(?,?,?,?,?,0)').run(tunnelId, 'source', 'target', state, JSON.stringify({ ...input, _benxEndpoints: { source: '1.1.1.1', target: '8.8.8.8' }, _benxRekey: false, ...extra }));
}
function row() { return db.prepare('SELECT * FROM tunnels WHERE id=?').get(tunnelId) as unknown as TunnelRow; }
function workingRemote() {
  remote.mockImplementation(async (server, _env, request) => {
    if (request.path.endsWith('/capabilities')) return { features: ['tunneling'] };
    if (request.path.endsWith('/status')) return { state: 'running', connected: true };
    if (request.path.endsWith('/prepare')) return { publicKey: `public-${server.id}`, user: 'generated-target-user' };
    if (request.path.endsWith('/commit')) return { state: 'running', connected: true };
    if (request.path.endsWith('/remove')) return { removed: true };
    throw new Error('Unexpected request');
  });
}
beforeEach(() => {
  db = new DatabaseSync(':memory:');
  for (const name of readdirSync('migrations').filter(n => n.endsWith('.sql')).sort()) db.exec(readFileSync('migrations/' + name, 'utf8'));
  env = { DB: database(db) } as Env;
  for (const [id, host] of [['source', '1.1.1.1'], ['target', '8.8.8.8']]) db.prepare("INSERT INTO servers(id,name,url,kind,auth,credentials,created_at) VALUES(?,?,?,'server','token','encrypted',0)").run(id, id, `ssh://${host}:22/`);
  remote.mockReset(); workingRemote();
});
afterEach(() => db.close());

describe('Durable paired tunnel reconciliation', () => {
  it('rejects retired methods for new setup while retaining their historical cleanup path', async () => {
    await expect(tunnelsRoute(new Request('https://benx.example/api/tunnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, method: 'gre' }) }), env)).rejects.toMatchObject({ status: 400 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM tunnels').get()!.n).toBe(0);
    expect(remote).not.toHaveBeenCalled();
  });
  it('rejects an already reserved private subnet before changing either endpoint', async () => {
    saved();
    await expect(tunnelsRoute(new Request('https://benx.example/api/tunnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), env)).rejects.toMatchObject({ status: 409 });
    expect(remote).not.toHaveBeenCalled();
  });
  it('checks healthy endpoints without removing services or rotating their existing keys', async () => {
    saved(); await reconcileTunnels(env); await reconcileTunnels(env);
    expect(remote.mock.calls.map(c => c[2].path.split('/').at(-1))).toEqual(['status', 'status', 'status', 'status']);
    expect(row()).toMatchObject({ state: 'configured', desired_state: 'configured', lease: null, lease_until: 0, error: '' });
  });
  it('re-pairs both endpoints after replacement and updates the old public IP to the logical server’s new SSH host', async () => {
    saved('pending'); db.prepare("UPDATE servers SET url='ssh://9.9.9.9:22/' WHERE id='source'").run();
    await reconcileTunnels(env);
    const calls = remote.mock.calls;
    expect(calls.filter(c => c[2].path.endsWith('/remove')).map(c => c[0].id).sort()).toEqual(['source', 'target']);
    const prepares = calls.filter(c => c[2].path.endsWith('/prepare'));
    expect(prepares).toHaveLength(2); expect(prepares[0][0].url).toBe('ssh://9.9.9.9:22/');
    expect(prepares[1][2].body?.peerHost).toBe('9.9.9.9');
    expect(calls.filter(c => c[2].path.endsWith('/commit')).map(c => c[0].id)).toEqual(['target', 'source']);
    expect(JSON.parse(row().data)).toMatchObject({ sourceHost: '9.9.9.9', _benxRekey: false });
    expect(row().state).toBe('configured');
    remote.mockClear(); await reconcileTunnels(env); expect(remote).toHaveBeenCalledTimes(2);
  });
  it('preserves custom public DNS names when an SSH destination changes', async () => {
    saved('pending', { sourceHost: 'vpn.example.com' }); db.prepare("UPDATE servers SET url='ssh://9.9.9.9:22/' WHERE id='source'").run();
    await reconcileTunnels(env);
    expect(JSON.parse(row().data).sourceHost).toBe('vpn.example.com');
    expect(remote.mock.calls.find(c => c[0].id === 'target' && c[2].path.endsWith('/prepare'))?.[2].body?.peerHost).toBe('vpn.example.com');
  });
  it('keeps a legacy custom interface IP during ordinary checks and updates an old IP only when replacement is pending', async () => {
    saved('configured', { sourceHost: '5.5.5.5', _benxEndpoints: undefined });
    await reconcileTunnels(env);
    expect(JSON.parse(row().data).sourceHost).toBe('5.5.5.5'); expect(remote).toHaveBeenCalledTimes(2);
    db.prepare('UPDATE tunnels SET state=?,data=? WHERE id=?').run('pending', JSON.stringify({ ...input }), tunnelId);
    db.prepare("UPDATE servers SET url='ssh://9.9.9.9:22/' WHERE id='source'").run(); remote.mockClear();
    await reconcileTunnels(env);
    expect(JSON.parse(row().data).sourceHost).toBe('9.9.9.9');
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/prepare'))).toHaveLength(2);
  });
  it('repairs an absent endpoint using cleanup and a new paired prepare/commit sequence', async () => {
    saved(); const normal = remote.getMockImplementation()!;
    remote.mockImplementation((server, e, request) => request.path.endsWith('/status') && server.id === 'source' ? Promise.resolve({ state: 'absent', connected: false }) : normal(server, e, request));
    await reconcileTunnels(env);
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/remove'))).toHaveLength(2);
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/prepare'))).toHaveLength(2);
    expect(row().state).toBe('configured');
  });
  it('retains existing keys when both services run but WireGuard has no recent handshake', async () => {
    saved(); remote.mockResolvedValue({ state: 'running', connected: false });
    await reconcileTunnels(env); await reconcileTunnels(env);
    expect(row().state).toBe('failed'); expect(row().error).toContain('handshake');
    expect(remote.mock.calls.every(c => c[2].method === 'GET' && c[2].path.endsWith('/status'))).toBe(true);
    expect(JSON.parse(row().data)._benxRekey).toBe(false);
  });
  it('does not mutate the healthy endpoint while the other server is unreachable', async () => {
    saved(); remote.mockImplementation(async (server, _env, request) => { if (server.id === 'target') throw new Error('Peer offline'); if (request.path.endsWith('/status')) return { state: 'running', connected: true }; throw new Error('Unexpected mutation'); });
    await reconcileTunnels(env);
    expect(row().state).toBe('failed'); expect(remote.mock.calls.every(c => c[2].method === 'GET')).toBe(true);
    remote.mockClear(); workingRemote(); await reconcileTunnels(env);
    expect(row().state).toBe('configured'); expect(remote).toHaveBeenCalledTimes(2);
  });
  it('saves removal before remote changes and retries unreachable cleanup without recreating the tunnel', async () => {
    saved(); remote.mockImplementation(async server => { expect(row().desired_state).toBe('removed'); expect(row().state).toBe('removing'); if (server.id === 'target') throw new Error('offline'); return { removed: true }; });
    await expect(tunnelsRoute(new Request(`https://benx.example/api/tunnels/${tunnelId}`, { method: 'DELETE' }), env)).rejects.toThrow('removal remains saved');
    expect(row()).toMatchObject({ desired_state: 'removed', state: 'cleanup-required', lease: null });
    remote.mockClear(); workingRemote(); await reconcileTunnels(env);
    expect(row()).toMatchObject({ state: 'removed', desired_state: 'removed', error: '' });
    expect(remote.mock.calls.every(c => c[2].path.endsWith('/remove'))).toBe(true);
  });
  it('keeps cleanup pending when an agent returns no explicit removal confirmation', async () => {
    saved(); remote.mockResolvedValue({ removed: false });
    await expect(tunnelsRoute(new Request(`https://benx.example/api/tunnels/${tunnelId}`, { method: 'DELETE' }), env)).rejects.toThrow('removal remains saved');
    expect(row()).toMatchObject({ desired_state: 'removed', state: 'cleanup-required' });
  });
  it('prevents concurrent schedulers from working on the same tunnel and skips active leases', async () => {
    saved(); await Promise.all([reconcileTunnels(env), reconcileTunnels(env)]);
    expect(remote).toHaveBeenCalledTimes(2);
    remote.mockClear(); db.prepare('UPDATE tunnels SET lease=?,lease_until=? WHERE id=?').run('another-worker', Date.now() + 60000, tunnelId);
    await reconcileTunnels(env); expect(remote).not.toHaveBeenCalled(); expect(row().lease).toBe('another-worker');
  });
  it('keeps a failed creation as desired configuration and cleans both partial endpoints before retrying', async () => {
    const normal = remote.getMockImplementation()!;
    remote.mockImplementation(async (server, e, request) => { expect(db.prepare('SELECT COUNT(*) AS n FROM tunnels').get()).toEqual({ n: 1 }); if (server.id === 'target' && request.path.endsWith('/commit')) throw new Error('failed start'); return normal(server, e, request); });
    await expect(tunnelsRoute(new Request('https://benx.example/api/tunnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), env)).rejects.toThrow('prepared resources were removed');
    const failed = db.prepare('SELECT * FROM tunnels').get() as unknown as TunnelRow;
    expect(failed).toMatchObject({ state: 'failed', desired_state: 'configured', lease: null }); expect(JSON.parse(failed.data)._benxRekey).toBe(true);
    remote.mockClear(); workingRemote(); await reconcileTunnels(env);
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/remove'))).toHaveLength(2);
    expect((db.prepare('SELECT state FROM tunnels').get() as { state: string }).state).toBe('configured');
  });
  it('does not mark a paired tunnel configured when one agent commits a stopped service', async () => {
    saved('pending'); const normal = remote.getMockImplementation()!;
    remote.mockImplementation((server, e, request) => request.path.endsWith('/commit') && server.id === 'target' ? Promise.resolve({ state: 'stopped', connected: false }) : normal(server, e, request));
    await reconcileTunnels(env);
    expect(row()).toMatchObject({ state: 'failed', desired_state: 'configured' });
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/commit'))).toHaveLength(1);
    expect(remote.mock.calls.filter(c => c[2].path.endsWith('/remove'))).toHaveLength(4);
  });
});
