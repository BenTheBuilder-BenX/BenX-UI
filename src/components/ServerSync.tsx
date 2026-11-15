import { t as translateUI } from '../lib/i18n';
import { workspaceHeaders } from '../lib/api';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRightLeft, Check, Cloud, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import type { Server } from '../../shared/types';
import { usePanel } from '../context';
import { api } from '../lib/api';
import { download } from '../lib/format';
import { Badge, Button, Field, Modal, Notice, Select } from './ui';

export interface ManagedServer extends Server {
  managed?: number;
  bound?: number;
  sync_phase?: string;
  desired_revision?: number;
  applied_revision?: number;
}
interface ControlStatus {
  requested_revision?: number;
  revision: number;
  applied_revision: number;
  phase: string;
  error?: string | null;
  warning?: string;
  bound: number | boolean;
  updated_at?: number;
  checked_at?: number;
  replacement?: { candidate_id: string; state: string; error?: string | null } | null;
}
export function synchronizationLabel(server: ManagedServer) {
  if (server.bound === 0) return 'Saved · no VPS';
  if (!server.managed) return 'Import to manage settings';
  if (server.sync_phase === 'failed' || server.sync_phase === 'error') return 'Needs attention';
  if (['applying', 'running', 'syncing'].includes(server.sync_phase ?? '')) return 'Applying settings';
  if (server.sync_phase === 'synced' && server.desired_revision && server.desired_revision === server.applied_revision) return 'Up to date';
  return 'Waiting to synchronize';
}

