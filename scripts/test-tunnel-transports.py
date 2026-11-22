"""Verify all five supported adapters between isolated Linux peers on a disposable systemd runner."""
import contextlib
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time
import uuid
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agent'))
import benx_agent as agent
import tunnel_tools
import tunnel_probe


def ip(*args):
    subprocess.run(['ip', *args], check=True)


@contextlib.contextmanager
def peer(directory, namespace):
    original = agent.unit_text
    def unit(command, stop=None):
        return original(command, stop).replace('[Service]\n', f'[Service]\nNetworkNamespacePath=/run/netns/{namespace}\n')
    with open('/proc/self/ns/net', 'rb') as host, open('/run/netns/' + namespace, 'rb') as isolated:
        os.setns(isolated.fileno(), 0)
        try:
            with patch.object(agent, 'ROOT', directory), patch.object(agent, 'unit_text', unit):
                yield
        finally:
            os.setns(host.fileno(), 0)


def check(method, peers):
    ids = [str(uuid.uuid4()), str(uuid.uuid4())]
    token = secrets.token_hex(32)
    public = []
    with contextlib.ExitStack() as cleanup:
        def remove(i):
            with peer(*peers[i]):
                assert agent.tunnels.remove(agent, ids[i])['removed']
                assert agent.tunnels.status(agent, ids[i])['state'] == 'absent'
        for i, (directory, namespace) in enumerate(peers):
            role = 'source' if i == 0 else 'target'
            data = {'method': method, 'role': role, 'peerHost': f'10.244.127.{2 - i}', 'port': 45380,
                    'peerPort': 45380, 'listenPort': 45381, 'destinationPort': 45382, 'listenHost': '127.0.0.1',
                    'destinationHost': '127.0.0.1', 'address': f'10.234.42.{1 + i}/30', 'peerAddress': f'10.234.42.{2 - i}/30'}
            cleanup.callback(remove, i)
            with peer(directory, namespace):
                public.append(agent.tunnels.prepare(agent, ids[i], data))
                assert not public[i].get('pending'), 'Tunnel tools must be ready before the test'
        for i in [1, 0]:
            with peer(*peers[i]):
                assert agent.tunnels.commit(agent, ids[i], public[1-i])['state'] == 'running'
        receiver = 1 if method in ['wireguard', 'ssh-direct'] else 0
        with peer(*peers[receiver]):
            assert tunnel_probe.start(agent, ids[receiver], {'token': token})['ready']
        with peer(*peers[1-receiver]):
            for _ in range(12):
                result = tunnel_probe.measure(agent, ids[1-receiver], {'token': token, 'byteLimit': 262144})
                if result['state'] == 'passed':
                    break
                time.sleep(1)
            assert result['state'] == 'passed' and result['bytes'] == 524288, (method, result)
            assert result['uploadMbps'] > 0 and result['downloadMbps'] > 0
            if method == 'wireguard':
                assert agent.tunnels.status(agent, ids[1-receiver])['connected']
    print(f'{method}: 256 KiB acknowledged in each direction; both adapters removed.', flush=True)


def run():
    if sys.platform != 'linux' or os.geteuid() != 0 or not Path('/run/systemd/system').is_dir():
        sys.exit('Run on a disposable Linux systemd runner as root with Python 3.12+, iproute2, OpenSSH and wireguard-tools.')
    with tempfile.TemporaryDirectory(prefix='benx-ci-') as tmp, contextlib.ExitStack() as cleanup:
        root = Path(tmp)
        with patch.object(agent, 'ROOT', root):
            tunnel_tools.install(agent, 'frp-tls')
        suffix = uuid.uuid4().hex[:6]
        peers = []
        for side in ['a', 'b']:
            ns = 'benx-' + side + suffix
            ip('netns', 'add', ns)
            cleanup.callback(ip, 'netns', 'del', ns)
            directory = root / side
            directory.mkdir()
            (directory / 'tunnel-tools').symlink_to(root / 'tunnel-tools', target_is_directory=True)
            peers.append((directory, ns))
        left, right = 'va' + suffix, 'vb' + suffix
        ip('-n', peers[0][1], 'link', 'add', left, 'type', 'veth', 'peer', 'name', right, 'netns', peers[1][1])
        for i, ((_, ns), dev) in enumerate(zip(peers, [left, right])):
            ip('-n', ns, 'link', 'set', 'lo', 'up')
            ip('-n', ns, 'address', 'add', f'10.244.127.{i + 1}/30', 'dev', dev)
            ip('-n', ns, 'link', 'set', dev, 'up')
        for method in ['wireguard', 'ssh-direct', 'ssh-reverse', 'frp-tls', 'frp-wss']:
            check(method, peers)


if __name__ == '__main__':
    run()
