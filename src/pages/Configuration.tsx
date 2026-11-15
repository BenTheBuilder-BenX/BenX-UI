import { RoutingEditor } from '../components/RoutingEditor';
import { t as translateUI } from '../lib/i18n';
import { OutboundDialog } from '../components/OutboundDialog';
import { newOutbound } from '../lib/outbound-form';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Code2, Download, Edit3, Plus, RefreshCw, Save, Settings, Trash2 } from 'lucide-react';
import type { JsonObject } from '../../shared/types';
import { parseObject } from '../../shared/types';
import { settingsPath, usePanel } from '../context';
import { Badge, Button, Empty, Field, IconButton, Notice, PageHeading, Switch, Tabs } from '../components/ui';
import { download, pretty } from '../lib/format';

type ConfigSection = 'xray' | 'outbounds' | 'routing';
export function Configuration({ section }: { section: ConfigSection }) {
  const { server, remote, toast, confirm, navigate } = usePanel();
  const [config, setConfig] = useState<JsonObject | null>(null), [text, setText] = useState(''), [tab, setTab] = useState(section === 'routing' ? 'Routing' : section === 'outbounds' ? 'Outbounds' : 'Full config');
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [dirty, setDirty] = useState(false), [outboundEdit, setOutboundEdit] = useState<{ index: number; text: string }>(), [testUrl, setTestUrl] = useState('');
  const baseline = useRef<JsonObject | undefined>(undefined);
  const configPath = settingsPath(server, 'xray', '');
  const load = useCallback(async () => {
    setBusy(true); setError('');
    try {
      const response = parseObject(await remote({ path: configPath, method: 'POST' }));
      const cfg = parseObject(response.xraySetting);
      if (!Object.keys(cfg).length) throw new Error('The remote panel returned an empty Xray configuration.');
      baseline.current = structuredClone(cfg); setConfig(cfg); setText(pretty(cfg)); setDirty(false); setTestUrl(String(response.outboundTestUrl ?? ''));
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [remote, configPath]);
  useEffect(() => { void load(); }, [load]);
  const key = tab === 'Routing' ? 'routing' : tab === 'DNS' ? 'dns' : tab === 'Policy' ? 'policy' : tab === 'Logging' ? 'log' : '';
  const change = (next: string) => {
    try {
      let updated = config;
      if (tab !== 'Outbounds' && tab !== 'Routing' || tab === 'Routing' && section === 'xray') {
        const parsed = JSON.parse(text) as JsonObject; updated = key ? { ...config, [key]: parsed } : parsed;
      }
      setConfig(updated); const nextKey = next === 'Routing' ? 'routing' : next === 'DNS' ? 'dns' : next === 'Policy' ? 'policy' : next === 'Logging' ? 'log' : '';
      setText(pretty(nextKey ? updated?.[nextKey] ?? {} : updated)); setTab(next); setError('');
    } catch { setError('Fix the JSON before switching tabs.'); }
  };
  useEffect(() => { if (config && !dirty) setText(pretty(key ? config[key] ?? {} : config)); }, [config, dirty, key]);
  const save = async () => {
    let payload: JsonObject;
    try { payload = tab === 'Outbounds' || tab === 'Routing' && section === 'routing' ? config! : key ? { ...config, [key]: JSON.parse(text) } : JSON.parse(text) as JsonObject; }
    catch { setError('Invalid JSON. Please fix the configuration.'); return; }
    if (!payload || !Array.isArray(payload.outbounds)) { setError('The configuration must contain an outbounds array.'); return; }
    if (!await confirm('Apply Xray configuration?', 'This saves the configuration on the selected server and can affect active connections.', false)) return;
    setBusy(true); setError('');
    try {
      const response = parseObject(await remote({ path: settingsPath(server, 'xray', ''), method: 'POST' }));
      if (baseline.current && pretty(parseObject(response.xraySetting)) !== pretty(baseline.current)) throw new Error('The configuration changed remotely since you loaded it. Download your draft and refresh before applying.');
      await remote({ path: settingsPath(server, 'xray', 'update'), method: 'POST', body: { xraySetting: pretty(payload), outboundTestUrl: testUrl, expectedXraySetting: pretty(baseline.current) } });
      toast('Xray configuration saved.'); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const title = section === 'xray' ? 'Xray configs' : section === 'outbounds' ? 'Outbounds' : 'Routing';
  const outbounds = Array.isArray(config?.outbounds) ? config.outbounds as JsonObject[] : [];
  const updateOutbounds = (list: JsonObject[]) => { setConfig(c => ({ ...c, outbounds: list })); setDirty(true); };
  return <><PageHeading title={translateUI(title)} description={section === 'outbounds' ? translateUI("Choose how your server reaches the internet.") : section === 'routing' ? translateUI("Route traffic by domain, IP, protocol, and inbound.") : translateUI("Configure the Xray engine on your remote server.")} actions={<><Button icon={RefreshCw} busy={busy} onClick={() => { if (dirty) void confirm('Discard configuration draft?', 'Refreshing replaces your unsaved changes.', false).then(ok => { if (ok) void load(); }); else void load(); }}>{translateUI("Refresh")}</Button><Button icon={Save} variant="primary" disabled={!config || !dirty} busy={busy} onClick={() => void save()}>{translateUI("Save changes")}</Button></>} />
    {error && <Notice tone="error">{error}</Notice>}{dirty && <Notice>{translateUI("You have unsaved configuration changes. Apply them with Save changes.")}</Notice>}
    <section className={`card config-card config-${section}`}>{section === 'xray' && <Tabs tabs={['Full config', 'Outbounds', 'Routing', 'DNS', 'Policy', 'Logging']} value={tab} onChange={change} />}
      {!config ? <Empty icon={Code2} title={busy ? translateUI("Loading configuration…") : translateUI("Configuration unavailable")} description={translateUI("Connect a panel with configuration read permissions, then refresh.")} /> : tab === 'Outbounds' ? <><div className="table-toolbar"><div><h3>{translateUI("Outbound connections ")}<Badge>{outbounds.length}</Badge></h3></div><Button icon={Plus} onClick={() => setOutboundEdit({ index: -1, text: pretty(newOutbound('vless', server.version === 'v2')) })}>{translateUI("Add outbound")}</Button></div><div className="table-scroll"><table><thead><tr><th>{translateUI("TAG")}</th><th>{translateUI("PROTOCOL")}</th><th>{translateUI("CONFIGURATION")}</th><th>{translateUI("ACTIONS")}</th></tr></thead><tbody>{outbounds.map((o, n) => <tr key={n}><td><strong>{String(o.tag ?? 'Untagged')}</strong></td><td><Badge color="blue">{String(o.protocol ?? '').toUpperCase()}</Badge></td><td className="muted">{String(parseObject(o.settings).domainStrategy ?? parseObject(o.settings).address ?? ((parseObject(o.settings).vnext as JsonObject[])?.[0]?.address) ?? ((parseObject(o.settings).servers as JsonObject[])?.[0]?.address) ?? (o.protocol === 'freedom' ? 'Direct connection' : o.protocol === 'blackhole' ? 'Block traffic' : 'Custom configuration'))}</td><td><div className="row-actions"><IconButton icon={Edit3} label={translateUI("Edit outbound {0}", o.tag)} onClick={() => setOutboundEdit({ index: n, text: pretty(o) })} /><IconButton icon={Trash2} label={translateUI("Remove outbound {0} from draft", o.tag)} onClick={() => updateOutbounds(outbounds.filter((_, idx) => idx !== n))} /></div></td></tr>)}</tbody></table></div><div className="config-note"><Button icon={ArrowLeftRight} onClick={() => navigate('locations')}>{translateUI("Add an exit location")}</Button><Button icon={Settings} onClick={() => navigate('routing')}>{translateUI("Choose which traffic uses it")}</Button><Notice>{translateUI("Need an exit location? Import a provider connection in Free multi location, then choose it in Routing. Advanced integrations are available below.")}</Notice><Button icon={ArrowLeftRight} onClick={() => navigate('api')}>{translateUI("Open advanced outbound tools")}</Button></div></> : tab === 'Routing' && section === 'routing' ? <RoutingEditor config={config} onChange={c=>{setConfig(c);setDirty(true);}} /> : <div className="json-config"><div className="json-editor-head"><span>{key ? translateUI("{0}.json", key) : translateUI("xray-config.json")}</span><Badge>{translateUI("JSON")}</Badge><Button icon={Download} variant="ghost" onClick={() => download(`benx-${key || 'xray'}-draft.json`, text)}>{translateUI("Download draft")}</Button></div><textarea className="code-editor large-editor" aria-label={translateUI("{0} JSON configuration", tab)} spellCheck={false} value={text} onChange={e => { setText(e.target.value); setDirty(true); }} /><p className="muted">{translateUI("Edits preserve the rest of your configuration. JSON is validated before saving.")}</p></div>}
    </section>
    {outboundEdit && <OutboundDialog editing={outboundEdit.index >= 0} value={JSON.parse(outboundEdit.text)} onClose={() => setOutboundEdit(undefined)} onSave={value => { if (!value.tag || !value.protocol) throw new Error('Outbound needs a tag and protocol.'); const list = [...outbounds]; if (outboundEdit.index < 0) list.push(value); else list[outboundEdit.index] = value; if (new Set(list.map(o => o.tag)).size !== list.length) throw new Error('Outbound tags must be unique.'); updateOutbounds(list); setOutboundEdit(undefined); }} />}

  </>;
}
const labels: Record<string, string> = { webPort: 'Panel port', webBasePath: 'Panel base path', webSessionMaxAge: 'Session lifetime (minutes)', webListen: 'Listen address', webDomain: 'Panel domain', timeLocation: 'Time zone', webCertFile: 'Certificate file', webKeyFile: 'Private key file', subEnable: 'Enable subscriptions', subURI: 'Subscription URL', subPath: 'Subscription path', tgBotEnable: 'Enable Telegram bot', tgBotToken: 'Bot token', tgBotChatId: 'Admin chat ID', tgBotRuntime: 'Report schedule', tgCpu: 'CPU alert threshold', twoFactorEnable: 'Enable two-factor authentication' };
function humanize(key: string) { return labels[key] ?? key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()); }
function settingsGroup(key: string) {
  if (/^sub/i.test(key)) return 'Subscriptions'; if (/^tg/i.test(key)) return 'Telegram'; if (/discord/i.test(key)) return 'Discord';
  if (/smtp|mail/i.test(key)) return 'Email'; if (/ldap/i.test(key)) return 'LDAP';
  if (/cert|keyfile|secret|twofactor|auth|login|fail2ban|password|token|security/i.test(key)) return 'Security'; return 'General';
}
export function PanelSettings() {
  const { server, remote, toast, confirm, navigate } = usePanel();
  const [form, setForm] = useState<JsonObject>({}), [raw, setRaw] = useState(''), [tab, setTab] = useState('General'), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false);
  const original = useRef<JsonObject>({});
  const load = useCallback(async () => {
    setBusy(true); setError(''); try { const value = parseObject(await remote({ path: settingsPath(server, 'setting', 'all'), method: 'POST' })); original.current = structuredClone(value); setForm(value); setRaw(pretty(value)); setDirty(false); setLoaded(true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }, [remote, server]);
  useEffect(() => { void load(); }, [load]);
  const changeTab = (next: string) => { try { if (tab === 'JSON') setForm(parseObject(JSON.parse(raw))); else setRaw(pretty(form)); setTab(next); setError(''); } catch { setError('Fix the settings JSON first.'); } };
  const save = async () => {
    let edited: JsonObject;
    try { edited = tab === 'JSON' ? parseObject(JSON.parse(raw)) : form; } catch { setError('Invalid settings JSON.'); return; }
    if (!await confirm('Save remote panel settings?', 'Changing panel ports, paths, or credentials can require updating this connection. Some settings need a panel restart.', false)) return;
    setBusy(true); setError('');
    try {
      const latest = parseObject(await remote({ path: settingsPath(server, 'setting', 'all'), method: 'POST' }));
      const changes = Object.fromEntries(Object.entries(edited).filter(([k, v]) => pretty(v) !== pretty(original.current[k])));
      for (const k of Object.keys(changes)) if (pretty(latest[k]) !== pretty(original.current[k])) throw new Error(`${humanize(k)} changed remotely. Refresh settings before editing it.`);
      await remote({ path: settingsPath(server, 'setting', 'update'), method: 'POST', body: { ...latest, ...changes } }); toast('Panel settings saved.'); await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const set = (key: string, value: unknown) => { setForm(f => ({ ...f, [key]: value })); setDirty(true); };
  const keys = Object.keys(form).filter(k => settingsGroup(k) === tab);
  return <><PageHeading title={translateUI("Panel settings")} description={translateUI("Configure your remote 3X-UI panel and its integrations.")} actions={<><Button icon={RefreshCw} busy={busy} onClick={() => { if (dirty) void confirm('Discard settings draft?', 'Reloading replaces unsaved settings.', false).then(ok => { if (ok) void load(); }); else void load(); }}>{translateUI("Refresh")}</Button><Button icon={Save} variant="primary" busy={busy} disabled={!dirty || !loaded} onClick={() => void save()}>{translateUI("Save settings")}</Button></>} />{error && <Notice tone="error">{error}</Notice>}
    <section className="card settings-card"><Tabs tabs={['General', 'Security', 'Subscriptions', 'Telegram', 'Discord', 'Email', 'LDAP', 'JSON']} value={tab} onChange={changeTab} /><div className="settings-content"><h3>{tab === 'JSON' ? translateUI("All panel settings") : translateUI("{0} settings", tab)}</h3><p className="muted">{translateUI("These settings are loaded from the selected server and reflect its installed features.")}</p>
      {!loaded ? <Empty icon={Settings} title={busy ? translateUI("Loading settings…") : translateUI("Settings unavailable")} description={translateUI("Connect a panel and refresh to load its settings.")} /> : tab === 'JSON' ? <textarea className="code-editor large-editor" aria-label={translateUI("All remote panel settings JSON")} spellCheck={false} value={raw} onChange={e => { setRaw(e.target.value); setDirty(true); }} /> : keys.length ? <div className="form-grid">{keys.map(key => typeof form[key] === 'boolean' ? <div key={key} className="setting-toggle"><span>{humanize(key)}</span><Switch label={humanize(key)} checked={form[key] as boolean} onChange={v => set(key, v)} /></div> : <Field key={key} label={humanize(key)}>{typeof form[key] === 'object' ? <textarea className="code-editor" rows={4} defaultValue={pretty(form[key])} onBlur={e => { try { set(key, JSON.parse(e.target.value)); setError(''); } catch { setError(`${humanize(key)} must be valid JSON.`); } }} /> : <input type={typeof form[key] === 'number' ? 'number' : /password|pass$|token|secret/i.test(key) ? 'password' : 'text'} autoComplete="off" value={String(form[key] ?? '')} onChange={e => set(key, typeof form[key] === 'number' ? Number(e.target.value) : e.target.value)} />}</Field>)}</div> : <Empty icon={Settings} title={translateUI("No {0} settings exposed", tab.toLowerCase())} description={translateUI("Your panel version may not include this integration. Check the JSON tab or API console for advanced controls.")} />}
      {tab === 'Security' && <div className="config-note"><Button icon={ArrowLeftRight} onClick={() => navigate('locations')}>{translateUI("Add an exit location")}</Button><Button icon={Settings} onClick={() => navigate('routing')}>{translateUI("Choose which traffic uses it")}</Button><Notice>{translateUI("Token creation, token scopes, credential changes, Fail2ban status, and other security operations are available through the API console.")}</Notice><Button onClick={() => navigate('api')}>{translateUI("Open security API tools")}</Button></div>}
    </div></section>
  </>;
}
