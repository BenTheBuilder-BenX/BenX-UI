import { describe, expect, it } from 'vitest';
import { sshSetupScript, validateSSHSetup, type SSHSetup } from '../src/lib/ssh-setup';
const setup: SSHSetup = { host: 'server.example.com', port: 22, username: 'root', authentication: 'password', keyPath: '' };
describe('SSH onboarding package', () => {
  it.each(['-oProxyCommand=bad', 'host; command', 'host\ncommand', 'user@server', 'https://server/'])('rejects a shell/argument injection host %s', host => expect(() => validateSSHSetup({ ...setup, host })).toThrow());
  it('rejects unsafe users, ports and package filenames', () => {
    expect(() => validateSSHSetup({ ...setup, username: 'root;bad' })).toThrow();
    expect(() => validateSSHSetup({ ...setup, port: 0 })).toThrow();
    expect(() => sshSetupScript(setup, { '../outside': 'bad' })).toThrow();
  });
  it('keeps private keys local, quotes their paths and enables SSH host verification', () => {
    const script = sshSetupScript({ ...setup, authentication: 'key', keyPath: "C:\\Keys\\seller's key" }, { 'benx_agent.py': 'print("سلام")' });
    expect(script).toContain("'C:\\Keys\\seller''s key'"); expect(script).toContain('StrictHostKeyChecking=ask');
    expect(script).not.toContain('StrictHostKeyChecking=no'); expect(script).not.toContain('password=');
    const payload = script.match(/Join-Path \$setupRoot 'benx_agent.py'\), \[Convert\]::FromBase64String\('([^']+)'\)/)?.[1];
    expect(Buffer.from(payload!, 'base64').toString('utf8')).toBe('print("سلام")');
  });
});
