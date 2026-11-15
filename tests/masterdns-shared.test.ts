import { describe, it, expect } from 'vitest';
import { masterDNSBackend, validateMasterDNS, withDNSBackends } from '../shared/masterdns';
const backend = { id: 2, protocol: 'vless', listen: '127.0.0.1', enable: true, excludeFromSub: true, settings: { decryption: 'none' }, streamSettings: { network: 'raw', security: 'none' } };
const dns = { id: 1, protocol: 'masterdnsvpn', settings: { meteredInboundId: 2 } };
describe('Shared DNS customer isolation', () => {
  it('pairs the private authenticated backend and accepts distinct identities', () => {
    expect(withDNSBackends([1], [dns, backend])).toEqual([1, 2]);
    expect(() => validateMasterDNS([dns, backend], { a: { inboundIds: [1, 2], id: '11111111-1111-4111-8111-111111111111' }, b: { inboundIds: [1, 2], id: '22222222-2222-4222-8222-222222222222' } })).not.toThrow();
  });
  it('rejects exposed backends and shared customer identities', () => {
    expect(() => masterDNSBackend(dns, [dns, { ...backend, listen: '0.0.0.0' }])).toThrow('127.0.0.1');
    expect(() => validateMasterDNS([dns, backend], { a: { inboundIds: [1, 2], id: '11111111-1111-4111-8111-111111111111' }, b: { inboundIds: [1, 2], id: '11111111-1111-4111-8111-111111111111' } })).toThrow('distinct');
    expect(() => validateMasterDNS([{ ...dns, settings: {} }], { a: { inboundIds: [1] }, b: { inboundIds: [1] } })).not.toThrow();
  });
});
