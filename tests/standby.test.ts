import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../worker/control', async original => ({ ...await original<typeof import('../worker/control')>(), reconcileServer: vi.fn(async () => true) }));
import { createManaged, managedRow, saveManaged, savedDocument } from '../worker/control';
import { standbyRoute, reconcileStandbys } from '../worker/standby';
import { emptyDocument } from '../shared/managed';
import { portableCopy } from '../shared/portable-profile';
import type { StoredServer } from '../worker/remote';
import { parseObject } from '../shared/types';
import { teamFixture } from './team-fixture';
let f: ReturnType<typeof teamFixture>, source: StoredServer, target: StoredServer;
const profile = () => {
  const d = emptyDocument(); d.state.nextId = 3;
  d.state.inbounds = [{ id: 1, protocol: 'vless', listen: '1.1.1.1', port: 443, enable: true, settings: { decryption: 'none', publicHost: '1.1.1.1' }, streamSettings: {}, sniffing: {} }, { id: 2, protocol: 'vless', port: 444, enable: false, settings: { decryption: 'none', publicHost: 'vpn.example.com' }, streamSettings: {}, sniffing: {} }];
  d.state.clients.alice = { email: 'alice', id: 'permanent-customer-uuid', password: 'permanent-customer-password', inboundIds: [1, 2], enable: true, totalGB: 1024 };
  d.runtime.usage = { alice: { up: 11, down: 19 } }; d.assets['native/1.key'] = 'private-key-material'; return d;
};
const command = (action: string, revision = 1, targetId = 'target') => standbyRoute(new Request('https://panel.example/api/servers/source/standbys', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, targetId, revision }) }), f.env, source, f.ctx);
const confirm = (id: string) => f.db.prepare("UPDATE managed_state SET applied_revision=revision,phase='synced' WHERE server_id=?").run(id);
const copy = () => f.db.prepare("SELECT * FROM standby_copies WHERE target_id='target'").get() as { phase: string; target_revision: number; source_revision: number; enabled: number };
beforeEach(async () => {
  f = teamFixture();
  for (const [id, url] of [['source', 'ssh://1.1.1.1:22/'], ['target', 'ssh://8.8.8.8:22/']]) f.db.prepare("INSERT INTO servers(id,name,url,version,kind,auth,credentials,created_at) VALUES(?,?,?,'v3','server','token','synthetic',0)").run(id, id, url);
  source = f.db.prepare("SELECT * FROM servers WHERE id='source'").get() as unknown as StoredServer; target = f.db.prepare("SELECT * FROM servers WHERE id='target'").get() as unknown as StoredServer;
  await createManaged(f.env, source.id, profile()); await createManaged(f.env, target.id, emptyDocument()); confirm(source.id);
});
afterEach(async () => { await Promise.allSettled(f.waits); f.db.close(); });
describe('Manually approved standby recovery', () => {
  it('copies identities, keys and usage, remaps only the VPS address and never enables listeners automatically', async () => {
    await command('approve'); await Promise.all(f.waits);
    const d = await savedDocument(f.env, (await managedRow(f.env, target.id))!);
    expect(d.state.clients.alice).toEqual(profile().state.clients.alice); expect(d.assets).toEqual(profile().assets); expect(d.runtime.usage).toEqual(profile().runtime.usage);
    expect(d.state.inbounds[0]).toMatchObject({ listen: '8.8.8.8', enable: false, settings: { publicHost: '8.8.8.8' } }); expect(parseObject(d.state.inbounds[1].settings).publicHost).toBe('vpn.example.com'); expect(d.coreEnabled.xray).toBe(false);
    confirm(target.id); await reconcileStandbys(f.env); expect(copy().phase).toBe('ready'); expect((await savedDocument(f.env, (await managedRow(f.env, target.id))!)).state.inbounds.every(i => i.enable === false)).toBe(true);
  });
  it('refreshes changed source revisions and requires explicit activation, even when the source is offline', async () => {
    await command('approve'); await Promise.all(f.waits); confirm(target.id);
    const changed = profile(); changed.state.clients.alice.password = 'new-customer-password'; await saveManaged(f.env, (await managedRow(f.env, source.id))!, changed); confirm(source.id);
    await reconcileStandbys(f.env); expect(copy().source_revision).toBe(2); confirm(target.id); await reconcileStandbys(f.env); expect(copy().phase).toBe('ready');
    f.db.prepare("UPDATE managed_state SET phase='failed' WHERE server_id='source'").run();
    await command('activate', copy().target_revision); const d = await savedDocument(f.env, (await managedRow(f.env, target.id))!);
    expect(d.state.clients.alice.password).toBe('new-customer-password'); expect(d.state.inbounds[0].enable).toBe(true); expect(d.state.inbounds[1].enable).toBe(false); expect(copy()).toMatchObject({ phase: 'activated', enabled: 0 });
  });
  it('refuses to overwrite a populated target, accept a stale approval, or form a cycle', async () => {
    await expect(command('approve', 9)).rejects.toThrow('refresh');
    await saveManaged(f.env, (await managedRow(f.env, target.id))!, profile()); await expect(command('approve', 2)).rejects.toThrow('empty target');
    f.db.prepare("INSERT INTO standby_copies(source_id,target_id) VALUES('target','source')").run(); await expect(command('approve', 2)).rejects.toThrow('cycles');
  });
  it('stops instead of overwriting independently edited standby settings', async () => {
    await command('approve'); await Promise.all(f.waits); const row = (await managedRow(f.env, target.id))!, d = await savedDocument(f.env, row); d.state.inbounds[0].remark = 'Target owner edit'; await saveManaged(f.env, row, d);
    await reconcileStandbys(f.env); expect(copy().phase).toBe('waiting'); expect((await savedDocument(f.env, (await managedRow(f.env, target.id))!)).state.inbounds[0].remark).toBe('Target owner edit');
  });
  it('preserves live source flags for direct restore rather than standby preparation', () => {
    const d = portableCopy(profile(), source.url, target.url, false); expect(d.state.inbounds[0].enable).toBe(true); expect(d.state.inbounds[1].enable).toBe(false); expect(d.state.clients).toEqual(profile().state.clients);
  });
  it('preserves public endpoints when the target is an outbound identity with no inferred VPS address', () => {
    const d = portableCopy(profile(), source.url, 'agent://11111111-1111-4111-8111-111111111111/', false);
    expect(parseObject(d.state.inbounds[0].settings).publicHost).toBe('1.1.1.1');
  });
  it('retains the real origin through an unconnected saved profile until a VPS is supplied', () => {
    const original = profile(); original.setup.certificate = {enabled:true,target:'both',domain:'vpn.example.com',ip:'1.1.1.1',email:'test@example.com'};
    const saved = portableCopy(original, source.url, 'https://unconnected.invalid/', false);
    expect(saved.setup.certificate.ip).toBe('1.1.1.1');
    const restored = portableCopy(saved, 'https://unconnected.invalid/', target.url, false);
    expect(restored.setup.certificate.ip).toBe('8.8.8.8'); expect(parseObject(restored.state.inbounds[0].settings).publicHost).toBe('8.8.8.8');
  });
});
