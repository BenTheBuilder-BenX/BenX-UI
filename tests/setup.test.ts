import { describe, expect, it, vi, afterEach } from 'vitest';
import { utils } from 'ssh2';
import { defaultSetup, validatePlan } from '../shared/setup';
import { managementKey, managementPublicKey, sshAddress, validateSSH } from '../worker/ssh';
import { bootstrapScript } from '../worker/bootstrap';
import { isAgentOperation } from '../shared/cores';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const ssh = { host: '1.1.1.1', port: 22, username: 'root', password: 'test', fingerprint: 'SHA256:' + 'a'.repeat(43) };
afterEach(() => vi.unstubAllGlobals());
describe('Automatic VPS setup', () => {
  it('rejects malformed and truncated management keys during bootstrap retry', () => {
    for (const key of ['', 'not-a-key', '-----BEGIN OPENSSH PRIVATE KEY-----\nYWJj\n-----END OPENSSH PRIVATE KEY-----']) expect(() => managementPublicKey(key)).toThrow('Management key parsing failed');
    const generated = managementKey();
    expect(managementPublicKey(generated.privateKey)).toBe(generated.publicKey);
  });
  it('generates a usable Ed25519 SSH key, with a matching public blob', () => {
    const key = managementKey(), parsed = utils.parseKey(key.privateKey);
    if (parsed instanceof Error || Array.isArray(parsed)) throw parsed;
    expect(parsed.type).toBe('ssh-ed25519');
    expect(Buffer.from(parsed.getPublicSSH()).toString('base64')).toBe(key.publicKey.split(' ')[1]);
    const signature = parsed.sign(Buffer.from('management-proof'));
    expect(signature).not.toBeInstanceOf(Error);
    expect(parsed.verify(Buffer.from('management-proof'), signature as Buffer)).toBe(true);
  });
  it.each(['127.0.0.1', '10.0.0.1', 'localhost', 'bad;host.example', '-ssh.example.com', 'host.example.com/path'])('rejects unsafe SSH host %s', host => expect(() => validateSSH({ ...ssh, host })).toThrow());
  it('requires fingerprint verification before authenticating and accepts only valid Linux usernames', () => {
    expect(validateSSH(ssh)).toMatchObject(ssh);
    expect(() => validateSSH({ ...ssh, fingerprint: '' })).toThrow('Verify');
    expect(() => validateSSH({ ...ssh, username: 'admin;reboot' })).toThrow('username');
    expect(() => validateSSH({ ...ssh, port: 0 })).toThrow();
  });
  it('rejects any private DNS answer before opening SSH and uses the verified address', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ Answer: [{ type: url.includes('AAAA') ? 28 : 1, data: url.includes('AAAA') ? 'fd00::1' : '1.1.1.1' }] })));
    await expect(sshAddress('ssh.example.com')).rejects.toThrow('public');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => Response.json({ Answer: url.includes('AAAA') ? [] : [{ type: 1, data: '1.1.1.1' }] })));
    expect(await sshAddress('ssh.example.com')).toBe('1.1.1.1');
  });
  it('rejects unsupported cores and certificate injection', () => {
    expect(validatePlan(defaultSetup)).toEqual(defaultSetup);
    expect(() => validatePlan({ ...defaultSetup, cores: ['user-command'] })).toThrow();
    expect(() => validatePlan({ ...defaultSetup, certificate: { enabled: true, domain: 'good.example; reboot', email: 'a@example.com' } })).toThrow();
  });
  it('adds the matching tunnel tools without requiring a peer during base setup', () => {
    expect(validatePlan({ ...defaultSetup, tunnelMethod: 'ssh-reverse' }).cores).toContain('openssh');
    expect(validatePlan({ ...defaultSetup, tunnelMethod: 'wireguard' }).cores).toContain('wireguard');
  });
  it('validates domain-only, public IP and combined certificate requests', () => {
    const certificate = { enabled: true, domain: '', target: 'ip', ip: '2606:4700:4700::1111', email: 'a@example.com' };
    expect(validatePlan({ ...defaultSetup, certificate }).certificate.ip).toBe(certificate.ip);
    expect(validatePlan({ ...defaultSetup, certificate: { ...certificate, target: 'both', domain: 'VPN.Example.com' } }).certificate.domain).toBe('vpn.example.com');
    expect(() => validatePlan({ ...defaultSetup, certificate: { ...certificate, ip: '999.1.1.1' } })).toThrow();
    expect(() => validatePlan({ ...defaultSetup, certificate: { ...certificate, target: 'both' } })).toThrow();
  });
  it('installs only a loopback-forwarding key and never embeds root credentials', () => {
    const script = bootstrapScript('agent-token', 'ssh-ed25519 test-public-key', '00000000-0000-0000-0000-000000000001', defaultSetup);
    expect(script).toContain('restrict,port-forwarding,permitopen="127.0.0.1:8095"');
    expect(script).toContain('command="/bin/cat /var/lib/benx-agent/bootstrap-status.json"');
    expect(script).toContain('test ! -e /etc/benx-agent.env');
    expect(script).not.toContain('PasswordAuthentication');
    expect(script).not.toContain('PermitRootLogin');
  });
  it('passes shell syntax checks for staging and the background installer', () => {
    const bash = process.platform === 'win32' ? 'C:\\Program Files\\Git\\bin\\bash.exe' : '/bin/bash';
    if (!existsSync(bash)) return;
    const script = bootstrapScript('fixture-agent-token', 'ssh-ed25519 fixture-public-key', '00000000-0000-0000-0000-000000000001', defaultSetup, 'ubuntu');
    const encoded = script.match(/printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d > '[^']+\/install.sh'/)?.[1];
    expect(encoded).toBeTruthy();
    mkdirSync('.wrangler/syntax', { recursive: true });
    writeFileSync('.wrangler/syntax/stage.sh', script);
    writeFileSync('.wrangler/syntax/install.sh', Buffer.from(encoded!, 'base64'));
    for (const name of ['stage', 'install']) execFileSync(bash, ['--noprofile', '--norc', '-n', `.wrangler/syntax/${name}.sh`]);
  });
  it('allows only fixed setup endpoints', () => {
    expect(isAgentOperation('/benx/v1/setup', 'GET')).toBe(true);
    expect(isAgentOperation('/benx/v1/setup', 'POST')).toBe(true);
    expect(isAgentOperation('/benx/v1/setup/exec', 'POST')).toBe(false);
  });
});
