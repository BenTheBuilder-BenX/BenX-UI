"""Two-phase tunnel setup. Only isolated BenX units and generated accounts."""
import hashlib
import ipaddress
import json
import re
import shutil
import time
import tunnel_adapters
import tunnel_tools
import tunnel_probe


def names(agent, tunnel_id):
    if not re.fullmatch(r'[a-f0-9-]{36}', tunnel_id):
        raise agent.AgentError('Invalid tunnel ID.')
    suffix = hashlib.sha256(tunnel_id.encode()).hexdigest()[:10]
    return agent.ROOT / 'tunnels' / tunnel_id, 'benx-tunnel-' + suffix + '.service', 'bt' + suffix, 'bxt_' + suffix


def validate(agent, data):
    if data.get('method') not in ['wireguard', 'ssh-direct', 'ssh-reverse', *tunnel_adapters.METHODS] or data.get('role') not in ['source', 'target']:
        raise agent.AgentError('Invalid tunnel method or role.')
    for key in ['port', 'peerPort', 'listenPort', 'destinationPort']:
        if type(data.get(key)) is not int or not 1 <= data[key] <= 65535:
            raise agent.AgentError('Tunnel ports must be between 1 and 65535.')
    for key in ['peerHost', 'destinationHost']:
        agent.host(data.get(key, ''))
    for key in ['address', 'peerAddress']:
        try:
            value = ipaddress.ip_interface(data[key])
            if value.version != 4 or not value.ip.is_private or value.network.prefixlen != 30:
                raise ValueError()
        except (ValueError, KeyError):
            raise agent.AgentError('Use a private IPv4 /30 tunnel subnet.') from None
    if data.get('listenHost') not in ['127.0.0.1', '::1']:
        raise agent.AgentError('Forwarding listeners must bind to loopback.')
    if type(data.get('mtu', 1400)) is not int or not 1280 <= data.get('mtu', 1400) <= 1500:
        raise agent.AgentError('MTU must be between 1280 and 1500.')
    if data.get('mimic', 'ssh') not in ['ssh', 'tls'] or data.get('domain') and not re.fullmatch(r'(?:[a-z0-9-]+\.)+[a-z]{2,63}', data['domain']):
        raise agent.AgentError('Invalid TLS mimic settings.')
    return data


def prepare(agent, tunnel_id, body):
    body = validate(agent, body)
    directory, unit, interface, user = names(agent, tunnel_id)
    if not tunnel_tools.ensure(agent, body['method']):
        return {'pending': True, 'message': 'Installing the pinned tunnel engine. Setup retries automatically.'}
    if directory.exists():
        saved = json.loads((directory / 'setup.json').read_text())
        if saved != body:
            raise agent.AgentError('Tunnel ID is already prepared with different settings.', 409)
        return json.loads((directory / 'public.json').read_text())
    if body['method'] == 'wireguard' and (not agent.binary('wireguard') or not shutil.which('wg-quick')):
        raise agent.AgentError('Install WireGuard tools on both servers.', 409)
    if body['method'].startswith('ssh') and (not agent.binary('openssh') or not shutil.which('ssh') or not shutil.which('ssh-keygen')):
        raise agent.AgentError('Install OpenSSH on both servers.', 409)
    # Reserve directory before any managed OS resources. Never overwrite existing accounts.
    directory.mkdir(mode=0o700, parents=True, exist_ok=False)
    agent.write_private(directory / 'setup.json', json.dumps(body))
    public = {}
    if body['method'] == 'wireguard':
        private = agent.run([agent.binary('wireguard'), 'genkey'])
        agent.write_private(directory / 'private.key', private + '\n')
        public['publicKey'] = agent.run([agent.binary('wireguard'), 'pubkey'], input_text=private + '\n')
    elif body['method'] in tunnel_adapters.METHODS:
        public = tunnel_adapters.prepare(agent, directory, body)
    else:
        key = directory / ('client_key' if body['role'] == 'source' else 'host_key')
        agent.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(key)])
        key.chmod(0o600)
        public['publicKey'] = key.with_suffix('.pub').read_text().strip()
        if body['role'] == 'target':
            if agent.run(['getent', 'passwd', user], check=False):
                raise agent.AgentError('Generated tunnel account already exists; choose a new tunnel ID.', 409)
            agent.run(['useradd', '--system', '--no-create-home', '--shell', '/bin/false', '--password', 'x', user])
            agent.write_private(directory / 'account-created', user)
            public['user'] = user
    agent.write_private(directory / 'public.json', json.dumps(public))
    return public


