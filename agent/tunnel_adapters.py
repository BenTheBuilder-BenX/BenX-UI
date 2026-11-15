"""Isolated GRE/IPIP, FRP, Phormal Relay and Hedioum configuration recipes."""
import ipaddress
import json
import secrets
import socket
from pathlib import Path
import tunnel_tools

METHODS = ['backhaul-tcp','backhaul-tcpmux','backhaul-ws','gre', 'ipip', 'frp-tls', 'frp-wss', 'phormal-relay', 'hedioum']


def endpoint(host, port):
    return f'[{host}]:{port}' if ':' in host else f'{host}:{port}'


def prepare(agent, directory, data):
    method, role = data['method'], data['role']
    public = {}
    if method in ['gre', 'ipip']:
        for field in ['localHost', 'peerHost']:
            try:
                if ipaddress.ip_address(data[field]).version != 4:
                    raise ValueError()
            except (ValueError, KeyError):
                raise agent.AgentError('GRE/IPIP require literal IPv4 addresses on both endpoints.') from None
        if not agent.shutil.which('ip'):
            raise agent.AgentError('Install iproute2 on both endpoints.', 409)
    if method.startswith('frp-') or method == 'phormal-relay':
        if role == 'target':
            key, cert, ca = agent.certificate(directory / 'tls', 'server', public_host='benx-tunnel')
            public['certificate'] = ca.read_text()
            public['token'] = secrets.token_urlsafe(32)
            if method == 'phormal-relay':
                public['obfs'] = secrets.token_urlsafe(32)
    if method.startswith('backhaul-') and role == 'target':
        public['token'] = secrets.token_urlsafe(32)
    if method == 'hedioum' and role == 'target':
        public['token'] = secrets.token_hex(32)
    return public


