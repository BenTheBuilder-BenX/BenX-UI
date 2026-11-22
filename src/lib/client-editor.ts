import { parseObject, type Client, type JsonObject } from '../../shared/types';
import { clientExpiry } from '../../shared/client-expiry';
export function hydrateClient(value: unknown, expectedEmail?: string): { client: Client; inboundIds: number[]; externalLinks: JsonObject[] } {
  const root = parseObject(value), client = (root.client ? parseObject(root.client) : root) as Client;
  const ids = root.inboundIds !== undefined ? root.inboundIds : client.inboundIds;
  if (expectedEmail !== undefined && (client.email !== expectedEmail || ids !== null && (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id <= 0)))) {
    throw new Error('The server returned invalid data. Please retry.');
  }
  const links = root.externalLinks ?? client.externalLinks;
  const hydrated: Client = { ...client, ...(client.uuid ? { id: String(client.uuid) } : {}) };
  // Native detail reports the active deadline. An edit must retain the configured first-use duration.
  const activation = parseObject(client._firstUse), duration = activation.duration;
  if (expectedEmail !== undefined && typeof duration === 'number' && duration < 0 && client.expiryTime > 0
      && clientExpiry({ ...client, expiryTime: duration }, activation) === client.expiryTime) hydrated.expiryTime = duration;
  return {
    client: hydrated,
    inboundIds: Array.isArray(ids) ? ids : [],
    externalLinks: Array.isArray(links) ? links.map(link => typeof link === 'string' ? { kind: 'link', value: link } : link) : [],
  };
}
export function clientPayload(client: Client, version: 'v2' | 'v3', nativeInboundIds?: number[]): Client {
  if (version === 'v2') return { ...client };
  const payload: Client = { ...client, uuid: client.id ?? client.uuid ?? '' };
  delete payload.traffic;
  delete payload._firstUse;
  delete payload._quotaBlocked;
  delete payload.externalLinks;
  if (nativeInboundIds) payload.inboundIds = nativeInboundIds;
  else delete payload.inboundIds;
  return payload;
}
export function secretBytes(length = 32) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return btoa(String.fromCharCode(...bytes)); }
export const externalLinksSchema = { type: 'object', fields: { externalLinks: { type: 'array', item: { type: 'object', fields: { kind: { type: 'enum', options: ['link', 'subscription'], default: 'link' }, value: { type: 'string' }, remark: { type: 'string' }, namePrefix: { type: 'string' }, enable: { type: 'boolean', default: true }, expiryTime: { type: 'number', default: 0 } } } } } };
