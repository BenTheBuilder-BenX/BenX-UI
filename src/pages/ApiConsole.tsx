import { t as translateUI } from '../lib/i18n';
import { workspaceHeaders } from '../lib/api';
import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Code2, Copy, Download, ExternalLink, Globe, Network, Play, Plus, Search, Tags } from 'lucide-react';
import operationData from '../../shared/operations.json';
import type { JsonObject, Operation } from '../../shared/types';
import { usePanel } from '../context';
import { Badge, Button, Empty, Field, Modal, Notice, PageHeading, Select } from '../components/ui';
import { download, pretty } from '../lib/format';

export const operations: Operation[] = operationData as Operation[];
export function ApiConsole() {
  const { server } = usePanel();
  const available = useMemo(() => operations.filter(o => o.version === server.version), [server.version]);
  const [search, setSearch] = useState(''), [group, setGroup] = useState('all'), [selected, setSelected] = useState(available[0]);
  const groups = [...new Set(available.map(o => o.group))];
  const visible = available.filter(o => (group === 'all' || o.group === group) && `${o.path} ${o.summary}`.toLowerCase().includes(search.toLowerCase()));
  return <><PageHeading title={translateUI("API console")} description={translateUI("Every exposed management operation, from one secure workspace.")} actions={<Badge color="blue">{available.length}{translateUI(" operations · ")}{server.version === 'v3' ? translateUI("3X-UI 3.x") : translateUI("3X-UI 2.x")}</Badge>} />
    <Notice>{translateUI("Operations depend on your remote panel’s installed release and API token scopes. Review request details before executing. Server processes run on the remote host.")}</Notice>
    <div className="api-layout"><section className="card api-list"><div className="api-list-filter"><div className="table-search"><Search size={15} /><input placeholder={translateUI("Find an operation…")} value={search} aria-label={translateUI("Search API operations")} onChange={e => setSearch(e.target.value)} /></div><Select value={group} onChange={e => setGroup(e.target.value)} aria-label={translateUI("API operation category")}><option value="all">{translateUI("All categories")}</option>{groups.map(g => <option key={g}>{g}</option>)}</Select></div><div className="operation-list">{visible.map(o => <button key={o.method + o.path} className={`operation-item ${selected?.path === o.path && selected?.method === o.method ? 'active' : ''}`} onClick={() => setSelected(o)}><Badge color={o.method === 'GET' ? 'green' : 'blue'}>{o.method}</Badge><div><strong>{o.path.replace('/panel/api/', '').replace('/panel/', '')}</strong><small>{o.group}</small></div></button>)}{!visible.length && <Empty icon={BookOpen} title={translateUI("No matching operations")} description={translateUI("Try another category or search.")} />}</div></section><section className="card api-detail">{selected ? <RequestEditor key={selected.method + selected.path} operation={selected} /> : <Empty icon={BookOpen} title={translateUI("Select an operation")} description={translateUI("Choose a supported API request from the list.")} />}</section></div>
    <p className="api-source">{translateUI("API definitions adapted from the ")}<a href="https://github.com/MHSanaei/3x-ui/blob/main/docs/public/openapi.json" target="_blank" rel="noreferrer">{translateUI("3X-UI OpenAPI reference ")}<ExternalLink size={12} /></a>{translateUI(". Includes reviewed 2.x compatibility routes.")}</p>
  </>;
}
export function RequestEditor({ operation, initialBody, initialParams, onDone }: { operation: Operation; initialBody?: JsonObject; initialParams?: Record<string, string>; onDone?: () => void }) {
  const { remote, demo, server, confirm, toast } = usePanel();
  const [params, setParams] = useState<Record<string, string>>(initialParams ?? {}), [query, setQuery] = useState<Record<string, string>>({}), [body, setBody] = useState(pretty(initialBody ?? operation.example)), [result, setResult] = useState<unknown>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [elapsed, setElapsed] = useState(0), [file, setFile] = useState<File>();
  const path = operation.path.replace(/\{([^}]+)\}/g, (_, key: string) => encodeURIComponent(params[key] ?? `{${key}}`));
  const write = operation.path.endsWith('/backuptotgbot') || operation.method !== 'GET' && !/(\/all$|\/xray\/$|\/logs\/|\/xraylogs\/|\/onlines$|\/lastOnline$|\/testOutbound|\/routeTest|\/renewalPreview)/.test(operation.path);
  const execute = async (e: React.FormEvent) => {
    e.preventDefault(); setError('');
    if (operation.parameters.some(p => p.in === 'path' && !params[p.name])) { setError('Fill every path parameter.'); return; }
    let parsed: JsonObject;
    try { const value = JSON.parse(body) as unknown; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); parsed = value as JsonObject; }
    catch { setError('Request body must be a valid JSON object.'); return; }
    if (write && !await confirm('Execute API operation?', `${operation.method} ${path}\nThis sends the displayed request to ${server.name}.`, true)) return;
    setBusy(true); const start = performance.now(); setResult(undefined);
    try {
      if (!demo && (operation.path.endsWith('/getDb') || operation.path.endsWith('/getMigration'))) {
        const response = await fetch(`/api/servers/${server.id}/request`, { method: 'POST', headers: { ...workspaceHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ path, method: operation.method, body: parsed, query }) });
        if (!response.ok || response.headers.get('Content-Type')?.includes('json')) { const data = await response.json() as JsonObject; throw new Error(String(data.msg ?? 'Download failed.')); }
        download(operation.path.endsWith('/getDb') ? '3x-ui-backup.db' : '3x-ui-migration.zip', await response.blob()); setResult({ downloaded: true });
      } else if (operation.encoding === 'multipart/form-data') {
        if (demo) throw new Error('File uploads require a connected real server.');
        if (!file) throw new Error('Choose a file to upload.');
        const form = new FormData(); form.set('file', file); form.set('_path', path); form.set('_method', operation.method);
        for (const [k, v] of Object.entries(parsed)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
        const response = await fetch(`/api/servers/${server.id}/upload`, { method: 'POST', headers: workspaceHeaders(), body: form });
        const data = await response.json() as JsonObject;
        if (!response.ok || data.success === false) throw new Error(String(data.msg ?? 'Upload failed.')); setResult(data); onDone?.();
      } else {
        const response = await remote({ path, method: operation.method, body: parsed, query: Object.fromEntries(Object.entries(query).filter(([, v]) => v !== '')) });
        if (response instanceof Blob) { download(`${path.split('/').at(-1) || 'benx-export'}.bin`, response); setResult({ downloaded: true, bytes: response.size }); }
        else setResult(response);
        onDone?.();
      }
      setElapsed(Math.round(performance.now() - start));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  return <form onSubmit={e => void execute(e)} className="request-editor"><div className="request-title"><Badge color={operation.method === 'GET' ? 'green' : 'blue'}>{operation.method}</Badge><span>{operation.group}</span></div><code className="request-path">{operation.path}</code><p className="request-summary">{operation.summary}</p>
    {operation.parameters.filter(p => p.in === 'path').length > 0 && <div className="form-grid">{operation.parameters.filter(p => p.in === 'path').map(p => <Field key={p.name} label={p.name} hint={translateUI(p.description)}><input required value={params[p.name] ?? ''} onChange={e => setParams(v => ({ ...v, [p.name]: e.target.value }))} /></Field>)}</div>}
    {operation.parameters.filter(p => p.in === 'query').length > 0 && <div className="form-grid">{operation.parameters.filter(p => p.in === 'query').map(p => <Field key={p.name} label={translateUI("{0} (query)", p.name)} hint={translateUI(p.description)}><input value={query[p.name] ?? ''} onChange={e => setQuery(v => ({ ...v, [p.name]: e.target.value }))} required={p.required} /></Field>)}</div>}
    {operation.method !== 'GET' && <Field label={translateUI("Request body")} hint={translateUI("Sent as {0}. Nested values are encoded automatically for legacy form endpoints.", operation.encoding)}><textarea className="code-editor" rows={12} value={body} onChange={e => setBody(e.target.value)} spellCheck={false} /></Field>}
    {operation.encoding === 'multipart/form-data' && <Field label={translateUI("Upload file (20 MB maximum)")}><input type="file" onChange={e => setFile(e.target.files?.[0])} /></Field>}
    {Object.keys(operation.schema).length > 0 && <details className="request-schema"><summary>{translateUI("Request schema")}</summary><pre className="code-preview">{pretty(operation.schema)}</pre></details>}
    {error && <Notice tone="error">{error}</Notice>}<div className="request-execute"><Button type="submit" variant="primary" icon={Play} busy={busy}>{translateUI("Execute request")}</Button><span className="muted">{demo ? translateUI("Demo simulation") : translateUI("Sent securely through your Worker")}</span></div>
    {result !== undefined && <div className="request-response"><div><Badge color="green">{translateUI("Completed")}</Badge><span className="muted">{elapsed}{translateUI(" ms")}</span><Button icon={Copy} variant="ghost" onClick={() => void navigator.clipboard.writeText(pretty(result)).then(() => toast('Response copied.')).catch(() => toast('Could not copy response.', true))}>{translateUI("Copy")}</Button><Button icon={Download} variant="ghost" onClick={() => download('benx-api-response.json', pretty(result))}>{translateUI("Download")}</Button></div><pre className="code-preview">{pretty(result)}</pre></div>}
  </form>;
}
export function Resources({ section }: { section: 'groups' | 'nodes' | 'hosts' }) {
  const { server, remote, toast } = usePanel();
  const group = section === 'groups' ? 'Client Groups' : section === 'nodes' ? 'Nodes' : 'Hosts';
  const [items, setItems] = useState<JsonObject[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [edit, setEdit] = useState<{ operation: Operation; body?: JsonObject; params?: Record<string, string> }>();
  const path = section === 'groups' ? '/panel/api/clients/groups' : `/panel/api/${section}/list`;
  const available = operations.filter(o => o.version === server.version && (section === 'groups' ? o.path.includes('/clients/groups') : o.group === group));
  const load = async () => { setLoading(true); setError(''); try { const response = await remote<unknown>({ path, method: 'GET' }); const rows = Array.isArray(response) ? response : []; setItems(rows.map(r => typeof r === 'string' ? { name: r } : r as JsonObject)); } catch (e) { setError((e as Error).message); } finally { setLoading(false); } };
  useEffect(() => { void load(); /* Re-mounts when the selected server changes. */ }, []);
  const create = available.find(o => o.path.endsWith(section === 'groups' ? '/create' : '/add'));
  const icon = section === 'groups' ? Tags : section === 'nodes' ? Network : Globe;
  const title = section === 'groups' ? 'Groups' : section === 'nodes' ? `${server.name} · Panel nodes` : 'Hosts';
  const openOperation = (operation: Operation) => setEdit({ operation });
  return <><PageHeading title={translateUI(title)} description={section === 'groups' ? translateUI("Organize clients and apply group-level traffic controls.") : section === 'nodes' ? translateUI("These servers are registered as nodes under the selected 3X-UI panel. BenX-UI manages them through that one panel connection.") : translateUI("Manage advertised hosts and subscription endpoints.")} actions={create && <Button icon={Plus} variant="primary" onClick={() => openOperation(create)}>{translateUI("Add ")}{section === 'groups' ? translateUI("group") : section === 'nodes' ? translateUI("node") : translateUI("host")}</Button>} />
    {server.version === 'v2' ? <Notice tone="warning">{translateUI("Native ")}{translateUI(section)}{translateUI(" APIs are available in 3X-UI 3.x. Upgrade your remote panel for these features. Independent panels can still be managed from Servers.")}</Notice> : <>
      {error && <Notice tone="error">{error}</Notice>}<section className="card resource-card"><div className="table-toolbar"><h3>{translateUI(title)} <Badge>{items.length}</Badge></h3><Button onClick={() => void load()} busy={loading}>{translateUI("Refresh")}</Button></div>{items.length ? <div className="table-scroll"><table><thead><tr><th>{translateUI("NAME / ID")}</th><th>{translateUI("DETAILS")}</th><th>{translateUI("STATE")}</th><th>{translateUI("CONFIGURATION")}</th></tr></thead><tbody>{items.map((item, n) => <tr key={String(item.id ?? item.groupId ?? item.name ?? n)}><td><strong>{String(item.name ?? item.remark ?? item.groupId ?? item.id ?? n + 1)}</strong></td><td>{String(item.address ?? (item.hosts as string[])?.join(', ') ?? item.clientCount ?? 'Client group')}</td><td><Badge color={item.status === 'offline' || item.isDisabled || item.enable === false ? 'orange' : 'green'}>{String(item.status ?? (item.isDisabled || item.enable === false ? 'Disabled' : 'Enabled'))}</Badge></td><td><Button icon={Code2} variant="ghost" onClick={() => { const op = available.find(o => section === 'groups' ? o.path.endsWith('/rename') : o.path.includes('/update/')); if (!op) { toast('Choose an operation from the management tools below.'); return; } const key = section === 'hosts' ? 'groupId' : 'id'; setEdit({ operation: op, body: section === 'groups' ? { oldName: item.name, newName: item.name } : item, params: { [key]: String(item[key] ?? '') } }); }}>{translateUI("Manage")}</Button></td></tr>)}</tbody></table></div> : <Empty icon={icon} title={loading ? translateUI("Loading {0}…", section) : translateUI("No {0} found", section)} description={translateUI("Use the management tools below to configure this feature on the remote panel.")} />}</section>
      <section className="card resource-tools"><h3>{translateUI("Management tools")}</h3><p className="muted">{translateUI("All available ")}{translateUI(section)}{translateUI(" operations on the selected API version.")}</p><div className="tool-grid">{available.map(o => <button key={o.method + o.path} onClick={() => openOperation(o)}><Badge color={o.method === 'GET' ? 'green' : 'blue'}>{o.method}</Badge><span>{o.path.split('/').filter(Boolean).slice(-2).join(' / ')}</span><ExternalLink size={13} /></button>)}</div></section>
    </>}
    {edit && <Modal title={`${title} · ${edit.operation.path.split('/').at(-1)}`} wide onClose={() => setEdit(undefined)}><RequestEditor operation={edit.operation} initialBody={edit.body} initialParams={edit.params} onDone={() => void load()} /></Modal>}
  </>;
}
