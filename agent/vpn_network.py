"""Per-listener Internet forwarding. Never flush rules or change INPUT policy."""
import argparse
import ipaddress
import json
import re
import subprocess
from pathlib import Path


def rules(number, subnet, device):
    network = ipaddress.IPv4Network(subnet, strict=True)
    private = any(network.subnet_of(ipaddress.IPv4Network(pool)) for pool in ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'])
    if not private or network.prefixlen < 16 or not 1 <= number <= 999999999 or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,15}', device):
        raise ValueError('Invalid private VPN network or egress interface.')
    comment = ['-m', 'comment', '--comment', f'benx-vpn-{number}']
    return [
        ('filter', 'FORWARD', ['-s', str(network), '-o', device, *comment, '-j', 'ACCEPT']),
        ('filter', 'FORWARD', ['-d', str(network), '-i', device, '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', *comment, '-j', 'ACCEPT']),
        ('nat', 'POSTROUTING', ['-s', str(network), '-o', device, *comment, '-j', 'MASQUERADE']),
    ]


def healthy(number, subnet, root=Path('/var/lib/benx-agent'), execute=subprocess.run):
    try:
        saved = json.loads((root / 'vpn-network' / f'{number}.json').read_text())
        if saved['subnet'] != subnet:
            return False
        forwarding = execute(['sysctl', '-n', 'net.ipv4.ip_forward'], capture_output=True, text=True, check=True).stdout.strip()
        route = execute(['ip', '-j', 'route', 'get', '1.1.1.1'], capture_output=True, text=True, check=True)
        if forwarding != '1' or json.loads(route.stdout)[0]['dev'] != saved['device']:
            return False
        return all(execute(['iptables', '-w', '5', '-t', table, '-C', chain, *args], capture_output=True).returncode == 0 for table, chain, args in rules(number, subnet, saved['device']))
    except (OSError, ValueError, KeyError, IndexError, subprocess.SubprocessError):
        return False


def change(action, number, subnet, root=Path('/var/lib/benx-agent'), execute=subprocess.run):
    marker = root / 'vpn-network' / f'{number}.json'
    if action == 'down':
        if not marker.is_file():
            return
        saved = json.loads(marker.read_text())
        entries = rules(number, saved['subnet'], saved['device'])
    else:
        route = execute(['ip', '-j', 'route', 'get', '1.1.1.1'], capture_output=True, text=True, check=True)
        device = json.loads(route.stdout)[0]['dev']
        entries = rules(number, subnet, device)
        if marker.is_file():
            change('down', number, subnet, root, execute)
        execute(['sysctl', '-w', 'net.ipv4.ip_forward=1'], capture_output=True, check=True)
    added = []
    try:
        for table, chain, args in entries:
            prefix = ['iptables', '-w', '5', '-t', table]
            exists = execute([*prefix, '-C', chain, *args], capture_output=True).returncode == 0
            if action == 'down':
                if exists:
                    execute([*prefix, '-D', chain, *args], capture_output=True, check=True)
            elif not exists:
                execute([*prefix, '-I', chain, '1', *args], capture_output=True, check=True)
                added.append((prefix, chain, args))
        if action == 'up':
            marker.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            marker.write_text(json.dumps({'subnet': subnet, 'device': device}))
            marker.chmod(0o600)
        else:
            marker.unlink(missing_ok=True)
    except Exception:
        for prefix, chain, args in reversed(added):
            execute([*prefix, '-D', chain, *args], capture_output=True)
        raise


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['up', 'down'])
    parser.add_argument('--id', type=int, required=True)
    parser.add_argument('--subnet', required=True)
    args = parser.parse_args()
    change(args.action, args.id, args.subnet)
