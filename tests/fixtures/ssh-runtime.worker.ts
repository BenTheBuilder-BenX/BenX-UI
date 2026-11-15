import { agentRequest, managementKey, openSSH, sshExec } from '../../worker/ssh';
export default {
  async fetch(_request: Request, env: { PORT: string; FINGERPRINT: string; MISMATCH: string }) {
    let diagnostic = '';
    try {
    const key = managementKey();
    const client = await openSSH({ host: '127.0.0.1', port: Number(env.PORT), username: 'root', password: 'fixture-only', fingerprint: env.MISMATCH || env.FINGERPRINT }, '127.0.0.1', error => { diagnostic = error.message; });
    const command = await sshExec(client, 'fixture-command', 'fixture-input');
    const secondCommand = await sshExec(client, 'fixture-command', 'sequential-input');
    const largeInput = JSON.parse(await sshExec(client, 'fixture-large-input', 'X🙂'.repeat(140000) + 'end-marker'));
    let missingExitStatusRejected = false;
    try { await sshExec(client, 'fixture-no-exit-status', 'unacknowledged-command'); }
    catch { missingExitStatusRejected = true; }
    const result = await agentRequest(client, 'fixture-agent-token', '/benx/v1/capabilities', 'GET');
    const keyClient = await openSSH({ host: '127.0.0.1', port: Number(env.PORT), username: 'root', privateKey: key.privateKey, fingerprint: env.FINGERPRINT }, '127.0.0.1', error => { diagnostic = error.message; });
    const keyCommand = await sshExec(keyClient, 'fixture-command', 'key-authenticated');
    keyClient.end();
    return Response.json({ command, secondCommand, largeInput, missingExitStatusRejected, keyCommand, agent: await result.json(), publicKey: key.publicKey, privateKeyValid: key.privateKey.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----') });
    } catch (error) { return Response.json({ message: (error as Error).message, diagnostic }, { status: 500 }); }
  },
};
