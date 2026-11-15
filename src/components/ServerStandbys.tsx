import { useCallback, useEffect, useState } from 'react';
import { Copy, RefreshCw } from 'lucide-react';
import type { Server } from '../../shared/types';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { usePanel } from '../context';
import { Badge, Button, Modal, Notice } from './ui';
interface Standby { target_id: string; target_name: string; target_revision: number; source_revision: number; enabled: number; phase: string; error: string }
export function ServerStandbys({ source, onClose }: { source: Server; onClose: () => void }) {
  const { servers, confirm, toast } = usePanel();
  const [rows, setRows] = useState<Standby[]>([]), [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const load = useCallback(async () => { setRows(await api<Standby[]>(`/servers/${source.id}/standbys`)); }, [source.id]);
  useEffect(() => { void load().catch(e => setError(e.message)); }, [load]);
  const targets = servers.filter(s => s.id !== source.id && s.kind === 'server' && !rows.some(r => r.target_id === s.id));
  const approve = async () => {
    if (!await confirm('Approve these standby copies?', 'Copy the source’s confirmed native customers, keys, inbounds, cores and routing to selected empty profiles. Their VPN listeners stay disabled until you approve activation. Domains and provider firewall rules need your own cutover.', false)) return;
    setBusy(true); setError(''); const failed: string[] = [];
    for (const id of selected) {
      try { const status = await api<{ revision: number } | null>(`/servers/${id}/control?summary=1`); if (!status) throw new Error('Create or import an empty target profile first.'); await api(`/servers/${source.id}/standbys`, 'POST', { action: 'approve', targetId: id, revision: status.revision }); }
      catch (e) { failed.push(`${servers.find(s => s.id === id)?.name}: ${(e as Error).message}`); }
    }
    setError(failed.join('\n')); setSelected([]); await load().catch(e => setError(e.message)); setBusy(false); if (!failed.length) toast('Standby copies approved. Connect saved targets to fresh VPSs and refresh to check preparation.');
  };
  const action = async (row: Standby, action: string) => {
    if (action === 'activate' && !await confirm('Activate this standby server?', 'Its listeners will start using the source’s latest confirmed configuration. This independent server has its own subscription links. To keep the original identity and existing links, use Replace server instead. Update domains before sending traffic.', false)) return;
    if (action === 'approve' && !await confirm('Resume standby updates?', 'This replaces the target’s saved configuration with a disabled copy of this source, including any independent target edits.', true)) return;
    setBusy(true); setError('');
    try { const status = await api<{ revision: number }>(`/servers/${row.target_id}/control?summary=1`); await api(`/servers/${source.id}/standbys`, 'POST', { action, targetId: row.target_id, revision: status.revision }); await load(); toast(action === 'activate' ? 'Standby activation queued. Check target synchronization before use.' : 'Automatic standby updates paused.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title={t('Standby backups')} description={source.name} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{t('Close')}</Button><Button icon={Copy} variant="primary" busy={busy} disabled={!selected.length} onClick={() => void approve()}>{t('Approve selected backups')}</Button></>}><div className="form-stack">
    <Notice>{t('A standby keeps a copy of your confirmed native configuration. Cores are prepared, but VPN listeners stay off. Only you can approve activation. Primary edits update approved copies in the background; failover is never automatic.')}</Notice>
    <Notice tone="warning">{t('Use empty targets to avoid overwriting customers. Existing 3X-UI workspaces use Import & migrate; a VPS with a private panel uses Replace server to restore both workspaces together.')}</Notice>
    {error && <Notice tone="error">{error}</Notice>}<Button icon={RefreshCw} disabled={busy} onClick={() => void load().catch(e => setError(e.message))}>{t('Refresh status')}</Button>
    {rows.map(row => <section className="card form-stack" key={row.target_id}><div className="button-row"><strong>{row.target_name}</strong><Badge>{row.phase}</Badge></div><p>{t('Source revision')} {row.source_revision} · {t('Target revision')} {row.target_revision}</p>{row.error && <Notice>{row.error}</Notice>}<div className="button-row">{(!row.enabled || row.phase === 'waiting') && <Button disabled={busy} onClick={() => void action(row, 'approve')}>{t('Reapprove backup updates')}</Button>}{row.enabled === 1 && <Button disabled={busy} onClick={() => void action(row, 'pause')}>{t('Pause backup updates')}</Button>}{row.enabled === 1 && row.phase === 'ready' && <Button variant="primary" disabled={busy} onClick={() => void action(row, 'activate')}>{t('Approve activation')}</Button>}</div></section>)}
    <h3>{t('Choose backup servers')}</h3><p className="muted">{t('Create an empty saved server first, or connect and import a fresh native VPS. You can approve multiple targets.')}</p>
    {targets.map(s => <label className="setting-toggle" key={s.id}><span>{s.name}</span><input type="checkbox" disabled={busy} checked={selected.includes(s.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, s.id] : ids.filter(id => id !== s.id))}/></label>)}
  </div></Modal>;
}
