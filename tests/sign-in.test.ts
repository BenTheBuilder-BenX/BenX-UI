import { afterEach, describe, expect, it, vi } from 'vitest';
import { signInToWorkspace } from '../src/lib/sign-in';
afterEach(() => vi.unstubAllGlobals());
describe('Login workspace transition', () => {
  it.each(['/owner/' + 'a'.repeat(32), '/admins/' + 'a'.repeat(36), '/resellers/' + 'a'.repeat(36)])('verifies the session before opening %s', async entryPath => {
    vi.stubGlobal('location', { pathname: '/sign-in' });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ entryPath }))).mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: true, entryPath })));
    vi.stubGlobal('fetch', fetcher);
    expect(await signInToWorkspace('test-user', 'test-only-password')).toBe(entryPath);
    expect(fetcher.mock.calls.map(call => call[0])).toEqual(['/api/login', '/api/session']);
    expect(fetcher.mock.calls.every(call => call[1].credentials === 'same-origin')).toBe(true);
  });
  it('does not navigate when the session is missing after a successful password check', async () => {
    vi.stubGlobal('location', { pathname: '/sign-in' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ entryPath: '/owner/' + 'a'.repeat(32) }))).mockResolvedValueOnce(new Response(JSON.stringify({ authenticated: false, entryPath: null }))));
    await expect(signInToWorkspace('test-user', 'test-only-password')).rejects.toThrow('session could not be verified');
  });
});
