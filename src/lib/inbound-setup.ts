import { parseObject, type Inbound } from '../../shared/types';
export function randomInboundPort(inbounds: Inbound[]): number { const used = new Set(inbounds.map(i => i.port)); const start = crypto.getRandomValues(new Uint32Array(1))[0] % 55536; for (let n = 0; n < 55536; n++) { const port = 10000 + (start + n) % 55536; if (!used.has(port)) return port; } return 0; }
export function randomSecret(length = 32) { return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length)))); }
export async function realityKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']) as CryptoKeyPair;
  const [priv, pub] = await Promise.all([crypto.subtle.exportKey('jwk', pair.privateKey), crypto.subtle.exportKey('jwk', pair.publicKey)]);
  if (!priv.d || !pub.x) throw new Error('This browser cannot export REALITY keys. Add a key pair in Security.');
  return { privateKey: priv.d, publicKey: pub.x };
}
export function normalizeInboundCertificates(inbound: Inbound) {
  const stream = parseObject(inbound.streamSettings), tls = parseObject(stream.tlsSettings);
  if (stream.security !== 'tls' || !Array.isArray(tls.certificates)) return inbound;
  const certificates = tls.certificates.map(c => { const cert = { ...parseObject(c) }, files = cert.useFile === undefined ? Boolean(cert.certificateFile || cert.keyFile) : cert.useFile !== false; delete cert.useFile; if (files) { delete cert.certificate; delete cert.key; } else { delete cert.certificateFile; delete cert.keyFile; } return cert; });
  return { ...inbound, streamSettings: { ...stream, tlsSettings: { ...tls, certificates } } };
}
export function validateInboundSecurity(inbound: Inbound) {
  const stream = parseObject(inbound.streamSettings), reality = parseObject(stream.realitySettings), tls = parseObject(stream.tlsSettings);
  if (stream.security === 'reality') {
    if ((parseObject(reality.settings).fingerprint || reality.fingerprint) === 'android') throw new Error('Android OkHttp does not support the TLS 1.3 required by REALITY. Choose another uTLS fingerprint.');
    if (inbound.protocol !== 'vless' || !['tcp', 'raw', 'grpc', 'xhttp'].includes(String(stream.network))) throw new Error('Use REALITY with VLESS and a supported TCP, gRPC or XHTTP transport.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(String(reality.privateKey || ''))) throw new Error('Generate a valid REALITY key pair.');
    if (!Array.isArray(reality.serverNames) || !reality.serverNames.length || !(reality.target || reality.dest)) throw new Error('Set the REALITY destination and its server name.');
    if (!Array.isArray(reality.shortIds) || !reality.shortIds.length || reality.shortIds.some(s => typeof s !== 'string' || !/^(?:[a-fA-F0-9]{2}){0,8}$/.test(s))) throw new Error('REALITY short IDs must be even-length hexadecimal, up to 16 characters.');
  }
  if (stream.security === 'tls') {
    const certs = tls.certificates;
    if (!Array.isArray(certs) || !certs.length || !certs.some(c => parseObject(c).usage !== 'verify') || certs.some(c => { const cert = parseObject(c), files = cert.useFile === undefined ? Boolean(cert.certificateFile || cert.keyFile) : cert.useFile !== false; return files ? !cert.certificateFile || cert.usage !== 'verify' && !cert.keyFile : !Array.isArray(cert.certificate) || !cert.certificate.join('\n').includes('BEGIN CERTIFICATE') || cert.usage !== 'verify' && (!Array.isArray(cert.key) || !cert.key.join('\n').includes('PRIVATE KEY')); })) throw new Error('TLS needs both a certificate and private key. Reuse the panel certificate or supply the server file paths in Security.');
  }
  if (inbound.protocol === 'trojan' && !['tls', 'reality'].includes(String(stream.security))) throw new Error('Trojan requires TLS. Choose a certificate before creating it.');
}
