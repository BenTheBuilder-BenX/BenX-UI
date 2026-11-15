import { Client, utils, type Algorithms, type ClientChannel } from 'ssh2';
import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpError, isPublicIp, validateUrl } from './security';
import type { SSHInput } from '../shared/setup';
import { relayRequest, type RelayEnvironment } from './relay';
const relayClients = new WeakMap<Client, { input: SSHInput; env: RelayEnvironment }>();

export interface SSHConnection extends SSHInput { privateKey: string }
export function hostFingerprint(key: Buffer): string { return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`; }
export function validateSSH(value: unknown, credentials = true): SSHInput {
  if (!value || typeof value !== 'object') throw new HttpError(400, 'Enter SSH connection details.');
  const s = value as SSHInput;
  if (typeof s.host !== 'string' || !/^[a-zA-Z0-9.:-]{1,253}$/.test(s.host) || !Number.isInteger(s.port) || s.port < 1 || s.port > 65535 || !/^[a-z_][a-z0-9_-]{0,31}$/.test(s.username)) throw new HttpError(400, 'Use a public SSH host, a valid port, and a valid Linux username. Root or passwordless sudo is required.');
  if (!isIP(s.host) && !/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/.test(s.host)) throw new HttpError(400, 'Enter a valid SSH hostname or IP.');
  validateUrl(`https://${s.host.includes(':') ? `[${s.host}]` : s.host}/`);
  if (credentials && (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(s.fingerprint ?? '') || !(typeof s.password === 'string' && s.password.length > 0 && s.password.length <= 1024 || typeof s.privateKey === 'string' && s.privateKey.length > 0 && s.privateKey.length < 16000))) throw new HttpError(400, 'Verify the SSH fingerprint and enter a password or private key.');
  if (s.passphrase && (typeof s.passphrase !== 'string' || s.passphrase.length > 1024)) throw new HttpError(400, 'Invalid private key passphrase.');
  return { host: s.host.toLowerCase(), port: s.port, username: s.username, fingerprint: s.fingerprint, password: s.password, privateKey: s.privateKey, passphrase: s.passphrase };
}
export async function sshAddress(host: string): Promise<string> {
  if (isIP(host)) { if (!isPublicIp(host)) throw new HttpError(400, 'SSH requires a public IP address.'); return host; }
  const answers = (await Promise.all(['A', 'AAAA'].map(async type => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`, { headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new HttpError(502, 'Could not verify SSH host DNS.');
    const data = await res.json() as { Answer?: { type: number; data: string }[] };
    return (data.Answer ?? []).filter(a => [1, 28].includes(a.type)).map(a => a.data);
  }))).flat();
  if (!answers.length || answers.some(a => !isPublicIp(a))) throw new HttpError(400, 'SSH DNS must resolve exclusively to public addresses.');
  return answers[0]; // Connect to the verified address, avoiding a second DNS resolution.
}
const algorithms: Algorithms = { kex: ['ecdh-sha2-nistp256', 'ecdh-sha2-nistp384', 'ecdh-sha2-nistp521'], cipher: ['aes256-ctr', 'aes128-ctr'], hmac: ['hmac-sha2-256-etm@openssh.com', 'hmac-sha2-512-etm@openssh.com', 'hmac-sha2-256'], serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256'], compress: ['none'] };
export async function fingerprintSSH(input: SSHInput, env?: RelayEnvironment): Promise<string> {
  if (env?.SSH_RELAY_URL) return relayRequest<string>(env, 'fingerprint', input);
  const address = await sshAddress(input.host);
  return new Promise((resolve, reject) => {
    const client = new Client(); let found = false;
    client.on('error', () => { if (!found) reject(new HttpError(502, 'Cannot reach SSH. Check the host, port and firewall.')); });
    client.connect({ host: address, port: input.port, username: 'root', readyTimeout: 12000, algorithms, hostVerifier: (key: Buffer) => { found = true; resolve(hostFingerprint(key)); return false; } });
    client.on('close', () => { if (!found) reject(new HttpError(502, 'SSH closed before presenting a host key.')); });
  });
}
export async function connectSSH(input: SSHInput, env?: RelayEnvironment): Promise<Client> {
  if (env?.SSH_RELAY_URL) {
    const client = { end() { relayClients.delete(client); } } as Client;
    relayClients.set(client, { input: validateSSH(input), env });
    return client;
  }
  const address = await sshAddress(input.host);
  return openSSH(input, address);
}
// Separate transport entry point allows a local SSH server to exercise the Worker runtime.
// Production callers always obtain address through sshAddress above.
export function openSSH(input: SSHInput, address: string, diagnostic?: (error: Error) => void): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client(); let mismatch = false;
    client.on('error', error => { diagnostic?.(error); client.end(); reject(new HttpError(502, mismatch ? 'SSH host key changed. Verify the server identity before reconnecting.' : 'SSH connection failed. Check credentials, port, firewall and supported SSH algorithms.')); });
    client.once('ready', () => resolve(client));
    client.connect({ host: address, port: input.port, username: input.username, password: input.password, privateKey: input.privateKey, passphrase: input.passphrase, readyTimeout: 15000, algorithms, hostVerifier: (key: Buffer) => { mismatch = hostFingerprint(key) !== input.fingerprint; return !mismatch; } });
  });
}
async function sendInput(stream: ClientChannel, text: string) {
  const input = Buffer.from(text);
  for (let offset = 0; offset < input.length; offset += 8192) {
    await new Promise<void>((done, fail) => stream.write(input.subarray(offset, offset + 8192), error => error ? fail(error) : done()));
    // Yield between packets so deployed TCP writers can drain their queue.
    await new Promise<void>(done => setTimeout(done, 0));
  }
  stream.end();
}
export async function sshExec(client: Client, command: string, stdin?: string): Promise<string> {
  const relay = relayClients.get(client);
  if (relay) return relayRequest<string>(relay.env, 'exec', { connection: relay.input, command, stdin });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.end(); reject(new HttpError(504, 'SSH setup timed out. Recheck the server before retrying.')); }, 20000);
    client.exec(command, (error, stream) => {
      if (error) { clearTimeout(timer); reject(new HttpError(502, 'SSH server refused the setup command.')); return; }
      let data = ''; let size = 0;
      stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4 * 1024 * 1024) { stream.close(); clearTimeout(timer); reject(new HttpError(502, 'SSH response exceeded its limit.')); } else data += chunk.toString(); });
      stream.on('error', () => { clearTimeout(timer); reject(new HttpError(502, 'SSH command channel failed.')); });
      stream.on('close', (code: number) => { clearTimeout(timer); if (code !== 0) reject(new HttpError(502, 'The server did not confirm successful command completion. Check setup status before retrying.')); else resolve(data); });
      // Explicit writes work consistently across Node and the deployed Workers
      // stream implementation. End only after all input has been accepted.
      if (stdin !== undefined) void sendInput(stream, stdin).catch(() => { clearTimeout(timer); reject(new HttpError(502, 'SSH setup input could not be delivered.')); });
      else stream.end();
    });
  });
}
export function managementPublicKey(privateKey: string) {
  // BenX generates unencrypted, single-key OpenSSH Ed25519 files. Read their
  // public field without loading the SSH protocol implementation in a Worker.
  const raw = Buffer.from(privateKey.replace(/-----[^\n]+-----/g, '').replace(/\s/g, ''), 'base64');
  let offset = 15;
  const field = () => { if (offset + 4 > raw.length) throw Error('Management key parsing failed.'); const length = raw.readUInt32BE(offset); offset += 4; if (offset + length > raw.length) throw Error('Management key parsing failed.'); const value = raw.subarray(offset, offset + length); offset += length; return value; };
  if (raw.subarray(0, 15).toString() !== 'openssh-key-v1\0' || field().toString() !== 'none' || field().toString() !== 'none') throw Error('Management key parsing failed.');
  field();
  if (offset + 4 > raw.length || raw.readUInt32BE(offset) !== 1) throw Error('Management key parsing failed.');
  offset += 4;
  const publicSSH = field();
  if (publicSSH.length !== 51 || publicSSH.readUInt32BE(0) !== 11 || publicSSH.subarray(4, 15).toString() !== 'ssh-ed25519' || publicSSH.readUInt32BE(15) !== 32) throw Error('Management key parsing failed.');
  return `ssh-ed25519 ${publicSSH.toString('base64')}`;
}
export function managementKey() {
  const pair = generateKeyPairSync('ed25519');
  // ssh2 accepts OpenSSH Ed25519 keys, not PKCS#8. Encode the generated seed explicitly.
  const jwk = pair.privateKey.export({ format: 'jwk' });
  const publicBytes = Buffer.from(jwk.x!, 'base64url'), seed = Buffer.from(jwk.d!, 'base64url');
  const number = (value: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32BE(value); return bytes; };
  const string = (value: Buffer | string) => { const bytes = typeof value === 'string' ? Buffer.from(value) : value; return Buffer.concat([number(bytes.length), bytes]); };
  const publicSSH = Buffer.concat([string('ssh-ed25519'), string(publicBytes)]);
  const check = crypto.getRandomValues(new Uint32Array(1))[0];
  const secret = Buffer.concat([number(check), number(check), string('ssh-ed25519'), string(publicBytes), string(Buffer.concat([seed, publicBytes])), string('benx-management')]);
  const padding = Buffer.from(Array.from({ length: 8 - secret.length % 8 }, (_, n) => n + 1));
  const encoded = Buffer.concat([Buffer.from('openssh-key-v1\0'), string('none'), string('none'), string(''), number(1), string(publicSSH), string(Buffer.concat([secret, padding]))]).toString('base64');
  const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${encoded.match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`;
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Management key generation failed.');
  return { privateKey, publicKey: managementPublicKey(privateKey) };
}
export async function agentOverSSH(connection: SSHConnection, token: string, path: string, method: string, body?: string, env?: RelayEnvironment): Promise<Response> {
  if (env?.SSH_RELAY_URL) {
    const result = await relayRequest<{ status: number; body: string }>(env, 'agent', { connection, token, path, method, body });
    if (!Number.isInteger(result.status) || typeof result.body !== 'string') throw new HttpError(502, 'SSH relay returned invalid agent data.');
    return new Response(result.body, { status: result.status, headers: { 'Content-Type': 'application/json' } });
  }
  const client = await connectSSH(connection);
  return agentRequest(client, token, path, method, body);
}
export async function agentRequest(client: Client, token: string, path: string, method: string, body?: string): Promise<Response> {
  try {
    return await new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => { client.end(); reject(new HttpError(504, 'Management agent request timed out.')); }, 20000);
      client.forwardOut('127.0.0.1', 0, '127.0.0.1', 8095, (error, channel) => {
        if (error) { clearTimeout(timer); reject(new HttpError(502, 'The private agent is not ready. Check server setup status.')); return; }
        const chunks: Buffer[] = []; let size = 0;
        channel.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 5 * 1024 * 1024) { clearTimeout(timer); channel.close(); reject(new HttpError(502, 'Agent response exceeded its limit.')); } else chunks.push(chunk); });
        channel.on('error', () => { clearTimeout(timer); reject(new HttpError(502, 'Private management channel failed.')); });
        channel.on('close', () => {
          clearTimeout(timer);
          const bytes = Buffer.concat(chunks), split = bytes.indexOf('\r\n\r\n');
          const header = bytes.subarray(0, split).toString(); const status = Number(header.match(/^HTTP\/1\.[01] (\d{3})/)?.[1]);
          if (split < 0 || !status || /transfer-encoding:/i.test(header)) { reject(new HttpError(502, 'Agent returned an invalid HTTP response.')); return; }
          resolve(new Response(new Uint8Array(bytes.subarray(split + 4)), { status, headers: { 'Content-Type': 'application/json' } }));
        });
        const payload = body ?? '';
        // Signal request EOF so real OpenSSH closes both forwarding directions.
        void sendInput(channel, `${method} ${path} HTTP/1.0\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`).catch(() => { clearTimeout(timer); reject(new HttpError(502, 'Private management request could not be delivered.')); });
      });
    });
  } finally { client.end(); }
}
