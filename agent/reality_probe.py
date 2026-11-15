"""Bounded, certificate-verified REALITY target checks from the actual VPS."""
from concurrent.futures import ThreadPoolExecutor
import ipaddress
import re
import socket
import ssl
import time


def scan(body):
    target = str(body.get('target', ''))
    result = {'target':target, 'feasible':False, 'serverNames':[]}
    try:
        if not re.fullmatch(r'[a-zA-Z0-9.-]{1,253}(?::[0-9]{1,5})?', target):
            raise ValueError('Use a public domain or IPv4 address, optionally followed by a port.')
        parts = target.rsplit(':', 1)
        host, port = (parts[0], int(parts[1])) if len(parts) == 2 else (target, 443)
        sni = str(body.get('sni') or host)
        if not 1 <= port <= 65535 or not re.fullmatch(r'[a-zA-Z0-9.-]{1,253}', sni):
            raise ValueError('Enter a valid port and server name.')
        if body.get('xver', 0) not in [0, '0']:
            raise ValueError('This native target probe supports PROXY protocol disabled (Xver 0).')
        resolved = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        if not resolved or any(not ipaddress.ip_address(row[4][0]).is_global for row in resolved):
            result['privateTarget'] = True
            raise ValueError('Private, loopback and reserved targets are unavailable in this native probe.')
        context = ssl.create_default_context()
        context.minimum_version = context.maximum_version = ssl.TLSVersion.TLSv1_3
        context.set_alpn_protocols(['h2'])
        context.set_ecdh_curve('X25519')
        start = time.monotonic()
        # Connect to the already checked address, avoiding a second DNS lookup.
        # Fresh IPv4 VPSs can resolve AAAA records without having an IPv6 route.
        family, kind, protocol, _, address = sorted(resolved, key=lambda row: row[0] != socket.AF_INET)[0]
        with socket.socket(family, kind, protocol) as raw:
            raw.settimeout(5)
            raw.connect(address)
            with context.wrap_socket(raw, server_hostname=sni) as connection:
                names = [name for kind, name in connection.getpeercert().get('subjectAltName', []) if kind == 'DNS' and '*' not in name]
                h2 = connection.selected_alpn_protocol() == 'h2'
                result.update(tls13=True, h2=h2, x25519=True, trustedCertificate=True, latencyMs=round((time.monotonic()-start)*1000), serverNames=[sni, *[n for n in names if n != sni]][:32], feasible=h2)
                if not h2:
                    result['reason'] = 'The target did not negotiate HTTP/2.'
    except ValueError as error:
        result['reason'] = str(error)
    except ssl.SSLCertVerificationError:
        result['reason'] = 'The target certificate is untrusted or does not match the server name.'
    except (OSError, ssl.SSLError):
        result['reason'] = 'The VPS could not complete a verified TLS 1.3 handshake with this target.'
    return result


def discover(body):
    candidates = str(body.get('targets') or 'www.cloudflare.com,www.microsoft.com,www.apple.com').split(',')
    if len(candidates) > 16:
        raise ValueError('Probe at most 16 public targets at a time.')
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(lambda target: scan({'target':target.strip()}), candidates))
    return sorted(results, key=lambda result: (not result['feasible'], result.get('latencyMs', 999999)))
