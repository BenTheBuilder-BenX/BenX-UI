import { t as translateUI } from '../lib/i18n';
import { useEffect, useState } from 'react';
import { coreCatalog, coreForProtocol, panelProtocols } from '../../shared/cores';
import { OptionsEditor } from '../components/OptionsEditor';
import { inboundExtraSchema, nativeSchemas, protocolSchema, schemaFor } from '../lib/editor-metadata';
import { ArrowDown, Copy, Download, Edit3, ListFilter, Plus, RotateCcw, Search, Trash2, Upload, Users } from 'lucide-react';
import { FormRow, SecurityEditor, StreamEditor } from '../components/XrayEditors';
import { FeatureGuide } from '../components/FeatureGuide';
import { inboundClients, parseObject, type Inbound, type JsonObject } from '../../shared/types';
import { usePanel } from '../context';
import { Badge, Button, Empty, Field, IconButton, Modal, Notice, PageHeading, Select, Switch, Tabs } from '../components/ui';
import { bytes, download, expiry, GiB, pretty } from '../lib/format';
import { normalizeInboundCertificates, randomInboundPort, realityKeys, validateInboundSecurity } from '../lib/inbound-setup';
import { api } from '../lib/api';

interface FleetInboundResult { id: string; results: Array<{ serverId: string; inboundId?: number; saved: boolean; error?: string }> }

