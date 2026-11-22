import { t as translateUI } from '../lib/i18n';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Copy, Download, Edit3, Eye, Plus, QrCode, RotateCcw, Search, Trash2, Users, X } from 'lucide-react';
import QRCode from 'qrcode';
import { inboundClients, parseObject, type Client, type Inbound } from '../../shared/types';
import { primaryAttachmentIds } from '../../shared/masterdns';
import { reportedClientExpiry, reportedClientTraffic } from '../../shared/client-usage';
import { usePanel, type ClientRow } from '../context';
import { Button, Empty, Field, IconButton, Modal, Notice, PageHeading, Select, Switch, Tabs } from '../components/ui';
import { bytes, download, expiry, GiB, pretty } from '../lib/format';
import { shareLink } from '../lib/links';
import { hydrateClient, clientPayload, secretBytes, externalLinksSchema } from '../lib/client-editor';
import { ClientSubscriptionShare } from '../components/ClientSubscriptionShare';
import { AttachmentPicker } from '../components/AttachmentPicker';
import { effectiveMultiplier, serviceClientFields, serviceIds, type ClientPolicy } from '../../shared/policy';
import { JsonOption, OptionsEditor } from '../components/OptionsEditor';

export function makeClientRows(inbounds: Inbound[]): ClientRow[] {
  return inbounds.flatMap(inbound => {
    const traffic = new Map<string, Client>();
    for (const stat of inbound.clientStats ?? []) {
      if (!traffic.has(stat.email)) traffic.set(stat.email, stat);
    }
    const stream = parseObject(inbound.streamSettings);
    return inboundClients(inbound).map(c => {
      const stats = traffic.get(c.email);
      return { ...c, expiryTime: reportedClientExpiry(c, stats), up: stats?.up ?? 0, down: stats?.down ?? 0, inboundId: inbound.id, inboundName: inbound.remark, inboundProtocol: inbound.protocol, original: c, key: `${inbound.id}-${c.email}`, stream };
    });
  });
}
export function Clients() {
  const { inbounds, server, remote, refresh, confirm, toast, online, policy, policyReady, savePolicy, demo } = usePanel();
  const [directory, setDirectory] = useState<unknown[]>([]), [directoryError, setDirectoryError] = useState(''), [accountingError, setAccountingError] = useState('');
  useEffect(() => {
    if (demo || !server.id || server.version !== 'v3') return;
    let alive = true;
    void remote<unknown[]>({ path: '/panel/api/clients/list', method: 'GET' }).then(rows => {
      if (!Array.isArray(rows)) throw new Error('The server returned invalid data. Please retry.');
      if (alive) { setDirectory(rows); setDirectoryError(''); }
    }).catch(e => {
      if (alive) { setDirectory([]); setDirectoryError(e.message); }
    });
    if (server.kind === 'server' && server.bound !== 0) {
      void remote<{ errors: Record<string, string> }>({ path: '/benx/v1/accounting', method: 'GET' }).then(result => {
        if (alive) setAccountingError(Object.keys(result.errors || {}).length ? 'Some listener counters are unavailable. Check or save the affected listeners before relying on weighted quota enforcement.' : '');
      }).catch(e => { if (alive) setAccountingError(e.message); });
    }
    return () => { alive = false; };
  }, [demo, server.id, server.version, server.kind, server.bound, remote, inbounds]);
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [inboundFilter, setInboundFilter] = useState('all'), [create, setCreate] = useState(false);
  const [selected, setSelected] = useState<string[]>([]), [busy, setBusy] = useState(false);
  const rows = useMemo(() => {
    const all = makeClientRows(inbounds); if (server.version !== 'v3') return all;
    const map = new Map<string, ClientRow>();
    for (const c of all) {
      const previous = map.get(c.email);
      map.set(c.email, { ...c, key: `client:${c.email}`, up: Math.max(c.up || 0, previous?.up || 0), down: Math.max(c.down || 0, previous?.down || 0) });
    }
    for (const value of directory) {
      const detail = parseObject(value), { client } = hydrateClient(detail);
      if (!client.email) continue;
      const previous = map.get(client.email), traffic = reportedClientTraffic(detail);
      map.set(client.email, {
        ...(previous || { inboundId: 0, inboundName: 'No attachments', inboundProtocol: '', stream: {} }),
        ...client, original: client, key: `client:${client.email}`, expiryTime: reportedClientExpiry(client, traffic),
        up: Number(traffic?.up ?? previous?.up ?? 0), down: Number(traffic?.down ?? previous?.down ?? 0),
      });
    }
    return [...map.values()];
  }, [inbounds, server.version, directory]);
  const attachments = useMemo(() => {
    const byEmail = new Map<string, Inbound[]>();
    for (const inbound of inbounds) {
      for (const { email } of inboundClients(inbound)) {
        const list = byEmail.get(email);
        if (list) list.push(inbound); else byEmail.set(email, [inbound]);
      }
    }
    return byEmail;
  }, [inbounds]);
  const onlineEmails = useMemo(() => new Set(online), [online]);
  const query = search.trim().toLowerCase(), inboundId = Number(inboundFilter);
  const visible = rows.filter(c => {
    const attached = attachments.get(c.email);
    const matchesText = !query || `${c.email} ${c.comment ?? ''} ${c.inboundName}`.toLowerCase().includes(query)
      || server.version === 'v3' && attached?.some(i => (i.remark || '').toLowerCase().includes(query));
    const matchesInbound = inboundFilter === 'all' || (server.version === 'v3' ? attached?.some(i => i.id === inboundId) : c.inboundId === inboundId);
    return matchesText && matchesInbound && (filter === 'all' || filter === 'enabled' && c.enable || filter === 'disabled' && !c.enable || filter === 'online' && onlineEmails.has(c.email));
  });
  const bulk = async (mode: 'reset' | 'delete') => {
    const picked = rows.filter(c => selected.includes(c.key));
    if (!picked.length || !await confirm(mode === 'delete' ? `Delete ${picked.length} client attachment(s)?` : 'Reset selected client traffic?', server.version === 'v3' && mode === 'delete' ? 'In 3X-UI 3.x, deleting a client removes it from every attached inbound.' : 'This affects the selected clients on this server.')) return;
    setBusy(true); let completed = 0; const removed: string[] = [];
    try {
      const seen = new Set<string>();
      for (const c of picked) {
        if (server.version === 'v3' && seen.has(c.email)) continue; seen.add(c.email);
        const path = server.version === 'v3' ? `/panel/api/clients/${mode === 'delete' ? 'del' : 'resetTraffic'}/${encodeURIComponent(c.email)}` : mode === 'delete' ? `/panel/api/inbounds/${c.inboundId}/delClient/${encodeURIComponent(clientIdentifier(c))}` : `/panel/api/inbounds/${c.inboundId}/resetClientTraffic/${encodeURIComponent(c.email)}`;
        await remote({ path, method: 'POST' }); completed++;
        if (mode === 'delete' && server.version === 'v3') removed.push(c.email);
      }
      toast(`Completed for ${completed} client(s).`); setSelected([]);
    } catch (e) { toast(`Completed ${completed} before the operation stopped. ${(e as Error).message}`, true); } finally { if (removed.length) { const clients = { ...policy.clients }; for (const email of removed) delete clients[email]; try { await savePolicy({ ...policy, clients }); } catch (e) { toast(`Clients removed; service policy cleanup failed: ${(e as Error).message}`, true); } } setBusy(false); await refresh(); }
  };
  return <><PageHeading title={translateUI("Clients")} description={translateUI("Manage access, traffic limits, subscriptions, and expiry dates.")} actions={<><Button icon={Download} onClick={() => download('benx-clients.json', pretty(rows.map(c => c.original)))}>{translateUI("Export")}</Button><Button icon={Plus} variant="primary" disabled={!inbounds.length || !policyReady} onClick={() => setCreate(true)}>{translateUI("Add client")}</Button></>} />
    {directoryError && <Notice tone="warning">{translateUI("Full client directory unavailable: ")}{translateUI(directoryError)}{translateUI(". Showing the inbound snapshot.")}</Notice>}{accountingError && <Notice tone="warning">{accountingError}</Notice>}<div className="summary-bar"><div><Users size={15} /><strong>{new Set(rows.map(c => c.email)).size}</strong><span>{translateUI("unique clients")}</span></div>{server.kind === 'server' || online === null ? <div><span>{translateUI("Online client activity not reported")}</span></div> : <div><i className="status-dot" /><strong>{onlineEmails.size}</strong><span>{translateUI("online now")}</span></div>}<div><strong>{rows.filter(c => !c.enable).length}</strong><span>{translateUI("disabled attachments")}</span></div></div>
    <section className="card"><div className="table-toolbar"><div className="table-search"><Search size={15} /><input placeholder={translateUI("Search client, comment, or inbound…")} aria-label={translateUI("Search clients")} value={search} onChange={e => setSearch(e.target.value)} /></div><div><Select aria-label={translateUI("Client status")} value={filter} onChange={e => setFilter(e.target.value)}><option value="all">{translateUI("All statuses")}</option>{server.kind !== 'server' && <option value="online" disabled={online === null}>{translateUI("Online")}</option>}<option value="enabled">{translateUI("Enabled")}</option><option value="disabled">{translateUI("Disabled")}</option></Select><Select aria-label={translateUI("Client inbound")} value={inboundFilter} onChange={e => setInboundFilter(e.target.value)}><option value="all">{translateUI("All inbounds")}</option>{inbounds.map(i => <option key={i.id} value={i.id}>{i.remark}</option>)}</Select></div></div>
      {selected.length > 0 && <div className="bulk-bar"><strong>{selected.length}{translateUI(" selected")}</strong><Button icon={RotateCcw} busy={busy} onClick={() => void bulk('reset')}>{translateUI("Reset traffic")}</Button><Button icon={Trash2} variant="danger" busy={busy} onClick={() => void bulk('delete')}>{translateUI("Delete")}</Button><IconButton icon={X} label={translateUI("Clear selection")} onClick={() => setSelected([])} /></div>}
      <ClientTable rows={visible} attachments={attachments} onlineEmails={onlineEmails} selected={selected} onSelection={setSelected} /><div className="table-footer"><span>{visible.length}{translateUI(" clients")}</span><span>{translateUI("A client can belong to multiple inbounds")}</span></div></section>
    {create && <ClientDialog onClose={() => setCreate(false)} />}
  </>;
}
function clientIdentifier(c: ClientRow) { return String(c.inboundProtocol === 'trojan' ? c.password : c.inboundProtocol === 'shadowsocks' ? c.email : c.id ?? c.email); }
function ClientTable({ rows, attachments, onlineEmails, selected, onSelection, compact }: { rows: ClientRow[]; attachments: Map<string, Inbound[]>; onlineEmails: Set<string>; selected?: string[]; onSelection?: (ids: string[]) => void; compact?: boolean }) {
  const { server, remote, refresh, toast, confirm, inbounds, online, policy, policyReady, savePolicy } = usePanel();
  const [edit, setEdit] = useState<ClientRow>(), [share, setShare] = useState<ClientRow>(), [ips, setIps] = useState<{ row: ClientRow; data: unknown }>();
  const mutate = async (c: ClientRow, operation: 'toggle' | 'delete' | 'reset', enabled = false) => {
    if (operation !== 'toggle' && !await confirm(operation === 'delete' ? `Delete client “${c.email}”?` : `Reset traffic for “${c.email}”?`, operation === 'delete' && server.version === 'v3' ? 'This deletes the client from all attached inbounds on this server.' : 'This changes the selected client on this server.')) return;
    try {
      if (operation === 'toggle') {
        const original = server.version === 'v3' ? hydrateClient(await remote({ path: `/panel/api/clients/get/${encodeURIComponent(c.email)}`, method: 'GET' }), c.email).client : c.original;
        const updated = clientPayload({ ...original, enable: enabled }, server.version);
        await remote({ path: server.version === 'v3' ? `/panel/api/clients/update/${encodeURIComponent(c.email)}` : `/panel/api/inbounds/updateClient/${encodeURIComponent(clientIdentifier(c))}`, method: 'POST', body: server.version === 'v3' ? updated : { id: c.inboundId, settings: { clients: [updated] } } });
      } else {
        const path = server.version === 'v3' ? `/panel/api/clients/${operation === 'delete' ? 'del' : 'resetTraffic'}/${encodeURIComponent(c.email)}` : operation === 'delete' ? `/panel/api/inbounds/${c.inboundId}/delClient/${encodeURIComponent(clientIdentifier(c))}` : `/panel/api/inbounds/${c.inboundId}/resetClientTraffic/${encodeURIComponent(c.email)}`;
        await remote({ path, method: 'POST' });
        if (operation === 'delete' && server.version === 'v3') { const clients = { ...policy.clients }; delete clients[c.email]; await savePolicy({ ...policy, clients }); }
      }
      await refresh(); toast('Client updated.');
    } catch (e) { toast((e as Error).message, true); }
  };
  const showIps = async (row: ClientRow) => { try { setIps({ row, data: await remote({ path: server.version === 'v3' ? `/panel/api/clients/ips/${encodeURIComponent(row.email)}` : `/panel/api/inbounds/clientIps/${encodeURIComponent(row.email)}`, method: 'POST' }) }); } catch (e) { toast((e as Error).message, true); } };
  if (!rows.length) return <Empty icon={Users} title={translateUI("No clients here yet")} description={translateUI("Add a client to an inbound, or adjust your filters.")} />;
  return <><div className="table-scroll"><table className={`clients-table ${onSelection ? "has-selection" : ""} ${compact ? 'compact' : ''}`}><thead><tr>{onSelection && <th><input type="checkbox" aria-label={translateUI("Select all visible clients")} checked={rows.length > 0 && rows.every(c => selected?.includes(c.key))} onChange={e => onSelection(e.target.checked ? [...new Set([...(selected ?? []), ...rows.map(c => c.key)])] : (selected ?? []).filter(id => !rows.some(c => c.key === id)))} /></th>}<th>{translateUI("ENABLED")}</th><th>{translateUI("CLIENT")}</th>{!compact && <th>{translateUI("INBOUND")}</th>}<th>{translateUI("TRAFFIC / LIMIT")}</th><th>{translateUI("EXPIRY")}</th><th>{translateUI("IP LIMIT")}</th><th>{translateUI("ACTIONS")}</th></tr></thead><tbody>{rows.map(c => {
    const used = (c.up ?? 0) + (c.down ?? 0), expired = c.expiryTime > 0 && c.expiryTime < Date.now(), depleted = c.totalGB > 0 && used >= c.totalGB;
    return <tr key={c.key}>{onSelection && <td><input type="checkbox" checked={selected?.includes(c.key) ?? false} aria-label={translateUI("Select {0}", c.email)} onChange={e => onSelection(e.target.checked ? [...(selected ?? []), c.key] : (selected ?? []).filter(id => id !== c.key))} /></td>}<td><Switch checked={c.enable} onChange={v => void mutate(c, 'toggle', v)} label={translateUI("Enable client {0}", c.email)} /></td><td><div className="client-name"><span className={`client-avatar ${onlineEmails.has(c.email) ? 'is-online' : ''}`}>{c.email.slice(0, 1).toUpperCase()}</span><div><strong>{c.email}</strong><small>{expired ? <span className="red-text">{translateUI("Expired")}</span> : depleted ? <span className="red-text">{translateUI("Depleted")}</span> : onlineEmails.has(c.email) ? <span className="green-text">{translateUI("Online")}</span> : c.comment || translateUI(server.kind === 'server' ? (c.enable ? "Enabled" : "Disabled") : online === null ? "Not checked" : "Offline")}</small></div></div></td>{!compact && <td className="client-access-cell"><ClientAttachments inbounds={attachments.get(c.email) ?? []} /><small className="block muted">{policy.services.find(s => s.id === policy.clients[c.email]?.serviceId)?.name || translateUI("Custom access")} · {effectiveMultiplier(policy, c.email, c.inboundId)}×</small></td>}<td><div className="traffic-cell"><strong>{bytes(used, 1)}<span> / {c.totalGB ? bytes(c.totalGB, 0) : '∞'}</span></strong><div className={`progress ${depleted ? 'depleted' : ''}`}><span style={{ width: `${c.totalGB ? Math.min(100, used / c.totalGB * 100) : 0}%` }} /></div></div></td><td className={expired ? 'red-text' : 'muted'}>{expiry(c.expiryTime)}</td><td>{c.limitIp || (translateUI("Unlimited"))}</td><td><div className="row-actions"><IconButton icon={QrCode} label={translateUI("Share {0}", c.email)} onClick={() => setShare(c)} /><IconButton icon={Edit3} label={translateUI("Edit client {0}", c.email)} disabled={!policyReady} onClick={() => setEdit(c)} />{server.kind !== 'server' && <IconButton icon={Eye} label={translateUI("View IPs for {0}", c.email)} onClick={() => void showIps(c)} />}<IconButton icon={RotateCcw} label={translateUI("Reset traffic for {0}", c.email)} onClick={() => void mutate(c, 'reset')} /><IconButton icon={Trash2} label={translateUI("Delete client {0}", c.email)} onClick={() => void mutate(c, 'delete')} /></div></td></tr>;
  })}</tbody></table></div>
    {edit && <ClientDialog client={edit} inbound={inbounds.find(i => i.id === edit.inboundId)} onClose={() => setEdit(undefined)} />}
    {share && <ShareDialog client={share} onClose={() => setShare(undefined)} />}
    {ips && <Modal title={translateUI("IP addresses · {0}", ips.row.email)} onClose={() => setIps(undefined)} footer={<><Button onClick={() => setIps(undefined)}>{translateUI("Close")}</Button><Button variant="danger" onClick={() => { void (async () => { if (!await confirm('Clear stored client IPs?', 'This removes the recorded IP history for this client.')) return; try { await remote({ path: server.version === 'v3' ? `/panel/api/clients/clearIps/${encodeURIComponent(ips.row.email)}` : `/panel/api/inbounds/clearClientIps/${encodeURIComponent(ips.row.email)}`, method: 'POST' }); setIps(undefined); toast('Client IPs cleared.'); } catch (e) { toast((e as Error).message, true); } })(); }}>{translateUI("Clear IPs")}</Button></>}><pre className="code-preview">{pretty(ips.data)}</pre></Modal>}
  </>;
}

