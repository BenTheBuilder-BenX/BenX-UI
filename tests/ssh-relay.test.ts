import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relayRequest } from '../worker/relay';
const env = { SSH_RELAY_URL: 'https://primary.example/ssh', SSH_RELAY_BACKUP_URL: 'https://backup.example/ssh', SSH_RELAY_TOKEN: 'test-only-secret' };
const health = () => new Response(JSON.stringify({ success: true, obj: { ready: true } }));
beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.unstubAllGlobals());
describe('VPS SSH transport', () => {
  it('uses authenticated HTTPS and refuses redirects', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, obj: 'confirmed' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await relayRequest(env, 'exec', { command: 'true' })).toBe('confirmed');
    expect(fetcher.mock.calls[1][1]).toMatchObject({ redirect: 'manual', headers: { Authorization: 'Bearer test-only-secret' } });
  });
  it('selects the backup only after a safe health probe fails', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline')).mockResolvedValueOnce(health()).mockResolvedValueOnce(new Response(JSON.stringify({ success: true, obj: 'ok' })));
    vi.stubGlobal('fetch', fetcher);
    expect(await relayRequest(env, 'exec', {})).toBe('ok');
    expect(fetcher.mock.calls.map(c => String(c[0]))).toEqual([env.SSH_RELAY_URL, env.SSH_RELAY_BACKUP_URL, env.SSH_RELAY_BACKUP_URL]);
  });
  it('does not resend an uncertain command on the other relay', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(health()).mockRejectedValueOnce(new TypeError('connection lost'));
    vi.stubGlobal('fetch', fetcher);
    await expect(relayRequest(env, 'exec', {})).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('rejects plaintext and credential-bearing relay URLs before sending secrets', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(relayRequest({ ...env, SSH_RELAY_URL: 'http://relay.example/ssh' }, 'exec', {})).rejects.toMatchObject({ status: 503 });
    await expect(relayRequest({ ...env, SSH_RELAY_URL: 'https://user:password@relay.example/ssh' }, 'exec', {})).rejects.toMatchObject({ status: 503 });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails clearly if neither relay is healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => Promise.resolve(new Response('Unavailable', { status: 503 }))));
    await expect(relayRequest(env, 'exec', {})).rejects.toMatchObject({ status: 503 });
  });
});
