import { describe, expect, it } from 'vitest';
import { configurationView, emptyDocument, reduceDocument, validateDocument, type ManagedDocument } from '../shared/managed';
import { parseObject, type JsonObject } from '../shared/types';

const uuid = '11111111-1111-4111-8111-111111111111';
function listener(port: number, clients: JsonObject[] = []): JsonObject {
  return { protocol: 'vless', port, remark: `Listener ${port}`, enable: true, listen: '', settings: { clients, decryption: 'none' }, streamSettings: { network: 'tcp', security: 'none' }, sniffing: {} };
}
function addInbound(d: ManagedDocument, port: number, clients: JsonObject[] = []) {
  return reduceDocument(d, { path: '/panel/api/inbounds/add', method: 'POST', body: listener(port, clients) }).document;
}
describe('Saved server configuration', () => {
  it('accepts multiple shared-key MasterDNSVPN identities without mutating the previous document', () => {
    const d = addInbound(emptyDocument(), 5353, [{ email: 'dns-user', enable: true }]);
    d.state.inbounds[0].protocol = 'masterdnsvpn';
    expect(() => validateDocument(d)).not.toThrow();
    const shared = reduceDocument(d, { path: '/panel/api/clients/add', method: 'POST', body: { client: { email: 'other-user', enable: false }, inboundIds: [1] } }).document;
    expect(Object.keys(shared.state.clients)).toEqual(['dns-user', 'other-user']);
    expect(Object.keys(d.state.clients)).toEqual(['dns-user']);
    const detached = reduceDocument(d, { path: '/panel/api/clients/dns-user/detach', method: 'POST', body: { inboundIds: [1] } }).document;
    expect(() => reduceDocument(detached, { path: '/panel/api/clients/add', method: 'POST', body: { client: { email: 'replacement', enable: true }, inboundIds: [1] } })).not.toThrow();
  });
  it('keeps a client’s original credentials when attaching the identity to another inbound', () => {
    const first = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, password: 'original-password', subId: 'subscription-identity', enable: true }]);
    const second = addInbound(first, 8443, [{ email: 'alice', id: 'different-uuid', password: 'different-password', subId: 'different-subscription', enable: true }]);
    expect(second.state.clients.alice).toMatchObject({ id: uuid, password: 'original-password', subId: 'subscription-identity', inboundIds: [1, 2] });
    expect(parseObject(second.state.inbounds[1].settings).clients).toBeUndefined();
    const view = configurationView(second, { path: '/panel/api/inbounds/get/2', method: 'GET' }) as JsonObject;
    expect((parseObject(view.settings).clients as JsonObject[])[0].id).toBe(uuid);
    expect(first.state.clients.alice.inboundIds).toEqual([1]);
  });
  it('generates missing credentials once and retains them when a client quota changes', () => {
    const initial = addInbound(emptyDocument(), 443);
    const created = reduceDocument(initial, { path: '/panel/api/clients/add', method: 'POST', body: { client: { email: 'alice', totalGB: 0, enable: true }, inboundIds: [1] } }).document;
    const client = created.state.clients.alice;
    expect(client.id).toMatch(/^[a-f0-9-]{36}$/); expect(client.uuid).toBe(client.id);
    expect(String(client.password).length).toBeGreaterThan(32); expect(String(client.subId).length).toBeGreaterThan(8);
    const updated = reduceDocument(created, { path: '/panel/api/clients/update/alice', method: 'POST', body: { email: 'alice', totalGB: 50 * 1024 ** 3 } }).document;
    expect(updated.state.clients.alice).toMatchObject({ id: client.id, uuid: client.uuid, password: client.password, subId: client.subId, inboundIds: [1], totalGB: 50 * 1024 ** 3 });
  });
  it('deleting an inbound removes its attachments, service membership and quota multiplier', () => {
    const d = addInbound(addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, enable: true }]), 8443, [{ email: 'alice', id: uuid, enable: true }]);
    d.policy.inboundMultipliers = { 1: 2, 2: 1 };
    d.policy.services = [{ id: 'standard', name: 'Standard', description: '', enabled: true, inbounds: [{ inboundId: 1, multiplier: 2 }, { inboundId: 2, multiplier: 1 }], rules: { quotaGB: 50, expiryDays: 30, ipLimit: 0, hwidLimit: 0 }, formats: ['v2ray'] }];
    const deleted = reduceDocument(d, { path: '/panel/api/inbounds/del/1', method: 'POST' }).document;
    expect(deleted.state.inbounds.map(i => i.id)).toEqual([2]);
    expect(deleted.state.clients.alice).toMatchObject({ id: uuid, inboundIds: [2] });
    expect(deleted.policy.inboundMultipliers).toEqual({ 2: 1 });
    expect(deleted.policy.services[0].inbounds).toEqual([{ inboundId: 2, multiplier: 1 }]);
    expect(() => validateDocument(deleted)).not.toThrow();
  });
  it('rejects a stale routing/outbound edit rather than overwriting newer settings', () => {
    const initial = emptyDocument(), oldSetting = structuredClone(initial.state.xray);
    const replacement = { outbounds: [{ protocol: 'freedom', tag: 'direct' }, { protocol: 'blackhole', tag: 'blocked' }], routing: { rules: [{ domain: ['example.com'], outboundTag: 'blocked' }] } };
    const current = reduceDocument(initial, { path: '/panel/api/xray/update', method: 'POST', body: { expectedXraySetting: oldSetting, xraySetting: JSON.stringify(replacement) } }).document;
    expect(() => reduceDocument(current, { path: '/panel/api/xray/update', method: 'POST', body: { expectedXraySetting: oldSetting, xraySetting: JSON.stringify(oldSetting) } })).toThrow('Configuration changed');
    expect(current.state.xray).toEqual(replacement);
  });
  it('prevents clients from attaching to listeners absent from their saved profile', () => {
    const d = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, enable: true }]);
    expect(() => reduceDocument(d, { path: '/panel/api/clients/alice/attach', method: 'POST', body: { inboundIds: [9] } })).toThrow('invalid inbound attachments');
    expect(d.state.clients.alice.inboundIds).toEqual([1]);
  });
  it('retains an unconfigured client identity when its last inbound is removed', () => {
    const d = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, password: 'keep-me', subId: 'keep-sub', enable: true }]);
    const detached = reduceDocument(d, { path: '/panel/api/inbounds/del/1', method: 'POST' }).document;
    expect(detached.state.clients.alice).toMatchObject({ id: uuid, password: 'keep-me', subId: 'keep-sub', inboundIds: [] });
    expect(configurationView(detached, { path: '/panel/api/inbounds/list', method: 'GET' })).toEqual([]);
  });
  it('shows native checkpoint counters without changing saved credentials or enable intent', () => {
    const d = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, password: 'keep-password', subId: 'keep-sub', enable: true }]);
    d.runtime = { usage: { alice: { up: 2048, down: 4096, rawUp: 1024, rawDown: 2048, enable: false } }, inbounds: { 1: { up: 1024, down: 2048 } } };
    const original = structuredClone(d);
    const rows = configurationView(d, { path: '/panel/api/inbounds/list', method: 'GET' }) as JsonObject[];
    expect(rows[0]).toMatchObject({ id: 1, up: 1024, down: 2048, enable: true, clientStats: [{ email: 'alice', up: 2048, down: 4096 }] });
    const clients = configurationView(d, { path: '/panel/api/clients/list', method: 'GET' }) as JsonObject[];
    expect(clients[0]).toMatchObject({ email: 'alice', id: uuid, password: 'keep-password', subId: 'keep-sub', enable: true, inboundIds: [1], traffic: { up: 2048, down: 4096, rawUp: 1024, rawDown: 2048 } });
    expect(configurationView(d, { path: '/panel/api/clients/get/alice', method: 'GET' })).toEqual(clients[0]);
    parseObject(rows[0].settings).decryption = 'changed';
    (parseObject(rows[0].settings).clients as JsonObject[])[0].password = 'changed';
    (clients[0].inboundIds as number[]).push(2); parseObject(clients[0].traffic).up = 99999;
    expect(d).toEqual(original);
  });
  it('keeps panel traffic checkpoints separate from client intent and exposes logical inbound totals', () => {
    const d = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, password: 'keep-password', enable: true, totalGB: 100 }]); d.mode = 'panel';
    d.state.inbounds[0].up = 7; d.state.inbounds[0].down = 9;
    d.runtime = { alice: { up: 70, down: 50, enable: false, resetCount: 2, lastOnline: 1700000000 }, _inboundTraffic: { 1: { up: 300, down: 400 } } };
    const original = structuredClone(d);
    const rows = configurationView(d, { path: '/panel/api/inbounds/list', method: 'GET' }) as JsonObject[];
    expect(rows[0]).toMatchObject({ id: 1, up: 300, down: 400, clientStats: [{ email: 'alice', up: 70, down: 50 }] });
    const clients = configurationView(d, { path: '/panel/api/clients/list', method: 'GET' }) as JsonObject[];
    expect(clients).toEqual([{ client: d.state.clients.alice, inboundIds: [1], traffic: d.runtime.alice, externalLinks: [] }]);
    expect(parseObject(clients[0].client)).toMatchObject({ id: uuid, password: 'keep-password', enable: true, totalGB: 100 });
    expect(configurationView(d, { path: '/panel/api/clients/get/alice', method: 'GET' })).toEqual(clients[0]);
    parseObject(clients[0].client).enable = false; parseObject(clients[0].traffic).down = 0;
    expect(d).toEqual(original);
    delete d.runtime._inboundTraffic;
    expect(configurationView(d, { path: '/panel/api/inbounds/get/1', method: 'GET' })).toMatchObject({ up: 7, down: 9 });
  });
  it('returns zero traffic for a client without a checkpoint and authoritative absence for missing records', () => {
    const d = addInbound(emptyDocument(), 443, [{ email: 'alice', id: uuid, enable: true }]);
    for (const mode of ['native', 'panel'] as const) {
      d.mode = mode;
      expect(configurationView(d, { path: '/panel/api/clients/get/alice', method: 'GET' })).toMatchObject({ traffic: { up: 0, down: 0 } });
      expect(configurationView(d, { path: '/panel/api/clients/get/deleted', method: 'GET' })).toBeNull();
      expect(configurationView(d, { path: '/panel/api/inbounds/get/99', method: 'GET' })).toBeNull();
      const list = configurationView(d, { path: '/panel/api/inbounds/list', method: 'GET' }) as JsonObject[];
      expect(list[0].clientStats).toEqual([{ email: 'alice', up: 0, down: 0 }]);
    }
  });
});
