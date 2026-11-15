import { t as translateUI } from '../lib/i18n';
import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Box, Download, Play, RefreshCw, Plus, ShieldCheck, Square } from 'lucide-react';
import { ServerSetupDialog } from '../components/ServerSetup';
import { coreCatalog } from '../../shared/cores';
import { coreSupport } from '../../shared/core-support';
import type { CoreJob } from '../../shared/types';
import { usePanel } from '../context';
import { Badge, Button, Empty, Notice, PageHeading } from '../components/ui';

export function Cores() {
  const { server, capabilities, remote, refresh, toast, confirm, navigate, demo, reloadServers } = usePanel();
  const [jobs, setJobs] = useState<CoreJob[]>([]), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const completed = useRef(new Set<string>());
  const full = server.kind === 'server' && capabilities?.agent === 'benx-agent' && capabilities.fullAccess;
  useEffect(() => {
    if (!full) return;
    let alive = true;
    const load = async () => { try { const list = await remote<CoreJob[]>({ path: '/benx/v1/jobs', method: 'GET' }); if (alive) { setJobs(list); setError(''); } } catch (e) { if (alive) setError((e as Error).message); } };
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 4000);
    return () => { alive = false; clearInterval(timer); };
  }, [full, remote]);
  useEffect(() => {
    const finished = jobs.filter(j => ['succeeded', 'failed'].includes(j.state) && !completed.current.has(j.id));
    finished.forEach(j => completed.current.add(j.id));
    if (finished.length) void refresh();
  }, [jobs, refresh]);
  const action = async (core: string, verb: string) => {
    if (!await confirm(`${verb[0].toUpperCase() + verb.slice(1)} ${coreCatalog.find(c => c.id === core)?.name}?`, verb === 'install' ? `Install this core ${['masterdnsvpn', 'xray', 'dnsproxy'].includes(core) ? 'from its verified official release' : 'from the server’s configured package repositories'} on ${server.name}.` : `This affects BenX-managed ${core} listeners on ${server.name}. Connected clients may disconnect.`, verb === 'stop')) return;
    setBusy(core); setError('');
    try { const job = await remote<CoreJob>({ path: `/benx/v1/cores/${core}/${verb}`, method: 'POST' }); setJobs(j => [job, ...j.filter(x => x.id !== job.id)]); toast(demo ? 'Core action completed in the demo workspace.' : 'Server action queued. Follow its status below.'); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(''); }
  };
  return <><PageHeading title={translateUI("Cores")} description={translateUI("Install and manage the engines running on your full-access server.")} actions={<>{full && <Button variant="primary" onClick={() => setSetupOpen(true)}>{translateUI("Server setup")}</Button>}<Button icon={RefreshCw} onClick={() => void refresh()}>{translateUI("Refresh")}</Button></>} />
    {!full && <Empty icon={ShieldCheck} title={server.kind === 'server' ? translateUI("Management agent unavailable") : translateUI("Full server access required")} description={server.kind === 'server' ? translateUI("Check the agent connection and its permissions before managing cores.") : translateUI("Choose a full-access server from the top menu to install cores and create additional VPN listeners.")}><Button variant="primary" onClick={() => navigate('servers')}>{translateUI("Manage server connections")}</Button></Empty>}
    {error && <Notice tone="error">{error}</Notice>}
    {full && <div className="summary-bar"><div><ShieldCheck size={16} /><strong>{server.name}</strong><span>{capabilities.platform}</span></div><div><Box size={16} /><strong>{capabilities.cores.filter(c => c.installed).length}</strong><span>{translateUI("installed cores")}</span></div></div>}
    <div className={`core-grid ${!full ? 'locked' : ''}`}>{coreCatalog.map(core => { const state = full ? capabilities.cores.find(c => c.id === core.id) : undefined; const pending = jobs.some(j => j.core === core.id && ['queued', 'running'].includes(j.state)); return <section className="card core-card" key={core.id}><div className="core-card-title"><span className="server-large-icon"><Box size={22} /></span><Badge color={state?.state === 'running' ? 'green' : state?.installed ? 'blue' : 'gray'}>{!full ? translateUI("Requires full access") : state?.installed ? state.state : translateUI("Not installed")}</Badge></div><h3>{core.name}</h3><p>{translateUI(core.description)}</p><div className="core-meta"><span>{state?.version || '—'}</span>{core.docs && <a href={core.docs} target="_blank" rel="noreferrer">{translateUI("Documentation ")}<ArrowUpRight size={12} /></a>}</div>{state?.installed && !state.protocols?.length && <small className="muted">{translateUI("This core is detected, but inbound creation is not supported by this agent yet.")}</small>}{state?.reason && <small className="muted">{state.reason}</small>}<details className="core-support"><summary>{translateUI("Capabilities & limitations")}</summary><p>{translateUI(coreSupport[core.id].accounting)}</p><p>{translateUI(coreSupport[core.id].limits)}</p><Badge color={coreSupport[core.id].shop ? "blue" : "gray"}>{translateUI(coreSupport[core.id].shop ? "Supported shop protocols" : "No automatic shop delivery")}</Badge></details><div className="core-actions">{!state?.installed ? <Button icon={Download} variant="primary" disabled={!full || !state?.installable || pending} busy={busy === core.id} onClick={() => void action(core.id, 'install')}>{pending ? translateUI("Installing…") : translateUI("Install")}</Button> : <><Button icon={state.state === 'running' ? RefreshCw : Play} disabled={pending || !state.instances || !core.protocols.length} busy={busy === core.id} onClick={() => void action(core.id, state.state === 'running' ? 'restart' : 'start')}>{state.state === 'running' ? translateUI("Restart") : translateUI("Start")}</Button><Button icon={Square} disabled={pending || !state.instances} onClick={() => void action(core.id, 'stop')}>{translateUI("Stop")}</Button><Button icon={Plus} variant="primary" disabled={!state.protocols?.length} onClick={() => { if (core.id === 'dnsproxy') { navigate('dns'); return; } navigate('inbounds'); location.hash = `inbounds?core=${encodeURIComponent(core.id)}`; }}>{core.id === 'dnsproxy' ? translateUI("Configure DNS") : translateUI("Add inbound")}</Button></>}</div></section>; })}</div>
    {full && jobs.length > 0 && <section className="card core-jobs"><div className="card-heading"><h3>{translateUI("Server activity")}</h3><Badge>{demo ? translateUI("Demo actions") : translateUI("Management agent")}</Badge></div>{jobs.map(j => <div key={j.id} className="core-job"><div><strong>{j.core} · {j.action}</strong><small>{j.message}</small></div><Badge color={j.state === 'failed' ? 'red' : j.state === 'succeeded' ? 'green' : 'orange'}>{j.state}</Badge></div>)}</section>}
    {setupOpen && <ServerSetupDialog onClose={() => { setSetupOpen(false); void refresh(); void reloadServers(); }} />}
  </>;
}

