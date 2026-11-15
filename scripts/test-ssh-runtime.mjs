import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { generateKeyPairSync, createHash } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const output = resolve('.wrangler/ssh-runtime');
mkdirSync(output, { recursive: true });
const configPath = resolve(output, 'config.json');
writeFileSync(configPath, JSON.stringify({ name: 'benx-ssh-test', main: resolve('tests/fixtures/ssh-runtime.worker.ts'), compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'], alias: { 'cpu-features': resolve('worker/ssh-cpu.cjs'), './crypto/build/Release/sshcrypto.node': resolve('worker/ssh-native-disabled.cjs') }, define: { __dirname: '"/ssh2"' } }));
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', configPath, '--dry-run', '--outdir', output], { stdio: 'inherit', env: { ...process.env, WRANGLER_LOG_PATH: resolve('.wrangler/logs'), WRANGLER_REGISTRY_PATH: resolve('.wrangler/registry'), WRANGLER_SEND_METRICS: 'false' } });
const host = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
const fingerprint = 'SHA256:' + createHash('sha256').update(utils.parseKey(host).getPublicSSH()).digest('base64').replace(/=+$/, '');
let commands = 0, forwarded = 0, passwordAuth = 0, publicKeyAuth = 0;
const server = new Server({ hostKeys: [host] }, client => {
  client.on('error', () => {});
  client.on('authentication', auth => {
    if (auth.method === 'password' && auth.username === 'root' && auth.password === 'fixture-only') { passwordAuth++; auth.accept(); }
    else if (auth.method === 'publickey' && auth.username === 'root') {
      const key = utils.parseKey(`${auth.key.algo} ${auth.key.data.toString('base64')}`);
      if (!auth.signature) auth.accept();
      else if (!(key instanceof Error) && key.verify(auth.blob, auth.signature, auth.hashAlgo)) { publicKeyAuth++; auth.accept(); }
      else auth.reject();
    } else auth.reject();
  });
  client.on('ready', () => {
    client.on('session', accept => {
      const session = accept();
      session.on('exec', (accept, reject, info) => {
        if (!['fixture-command', 'fixture-large-input', 'fixture-no-exit-status'].includes(info.command)) { reject(); return; }
        commands++; const channel = accept(); const chunks = [];
        channel.on('data', data => { chunks.push(Buffer.from(data)); });
        channel.on('end', () => {
          const input = Buffer.concat(chunks);
          if (info.command === 'fixture-no-exit-status') {
            // The shell never acknowledged successful execution. An orderly
            // channel close alone must not turn a failed bootstrap into success.
            channel.end('closed-without-exit-status');
            return;
          }
          channel.write(info.command === 'fixture-large-input'
            ? JSON.stringify({ bytes: input.length, sha256: createHash('sha256').update(input).digest('hex') })
            : 'command:' + input.toString());
          channel.exit(0); channel.end();
        });
      });
    });
    client.on('tcpip', (accept, reject, info) => {
      if (info.destIP !== '127.0.0.1' || info.destPort !== 8095) { reject(); return; }
      forwarded++; const channel = accept(); let input = '';
      channel.on('data', chunk => { input += chunk.toString(); });
      // OpenSSH forwarding can leave the channel half-open after the HTTP
      // service closes its output. Require the caller's EOF before closing,
      // reproducing the live private-agent timeout found during provisioning.
      channel.on('end', () => {
        assert.ok(input.includes('\r\n\r\n'));
        assert.match(input, /Authorization: Bearer fixture-agent-token/);
        assert.match(input, /GET \/benx\/v1\/capabilities HTTP\/1.0/);
        const body = JSON.stringify({ success: true, obj: { agent: 'runtime-fixture' } });
        channel.end(`HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      });
    });
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let mf;
try {
  const port = server.address().port;
  const options = { modules: true, scriptPath: resolve(output, 'ssh-runtime.worker.js'), compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat'], bindings: { PORT: String(port), FINGERPRINT: fingerprint, MISMATCH: '' } };
  mf = new Miniflare(convertV4MiniflareOptions(options));
  const response = await mf.dispatchFetch('http://test/');
  if (response.status !== 200) throw new Error(await response.text());
  const data = await response.json();
  assert.equal(data.command, 'command:fixture-input');
  assert.equal(data.secondCommand, 'command:sequential-input');
  const largeInput = 'X🙂'.repeat(140000) + 'end-marker';
  assert.ok(Buffer.byteLength(largeInput) > 512 * 1024);
  assert.deepEqual(data.largeInput, { bytes: Buffer.byteLength(largeInput), sha256: createHash('sha256').update(largeInput).digest('hex') });
  assert.equal(data.missingExitStatusRejected, true, 'A close without an SSH exit status must be rejected');
  assert.equal(data.agent.obj.agent, 'runtime-fixture');
  assert.equal(data.privateKeyValid, true);
  assert.match(data.publicKey, /^ssh-ed25519 /);
  assert.equal(data.keyCommand, 'command:key-authenticated');
  assert.equal(commands, 5); assert.equal(forwarded, 1); assert.equal(passwordAuth, 1); assert.equal(publicKeyAuth, 1);
  await mf.setOptions(convertV4MiniflareOptions({ ...options, bindings: { ...options.bindings, MISMATCH: 'SHA256:' + 'a'.repeat(43) } }));
  const denied = await mf.dispatchFetch('http://test/');
  assert.equal(denied.status, 500);
  assert.equal(passwordAuth, 1, 'Changed host key must be rejected before authentication');
  console.log('Worker runtime SSH handshake, pinned host identity, sequential commands, complete >512KiB UTF-8 stdin before EOF, missing-exit-status rejection, private agent forwarding and Ed25519 key generation passed.');
} finally {
  await mf?.dispose();
  await new Promise(resolve => server.close(resolve));
}
