import { feedbackCSS } from './subscription-feedback';
import {originalSubscriptionAssets} from './original-subscription-assets';
import {escapeHTML} from './subscription-page';
export interface OriginalSubData {name:string;total:number;download:number;upload:number;start:number|null;expire:number|null;durationDays:number;pendingDays:number;active:boolean;url:string;language:string;apps:{name:string;url:string;download:string}[];qr:string;expiryLabel:string}
export const originalThemeNames=Object.keys(originalSubscriptionAssets);
export function originalSubscriptionPage(theme:string,data:OriginalSubData,options:{nonce:string;announcements:string;extra:string;feedback?:string;preview?:boolean}){
  let html:string=originalSubscriptionAssets[theme as keyof typeof originalSubscriptionAssets];
  if(!html) throw Error('Choose a supplied subscription template.');
  const safeJSON=JSON.stringify(data).replaceAll('<','\\u003c').replaceAll('>','\\u003e').replaceAll('&','\\u0026');
  html=html.replace(/<html[^>]*>/,`<html data-template="${theme}" lang="${data.language}" dir="${data.language==='fa'?'rtl':'ltr'}">`);
  html=html.replace('const INJECT=/*__SUB_DATA__*/null;',()=>`const INJECT=${safeJSON};`)
    .replace(/const D=INJECT\|\|\{[^;]+;/,'const D=INJECT;')
    .replace(/const span=noexp\?0:D.expire-\(D.start\|\|D.expire-30\*DAY\)/,'const span=noexp?0:(D.durationDays?D.durationDays*DAY:D.start?D.expire-D.start:0)')
    .replace(/fT=noexp\?1:Math.min\(1,Math.max\(0,\(D.expire-now\)\/span\)\)/,'fT=noexp?1:span>0?Math.min(1,Math.max(0,(D.expire-now)/span)):0')
    .replace(/const status=\([^;]+;/,"const status=!D.active?'expired':(!unl&&left<=0)?'limited':'active';")
    .replace(/let lang=st\('lang'\)\|\|\([^;]+;/,"let lang=['en','fa','ru','zh'].includes(D.language)?D.language:'en',N,t,first=true;");
  html=html.replace('const $=s=>',`Object.assign(T,{ru:{lf:'Осталось',us:'Использовано',total:'Всего',sub:'Ваша подписка',active:'Активна',limited:'Трафик исчерпан',expired:'Истекла',data:'осталось данных',time:'осталось времени',dleft:'Остаток трафика',tleft:'Осталось времени',used:'Использовано',down:'Загрузка',up:'Отправка',exp:'Истекает',link:'Ссылка подписки',copy:'Копировать',copied:'Скопировано!',unl:'Без лимита',never:'Без срока',days:'дней',d:'д',h:'ч',m:'м',s:'с'},zh:{lf:'剩余',us:'已用',total:'总量',sub:'您的订阅',active:'有效',limited:'流量已用完',expired:'已过期',data:'剩余流量',time:'剩余时间',dleft:'剩余流量',tleft:'剩余时间',used:'已用',down:'下载',up:'上传',exp:'到期时间',link:'订阅链接',copy:'复制',copied:'已复制！',unl:'不限流量',never:'永不过期',days:'天',d:'天',h:'时',m:'分',s:'秒'}});const $=s=>`)
    .replace("lang==='fa'?'fa':'en'","lang")
    .replace("lang==='fa'?'EN':'FA'","({en:'FA',fa:'RU',ru:'中文',zh:'EN'})[lang]")
    .replace("lang=lang==='fa'?'en':'fa'","lang=['en','fa','ru','zh'][(['en','fa','ru','zh'].indexOf(lang)+1)%4]");
  html=html.replace(/\$\('#apps'\)\.innerHTML=[^\n]+;/,`const apps=$('#apps');D.apps.forEach(a=>{const e=document.createElement('a');e.textContent=a.name;e.href=a.url;apps.append(e)});`);
  html=html.replace(/let qd=false;\$\('#qb'\)\.onclick=[^\n]+;/,`$('#qb').onclick=()=>{const q=$('#qr');q.classList.toggle('on');if(!q.firstChild&&D.qr){const i=document.createElement('img');i.src=D.qr;i.width=176;i.height=176;i.alt='Subscription QR';q.append(i)}};`);
  // Keep the original counters and animation loops. Only real expiry semantics change.
  html=html.replace('render();\n})();',`render();
const originalRender=render;render=()=>{originalRender();if(D.pendingDays){$('#tv').textContent=D.pendingDays;['#tu','#tl','#tL'].forEach(s=>{const el=$(s);if(el)el.textContent=D.expiryLabel})}else if(!noexp&&!span){['#tp','#tv','#tu'].forEach(s=>{const el=$(s);if(el&&s!=='#tv')el.textContent=s==='#tp'?'—':D.expiryLabel})}const exp=$('#sE');if(exp)exp.textContent=D.expiryLabel;};render();
document.querySelectorAll('[data-copy]').forEach(b=>b.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(b.dataset.copy);b.textContent=t.copied}catch{const i=b.closest('article')?.querySelector('input');i?.select()}}));
document.querySelectorAll('[data-reveal]').forEach(b=>b.addEventListener('click',()=>{const i=b.closest('details').querySelector('input[type=password],input[data-secret]');i.dataset.secret='1';i.type=i.type==='password'?'text':'password'}));
})();`);
  if (!options.preview) {
    html = html.replace("st('lang',lang);render()", "const u=new URL(location.href);u.searchParams.set('lang',lang);location.assign(u.href)");
  }
  const notices=options.announcements?`<div class="original-notices">${options.announcements}</div>`:'';
  html=html.replace('<div class="who">',()=>notices+'<div class="who">');
  html=html.replace('<p class="foot">BenX-UI</p>',()=>`${options.feedback || ''}${options.extra?`<details class="c original-extra"><summary>${({en:'Apps & connection files',fa:'برنامه‌ها و فایل‌های اتصال',ru:'Приложения и файлы',zh:'应用与连接文件'} as Record<string,string>)[data.language]||'Apps & connection files'}</summary>${options.extra}</details>`:''}<p class="foot">BenX-UI</p>`);
  html=html.replace('</style>',`${feedbackCSS}.original-notices{margin:20px 0}.original-notices aside{background:var(--gl);border:1px solid var(--bd);border-radius:18px;padding:16px;margin-bottom:12px}.original-notices p{white-space:pre-wrap}.original-extra{margin-top:14px}.original-extra summary{cursor:pointer}.original-extra .panel{margin-top:20px}.original-extra .apps{display:grid;grid-template-columns:1fr}.original-extra article{padding:12px;border:1px solid var(--bd);border-radius:14px;margin:10px 0}.original-extra input{width:100%;min-width:0;color:var(--tx);background:var(--gl);border:1px solid var(--bd);border-radius:10px;padding:10px;font:12px monospace;margin:10px 0}.original-extra button,.original-extra a{font:inherit;color:var(--tx);background:var(--gl);border:1px solid var(--bd);border-radius:12px;padding:8px 12px;text-decoration:none;display:inline-block}.original-extra table{width:100%;border-collapse:collapse;font-size:12px}.original-extra th,.original-extra td{padding:8px;border-bottom:1px solid var(--bd);text-align:start;overflow-wrap:anywhere}.original-extra h2{font-size:16px;margin:12px 0}.original-extra article div{display:flex;flex-wrap:wrap;gap:8px}</style>`);
  html=html.replaceAll('<script>',`<script nonce="${options.nonce}">`).replace('<title>BenX Subscription</title>',`<title>${escapeHTML(data.name)} · BenX</title>`);
  return html;
}
