import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/ssh', () => ({ agentOverSSH: vi.fn() }));
vi.mock('../worker/security', async original => ({ ...await original<typeof import('../worker/security')>(), decrypt: vi.fn(), verifyPublicDns: vi.fn() }));
import { callRemote, type StoredServer } from '../worker/remote';
import { agentOverSSH } from '../worker/ssh';
import { decrypt } from '../worker/security';

const env = { ENCRYPTION_KEY: 'test-only' } as Env;
const input = { method: 'GET', path: '/panel/api/server/status' };
beforeEach(() => { vi.clearAllMocks(); vi.mocked(decrypt).mockResolvedValue({ token: 'test-only', ssh: {} }); });
afterEach(() => vi.unstubAllGlobals());
describe('Remote authentication isolation', () => {
  it.each([401, 403])('maps direct HTTPS upstream %s to 502', async status => {
    const server = { enabled: 1, kind: 'server', auth: 'token', version: 'v3', url: 'https://agent.example.com/', credentials: 'test' } as StoredServer;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('Denied', { status })));
    await expect(callRemote(server, env, input)).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 403])('maps private agent upstream %s to 502', async status => {
    const server = { enabled: 1, kind: 'server', version: 'v3', url: 'ssh://203.0.113.1:22/', credentials: 'test' } as StoredServer;
    vi.mocked(agentOverSSH).mockResolvedValue(new Response('Denied', { status }));
    await expect(callRemote(server, env, input)).rejects.toMatchObject({ status: 502 });
  });
  it.each([401, 403])('maps installed panel upstream %s to 502', async status => {
    const server = { enabled: 1, kind: 'panel', version: 'v3', url: 'ssh://203.0.113.1:22/', credentials: 'test' } as StoredServer;
    vi.mocked(decrypt).mockResolvedValue({ token: 'test-only', ssh: {}, installedPanel: true });
    vi.mocked(agentOverSSH).mockResolvedValue(new Response(JSON.stringify({ success: true, obj: { status, contentType: 'text/html', body: '' } })));
    await expect(callRemote(server, env, input)).rejects.toMatchObject({ status: 502 });
  });
});