function ClientAttachments({ inbounds }: { inbounds: Inbound[] }) {
  const [expanded, setExpanded] = useState(false);
  if (!inbounds.length) return <small className="muted">{translateUI("No attachments")}</small>;
  return <div className="client-attachments"><div className="client-attachment-tags">{(expanded ? inbounds : inbounds.slice(0, 2)).map(i => <span className="client-attachment-tag" key={i.id} title={`${i.remark} · ${i.protocol} · ${i.port}`}><span>{i.remark || `#${i.id}`}</span><small>{i.protocol.toUpperCase()}</small></span>)}</div>{inbounds.length > 2 && <button className="client-attachment-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? translateUI("Show less") : `+${inbounds.length - 2} · ${translateUI("Show all")}`}</button>}</div>;
}

export function ClientDialog({ client, inbound, onClose }: { client?: ClientRow; inbound?: Inbound; onClose: () => void }) {
  const { inbounds, server, remote, refresh, toast, demo, policy, policyReady, savePolicy, capabilities, policyError } = usePanel();
  const [form, setForm] = useState<Client>(() => client ? structuredClone(client.original) : { email: '', id: crypto.randomUUID(), password: secretBytes(), auth: crypto.randomUUID(), enable: true, totalGB: 0, expiryTime: 0, limitIp: 0, limitHwid: 0, tgId: 0, subId: crypto.randomUUID().replaceAll('-', '').slice(0, 16), flow: '', security: 'auto', comment: '', reset: 0, resetDay: 0, resetWeekday: 0, resetMax: 0, trafficReset: 'never', trafficResetDay: 1 });
  const attachable = inbounds.filter(i => i.protocol !== 'dns-resolver');
  const attachedIds = client ? inbounds.filter(i => inboundClients(i).some(c => c.email === client.email)).map(i => i.id) : inbound ? [inbound.id] : attachable[0] ? [attachable[0].id] : [];
  const initialInbounds = useRef(inbounds);
  const initialIds = server.kind === 'server' ? primaryAttachmentIds(attachedIds, inbounds) : attachedIds;
  const [ids, setIds] = useState<number[]>(initialIds), [originalIds, setOriginalIds] = useState(initialIds), [links, setLinks] = useState<Record<string, unknown>[]>([]);
  const [linksChanged, setLinksChanged] = useState(false);
  const [savedEmail, setSavedEmail] = useState(client?.email), [tab, setTab] = useState('General'), [raw, setRaw] = useState(pretty(form)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(Boolean(client && server.version === 'v3' && !demo)), [loadError, setLoadError] = useState(''), [loadAttempt, setLoadAttempt] = useState(0);
  const [expiryMode, setExpiryMode] = useState(form.expiryTime < 0 ? 'duration' : form.expiryTime > 0 ? 'date' : 'never');
  const full = server.kind === 'server';
  const [access, setAccess] = useState<ClientPolicy>(() => structuredClone(policy.clients[client?.email ?? ''] ?? { serviceId: '', multiplier: 1, overrides: {} }));
  const service = policy.services.find(s => s.id === access.serviceId);
  const applyService = (id: string) => { const plan = policy.services.find(s => s.id === id); setAccess(a => ({ ...a, serviceId: id, overrides: {} })); if (plan) { setIds(serviceIds(plan).filter(id => inbounds.some(i => i.id === id))); const fields = serviceClientFields(plan, !savedEmail); setForm(f => ({ ...f, ...fields })); if (!savedEmail && plan.rules.expiryDays) setExpiryMode('date'); } };
  const rates = { ...policy.inboundMultipliers, ...Object.fromEntries(service?.inbounds.map(i => [i.inboundId, i.multiplier]) ?? []) };
  const nativeAccounting = capabilities?.features.includes('weighted-accounting');
  const unmetered = inbounds.filter(i => ids.includes(i.id) && !['vless','vmess','trojan','shadowsocks','wireguard-native'].includes(i.protocol) && !(i.protocol === 'masterdnsvpn' && parseObject(i.settings).meteredInboundId));
  useEffect(() => {
    if (!client || server.version !== 'v3' || demo) return;
    let alive = true;
    setLoading(true); setLoadError('');
    void remote({ path: `/panel/api/clients/get/${encodeURIComponent(client.email)}`, method: 'GET' }).then(value => {
      if (!alive) return;
      const hydrated = hydrateClient(value, client.email); setForm(hydrated.client); setRaw(pretty(hydrated.client)); setLinks(hydrated.externalLinks); setLinksChanged(false);
      const attached = full ? primaryAttachmentIds(hydrated.inboundIds, initialInbounds.current) : hydrated.inboundIds;
      setIds(attached); setOriginalIds(attached); setExpiryMode(hydrated.client.expiryTime < 0 ? 'duration' : hydrated.client.expiryTime > 0 ? 'date' : 'never');
    }).catch(e => { if (alive) setLoadError(e.message || 'The server returned invalid data. Please retry.'); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [client, remote, server.version, full, demo, loadAttempt]);
  const set = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value }));
  const protocols = inbounds.filter(i => ids.includes(i.id)).map(i => i.protocol);
  const has = (...values: string[]) => values.some(v => protocols.includes(v));
  const passwordBytes = () => {
    const ciphers = inbounds.filter(i => ids.includes(i.id) && i.protocol === 'shadowsocks').map(i => String(parseObject(i.settings).method ?? ''));
    return secretBytes(ciphers.includes('2022-blake3-aes-128-gcm') ? 16 : 32);
  };
  const changeTab = (next: string) => { try { if (tab === 'JSON') setForm(JSON.parse(raw) as Client); else setRaw(pretty(form)); setTab(next); setError(''); } catch { setError('Fix the JSON first.'); } };
  const generateTunnelKeys = async () => {
    try { const keys = parseObject(await remote({ path: '/panel/api/server/getNewX25519Cert', method: 'GET' })); const privateKey = keys.privateKey ?? keys.private_key, publicKey = keys.publicKey ?? keys.public_key; if (!privateKey || !publicKey) throw new Error('The server did not return a WireGuard key pair.'); setForm(f => ({ ...f, privateKey, publicKey })); } catch (e) { setError((e as Error).message); }
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || loading || loadError) return;
    setBusy(true); setError('');
    let committed = false;
    try {
      const edited = tab === 'JSON' ? JSON.parse(raw) as Client : form;
      if (typeof edited.email !== 'string' || !edited.email.trim() || (/[\s/\\]/.test(edited.email) || Array.from(edited.email).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))) throw new Error('Enter a client name without spaces, slashes, or control characters.');
      if(full && ids.length===unmetered.length && (edited.totalGB > 0 || edited.expiryTime < 0)) throw new Error('Select at least one metered inbound for a traffic quota or first-use expiry.');
      if (!policyReady) throw new Error('Services are still loading. Reopen the editor after they load.');
      if (service && ids.some(id => !serviceIds(service).includes(id))) throw new Error('Remove inbounds outside this service.');
      if (!ids.length && !savedEmail) throw new Error('Select at least one inbound.');
      const base = savedEmail && server.version === 'v3' && !demo ? hydrateClient(await remote({ path: `/panel/api/clients/get/${encodeURIComponent(savedEmail)}`, method: 'GET' }), savedEmail).client : client?.original ?? {};
      const attachmentsChanged = ids.length !== originalIds.length || ids.some(id => !originalIds.includes(id));
      const merged = clientPayload({ ...base, ...edited }, server.version, full && (!savedEmail || attachmentsChanged) ? ids : undefined);
      if (server.version === 'v3') {
        await remote({ path: savedEmail ? `/panel/api/clients/update/${encodeURIComponent(savedEmail)}` : '/panel/api/clients/add', method: 'POST', body: savedEmail ? merged : { client: merged, inboundIds: ids } });
        committed = true; setSavedEmail(edited.email);
        if (savedEmail && !full) {
          const attach = ids.filter(id => !originalIds.includes(id)), detach = originalIds.filter(id => !ids.includes(id));
          if (attach.length) { await remote({ path: `/panel/api/clients/${encodeURIComponent(edited.email)}/attach`, method: 'POST', body: { inboundIds: attach } }); setOriginalIds(old => [...new Set([...old, ...attach])]); }
          if (detach.length) { await remote({ path: `/panel/api/clients/${encodeURIComponent(edited.email)}/detach`, method: 'POST', body: { inboundIds: detach } }); setOriginalIds(old => old.filter(id => !detach.includes(id))); }
        } else setOriginalIds(ids);
        if (!full && linksChanged) {
          await remote({ path: `/panel/api/clients/${encodeURIComponent(edited.email)}/externalLinks`, method: 'POST', body: { externalLinks: links.filter(l => String(l.value ?? '').trim()) } });
          setLinksChanged(false);
        }
      } else await remote({ path: client ? `/panel/api/inbounds/updateClient/${encodeURIComponent(clientIdentifier(client))}` : '/panel/api/inbounds/addClient', method: 'POST', body: { id: ids[0], settings: { clients: [merged] } } });
      const clients = { ...policy.clients }; if (savedEmail && savedEmail !== edited.email) delete clients[savedEmail]; clients[edited.email] = access;
      await savePolicy({ ...policy, clients });
      await refresh(); toast(`Client ${client ? 'updated' : 'created'}.`); onClose();
    } catch (e) { setError(`${committed ? 'Client details were saved, but another step failed. Review attachments and retry. ' : ''}${(e as Error).message}`); await refresh(); } finally { setBusy(false); }
  };
  const credential = (label: string, key: string, generator?: () => string) => <Field label={translateUI(label)}><div className="input-with-action"><input value={String(form[key] ?? '')} autoComplete="off" onChange={e => set(key, e.target.value)} />{generator && <IconButton icon={RotateCcw} label={translateUI("Generate {0}", label)} onClick={() => set(key, generator())} />}</div></Field>;
  return <Modal title={client ? translateUI("Edit client · {0}", client.email) : translateUI("Add client")} description={translateUI("Manage identity, credentials, limits, and core attachments.")} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{translateUI("Cancel")}</Button><Button variant="primary" busy={busy || loading} disabled={Boolean(loadError)} form="client-form" type="submit">{client ? translateUI("Save changes") : translateUI("Create client")}</Button></>}><form id="client-form" onSubmit={e => void save(e)} className="form-stack"><Tabs tabs={['General', 'Credentials', 'Renewal', ...(server.version === 'v3' && !full ? ['External links'] : []), 'JSON']} value={tab} onChange={changeTab} />{error && <Notice tone="error">{error}</Notice>}{loadError && <Notice tone="error">{translateUI(loadError)} <Button onClick={() => setLoadAttempt(n => n + 1)}>{translateUI("Retry")}</Button></Notice>}{loading && <Notice>{translateUI("Loading current client details…")}</Notice>}{policyError && <Notice tone="warning">{policyError}</Notice>}{server.kind !== 'server' && <Notice>{translateUI("Traffic multipliers are BenX-UI policy. This panel connection uses the upstream panel’s quota accounting; weighted enforcement requires the native agent.")}</Notice>}
    {full && unmetered.some(i => i.protocol === 'masterdnsvpn') && <Notice tone="warning">{translateUI("Shared-key MasterDNS is unmetered. This connection can be unlimited even when the customer has a quota on other inbounds.")}</Notice>}
    {full && <Notice>{translateUI("Traffic limits count authenticated Xray traffic, paired MasterDNS and native WireGuard. First-use expiry starts on measured traffic. When the quota is reached the panel pauses the customer’s managed credentials. A copied standalone DNS key can still work.")}</Notice>}<fieldset disabled={loading || busy || Boolean(loadError)} className="editor-fieldset">
    {tab === 'General' && <><div className="form-grid"><Field label={translateUI("Client name / email")}><input required value={form.email} placeholder={translateUI("e.g. alex")} onChange={e => set('email', e.target.value)} /></Field><Field label={translateUI("Traffic limit (GB)")} hint={full ? translateUI("Quota enforcement requires Xray, paired MasterDNS or native WireGuard.") : translateUI("0 means unlimited.")}><input type="number" min={0} step="any" disabled={full && nativeAccounting === false} value={form.totalGB / GiB} onChange={e => set('totalGB', Number(e.target.value) * GiB)} /></Field><Field label={translateUI("IP limit")} hint={full ? translateUI("Unavailable for native listeners.") : translateUI("Requires usable server-side IP enforcement.")}><input type="number" min={0} disabled={full} value={form.limitIp} onChange={e => set('limitIp', Number(e.target.value))} /></Field><Field label={translateUI("Expiry")}><Select value={expiryMode} onChange={e => { setExpiryMode(e.target.value); setForm(f => ({ ...f, expiryTime: e.target.value === 'duration' ? -30 * 86400000 : 0, ...(e.target.value === 'duration' ? { firstUseId: crypto.randomUUID() } : {}) })); }}><option value="never">{translateUI("Never")}</option><option value="date">{translateUI("On a date")}</option><option value="duration">{translateUI("After first use")}</option></Select></Field><Field label={expiryMode === 'duration' ? translateUI("Days after first use") : translateUI("Expiry date")}>{expiryMode === 'duration' ? <input type="number" min={1} max={3650} step={1} value={Math.abs(form.expiryTime) / 86400000} onChange={e => set('expiryTime', -Number(e.target.value) * 86400000)} /> : <input type="date" disabled={expiryMode === 'never'} value={form.expiryTime > 0 ? new Date(form.expiryTime).toISOString().slice(0, 10) : ''} onChange={e => set('expiryTime', e.target.value ? new Date(e.target.value).getTime() : 0)} />}</Field><Field label={translateUI("Group")}><input value={String(form.group ?? '')} onChange={e => set('group', e.target.value)} /></Field><Field label={translateUI("Telegram user ID")}><input value={String(form.tgId ?? '')} onChange={e => set('tgId', /^\d+$/.test(e.target.value) ? Number(e.target.value) : e.target.value)} /></Field>{server.version === 'v3' && <Field label={translateUI("Device / HWID limit")}><input type="number" min={0} disabled={full} value={form.limitHwid ?? 0} onChange={e => set('limitHwid', Number(e.target.value))} /></Field>}<Field label={translateUI("Comment")}><input value={form.comment ?? ''} onChange={e => set('comment', e.target.value)} /></Field></div>
      <div className="form-grid"><Field label={translateUI("Service")} hint={translateUI("A service selects its included inbounds and default client rules.")}><Select value={access.serviceId} disabled={!policyReady || server.version === 'v2'} onChange={e => applyService(e.target.value)}><option value="">{translateUI("Custom access")}</option>{policy.services.filter(s => s.enabled || s.id === access.serviceId).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field><Field label={translateUI("Client traffic multiplier")} hint={translateUI("Multiplies every attached inbound’s effective rate.")}><input type="number" min={0} max={100} step="0.1" value={access.multiplier} onChange={e => setAccess({ ...access, multiplier: Number(e.target.value) })} /></Field></div><section className="field"><span className="field-label">{translateUI("Attach to inbounds and cores")}</span><AttachmentPicker inbounds={attachable} ids={ids} onChange={next => { if (server.version !== 'v2' || !client) setIds(next); }} allowed={service ? serviceIds(service) : undefined} overrides={access.overrides} defaults={rates} globalRate={access.multiplier} single={server.version === 'v2'} readOnly={server.version === 'v2' && Boolean(client)} onRate={(id, rate) => setAccess(a => { const overrides = { ...a.overrides }; if (rate === undefined) delete overrides[id]; else overrides[id] = rate; return { ...a, overrides }; })} /></section><div className="setting-toggle"><span>{translateUI("Enable client")}</span><Switch checked={form.enable} onChange={v => set('enable', v)} label={translateUI("Enable client")} /></div></>}
    {tab === 'Credentials' && <><Notice>{translateUI("Credentials follow the attached protocols. One client can hold credentials for several cores.")}</Notice><div className="form-grid">{has('vless', 'vmess', 'tuic', 'masterdnsvpn') && credential('UUID', 'id', () => crypto.randomUUID())}{has('trojan', 'shadowsocks', 'tuic', 'openconnect', 'ssh') && credential('Password', 'password', passwordBytes)}{credential('Subscription ID', 'subId', () => crypto.randomUUID().replaceAll('-', '').slice(0, 16))}{has('hysteria') && credential('Hysteria authentication', 'auth', () => crypto.randomUUID())}{has('vless') && <Field label={translateUI("Flow")}><Select value={form.flow ?? ''} onChange={e => set('flow', e.target.value)}><option value="">{translateUI("None")}</option><option value="xtls-rprx-vision">{translateUI("XTLS Vision")}</option><option value="xtls-rprx-vision-udp443">{translateUI("XTLS Vision · UDP 443")}</option></Select></Field>}{has('vmess') && <Field label={translateUI("VMess security")}><Select value={String(form.security ?? 'auto')} onChange={e => set('security', e.target.value)}>{['auto', 'aes-128-gcm', 'chacha20-poly1305', 'none', 'zero'].map(v => <option key={v}>{v}</option>)}</Select></Field>}{has('vless') && <Field label={translateUI("Reverse proxy tag")}><input value={String(parseObject(form.reverse).tag ?? '')} onChange={e => set('reverse', e.target.value ? { ...parseObject(form.reverse), tag: e.target.value } : {})} /></Field>}{has('wireguard', 'amneziawg', 'wireguard-native') && <><Field label={translateUI("Private key")}><input value={String(form.privateKey ?? '')} onChange={e => set('privateKey', e.target.value)} /></Field>{credential('Public key', 'publicKey')}{credential('Pre-shared key', 'preSharedKey', () => secretBytes())}<Field label={translateUI("Allowed IPs")} hint={translateUI("Comma-separated CIDRs assigned to this peer.")}><input value={Array.isArray(form.allowedIPs) ? form.allowedIPs.join(', ') : String(form.allowedIPs ?? '')} onChange={e => set('allowedIPs', e.target.value.split(',').map(v => v.trim()).filter(Boolean))} /></Field><Field label={translateUI("Keepalive (seconds)")}><input type="number" min={0} value={Number(form.keepAlive ?? 25)} onChange={e => set('keepAlive', Number(e.target.value))} /></Field>{has('amneziawg') && credential('Forwarded ports', 'forwardedPorts')}<div className="full-width"><Button icon={RotateCcw} onClick={() => void generateTunnelKeys()}>{translateUI("Generate tunnel key pair")}</Button></div><div className="full-width"><JsonOption label={translateUI("Allowed IPs by inbound")} value={form.allowedIPsByInbound ?? {}} onChange={v => set('allowedIPsByInbound', v)} /></div></>}{has('mtproto') && <>{credential('MTProto secret', 'secret', () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''))}{credential('MTProto advertising tag', 'adTag')}</>}{has('masterdnsvpn') && <Notice>{translateUI("MasterDnsVPN’s encryption key belongs to this DNS inbound. The agent generates it and includes it in the client profile from Share. Shared-key mode accepts multiple customers, but shares the key and cannot meter or revoke them individually. A metered VLESS backend gives customers separate UUIDs and quotas. Public resolvers need a delegated NS domain and UDP port 53; Share provides the configuration and default resolver file. See DNS hosting for the setup guide.")}</Notice>}{has('openvpn') && <Notice>{translateUI("Password mode uses one common .ovpn file with each customer’s username and password. Certificate mode issues individual certificates. Download files from Share or the customer page. Configure separate TCP and UDP listeners to offer both transports.")}</Notice>}{has('ssh', 'openconnect') && <Notice>{translateUI("Server accounts are generated from this client identity. Connection details are available from Share after saving.")}</Notice>}</div></>}
    {tab === 'Renewal' && (full ? <Notice>{translateUI("Scheduled renewal and traffic reset require the 3X-UI accounting service. Native first-use expiry starts after measured traffic on Xray, native WireGuard or a metered MasterDNS backend. Other native protocols require a fixed expiry date.")}</Notice> : <><div className="form-grid"><Field label={translateUI("Renewal interval (days)")} hint={translateUI("0 disables interval renewal. Use one renewal schedule.")}><input type="number" min={0} value={Number(form.reset ?? 0)} onChange={e => setForm(f => ({ ...f, reset: Number(e.target.value), resetDay: 0, resetWeekday: 0 }))} /></Field><Field label={translateUI("Monthly renewal day")}><input type="number" min={0} max={31} value={Number(form.resetDay ?? 0)} onChange={e => setForm(f => ({ ...f, resetDay: Number(e.target.value), reset: 0, resetWeekday: 0 }))} /></Field><Field label={translateUI("Weekly renewal day")}><Select value={String(form.resetWeekday ?? 0)} onChange={e => setForm(f => ({ ...f, resetWeekday: Number(e.target.value), reset: 0, resetDay: 0 }))}>{['Disabled', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, n) => <option key={d} value={n}>{d}</option>)}</Select></Field><Field label={translateUI("Maximum renewals")} hint={translateUI("0 means unlimited.")}><input type="number" min={0} value={Number(form.resetMax ?? 0)} onChange={e => set('resetMax', Number(e.target.value))} /></Field><Field label={translateUI("Periodic traffic reset")}><Select value={String(form.trafficReset ?? 'never')} onChange={e => set('trafficReset', e.target.value)}>{['never', 'hourly', 'daily', 'weekly', 'monthly'].map(v => <option key={v}>{v}</option>)}</Select></Field><Field label={translateUI("Traffic reset day")}><input type="number" min={1} max={31} value={Number(form.trafficResetDay ?? 1)} onChange={e => set('trafficResetDay', Number(e.target.value))} /></Field></div></>)}
    {tab === 'External links' && <OptionsEditor schema={externalLinksSchema} value={{ externalLinks: links }} onChange={v => { setLinks(v.externalLinks as Record<string, unknown>[]); setLinksChanged(true); }} />}
    {tab === 'JSON' && <Field label={translateUI("Full client JSON")}><textarea className="code-editor" rows={24} value={raw} onChange={e => setRaw(e.target.value)} spellCheck={false} /></Field>}
    </fieldset>
  </form></Modal>;
}
function ShareDialog({ client, onClose }: { client: ClientRow; onClose: () => void }) {
  const { inbounds, server, remote, toast, demo } = usePanel();
  const [shareTab, setShareTab] = useState(server.version === 'v3' ? 'Subscription' : 'Connections & profiles');
  const [address, setAddress] = useState(server.url.startsWith("agent://") ? "" : new URL(server.url).hostname), [links, setLinks] = useState<string[]>([]), [qr, setQr] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [selected, setSelected] = useState('');
  const generate = async () => {
    setBusy(true); setError('');
    try {
      const inbound = inbounds.find(i => i.id === client.inboundId); if (!inbound) throw new Error('Inbound not found.');
      if (server.version === 'v2' && (!address || !Array.from(address).every(c => /[a-zA-Z0-9.:-]/.test(c) || c === '[' || c === ']'))) throw new Error('Enter a proxy hostname or IP address without a scheme or path.');
      const result = server.version === 'v3' ? await remote<string[]>({ path: `/panel/api/clients/links/${encodeURIComponent(client.email)}`, method: 'GET' }) : [shareLink(inbound, client.original, address)];
      if (!Array.isArray(result) || !result.length) throw new Error('This client has no shareable links. Use native export for this protocol.');
      setLinks(result); setSelected(result[0]); setQr(/^[a-z0-9+.-]+:\/\//i.test(result[0]) && result[0].length < 1600 ? await QRCode.toDataURL(result[0], { width: 240, margin: 2, color: { dark: '#172338' } }) : '');
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const exportProfiles = () => {
    if (server.kind !== 'server') { download(`${client.email}-connections.txt`, links.join('\n'), 'text/plain'); return; }
    if (selected.startsWith('# MasterDnsVPN client_resolvers.txt')) { download('client_resolvers.txt', selected, 'text/plain'); return; }
    const extension = selected.startsWith('client') ? 'ovpn' : selected.startsWith('[Interface]') ? 'conf' : selected.startsWith('{') ? 'json' : 'txt';
    download(`${client.email}-profile.${extension}`, selected, extension === 'json' ? 'application/json' : 'text/plain');
  };
  return <Modal title={translateUI("Share client · {0}", client.email)} onClose={onClose}><div className="form-stack">{inbounds.some(i => i.protocol === 'masterdnsvpn' && !parseObject(i.settings).meteredInboundId && inboundClients(i).some(c => c.email === client.email)) && <Notice tone="warning">{translateUI("Shared-key MasterDNS is unmetered. This connection can be unlimited even when the customer has a quota on other inbounds.")}</Notice>}<Tabs tabs={['Subscription', 'Connections & profiles']} value={shareTab} onChange={setShareTab} />{shareTab === 'Subscription' ? <ClientSubscriptionShare client={client} /> : <>{demo && <Notice>{translateUI("These are sample links for previewing the sharing interface.")}</Notice>}{inbounds.some(i => i.protocol === 'masterdnsvpn' && inboundClients(i).some(c => c.email === client.email)) && <Notice>{translateUI("MasterDNSVPN requires both its JSON configuration and client_resolvers.txt. Default public resolvers need NS delegation and UDP port 53. For a custom-port direct test, put the VPS IP:port in the resolver file instead. See DNS hosting for the domain setup guide.")}</Notice>}{server.version === 'v2' && <Field label={translateUI("Public proxy address")} hint={translateUI("Use the actual proxy host. A panel or Cloudflare Tunnel hostname may be different.")}><input value={address} onChange={e => setAddress(e.target.value)} /></Field>}<Button variant="primary" icon={QrCode} busy={busy} onClick={() => void generate()}>{server.kind === 'server' ? translateUI("Get client profiles") : translateUI("Get connection links")}</Button>{error && <Notice tone="error">{error}</Notice>}{qr && <div className="qr-container"><img src={qr} alt={`QR code for ${client.email}`} width={240} height={240} /></div>}{links.length > 0 && <><Field label={server.kind === 'server' ? translateUI("Client profile") : translateUI("Connection link")}><Select value={selected} onChange={e => { setSelected(e.target.value); if (/^[a-z0-9+.-]+:\/\//i.test(e.target.value) && e.target.value.length < 1600) void QRCode.toDataURL(e.target.value, { width: 240, margin: 2 }).then(setQr).catch(e => setError(e.message)); else setQr(''); }}>{links.map((l, n) => <option key={l} value={l}>{translateUI("Connection ")}{n + 1} · {server.kind === 'server' ? l.startsWith('# MasterDnsVPN') ? translateUI("MasterDNS resolvers") : l.includes('"DOMAINS"') ? translateUI("MasterDNS configuration") : l.startsWith('client') ? translateUI("OpenVPN") : l.startsWith('[Interface]') ? translateUI("WireGuard") : l.startsWith('{') ? translateUI("JSON profile") : translateUI("Account details") : l.split('://')[0].toUpperCase()}</option>)}</Select><textarea rows={4} readOnly value={selected} className="code-editor" /></Field><div className="button-row"><Button icon={Copy} onClick={() => void navigator.clipboard.writeText(selected).then(() => toast(server.kind === 'server' ? 'Client profile copied.' : 'Connection link copied.')).catch(() => toast('Copy failed. Select and copy the link manually.', true))}>{server.kind === 'server' ? translateUI("Copy profile") : translateUI("Copy link")}</Button><Button icon={Download} onClick={exportProfiles}>{translateUI("Download")}</Button></div></>}
  </>}</div></Modal>;
}




