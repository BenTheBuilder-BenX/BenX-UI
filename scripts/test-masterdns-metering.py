"""Exercise the native DNS profiles and quota enforcement over real loopback sockets."""
import argparse
import contextlib
import functools
import hashlib
import http.server
import io
import json
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import uuid
import zipfile
from unittest.mock import patch
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import benx_agent as agent


def port(kind=socket.SOCK_STREAM):
    with socket.socket(socket.AF_INET, kind) as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def write(path, value):
    path.write_text(json.dumps(value), encoding='utf-8')
    return str(path)


class QuietHTTP(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def exercise(root, binaries, stack):
    names = ('buyer-a', 'buyer-b')
    clients = {name: {'email': name, 'id': str(uuid.uuid4()), 'enable': True, 'expiryTime': 0,
                      'totalGB': 65536 if i == 0 else 0, 'inboundIds': [1, 2]} for i, name in enumerate(names)}
    backend = {'id': 2, 'protocol': 'vless', 'port': port(), 'listen': '127.0.0.1', 'enable': True, 'excludeFromSub': True,
               'remark': 'Private backend', 'settings': {'decryption': 'none'}, 'streamSettings': {'network': 'tcp', 'security': 'none'}}
    dns_port = port(socket.SOCK_DGRAM)
    dns = {'id': 1, 'protocol': 'masterdnsvpn', 'port': dns_port, 'listen': '127.0.0.1', 'enable': True, 'remark': 'DNS',
           'settings': {'DOMAIN': ['t.example.test'], 'DATA_ENCRYPTION_METHOD': 5, 'meteredInboundId': 2, 'clientResolvers': [f'127.0.0.1:{dns_port}']}}
    state = {'clients': clients, 'inbounds': [dns, backend], 'nextId': 3}
    stack.enter_context(patch.object(agent, 'ROOT', root))
    stack.enter_context(patch.object(agent, 'binary', side_effect=lambda core: binaries[core]))
    invocation = ['1']
    run = agent.run

    def local_run(args, **kwargs):
        if args[0] == 'systemctl':
            return invocation[0] if args[1] == 'show' else 'active'
        return run(args, **kwargs)

    stack.enter_context(patch.object(agent, 'run', side_effect=local_run))
    for inbound in state['inbounds']:
        agent.compile_inbound(inbound, state)
    write(root / 'policy.json', {'inboundMultipliers': {'1': 2}})
    write(root / 'state.json', state)
    handles = {}
    def stop(label):
        proc = handles.pop(label, None)
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(4)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    def launch(label, *args):
        stop(label)
        handles[label] = subprocess.Popen(args, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        stack.callback(stop, label)

    xray, listener_dir = binaries['xray'], root / 'listeners'
    def apply(next_state, previous, changed):
        if 2 in changed:
            agent.compile_inbound(backend, next_state)
            invocation[0] = str(int(invocation[0]) + 1)
            launch('backend', xray, 'run', '-config', str(listener_dir / '2/xray.json'))
        write(root / 'state.json', next_state)
    stack.enter_context(patch.object(agent, 'apply_state', side_effect=apply))
    launch('backend', xray, 'run', '-config', str(listener_dir / '2/xray.json'))
    launch('dns', binaries['masterdnsvpn'], '-json', str(listener_dir / '1/masterdnsvpn.json'), '-nowait')
    # Only a generated test payload is visible to the local HTTP endpoint.
    www = root / 'www'
    www.mkdir()
    sample = secrets.token_bytes(96 * 1024)
    (www / 'sample').write_bytes(sample)
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHTTP, directory=str(www)))
    stack.callback(httpd.server_close)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    stack.callback(httpd.shutdown)
    proxies = {}
    for name in names:
        profiles = agent.client_profiles(state, name)
        config = json.loads(next(s for s in profiles if s.startswith('{') and 'ENCRYPTION_KEY' in s))
        inner = urlsplit(next(s for s in profiles if s.startswith('vless:') and s.endswith('#MasterDNSVPN-metered')))
        assert config['PROTOCOL_TYPE'] == 'TCP' and inner.username == clients[name]['id'] and inner.port == config['LISTEN_PORT']
        # Give the two simulated devices separate loopback ports on this one host.
        config['LISTEN_PORT'] = port()
        resolvers = root / f'{name}-resolvers.txt'
        resolvers.write_text(next(s for s in profiles if s.startswith('# MasterDnsVPN client_resolvers.txt')).split('\n', 1)[1])
        launch(name + '-dns', binaries['client'], '-json', write(root / f'{name}-dns.json', config), '-resolvers', str(resolvers))
        proxies[name] = port()
        xclient = {'inbounds': [{'listen': '127.0.0.1', 'port': proxies[name], 'protocol': 'socks', 'settings': {'auth': 'noauth'}}],
                   'outbounds': [{'protocol': 'vless', 'settings': {'vnext': [{'address': inner.hostname, 'port': config['LISTEN_PORT'], 'users': [{'id': inner.username, 'encryption': 'none'}]}]}}]}
        launch(name + '-proxy', xray, 'run', '-config', write(root / f'{name}-proxy.json', xclient))
    def transfer(name):
        cmd = ['curl', '--silent', '--fail', '--max-time', '12', '--noproxy', '', '--socks5', f'127.0.0.1:{proxies[name]}', f'http://127.0.0.1:{httpd.server_port}/sample']
        result = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=15)
        return result.returncode == 0 and result.stdout == sample
    def confirm_transfer(name):
        for attempt in range(6):
            if transfer(name):
                return
            if attempt == 5:
                raise RuntimeError(f'DNS transfer failed for {name}; process status: {[(k, v.poll()) for k, v in handles.items()]}')
            time.sleep(1)
    for name in names:
        confirm_transfer(name)
    agent.accounting.reconcile(agent)
    snapshot = agent.accounting.read(agent, 'accounting.json', {})
    for name in names:
        counters = snapshot['usage'][name]
        assert counters['rawDown'] >= len(sample) and counters['down'] == 2 * counters['rawDown']
    assert agent.load_state()['clients'][names[0]]['_quotaBlocked']
    assert not agent.load_state()['clients'][names[1]].get('_quotaBlocked')
    # The native apply restarts Xray. Wait for the surviving client's first usable connection.
    confirm_transfer(names[1])
    assert not transfer(names[0]), 'An exhausted identity could still make a new connection'
    print('Two DNS clients transferred 96 KiB each. Separate Xray counters, a 2x rate, quota cut-off and continuing access for the second client passed.')


