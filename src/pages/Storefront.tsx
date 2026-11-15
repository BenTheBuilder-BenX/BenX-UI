import arcadeHTML from '../../agent/arcade.html?raw';

import { useEffect, useState } from 'react';

import { ExternalLink, Save, Store } from 'lucide-react';

import { usePanel } from '../context';

import { parseObject, type JsonObject } from '../../shared/types';

import { validateStorefront, validateStorefrontHTML } from '../../shared/storefront';

import { Button, Empty, Field, Notice, PageHeading, Select, Switch } from '../components/ui';

import { t } from '../lib/i18n';

export function Storefront() {

  const { server, inbounds, remote, operationMode, toast, refresh } = usePanel();

  const [form, setForm] = useState<JsonObject>({ enabled: false, template: 'arcade', mode: 'direct', domain: '', port: 443, inboundIds: [] }), [busy, setBusy] = useState(false), [error, setError] = useState(''), [ready, setReady] = useState(false);

  useEffect(() => { if (server.kind === 'server') void remote<JsonObject>({ path: '/benx/v1/storefront', method: 'GET' }).then(v => { setForm(f => ({ ...f, ...v })); setReady(true); }).catch(e => setError((e as Error).message)); }, []);

  const set = (k: string, v: unknown) => setForm(f => ({ ...f, [k]: v }));

  const eligible = inbounds.filter(i => ['vless', 'vmess', 'trojan', 'shadowsocks'].includes(i.protocol) && parseObject(i.streamSettings).network === 'ws' && ['none', undefined, ''].includes(parseObject(i.streamSettings).security as string | undefined));

  const url = `https://${form.domain}${Number(form.port) === 443 ? '' : ':' + form.port}/`;

  const uploadHTML = async (file?: File) => { if (!file) return; try { if (file.size > 200000) throw new Error('Choose an HTML file smaller than 200 KB.'); const html = validateStorefrontHTML(await file.text()); setForm(f => ({ ...f, template: 'custom', html, htmlName: file.name })); setError(''); } catch(e) { setError((e as Error).message); } };

  const save = async () => { setBusy(true); setError(''); try { const value = validateStorefront(form, inbounds); delete value.healthy; await remote({ path: '/benx/v1/storefront', method: 'POST', body: value }); toast(operationMode === 'manual' ? 'Storefront saved. Apply the saved batch to publish it on the VPS.' : 'Storefront saved. Server synchronization will deploy it.'); await refresh(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };

  return <><PageHeading title="Storefront" description="Your chosen static HTML page on the server domain, with optional WebSocket routes for compatible configs." />{server.kind !== 'server' ? <Empty icon={Store} title="Full server access required" description="Select a full-access server to install the HTTPS Storefront. Connected panel credentials alone cannot install a website." /> : <>

    {error && <Notice tone="error">{error}</Notice>}<div className="storefront-layout"><section className="card"><h2>{t('Website and WebSocket hosting')}</h2><div className="form-grid"><Field label="Enable Storefront"><Switch label="Enable Storefront" checked={Boolean(form.enabled)} onChange={v => set('enabled', v)} /></Field><Field label="Hosting mode"><Select value={String(form.mode)} onChange={e => set('mode', e.target.value)}><option value="direct">{t('Direct DNS')}</option><option value="cdn">{t('Cloudflare proxy / CDN')}</option></Select></Field><Field label="Website page"><Select value={String(form.template)} onChange={e => set('template', e.target.value)}><option value="arcade">{t('Arcade · included template')}</option><option value="custom">{t('Custom HTML file')}</option></Select></Field>{form.template === 'custom' && <Field label="Upload HTML file" hint="Static HTML and CSS, up to 200 KB. This page appears on normal visits; selected WebSocket paths continue carrying proxy traffic."><input type="file" accept=".html,.htm,text/html" onChange={e => void uploadHTML(e.target.files?.[0])} />{Boolean(form.htmlName) && <small>{String(form.htmlName)}</small>}<textarea aria-label={t('Custom HTML')} rows={6} value={String(form.html || '')} onChange={e => set('html', e.target.value)} /></Field>}<Field label="Domain" hint="Use the exact hostname covered by the certificate in server setup."><input value={String(form.domain)} placeholder="arcade.example.com" onChange={e => set('domain', e.target.value.trim().toLowerCase())} /></Field><Field label="HTTPS port" hint="443 gives a normal HTTPS URL. Another port must be included in the URL."><input type="number" min={1} max={65535} value={Number(form.port)} onChange={e => set('port', Number(e.target.value))} /></Field></div><Field label="WebSocket inbounds" hint="Optional. Selected listeners become private on localhost; the Storefront domain and port are advertised in subscriptions." group><div className="host-options">{eligible.map(i => <label key={i.id}><input type="checkbox" checked={(form.inboundIds as number[]).includes(i.id)} onChange={e => set('inboundIds', e.target.checked ? [...form.inboundIds as number[], i.id] : (form.inboundIds as number[]).filter(id => id !== i.id))} />{i.remark} · {String(parseObject(parseObject(i.streamSettings).wsSettings).path || t('Set a unique path first'))}</label>)}</div>{!eligible.length && <small>{t('Create a plain WebSocket inbound with a unique path such as /proxy to share the site. A standalone page needs no inbound.')}</small>}</Field><div className="heading-actions"><Button icon={Save} busy={busy} disabled={!ready} variant="primary" onClick={() => void save()}>Save hosting settings</Button>{Boolean(form.domain) && <a className="button" href={url} target="_blank" rel="noreferrer"><ExternalLink size={15} />{t('Open site')}</a>}</div></section><section className="card storefront-preview"><h2>{t(form.template === 'custom' ? 'Custom HTML · static preview' : 'Arcade · static preview')}</h2><iframe title="Storefront HTML preview" srcDoc={form.template === 'custom' ? String(form.html || '') : arcadeHTML} sandbox="" /><p className="muted">{t('Decorative HTML only. Games, purchases and account collection are disabled.')}</p></section></div>

    <section className="card setup-guide"><h2>{t('Domain and CDN setup')}</h2><ol><li>{t('Create an A record for this hostname pointing to the VPS IPv4 address. An AAAA record needs a working VPS IPv6 address. To point to another hostname, use CNAME instead of A.')}</li><li>{t('In server installation settings, request a certificate for this exact domain and allow port 80 for validation. Keep the record DNS-only while issuing the certificate.')}</li><li>{t('Choose a free HTTPS port and allow that TCP port in the provider firewall. Existing REALITY, raw TCP or DNS listeners cannot share the same port; use a different port or a separate server.')}</li><li>{t('For CDN mode, enable the Cloudflare proxy after certificate issuance and select Full (strict) encryption. Supported HTTPS ports are 443, 2053, 2083, 2087, 2096 and 8443. Cloudflare’s normal proxy supports the selected WebSocket routes, not raw TCP, REALITY or UDP.')}</li><li>{t('Save, then apply the batch in Manual mode or wait for confirmation in Automatic mode. Ordinary visits show the selected HTML page; the selected WebSocket paths forward to your private listeners. Copy fresh subscription links after changing the domain or port.')}</li></ol><Notice>{t('Disabling Storefront restores the selected listeners’ original addresses and ports. The website settings travel with server replacement profiles; point DNS to the replacement VPS and renew its domain certificate before publishing.')}</Notice>{Boolean(form.domain) && <p><strong>{t('Website URL')}: </strong><code>{url}</code></p>}</section>

  </>}</>;

}

