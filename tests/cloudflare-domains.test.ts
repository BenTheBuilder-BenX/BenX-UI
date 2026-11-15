import { afterEach, describe, expect, it, vi } from 'vitest';
import { domainsRoute, validateDomainIntent } from '../worker/cloudflare-domains';
const zoneId = 'a'.repeat(32), account = 'b'.repeat(32);
const env = { CF_ACCOUNT_ID: account, CF_API_TOKEN: 'test-only-token', CF_WORKER_NAME: 'benx-ui', SESSION_SECRET: 's'.repeat(40) } as Env;
const request = (route: string, body: unknown) => new Request(`https://panel.example.com/api/cloudflare/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const response = (result: unknown) => Response.json({ success: true, result });
const zone = () => response({ id: zoneId, name: 'example.com', status: 'active', account: { id: account } });
afterEach(() => vi.unstubAllGlobals());
describe('Reviewed Cloudflare domain changes', () => {
  it('checks zone boundaries and public addresses', () => {
    expect(() => validateDomainIntent({ kind: 'vps', zoneId, hostname: 'notexample.com', address: '1.1.1.1' }, 'example.com')).toThrow('selected zone');
    for (const address of ['127.0.0.1', '10.0.0.1', '::1', 'not-an-ip']) expect(() => validateDomainIntent({ kind: 'vps', zoneId, hostname: 'vpn.example.com', address }, 'example.com')).toThrow('public IPv4');
  });
  it('keeps manual setup available without any API credentials', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect(await (await domainsRoute(new Request('https://panel.example.com/api/cloudflare'), {} as Env)).json()).toMatchObject({ configured: false });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('previews without writing, signs the exact record and rejects a tampered preview', async () => {
    const fetcher = vi.fn().mockImplementation(zone); vi.stubGlobal('fetch', fetcher);
    const data = await (await domainsRoute(request('preview', { kind: 'vps', zoneId, hostname: 'VPN.Example.com', address: '1.1.1.1' }), env)).json() as { plan: unknown; intent: string };
    expect(data.plan).toMatchObject({ record: { type: 'A', name: 'vpn.example.com', content: '1.1.1.1', proxied: false } });
    expect(fetcher.mock.calls.every(c => c[1].method === 'GET')).toBe(true);
    await expect(domainsRoute(request('apply', { intent: data.intent.slice(0, -8) + 'tampered' }), env)).rejects.toMatchObject({ status: 409 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('never replaces a conflicting DNS record', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(zone()).mockResolvedValueOnce(zone()).mockResolvedValueOnce(response([{ type: 'CNAME', content: 'existing.example.net', proxied: true }])); vi.stubGlobal('fetch', fetcher);
    const data = await (await domainsRoute(request('preview', { kind: 'vps', zoneId, hostname: 'vpn.example.com', address: '1.1.1.1' }), env)).json() as { intent: string };
    await expect(domainsRoute(request('apply', { intent: data.intent }), env)).rejects.toMatchObject({ status: 409 });
    expect(fetcher.mock.calls.every(c => c[1].method === 'GET')).toBe(true);
  });
  it('creates DNS-only IPv6 and safely accepts an identical retry', async () => {
    const record = { type: 'AAAA', name: 'vpn.example.com', content: '2606:4700:4700::1111', proxied: false, ttl: 1 };
    const fetcher = vi.fn().mockResolvedValueOnce(zone()).mockResolvedValueOnce(zone()).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ id: 'record', ...record })).mockResolvedValueOnce(zone()).mockResolvedValueOnce(response([{ id: 'record', ...record }])); vi.stubGlobal('fetch', fetcher);
    const data = await (await domainsRoute(request('preview', { kind: 'vps', zoneId, hostname: 'vpn.example.com', address: record.content }), env)).json() as { intent: string };
    expect(await (await domainsRoute(request('apply', data), env)).json()).toMatchObject({ confirmed: true, unchanged: false });
    expect(JSON.parse(fetcher.mock.calls[3][1].body)).toEqual(record);
    expect(await (await domainsRoute(request('apply', data), env)).json()).toMatchObject({ unchanged: true });
    expect(fetcher.mock.calls.filter(c => c[1].method === 'POST')).toHaveLength(1);
  });
  it('rejects another account before creating a signed intent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ name: 'example.com', status: 'active', account: { id: 'c'.repeat(32) } })));
    await expect(domainsRoute(request('preview', { kind: 'worker', zoneId, hostname: 'panel.example.com' }), env)).rejects.toMatchObject({ status: 409 });
  });
  it('attaches the reviewed Worker only to an unused hostname', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(zone()).mockResolvedValueOnce(zone()).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response({ hostname: 'panel.example.com', service: 'benx-ui' })); vi.stubGlobal('fetch', fetcher);
    const data = await (await domainsRoute(request('preview', { kind: 'worker', zoneId, hostname: 'panel.example.com' }), env)).json() as { intent: string };
    expect(JSON.stringify(data)).not.toContain(env.CF_API_TOKEN);
    expect(await (await domainsRoute(request('apply', data), env)).json()).toMatchObject({ confirmed: true, hostname: 'panel.example.com' });
    expect(fetcher.mock.calls[4][0]).toBe(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/domains`);
    expect(JSON.parse(fetcher.mock.calls[4][1].body)).toEqual({ hostname: 'panel.example.com', service: 'benx-ui', enabled: true, zone_id: zoneId, zone_name: 'example.com' });
  });
  it('rejects a changed deployment after preview and never reassigns another Worker', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(zone()).mockResolvedValueOnce(zone()).mockResolvedValueOnce(zone()).mockResolvedValueOnce(response([])).mockResolvedValueOnce(response([{ hostname: 'panel.example.com', service: 'other-worker', enabled: true }])); vi.stubGlobal('fetch', fetcher);
    const data = await (await domainsRoute(request('preview', { kind: 'worker', zoneId, hostname: 'panel.example.com' }), env)).json() as { intent: string };
    await expect(domainsRoute(request('apply', data), { ...env, CF_WORKER_NAME: 'changed-worker' })).rejects.toMatchObject({ status: 409 });
    await expect(domainsRoute(request('apply', data), env)).rejects.toMatchObject({ status: 409 });
    expect(fetcher.mock.calls.every(c => c[1].method === 'GET')).toBe(true);
  });
});
