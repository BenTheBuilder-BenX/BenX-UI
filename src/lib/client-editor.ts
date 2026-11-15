import { parseObject, type Client, type JsonObject } from '../../shared/types';
export function hydrateClient(value: unknown): { client: Client; inboundIds: number[]; externalLinks: JsonObject[] } {
  const root = parseObject(value), client = (root.client ? parseObject(root.client) : root) as Client;
  return { client: { ...client, ...(client.uuid ? { id: String(client.uuid) } : {}) }, inboundIds: Array.isArray(root.inboundIds) ? root.inboundIds as number[] : Array.isArray(client.inboundIds) ? client.inboundIds : [], externalLinks: Array.isArray(root.externalLinks) ? root.externalLinks as JsonObject[] : [] };
}
export function clientPayload(client: Client, version: 'v2' | 'v3'): Client {
  return { ...client, ...(version === 'v3' ? { uuid: client.id ?? client.uuid ?? '' } : {}) };
}
export function secretBytes(length = 32) { const bytes = crypto.getRandomValues(new Uint8Array(length)); return btoa(String.fromCharCode(...bytes)); }
export const externalLinksSchema = { type: 'object', fields: { externalLinks: { type: 'array', item: { type: 'object', fields: { kind: { type: 'enum', options: ['link', 'subscription'], default: 'link' }, value: { type: 'string' }, remark: { type: 'string' }, namePrefix: { type: 'string' }, enable: { type: 'boolean', default: true }, expiryTime: { type: 'number', default: 0 } } } } } };
