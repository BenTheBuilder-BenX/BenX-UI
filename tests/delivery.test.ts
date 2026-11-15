import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/remote', () => ({ callRemoteJson: vi.fn() }));
import { callRemoteJson } from '../worker/remote';
import { publicSubscription, subscriptionAdmin } from '../worker/subscriptions';
import { tunnelsRoute, type TunnelInput } from '../worker/tunnels';
import { encrypt } from '../worker/security';
import { newPolicy } from '../shared/policy';
const remote = vi.mocked(callRemoteJson);
afterEach(() => remote.mockReset());
const server = { id: 's', enabled: 1, kind: 'panel', version: 'v3' };
const uuid = '11111111-1111-4111-8111-111111111111';
const identity = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('subscriber-alice'))), b => b.toString(16).padStart(2, '0')).join('');
function database(select: (sql: string, values: unknown[]) => unknown) {
  const writes: Array<{ sql: string; values: unknown[] }> = [];
  const db = { prepare(sql: string) { let values: unknown[] = []; return { bind(...v: unknown[]) { values = v; return this; }, async first() { return select(sql, values); }, async all() { return { results: select(sql, values) || [] }; }, async run() { writes.push({ sql, values }); return { success: true }; } }; } } as unknown as D1Database;
  return { db, writes };
}
describe('Worker subscription delivery', () => {
  it('never exposes an outbound management identity as a customer VPN address', async () => {
    const native = { ...server, kind: 'server', url: `agent://${uuid}/` };
    const { db } = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice', identity } : sql.includes('FROM servers') ? native : null);
    const inbound = { id: 1, protocol: 'vless', port: 443, enable: true, settings: { decryption: 'none', clients: [{ email: 'alice', id: uuid }] }, streamSettings: { network: 'raw', security: 'none' } };
    remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice' }).mockResolvedValueOnce([inbound]);
    const request = () => new Request('https://benx.example.com/sub/' + 'a'.repeat(64) + '/v2box');
    await expect(publicSubscription(request(), { DB: db } as Env)).rejects.toThrow('actual VPS public host');
    remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice' }).mockResolvedValueOnce([{ ...inbound, settings: { ...inbound.settings, publicHost: 'vpn.example.com' } }]);
    expect(atob(await (await publicSubscription(request(), { DB: db } as Env)).text())).toContain('@vpn.example.com:443');
  });
  it('delivers native RAW subscriptions using the server address without exposing private backends', async () => {
    const native = { ...server, kind: 'server', url: 'ssh://203.0.113.10:22/' };
    const { db } = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice', identity } : sql.includes('FROM servers') ? native : null);
    const inbound = { id: 1, protocol: 'vless', port: 443, enable: true, settings: { decryption: 'none', clients: [{ email: 'alice', id: uuid }] }, streamSettings: { network: 'raw', security: 'none' } };
    remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice' }).mockResolvedValueOnce([inbound, { ...inbound, id: 2, excludeFromSub: true, listen: '127.0.0.1' }]);
    const response = await publicSubscription(new Request('https://benx.example.com/sub/' + 'a'.repeat(64) + '/v2box'), { DB: db } as Env);
    const decoded = atob(await response.text());
    expect(decoded.split('\n')).toHaveLength(1); expect(decoded).toContain('@203.0.113.10:443'); expect(decoded).toContain('type=tcp'); expect(decoded).toContain('encryption=none');
  });

  const url = 'https://benx.example.com/sub/' + 'a'.repeat(64) + '/singbox';
  it('checks live identity before delivering the selected app format', async () => {
    const { db } = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice', identity } : sql.includes('FROM servers') ? server : null);
    remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice', enable: true, expiryTime: 0 }).mockResolvedValueOnce([`vless://${uuid}@example.com:443?security=tls#Alice`]);
    const response = await publicSubscription(new Request(url), { DB: db } as Env), config = await response.json() as { outbounds: Array<{ type: string }> };
    expect(config.outbounds[1].type).toBe('vless'); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(remote).toHaveBeenCalledTimes(2);
  });
  it('rejects revoked, expired and service-excluded subscriptions', async () => {
    const absent = database(() => null); await expect(publicSubscription(new Request(url), { DB: absent.db } as Env)).rejects.toThrow('revoked'); expect(remote).not.toHaveBeenCalled();
    const p = newPolicy(); p.services = [{ id: 'standard', name: 'Standard', description: '', enabled: true, inbounds: [], rules: { quotaGB: 0, expiryDays: 0, ipLimit: 0, hwidLimit: 0 }, formats: ['v2ray'] }]; p.clients.alice = { serviceId: 'standard', multiplier: 1, overrides: {} };
    const excluded = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice' } : sql.includes('FROM servers') ? server : sql.includes('FROM server_policy') ? { data: JSON.stringify(p) } : null);
    await expect(publicSubscription(new Request(url), { DB: excluded.db } as Env)).rejects.toThrow('does not include'); expect(remote).not.toHaveBeenCalled();
    const expired = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice', identity } : sql.includes('FROM servers') ? server : null);
    remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice', enable: true, expiryTime: 1 }); await expect(publicSubscription(new Request(url), { DB: expired.db } as Env)).rejects.toThrow('expired'); expect(remote).toHaveBeenCalledTimes(1);
  });
  it('prevents an old access URL from reaching a recreated client identity', async () => { const { db } = database(sql => sql.includes('token_hash') ? { server_id: 's', email: 'alice', identity } : sql.includes('FROM servers') ? server : null); remote.mockResolvedValueOnce({ email: 'alice', subId: 'replacement-client', enable: true, expiryTime: 0 }); await expect(publicSubscription(new Request(url), { DB: db } as Env)).rejects.toThrow('identity changed'); expect(remote).toHaveBeenCalledTimes(1); });
  it('reuses a current share URL without rotating previously issued access', async () => {
    const key = btoa('k'.repeat(32)), secret = await encrypt('a'.repeat(64), key);
    const { db, writes } = database(() => ({ secret, identity })); remote.mockResolvedValueOnce({ email: 'alice', subId: 'subscriber-alice' });
    const response = await subscriptionAdmin(new Request('https://benx.example/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice', reuse: true }) }), { DB: db, ENCRYPTION_KEY: key } as Env, server as never);
    expect(await response.json()).toEqual({ email: 'alice', token: 'a'.repeat(64) }); expect(writes).toHaveLength(0);
  });
  it('revokes access without fetching credentials from the server', async () => { const { db, writes } = database(() => null); await subscriptionAdmin(new Request('https://benx.example/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'alice', revoke: true }) }), { DB: db } as Env, server as never); expect(writes[0].sql).toContain('DELETE'); expect(writes[0].values).toEqual(['s', 'alice']); expect(remote).not.toHaveBeenCalled(); });
});
describe('Two-server tunnel setup', () => {
  const input: TunnelInput = { name: 'Paired', sourceId: 's', targetId: 't', method: 'wireguard', sourceHost: 'source.example.com', targetHost: 'target.example.com', port: 51830, listenPort: 1080, destinationHost: '127.0.0.1', destinationPort: 443, subnet: '10.83.0.0/30' };
  it('cleans both prepared endpoints when the receiver fails to commit', async () => {
    const { db, writes } = database((sql, values) => sql.includes('SELECT data FROM tunnels') ? [] : sql.includes('FROM servers') ? { id: values[0], kind: 'server', enabled: 1 } : { n: 0 });
    remote.mockImplementation(async (_server, _env, req) => { if (req.path.endsWith('/capabilities')) return { features: ['tunneling'] }; if (req.path.endsWith('/prepare')) return { publicKey: 'public' }; if (req.path.endsWith('/commit')) throw new Error('receiver failed'); return { removed: true }; });
    await expect(tunnelsRoute(new Request('https://benx.example/api/tunnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), { DB: db } as Env)).rejects.toThrow('prepared resources were removed');
    const paths = remote.mock.calls.map(c => c[2].path); expect(paths.filter(p => p.endsWith('/remove'))).toHaveLength(2);
    const state = [...writes].reverse().find(w => w.sql.startsWith('UPDATE tunnels SET state=?'));
    expect(state?.values[0]).toBe('failed'); expect(state?.values.at(-1)).toBe('configured');
    expect(state?.values[1]).toContain('prepared resources were removed');
  });
  it('records incomplete cleanup honestly when a peer is unreachable', async () => {
    const { db, writes } = database((sql, values) => sql.includes('SELECT data FROM tunnels') ? [] : sql.includes('FROM servers') ? { id: values[0], kind: 'server', enabled: 1 } : { n: 0 });
    remote.mockImplementation(async (_server, _env, req) => { if (req.path.endsWith('/capabilities')) return { features: ['tunneling'] }; if (req.path.endsWith('/prepare')) return { publicKey: 'public' }; throw new Error('peer unavailable'); });
    await expect(tunnelsRoute(new Request('https://benx.example/api/tunnels', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }), { DB: db } as Env)).rejects.toThrow('cleanup is required');
    const state = [...writes].reverse().find(w => w.sql.startsWith('UPDATE tunnels SET state=?'));
    expect(state?.values[0]).toBe('failed'); expect(state?.values.at(-1)).toBe('configured');
    expect(state?.values[1]).toContain('cleanup is required');
    expect(JSON.parse(String(state?.values[2]))._benxRekey).toBe(true);
  });
});
