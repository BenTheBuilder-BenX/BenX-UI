import { describe, expect, it } from 'vitest';
import { decode64, encode64, parseProxy, subscription } from '../shared/subscriptions';
import { emptyDocument, reduceDocument, withDefaultPublicHost, isManagedMutation } from '../shared/managed';
import { parseObject } from '../shared/types';
const key = encode64('a'.repeat(32));
const wg = `wireguard://${encodeURIComponent(key)}@vpn.example.com:51820?publickey=${encodeURIComponent(key)}&address=10.80.0.2%2F32&presharedkey=${encodeURIComponent(key)}`;
const ssh = 'ssh://customer:secret@vpn.example.com:2222?host_key=' + encodeURIComponent('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICLqZQfxtLIO3sy4cK7txsKgxHwKe63rfXa0ze30eeYo');
const dns = 'masterdns://' + encode64(JSON.stringify({ v: '1', domain: 'ns.example.com', key: 'test-only', method: 5, port: 53, protocol: 'SOCKS5', ps: 'DNS', resolvers: ['1.1.1.1'] }));
describe('Customer app protocol coverage', () => {
  it('preserves the V2Box MasterDNS payload and native connection credentials', () => {
    const result = subscription([wg, ssh, dns, 'socks://customer:secret@vpn.example.com:1080'], 'v2box');
    expect(decode64(result.body).split('\n')).toEqual([wg, ssh, dns, 'socks://customer:secret@vpn.example.com:1080']);
    expect(result.count).toBe(4);
    expect(parseProxy(wg).password).toBe(key);
  });
  it('uses current sing-box WireGuard endpoints and verifies SSH host keys', () => {
    const result = subscription([wg, ssh, dns], 'singbox'), config = JSON.parse(result.body);
    expect(result.excluded).toBe(1);
    expect(config.endpoints[0].peers[0].pre_shared_key).toBe(key);
    expect(config.endpoints[0].address).toEqual(['10.80.0.2/32']);
    expect(config.outbounds.find((p: { type: string }) => p.type === 'ssh').host_key[0]).toContain('ssh-ed25519');
    expect(config.outbounds[0].outbounds).toHaveLength(2);
  });
  it('defaults native endpoints separately for each server and preserves overrides', () => {
    const inbound = { protocol: 'ssh', settings: {} };
    expect(withDefaultPublicHost(inbound, 'ssh://140.82.33.6').settings).toEqual({ publicHost: '140.82.33.6' });
    expect(withDefaultPublicHost(inbound, 'ssh://212.74.39.106').settings).toEqual({ publicHost: '212.74.39.106' });
    const custom = { protocol: 'ssh', settings: { publicHost: 'vpn.example.com' } };
    expect(withDefaultPublicHost(custom, 'ssh://140.82.33.6')).toBe(custom);
  });
  it('requires an actual public address for an outbound agent while allowing a private backend', () => {
    const origin = 'agent://11111111-1111-4111-8111-111111111111/';
    expect(() => withDefaultPublicHost({ protocol: 'ssh', settings: {} }, origin)).toThrow('actual VPS public host');
    expect(withDefaultPublicHost({ protocol: 'vless', listen: '127.0.0.1', excludeFromSub: true, settings: {} }, origin).settings).toEqual({});
    expect(withDefaultPublicHost({ protocol: 'ssh', settings: { publicHost: 'vpn.example.com' } }, origin).settings).toEqual({ publicHost: 'vpn.example.com' });
  });
  it('exports Hysteria2 TLS without unsupported uTLS', () => {
    const config = JSON.parse(subscription(['hysteria2://secret@vpn.example.com:443?sni=vpn.example.com'], 'singbox').body);
    const proxy = config.outbounds.find((p: { type: string }) => p.type === 'hysteria2');
    expect(proxy.tls.enabled).toBe(true);
    expect(proxy.tls.utls).toBeUndefined();
  });
  it('keeps compatible Clash access when SSH or MasterDNS is also attached', () => {
    const result = subscription([wg, ssh, dns], 'clash');
    expect(result.excluded).toBe(2);
    expect(JSON.parse(result.body).proxies[0]).toMatchObject({ type: 'wireguard', ip: '10.80.0.2', 'private-key': key });
  });
  it('changes many customers atomically and preserves unrelated access and credentials', () => {
    let doc = emptyDocument();
    for (const port of [443, 8443]) doc = reduceDocument(doc, {path: '/panel/api/inbounds/add', method: 'POST', body: {protocol: 'vless', port, settings: {}, streamSettings: {}}}).document;
    for (const email of ['a', 'b']) doc = reduceDocument(doc, {path: '/panel/api/clients/add', method: 'POST', body: {client: {email}, inboundIds: [2]}}).document;
    const input = {path: '/panel/api/inbounds/1/clients', method: 'POST', body: {action: 'attach', emails: ['a', 'b']}};
    expect(isManagedMutation(input)).toBe(true);
    const attached = reduceDocument(doc, input).document;
    expect(attached.state.clients.a.inboundIds).toEqual([2, 1]);
    expect(attached.state.clients.b.password).toBe(doc.state.clients.b.password);
    const detached = reduceDocument(attached, {...input, body: {...input.body, action: 'detach'}}).document;
    expect(detached.state.clients.a.inboundIds).toEqual([2]);
    expect(detached.state.clients.b.inboundIds).toEqual([2]);
    expect(() => reduceDocument(doc, {...input, body: {...input.body, emails: ['a', 'missing']}})).toThrow('existing');
    expect(doc.state.clients.a.inboundIds).toEqual([2]);
  });
  it('rejects a second native MasterDNS inbound and invalid encryption choices', () => {
    const doc = reduceDocument(emptyDocument(), {path: '/panel/api/inbounds/add', method: 'POST', body: {protocol: 'masterdnsvpn', port: 53, settings: {DOMAIN: ['ns.example.com'], DATA_ENCRYPTION_METHOD: 2}}}).document;
    expect(() => reduceDocument(doc, {path: '/panel/api/inbounds/add', method: 'POST', body: {protocol: 'masterdnsvpn', port: 5353, settings: {DOMAIN: ['other.example.com']}}})).toThrow('existing MasterDNS');
    expect(() => reduceDocument(doc, {path: '/panel/api/inbounds/update/1', method: 'POST', body: {...doc.state.inbounds[0], settings: {DATA_ENCRYPTION_METHOD: 9}}})).toThrow('encryption');
  });
  it('creates and removes both real OpenVPN transports together and pairs customers', () => {
    const doc = reduceDocument(emptyDocument(), { path: '/panel/api/inbounds/add', method: 'POST', body: { protocol: 'openvpn', port: 1194, remark: 'VPN', settings: { transport: 'both', authentication: 'password' }, streamSettings: {} } }).document;
    expect(doc.state.inbounds).toHaveLength(2);
    expect(parseObject(doc.state.inbounds[1].settings).transport).toBe('tcp');
    const attached = reduceDocument(doc, { path: '/panel/api/clients/add', method: 'POST', body: { client: { email: 'a' }, inboundIds: [1] } }).document;
    expect(attached.state.clients.a.inboundIds).toEqual([1, 2]);
    const updated = reduceDocument(attached, { path: '/panel/api/inbounds/setEnable/1', method: 'POST', body: { enable: false } }).document;
    expect(updated.state.inbounds.every(i => i.enable === false)).toBe(true);
    const removed = reduceDocument(updated, { path: '/panel/api/inbounds/del/1', method: 'POST' }).document;
    expect(removed.state.inbounds).toHaveLength(0);
    expect(removed.state.clients.a.inboundIds).toEqual([]);
  });
});
