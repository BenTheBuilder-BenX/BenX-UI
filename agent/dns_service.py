"""Managed caching/encrypted DNS; private configuration and scoped access rules."""
import hashlib
import io
import ipaddress
import json
import platform
from pathlib import Path
import subprocess
import sys
import shlex
import tarfile
from urllib.request import Request, urlopen


def endpoints(row):
    if row.get('protocol') != 'dns-resolver':
        return [(row['port'], 'udp' if row.get('protocol') == 'masterdnsvpn' else 'any')]
    s = row.get('settings', {})
    return [(row['port'], 'any')] + [(s.get(k, 0), p) for k, p in [('httpsPort', 'tcp'), ('tlsPort', 'tcp'), ('quicPort', 'udp')] if s.get(k, 0)]


def validate(agent, row, state):
    s = row['settings']
    for key in ['httpsPort', 'tlsPort', 'quicPort']:
        if type(s.get(key, 0)) is not int or not 0 <= s.get(key, 0) <= 65535:
            raise agent.AgentError('DNS endpoint ports must be 0 (off) or between 1 and 65535.')
    cidrs = s.get('allowedClients', [])
    if not isinstance(cidrs, list) or not 1 <= len(cidrs) <= 100:
        raise agent.AgentError('Set at least one allowed IPv4 client or subnet for DNS access.')
    try:
        s['allowedClients'] = [str(ipaddress.IPv4Network(c, strict=False)) for c in cidrs]
    except (ValueError, TypeError):
        raise agent.AgentError('DNS access entries must be IPv4 addresses or CIDRs.') from None
    upstreams = s.get('upstreams', [])
    if not isinstance(upstreams, list) or not 1 <= len(upstreams) <= 10 or any(not isinstance(u, str) or len(u) > 500 or any(c.isspace() for c in u) or u.startswith('-') for u in upstreams):
        raise agent.AgentError('Set 1–10 DNS upstream addresses without spaces.')
    for key, low, high, default in [('rateLimit', 1, 1000, 20), ('cacheSize', 1024, 16777216, 1048576)]:
        v = s.get(key, default)
        if type(v) is not int or not low <= v <= high:
            raise agent.AgentError('Invalid DNS cache size or request rate limit.')
        s[key] = v
    if type(s.get('cache', True)) is not bool:
        raise agent.AgentError('DNS caching must be enabled or disabled.')
    if any(s.get(k) for k in ['httpsPort', 'tlsPort', 'quicPort']):
        for k in ['certificateFile', 'keyFile']:
            v = s.get(k, '')
            if not isinstance(v, str) or not v.startswith('/') or any(c in v for c in ['\n', '\r', '\x00']):
                raise agent.AgentError('Encrypted DNS needs absolute certificate and private-key paths.')
    if row.get('listen') in ['', '0.0.0.0'] and row['port'] == 53:
        raise agent.AgentError('Bind DNS port 53 to the VPS public IPv4 address to preserve the operating-system resolver.')
    if row.get('enable', True):
        for other in state['inbounds']:
            if other['id'] == row['id'] or not other.get('enable', True):
                continue
            for port, proto in endpoints(row):
                for op, opr in endpoints(other):
                    if port == op and (proto == opr or 'any' in [proto, opr]):
                        raise agent.AgentError('DNS listener conflicts with another inbound. Keep MasterDNSVPN on UDP 53 and choose another DNS port, such as 5353.', 409)
        own = endpoints(row)
        if any(p == q and (a == b or 'any' in [a, b]) for n, (p, a) in enumerate(own) for q, b in own[n + 1:]):
            raise agent.AgentError('DNS endpoints overlap. DoT and DoQ may share a port because their transports differ.')


def install(agent):
    arch = {'amd64': 'x86_64', 'arm64': 'aarch64'}.get(platform.machine().lower(), platform.machine().lower())
    asset = json.loads((Path(__file__).parent / 'dnsproxy-release.json').read_text())['assets'].get(arch)
    if not asset or not asset['url'].startswith('https://github.com/AdguardTeam/dnsproxy/releases/download/'):
        raise agent.AgentError('No verified DNS engine build for this architecture.', 409)
    with urlopen(Request(asset['url'], headers={'User-Agent': 'BenX-Agent'}), timeout=120) as response:
        data = response.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise agent.AgentError('DNS engine release checksum verification failed.', 502)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        members = [m for m in archive.getmembers() if m.isfile() and Path(m.name).name == 'dnsproxy']
        if len(members) != 1 or members[0].size > 100 * 1024 * 1024:
            raise agent.AgentError('Unexpected DNS release contents.')
        destination = Path('/usr/local/bin/benx-dnsproxy')
        temporary = destination.with_suffix('.new')
        temporary.write_bytes(archive.extractfile(members[0]).read())
        temporary.chmod(0o755)
        temporary.replace(destination)
    agent.run([str(destination), '--version'])


