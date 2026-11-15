import { afterEach, describe, expect, it, vi } from 'vitest';
import { authenticate, configured, decrypt, encrypt, equalSecret, assertOrigin, issueSession, isPublicIp, readLimited, validateUrl, verifyPublicDns } from '../worker/security';
import { callRemote, callRemoteJson, findOperation, formBody, type StoredServer } from '../worker/remote';
import { validateServer } from '../worker/index';
import operations from '../shared/operations.json';
import type { ServerInput } from '../shared/types';

const env = { ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'a-strong-test-password', SESSION_SECRET: '12345678901234567890123456789012', ENCRYPTION_KEY: btoa('12345678901234567890123456789012') } as Env;
const input: ServerInput = { name: 'Test', url: 'https://panel.example.com/secret/', version: 'v3', kind: 'panel', auth: 'token', token: 'test-token', location: '', subscription_url: '' };
afterEach(() => vi.unstubAllGlobals());

describe('Worker security', () => {
  it('requires new credentials when changing a panel to full-access mode on the same endpoint', async () => { const previous = await validateServer(input, env); await expect(validateServer({ ...input, kind: 'server', token: undefined }, env, previous)).rejects.toThrow('credentials'); });
  it('encrypts credentials with authenticated encryption and rejects tampering', async () => {
    const a = await encrypt({ token: 'a-private-api-token' }, env.ENCRYPTION_KEY);
    const b = await encrypt({ token: 'a-private-api-token' }, env.ENCRYPTION_KEY);
    expect(a).not.toBe(b); expect(a).not.toContain('a-private');
    expect(await decrypt(a, env.ENCRYPTION_KEY)).toEqual({ token: 'a-private-api-token' });
    await expect(decrypt(a.slice(0, 20) + 'AAAA' + a.slice(24), env.ENCRYPTION_KEY)).rejects.toThrow();
    await expect(decrypt(a, btoa('different-key-12345678901234567890'))).rejects.toThrow();
  });
  it('fails closed when secrets are missing or weak', () => {
    expect(configured(env)).toBe(true); expect(configured({ ...env, ADMIN_PASSWORD: 'admin' })).toBe(false);
    expect(configured({ ...env, ENCRYPTION_KEY: 'bad' })).toBe(false); expect(configured({ ...env, SESSION_SECRET: '' })).toBe(false);
  });
  it('verifies signed sessions and invalidates them on password rotation', async () => {
    const token = await issueSession(env);
    const request = new Request('https://benx.example.com/api/servers', { headers: { Cookie: `benx_session=${token}` } });
    expect(await authenticate(request, env)).toBe('admin');
    await expect(authenticate(request, { ...env, ADMIN_PASSWORD: 'a-new-strong-password' })).rejects.toThrow('expired');
    await expect(authenticate(new Request(request.url), env)).rejects.toThrow('sign in');
    await expect(authenticate(new Request(request.url, { headers: { Cookie: 'benx_session=forged' } }), env)).rejects.toThrow();
  });
  it('compares credentials without length-dependent comparisons', async () => {
    expect(await equalSecret('same', 'same')).toBe(true); expect(await equalSecret('a', 'much-longer')).toBe(false);
  });
  it('rejects cross-origin writes including missing origins', () => {
    expect(() => assertOrigin(new Request('https://benx.example.com/api/login', { headers: { Origin: 'https://benx.example.com' } }))).not.toThrow();
    expect(() => assertOrigin(new Request('https://benx.example.com/api/login', { headers: { Origin: 'https://evil.example.com' } }))).toThrow();
    expect(() => assertOrigin(new Request('https://benx.example.com/api/login'))).toThrow();
    expect(() => assertOrigin(new Request('http://127.0.0.1:8787/api/login', { headers: { Origin: 'http://127.0.0.1:5173' } }))).not.toThrow();
  });
  it.each(['http://example.com/', 'https://user:pass@example.com/', 'https://localhost/', 'https://127.1/', 'https://10.0.0.1/', 'https://192.168.0.1/', 'https://169.254.169.254/', 'https://[::1]/', 'https://[::ffff:10.0.0.1]/', 'https://example.internal/', 'https://example.com/?token=x', 'https://example.com/#secret'])('blocks unsafe destination %s', url => expect(() => validateUrl(url)).toThrow());
  it('accepts public HTTPS destinations and preserves complete base paths', () => {
    expect(validateUrl('https://panel.example.com:2053/private')).toBe('https://panel.example.com:2053/private/');
    expect(isPublicIp('1.1.1.1')).toBe(true); expect(isPublicIp('2606:4700:4700::1111')).toBe(true);
    expect(isPublicIp('100.64.1.1')).toBe(false); expect(isPublicIp('192.0.2.1')).toBe(false);
  });
  it('checks both DNS families and rejects any private answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ Answer: [{ type: url.includes('type=AAAA') ? 28 : 1, data: url.includes('type=AAAA') ? 'fd00::1' : '1.1.1.1' }] })));
    await expect(verifyPublicDns('https://panel.example.com/')).rejects.toThrow('public');
  });
  it('limits payloads while streaming', async () => {
    await expect(readLimited(new Response('123456'), 5)).rejects.toThrow('too large');
    expect(new TextDecoder().decode(await readLimited(new Response('hello'), 5))).toBe('hello');
  });
  it('does not reuse credentials after destination changes', async () => {
    const previous = await validateServer(input, env);
    await expect(validateServer({ ...input, url: 'https://other.example.com/', token: '' }, env, previous)).rejects.toThrow('Re-enter');
    const edited = await validateServer({ ...input, token: '', name: 'Renamed' }, env, previous);
    expect(await decrypt(edited.credentials, env.ENCRYPTION_KEY)).toMatchObject({ token: 'test-token' });
  });
});
describe('Versioned 3X-UI adapter', () => {
  it('matches every allowlisted operation for its selected version', () => {
    for (const operation of operations) {
      const path = operation.path.replace(/\{[^}]+\}/g, 'example');
      expect(findOperation(path, operation.method, operation.version).path).toBe(operation.path);
    }
    expect(() => findOperation('/panel/api/clients/add', 'POST', 'v2')).toThrow('not supported');
    expect(() => findOperation('/panel/setting/update', 'POST', 'v3')).toThrow('not supported');
  });
  it.each(['/panel/api/inbounds/../server/status', '/panel/api/inbounds/get/%2f..', '/panel/api/inbounds/get/%252f', '//evil.example.com', '/panel/api/server/status?x=1', '/panel/api/inbounds/get/%00', '/panel/api/inbounds/get/%2e%2e'])('rejects escaping request path %s', p => expect(() => findOperation(p, 'GET', 'v3')).toThrow());
  it('encodes nested legacy fields and boolean values exactly once', () => {
    const encoded = formBody({ settings: { clients: [{ email: 'test' }] }, enable: false, sniffing: '{"enabled":true}' });
    expect(JSON.parse(encoded.get('settings')!)).toMatchObject({ clients: [{ email: 'test' }] });
    expect(encoded.get('enable')).toBe('false'); expect(encoded.get('sniffing')).toBe('{"enabled":true}');
  });
  it('forwards bearer auth and Access tokens server-side with no redirects', async () => {
    const server = await validateServer({ ...input, accessId: 'access-id', accessSecret: 'access-secret' }, env);
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://cloudflare-dns.com')) return Response.json({ Answer: [{ type: 1, data: '1.1.1.1' }] });
      expect(url).toBe('https://panel.example.com/secret/panel/api/inbounds/add');
      const headers = new Headers(init?.headers); expect(headers.get('Authorization')).toBe('Bearer test-token'); expect(headers.get('CF-Access-Client-Secret')).toBe('access-secret');
      expect(init?.redirect).toBe('manual'); expect(JSON.parse(String(init?.body))).toMatchObject({ port: 443 });
      return Response.json({ success: true, obj: { id: 1 } });
    });
    vi.stubGlobal('fetch', fetchMock);
    expect(await callRemoteJson(server, env, { path: '/panel/api/inbounds/add', method: 'POST', body: { port: 443 } })).toEqual({ id: 1 });
  });
  it('logs in to 2.x and serializes inbound settings as form fields', async () => {
    const server = await validateServer({ ...input, version: 'v2', auth: 'password', username: 'user', password: 'password' }, env);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://cloudflare-dns.com')) return Response.json({ Answer: [{ type: 1, data: '1.1.1.1' }] });
      if (url.endsWith('/login')) return Response.json({ success: true }, { headers: { 'Set-Cookie': '3x-ui=private-session; HttpOnly; Path=/' } });
      const headers = new Headers(init?.headers); expect(headers.get('Cookie')).toBe('3x-ui=private-session'); expect(headers.get('content-type')).toBe('application/x-www-form-urlencoded');
      expect((init?.body as URLSearchParams).get('settings')).toBe('{"clients":[]}');
      return Response.json({ success: true });
    }));
    await callRemote(server, env, { path: '/panel/api/inbounds/add', method: 'POST', body: { settings: { clients: [] } } });
  });
  it('obtains and replays 3.x CSRF for session authentication', async () => {
    const server = await validateServer({ ...input, auth: 'password', username: 'user', password: 'password' }, env);
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('https://cloudflare-dns.com')) return Response.json({ Answer: [{ type: 1, data: '1.1.1.1' }] });
      if (url.endsWith('/login')) return Response.json({ success: true }, { headers: { 'Set-Cookie': '3x-ui=session; Path=/' } });
      if (url.endsWith('/csrf-token')) return Response.json({ success: true, obj: 'remote-csrf' });
      expect(new Headers(init?.headers).get('X-CSRF-Token')).toBe('remote-csrf'); return Response.json({ success: true });
    }));
    await callRemote(server, env, { path: '/panel/api/inbounds/add', method: 'POST' });
  });
  it('rejects redirects without sending credentials to their location', async () => {
    const server = await validateServer(input, env);
    const mock = vi.fn(async (url: string) => url.startsWith('https://cloudflare-dns.com') ? Response.json({ Answer: [{ type: 1, data: '1.1.1.1' }] }) : new Response(null, { status: 302, headers: { location: 'https://evil.example.com' } }));
    vi.stubGlobal('fetch', mock);
    await expect(callRemote(server, env, { path: '/panel/api/server/status', method: 'GET' })).rejects.toThrow('redirected');
    expect(mock.mock.calls.some(([url]) => url.includes('evil'))).toBe(false);
  });
  it('refuses disabled connections', async () => {
    const server: StoredServer = { ...await validateServer(input, env), enabled: 0 };
    await expect(callRemote(server, env, { path: '/panel/api/server/status', method: 'GET' })).rejects.toThrow('disabled');
  });
});
