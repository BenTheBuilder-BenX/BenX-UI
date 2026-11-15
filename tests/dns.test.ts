import { describe, expect, it } from 'vitest';
import { validateDNS } from '../shared/dns';
import { emptyDocument, validateDocument } from '../shared/managed';
import type { JsonObject } from '../shared/types';
const dns = (): JsonObject => ({ id: 2, protocol: 'dns-resolver', listen: '192.0.2.1', port: 5353, enable: true, settings: { upstreams: ['1.1.1.1'], allowedClients: ['192.0.2.2/32'], httpsPort: 8443, tlsPort: 853, quicPort: 853, certificateFile: '/pki/cert.pem', keyFile: '/pki/key.pem' } });
describe('Saved DNS configuration', () => {
  it('rejects customer attachments to a resolver before saving', () => {
    const document = emptyDocument(); document.state.inbounds = [dns()]; document.state.nextId = 3;
    document.state.clients.alice = { email: 'alice', inboundIds: [2] };
    expect(() => validateDocument(document)).toThrow('cannot be attached');
  });
  it('allows DoT and DoQ to share 853 alongside MasterDNS on 53', () => expect(() => validateDNS([dns(), { id: 1, port: 53, protocol: 'masterdnsvpn' }])).not.toThrow());
  it('rejects secondary endpoint conflicts before saving', () => expect(() => validateDNS([dns(), { id: 1, port: 8443, protocol: 'vless' }])).toThrow('conflict'));
  it('rejects normal DNS and MasterDNS sharing 53', () => expect(() => validateDNS([{ ...dns(), port: 53 }, { id: 1, port: 53, protocol: 'masterdnsvpn' }])).toThrow('conflict'));
  it('rejects open-by-accident access, invalid CIDRs and malformed settings', () => { for (const allowed of [[], ['999.1.1.1'], ['1.2.3.4/99']]) expect(() => validateDNS([{ ...dns(), settings: { ...(dns().settings as JsonObject), allowedClients: allowed } }])).toThrow('allowed'); });
  it('rejects missing encrypted DNS keys', () => expect(() => validateDNS([{ ...dns(), settings: { ...(dns().settings as JsonObject), keyFile: '' } }])).toThrow('certificate'));
});
