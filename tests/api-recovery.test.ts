import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, backupDownload, panelRequest } from '../src/lib/api';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('location', { pathname: '/owner/test' });
  vi.stubGlobal('window', { dispatchEvent: vi.fn() });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const json = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
describe('API recovery', () => {
  it('recovers one safe read from a Cloudflare HTML error', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response('<!DOCTYPE html><title>Error 1102</title>', { status: 500 })).mockResolvedValueOnce(json({ cpu: 3 }));
    vi.stubGlobal('fetch', fetcher);
    const result = panelRequest('test', { method: 'GET', path: '/panel/api/server/status' });
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ cpu: 3 });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
  it('reports the CPU failure without HTML or a JSON parser exception', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('<!DOCTYPE html>Error 1102', { status: 500, headers: { 'CF-Ray': 'test-ray' } }))));
    const assertion = expect(api('/servers')).rejects.toMatchObject({ code: 'worker_cpu_limit', requestId: 'test-ray' });
    await vi.runAllTimersAsync(); await assertion;
  });
  it('never replays a mutation after an uncertain HTML response', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('<!DOCTYPE html>Unavailable', { status: 502 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(panelRequest('test', { method: 'POST', path: '/panel/api/inbounds/add', body: {} })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not repeat a denied read when the gateway returns HTML', async () => {
    const fetcher = vi.fn().mockImplementation(() => new Response('Access denied', { status: 403 }));
    vi.stubGlobal('fetch', fetcher);
    const assertion = expect(api('/servers')).rejects.toMatchObject({ status: 403 });
    await vi.runAllTimersAsync();
    await assertion;
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('bounds retries for network failures', async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    vi.stubGlobal('fetch', fetcher);
    const assertion = expect(api('/servers')).rejects.toMatchObject({ code: 'connection_failed' });
    await vi.runAllTimersAsync(); await assertion;
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not expire the session for an incorrect login password', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ msg: 'Incorrect credentials' }, 401)));
    await expect(api('/login', 'POST', {})).rejects.toMatchObject({ status: 401 });
    expect(window.dispatchEvent).not.toHaveBeenCalled();
  });
  it('expires the session for a protected endpoint returning 401', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ msg: 'Sign in again' }, 401)));
    await expect(api('/servers')).rejects.toMatchObject({ status: 401 });
    expect(window.dispatchEvent).toHaveBeenCalledTimes(1);
  });
  it('rejects invalid metrics and lists instead of passing them to the page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ success: true, obj: { cpu: 'bad' } })).mockResolvedValueOnce(json({ success: true, obj: {} })));
    await expect(panelRequest('test', { method: 'GET', path: '/panel/api/server/status' })).rejects.toMatchObject({ code: 'invalid_metrics' });
    await expect(panelRequest('test', { method: 'GET', path: '/panel/api/inbounds/list' })).rejects.toMatchObject({ code: 'invalid_response' });
  });
  it('still supports binary database backups', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sqlite-data', { headers: { 'Content-Disposition': 'attachment; filename="panel.db"', 'Content-Type': 'application/octet-stream' } })));
    const backup = await backupDownload('test');
    expect(await backup.text()).toBe('sqlite-data');
  });
});
