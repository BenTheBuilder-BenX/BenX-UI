import { parseObject, type JsonObject } from '../../shared/types';
export const outboundProtocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'wireguard', 'amneziawg', 'hysteria', 'freedom', 'blackhole', 'dns', 'loopback'];
export const flatVless = (value: JsonObject) => value.protocol === 'vless' && !Array.isArray(parseObject(value.settings).vnext);
export function outboundEndpoint(value: JsonObject) {
  const settings = parseObject(value.settings), vnext = ['vless', 'vmess'].includes(String(value.protocol)), rows = settings[vnext ? 'vnext' : 'servers'];
  if (flatVless(value) || value.protocol === 'hysteria') return { endpoint: settings, user: settings };
  const endpoint = parseObject(Array.isArray(rows) ? rows[0] : {}), users = endpoint.users;
  return { endpoint, user: parseObject(Array.isArray(users) ? users[0] : {}) };
}
export function updateOutboundEndpoint(value: JsonObject, fields: JsonObject, userFields?: JsonObject): JsonObject {
  const settings = parseObject(value.settings), vnext = ['vless', 'vmess'].includes(String(value.protocol)), key = vnext ? 'vnext' : 'servers', rows = Array.isArray(settings[key]) ? settings[key] as JsonObject[] : [];
  if (flatVless(value) || value.protocol === 'hysteria') return { ...value, settings: { ...settings, ...fields, ...userFields } };
  const { endpoint, user } = outboundEndpoint(value), users = Array.isArray(endpoint.users) ? endpoint.users : [];
  const updated = { ...endpoint, ...fields, ...(userFields ? { users: [{ ...user, ...userFields }, ...users.slice(1)] } : {}) };
  return { ...value, settings: { ...settings, [key]: [updated, ...rows.slice(1)] } };
}
export function newOutbound(protocol = 'vless', legacy = false): JsonObject {
  const base: JsonObject = { tag: '', protocol, settings: legacy && protocol === 'vless' ? { vnext: [] } : {} };
  if (['vless', 'vmess'].includes(protocol)) return updateOutboundEndpoint({ ...base, streamSettings: { network: 'tcp', security: 'none' } }, { address: '', port: 443 }, { id: '', ...(protocol === 'vless' ? { encryption: 'none' } : { security: 'auto' }) });
  if (['trojan', 'shadowsocks', 'http', 'socks'].includes(protocol)) return updateOutboundEndpoint({ ...base, streamSettings: { network: 'tcp', security: protocol === 'trojan' ? 'tls' : 'none' } }, { address: '', port: 443, ...(['trojan', 'shadowsocks'].includes(protocol) ? { password: '', ...(protocol === 'shadowsocks' ? { method: 'aes-128-gcm' } : {}) } : {}) });
  if (protocol === 'freedom') base.settings = { domainStrategy: 'AsIs' };
  if (protocol === 'blackhole') base.settings = { response: { type: 'none' } };
  if (protocol === 'wireguard') base.settings = { secretKey: '', address: [], peers: [], mtu: 1420 };
  if (protocol === 'amneziawg') base.settings = { secretKey: '', address: [], peers: [], mtu: 0 };
  if (protocol === 'hysteria') return { ...base, settings: { address: '', port: 443, version: 2 }, streamSettings: { network: 'hysteria', security: 'tls', hysteriaSettings: { version: 2, auth: '', udpIdleTimeout: 60 } } };
  return base;
}
export function validateOutbound(value: JsonObject) {
  if (!value || Array.isArray(value) || !String(value.tag || '').trim() || !String(value.protocol || '').trim()) throw new Error('Enter a unique tag and protocol.');
  const p = String(value.protocol), settings = parseObject(value.settings);
  if (['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks', 'hysteria'].includes(p)) {
    const rows = flatVless(value) || p === 'hysteria' ? [{ ...settings, users: [settings] }] : settings[['vless', 'vmess'].includes(p) ? 'vnext' : 'servers'];
    if (!Array.isArray(rows) || !rows.length) throw new Error('Add at least one outbound server.');
    for (const entry of rows) {
      const e = parseObject(entry); if (!String(e.address || '').trim() || !Number.isInteger(e.port) || Number(e.port) < 1 || Number(e.port) > 65535) throw new Error('Enter a server address and port between 1 and 65535.');
      if (['vless', 'vmess'].includes(p) && (!Array.isArray(e.users) || !e.users.length || e.users.some(u => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(parseObject(u).id || ''))))) throw new Error('Enter the remote server’s valid UUID.');
      if (['trojan', 'shadowsocks'].includes(p) && !String(e.password || '')) throw new Error('Enter the remote server password.');
      if (p === 'shadowsocks' && !e.method) throw new Error('Choose an encryption method.');
    }
  }
  if (['wireguard', 'amneziawg'].includes(p) && (!settings.secretKey || !Array.isArray(settings.peers) || !settings.peers.length || settings.peers.some(v => !parseObject(v).publicKey || !parseObject(v).endpoint))) throw new Error('Enter the private key and at least one peer with a public key and endpoint.');
  const stream = parseObject(value.streamSettings), reality = parseObject(stream.realitySettings);
  if (stream.security === 'reality' && (!(reality.publicKey || reality.password) || !reality.serverName)) throw new Error('REALITY needs the remote public key and SNI.');
  if (stream.security === 'reality' && reality.shortId !== undefined && !/^(?:[a-f0-9]{2}){0,8}$/i.test(String(reality.shortId))) throw new Error('REALITY short ID must be even-length hexadecimal, up to 16 characters.');
  return value;
}
