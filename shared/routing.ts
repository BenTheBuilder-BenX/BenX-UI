import { parseObject, type JsonObject } from './types';
export const listValues = (value: unknown): string[] => Array.isArray(value) ? value.map(String) : typeof value==='string' ? value.split(/[\n,]/).map(s=>s.trim()).filter(Boolean) : [];
export function validateRoutingRule(raw: JsonObject, outbounds: JsonObject[], balancers: JsonObject[]) {
 const r:JsonObject={...raw,type:'field'};
 if(Boolean(r.outboundTag)===Boolean(r.balancerTag))throw Error('Choose one outbound or one balancer.');
 if(r.outboundTag && !outbounds.some(o=>o.tag===r.outboundTag))throw Error('Choose an existing outbound.');
 if(r.balancerTag && !balancers.some(b=>b.tag===r.balancerTag))throw Error('Choose an existing balancer.');
 for(const k of ['port','sourcePort'])if(r[k] && !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(String(r[k])))throw Error('Use ports or ranges, such as 443,1000-2000.');
 for(const k of ['port','sourcePort'])for(const part of String(r[k]||'').split(',').filter(Boolean)){const numbers=part.split('-').map(Number);if(numbers.some(n=>n<1||n>65535)||numbers.length===2&&numbers[0]>numbers[1])throw Error('Port ranges must be between 1 and 65535 and increasing.');}
 if(r.network&&!['tcp','udp','tcp,udp'].includes(String(r.network)))throw Error('Choose TCP, UDP or any network.');
 return r;
}
export function basicRule(config: JsonObject, field:'ip'|'domain'|'protocol', target:'blocked'|'direct', values:string[]) {
 const routing=parseObject(config.routing),rules=(routing.rules||[]) as JsonObject[];
 const simple=(r:JsonObject)=>r.outboundTag===target&&Array.isArray(r[field])&&Object.keys(r).every(k=>['type','enabled','outboundTag',field].includes(k));
 const remaining=rules.filter(r=>!simple(r));
 const outbounds=[...config.outbounds as JsonObject[]];
 if(values.length&&!outbounds.some(o=>o.tag===target))outbounds.push({tag:target,protocol:target==='blocked'?'blackhole':'freedom',settings:{}});
 return {...config,outbounds,routing:{...routing,rules:[...(values.length?[{type:'field',outboundTag:target,[field]:values}]:[]),...remaining]}};
}
export function basicValues(config: JsonObject,field:string,target:string) { return ((parseObject(config.routing).rules||[]) as JsonObject[]).filter(r=>r.enabled!==false&&r.outboundTag===target&&Array.isArray(r[field])&&Object.keys(r).every(k=>['type','enabled','outboundTag',field].includes(k))).flatMap(r=>listValues(r[field])); }
