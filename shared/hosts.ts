import { parseObject, type Inbound, type JsonObject } from './types';
export function advertisedHosts(inbound: Inbound, hosts: JsonObject[], address: string, format = 'raw'): Array<{ inbound: Inbound; address: string }> {
  const groups = hosts.filter(h => !h.isDisabled && !h.isHidden && (h.inboundIds as number[] || [h.inboundId]).includes(inbound.id));
  if (!groups.length) return [{ inbound, address }];
  return groups.filter(h => !(h.excludeFromSubTypes as string[] || []).includes(format)).flatMap(h => (Array.isArray(h.hosts) ? h.hosts as string[] : [String(h.address || address)]).map(a => {
    const row = structuredClone(inbound), stream = parseObject(row.streamSettings);
    const endpoint = new URL(`https://${a}`); row.port = Number(a.match(/:(\d+)$/)?.[1] || h.port || row.port);
    row.remark = String(h.remark || row.remark);
    if (h.security && h.security !== 'same') stream.security = h.security;
    const key = stream.security === 'reality' ? 'realitySettings' : 'tlsSettings', tls = parseObject(stream[key]);
    if (h.sni || h.keepSniBlank || h.overrideSniFromAddress) tls.serverName = h.keepSniBlank ? '' : h.overrideSniFromAddress ? endpoint.hostname : h.sni;
    if (Array.isArray(h.alpn) && h.alpn.length) tls.alpn = h.alpn;
    if (h.fingerprint) tls.settings = { ...parseObject(tls.settings), fingerprint: h.fingerprint };
    if (h.allowInsecure) tls.allowInsecure = true;
    if(key==='realitySettings') tls.settings={...parseObject(tls.settings), ...(h.sni ? {serverName:h.sni} : {}), ...(h.fingerprint ? {fingerprint:h.fingerprint} : {})};
    stream[key] = tls;
    const transportKey = `${stream.network || 'tcp'}Settings`, transport = parseObject(stream[transportKey]);
    if (h.path) transport.path = h.path;
    if (h.hostHeader) transport.headers = { ...parseObject(transport.headers), Host: h.hostHeader };
    stream[transportKey] = transport; row.streamSettings = stream;
    return { inbound: row, address: endpoint.hostname.replace(/^\[|\]$/g, '') };
  }));
}
