import schemas from '../../shared/editor-schemas.json';
import masterDns from '../../shared/masterdns-schema.json';
import type { FieldSchema } from '../components/OptionsEditor';
const all = schemas as unknown as Record<string, FieldSchema>;
export const schemaFor = (name: string) => all[name] ?? { type: 'object', fields: {} };
const names: Record<string, string> = { vless: 'Vless', vmess: 'Vmess', trojan: 'Trojan', shadowsocks: 'Shadowsocks', wireguard: 'Wireguard', amneziawg: 'Amneziawg', hysteria: 'Hysteria', tuic: 'Tuic', mtproto: 'Mtproto', http: 'Http', socks: 'Mixed', mixed: 'Mixed', tunnel: 'Tunnel', 'dokodemo-door': 'Tunnel', tun: 'Tun' };
const field = (type: string, value?: unknown): FieldSchema => ({ type, default: value });
export const nativeSchemas: Record<string, FieldSchema> = {
  masterdnsvpn: { ...masterDns, fields: { ...masterDns.fields, clientResolvers: { type: 'array', default: ['1.1.1.1:53', '8.8.8.8:53', '9.9.9.9:53'], item: { type: 'string' } } } } as FieldSchema,
  openvpn: { type: 'object', fields: { authentication: { type: 'enum', options: ['password', 'certificate'], default: 'password' }, transport: { type: 'enum', options: ['udp', 'tcp', 'both'], default: 'udp' }, tcpPort: field('number', 0), internetAccess: field('boolean', true), subnet: field('string', '10.80.0.0/24'), dns: field('string', '1.1.1.1'), publicHost: field('string'), cipher: { type: 'enum', options: ['AES-256-GCM', 'AES-128-GCM'], default: 'AES-256-GCM' } } },
  openconnect: { type: 'object', fields: { internetAccess: field('boolean', true), subnet: field('string', '10.81.0.0/24'), dns: field('string', '1.1.1.1'), publicHost: field('string'), maxClients: field('number', 128), mtu: field('number', 1400) } },
  ssh: { type: 'object', fields: { publicHost: field('string'), allowTcpForwarding: field('boolean', true) } },
  'wireguard-native': { type: 'object', fields: { internetAccess: field('boolean', true), address: field('string', '10.82.0.1/24'), privateKey: field('string'), mtu: field('number', 1420), dns: field('string', '1.1.1.1'), publicHost: field('string') } },
};
export function protocolSchema(protocol: string) { return nativeSchemas[protocol] ?? schemaFor(`${names[protocol]}InboundSettingsSchema`); }
export const transportNames: Record<string, string> = { tcp: 'Tcp', raw: 'Tcp', kcp: 'Kcp', ws: 'Ws', grpc: 'Grpc', httpupgrade: 'HttpUpgrade', xhttp: 'XHttp', hysteria: 'Hysteria' };
export const inboundExtraSchema: FieldSchema = { type: 'object', fields: {
  tag: field('string'), nodeId: { type: 'number', optional: true }, shareAddrStrategy: { type: 'enum', options: ['node', 'listen', 'custom'], default: 'node' }, shareAddr: field('string'), subSortIndex: field('number', 1), excludeFromSub: field('boolean', false), disableFlow: field('boolean', false), trafficReset: { type: 'enum', options: ['never', 'hourly', 'daily', 'weekly', 'monthly'], default: 'never' }, trafficResetDay: field('number', 1),
} };
