import { createContext, useContext } from 'react';
import type { Client, Inbound, JsonObject, RemoteRequest, Server, Status, ServerCapabilities } from '../shared/types';
import type { demoSamples } from './lib/demo';
import type { ServerPolicy } from '../shared/policy';
export type Page = 'account' | 'launch' | 'domains' | 'certificates' | 'storefront' | 'dns' | 'overview' | 'team' | 'testing' | 'telegram' | 'inbounds' | 'clients' | 'groups' | 'services' | 'tunneling' | 'locations' | 'cores' | 'servers' | 'nodes' | 'hosts' | 'outbounds' | 'routing' | 'subscriptions' | 'settings' | 'xray' | 'logs' | 'backups' | 'api' | 'audit';
export interface PanelState {
  administrator?: boolean; demo: boolean; authenticated: boolean; servers: Server[]; server: Server;
  status: Status | null; inbounds: Inbound[]; online: string[] | null;
  capabilities: ServerCapabilities | null;
  policy: ServerPolicy; policyReady: boolean; policyError: string;
  savePolicy: (next: ServerPolicy) => Promise<void>;
  samples: typeof demoSamples; loading: boolean; error: string; lastUpdated: number;
  navigate: (page: Page) => void; selectServer: (id: string) => void;
  remote: <T = unknown>(input: RemoteRequest) => Promise<T>;
  refresh: () => Promise<void>; toast: (message: string, error?: boolean) => void;
  operationMode: 'manual' | 'automatic'; refreshLive: () => Promise<void>;
  confirm: (title: string, description: string, danger?: boolean) => Promise<boolean>;
  openConnect: (server?: Server) => void; reloadServers: () => Promise<Server[]>;
  setDemo: (demo: boolean) => void; signIn: () => void;
}
export const PanelContext = createContext<PanelState | null>(null);
export function usePanel() { const context = useContext(PanelContext); if (!context) throw new Error('Panel provider missing'); return context; }
export function settingsPath(server: Server, section: 'xray' | 'setting', action: string) {
  return `/panel${server.version === 'v3' ? '/api' : ''}/${section}/${action}`;
}
export interface ClientRow extends Client { inboundId: number; inboundName: string; inboundProtocol: string; original: Client; key: string; stream: JsonObject }