def compile(agent, row, state, directory):
    validate(agent, row, state)
    s = row['settings']
    config = directory / 'dns-access.json'
    acl = {'id': row['id'], 'listen': row.get('listen') or '0.0.0.0', 'endpoints': endpoints(row), 'allowed': s['allowedClients'], 'certificateFiles': {k: s[k] for k in ['certificateFile', 'keyFile'] if s.get(k)}}
    agent.write_private(config, json.dumps(acl))
    args = [agent.binary('dnsproxy'), '-l', acl['listen'], '-p', str(row['port']), '--refuse-any', '--ratelimit', str(s['rateLimit'])]
    for upstream in s['upstreams']:
        args += ['-u', upstream]
    if s.get('cache', True):
        args += ['--cache', '--cache-size', str(s['cacheSize'])]
    for field, flag in [('httpsPort', '--https-port'), ('tlsPort', '--tls-port'), ('quicPort', '--quic-port')]:
        if s.get(field):
            args += [flag, str(s[field])]
    if any(s.get(k) for k in ['httpsPort', 'tlsPort', 'quicPort']):
        pki = directory / 'pki'
        pki.mkdir(exist_ok=True, mode=0o700)
        paths = []
        for field, name in [('certificateFile', 'dns-cert.pem'), ('keyFile', 'dns-key.pem')]:
            source, snapshot = Path(s[field]), pki / name
            if source.is_file():
                agent.write_private(snapshot, source.read_text())
                paths.append(str(source))  # Renewals continue using the remembered live path.
            elif snapshot.is_file():
                paths.append(str(snapshot))
            else:
                raise agent.AgentError('DNS certificate not found. Issue a certificate in Server setup first.')
        agent.run(['openssl', 'x509', '-in', paths[0], '-noout', '-checkend', '0'])
        cert_key = agent.run(['openssl', 'x509', '-in', paths[0], '-noout', '-pubkey'])
        private_key = agent.run(['openssl', 'pkey', '-in', paths[1], '-pubout'])
        if cert_key.strip() != private_key.strip():
            raise agent.AgentError('DNS certificate and private key do not match.')
        if (agent.ROOT / 'renew-benx-cert').is_file():
            agent.server_setup.certificates.renewal_hook(agent)
        args += ['--tls-crt', paths[0], '--tls-key', paths[1]]
    text = agent.unit_text(args)
    script = Path(__file__).resolve()
    hooks = f'ExecStartPre=/usr/bin/python3 "{script}" up "{config}"\nExecStopPost=/usr/bin/python3 "{script}" down "{config}"\n'
    return text.replace('[Service]\n', '[Service]\n' + hooks)


def firewall(action, config):
    number = config['id']
    if type(number) is not int or not 1 <= number <= 999999999:
        raise ValueError('Invalid owned DNS listener')
    chain = f'BXD{number}'
    def call(*args, check=True):
        return subprocess.run(['iptables', '-w', '10', *args], check=check, capture_output=True, text=True)
    # Remove exact jumps to this owned chain, including an old port after edits.
    for line in call('-S', 'INPUT').stdout.splitlines():
        tokens = shlex.split(line)
        if len(tokens) >= 4 and tokens[:2] == ['-A', 'INPUT'] and tokens[-2:] == ['-j', chain]:
            call('-D', *tokens[1:])
    call('-F', chain, check=False)
    call('-X', chain, check=False)
    if action == 'up':
        call('-N', chain)
        for cidr in ['127.0.0.0/8', *config['allowed']]:
            call('-A', chain, '-s', str(ipaddress.IPv4Network(cidr, strict=False)), '-j', 'ACCEPT')
        call('-A', chain, '-j', 'DROP')
        for port, proto in config['endpoints']:
            for transport in ['tcp', 'udp'] if proto == 'any' else [proto]:
                call('-I', 'INPUT', '1', '-d', '0.0.0.0/0' if config['listen'] == '0.0.0.0' else config['listen'], '-p', transport, '--dport', str(port), '-j', chain)


def healthy(row):
    chain = f"BXD{row['id']}"
    def output(*args):
        r = subprocess.run(['iptables', '-w', '10', *args], capture_output=True, text=True)
        return r.returncode, r.stdout
    code, text = output('-S', chain)
    allowed = ['127.0.0.0/8', *row['settings']['allowedClients']]
    expected = [f'-N {chain}'] + [f'-A {chain} -s {str(ipaddress.IPv4Network(c, strict=False))} -j ACCEPT' for c in allowed] + [f'-A {chain} -j DROP']
    def normalized(line):
        tokens = shlex.split(line)
        if '-s' in tokens:
            source = tokens.index('-s')
            network = ipaddress.IPv4Network(tokens[source + 1], strict=False)
            if network.prefixlen == 0:
                del tokens[source:source + 2]  # iptables omits its default any-source matcher.
            else:
                tokens[source + 1] = str(network)
        return tokens
    if code or [normalized(line) for line in text.strip().splitlines()] != [normalized(line) for line in expected]:
        return False
    listen = row.get('listen') or '0.0.0.0/0'
    for port, proto in endpoints(row):
        for transport in ['tcp', 'udp'] if proto == 'any' else [proto]:
            if output('-C', 'INPUT', '-d', '0.0.0.0/0' if listen == '0.0.0.0' else listen, '-p', transport, '--dport', str(port), '-j', chain)[0]:
                return False
    return True


if __name__ == '__main__':
    if len(sys.argv) != 3 or sys.argv[1] not in ['up', 'down', 'refresh']:
        raise SystemExit('Expected up/down and an owned access configuration path')
    config = json.loads(Path(sys.argv[2]).read_text())
    if sys.argv[1] == 'refresh':
        for field, name in [('certificateFile', 'dns-cert.pem'), ('keyFile', 'dns-key.pem')]:
            source = Path(config.get('certificateFiles', {}).get(field, '/nonexistent'))
            if source.is_file():
                target = Path(sys.argv[2]).parent / 'pki' / name
                target.write_bytes(source.read_bytes())
                target.chmod(0o600)
    else:
        firewall(sys.argv[1], config)
