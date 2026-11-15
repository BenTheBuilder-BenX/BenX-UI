import {HttpError,readLimited,verifyPublicDns} from './security';
async function proof(challenge:string,env:Env){
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(env.ENCRYPTION_KEY),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode('benx-subscription-host:'+challenge))),v=>v.toString(16).padStart(2,'0')).join('');
}
export async function subscriptionHostProof(request:Request,env:Env){
  const challenge=new URL(request.url).searchParams.get('challenge')||'';
  if(!/^[a-f0-9-]{36}$/.test(challenge))throw new HttpError(400,'Invalid hostname verification challenge.');
  return Response.json({challenge,proof:await proof(challenge,env)},{headers:{'Cache-Control':'no-store'}});
}
export async function verifySubscriptionHost(origin:string,env:Env){
  await verifyPublicDns(origin);
  const challenge=crypto.randomUUID();
  try{
    const response=await fetch(`${origin}/api/public/subscription-host?challenge=${challenge}`,{redirect:'manual',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
    if(!response.ok)throw Error();
    const value=JSON.parse(new TextDecoder().decode(await readLimited(response,4096)));
    if(value.challenge!==challenge||value.proof!==await proof(challenge,env))throw Error();
  }catch{throw new HttpError(400,'This hostname does not reach this BenX Worker. Add it in Cloudflare Workers → this Worker → Settings → Domains & Routes, then retry.');}
}
