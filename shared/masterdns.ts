import { parseObject, type JsonObject } from './types';
export function masterDNSBackend(inbound: JsonObject, inbounds: JsonObject[]): JsonObject | undefined {
  const id = Number(parseObject(inbound.settings).meteredInboundId || 0);
  if (!id) return;
  const target = inbounds.find(i => i.id === id), stream = parseObject(target?.streamSettings);
  if (!Number.isSafeInteger(id) || !target || target.protocol !== 'vless' || target.listen !== '127.0.0.1' || !['tcp', 'raw'].includes(String(stream.network || 'tcp')) || !['none', ''].includes(String(stream.security || 'none')) || !target.excludeFromSub || parseObject(target.settings).decryption !== 'none' || inbound.enable !== false && target.enable === false) throw new Error('Shared MasterDNSVPN needs an enabled VLESS backend on 127.0.0.1 with RAW/TCP, no TLS, decryption none, and Exclude from subscription enabled.');
  return target;
}
export function validateMasterDNS(inbounds: JsonObject[], clients: Record<string, JsonObject>) {
  const claimed = new Set<number>();
  for (const inbound of inbounds.filter(i => i.protocol === 'masterdnsvpn')) {
    const method = parseObject(inbound.settings).DATA_ENCRYPTION_METHOD ?? 2;
    if (!Number.isInteger(method) || ![1, 2, 3, 4, 5].includes(Number(method))) throw new Error('Choose XOR, ChaCha20 or an AES-GCM encryption method.');
    const attached = Object.values(clients).filter(c => (c.inboundIds as number[]).includes(Number(inbound.id))), backend = masterDNSBackend(inbound, inbounds);
    if (backend) {
      if (claimed.has(Number(backend.id))) throw new Error('Each shared DNS listener needs its own metered VLESS backend.');
      claimed.add(Number(backend.id));
      if (attached.some(c => !(c.inboundIds as number[]).includes(Number(backend.id)))) throw new Error('Shared DNS clients must also be attached to its VLESS backend for authentication and metering.');
      const identities = attached.map(c => String(c.uuid || c.id || ''));
      if (identities.some(id => !/^[0-9a-f-]{36}$/i.test(id)) || new Set(identities).size !== identities.length) throw new Error('Shared DNS clients need distinct VLESS UUIDs.');
    }
  }
}
export function withDNSBackends(ids: number[], inbounds: JsonObject[]) {
  return [...new Set([...ids, ...inbounds.filter(i => ids.includes(Number(i.id)) && i.protocol === 'masterdnsvpn').flatMap(i => { const target = masterDNSBackend(i, inbounds); return target ? [Number(target.id)] : []; })])];
}
