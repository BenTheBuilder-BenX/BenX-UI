import { describe, it, expect } from 'vitest';
import { newPolicy, demoPolicy, effectiveMultiplier, validatePolicy, serviceClientFields } from '../shared/policy';
import { subscription, parseProxy, encode64, decode64 } from '../shared/subscriptions';
import { importOutbound, publicDirectory } from '../shared/locations';
import { validateTunnel } from '../worker/tunnels';
import type { TunnelInput } from '../worker/tunnels';
import { newDemoData } from '../src/lib/demo';
const uuid = '11111111-1111-4111-8111-111111111111';
const link = `vless://${uuid}@proxy.example.com:443?security=reality&pbk=public-key&sid=0123&type=ws&path=%2Fproxy&host=ws.example.com#Netherlands`;
describe('Services and traffic policy', () => {
  it('resolves override, service, inbound and client multipliers including zero', () => {
    const p = demoPolicy(newDemoData().inbounds); p.inboundMultipliers['2'] = 3; p.clients.alice = { serviceId: 'standard', multiplier: 1.5, overrides: {} };
    expect(effectiveMultiplier(p, 'alice', 2)).toBe(3); p.clients.alice.serviceId = 'pro'; expect(effectiveMultiplier(p, 'alice', 2)).toBe(1.5);
    p.clients.alice.overrides['2'] = 0; expect(effectiveMultiplier(p, 'alice', 2)).toBe(0); expect(effectiveMultiplier(p, 'bob', 2)).toBe(3);
  });
  it('rejects malformed services, unknown plans, prototype keys and nonfinite rates', () => {
    const p = demoPolicy(newDemoData().inbounds); expect(validatePolicy(p)).toEqual(p);
    expect(() => validatePolicy({ ...p, clients: { alice: { serviceId: 'missing', multiplier: 1, overrides: {} } } })).toThrow();
    expect(() => validatePolicy({ ...p, inboundMultipliers: { '1': Infinity } })).toThrow();
    expect(() => validatePolicy({ ...p, clients: JSON.parse('{"__proto__":{"serviceId":"","multiplier":1,"overrides":{}}}') })).toThrow();
    const duplicate = structuredClone(p); duplicate.services[0].inbounds.push(duplicate.services[0].inbounds[0]); expect(() => validatePolicy(duplicate)).toThrow();
  });
  it('sets new-client rules without replacing an existing expiry', () => { const plan = demoPolicy(newDemoData().inbounds).services[0]; expect(serviceClientFields(plan, true).expiryTime).toBeGreaterThan(Date.now()); expect(serviceClientFields(plan, false)).not.toHaveProperty('expiryTime'); });
  it('restricts subscription origins and formats', () => { const p = newPolicy(); p.subscriptions.singbox = { enabled: true, baseUrl: 'https://user:password@example.com/', options: {} }; expect(() => validatePolicy(p)).toThrow(); });
});
describe('App subscription outputs', () => {
  it.each(['v2ray', 'v2box', 'happ'])('exports standard URI lists for %s', f => { expect(decode64(subscription([link], f).body)).toBe(link); });
  it('creates sing-box REALITY and transport settings, with selector routing', () => { const cfg = JSON.parse(subscription([link], 'singbox', { localPort: 3080 }).body); expect(cfg.outbounds[1].uuid).toBe(uuid); expect(cfg.outbounds[1].tls.reality.public_key).toBe('public-key'); expect(cfg.outbounds[1].transport.headers.Host).toBe('ws.example.com'); expect(cfg.route.final).toBe('BenX'); expect(cfg.inbounds[0].listen_port).toBe(3080); });
  it('creates distinct valid Clash proxy/group objects', () => { const cfg = JSON.parse(subscription([link, link], 'clash').body); expect(cfg.proxies[0].type).toBe('vless'); expect(cfg.proxies[0]['reality-opts']['short-id']).toBe('0123'); expect(cfg['proxy-groups'][0].proxies).toHaveLength(2); expect(cfg.proxies[0].name).not.toBe(cfg.proxies[1].name); });
  it('fails explicitly for unsupported transports instead of silently losing access', () => { expect(() => subscription([link.replace('type=ws', 'type=xhttp')], 'singbox')).toThrow('xhttp'); expect(() => subscription(['[Interface]\nPrivateKey=secret'], 'v2ray')).toThrow('No shareable'); });
  it('decodes VMess and Shadowsocks without changing credentials', () => { const vmess = parseProxy('vmess://' + encode64(JSON.stringify({ add: 'example.com', port: '443', id: uuid, net: 'grpc', path: 'proxy', ps: 'تهران', aid: 0 }))); expect(vmess.name).toBe('تهران'); expect(vmess.service).toBe('proxy'); const ss = parseProxy('ss://' + encode64('aes-256-gcm:secret:with-colon') + '@example.com:8388#Test'); expect(ss.password).toBe('secret:with-colon'); });
});
describe('Provider imports and tunnel inputs', () => {
  it('imports WireGuard and rejects command directives or unsupported profiles', () => { const key = 'YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWE='; const conf = `[Interface]\nPrivateKey = ${key}\nAddress = 10.1.0.2/32\nPostUp = dangerous-command\n[Peer]\nPublicKey = ${key}\nEndpoint = vpn.example.com:51820\nAllowedIPs = 0.0.0.0/0`; const cfg = importOutbound(conf, 'proton-nl'); expect(cfg.protocol).toBe('wireguard'); expect(JSON.stringify(cfg)).not.toContain('dangerous'); expect(() => importOutbound('client\ndev tun\n<ca>secret</ca>', 'proton')).toThrow('OpenVPN'); });
  it('converts a proxy URI or local SOCKS endpoint to a single outbound', () => { expect(importOutbound(link, 'location').protocol).toBe('vless'); expect(importOutbound('socks://127.0.0.1:1080', 'psiphon').protocol).toBe('socks'); expect(() => importOutbound(link, '../tag')).toThrow(); });
  it('discovers only fixed-origin public provider listings', () => { const listings = publicDirectory('<a href="/free-vless">Free VLESS</a><a href="https://evil.example/free">Fake</a><a href="javascript:alert(1)">Free</a>'); expect(listings).toEqual([{ title: 'Free VLESS', url: 'https://www.vpnjantit.com/free-vless' }]); });
  it('validates two endpoints and rejects injection and invalid subnet alignment', () => { const input: TunnelInput = { name: 'Link', sourceId: 'a', targetId: 'b', method: 'ssh-reverse', sourceHost: 'a.example.com', targetHost: 'b.example.com', port: 2223, listenPort: 1080, destinationHost: '127.0.0.1', destinationPort: 443, subnet: '10.83.0.0/30' }; expect(validateTunnel(input)).toBe(input); expect(() => validateTunnel({ ...input, targetId: 'a' })).toThrow(); expect(() => validateTunnel({ ...input, destinationHost: 'host\nPermitRootLogin yes' })).toThrow(); expect(() => validateTunnel({ ...input, subnet: '10.83.0.1/30' })).toThrow(); });
});
