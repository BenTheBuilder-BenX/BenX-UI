import { describe, expect, it } from 'vitest';
import { hydrateClient, clientPayload, secretBytes } from '../src/lib/client-editor';
import { protocolSchema, schemaFor } from '../src/lib/editor-metadata';
import { coreForProtocol, isAgentOperation } from '../shared/cores';
import { runDemo, newDemoData } from '../src/lib/demo';
import { callRemote } from '../worker/remote';

describe('Full-access capability boundaries', () => {
  it('restricts management to known actions and full-access connections', async () => {
    expect(isAgentOperation('/benx/v1/cores/masterdnsvpn/install', 'POST')).toBe(true);
    expect(isAgentOperation('/benx/v1/cores/ssh;reboot/install', 'POST')).toBe(false);
    expect(isAgentOperation('/benx/v1/cores/openssh/uninstall', 'POST')).toBe(false);
    expect(isAgentOperation('/benx/v1/cores/openssh/install', 'GET')).toBe(false);
    await expect(callRemote({ kind: 'panel' } as never, {} as Env, { path: '/benx/v1/cores/openvpn/install', method: 'POST' })).rejects.toThrow('full-access');
    const demo = newDemoData();
    expect(() => runDemo({ path: '/benx/v1/capabilities', method: 'GET' }, demo)).toThrow('Full server access');
    expect(runDemo({ path: '/benx/v1/capabilities', method: 'GET' }, demo, true)).toMatchObject({ fullAccess: true, agent: 'benx-agent' });
  });
  it('exposes current protocol and transport fields including new XHTTP/REALITY options', () => {
    for (const protocol of ['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard', 'amneziawg', 'hysteria', 'tuic', 'mtproto', 'http', 'mixed', 'tunnel', 'tun']) expect(Object.keys(protocolSchema(protocol).fields ?? {}).length).toBeGreaterThan(0);
    expect(schemaFor('RealityStreamSettingsSchema').fields).toHaveProperty('mldsa65Seed');
    expect(schemaFor('XHttpStreamSettingsSchema').fields).toHaveProperty('sessionIDTable');
    expect(schemaFor('StreamExtrasSchema').fields).toHaveProperty('finalmask');
    expect(protocolSchema('masterdnsvpn').fields).toHaveProperty('ARQ_WINDOW_SIZE');
    expect(coreForProtocol('openconnect')).toBe('ocserv');
  });
});
describe('Current 3X-UI client identity', () => {
  it('requires the requested identity and its attachments before hydrating an existing editor', () => {
    expect(() => hydrateClient({ client: { email: 'other' }, inboundIds: [] }, 'alice')).toThrow();
    expect(() => hydrateClient({ client: { email: 'alice' } }, 'alice')).toThrow();
    expect(() => hydrateClient({ client: { email: 'alice' }, inboundIds: ['bad'] }, 'alice')).toThrow();
    expect(hydrateClient({ client: { email: 'alice' }, inboundIds: null }, 'alice').inboundIds).toEqual([]);
    expect(hydrateClient({ email: 'alice', inboundIds: [2], externalLinks: ['https://fixture.example/alice'] }, 'alice')).toMatchObject({
      inboundIds: [2], externalLinks: [{ value: 'https://fixture.example/alice' }],
    });
  });
  it('hydrates native global clients without confusing database IDs with UUIDs', () => {
    const hydrated = hydrateClient({ client: { id: 12, uuid: 'protocol-uuid', email: 'alex', reverse: { tag: 'retained' } }, inboundIds: [1, 3], externalLinks: [{ value: 'vless://example' }] });
    expect(hydrated.client.id).toBe('protocol-uuid');
    expect(clientPayload(hydrated.client, 'v3')).toMatchObject({ uuid: 'protocol-uuid', reverse: { tag: 'retained' } });
    expect(hydrated.inboundIds).toEqual([1, 3]);
    expect(hydrated.externalLinks).toHaveLength(1);
    expect(hydrateClient({ id: 'legacy-uuid', email: 'alex' }).client.id).toBe('legacy-uuid');
    expect(atob(secretBytes(16))).toHaveLength(16);
  });
  it('omits independently managed links, attachments and runtime traffic from ordinary client edits', () => {
    const { client } = hydrateClient({ email: 'alex', uuid: 'fixture-uuid', inboundIds: [1], externalLinks: ['saved-link'], traffic: { up: 40 }, reverse: { tag: 'keep' } });
    expect(clientPayload(client, 'v3')).toEqual({ email: 'alex', id: 'fixture-uuid', uuid: 'fixture-uuid', reverse: { tag: 'keep' } });
    expect(clientPayload(client, 'v3', [2]).inboundIds).toEqual([2]);
    expect(clientPayload(client, 'v2')).toEqual(client);
  });
  it('recovers the configured duration when an older native agent returns its activated deadline', () => {
    const activation = { duration: -86400000, startedAt: 1700000000000, identity: 'renewal-1' };
    const detail = { email: 'alex', inboundIds: [1], firstUseId: 'renewal-1', expiryTime: activation.startedAt - activation.duration, _firstUse: activation };
    expect(hydrateClient(detail, 'alex').client.expiryTime).toBe(activation.duration);
    expect(hydrateClient(detail).client.expiryTime).toBe(detail.expiryTime);
    expect(hydrateClient({ ...detail, expiryTime: detail.expiryTime + 10 }, 'alex').client.expiryTime).toBe(detail.expiryTime + 10);
  });
  it('changes existing client attachments without losing their credentials in demo', () => {
    const data = newDemoData();
    runDemo({ path: '/panel/api/clients/alex/attach', method: 'POST', body: { inboundIds: [2] } }, data);
    const clients = (data.inbounds[1].settings as { clients: { email: string; id: string }[] }).clients;
    expect(clients.find(c => c.email === 'alex')?.id).toBeTruthy();
    runDemo({ path: '/panel/api/clients/alex/detach', method: 'POST', body: { inboundIds: [1] } }, data);
    expect((data.inbounds[0].settings as { clients: { email: string }[] }).clients.some(c => c.email === 'alex')).toBe(false);
    expect(clients.some(c => c.email === 'alex')).toBe(true);
  });
  it('exports native demo profiles in their own formats', () => {
    const data = newDemoData();
    data.inbounds[0].protocol = 'openvpn';
    const profiles = runDemo({ path: '/panel/api/clients/links/alex', method: 'GET' }, data, true) as string[];
    expect(profiles[0]).toMatch(/^client\n/);
    expect(profiles[0]).toContain('Demo only');
    data.inbounds[0].protocol = 'wireguard-native';
    expect((runDemo({ path: '/panel/api/clients/links/alex', method: 'GET' }, data, true) as string[])[0]).toMatch(/^\[Interface\]/);
  });
});
