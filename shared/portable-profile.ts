import { parseObject } from './types';
import { type ManagedDocument, validateDocument } from './managed';
export function portableCopy(raw: ManagedDocument, sourceURL: string, targetURL: string, standby: boolean) {
  const d = structuredClone(raw), origin = new URL(sourceURL).hostname === 'unconnected.invalid' ? String(raw.runtime._benxOriginURL || sourceURL) : sourceURL;
  const oldHost = new URL(origin).hostname.replace(/^\[|\]$/g, ''), targetHost = new URL(targetURL).hostname.replace(/^\[|\]$/g, ''), newHost = targetHost === 'unconnected.invalid' || new URL(targetURL).protocol === 'agent:' ? oldHost : targetHost;
  d.runtime._benxOriginURL = targetHost === 'unconnected.invalid' ? origin : targetURL;
  if (d.setup.certificate.ip === oldHost) d.setup.certificate.ip = newHost;
  for (const inbound of d.state.inbounds) {
    for (const key of ['listen', 'address']) if (inbound[key] === oldHost) inbound[key] = newHost;
    const settings = parseObject(inbound.settings);
    if (settings.publicHost === oldHost) inbound.settings = { ...settings, publicHost: newHost };
    if (standby) inbound.enable = false;
  }
  delete d.runtime._benxPanelBinding;
  if (standby && d.state.storefront) d.state.storefront.enabled = false;
  if (standby) for (const key of new Set(['xray', ...d.setup.cores, ...Object.keys(d.coreEnabled)])) d.coreEnabled[key] = false;
  return validateDocument(d);
}
