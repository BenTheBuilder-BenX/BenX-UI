import https from 'node:https';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { webcrypto } from 'node:crypto';
globalThis.crypto ??= webcrypto;
import runtime from './ssh-runtime.cjs';
const { agentOverSSH, connectSSH, fingerprintSSH, managementKey, sshExec, validateSSH } = runtime;

const token = process.env.BENX_RELAY_TOKEN;
if (!token || token.length < 48) throw Error('A strong relay token is required.');
const expected = Buffer.from(`Bearer ${token}`);
let active = 0;
const server = https.createServer({ cert: readFileSync(process.env.BENX_RELAY_CERT), key: readFileSync(process.env.BENX_RELAY_KEY), minVersion: 'TLSv1.2', maxHeaderSize: 8192 }, async (req, res) => {
  const supplied = Buffer.from(req.headers.authorization || '');
  const respond = (status, data) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); } };
  if (req.url !== '/ssh' || req.method !== 'POST') { respond(404, { success: false }); return; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { respond(401, { success: false }); return; }
  if (active >= 16) { respond(503, { success: false, msg: 'SSH relay is busy. Retry later.' }); return; }
  active++;
  try {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 4 * 1024 * 1024) { respond(413, { success: false, msg: 'Relay input exceeds its limit.' }); return; } chunks.push(chunk); }
    const { operation, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let obj;
    if (operation === 'health') obj = { ready: true };
    else if (operation === 'fingerprint') obj = await fingerprintSSH(validateSSH(input, false));
    else if (operation === 'keys') obj = managementKey();
    else if (operation === 'exec') {
      if (typeof input.command !== 'string' || input.command.length > 4096 || input.stdin !== undefined && typeof input.stdin !== 'string') throw Error('Invalid command input.');
      const client = await connectSSH(validateSSH(input.connection));
      try { obj = await sshExec(client, input.command, input.stdin); } finally { client.end(); }
    } else if (operation === 'agent') {
      if (typeof input.token !== 'string' || input.token.length < 32 || typeof input.path !== 'string' || !/^\/(?:benx|panel)\//.test(input.path) || /[\r\n\s]/.test(input.path) || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].includes(input.method) || input.body !== undefined && typeof input.body !== 'string') throw Error('Invalid agent input.');
      const response = await agentOverSSH(validateSSH(input.connection), input.token, input.path, input.method, input.body);
      obj = { status: response.status, body: await response.text() };
    } else throw Error('Unsupported relay operation.');
    respond(200, { success: true, obj });
  } catch (error) {
    const known = Number.isInteger(error.status) && [400, 409, 502, 504].includes(error.status);
    respond(known ? error.status : 502, { success: false, status: known ? error.status : 502, msg: known ? error.message : 'SSH relay could not complete the operation.' });
    // Never log request bodies, credentials, customer data or command output.
    console.error(JSON.stringify({ event: 'operation_failed', category: known ? 'ssh' : 'invalid_request' }));
  } finally { active--; }
});
server.requestTimeout = 40000; server.headersTimeout = 10000; server.timeout = 45000;
server.listen(Number(process.env.BENX_RELAY_PORT || 9443), '0.0.0.0');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