export function ServerSyncDialog({ server, onClose, onReplace, onSetup }: {
  server: ManagedServer;
  onClose: () => void;
  onReplace: () => void;
  onSetup: (id: string) => void;
}) {
  const { servers, demo, authenticated, confirm, toast, reloadServers, signIn, administrator, operationMode } = usePanel();
  const [status, setStatus] = useState<ControlStatus | null>(), [error, setError] = useState(''), [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(''), [sourceId, setSourceId] = useState('');
  const [importDocument, setImportDocument] = useState<unknown>(), [fileName, setFileName] = useState('');
  const pollCadence = useRef({ last: 0, phase: '', submitted: false });
  const live = authenticated && !demo;
  const load = useCallback(async () => {
    if (!live) return;
    const result = await api<ControlStatus | null>(`/servers/${server.id}/control`);
    setStatus(result);
    return result;
  }, [live, server.id]);
  useEffect(() => {
    if (!live) return;
    let alive = true, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try { const result = await api<ControlStatus | null>(`/servers/${server.id}/control?summary=1`); if (alive) { setStatus(previous => result ? { ...previous, ...result } : null); pollCadence.current = { last: Date.now(), phase: result?.phase || '', submitted: Boolean(result && Number(result.requested_revision || 0) >= result.revision && result.phase !== 'synced') }; setLoadError(''); } }
      catch (e) { if (alive) setLoadError((e as Error).message); }
      finally { polling = false; }
    };
    void poll();
    const timer = setInterval(() => { if(operationMode==='manual' && !pollCadence.current.submitted)return; const interval = ['pending', 'applying', 'running'].includes(pollCadence.current.phase) ? 15000 : 60000; if (!document.hidden && Date.now() - pollCadence.current.last >= interval) void poll(); }, 15000);
    return () => { alive = false; clearInterval(timer); };
  }, [live, server.id, operationMode]);
  const bound = status ? Boolean(status.bound) : server.bound !== 0;
  const revision = status?.revision ?? server.desired_revision ?? 0;
  const applied = status?.applied_revision ?? server.applied_revision ?? 0;
  const sources = servers.filter(s => s.id !== server.id && s.enabled && (s as ManagedServer).bound !== 0 && (server.kind === 'server' ? s.kind === 'server' : s.kind !== 'server' && s.version === server.version));
  const run = async (action: string, task: () => Promise<void>) => {
    setBusy(action); setError('');
    try { await task(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  const sync = () => run('sync', async () => {
    await api(`/servers/${server.id}/control`, 'POST', { action: 'sync', revision });
    await load(); await reloadServers(); toast('Saved settings queued for this server.');
  });
  const importState = async (source: 'current' | 'panel' | 'file') => {
    const name = source === 'file' ? `the file “${fileName}”` : source === 'panel' ? `“${sources.find(s => s.id === sourceId)?.name ?? 'the selected server'}”` : 'this server';
    if (!await confirm(`Import configuration from ${name}?`, `${revision ? 'This replaces the current saved configuration. ' : ''}BenX-UI will become the source of settings for this server. Future synchronization applies the saved configuration to the VPS.`, Boolean(revision))) return;
    await run('import', async () => {
      await api(`/servers/${server.id}/control`, 'POST', { action: 'import', revision, ...(source === 'panel' ? { sourceId } : source === 'file' ? { document: importDocument } : {}) });
      await load(); await reloadServers(); setImportDocument(undefined); setFileName(''); toast('Configuration imported into BenX-UI. Review synchronization status.');
    });
  };
  const exportState = () => run('export', async () => {
    const response = await fetch(`/api/servers/${server.id}/control`, { method: 'POST', credentials: 'same-origin', headers: { ...workspaceHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'export', revision }) });
    if (!response.ok) {
      let message = 'Configuration export failed.';
      try { const result = await response.json() as { msg?: string }; if (result.msg) message = result.msg; } catch { /* Keep the response-independent error. */ }
      throw new Error(message);
    }
    download(`benx-${server.name.replace(/[^a-z0-9_-]/gi, '-').slice(0, 60)}-${new Date().toISOString().slice(0, 10)}.json`, await response.blob());
    toast('Saved configuration exported. Keep this file private.');
  });
  const chooseFile = async (file?: File) => {
    setImportDocument(undefined); setFileName(''); setError('');
    if (!file) return;
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error('Choose a configuration file smaller than 10 MB.');
      const document = JSON.parse(await file.text()) as unknown;
      if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error('Choose an exported BenX-UI configuration JSON object.');
      setImportDocument(document); setFileName(file.name);
    } catch (e) { setError((e as Error).message); }
  };
  const retryReplacement = () => run('replacement', async () => {
    await api(`/servers/${server.id}/replacement`, 'POST', { action: 'retry' });
    await load(); await reloadServers(); toast('Replacement restore checked. Review its status before switching.');
  });
  const cutover = async () => {
    if (!await confirm('Switch to the replacement VPS?', 'BenX-UI will manage the replacement using this server’s saved identity and configuration. Point any public DNS or external firewall rules to the new VPS.')) return;
    await run('cutover', async () => {
      await api(`/servers/${server.id}/replacement`, 'POST', { action: 'cutover' });
      await load(); await reloadServers(); toast('Replacement VPS is now connected to this saved server.');
    });
  };
  const phase = status?.phase ?? server.sync_phase;
  const synced = revision > 0 && revision === applied && phase === 'synced';
  return <Modal title={translateUI("Synchronization · {0}", server.name)} description={translateUI("BenX-UI keeps your saved settings and applies them to the connected VPS.")} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={Boolean(busy)} onClick={onClose}>{translateUI("Close")}</Button><Button icon={RefreshCw} busy={busy === 'sync'} disabled={!live || Boolean(busy) || !bound || !revision} variant="primary" onClick={() => void sync()}>{translateUI("Apply BenX-UI → server")}</Button></>}>
    <div className="form-stack">
      {!live && <Notice>{demo ? translateUI("Demo preview: synchronization and replacement require a connected server in the live workspace.") : <>{translateUI("Preview synchronization here.")} <button className="text-link" onClick={signIn}>{translateUI("Sign in")}</button> {translateUI("to manage a real server.")}</>}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {loadError && loadError !== error && <Notice tone="error">{loadError}</Notice>}
      {status?.error && status.error !== error && <Notice tone="error">{status.error}</Notice>}
      {status?.warning && <Notice tone="warning">{status.warning}</Notice>}
      <section className="setup-review"><div className="setup-section-title"><Cloud size={18} /><h3>{translateUI("Saved server configuration")}</h3><Badge color={!bound ? 'gray' : synced ? 'green' : phase === 'failed' || phase === 'error' ? 'red' : 'blue'}>{!bound ? translateUI("No VPS connected") : synced ? translateUI("Up to date") : phase?.replace(/[-_]/g, ' ') || (translateUI("Not imported yet"))}</Badge></div><dl><dt>{translateUI("Saved revision")}</dt><dd>{revision || (translateUI("No configuration saved"))}</dd><dt>{translateUI("Applied on VPS")}</dt><dd>{bound ? applied || (translateUI("Not applied yet")) : translateUI("Connect a VPS to restore these settings")}</dd><dt>{translateUI("Last checked")}</dt><dd>{status?.checked_at ? new Date(status.checked_at).toLocaleString() : '—'}</dd><dt>{translateUI("Last changed")}</dt><dd>{status?.updated_at ? new Date(status.updated_at).toLocaleString() : '—'}</dd></dl></section>
      <Notice tone={revision ? 'info' : 'warning'}>{revision ? translateUI("Edits made here update the saved configuration. Synchronization reapplies that configuration when the server changes or returns online. Import an existing panel explicitly before adopting its settings.") : translateUI("Import the existing server or a configuration file to save its settings in BenX-UI. A saved server can be configured before a VPS is connected.")}</Notice>
      {!administrator && status?.replacement && <section className="setup-option-box"><div className="setup-section-title"><ArrowRightLeft size={18} /><strong>{translateUI("Replacement VPS")}</strong><Badge color={status.replacement.state === 'failed' ? 'red' : ['ready', 'completed'].includes(status.replacement.state) ? 'green' : 'blue'}>{status.replacement.state.replace(/[-_]/g, ' ')}</Badge></div><p>{translateUI("The replacement is prepared from this saved server configuration. Check the restore, then switch when it is ready.")}</p>{status.replacement.error && <Notice tone="error">{status.replacement.error}</Notice>}<div className="button-row">{status.replacement.state !== 'completed' && <><Button icon={RefreshCw} disabled={!live || Boolean(busy)} onClick={() => onSetup(status.replacement!.candidate_id)}>{translateUI("Open installation progress")}</Button><Button icon={RefreshCw} busy={busy === 'replacement'} disabled={!live || Boolean(busy)} onClick={() => void retryReplacement()}>{translateUI("Check restore / retry")}</Button></>}{status.replacement.state === 'ready' && <Button variant="primary" icon={ArrowRightLeft} busy={busy === 'cutover'} disabled={!live || Boolean(busy)} onClick={() => void cutover()}>{translateUI("Switch to replacement")}</Button>}</div></section>}
      {!administrator && <section className="setup-option-box"><div className="setup-section-title"><ShieldCheck size={18} /><strong>{bound ? translateUI("Restore BenX-UI → fresh VPS") : translateUI("Connect this saved server to a VPS")}</strong></div><p>{bound ? translateUI("Install the required features on a fresh VPS and restore this saved configuration. BenX-UI keeps this server’s identity and settings.") : translateUI("Your settings stay in BenX-UI. Connect a fresh VPS to install its required features and apply the saved configuration.")}</p>{server.kind === 'server' ? <Button icon={ArrowRightLeft} disabled={!live || Boolean(busy) || Boolean(status?.replacement && !['failed', 'completed', 'cancelled'].includes(status.replacement.state))} onClick={onReplace}>{bound ? translateUI("Replace server") : translateUI("Connect VPS")}</Button> : <Notice>{server.parent_id ? translateUI("Replace the parent VPS from Servers. This managed 3X-UI workspace and its saved settings follow that replacement.") : translateUI("Standalone panel access can import and synchronize panel settings. Automatic VPS replacement requires a full-access parent server.")}</Notice>}</section>}
      <section className="setup-option-box"><div className="setup-section-title"><Upload size={18} /><strong>{translateUI("Read server → BenX-UI")}</strong></div><p>{translateUI("This reads existing clients, inbounds and supported settings from the server. It replaces the saved BenX-UI profile for this server; it does not install on a new VPS. Export a backup first if you already have saved edits.")}</p><div className="button-row"><Button icon={Upload} busy={busy === 'import'} disabled={!live || Boolean(busy) || !bound} onClick={() => void importState('current')}>{translateUI("Read current server into BenX-UI")}</Button></div>{sources.length > 0 && <><Field label={server.kind === 'server' ? translateUI("Existing full-access server") : translateUI("Existing compatible panel")}><Select aria-label={translateUI("Migration source server")} value={sourceId} disabled={Boolean(busy)} onChange={e => setSourceId(e.target.value)}><option value="">{translateUI("Choose a connected ")}{server.kind === 'server' ? translateUI("BenX server") : translateUI("3X-UI {0} panel", server.version === 'v3' ? '3.x' : '2.x')}</option>{sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><Button icon={Upload} disabled={!live || Boolean(busy) || !sourceId} onClick={() => void importState('panel')}>{translateUI("Import selected ")}{server.kind === 'server' ? translateUI("server") : translateUI("panel")}</Button></>}{server.kind === 'server' && <small className="muted">{translateUI("Native profiles require a BenX server export. Import 3X-UI data in its panel workspace to preserve all panel options.")}</small>}<Field label={translateUI("Restore exported configuration")} hint={translateUI("Choose a BenX-UI configuration JSON file. Files may contain private keys and client credentials.")}><input type="file" accept="application/json,.json" disabled={!live || Boolean(busy)} onChange={e => void chooseFile(e.target.files?.[0])} /></Field>{fileName && <div className="button-row"><Badge><Check size={12} />{fileName}</Badge><Button icon={Upload} disabled={!live || Boolean(busy) || !importDocument} onClick={() => void importState('file')}>{translateUI("Import this file")}</Button></div>}</section>
      <section className="setup-option-box"><div className="setup-section-title"><ArrowDownToLine size={18} /><strong>{translateUI("Configuration backup")}</strong></div><p>{translateUI("The export contains credentials and private configuration. Store it securely and only share it with trusted administrators.")}</p><Button icon={ArrowDownToLine} busy={busy === 'export'} disabled={!live || Boolean(busy) || !revision} onClick={() => void exportState()}>{translateUI("Export saved configuration")}</Button></section>
    </div>
  </Modal>;
}
