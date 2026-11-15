import { useEffect, useState } from 'react';
import { ArrowRight, Check, Download, KeyRound, Network, RefreshCw, Server, ShieldCheck, Terminal } from 'lucide-react';
import { defaultSetup, type AgentSetupResponse, type SetupPlan, type SetupStatus } from '../../shared/setup';
import type { ServerCapabilities } from '../../shared/types';
import { usePanel } from '../context';
import { api, panelRequest } from '../lib/api';
import { t } from '../lib/i18n';
import { Badge, Button, Field, Modal, Notice } from './ui';
import { SetupOptions, SetupProgress } from './ServerSetup';

export function ConnectionMethodDialog({ onClose, onChoose }: { onClose: () => void; onChoose: (method: 'outbound' | 'ssh' | 'https' | 'panel') => void }) {
  return <Modal title={t('Connect your VPS')} description={t('One workspace for your servers, customers and shop. Choose how this VPS connects.')} wide onClose={onClose}>
    <div className="connect-methods">
      <button className="connect-method recommended" onClick={() => onChoose('outbound')}><span className="launch-icon"><Server size={24} /></span><Badge color="blue">{t('Recommended')}</Badge><h3>{t('Direct agent connection')}</h3><p>{t('Install a private agent once. Your VPS contacts this Worker over HTTPS; BenX installs and manages your chosen cores.')}</p><strong>{t('Connect a fresh VPS')} <ArrowRight size={16} /></strong><small>{t('No additional panel or shared SSH relay required.')}</small></button>
      <button className="connect-method" onClick={() => onChoose('ssh')}><span className="launch-icon"><KeyRound size={24} /></span><h3>{t('Automatic SSH installation')}</h3><p>{t('Check the host fingerprint, authenticate, then install from the panel using your own configured SSH relay.')}</p><strong>{t('Use SSH setup')} <ArrowRight size={16} /></strong><small>{t('Requires a private HTTPS SSH relay.')}</small></button>
    </div>
    <details className="launch-advanced"><summary>{t('Existing installations & advanced connections')}</summary><div className="button-row"><Button icon={Network} onClick={() => onChoose('https')}>{t('Connect an HTTPS agent')}</Button><Button icon={Terminal} onClick={() => onChoose('panel')}>{t('Import or connect 3X-UI')}</Button></div><p className="muted">{t('Existing panels stay separate. Import and review their configuration before migration.')}</p></details>
  </Modal>;
}

