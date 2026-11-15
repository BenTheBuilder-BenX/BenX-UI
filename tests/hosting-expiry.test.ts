import { describe, expect, it } from 'vitest';
import { clientExpiry } from '../shared/client-expiry';
import { advertisedHosts } from '../shared/hosts';
import { validateStorefront, validateStorefrontHTML } from '../shared/storefront';
import { emptyDocument, reduceDocument } from '../shared/managed';
import type { Inbound } from '../shared/types';
const inbound = { id: 1, port: 10001, listen: '', up: 0, down: 0, total: 0, expiryTime: 0, sniffing: {}, protocol: 'vless', remark: 'WS', enable: true, settings: {}, streamSettings: { network: 'ws', security: 'none', wsSettings: { path: '/proxy' } } } as Inbound;
describe('First-use expiry and hosting', () => {
  it('keeps a duration pending until real activation and preserves its deadline', () => {
    const c = { expiryTime: -30*86400000, id: 'id', firstUseId: 'renewal-1' };
    expect(clientExpiry(c, {})).toBe(c.expiryTime);
    expect(clientExpiry(c, { duration: c.expiryTime, identity: 'renewal-1', startedAt: 1000 })).toBe(1000+30*86400000);
    expect(clientExpiry(c, { duration: c.expiryTime, identity: 'old-renewal', startedAt: 1000 })).toBe(c.expiryTime);
  });
  it('advertises TLS/WS overrides without modifying the server listener', () => {
    const out = advertisedHosts(inbound, [{ inboundIds: [1], hosts: ['cdn.example.com:8443'], port: 443, security: 'tls', sni: 'origin.example.com', hostHeader: 'origin.example.com', path: '/other' }], 'origin')[0];
    expect(out.address).toBe('cdn.example.com'); expect(out.inbound.port).toBe(8443);
    expect(out.inbound.streamSettings).toMatchObject({ security: 'tls', tlsSettings: { serverName: 'origin.example.com' }, wsSettings: { path: '/other', headers: { Host: 'origin.example.com' } } });
    expect(inbound.port).toBe(10001);
  });
  it('supports native host edits and exclusion by subscription format', () => {
    const doc = emptyDocument(); doc.state.inbounds = [inbound]; doc.state.nextId = 2;
    const next = reduceDocument(doc, { path: '/panel/api/hosts/add', method: 'POST', body: { inboundIds: [1], hosts: ['cdn.example.com'], security: 'same', excludeFromSubTypes: ['clash'] } }).document;
    expect(advertisedHosts(inbound, next.hosts, 'origin', 'clash')).toEqual([]);
    expect(advertisedHosts(inbound, next.hosts, 'origin')[0].address).toBe('cdn.example.com');
  });
  it('updates native attachments and quota together, counting measured traffic for mixed attachments', () => {
    const doc = emptyDocument(); doc.state.inbounds = [inbound, { ...inbound, id: 2, port: 10002, protocol: 'ssh' }]; doc.state.nextId = 3;
    doc.state.clients.alice = { email: 'alice', id: 'id', inboundIds: [1,2], totalGB: 0, expiryTime: 0 };
    const updated = reduceDocument(doc, { path: '/panel/api/clients/update/alice', method: 'POST', body: { email: 'alice', inboundIds: [1], totalGB: 1000 } }).document;
    expect(updated.state.clients.alice).toMatchObject({ inboundIds: [1], totalGB: 1000 });
    expect(doc.state.clients.alice.inboundIds).toEqual([1,2]);
    expect(reduceDocument(updated, { path: '/panel/api/clients/alice/attach', method: 'POST', body: { inboundIds: [2] } }).document.state.clients.alice).toMatchObject({inboundIds:[1,2],totalGB:1000});
    expect(()=>reduceDocument(updated,{path:'/panel/api/clients/update/alice',method:'POST',body:{email:'alice',inboundIds:[2],totalGB:1000}})).toThrow(/measured/);
  });
  it('rejects port conflicts, unsupported CDN ports and duplicate proxy paths', () => {
    const s = { enabled: true, template: 'arcade', domain: 'arcade.example.com', mode: 'cdn', port: 2083, inboundIds: [1] };
    expect(validateStorefront(s, [inbound])).toEqual(s);
    expect(() => validateStorefront({ ...s, port: inbound.port }, [inbound])).toThrow();
    expect(() => validateStorefront({ ...s, port: 9443 }, [inbound])).toThrow();
    expect(() => validateStorefront({ ...s, inboundIds: [1, 2] }, [inbound, { ...inbound, id: 2 }])).toThrow();
    expect(() => validateStorefront(s, [{ ...inbound, streamSettings: { network: 'tcp', security: 'reality' } }])).toThrow();
  });
});

it('accepts static custom HTML but rejects oversized or executable uploads', () => {
  const html='<!doctype html><html><body><style>body{color:blue}</style><h1>Custom page</h1></body></html>';
  expect(validateStorefront({enabled:true,template:'custom',html,domain:'site.example.com',mode:'direct',port:2083,inboundIds:[1]},[inbound]).html).toBe(html);
  for(const bad of ['<html><script>alert(1)</script></html>','<html><img src=x onerror=alert(1)></html>','<html><form></form></html>','<html><meta http-equiv="refresh" content="0"></html>','<html>'+ 'a'.repeat(200000)+'</html>']) expect(()=>validateStorefrontHTML(bad)).toThrow();
});
