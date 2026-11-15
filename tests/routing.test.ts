import { describe,it,expect } from 'vitest';
import { basicRule,basicValues,validateRoutingRule } from '../shared/routing';
describe('Routing editor choices',()=>{
 it('changes simple presets without discarding complex per-inbound rules',()=>{
  const scoped={type:'field',domain:['example.com'],inboundTag:['entry'],outboundTag:'direct'};
  const config={outbounds:[{tag:'direct',protocol:'freedom'}],routing:{rules:[scoped,{type:'field',ip:['geoip:ir'],outboundTag:'blocked'}]}};
  const next=basicRule(config,'ip','blocked',['geoip:private']);
  expect(basicValues(next,'ip','blocked')).toEqual(['geoip:private']);expect(next.routing.rules).toContainEqual(scoped);
  expect(next.outbounds).toContainEqual({tag:'blocked',protocol:'blackhole',settings:{}});
 });
 it('validates outbound choice and port ranges while preserving advanced matchers',()=>{
  const outs=[{tag:'direct'}];
  expect(()=>validateRoutingRule({outboundTag:'missing'},outs,[])).toThrow('existing outbound');
  expect(()=>validateRoutingRule({outboundTag:'direct',balancerTag:'pool'},outs,[{tag:'pool'}])).toThrow('one outbound');
  expect(()=>validateRoutingRule({outboundTag:'direct',port:'2000-1000'},outs,[])).toThrow('increasing');
  expect(()=>validateRoutingRule({outboundTag:'direct',sourcePort:'65536'},outs,[])).toThrow('65535');
  expect(validateRoutingRule({outboundTag:'direct',port:'443,1000-2000',attrs:{host:'example'},enabled:false},outs,[])).toMatchObject({attrs:{host:'example'},enabled:false});
 });
});
