import { Buffer } from 'node:buffer';
import { isIP } from 'node:net';
import type { Client } from 'ssh2';
import { openSSH, validateSSH } from '../../worker/ssh';
import { equalSecret, isPublicIp } from '../../worker/security';

// Temporary, authenticated live transport fixture. Its two commands only read
// stdin; it cannot execute caller-supplied shell commands or save credentials.
interface DiagnosticEnv { DIAGNOSTIC_TOKEN: string }
interface Event { event: string; elapsedMs: number; code?: number | null; name?: string; message?: string }
function safeError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  const known = [
    ['host key changed', 'host identity mismatch'], ['authentication', 'authentication failed'],
    ['credentials', 'connection or authentication failed'], ['timed out', 'connection timed out'],
    ['ECONNRESET', 'connection reset'], ['ECONNREFUSED', 'connection refused'],
    ['ETIMEDOUT', 'connection timed out'], ['MAC', 'message authentication failed'],
    ['packet', 'SSH packet failure'], ['channel', 'SSH channel failure'],
    ['write', 'SSH input write failure'],
  ];
  return {
    name: error instanceof Error && ['Error', 'TypeError', 'RangeError'].includes(error.name) ? error.name : 'Error',
    message: known.find(([pattern]) => message.toLowerCase().includes(pattern.toLowerCase()))?.[1] ?? 'SSH operation failed; details withheld',
  };
}
async function probe(client: Client, command: '/bin/sh -s' | '/usr/bin/wc -c', input: string, chunked: boolean) {
  const started = Date.now(), events: Event[] = [];
  const record = (event: string, extra: Partial<Event> = {}) => events.push({ event, elapsedMs: Date.now() - started, ...extra });
  return new Promise<{ events: Event[]; inputBytes: number; acceptedBytes: number; outputBytes: number; sentinel: boolean; countedBytes: number | null; success: boolean }>(resolve => {
    let acceptedBytes = 0, outputBytes = 0, output = '', done = false;
    const finish = (code: number | null = null) => {
      if (done) return; done = true; clearTimeout(timer);
      resolve({ events, inputBytes: Buffer.byteLength(input), acceptedBytes, outputBytes,
        sentinel: output.trim() === 'BENX_READONLY_PREFLIGHT',
        countedBytes: /^\s*\d+\s*$/.test(output) ? Number(output.trim()) : null, success: code === 0 });
    };
    const timer = setTimeout(() => { record('timeout'); client.end(); finish(); }, 30000);
    client.exec(command, (error, stream) => {
      if (error) { record('exec-error', safeError(error)); finish(); return; }
      record('exec-accepted');
      stream.on('finish', () => record('finish'));
      stream.on('end', () => record('end'));
      stream.on('exit', (code: number | undefined) => record('exit', { code: typeof code === 'number' ? code : null }));
      stream.on('error', (error: Error) => record('channel-error', safeError(error)));
      stream.on('data', (bytes: Buffer) => {
        outputBytes += bytes.length;
        if (outputBytes <= 4096) output += bytes.toString();
        else { record('output-limit'); stream.close(); finish(); }
      });
      stream.stderr.on('data', (bytes: Buffer) => { record('stderr-bytes', { code: bytes.length }); });
      stream.on('close', (code: number | undefined) => { record('close', { code: typeof code === 'number' ? code : null }); finish(typeof code === 'number' ? code : null); });
      const send = async () => {
        const bytes = Buffer.from(input), size = chunked ? 8192 : bytes.length;
        for (let offset = 0; offset < bytes.length; offset += size) {
          const chunk = bytes.subarray(offset, offset + size);
          await new Promise<void>((accept, reject) => stream.write(chunk, writeError => {
            if (writeError) reject(writeError); else { acceptedBytes += chunk.length; accept(); }
          }));
          if (chunked) await new Promise<void>(accept => setTimeout(accept, 0));
        }
        record('all-write-callbacks');
        stream.end(); record('end-requested');
      };
      void send().catch(error => { record('input-error', safeError(error)); stream.close(); finish(); });
    });
  });
}
export default {
  async fetch(request: Request, env: DiagnosticEnv) {
    const response = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
    if (!env.DIAGNOSTIC_TOKEN || env.DIAGNOSTIC_TOKEN.length < 32) return response({ error: 'Diagnostic fixture disabled' }, 503);
    if (request.method !== 'POST' || !await equalSecret(request.headers.get('Authorization') ?? '', `Bearer ${env.DIAGNOSTIC_TOKEN}`)) return response({ error: 'Unauthorized' }, 401);
    let client: Client | undefined;
    const clientEvents: Event[] = [], started = Date.now();
    try {
      const text = await request.text();
      if (text.length > 32768) return response({ error: 'Request too large' }, 413);
      const body = JSON.parse(text) as { ssh: unknown; writeMode?: unknown };
      if (body.writeMode !== undefined && !['single', 'chunked'].includes(String(body.writeMode))) return response({ error: 'Invalid diagnostic write mode' }, 400);
      const ssh = validateSSH(body.ssh);
      if (!isIP(ssh.host) || !isPublicIp(ssh.host)) return response({ error: 'A public literal IP is required' }, 400);
      client = await openSSH(ssh, ssh.host, error => clientEvents.push({ event: 'client-error', elapsedMs: Date.now() - started, ...safeError(error) }));
      client.on('end', () => clientEvents.push({ event: 'client-end', elapsedMs: Date.now() - started }));
      client.on('close', () => clientEvents.push({ event: 'client-close', elapsedMs: Date.now() - started }));
      const chunked = body.writeMode !== 'single';
      const preflight = await probe(client, '/bin/sh -s', "set -eu\nprintf '%s\\n' 'BENX_READONLY_PREFLIGHT'\n", chunked);
      const largeInput = preflight.success ? await probe(client, '/usr/bin/wc -c', 'X'.repeat(330 * 1024), chunked) : null;
      return response({ writeMode: chunked ? 'chunked' : 'single', preflight, largeInput, clientEvents });
    } catch (error) { return response({ error: safeError(error), clientEvents }, 502); }
    finally { client?.end(); }
  },
};
