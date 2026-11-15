import {describe,it,expect} from 'vitest';
import {originalSubscriptionAssets} from '../shared/original-subscription-assets';
import {originalSubscriptionPage,originalThemeNames} from '../shared/original-subscription-page';
describe('Original subscription designs',()=>{
  for(const theme of originalThemeNames)it(`preserves ${theme} CSS and effects while replacing sample data`,()=>{
    const source=originalSubscriptionAssets[theme as keyof typeof originalSubscriptionAssets];
    const html=originalSubscriptionPage(theme,{name:'Alice </script>',total:1000,download:120,upload:30,start:null,expire:null,durationDays:30,pendingDays:30,active:true,url:'https://sub.example.com/sub/token',language:'fa',apps:[],qr:'',expiryLabel:'30 days after first connection'},{nonce:'test',announcements:'<aside>Notice</aside>',extra:'<p>Files</p>'});
    expect(html).toContain(source.match(/<style>([\s\S]*?)<\/style>/)![1]);
    expect(html).toContain('requestAnimationFrame');expect(html).toContain('const D=INJECT;');
    expect(html).not.toContain('46.2*GB');expect(html).not.toContain('D.expire-30*DAY');
    expect(html).not.toContain('Alice </script>');expect(html).toContain('Alice \\u003c/script\\u003e');
    expect(html).toContain('<aside>Notice</aside>');expect(html).toContain('nonce="test"');
    const script=html.match(/<script nonce="test">([\s\S]*?)<\/script>/)![1];
    expect(()=>new Function(script)).not.toThrow();
  });
});
