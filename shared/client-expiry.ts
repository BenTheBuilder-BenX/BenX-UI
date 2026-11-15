import { parseObject, type JsonObject } from './types';
export function clientExpiry(client: JsonObject, firstUse: unknown): number {
  const duration=Number(client.expiryTime || 0), activation=parseObject(firstUse);
  if(duration>=0)return duration;
  return activation.duration===duration && activation.identity===(client.firstUseId || client.id || client.uuid) && Number(activation.startedAt)>0 ? Number(activation.startedAt)-duration : duration;
}