export function OutboundEnrollment({ onClose, onBack, onSaved, resumeId }: { resumeId?: string; onClose: () => void; onBack: () => void; onSaved: (id: string) => Promise<void> }) {
  const { authenticated, signIn, reloadServers, setDemo } = usePanel();
  const [name, setName] = useState(''), [location, setLocation] = useState(''), [plan, setPlan] = useState<SetupPlan>(structuredClone(defaultSetup));
  const [enrollment, setEnrollment] = useState<{ id: string; script: string; expiresAt: number; pollSeconds: number }>(), [paired, setPaired] = useState(false);
  const [status, setStatus] = useState<SetupStatus>(), [verified, setVerified] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const create = async () => {
    setBusy(true); setError('');
    try { const result = await api<{ id: string; script: string; expiresAt: number; pollSeconds: number }>('/enrollments', 'POST', resumeId || enrollment ? { id: resumeId || enrollment?.id } : { name, location, plan }); setEnrollment(result); setVerified(false); setStatus(undefined); await reloadServers(); setDemo(false); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!enrollment) return;
    let alive = true, loading = false;
    const load = async () => { if (loading) return; loading = true; try { const rows = await api<Array<{ server_id: string; state: string; last_seen: number }>>('/enrollments'); if (alive) setPaired(rows.some(r => r.server_id === enrollment.id && r.state === 'connected' && r.last_seen > Date.now() - 90000)); } catch (e) { if (alive) setError((e as Error).message); } finally { loading = false; } };
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [enrollment]);
  const verify = async () => {
    if (!enrollment) return;
    setBusy(true); setError('');
    try {
      const capabilities = await panelRequest<ServerCapabilities>(enrollment.id, { path: '/benx/v1/capabilities', method: 'GET' });
      if (capabilities.agent !== 'benx-agent' || !capabilities.fullAccess) throw new Error('Agent did not confirm management access.');
      setVerified(true);
      const setup = await panelRequest<AgentSetupResponse>(enrollment.id, { path: '/benx/v1/setup', method: 'GET' });
      setStatus(setup.job);
      await reloadServers();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const download = () => { if (!enrollment) return; const url = URL.createObjectURL(new Blob([enrollment.script], { type: 'text/x-shellscript' })); const a = document.createElement('a'); a.href = url; a.download = 'benx-connect.sh'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  return <Modal title={t(resumeId ? 'Repair agent pairing' : 'Direct agent connection')} description={t('Check reachability → pair agent → install cores → verify a client.')} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={enrollment ? onClose : onBack}>{t(enrollment ? 'Close · agent keeps working' : 'Back')}</Button>{!enrollment ? <Button icon={ShieldCheck} variant="primary" busy={busy} disabled={!authenticated || !resumeId && !name.trim()} onClick={() => void create()}>{t(resumeId ? 'Prepare repair installer' : 'Prepare private installer')}</Button> : <><Button icon={RefreshCw} busy={busy} disabled={!paired} onClick={() => void verify()}>{t('Verify agent & setup')}</Button><Button variant="primary" disabled={!verified || !paired || busy} onClick={() => void onSaved(enrollment.id)}>{t('Manage server')}</Button></>}</>}>
    <div className="form-stack">{error && <Notice tone="error">{error}</Notice>}{!authenticated && <Notice><button className="text-link" onClick={signIn}>{t('Sign in')}</button> {t('to pair a real VPS. This preview never installs anything.')}</Notice>}
      {!enrollment ? <>{resumeId ? <Notice>{t("Renew the pairing secret for this exact agent. Run the downloaded repair installer on the same VPS. It preserves the node identity, installed cores and saved configuration, and refuses a different installation.")}</Notice> : <div className="form-grid"><Field label={t('Server name')}><input value={name} maxLength={80} onChange={e => setName(e.target.value)} placeholder={t('Frankfurt · Primary')} /></Field><Field label={t('Location')}><input value={location} maxLength={100} onChange={e => setLocation(e.target.value)} placeholder="Frankfurt, Germany" /></Field></div>}<Notice>{t('Use a public HTTPS Worker address and a fresh Debian 12/13 or Ubuntu 24.04/26.04 VPS. Run the reviewed installer once in your provider console or SSH session. Management then works through outbound HTTPS.')}</Notice>{!resumeId && <SetupOptions plan={plan} onChange={setPlan} nativeOnly />}</> : <><div className="setup-stages"><span className="done"><i><Check size={14} /></i>{t('Installer prepared')}</span><span className={paired ? 'done' : 'active'}><i>2</i>{t('Pair VPS')}</span><span className={verified ? 'done' : ''}><i>3</i>{t('Verify setup')}</span></div><section className="setup-option-box form-stack"><h3>{t('Install once on your VPS')}</h3><p>{t('Download this private script, inspect it, upload it to your VPS, then run:')}</p><pre className="launch-code" dir="ltr">sudo sh benx-connect.sh</pre><div className="button-row"><Button icon={Download} variant="primary" onClick={download}>{t('Download private installer')}</Button>{!paired && <Button disabled={busy} onClick={() => void create()}>{t("Renew private installer")}</Button>}<Badge color={paired ? 'green' : 'orange'}>{t(paired ? 'Agent connected' : 'Waiting for VPS')}</Badge></div><small className="muted">{t('Pairing expires at')} {new Date(enrollment.expiresAt).toLocaleTimeString()}. {t('Keep the installer private and delete it after pairing. An existing agent can only renew pairing for this same identity; its configuration is preserved.')}</small></section><Notice>{t('The installer checks authenticated HTTPS reachability before making changes. It adds no public management port. This agent checks for work every {0} seconds when idle; installation and network latency still take time.', enrollment.pollSeconds)}</Notice>{status && <SetupProgress status={status} />}{verified && <Notice tone="warning">{t('Agent access is verified. Test an exported profile on a real client before selling access; pairing alone does not verify VPN traffic.')}</Notice>}</>}
    </div>
  </Modal>;
}