def linux_binaries(directory):
    manifests = Path(agent.__file__).parent
    xray = json.loads((manifests / 'xray-release.json').read_text())['assets']['x86_64']
    server = json.loads((manifests / 'masterdnsvpn-release.json').read_text())['assets']['AMD64']
    client = {'url': server['url'].replace('_Server_', '_Client_'),
              'sha256': 'f28d760402fd3b1a7bb9b7f74168ddb11c41467e44b987d4f4c89016cb7fcdac'}
    binaries = {}
    for name, release in [('xray', xray), ('masterdnsvpn', server), ('client', client)]:
        with urlopen(Request(release['url'], headers={'User-Agent': 'BenX-integration-check'}), timeout=90) as response:
            data = response.read(90 * 1024 * 1024 + 1)
        if hashlib.sha256(data).hexdigest() != release['sha256']:
            raise RuntimeError(f'{name} checksum mismatch')
        if name == 'xray':
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                executable = archive.read('xray')
        else:
            kind = 'Client' if name == 'client' else 'Server'
            with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
                member, = [m for m in archive if m.isfile() and re.fullmatch('MasterDnsVPN_' + kind + r'_Linux_AMD64_v[\w.-]+', Path(m.name).name)]
                executable = archive.extractfile(member).read()
        path = directory / name
        path.write_bytes(executable)
        path.chmod(0o700)
        binaries[name] = str(path)
    return binaries


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    for flag in ['xray', 'dns-server', 'dns-client']:
        parser.add_argument('--' + flag, type=Path)
    parser.add_argument('--fetch-linux', action='store_true', help='Fetch checksum-pinned Linux x86-64 test binaries.')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory() as tmp, contextlib.ExitStack() as resources:
        root = Path(tmp)
        if args.fetch_linux:
            bins = linux_binaries(root)
        elif all((args.xray, args.dns_server, args.dns_client)):
            bins = {'xray': str(args.xray.resolve(strict=True)), 'masterdnsvpn': str(args.dns_server.resolve(strict=True)), 'client': str(args.dns_client.resolve(strict=True))}
        else:
            parser.error('Specify all three binary paths or --fetch-linux.')
        exercise(root, bins, resources)