export function Inbounds() {
  const { inbounds, remote, refresh, toast, confirm, server, capabilities } = usePanel();
  const [search, setSearch] = useState(''), [protocol, setProtocol] = useState('all');
  const [customersInbound, setCustomersInbound] = useState<Inbound>();
  const [editor, setEditor] = useState<Inbound | 'new'>(), [importing, setImporting] = useState(false), [importText, setImportText] = useState(''), [busy, setBusy] = useState(false);
  const requestedCore = new URLSearchParams(location.hash.split('?')[1] || '').get('core') || '';
  useEffect(() => { if (requestedCore && server.kind === 'server' && capabilities?.cores.some(c => c.id === requestedCore && c.installed && c.protocols?.some(p => p !== 'dns-resolver'))) setEditor('new'); }, [requestedCore, server.kind, capabilities]);
  const visible = inbounds.filter(i => i.protocol !== 'dns-resolver' && `${i.remark} ${i.port} ${i.protocol}`.toLowerCase().includes(search.toLowerCase()) && (protocol === 'all' || i.protocol === protocol));
  const action = async (path: string, title: string, description: string) => { if (!(await confirm(title, description))) return; try { await remote({ path, method: 'POST' }); toast('Operation completed.'); await refresh(); } catch (e) { toast((e as Error).message, true); } };
  const toggle = async (inbound: Inbound, enabled: boolean) => {
    try {
      if (server.version === 'v3') await remote({ path: `/panel/api/inbounds/setEnable/${inbound.id}`, method: 'POST', body: { enable: enabled } });
      else { const current = await remote<Inbound>({ path: `/panel/api/inbounds/get/${inbound.id}`, method: 'GET' }); await remote({ path: `/panel/api/inbounds/update/${inbound.id}`, method: 'POST', body: { ...current, enable: enabled } }); }
      await refresh(); toast(`Inbound ${enabled ? 'enabled' : 'disabled'}.`);
    } catch (e) { toast((e as Error).message, true); }
  };
  const importInbounds = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(importText) as unknown;
      const rows = Array.isArray(parsed) ? parsed : [parsed];
      if (!rows.length || rows.length > 100) throw new Error('Import between 1 and 100 inbounds.');
      for (let n = 0; n < rows.length; n++) {
        const row = parseObject(rows[n]); if (!row.protocol || !row.port) throw new Error(`Inbound ${n + 1} needs a protocol and port.`);
        const { id: _id, ...rest } = row; void _id;
        try { await remote({ path: '/panel/api/inbounds/add', method: 'POST', body: rest }); }
        catch (e) { throw new Error(`Imported ${n} of ${rows.length}. ${(e as Error).message}`); }
      }
      toast(`${rows.length} inbound(s) imported.`); setImporting(false); await refresh();
    } catch (e) { toast((e as Error).message, true); await refresh(); } finally { setBusy(false); }
  };
  return <>
    <PageHeading title={translateUI("Inbounds")} description={translateUI("Manage listeners, customer access and inbound traffic costs.")} actions={<><Button icon={Upload} onClick={() => setImporting(true)}>{translateUI("Import")}</Button><Button icon={Plus} variant="primary" disabled={server.kind === 'server' && server.bound !== 0 && !capabilities?.cores.some(c => c.installed && c.protocols?.some(p => p !== 'dns-resolver'))} onClick={() => setEditor('new')}>{translateUI("Add inbound")}</Button></>} />
    <div className="summary-bar"><div><i className="status-dot" /><strong>{inbounds.filter(i => i.enable).length}</strong><span>{translateUI("enabled inbounds")}</span></div><div><Users size={15} /><strong>{inbounds.reduce((a, i) => a + inboundClients(i).length, 0)}</strong><span>{translateUI("client attachments")}</span></div><div><ArrowDown size={15} /><strong>{bytes(inbounds.reduce((a, i) => a + i.up + i.down, 0))}</strong><span>{translateUI("total traffic")}</span></div></div>
    <section className="card"><div className="table-toolbar"><div className="table-search"><Search size={15} /><input placeholder={translateUI("Search remark, protocol, or port…")} value={search} onChange={e => setSearch(e.target.value)} aria-label={translateUI("Search inbounds")} /></div><div><Select aria-label={translateUI("Filter protocol")} value={protocol} onChange={e => setProtocol(e.target.value)}><option value="all">{translateUI("All protocols")}</option>{[...new Set(inbounds.map(i => i.protocol))].map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}</Select><Button icon={Download} onClick={() => download('benx-inbounds.json', pretty(inbounds))}>{translateUI("Export")}</Button><IconButton icon={RotateCcw} label={translateUI("Reset all inbound traffic")} onClick={() => void action('/panel/api/inbounds/resetAllTraffics', 'Reset all inbound traffic?', 'Traffic counters on every inbound of this server will reset.')} /></div></div>
      {!visible.length ? <Empty icon={ListFilter} title={search ? translateUI("No matching inbounds") : translateUI("No inbounds yet")} description={search ? translateUI("Try a different search or filter.") : translateUI("Create an inbound to start adding clients.")}><Button icon={Plus} variant="primary" disabled={server.kind === 'server' && server.bound !== 0 && !capabilities?.cores.some(c => c.installed && c.protocols?.some(p => p !== 'dns-resolver'))} onClick={() => setEditor('new')}>{translateUI("Add inbound")}</Button></Empty> : <div className="table-scroll"><table className="inbounds-table"><thead><tr><th>{translateUI("ENABLED")}</th><th>{translateUI("REMARK / PROTOCOL")}</th><th>{translateUI("PORT")}</th><th>{translateUI("TRANSPORT")}</th><th>{translateUI("RATE")}</th><th>{translateUI("TRAFFIC")}</th><th>{translateUI("EXPIRY")}</th><th>{translateUI("ACTIONS")}</th></tr></thead><tbody>{visible.map(i => <InboundRows key={i.id} inbound={i} onCustomers={() => setCustomersInbound(i)} onToggle={value => void toggle(i, value)} onEdit={() => setEditor(i)} onDelete={() => void action(`/panel/api/inbounds/del/${i.id}`, `Delete “${i.remark}”?`, 'The inbound and its client attachments will be removed from this server.')} onReset={() => void action(`/panel/api/inbounds/${i.id}/resetTraffic`, 'Reset inbound traffic?', 'This will reset the counters for this inbound.')} onClone={() => setEditor({ ...structuredClone(i), id: 0, remark: `${i.remark} (copy)`, port: i.port + 1, up: 0, down: 0 })} />)}</tbody></table></div>}
      <div className="table-footer"><span>{visible.length}{translateUI(" of ")}{inbounds.length}{translateUI(" inbounds")}</span><span>{translateUI("Changes apply to the selected server")}</span></div>
    </section>
    {customersInbound && <InboundCustomers inbound={customersInbound} onClose={() => setCustomersInbound(undefined)} />}
    {editor && <InboundDialog initialCore={editor === 'new' ? requestedCore : undefined} inbound={editor === 'new' ? undefined : editor} onClose={() => { setEditor(undefined); if (requestedCore) history.replaceState(null, '', '#inbounds'); }} />}
    {importing && <Modal title={translateUI("Import inbounds")} description={translateUI("Choose an exported JSON file or paste inbound configurations.")} wide onClose={() => { if (!busy) setImporting(false); }} footer={<><Button disabled={busy} onClick={() => setImporting(false)}>{translateUI("Cancel")}</Button><Button busy={busy} variant="primary" onClick={() => void importInbounds()}>{translateUI("Import inbounds")}</Button></>}><div className="form-stack"><input type="file" accept=".json,application/json" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setImportText); }} /><Notice tone="warning">{translateUI("Import creates new inbounds. Make sure ports are available. If an import fails partway, successfully created inbounds remain.")}</Notice><textarea className="code-editor" rows={16} value={importText} onChange={e => setImportText(e.target.value)} placeholder={translateUI("[ { ...inbound } ]")} aria-label={translateUI("Inbound import JSON")} /></div></Modal>}
  </>;
}
function InboundCustomers({ inbound, onClose }: { inbound: Inbound; onClose: () => void }) {
  const { remote, refresh, toast, server, demo } = usePanel();
  const [customers, setCustomers] = useState<JsonObject[]>([]), [selected, setSelected] = useState<string[]>([]), [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { let alive = true; setLoading(true); void remote<JsonObject[]>({ path: '/panel/api/clients/list', method: 'GET' }).then(rows => { if (alive) { setCustomers(rows); setSelected([]); } }).catch(e => { if (alive) setError(e.message); }).finally(() => { if (alive) setLoading(false); }); return () => { alive = false; }; }, [remote, server.id]);
  const change = async (action: 'attach' | 'detach', all = false) => {
    const emails = all ? customers.map(c => String(c.email)) : selected;
    if (!emails.length) return;
    setBusy(true); setError('');
    try {
      await remote({ path: `/panel/api/inbounds/${inbound.id}/clients`, method: 'POST', body: { emails, action } });
      await refresh(); toast('Customer attachments saved. Server synchronization is queued.'); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <Modal title={translateUI("Inbound customers")} description={`${inbound.remark || inbound.protocol} · #${inbound.id}`} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{translateUI("Close")}</Button><Button disabled={loading || busy || demo || !selected.length} onClick={() => void change('detach')}>{translateUI("Detach selected")}</Button><Button variant="primary" busy={busy} disabled={loading || demo || !selected.length} onClick={() => void change('attach')}>{translateUI("Attach selected")}</Button></>}>
    <div className="form-stack">{error && <Notice tone="error">{error}</Notice>}<Notice>{translateUI("Attachments change only this server. Other inbound access, customer credentials and quotas stay intact. Paired OpenVPN transports and private MasterDNS backends follow their main inbound. Disabled inbounds disappear from subscriptions until enabled again.")}</Notice>
    <div className="button-row"><Button disabled={loading || busy || demo || !customers.length} onClick={() => void change('attach', true)}>{translateUI("Attach all customers")}</Button><Button variant="danger" disabled={loading || busy || demo || !customers.length} onClick={() => void change('detach', true)}>{translateUI("Detach all customers")}</Button></div>
    <Field label={translateUI("Search customers")}><input value={search} onChange={e => setSearch(e.target.value)} /></Field>
    <div className="button-row"><Button disabled={busy || loading} onClick={() => setSelected(customers.map(c => String(c.email)))}>{translateUI("Select all")}</Button><Button disabled={busy} onClick={() => setSelected([])}>{translateUI("Clear selection")}</Button><span className="muted">{translateUI("{0} selected", selected.length)}</span></div>
    <div style={{ maxHeight: 360, overflowY: 'auto' }}>{loading ? <p>{translateUI("Loading customers…")}</p> : customers.filter(c => String(c.email).toLowerCase().includes(search.toLowerCase())).map(c => { const email = String(c.email), attached = (c.inboundIds as number[] || []).includes(inbound.id); return <label key={email} className="setting-toggle"><span><input type="checkbox" checked={selected.includes(email)} disabled={busy} onChange={e => setSelected(v => e.target.checked ? [...v, email] : v.filter(x => x !== email))} /> {email}</span><Badge color={attached ? 'green' : 'gray'}>{attached ? translateUI("Attached") : translateUI("Not attached")}</Badge></label>; })}</div></div>
  </Modal>;
}
function InboundRows({ inbound: i, onToggle, onEdit, onDelete, onReset, onClone, onCustomers }: { inbound: Inbound; onToggle: (v: boolean) => void; onEdit: () => void; onDelete: () => void; onReset: () => void; onClone: () => void; onCustomers: () => void }) {
  const stream = parseObject(i.streamSettings), used = i.up + i.down;
  const { server, policy } = usePanel();
  return <tr><td><Switch checked={i.enable} onChange={onToggle} label={translateUI("Enable {0}", i.remark)} /></td><td><div className="inbound-name"><strong>{i.remark || (translateUI("Inbound {0}", i.id))}</strong><div><Badge color="blue">{i.protocol.toUpperCase()}</Badge><span className="muted">#{i.id}</span></div></div></td><td><span className="port">{i.port}</span></td><td><div className="transport-cell"><span>{String(stream.network ?? (nativeSchemas[i.protocol] ? 'native' : 'tcp')).toUpperCase()}</span><Badge>{String(stream.security ?? 'none').toUpperCase()}</Badge></div></td><td><Badge color="purple">{policy.inboundMultipliers[i.id] ?? 1}×</Badge></td><td><div className="traffic-cell"><strong>{bytes(used, 1)}<span> / {i.total ? bytes(i.total, 0) : '∞'}</span></strong></div></td><td className="muted">{expiry(i.expiryTime)}</td><td><div className="row-actions">{server.version === 'v3' && <IconButton icon={Users} label={translateUI("Manage customers for {0}", i.remark)} onClick={onCustomers} />}<IconButton icon={Edit3} label={translateUI("Edit {0}", i.remark)} onClick={onEdit} /><IconButton icon={Copy} label={translateUI("Clone {0}", i.remark)} onClick={onClone} />{server.kind !== 'server' && server.version === 'v3' && <IconButton icon={RotateCcw} label={translateUI("Reset traffic for {0}", i.remark)} onClick={onReset} />}<IconButton icon={Trash2} label={translateUI("Delete {0}", i.remark)} onClick={onDelete} /></div></td></tr>;
}
const protocolDefaults = (protocol: string): JsonObject => {
  const clients: unknown[] = [];
  if (protocol === 'vless') return { clients, decryption: 'none', encryption: 'none', fallbacks: [] };
  if (protocol === 'vmess') return { clients };
  if (protocol === 'trojan') return { clients, fallbacks: [] };
  if (protocol === 'shadowsocks') return { method: 'aes-128-gcm', password: crypto.randomUUID(), network: 'tcp,udp', clients };
  if (protocol === 'http' || protocol === 'socks' || protocol === 'mixed') return { accounts: [], auth: 'password', udp: true };
  return {};
};

function listenerDefaults(protocol: string) {
  const defaults: JsonObject = protocol === 'masterdnsvpn' ? { DOMAIN: [], DATA_ENCRYPTION_METHOD: 2, clients: [] } : protocol === 'openvpn' ? { authentication: 'password', transport: 'udp', subnet: '10.80.0.0/24', dns: '1.1.1.1', cipher: 'AES-256-GCM', clients: [] } : protocol === 'openconnect' ? { subnet: '10.81.0.0/24', dns: '1.1.1.1', maxClients: 128, mtu: 1400, clients: [] } : protocol === 'ssh' ? { allowTcpForwarding: true, clients: [] } : protocol === 'wireguard-native' ? { address: '10.82.0.1/24', dns: '1.1.1.1', mtu: 1420, clients: [] } : protocolDefaults(protocol);
  return { settings: defaults, port: protocol === 'masterdnsvpn' ? 53 : protocol === 'openvpn' ? 1194 : protocol === 'ssh' ? 2222 : protocol === 'wireguard-native' ? 51820 : 443, streamSettings: nativeSchemas[protocol] ? {} : { network: protocol === 'hysteria' ? 'hysteria' : 'tcp', security: protocol === 'hysteria' ? 'tls' : 'none', ...(protocol === 'hysteria' ? { tlsSettings: { alpn: ['h3'], certificates: [] }, hysteriaSettings: { version: 2 } } : {}) } };
}

export function InboundDialog({ inbound, initialCore, onClose }: { inbound?: Inbound; initialCore?: string; onClose: () => void }) {
  const { remote, refresh, toast, server, servers, demo, capabilities, policy, savePolicy, inbounds } = usePanel();
  const full = server.kind === 'server';
  const creating = !inbound?.id;
  const configuredProtocols = coreCatalog.filter(c => capabilities?.cores.some(s => s.id === c.id && (s.installed || server.bound === 0))).flatMap(c => capabilities?.cores.find(s => s.id === c.id)?.protocols ?? []);
  const available = full ? configuredProtocols.length ? configuredProtocols : server.bound === 0 ? ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'socks', 'tunnel'] : [] : panelProtocols;
  const initialProtocol = available.find(p => coreForProtocol(p) === initialCore) || (available.includes('vless') ? 'vless' : available[0] || 'vless');
  const [tab, setTab] = useState('Basics'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [form, setForm] = useState<Inbound>(() => inbound ? structuredClone(inbound) : { id: 0, remark: '', enable: true, protocol: initialProtocol, ...listenerDefaults(initialProtocol), listen: '', up: 0, down: 0, total: 0, expiryTime: 0, trafficReset: 'never', subSortIndex: 1, shareAddrStrategy: 'node', port: initialProtocol === 'vless' ? randomInboundPort(inbounds) : listenerDefaults(initialProtocol).port, sniffing: { enabled: false, destOverride: ['http', 'tls', 'quic'], metadataOnly: false, routeOnly: false } });
  const [raw, setRaw] = useState(pretty(form));
  const [rate, setRate] = useState(policy.inboundMultipliers[inbound?.id ?? 0] ?? 1);
  const [savedInboundId, setSavedInboundId] = useState(inbound?.id || 0), [createdUnknown, setCreatedUnknown] = useState(false);
  const [serverIds, setServerIds] = useState([server.id]);
  const [fleetId] = useState(() => crypto.randomUUID());
  const [fleetSubmission, setFleetSubmission] = useState<{ serverIds: string[]; inbound: JsonObject; multiplier: number }>();
  const [fleetResult, setFleetResult] = useState<FleetInboundResult>();
  const deploymentServers = full ? servers.filter(s => s.kind === 'server' && (s.enabled || s.bound === 0 || s.id === server.id)) : [server];
  const fleetComplete = Boolean(fleetResult?.results.length && fleetResult.results.every(r => r.saved));
  const native = Boolean(nativeSchemas[form.protocol]);
  const protocols = [...new Set([...available, ...(inbound ? [inbound.protocol] : [])])].filter(p => p !== 'dns-resolver');
  const stream = parseObject(form.streamSettings), settings = parseObject(form.settings);
  const set = (key: string, value: unknown) => setForm(f => ({ ...f, [key]: value }));
  const [keyBusy, setKeyBusy] = useState(false), [authKind, setAuthKind] = useState('x25519_native');
  const [nodes, setNodes] = useState<JsonObject[]>([]);
  useEffect(() => { let alive = true; if (!full && server.version === 'v3') void remote<JsonObject[]>({ path: '/panel/api/nodes/list', method: 'GET' }).then(v => { if (alive && Array.isArray(v)) setNodes(v); }).catch(() => {}); return () => { alive = false; }; }, [remote, full, server.version]);
  const panelCertificate = async () => { if (Number(form.nodeId) > 0) throw new Error('Enter certificate paths that exist on the selected node.'); const result = parseObject(await remote({ path: server.version === 'v3' ? '/panel/api/server/getWebCertFiles' : '/panel/setting/all', method: server.version === 'v3' ? 'GET' : 'POST' })); const certificateFile = result.certFile || result.certificateFile || result.webCertFile, keyFile = result.keyFile || result.webKeyFile; if (!certificateFile || !keyFile) throw new Error('This panel has no reusable certificate. Enter the server certificate paths.'); return { certificateFile, keyFile, entries: result.entries }; };
  const remoteAction = !full && server.version === 'v3' ? (name: string, body?: JsonObject) => remote({ path: `/panel/api/server/${name}`, method: body ? 'POST' : 'GET', ...(body ? { body } : {}) }) : undefined;
  const generateVless = async () => { setKeyBusy(true); setError(''); try { const result = parseObject(await remoteAction!('getNewVlessEnc')); const auths = Array.isArray(result.auths) ? result.auths.map(parseObject) : []; const [algorithm, mode] = authKind.split('_'); const found = auths.find(a => { const label = String(a.label || '').toLowerCase().replace(/[-_\s]/g, ''); return a.id === (mode === 'native' ? algorithm : authKind) || label.includes(algorithm) && (mode === 'native' ? !label.includes('xorpub') && !label.includes('random') : label.includes(mode)); }); if (!found) throw new Error('The server did not return this encryption method.'); set('settings', { ...settings, decryption: found.decryption, encryption: found.encryption }); } catch (e) { setError((e as Error).message); } finally { setKeyBusy(false); } };
  const changeTab = (next: string) => { try { if (tab === 'JSON') { const parsed = JSON.parse(raw); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Enter a JSON object.'); setForm(parsed as Inbound); } else setRaw(pretty(form)); setTab(next); setError(''); } catch { setError('Fix the JSON before switching tabs.'); } };
  const chooseProtocol = (protocol: string) => {
    setForm(f => ({ ...f, protocol, core: coreForProtocol(protocol), ...listenerDefaults(protocol), port: nativeSchemas[protocol] ? listenerDefaults(protocol).port : f.port, settings: { ...listenerDefaults(protocol).settings, ...(parseObject(f.settings).publicHost ? { publicHost: parseObject(f.settings).publicHost } : {}) } }));
  };
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (creating && !demo && fleetSubmission) {
        const result = await api<FleetInboundResult>('/fleet/inbounds', 'POST', { id: fleetId, ...fleetSubmission });
        setFleetResult(result); await refresh();
        if (result.results.every(r => r.saved)) toast('Inbound settings saved. Server synchronization is queued.');
        return;
      }
      const payload = tab === 'JSON' ? JSON.parse(raw) as Inbound : structuredClone(form);
      if (!protocols.includes(payload.protocol)) throw new Error('Install the required core on the full-access server first.');
      if (!payload.protocol || !Number.isInteger(payload.port) || payload.port < 1 || payload.port > 65535) throw new Error('Enter a protocol and a port between 1 and 65535.');
      if (server.kind !== 'server' && nativeSchemas[payload.protocol]) throw new Error('This protocol requires full server access.');
      if (!savedInboundId && serverIds.includes(server.id) && inbounds.some(i => i.port === payload.port && Number(i.nodeId || 0) === Number(payload.nodeId || 0))) throw new Error('This port is already used by another inbound. Choose a different port.');
      if (!nativeSchemas[payload.protocol]) {
        const stream = parseObject(payload.streamSettings), r = parseObject(stream.realitySettings);
        if (stream.security === 'reality' && !r.privateKey) { const keys = await realityKeys(); payload.streamSettings = { ...stream, realitySettings: { ...r, privateKey: keys.privateKey, settings: { ...parseObject(r.settings), publicKey: keys.publicKey } } }; setForm({ ...payload }); }
        validateInboundSecurity(payload);
      }
      if (creating && !demo) {
        if (!serverIds.length) throw new Error('Choose at least one server.');
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) throw new Error('Enter a traffic multiplier between 0 and 100.');
        const submission = { serverIds: [...serverIds], inbound: { ...normalizeInboundCertificates(payload), id: 0 }, multiplier: rate };
        setFleetSubmission(submission);
        const result = await api<FleetInboundResult>('/fleet/inbounds', 'POST', { id: fleetId, ...submission });
        setFleetResult(result); await refresh();
        if (result.results.every(r => r.saved)) toast('Inbound settings saved. Server synchronization is queued.');
        return;
      }
      const isEdit = Boolean(savedInboundId);
      const result = parseObject(await remote({ path: `/panel/api/inbounds/${isEdit ? `update/${savedInboundId}` : 'add'}`, method: 'POST', body: { ...normalizeInboundCertificates(payload), id: savedInboundId } }));
      let savedId = savedInboundId || Number(result.id ?? 0); if (savedId) setSavedInboundId(savedId); else setCreatedUnknown(true);
      if (!savedId) savedId = (await remote<Inbound[]>({ path: '/panel/api/inbounds/list', method: 'GET' })).find(i => i.port === payload.port && i.protocol === payload.protocol)?.id ?? 0;
      if (!savedId) throw new Error("Inbound was created, but its ID could not be confirmed. Close this editor and refresh Inbounds before retrying."); setSavedInboundId(savedId); setCreatedUnknown(false);
      if (savedId && (rate !== 1 || policy.inboundMultipliers[savedId] !== undefined)) await savePolicy({ ...policy, inboundMultipliers: { ...policy.inboundMultipliers, [savedId]: rate } });
      await refresh(); toast(`Inbound ${isEdit ? 'updated' : 'created'}.`); onClose();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const network = String(stream.network ?? 'tcp'), security = String(stream.security ?? 'none');
  const reset = String(form.trafficReset || 'never');
  return <Modal title={inbound?.id ? translateUI("Edit inbound") : translateUI("Add Inbound")} wide onClose={() => { if (!busy) onClose(); }} footer={<><Button disabled={busy} onClick={onClose}>{fleetComplete ? translateUI("Done") : translateUI("Close")}</Button>{!fleetComplete && <Button variant="primary" busy={busy} disabled={createdUnknown || keyBusy || creating && !serverIds.length} type="submit" form="inbound-form">{inbound?.id ? translateUI("Save changes") : fleetSubmission ? translateUI("Retry unsaved servers") : translateUI("Create")}</Button>}</>}><form id="inbound-form" onSubmit={e => void save(e)} className="form-stack xray-form"><Tabs tabs={['Basics', 'Protocol', 'Stream', 'Security', 'Sniffing', 'Advanced']} value={tab} onChange={changeTab} />{error && <Notice tone="error">{error}</Notice>}
    {fleetSubmission && <Notice tone={fleetComplete ? 'success' : 'info'}>{fleetComplete ? translateUI("Saved in BenX-UI. These listener settings will be applied to every selected server when it is connected.") : translateUI("This creation request is kept unchanged so a retry cannot duplicate an inbound already saved on another server.")}</Notice>}
    {fleetResult && <div className="inbound-picker" role="status" aria-label={translateUI("Inbound deployment results")} style={{ padding: '5px 13px' }}>{fleetResult.results.map(result => <div key={result.serverId} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '10px 0', borderBottom: '1px solid var(--border)' }}><div><strong>{servers.find(s => s.id === result.serverId)?.name || result.serverId}</strong>{result.error && <small className="red-text block">{result.error}</small>}</div><Badge color={result.saved ? 'green' : 'red'}>{result.saved ? translateUI("Saved · sync queued") : translateUI("Not saved")}</Badge></div>)}</div>}
    <fieldset disabled={Boolean(fleetSubmission) || busy} style={{ display: 'contents', border: 0, padding: 0, margin: 0 }}>
    {tab === 'Basics' && <>
      <FormRow label={translateUI("Enabled")}><Switch checked={form.enable} onChange={v => set('enable', v)} label={translateUI("Enabled")} /></FormRow>
      <Field label={translateUI("Remark")}><input value={form.remark} onChange={e => set('remark', e.target.value)} /></Field>
      {creating && full && <FormRow label={translateUI("Servers")}><div style={{ width: '100%', display: 'grid', gap: 8 }}><div className="inbound-picker" role="group" aria-label={translateUI("Servers for this inbound")}>{deploymentServers.map(target => <label key={target.id} style={{ display: 'grid', gridTemplateColumns: '16px minmax(0, 1fr) auto', gap: 10, alignItems: 'center', minHeight: 46 }}><input type="checkbox" style={{ width: 16, height: 16, minWidth: 16, padding: 0 }} checked={serverIds.includes(target.id)} disabled={demo && target.id !== server.id} onChange={e => setServerIds(ids => e.target.checked ? [...new Set([...ids, target.id])] : ids.filter(id => id !== target.id))} aria-label={translateUI("Deploy inbound to {0}", target.name)} /><span><strong className="block">{target.name}</strong><small className="muted">{target.location || (translateUI("Full server access"))}</small></span><Badge color={target.bound === 0 ? 'purple' : 'blue'}>{target.bound === 0 ? translateUI("Saved profile") : translateUI("Full access")}</Badge></label>)}</div><small className="muted">{demo ? translateUI("Demo changes affect the selected demo server. Sign in to deploy across your saved servers.") : translateUI("{0} selected · The same listener settings will be saved on each server and applied when it connects.", serverIds.length)}</small></div></FormRow>}
      {(!creating || !full) && <Field label={creating ? translateUI("Panel / node") : translateUI("Deploy to")} hint={creating ? translateUI("This inbound is saved in the selected panel workspace. Its existing nodes remain available below.") : undefined}><Select value={String(form.nodeId || 0)} disabled={full || server.version !== 'v3'} onChange={e => set('nodeId', Number(e.target.value))}><option value={0}>{server.name} · {full ? translateUI("Server") : translateUI("Local panel")}</option>{nodes.map(n => <option key={String(n.id)} value={String(n.id)}>{String(n.name)}</option>)}{Number(form.nodeId) > 0 && !nodes.some(n => n.id === form.nodeId) && <option value={Number(form.nodeId)}>{translateUI("Node ")}{String(form.nodeId)}</option>}</Select></Field>}
      {full && <Field label={translateUI("Core")}><Select value={coreForProtocol(form.protocol)} onChange={e => { const p = protocols.find(p => coreForProtocol(p) === e.target.value); if (p) chooseProtocol(p); }}>{coreCatalog.filter(c => protocols.some(p => coreForProtocol(p) === c.id)).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>}
      <Field label={translateUI("Protocol")}><Select value={form.protocol} onChange={e => chooseProtocol(e.target.value)}>{protocols.filter(p => !full || coreForProtocol(p) === coreForProtocol(form.protocol)).map(p => <option key={p} value={p}>{p}</option>)}</Select></Field>
      <Field label={translateUI("Address")}><input value={form.listen} onChange={e => set('listen', e.target.value)} placeholder={translateUI("Leave blank to listen on all IPs")} /></Field>
      {full && <Field label={translateUI("Public proxy host")} hint={translateUI("The public address customers connect to.")}><input value={String(settings.publicHost || '')} onChange={e => set('settings', { ...settings, publicHost: e.target.value })} placeholder={translateUI("vpn.example.com")} /></Field>}
      {!full && <><Field label={translateUI("Share address strategy")}><Select value={String(form.shareAddrStrategy || 'node')} onChange={e => set('shareAddrStrategy', e.target.value)}><option value="node">{translateUI("Node address")}</option><option value="listen">{translateUI("Listen address")}</option><option value="custom">{translateUI("Custom address")}</option></Select></Field>{form.shareAddrStrategy === 'custom' && <Field label={translateUI("Share address")}><input value={String(form.shareAddr || '')} onChange={e => set('shareAddr', e.target.value)} /></Field>}<Field label={translateUI("Subscription sort order")}><input className="xray-short" type="number" value={Number(form.subSortIndex ?? 1)} onChange={e => set('subSortIndex', Number(e.target.value))} /></Field>{form.protocol === 'vless' && <FormRow label={translateUI("Disable XTLS flow")}><Switch checked={Boolean(form.disableFlow)} label={translateUI("Disable XTLS flow")} onChange={v => set('disableFlow', v)} /></FormRow>}</>}
      <Field label={translateUI("Port")}><input className="xray-short" type="number" min={1} max={65535} required value={form.port} onChange={e => set('port', Number(e.target.value))} /></Field>
      <Field label={translateUI("Total Flow")} hint={full ? translateUI("Native listeners currently support unlimited inbound traffic.") : translateUI("GB · 0 means unlimited.")}><input className="xray-short" type="number" min={0} step="any" disabled={full} value={form.total / GiB} onChange={e => set('total', Number(e.target.value) * GiB)} /></Field>
      <Field label={translateUI("Traffic Reset")}><Select disabled={full} value={reset} onChange={e => set('trafficReset', e.target.value)}>{['never', 'hourly', 'daily', 'weekly', 'monthly'].map(v => <option value={v} key={v}>{v[0].toUpperCase() + v.slice(1)}</option>)}</Select></Field>
      {['weekly', 'monthly'].includes(reset) && <Field label={translateUI("Reset day")}><input className="xray-short" type="number" min={1} max={reset === 'weekly' ? 7 : 31} value={Number(form.trafficResetDay ?? 1)} onChange={e => set('trafficResetDay', Number(e.target.value))} /></Field>}
      <Field label={translateUI("Duration")}><input type="date" value={form.expiryTime > 0 ? new Date(form.expiryTime).toISOString().slice(0, 10) : ''} onChange={e => set('expiryTime', e.target.value ? new Date(e.target.value).getTime() : 0)} /></Field>
    </>}
    {tab === 'Protocol' && <>{form.protocol === 'masterdnsvpn' && <><FeatureGuide topic="masterdns" /><FormRow label={translateUI("Encryption method")}><Select value={Number(settings.DATA_ENCRYPTION_METHOD ?? 2)} onChange={e => set('settings', { ...settings, DATA_ENCRYPTION_METHOD: Number(e.target.value) })}>{[[1, 'XOR'], [2, 'ChaCha20'], [3, 'AES-128-GCM'], [4, 'AES-192-GCM'], [5, 'AES-256-GCM']].map(([id, name]) => <option key={id} value={id}>{name}</option>)}</Select></FormRow><Notice tone={Number(settings.DATA_ENCRYPTION_METHOD) === 1 ? 'warning' : 'info'}>{Number(settings.DATA_ENCRYPTION_METHOD) === 1 ? translateUI("XOR provides obfuscation rather than strong encryption. ChaCha20 is the default recommendation.") : translateUI("Changing encryption affects every customer on this inbound. Update their subscription or client profile after server confirmation.")}</Notice><FormRow label={translateUI("Customer authentication")}><Select value={Number(settings.meteredInboundId || 0)} onChange={e => set('settings', { ...settings, meteredInboundId: Number(e.target.value) })}><option value={0}>{translateUI("Multiple customers · shared DNS key")}</option>{inbounds.filter(i => i.protocol === 'vless' && i.listen === '127.0.0.1' && i.excludeFromSub && ['tcp', 'raw'].includes(String(parseObject(i.streamSettings).network || 'tcp')) && ['none', ''].includes(String(parseObject(i.streamSettings).security || 'none')) && parseObject(i.settings).decryption === 'none').map(i => <option key={i.id} value={i.id}>{i.remark} · {i.port}</option>)}</Select></FormRow><Notice>{translateUI("Shared-key mode supports multiple customers with the same MasterDNS key, without individual metering or revocation. For individual authentication and traffic limits, create a private VLESS inbound: listen 127.0.0.1, RAW/TCP, security None, decryption none, and exclude it from subscriptions. Select it here. Customer attachments are paired automatically. Share supplies the DNS TCP configuration and a localhost VLESS link. The VLESS layer meters each customer's proxy traffic; DNS overhead is not counted.")}</Notice></>}<OptionsEditor key={form.protocol} schema={protocolSchema(form.protocol)} value={settings} onChange={v => set('settings', v)} omit={['clients', 'meteredInboundId', ...(form.protocol === 'masterdnsvpn' ? ['DATA_ENCRYPTION_METHOD'] : []), ...(['vless', 'trojan'].includes(form.protocol) && !(security === 'tls' && ['tcp', 'raw'].includes(network)) ? ['fallbacks'] : [])]} />{form.protocol === 'vless' && <FormRow label={translateUI("Generate keys")}><div className="xray-inline"><Select aria-label={translateUI("Generate keys method")} value={authKind} onChange={e => setAuthKind(e.target.value)}>{['x25519', 'mlkem768'].flatMap(a => ['native', 'xorpub', 'random'].map(m => <option value={`${a}_${m}`} key={`${a}_${m}`}>{a === 'x25519' ? translateUI("X25519") : translateUI("ML-KEM-768")} ({m})</option>))}</Select><Button variant="primary" disabled={!remoteAction} busy={keyBusy} onClick={() => void generateVless()}>{translateUI("Generate")}</Button><Button variant="danger" onClick={() => set('settings', { ...settings, decryption: 'none', encryption: 'none' })}>{translateUI("Clear")}</Button></div></FormRow>}{['vless', 'trojan'].includes(form.protocol) && !(security === 'tls' && ['tcp', 'raw'].includes(network)) && <Notice>{translateUI("Fallbacks become available with TLS enabled on the Security tab and RAW transmission.")}</Notice>}</>}
    {tab === 'Stream' && (native ? <Notice>{translateUI("Configure this core’s transport in Protocol.")}</Notice> : <StreamEditor protocol={form.protocol} value={stream} onChange={v => set('streamSettings', v)} />)}
    {tab === 'Security' && (native ? <Notice>{translateUI("This core manages security through its own protocol settings.")}</Notice> : <SecurityEditor value={stream} onChange={v => set('streamSettings', v)} panelCertificate={!full ? panelCertificate : undefined} remoteAction={remoteAction} />)}
    {tab === 'Sniffing' && (native ? <Notice>{translateUI("Sniffing is an Xray feature.")}</Notice> : <OptionsEditor schema={schemaFor('SniffingSchema')} value={parseObject(form.sniffing)} onChange={v => set('sniffing', v)} />)}
    {tab === 'Advanced' && <><Field label={translateUI("Traffic cost multiplier")} hint={translateUI("1 GB at 2× counts as 2 GB against the client quota. Services and client overrides can replace this default.")}><input type="number" min={0} max={100} step="0.1" className="xray-short" value={rate} onChange={e => setRate(Number(e.target.value))} /></Field><OptionsEditor schema={inboundExtraSchema} value={form} onChange={v => setForm(v as Inbound)} omit={['nodeId', 'shareAddrStrategy', 'shareAddr', 'subSortIndex', 'disableFlow', 'trafficReset', 'trafficResetDay']} />{!native && <OptionsEditor schema={schemaFor('StreamExtrasSchema')} value={stream} onChange={v => set('streamSettings', v)} omit={['sockopt', 'finalmask']} />}<FormRow label={translateUI("Configuration")}><Button onClick={() => changeTab('JSON')}>{translateUI("Edit JSON")}</Button></FormRow></>}
    {tab === 'JSON' && <><Notice>{translateUI("JSON edits preserve all additional options. Choose a tab above to return to the form.")}</Notice><textarea className="code-editor" aria-label={translateUI("Full inbound configuration")} rows={24} value={raw} onChange={e => setRaw(e.target.value)} spellCheck={false} /></>}
    </fieldset>
  </form></Modal>;
}