def commit(agent, directory, data, peer, interface):
    method, role = data['method'], data['role']
    own = json.loads((directory / 'public.json').read_text())
    if method in ['gre', 'ipip']:
        script = directory / 'link.py'
        code = '''import subprocess,sys
def run(args): subprocess.run(args,check=True)
interface=sys.argv[2]
if sys.argv[1]=='down':
 subprocess.run(['ip','tunnel','del',interface],check=False)
else:
 run(['ip','tunnel','add',interface,'mode',sys.argv[3],'local',sys.argv[4],'remote',sys.argv[5],'ttl','64'])
 try:
  run(['ip','address','add',sys.argv[6],'dev',interface])
  run(['ip','link','set','dev',interface,'mtu',sys.argv[7],'up'])
 except Exception:
  subprocess.run(['ip','tunnel','del',interface],check=False);raise
'''
        agent.write_private(script, code)
        return agent.unit_text(['python3', str(script), 'up', interface, method, data['localHost'], data['peerHost'], data['address'], str(data.get('mtu', 1400))], ['python3', str(script), 'down', interface])
    executable = str(tunnel_tools.binary(agent, method, role))
    if method.startswith('backhaul-'):
        transport=method.removeprefix('backhaul-')
        token=own.get('token') if role=='target' else peer.get('token')
        if not isinstance(token,str) or not 32<=len(token)<=128 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-' for c in token):
            raise agent.AgentError('Missing verified Backhaul pairing token.')
        conf={'transport':transport,'token':token,'web_port':0,'sniffer':False,'skip_optz':True,'log_level':'warn','nodelay':True,'keepalive_period':20}
        if role=='target':
            conf.update(bind_addr=endpoint('0.0.0.0',data['port']),ports=[endpoint('127.0.0.1',data['listenPort'])+'='+endpoint(data['destinationHost'],data['destinationPort'])])
        else:
            conf.update(remote_addr=endpoint(data['peerHost'],data['peerPort']),connection_pool=4,retry_interval=3,dial_timeout=10)
        config=directory/'backhaul.toml'
        lines=['['+('server' if role=='target' else 'client')+']']+[k+' = '+json.dumps(v) for k,v in conf.items()]
        agent.write_private(config,'\n'.join(lines)+'\n')
        return agent.unit_text([executable,'-c',str(config)])
    if method.startswith('frp-'):
        server = role == 'target'
        if server:
            token = own['token']
            conf = {'bindPort': data['port'], 'proxyBindAddr': '127.0.0.1', 'auth': {'method': 'token', 'token': token}, 'transport': {'tls': {'force': True, 'certFile': str(directory / 'tls/server.crt'), 'keyFile': str(directory / 'tls/server.key')}}, 'allowPorts': [{'single': data['listenPort']}], 'maxPortsPerClient': 1}
            if method == 'frp-wss':
                with socket.socket() as probe:
                    probe.bind(('127.0.0.1', 0))
                    internal_port = probe.getsockname()[1]
                conf['bindAddr'] = '127.0.0.1'
                conf['bindPort'] = internal_port
                conf['transport']['tls']['force'] = False
        else:
            certificate = peer.get('certificate', '')
            if not certificate.startswith('-----BEGIN CERTIFICATE-----') or len(certificate) > 20000 or not peer.get('token'):
                raise agent.AgentError('Missing verified FRP peer identity.')
            agent.write_private(directory / 'peer.crt', certificate)
            conf = {'serverAddr': data['peerHost'], 'serverPort': data['peerPort'], 'auth': {'method': 'token', 'token': peer['token']}, 'transport': {'protocol': 'wss' if method == 'frp-wss' else 'tcp', 'tls': {'enable': True, 'disableCustomTLSFirstByte': True, 'trustedCaFile': str(directory / 'peer.crt'), 'serverName': 'benx-tunnel'}}, 'proxies': [{'name': interface, 'type': 'tcp', 'localIP': data['destinationHost'], 'localPort': data['destinationPort'], 'remotePort': data['listenPort']}]}
            conf['loginFailExit'] = False
        config = directory / 'frp.json'; agent.write_private(config, json.dumps(conf))
        agent.run([executable, 'verify', '-c', str(config)])
        if server and method == 'frp-wss':
            return agent.unit_text(['python3', str(Path(__file__).parent / 'tunnel_tls_bridge.py'), '--engine', executable, '--config', str(config), '--port', str(data['port']), '--target', str(internal_port), '--cert', str(directory / 'tls/server.crt'), '--key', str(directory / 'tls/server.key')])
        return agent.unit_text([executable, '-c', str(config)])
    if method == 'phormal-relay':
        if role == 'target':
            conf = {'listen': ':' + str(data['port']), 'tls': {'cert': str(directory / 'tls/server.crt'), 'key': str(directory / 'tls/server.key')}, 'auth': {'type': 'password', 'password': own['token']}, 'obfs': {'type': 'salamander', 'salamander': {'password': own['obfs']}}}
        else:
            certificate = peer.get('certificate', '')
            if not certificate.startswith('-----BEGIN CERTIFICATE-----') or len(certificate) > 20000 or not peer.get('token') or not peer.get('obfs'):
                raise agent.AgentError('Missing verified Phormal peer identity.')
            agent.write_private(directory / 'peer.crt', certificate)
            conf = {'server': endpoint(data['peerHost'], data['peerPort']), 'auth': peer['token'], 'tls': {'sni': 'benx-tunnel', 'ca': str(directory / 'peer.crt')}, 'obfs': {'type': 'salamander', 'salamander': {'password': peer['obfs']}}, 'fastOpen': True, 'tcpForwarding': [{'listen': endpoint(data['listenHost'], data['listenPort']), 'remote': endpoint(data['destinationHost'], data['destinationPort'])}], 'udpForwarding': [{'listen': endpoint(data['listenHost'], data['listenPort']), 'remote': endpoint(data['destinationHost'], data['destinationPort'])}]}
        config = directory / 'phormal.json'; agent.write_private(config, json.dumps(conf))
        return agent.unit_text([executable, 'server' if role == 'target' else 'client', '-c', str(config)])
    if method == 'hedioum':
        mimic = data.get('mimic', 'ssh')
        domain = data.get('domain', '')
        if role == 'target':
            conf = {'role': 'foreign', 'auth_token': own['token'], 'foreign_listen_port': data['port'], 'http_decoy_port': -1, 'decoy_port': 22, 'mimics': [{'type': mimic, 'port': data['port'], 'decoy': '127.0.0.1:22'}], 'domain': domain, 'egress_ip_mode': 'ipv4'}
        else:
            token = peer.get('token', '')
            if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
                raise agent.AgentError('Invalid Hedioum pairing token.')
            conf = {'role': 'iran', 'foreign_nodes': [{'alias': interface, 'target_ip': data['peerHost'], 'target_port': data['peerPort'], 'local_socks_port': data['listenPort'], 'socks_bind': '127.0.0.1', 'endpoints': [{'target': endpoint(data['peerHost'], data['peerPort']), 'mimic': mimic, 'server_name': domain}], 'auth_token': token, 'min_connections': 2, 'max_connections': 10, 'bandwidth_limit_mbps': 8, 'bandwidth_jitter_mbps': 2}]}
        mount = directory / 'hedioum'; mount.mkdir(mode=0o700, exist_ok=True)
        agent.write_private(mount / 'hedioum.json', json.dumps(conf))
        # Upstream uses one hard-coded config directory. A private service mount
        # gives each BenX tunnel its own config without replacing existing installs.
        Path('/etc/hedioum').mkdir(mode=0o700, exist_ok=True)
        return agent.unit_text([executable, '--foreground']).replace('UMask=0077', f'PrivateMounts=yes\nBindPaths={mount}:/etc/hedioum\nUMask=0077')
    raise agent.AgentError('Unsupported tunnel adapter.')
