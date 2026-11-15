import QRCode from 'qrcode';
export function subscriptionQR(url:string){
  const {modules}=QRCode.create(url,{errorCorrectionLevel:'L'}),size=modules.size;
  let path='';for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(modules.get(y,x))path+=`M${x+4} ${y+4}h1v1h-1z`;
  return 'data:image/svg+xml;base64,'+btoa(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size+8} ${size+8}"><rect width="100%" height="100%" fill="white"/><path d="${path}" fill="black"/></svg>`);
}
