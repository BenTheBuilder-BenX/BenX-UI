import { parseObject, type JsonObject } from './types';

/** 3X-UI can nest traffic inside the client record. Exports and native agents also return it alongside the client. */
export function reportedClientTraffic(detail: JsonObject): JsonObject | undefined {
  const client = parseObject(detail.client ?? detail);
  const reported = detail.traffic ?? client.traffic ?? detail.clientStats ?? detail.stats ?? client.clientStats ?? client.stats;
  if (reported != null) return parseObject(reported);
  if (client.up == null && client.down == null) return undefined;
  return Object.fromEntries(['up', 'down', 'rawUp', 'rawDown', 'lastOnline'].filter(key => client[key] != null).map(key => [key, client[key]]));
}

export function reportedClientExpiry(client: JsonObject, traffic?: JsonObject): number {
  const configured = Number(client.expiryTime || 0), activated = Number(traffic?.expiryTime);
  return configured < 0 && Number.isSafeInteger(activated) && activated > 0 ? activated : configured;
}
