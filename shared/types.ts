export type JsonObject = Record<string, unknown>;
export type ApiVersion = 'v2' | 'v3';
export interface Server {
  id: string; name: string; url: string; version: ApiVersion; kind: 'panel' | 'gateway' | 'server';
  auth: 'token' | 'password'; location: string; subscription_url: string;
  enabled: number; created_at: number; online?: number; latency?: number; last_checked?: number;
  parent_id?: string | null;
  managed?: number; bound?: number; sync_phase?: string; desired_revision?: number; applied_revision?: number;
}
export interface ServerInput {
  name: string; url: string; version: ApiVersion; kind: 'panel' | 'gateway' | 'server';
  auth: 'token' | 'password'; location: string; subscription_url: string;
  username?: string; password?: string; token?: string;
  accessId?: string; accessSecret?: string; enabled?: boolean;
}
export interface Client extends JsonObject {
  id?: string; email: string; password?: string; auth?: string; secret?: string;
  enable: boolean; totalGB: number; expiryTime: number; limitIp: number; limitHwid?: number;
  subId?: string; tgId?: string | number; flow?: string; comment?: string;
  up?: number; down?: number; inboundId?: number; inboundIds?: number[];
}
export interface Inbound extends JsonObject {
  id: number; remark: string; enable: boolean; port: number; protocol: string; listen: string;
  up: number; down: number; total: number; expiryTime: number;
  settings: string | JsonObject; streamSettings: string | JsonObject; sniffing: string | JsonObject;
  clientStats?: Client[];
}
export interface Status {
  cpu: number; cpuCores?: number; logicalPro?: number; cpuSpeedMhz?: number;
  mem: { current: number; total: number }; swap: { current: number; total: number };
  disk: { current: number; total: number }; xray: { state: string; version: string; errorMsg?: string };
  netIO: { up: number; down: number }; netTraffic: { sent: number; recv: number };
  tcpCount: number; udpCount: number; uptime: number;
  appStats?: { mem: number; threads: number; uptime: number }; publicIP?: { ipv4?: string; ipv6?: string };
}
export interface Health { timestamp: number; online: number; latency: number; snapshot: string | null; error: string | null }
export interface Audit { id: number; timestamp: number; actor: string; server_id: string | null; action: string; success: number }
export interface Operation {
  path: string; method: string; group: string; summary: string; encoding: string;
  parameters: Array<{ name: string; in: string; required?: boolean; description?: string; schema?: JsonObject }>;
  schema: JsonObject; example: JsonObject; version: string;
}
export interface RemoteRequest { path: string; method: string; body?: JsonObject; encoding?: string; query?: Record<string, string> }
export interface CoreState { id: string; installed: boolean; state: string; version: string; installable: boolean; reason?: string; instances: number; protocols?: string[] }
export interface ServerCapabilities { agent: string; version: string; fullAccess: boolean; platform: string; cores: CoreState[]; features: string[]; policyRevision?: number }
export interface CoreJob { id: string; core: string; action: string; state: 'queued' | 'running' | 'succeeded' | 'failed'; message: string; createdAt: number }
export function parseObject(value: unknown): JsonObject {
  if (typeof value === 'string') {
    try { return parseObject(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}
export function inboundClients(inbound: Inbound): Client[] {
  const clients = parseObject(inbound.settings).clients;
  return Array.isArray(clients) ? clients as Client[] : [];
}