def commit(agent, tunnel_id, body):
    directory, unit, interface, user = names(agent, tunnel_id)
    if not (directory / 'public.json').exists():
        raise agent.AgentError('Prepare this tunnel first.', 409)
    data = json.loads((directory / 'setup.json').read_text())
    if (directory / 'committed.json').exists():
        if json.loads((directory / 'committed.json').read_text()) != body:
            raise agent.AgentError('Tunnel is already committed.', 409)
        return status(agent, tunnel_id)
    peer_key = body.get('publicKey', '')
    if data['method'] == 'wireguard':
        agent.peer_key(peer_key)
        config = directory / (interface + '.conf')
        peer = ipaddress.ip_interface(data['peerAddress']).ip
        host = data['peerHost']
        endpoint = f'[{host}]:{data["peerPort"]}' if ':' in host else f'{host}:{data["peerPort"]}'
        agent.write_private(config, f'[Interface]\nPrivateKey = {(directory / "private.key").read_text().strip()}\nAddress = {data["address"]}\nListenPort = {data["port"]}\n\n[Peer]\nPublicKey = {peer_key}\nAllowedIPs = {peer}/32\nEndpoint = {endpoint}\nPersistentKeepalive = 25\n')
        text = agent.unit_text(['wg-quick', 'up', str(config)], ['wg-quick', 'down', str(config)]).replace('Type=simple', 'Type=oneshot\nRemainAfterExit=yes')
    elif data['method'] in tunnel_adapters.METHODS:
        text = tunnel_adapters.commit(agent, directory, data, body, interface)
    else:
        if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/=]{40,100}(?: [^\r\n]{0,200})?', peer_key):
            raise agent.AgentError('Invalid SSH peer public key.')
        if data['role'] == 'target':
            agent.write_private(directory / 'authorized_keys', 'restrict,port-forwarding ' + peer_key + '\n')
            agent.SSH_RUNTIME_DIR.mkdir(mode=0o755, parents=True, exist_ok=True)
            config = directory / 'sshd.conf'
            allow = 'local' if data['method'] == 'ssh-direct' else 'remote'
            destination = f'{data["destinationHost"]}:{data["destinationPort"]}'
            agent.write_private(config, f'Port {data["port"]}\nListenAddress 0.0.0.0\nHostKey {directory / "host_key"}\nPidFile {directory / "sshd.pid"}\nAuthorizedKeysFile none\nAuthorizedKeysCommand /usr/bin/cat {directory / "authorized_keys"}\nAuthorizedKeysCommandUser root\nAllowUsers {user}\nPubkeyAuthentication yes\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nUsePAM no\nStrictModes yes\nAllowTcpForwarding {allow}\nPermitOpen {destination if allow == "local" else "none"}\nPermitListen {data["listenHost"]}:{data["listenPort"]}\nGatewayPorts no\nAllowAgentForwarding no\nX11Forwarding no\nPermitTTY no\nForceCommand /bin/false\n')
            agent.run([agent.binary('openssh'), '-t', '-f', str(config)])
            text = agent.unit_text([agent.binary('openssh'), '-D', '-e', '-f', str(config)])
        else:
            peer_user = body.get('user', '')
            if not re.fullmatch(r'bxt_[a-f0-9]{10}', peer_user):
                raise agent.AgentError('Invalid generated SSH peer account.')
            known = directory / 'known_hosts'
            host = data['peerHost']
            agent.write_private(known, f'[{host}]:{data["peerPort"]} {peer_key}\n')
            endpoint = f'[{data["destinationHost"]}]' if ':' in data['destinationHost'] else data['destinationHost']
            listen = f'[{data["listenHost"]}]' if ':' in data['listenHost'] else data['listenHost']
            forward = f'{listen}:{data["listenPort"]}:{endpoint}:{data["destinationPort"]}'
            command = ['ssh', '-N', '-T', '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f'UserKnownHostsFile={known}', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-o', 'ConnectTimeout=10', '-i', str(directory / 'client_key'), '-p', str(data['peerPort']), '-L' if data['method'] == 'ssh-direct' else '-R', forward, peer_user + '@' + host]
            text = agent.unit_text(command)
    agent.write_private(agent.UNITS_DIR / unit, text)
    agent.run(['systemctl', 'daemon-reload'])
    agent.run(['systemctl', 'enable', '--now', unit])
    time.sleep(0.35)
    if agent.run(['systemctl', 'is-active', unit], check=False) != 'active':
        raise agent.AgentError('Tunnel service failed to start. Check its journal.', 502)
    agent.write_private(directory / 'committed.json', json.dumps(body))
    return status(agent, tunnel_id)


def status(agent, tunnel_id):
    directory, unit, interface, _ = names(agent, tunnel_id)
    if not (directory / 'setup.json').exists():
        return {'state': 'absent', 'connected': False}
    data = json.loads((directory / 'setup.json').read_text())
    active = agent.run(['systemctl', 'is-active', unit], check=False) == 'active'
    result = {'state': 'running' if active else 'stopped', 'connected': None, 'checkedAt': int(time.time() * 1000)}
    if active and data['method'] == 'wireguard':
        output = agent.run([agent.binary('wireguard'), 'show', interface, 'latest-handshakes'], check=False).split()
        last = int(output[-1]) if output and output[-1].isdigit() else 0
        result.update({'connected': last > 0 and time.time() - last < 180, 'lastHandshake': last})
    return result


def remove(agent, tunnel_id):
    tunnel_probe.stop(agent, tunnel_id)
    directory, unit, _, user = names(agent, tunnel_id)
    unit_file = agent.UNITS_DIR / unit
    if unit_file.exists():
        agent.run(['systemctl', 'disable', '--now', unit])
        unit_file.unlink()
        agent.run(['systemctl', 'daemon-reload'])
    if (directory / 'account-created').exists():
        agent.run(['userdel', user])
    if directory.exists():
        shutil.rmtree(directory)
    return {'removed': True}
