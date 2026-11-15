import {afterEach,describe,it,expect,vi} from 'vitest';
import {subscriptionHostProof,verifySubscriptionHost} from '../worker/subscription-domain';
import {newPolicy,validatePolicy} from '../shared/policy';
const env={ENCRYPTION_KEY:'private-account-key'} as Env;
afterEach(()=>vi.unstubAllGlobals());
describe('Subscription hostname verification',()=>{
  it('requires a public HTTPS hostname without credentials, port or path',()=>{
    for(const origin of ['http://sub.example.com','https://user:pass@sub.example.com','https://sub.example.com:444','https://sub.example.com/sub'])expect(()=>validatePolicy({...newPolicy(),subscriptionOrigin:origin})).toThrow();
    expect(validatePolicy({...newPolicy(),subscriptionOrigin:'https://sub.example.com/'}).subscriptionOrigin).toBe('https://sub.example.com');
  });
  it('verifies the exact Worker using a fresh signed challenge and rejects a different account',async()=>{
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('cloudflare-dns.com')?Response.json({Answer:[{type:1,data:'1.1.1.1'}]}):subscriptionHostProof(new Request(url),env)));
    await expect(verifySubscriptionHost('https://sub.example.com',env)).resolves.toBeUndefined();
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('cloudflare-dns.com')?Response.json({Answer:[{type:1,data:'1.1.1.1'}]}):subscriptionHostProof(new Request(url),{ENCRYPTION_KEY:'other-account-key'} as Env)));
    await expect(verifySubscriptionHost('https://sub.example.com',env)).rejects.toMatchObject({status:400});
  });
  it('does not follow redirects or fetch hosts resolving to private addresses',async()=>{
    const calls=vi.fn(async()=>Response.json({Answer:[{type:1,data:'127.0.0.1'}]}));vi.stubGlobal('fetch',calls);
    await expect(verifySubscriptionHost('https://sub.example.com',env)).rejects.toMatchObject({status:400});
    expect(calls).toHaveBeenCalledTimes(2);
    await expect(subscriptionHostProof(new Request('https://benx.example/api/public/subscription-host?challenge=bad'),env)).rejects.toMatchObject({status:400});
  });
});
