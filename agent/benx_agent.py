#!/usr/bin/env python3
"""BenX privileged management agent. Python 3.11+, Linux/systemd.

Bind to loopback behind HTTPS/Cloudflare Tunnel. Token authentication is mandatory.
Only fixed package recipes and BenX-owned listener services can be executed.
"""
import base64
import copy
import hashlib
import hmac
import io
import ipaddress
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import subprocess
import threading
import tarfile
import time
import uuid
import sys
import http.client
sys.path.insert(0, str(Path(__file__).parent))
import accounting
import tunnels
import tunnel_probe
import setup as server_setup
import control as server_control
import storefront
import vpn_network
import reality_probe
import dns_service
import outbound
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit, quote, urlencode
from urllib.request import urlopen, Request

VERSION = "0.8.0"
ROOT = Path(os.environ.get("BENX_DATA_DIR", "/var/lib/benx-agent"))
UNITS_DIR = Path("/etc/systemd/system")
SSH_RUNTIME_DIR = Path("/run/sshd")
PACKAGE_POLICY = Path("/usr/sbin/policy-rc.d")
TOKEN = os.environ.get("BENX_AGENT_TOKEN", "")
LOCK = threading.RLock()
JOBS = []
INSTALLING = False
CORES = {
    "xray": {"binary": "xray", "packages": [], "protocols": ["vless", "vmess", "trojan", "shadowsocks", "http", "socks", "tunnel", "hysteria", "wireguard"]},
    "openvpn": {"binary": "openvpn", "packages": ["openvpn", "openssl"], "protocols": ["openvpn"]},
    "ocserv": {"binary": "ocserv", "packages": ["ocserv", "openssl"], "protocols": ["openconnect"]},
    "openssh": {"binary": "sshd", "packages": ["openssh-server", "openssh-client"], "protocols": ["ssh"]},
    "wireguard": {"binary": "wg", "packages": ["wireguard-tools", "iproute2"], "protocols": ["wireguard-native"]},
    "sing-box": {"binary": "sing-box", "packages": [], "protocols": []},
    "hysteria2": {"binary": "hysteria", "packages": [], "protocols": []},
    "dnsproxy": {"binary": "benx-dnsproxy", "packages": [], "protocols": ["dns-resolver"]},
    "masterdnsvpn": {"binary": "benx-masterdnsvpn", "packages": [], "protocols": ["masterdnsvpn"]},
}


class AgentError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def run(args, input_text=None, timeout=30, check=True):
    """Never invokes a shell. Secrets may be passed only through stdin/files."""
    result = subprocess.run(args, input=input_text, capture_output=True, text=True,
                            timeout=timeout, env={**os.environ, "PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "DEBIAN_FRONTEND": "noninteractive"})
    if check and result.returncode:
        # Do not return configuration excerpts or credential-bearing subprocess output.
        raise AgentError(f"{Path(args[0]).name} failed (exit {result.returncode}). Check the agent journal on the server.", 502)
    return result.stdout.strip()


def binary(core):
    name = CORES[core]["binary"]
    return shutil.which(name) or next((str(p) for p in [Path("/usr/sbin") / name, Path("/usr/local/bin") / name] if p.is_file()), None)


def write_private(path, text):
    path = Path(path)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".new")
    with os.fdopen(os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as file:
        file.write(text)
    temp.replace(path)


def load_state():
    path = ROOT / "state.json"
    state = json.loads(path.read_text()) if path.exists() else {"inbounds": [], "clients": {}, "nextId": 1}
    activations = accounting.read(sys.modules[__name__], 'accounting.json', {}).get('firstUse', {})
    for email, client in state['clients'].items():
        client['_firstUse'] = activations.get(email, {})
    return state


def unit_name(inbound):
    return f"benx-{core_of(inbound['protocol'])}-{int(inbound['id'])}.service"


def core_of(protocol):
    for name, core in CORES.items():
        if protocol in core["protocols"]:
            return name
    raise AgentError("This protocol has no native provisioning adapter.")


def object_value(value):
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, dict):
        raise AgentError("Expected a configuration object.")
    return value


def safe_line(value, label="Value"):
    value = str(value)
    if len(value) > 2048 or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise AgentError(f"{label} contains invalid characters.")
    return value


def host(value):
    value = safe_line(value, "Public host")
    if not re.fullmatch(r"[a-zA-Z0-9.:-]{1,253}", value):
        raise AgentError("Set a public hostname or IP address in the Protocol tab.")
    return value


def peer_key(value, label="WireGuard key"):
    try:
        if len(base64.b64decode(value, validate=True)) != 32:
            raise ValueError()
    except (ValueError, TypeError):
        raise AgentError(f"{label} must be a base64-encoded 32-byte key.") from None
    return value


def eligible(client):
    expiry = effective_expiry(client)
    return client.get("enable", True) and not client.get('_quotaBlocked', False) and (expiry <= 0 or expiry > time.time() * 1000)


def effective_expiry(client):
    expiry = int(client.get('expiryTime', 0))
    activation = client.get('_firstUse', {})
    if expiry < 0 and activation.get('duration') == expiry and activation.get('identity') == client.get('firstUseId', client.get('id', client.get('uuid'))) and activation.get('startedAt', 0) > 0:
        return activation['startedAt'] - expiry
    return expiry


def attached(state, inbound, active_only=True):
    return [c for c in state["clients"].values() if inbound["id"] in c.get("inboundIds", []) and (not active_only or eligible(c))]


def system_user(email):
    return "benx_" + hashlib.sha256(email.encode()).hexdigest()[:20]


def x25519_keypair(private=None):
    if private:
        pem = '-----BEGIN PRIVATE KEY-----\n' + base64.b64encode(bytes.fromhex('302e020100300506032b656e04220420') + base64.b64decode(peer_key(private))).decode() + '\n-----END PRIVATE KEY-----\n'
    else:
        pem = run(['openssl', 'genpkey', '-algorithm', 'X25519'])
    der = base64.b64decode(''.join(v for v in pem.splitlines() if not v.startswith('-----')))
    public_pem = run(['openssl', 'pkey', '-pubout'], input_text=pem)
    public_der = base64.b64decode(''.join(v for v in public_pem.splitlines() if not v.startswith('-----')))
    return base64.b64encode(der[-32:]).decode(), base64.b64encode(public_der[-32:]).decode()


def validate_client(client, ids, state):
    if not isinstance(client, dict):
        raise AgentError("Expected a client object.")
    client.pop('traffic', None)
    email = client.get("email", "")
    if not isinstance(email, str) or not re.fullmatch(r"[^\s/\\\x00-\x1f\x7f]{1,128}", email):
        raise AgentError("Invalid client name.")
    valid_ids = {i["id"] for i in state["inbounds"]}
    if not isinstance(ids, list) or any(type(i) is not int or i not in valid_ids for i in ids):
        raise AgentError("Select existing inbound IDs.")
    if type(client.get('totalGB', 0)) not in [int, float] or not 0 <= client.get('totalGB', 0) <= 1024 ** 3 * 1000000:
        raise AgentError('Invalid traffic quota.')
    if client.get('totalGB') and not any(i['id'] in ids and (accounting.supported(None, i) or i['protocol'] == 'masterdnsvpn' and masterdns_backend(i, state)) for i in state['inbounds']):
        raise AgentError('Traffic quotas need at least one measured attachment: VLESS, VMess, Trojan, Shadowsocks or native WireGuard.')
    client['_quotaBlocked'] = state['clients'].get(email, {}).get('_quotaBlocked', False)
    for field in ["limitIp", "limitHwid", "reset", "resetDay", "resetWeekday", "resetMax"]:
        if client.get(field, 0):
            raise AgentError(f"{field} requires 3X-UI accounting and is unavailable on native listeners.")
    if 'firstUseId' in client and (not isinstance(client['firstUseId'], str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', client['firstUseId'])):
        raise AgentError('Invalid first-use renewal identity.')
    duration = client.get('expiryTime', 0)
    if type(duration) is not int or duration < -3650 * 86400000 or -86400000 < duration < 0 or duration < 0 and duration % 86400000:
        raise AgentError('Set a valid expiry or 1–3650 days after first use.')
    if duration < 0 and not any(i['id'] in ids and (accounting.supported(None, i) or i['protocol'] == 'masterdnsvpn' and masterdns_backend(i, state)) for i in state['inbounds']):
        raise AgentError('First-use expiry requires Xray, native WireGuard or a metered MasterDNS backend. Use fixed expiry for other native protocols.')
    client['_firstUse'] = state['clients'].get(email, {}).get('_firstUse', {})
    if client.get("trafficReset", "never") != "never":
        raise AgentError("Native listeners support manual traffic resets.")
    for field in ["id", "uuid", "password", "auth", "subId", "flow"]:
        if field in client:
            safe_line(client[field], field)
    client.setdefault("id", str(uuid.uuid4()))
    client.setdefault("uuid", client["id"])
    client.setdefault("password", secrets.token_urlsafe(32))
    client.setdefault("enable", True)
    client.setdefault("totalGB", 0)
    client.setdefault("expiryTime", 0)
    client.setdefault("limitIp", 0)
    client.setdefault("subId", secrets.token_hex(8))
    client["inboundIds"] = sorted(set(ids))
    if any(i["id"] in ids and i["protocol"] == "dns-resolver" for i in state["inbounds"]):
        raise AgentError("DNS resolver access is configured by client network addresses in DNS hosting, not client attachments.")
    return client


def masterdns_backend(inbound, state):
    number = inbound.get('settings', {}).get('meteredInboundId', 0)
    if not number:
        return None
    target = next((i for i in state['inbounds'] if i['id'] == number), None)
    stream = target.get('streamSettings', {}) if target else {}
    if type(number) is not int or not target or target['protocol'] != 'vless' or target.get('listen') != '127.0.0.1' or stream.get('network', 'tcp') not in ['tcp', 'raw'] or stream.get('security', 'none') not in ['none', ''] or not target.get('excludeFromSub') or target.get('settings', {}).get('decryption') != 'none' or inbound.get('enable', True) and not target.get('enable', True):
        raise AgentError('Shared MasterDNSVPN requires a private VLESS RAW/TCP backend excluded from subscriptions.')
    customers = attached(state, inbound, active_only=False)
    identities = [c.get('uuid') or c.get('id') for c in customers]
    if any(number not in c.get('inboundIds', []) for c in customers) or any(not isinstance(v, str) or not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', v) for v in identities) or len(set(identities)) != len(identities):
        raise AgentError('Shared DNS clients need distinct UUIDs and attachments to its VLESS backend.')
    if any(i['id'] != inbound['id'] and i['protocol'] == 'masterdnsvpn' and i.get('settings', {}).get('meteredInboundId') == number for i in state['inbounds']):
        raise AgentError('Each shared DNS listener needs its own VLESS backend.')
    return target


def validate_inbound(inbound, state):
    if not isinstance(inbound, dict):
        raise AgentError("Expected an inbound object.")
    if inbound.get('protocol') == 'masterdnsvpn' and any(i.get('protocol') == 'masterdnsvpn' and i.get('id') != inbound.get('id') for i in state['inbounds']):
        raise AgentError('Use the existing MasterDNSVPN inbound for this server. It supports multiple domains and customers.')
    core = core_of(inbound.get("protocol"))
    if not binary(core):
        raise AgentError("Install the selected core before creating its inbound.", 409)
    if type(inbound.get("port")) is not int or not 1 <= inbound["port"] <= 65535:
        raise AgentError("Port must be between 1 and 65535.")
    if any(i["id"] != inbound["id"] and i["port"] == inbound["port"] for i in state["inbounds"]):
        raise AgentError("Another BenX inbound uses that port.", 409)
    listen = inbound.get("listen") or "0.0.0.0"
    try:
        ipaddress.ip_address(listen)
    except ValueError:
        raise AgentError("Listen address must be an IP address.") from None
    if core != "xray" and ":" in listen:
        raise AgentError("This native adapter currently supports IPv4 listen addresses.")
    if inbound.get("total", 0) or inbound.get("trafficReset", "never") != "never":
        raise AgentError("Traffic accounting requires a 3X-UI panel connection.")
    inbound["core"] = core
    for key in ["settings", "streamSettings", "sniffing"]:
        inbound[key] = object_value(inbound.get(key, {}))
    inbound.setdefault("enable", True)
    if core == "dnsproxy":
        dns_service.validate(sys.modules[__name__], inbound, state)
    elif inbound["enable"]:
        for other in state["inbounds"]:
            if other["id"] != inbound["id"] and other.get("enable", True) and other["protocol"] == "dns-resolver" and any(port == inbound["port"] for port, _ in dns_service.endpoints(other)):
                raise AgentError("Another DNS endpoint uses that port. Choose a different port.", 409)
    inbound.setdefault("expiryTime", 0)
    inbound.setdefault("remark", "")
    inbound.setdefault("listen", "")
    inbound.setdefault("up", 0)
    inbound.setdefault("down", 0)
    inbound.setdefault("total", 0)
    return inbound


def certificate(directory, name, public_host=None, client=False):
    """Issue certificates only in this agent's private per-listener PKI."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    ca = directory / "ca.crt"
    if not ca.exists():
        run(["openssl", "req", "-x509", "-newkey", "rsa:3072", "-nodes", "-sha256", "-days", "3650", "-subj", "/CN=BenX Private CA", "-keyout", str(directory / "ca.key"), "-out", str(ca)], timeout=60)
    key, cert = directory / f"{name}.key", directory / f"{name}.crt"
    if not cert.exists():
        csr, ext = directory / f"{name}.csr", directory / f"{name}.ext"
        run(["openssl", "req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", f"/CN={name}", "-keyout", str(key), "-out", str(csr)], timeout=60)
        extension = "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=" + ("clientAuth" if client else "serverAuth") + "\n"
        if public_host:
            try:
                ipaddress.ip_address(public_host)
                extension += f"subjectAltName=IP:{public_host}\n"
            except ValueError:
                extension += f"subjectAltName=DNS:{public_host}\n"
        write_private(ext, extension)
        run(["openssl", "x509", "-req", "-in", str(csr), "-CA", str(ca), "-CAkey", str(directory / "ca.key"), "-set_serial", str(secrets.randbits(128)), "-days", "825", "-sha256", "-extfile", str(ext), "-out", str(cert)])
    for file in directory.iterdir():
        file.chmod(0o600)
    return key, cert, ca


def unit_text(command, stop=None):
    def quote(arg):
        return '"' + str(arg).replace('\\', '\\\\').replace('"', '\\"').replace('%', '%%') + '"'
    return "[Unit]\nDescription=BenX managed VPN listener\nAfter=network-online.target\nWants=network-online.target\n[Service]\nType=" + ("oneshot" if stop else "simple") + "\nExecStart=" + " ".join(quote(a) for a in command) + "\n" + ("RemainAfterExit=yes\nExecStop=" + " ".join(quote(a) for a in stop) + "\n" if stop else "Restart=on-failure\nRestartSec=3\n") + "UMask=0077\n[Install]\nWantedBy=multi-user.target\n"


def vpn_unit(command, number, subnet, internet=True, stop=None):
    text = unit_text(command, stop)
    if type(internet) is not bool:
        raise AgentError('Internet access must be enabled or disabled.')
    script = Path(__file__).parent / 'vpn_network.py'
    network = str(ipaddress.IPv4Network(subnet, strict=True))
    if internet:
        try:
            vpn_network.rules(number, network, 'eth0')
        except ValueError:
            raise AgentError('Use a private IPv4 VPN subnet between /16 and /32 for Internet access.') from None
    action = 'up' if internet else 'down'
    hooks = f'ExecStartPre=/usr/bin/python3 {script} {action} --id {number} --subnet {network}\nExecStopPost=/usr/bin/python3 {script} down --id {number} --subnet {network}\n'
    return text.replace('[Service]\n', '[Service]\n' + hooks)


def compile_inbound(inbound, state):
    core, number = core_of(inbound["protocol"]), int(inbound["id"])
    directory = ROOT / "listeners" / str(number)
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    settings = object_value(inbound["settings"])
    clients = attached(state, inbound)
    port, listen = inbound["port"], inbound.get("listen") or "0.0.0.0"
    if state.get("storefront", {}).get("enabled") and number in state["storefront"].get("inboundIds", []):
        listen = "127.0.0.1"
    executable = binary(core)
    if not executable:
        raise AgentError("Selected core is not installed.", 409)
    if core == "xray":
        settings = {**settings}
        if inbound["protocol"] in ["vless", "vmess", "trojan", "shadowsocks"]:
            settings["clients"] = [{**c, "id": c.get("uuid") or c["id"]} for c in clients]
            if inbound['protocol'] == 'shadowsocks' and not str(settings.get('method', '')).startswith('2022-'):
                for user in settings['clients']:
                    user['method'] = settings.get('method', '')
        elif inbound["protocol"] in ["http", "socks"]:
            settings["accounts"] = [{"user": system_user(c["email"]), "pass": c["password"]} for c in clients] or [{"user": "benx_disabled", "pass": secrets.token_urlsafe(48)}]
            if inbound["protocol"] == "socks":
                settings["auth"] = "password"
        elif inbound["protocol"] == "hysteria":
            settings["version"] = 2
            # Xray 26.3 uses clients; newer versions retain this compatible alias.
            settings["clients"] = [{"auth": c.get("auth") or c["password"], "email": c["email"], "level": 0} for c in clients]
            settings.pop("users", None)
        elif inbound['protocol'] == 'wireguard':
            private, _public = x25519_keypair(settings.get('secretKey') or settings.get('privateKey'))
            if not settings.get('secretKey'):
                inbound['settings']['privateKey'] = private
            settings['secretKey'] = private
            settings['peers'] = []
            used_ips = set()
            for c in clients:
                c['privateKey'], c['publicKey'] = x25519_keypair(c.get('privateKey'))
                ips = c.get('allowedIPsByInbound', {}).get(str(number), c.get('allowedIPs', []))
                if isinstance(ips, str):
                    ips = [v.strip() for v in ips.split(',') if v.strip()]
                if not ips:
                    raise AgentError('Set a unique WireGuard client address in Allowed IPs before attaching it.')
                parsed = [str(ipaddress.ip_network(v, strict=False)) for v in ips]
                if any(v in used_ips for v in parsed):
                    raise AgentError('WireGuard client addresses cannot overlap.')
                used_ips.update(parsed)
                settings['peers'].append({'publicKey': c['publicKey'], 'allowedIPs': parsed, 'email': c['email'], 'level': 0, **({'preSharedKey': peer_key(c['preSharedKey'])} if c.get('preSharedKey') else {})})
            settings.pop('clients', None)
        wire = {k: copy.deepcopy(inbound[k]) for k in ["port", "protocol", "listen", "streamSettings", "sniffing"] if k in inbound}
        # Xray treats an empty string as a domain and can panic while parsing it.
        # The panel's blank address means listen on all IPv4 interfaces.
        wire['listen'] = listen
        wire['tag'] = inbound.get('tag') or f'inbound-{number}'
        if inbound['protocol'] == 'http' and wire.get('streamSettings', {}).get('security') == 'tls':
            # Xray's HTTP inbound accepts HTTP/1 CONNECT, not HTTP/2 frames.
            wire['streamSettings'].setdefault('tlsSettings', {})['alpn'] = ['http/1.1']
        wire["protocol"] = "dokodemo-door" if wire["protocol"] == "tunnel" else wire["protocol"]
        wire["settings"] = settings
        if inbound['protocol'] == 'hysteria':
            stream = wire.get('streamSettings', {})
            if stream.get('network') != 'hysteria' or stream.get('security') != 'tls':
                raise AgentError('Hysteria2 requires Hysteria transmission and TLS with a matching server certificate.')
            stream.setdefault('hysteriaSettings', {})['version'] = 2
            # An unused listener must never accept an empty shared transport password.
            stream['hysteriaSettings']['auth'] = secrets.token_urlsafe(48)
        config = directory / "xray.json"
        if not inbound.get('_benxApiPort'):
            with socket.socket() as sock:
                sock.bind(('127.0.0.1', 0))
                inbound['_benxApiPort'] = sock.getsockname()[1]
        api_port = inbound['_benxApiPort']
        for client in settings.get('clients', []):
            client['level'] = 0
        api_wire = {'listen': '127.0.0.1', 'port': api_port, 'protocol': 'dokodemo-door', 'settings': {'address': '127.0.0.1'}, 'tag': 'benx-api'}
        global_config = state.get('xray', {})
        # Keep disabled rules in the saved editor profile, but never send them to Xray.
        global_config = {**global_config, 'routing': {**global_config.get('routing', {}), 'rules': [{k: v for k, v in rule.items() if k != 'enabled'} for rule in global_config.get('routing', {}).get('rules', []) if rule.get('enabled') is not False]}}
        payload = {**global_config, 'log': global_config.get('log', {'loglevel': 'warning'}), 'inbounds': [wire, api_wire], 'outbounds': global_config.get('outbounds', [{'protocol': 'freedom', 'tag': 'direct'}]), 'api': {'tag': 'benx-api', 'services': ['StatsService']}, 'stats': {}, 'policy': {'levels': {'0': {'statsUserUplink': True, 'statsUserDownlink': True}}}, 'routing': {**global_config.get('routing', {}), 'rules': [{'type': 'field', 'inboundTag': ['benx-api'], 'outboundTag': 'benx-api'}, *global_config.get('routing', {}).get('rules', [])]}}
        write_private(config, json.dumps(payload))
        run([executable, "run", "-test", "-config", str(config)])
        return unit_text([executable, "run", "-config", str(config)])
    if core == "dnsproxy":
        return dns_service.compile(sys.modules[__name__], inbound, state, directory)
    if core == "masterdnsvpn":
        domains = settings.get("DOMAIN", [])
        if not isinstance(domains, list) or not domains or any(not isinstance(d, str) or not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?", d) for d in domains):
            raise AgentError("Set the delegated DNS tunnel domains in the Protocol tab.")
        method = settings.get("DATA_ENCRYPTION_METHOD", 2)
        if type(method) is not int or method not in [1, 2, 3, 4, 5]:
            raise AgentError("Select XOR, ChaCha20 or AES-GCM for DNS tunnel encryption.")
        defaults = json.loads((Path(__file__).parent / "masterdnsvpn-defaults.json").read_text())
        config = directory / "masterdnsvpn.json"
        key_file = directory / "dns-encryption-key.txt"
        payload = {**defaults, **settings, "DOMAIN": domains, "DATA_ENCRYPTION_METHOD": method, "UDP_HOST": listen, "UDP_PORT": port, "ENCRYPTION_KEY_FILE": str(key_file)}
        payload.pop("clients", None)
        payload.pop("clientResolvers", None)
        payload.pop("meteredInboundId", None)
        backend = masterdns_backend(inbound, state)
        if backend:
            payload.update(PROTOCOL_TYPE='TCP', FORWARD_IP='127.0.0.1', FORWARD_PORT=backend['port'], USE_EXTERNAL_SOCKS5=False)
        write_private(config, json.dumps(payload))
        # Upstream validates configuration and creates/loads the key without opening a listener.
        run([executable, "-json", str(config), "-genkey", "-nowait"])
        key_file.chmod(0o600)
        inbound["settings"]["DATA_ENCRYPTION_METHOD"] = method
        return unit_text([executable, "-json", str(config), "-nowait"])
    public = host(settings.get("publicHost", ""))
    if core == "openvpn":
        subnet = ipaddress.IPv4Network(settings.get("subnet", "10.80.0.0/24"), strict=True)
        dns = str(ipaddress.ip_address(settings.get("dns", "1.1.1.1")))
        transport = settings.get("transport", "udp")
        if transport not in ["udp", "tcp", "both"]:
            raise AgentError("OpenVPN transport must be UDP, TCP, or both with its managed TCP companion.")
        cipher = settings.get("cipher", "AES-256-GCM")
        if cipher not in ["AES-256-GCM", "AES-128-GCM"]:
            raise AgentError("Unsupported OpenVPN cipher.")
        key, cert, ca = certificate(directory / "pki", "server", public)
        password_auth = settings.get('authentication', 'certificate') == 'password'
        if settings.get('authentication', 'certificate') not in ['password', 'certificate']:
            raise AgentError('Choose OpenVPN certificate or password authentication.')
        ccd = directory / "ccd"
        ccd.mkdir(mode=0o700, exist_ok=True)
        valid_names = set()
        for client in clients:
            name = system_user(client["email"])
            valid_names.add(name)
            certificate(directory / "pki", name, client=True)
            write_private(ccd / name, "")
        for file in ccd.iterdir():
            if file.name not in valid_names:
                file.unlink()
        config = directory / "openvpn.conf"
        write_private(config, f"port {port}\nlocal {listen}\nproto {'tcp-server' if transport == 'tcp' else 'udp'}\ndev tun\nca {ca}\ncert {cert}\nkey {key}\ndh none\ntopology subnet\nserver {subnet.network_address} {subnet.netmask}\ndata-ciphers {cipher}\nkeepalive 10 120\npersist-key\npersist-tun\nremote-cert-tls client\nverify-client-cert require\nclient-config-dir {ccd}\nccd-exclusive\npush \"dhcp-option DNS {dns}\"\nstatus {directory / 'status.log'} 10\nverb 3\n")
        if password_auth:
            helper = Path(__file__).parent / 'openvpn_auth.py'
            verifier = f'/usr/bin/python3 {helper} --state {ROOT / "state.json"} --inbound {number}'
            text = config.read_text().replace('remote-cert-tls client\n', '').replace('verify-client-cert require\n', 'verify-client-cert none\nusername-as-common-name\nscript-security 2\nauth-user-pass-verify "' + verifier + '" via-file\n')
            write_private(config, text)
        if settings.get('internetAccess', True):
            write_private(config, config.read_text() + 'push "redirect-gateway def1 bypass-dhcp"\n')
        return vpn_unit([executable, "--config", str(config)], number, str(subnet), settings.get('internetAccess', True))
    if core == "ocserv":
        subnet = ipaddress.IPv4Network(settings.get("subnet", "10.81.0.0/24"), strict=True)
        dns = str(ipaddress.ip_address(settings.get("dns", "1.1.1.1")))
        key, cert, _ca = certificate(directory / "pki", "server", public)
        passwd = directory / "ocpasswd"
        write_private(passwd, "")
        for client in clients:
            password = safe_line(client["password"], "Password")
            if not password:
                raise AgentError("OpenConnect clients require a password.")
            run(["ocpasswd", "-c", str(passwd), system_user(client["email"])], input_text=password + "\n" + password + "\n")
        max_clients, mtu = int(settings.get("maxClients", 128)), int(settings.get("mtu", 1400))
        if not 1 <= max_clients <= 10000 or not 576 <= mtu <= 9000:
            raise AgentError("Invalid OpenConnect client limit or MTU.")
        config = directory / "ocserv.conf"
        write_private(config, f'auth = "plain[passwd={passwd}]"\nlisten-host = {listen}\ntcp-port = {port}\nudp-port = {port}\nrun-as-user = root\nrun-as-group = root\nsocket-file = {directory / "ocserv.sock"}\npid-file = {directory / "ocserv.pid"}\nserver-cert = {cert}\nserver-key = {key}\nisolate-workers = true\nmax-clients = {max_clients}\nmax-same-clients = 2\nkeepalive = 300\ndpd = 90\nmobile-dpd = 1800\ntry-mtu-discovery = true\ndevice = bx{number}\nipv4-network = {subnet.network_address}\nipv4-netmask = {subnet.netmask}\ndns = {dns}\nmtu = {mtu}\ncisco-client-compat = true\n')
        if settings.get('internetAccess', True) is False:
            write_private(config, config.read_text() + f'route = {subnet}\n')
        run([executable, "--test-config", "--config", str(config)])
        return vpn_unit([executable, "--foreground", "--config", str(config)], number, str(subnet), settings.get('internetAccess', True))
    if core == "openssh":
        for client in attached(state, inbound, active_only=False):
            username = system_user(client["email"])
            if not run(["getent", "passwd", username], check=False):
                run(["useradd", "--no-create-home", "--shell", "/bin/false", username])
            run(["chpasswd"], input_text=f"{username}:{safe_line(client['password'], 'Password')}\n")
        key = directory / "ssh_host_ed25519_key"
        if not key.exists():
            run(["ssh-keygen", "-t", "ed25519", "-N", "", "-f", str(key)])
        SSH_RUNTIME_DIR.mkdir(mode=0o755, exist_ok=True)
        config = directory / "sshd.conf"
        allowed = " ".join(system_user(c["email"]) for c in clients) or "benx_no_clients"
        write_private(config, f"Port {port}\nListenAddress {listen}\nHostKey {key}\nPidFile {directory / 'sshd.pid'}\nPermitRootLogin no\nPasswordAuthentication yes\nPubkeyAuthentication no\nUsePAM no\nPermitEmptyPasswords no\nAllowUsers {allowed}\nAllowTcpForwarding {'yes' if settings.get('allowTcpForwarding', True) else 'no'}\nGatewayPorts no\nX11Forwarding no\nPermitTunnel no\nPermitTTY no\nForceCommand /bin/false\n")
        run([executable, "-t", "-f", str(config)])
        return unit_text([executable, "-D", "-e", "-f", str(config)])
    if core == "wireguard":
        config = directory / f"bx{number}.conf"
        private = settings.get("privateKey") or run([executable, "genkey"])
        settings["privateKey"] = peer_key(private)
        inbound["settings"]["privateKey"] = private
        address = str(ipaddress.IPv4Interface(settings.get("address", "10.82.0.1/24")))
        mtu = int(settings.get("mtu", 1420))
        if not 576 <= mtu <= 9000:
            raise AgentError("Invalid WireGuard MTU.")
        content = f"[Interface]\nPrivateKey = {private}\nAddress = {address}\nListenPort = {port}\nMTU = {mtu}\n"
        used_ips = set()
        for client in clients:
            if not client.get("privateKey"):
                client["privateKey"] = run([executable, "genkey"])
            client["publicKey"] = run([executable, "pubkey"], input_text=peer_key(client["privateKey"]) + "\n")
            overrides = client.get("allowedIPsByInbound", {})
            ips = overrides.get(str(number), client.get("allowedIPs", []))
            if isinstance(ips, str):
                ips = [v.strip() for v in ips.split(",") if v.strip()]
            if not ips:
                raise AgentError("Set this WireGuard client's Allowed IPs before attaching it.")
            parsed = [str(ipaddress.ip_network(v, strict=False)) for v in ips]
            if any(v in used_ips for v in parsed):
                raise AgentError("WireGuard clients cannot share Allowed IPs.")
            used_ips.update(parsed)
            content += f"\n[Peer]\nPublicKey = {peer_key(client['publicKey'])}\nAllowedIPs = {', '.join(parsed)}\n"
            if client.get("preSharedKey"):
                content += f"PresharedKey = {peer_key(client['preSharedKey'])}\n"
        write_private(config, content)
        quick = shutil.which("wg-quick")
        if not quick:
            raise AgentError("wg-quick is required.")
        run([quick, "strip", str(config)])
        return vpn_unit([quick, "up", str(config)], number, str(ipaddress.IPv4Interface(address).network), settings.get('internetAccess', True), [quick, "down", str(config)])
    raise AgentError("Provisioning adapter unavailable.")


def active_inbound(inbound):
    return inbound.get("enable", True) and (int(inbound.get("expiryTime", 0)) <= 0 or int(inbound["expiryTime"]) > time.time() * 1000)


def should_run(inbound, state):
    if (ROOT / 'retired.json').exists():
        return False
    return state.get('coreEnabled', {}).get(core_of(inbound['protocol']), True) and active_inbound(inbound) and (inbound["protocol"] not in ["masterdnsvpn", "http", "socks"] or bool(attached(state, inbound)))


def apply_state(state, previous, changed_ids):
    # Serialize configuration writes and systemd operations across requests/jobs.
    storefront.validate(sys.modules[__name__], state)
    accounting.collect(sys.modules[__name__], previous)
    staged = {}
    old_files = {}
    old_units = {}
    old_running = {}
    old_enabled = {}
    units_changed = False
    affected = [i for i in state["inbounds"] if i["id"] in changed_ids]
    for inbound in [*affected, *[i for i in previous["inbounds"] if i["id"] in changed_ids]]:
        name = unit_name(inbound)
        unit = UNITS_DIR / name
        old_units[name] = unit.read_text() if unit.exists() else None
        old_running[name] = run(["systemctl", "is-active", name], check=False) == "active"
        old_enabled[name] = run(["systemctl", "is-enabled", name], check=False) == "enabled"
    for inbound in affected:
        directory = ROOT / "listeners" / str(inbound["id"])
        old_files[inbound["id"]] = {p: p.read_bytes() for p in directory.rglob("*") if p.is_file()} if directory.exists() else {}
    try:
        for inbound in affected:
            staged[unit_name(inbound)] = compile_inbound(inbound, state)
        for name, text in staged.items():
            write_private(UNITS_DIR / name, text)
        units_changed = True
        run(["systemctl", "daemon-reload"])
        for old in previous["inbounds"]:
            if old["id"] in changed_ids and not any(unit_name(i) == unit_name(old) for i in affected):
                run(["systemctl", "disable", "--now", unit_name(old)])
        for inbound in affected if units_changed else []:
            name = unit_name(inbound)
            if should_run(inbound, state):
                run(["systemctl", "enable", name])
                run(["systemctl", "restart", name])
                time.sleep(0.35)
                if run(["systemctl", "is-active", name], check=False) != "active":
                    raise AgentError("Listener did not start. Review the agent journal and server port availability.", 502)
            else:
                run(["systemctl", "disable", "--now", name])
        storefront.apply(sys.modules[__name__], state, previous)
        write_private(ROOT / "state.json", json.dumps(state))
    except Exception:
        # Restore previous managed configurations; never touch unrelated system services.
        for number, files in old_files.items():
            directory = ROOT / "listeners" / str(number)
            for path in directory.rglob("*"):
                if path.is_file() and path not in files:
                    path.unlink()
            for path, contents in files.items():
                write_private(path, contents.decode())
        for inbound in affected:
            name = unit_name(inbound)
            if not any(unit_name(old) == name for old in previous["inbounds"]):
                run(["systemctl", "disable", "--now", name], check=False)
        # SSH account passwords are system state outside the managed configuration directory.
        ssh_ids = {i["id"] for i in previous["inbounds"] if i["id"] in changed_ids and i["protocol"] == "ssh"}
        for client in previous["clients"].values():
            if ssh_ids.intersection(client["inboundIds"]):
                run(["chpasswd"], input_text=f"{system_user(client['email'])}:{safe_line(client['password'], 'Password')}\n", check=False)
        if units_changed:
            for name, text in old_units.items():
                unit = UNITS_DIR / name
                if text is not None:
                    write_private(unit, text)
                elif unit.exists():
                    unit.unlink()
            run(["systemctl", "daemon-reload"], check=False)
            for name, text in old_units.items():
                if text is not None:
                    run(["systemctl", "enable" if old_enabled[name] else "disable", name], check=False)
                    run(["systemctl", "restart" if old_running[name] else "stop", name], check=False)
        raise


def capabilities(state):
    rows = []
    for name, core in CORES.items():
        executable = binary(name)
        instances = [i for i in state["inbounds"] if core_of(i["protocol"]) == name]
        states = [run(["systemctl", "is-active", unit_name(i)], check=False) for i in instances]
        version = ""
        if executable:
            version = run([executable, "version"] if name in ["xray", "sing-box"] else [executable, "-version"] if name == "masterdnsvpn" else [executable, "-V"] if name == "openssh" else [executable, "--version"], check=False).split("\n")[0][:120]
        rows.append({"id": name, "installed": bool(executable), "state": "running" if "active" in states else "failed" if "failed" in states else "stopped", "version": version or ("Installed" if executable else ""), "installable": bool(core["packages"] and shutil.which("apt-get")) or name in ["xray", "masterdnsvpn", "dnsproxy"] and platform.machine().lower() in ["x86_64", "amd64", "aarch64", "arm64", "armv7l"], "instances": len(instances), "protocols": core["protocols"], "reason": "Pinned official release with SHA-256 verification." if name in ["xray", "masterdnsvpn", "dnsproxy"] else "" if core["packages"] else "Detected binary only; native provisioning adapter is not available yet."})
    return {"agent": "benx-agent", "version": VERSION, "policyRevision": accounting.read(sys.modules[__name__], "policy.json", {"revision": 0})["revision"], "fullAccess": os.geteuid() == 0 and bool(shutil.which("systemctl")), "platform": platform.freedesktop_os_release().get("PRETTY_NAME", "Linux"), "cores": rows, "features": ["native-inbounds", "native-clients", "fixed-expiry", "first-use-expiry", "core-installation", "weighted-accounting", "tunneling", "xray-outbounds", "server-setup", "desired-state", "server-recovery", "tunnel-tests", "ip-certificates"]}


def masterdns_binary(archive, asset):
    if len(archive) > 100 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != asset["sha256"]:
        raise AgentError("MasterDnsVPN archive checksum verification failed.", 502)
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as files:
        candidates = [m for m in files.getmembers() if m.isfile() and re.fullmatch(r"MasterDnsVPN_Server_Linux_(AMD64|ARM64|ARMV7)_v[\w.-]+", Path(m.name).name) and m.size < 100 * 1024 * 1024]
        if len(candidates) != 1:
            raise AgentError("Official archive does not contain the expected server binary.", 502)
        # Extract only the regular binary; archive paths are never used as destinations.
        return files.extractfile(candidates[0]).read()


def install_masterdns():
    architecture = {"x86_64": "AMD64", "amd64": "AMD64", "aarch64": "ARM64", "arm64": "ARM64", "armv7l": "ARMV7"}.get(platform.machine().lower())
    manifest = json.loads((Path(__file__).parent / "masterdnsvpn-release.json").read_text())
    asset = manifest["assets"].get(architecture)
    if not asset:
        raise AgentError("No pinned MasterDnsVPN build is available for this architecture.", 409)
    if not asset["url"].startswith("https://github.com/masterking32/MasterDnsVPN/releases/download/"):
        raise AgentError("Invalid release manifest.")
    with urlopen(Request(asset["url"], headers={"User-Agent": "BenX-Agent/" + VERSION}), timeout=120) as response:
        archive = response.read(100 * 1024 * 1024 + 1)
    data = masterdns_binary(archive, asset)
    destination = Path("/usr/local/bin/benx-masterdnsvpn")
    temporary = destination.with_suffix(".new")
    with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o700), "wb") as output:
        output.write(data)
    temporary.replace(destination)
    run([str(destination), "-version"])


def start_job(core, action, state):
    global INSTALLING
    if core not in CORES or action not in ["install", "start", "stop", "restart"]:
        raise AgentError("Unknown core operation.")
    if INSTALLING:
        raise AgentError("Wait for the current server action to finish.", 409)
    if action == "install" and core not in ["xray", "masterdnsvpn", "dnsproxy"] and (not CORES[core]["packages"] or not shutil.which("apt-get")):
        raise AgentError("No distribution package installation recipe is available for this core.", 409)
    job = {"id": str(uuid.uuid4()), "core": core, "action": action, "state": "queued", "message": "Waiting for server action.", "createdAt": int(time.time() * 1000)}
    JOBS.insert(0, job)
    del JOBS[100:]
    INSTALLING = True

    def execute():
        global INSTALLING
        try:
            job.update(state="running", message="Installing distribution packages." if action == "install" else "Updating managed listeners.")
            if action == "install" and core == "masterdnsvpn":
                install_masterdns()
            elif action == "install" and core == "dnsproxy":
                server_setup.install_core(sys.modules[__name__], core)
            elif action == "install" and core == "xray":
                server_setup.install_xray(sys.modules[__name__])
            elif action == "install":
                policy = PACKAGE_POLICY
                created_policy = False
                try:
                    # Debian invokes this policy before package-triggered service starts.
                    if not policy.exists():
                        with os.fdopen(os.open(policy, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755), "w") as file:
                            file.write("#!/bin/sh\n# BenX temporary package-install policy\nexit 101\n")
                        created_policy = True
                    run(["apt-get", "update"], timeout=600)
                    run(["apt-get", "install", "--yes", "--no-install-recommends", *CORES[core]["packages"]], timeout=900)
                finally:
                    if created_policy and policy.read_text() == "#!/bin/sh\n# BenX temporary package-install policy\nexit 101\n":
                        policy.unlink()
                if not binary(core):
                    raise AgentError("Package installation finished but the core binary was not found.", 502)
            else:
                with LOCK:
                    fresh = load_state()
                    rows = [i for i in fresh["inbounds"] if core_of(i["protocol"]) == core]
                    if not rows:
                        raise AgentError("Create an inbound for this core before starting it.", 409)
                    for row in rows:
                        if action in ["start", "restart"] and not should_run(row, fresh):
                            continue
                        run(["systemctl", "stop" if action == "stop" else "restart", unit_name(row)])
            job.update(state="succeeded", message="Core installed. Create an inbound to configure its listener." if action == "install" else "Managed listener action completed.")
        except Exception as error:
            job.update(state="failed", message=str(error) if isinstance(error, AgentError) else "Server action failed. Check the agent journal.")
        finally:
            INSTALLING = False
    threading.Thread(target=execute, daemon=True).start()
    return copy.deepcopy(job)


def inbound_rows(state):
    rows = copy.deepcopy(state["inbounds"])
    ledger = accounting.read(sys.modules[__name__], 'accounting.json', {'usage': {}})
    for row in rows:
        usage = ledger.get('inbounds', {}).get(str(row['id']), {})
        row['up'], row['down'] = usage.get('up', 0), usage.get('down', 0)
        row["settings"]["clients"] = [{**c, "expiryTime": effective_expiry(c)} for c in attached(state, row, active_only=False)]
        if row['protocol'] in ['http', 'socks']:
            row['settings']['clients'] = [{**c, 'proxyUsername': system_user(c['email'])} for c in row['settings']['clients']]
        row['clientStats'] = [{'email': c['email'], 'up': ledger['usage'].get(c['email'], {}).get('up', 0), 'down': ledger['usage'].get(c['email'], {}).get('down', 0)} for c in row['settings']['clients']]
    return rows


def client_profiles(state, email):
    client = state["clients"].get(email)
    if not client:
        raise AgentError("Client not found.", 404)
    if not eligible(client):
        raise AgentError("This client is disabled or expired.", 409)
    profiles = []
    for inbound in state["inbounds"]:
        if inbound["id"] not in client["inboundIds"]:
            continue
        core = core_of(inbound["protocol"])
        settings = inbound["settings"]
        directory = ROOT / "listeners" / str(inbound["id"])
        if core == "xray":
            if inbound['protocol'] == 'wireguard':
                _private, public_key = x25519_keypair(settings.get('secretKey') or settings.get('privateKey'))
                ips = client.get('allowedIPsByInbound', {}).get(str(inbound['id']), client.get('allowedIPs', []))
                address = ','.join(ips) if isinstance(ips, list) else ips
                endpoint = host(settings.get('publicHost', '')) + ':' + str(inbound['port'])
                query = urlencode({'publickey': public_key, 'address': address, 'presharedkey': client.get('preSharedKey', ''), 'mtu': settings.get('mtu', 1420), 'keepalive': 25, 'allowedips': '0.0.0.0/0,::/0'})
                profiles.append('wireguard://' + quote(client['privateKey'], safe='') + '@' + endpoint + '?' + query + '#' + quote(inbound.get('remark', 'WireGuard')))
                profiles.append(f"[Interface]\nPrivateKey = {client['privateKey']}\nAddress = {address}\nDNS = 1.1.1.1\n\n[Peer]\nPublicKey = {public_key}\nEndpoint = {endpoint}\nAllowedIPs = 0.0.0.0/0, ::/0\nPersistentKeepalive = 25\n")
                continue
            # Structured export preserves every transport setting. Use an Xray client config importer.
            profiles.append(json.dumps({"remark": inbound["remark"], "protocol": inbound["protocol"], "port": inbound["port"], "streamSettings": inbound["streamSettings"], "credential": client}))
            continue
        if core == "masterdnsvpn":
            profile = {"DOMAINS": settings["DOMAIN"], "DATA_ENCRYPTION_METHOD": settings.get("DATA_ENCRYPTION_METHOD", 2), "ENCRYPTION_KEY": (directory / "dns-encryption-key.txt").read_text().strip(), "PROTOCOL_TYPE": "SOCKS5", "LISTEN_IP": "127.0.0.1", "LISTEN_PORT": 18000, "LOCAL_DNS_ENABLED": False}
            backend = masterdns_backend(inbound, state)
            if backend:
                profile['PROTOCOL_TYPE'] = 'TCP'
            profiles.append(json.dumps(profile, indent=2))
            profiles.append("# MasterDnsVPN client_resolvers.txt\n" + "\n".join(settings.get("clientResolvers", ["1.1.1.1:53", "8.8.8.8:53", "9.9.9.9:53"])) + "\n")
            if backend:
                profiles.append('vless://' + str(client.get('uuid') or client['id']) + '@127.0.0.1:18000?encryption=none&security=none&type=tcp#MasterDNSVPN-metered')
                profiles.append('# Shared DNS instructions\nStart the MasterDNSVPN TCP client first, then import the localhost VLESS link in V2Box, Happ or another VLESS app. Keep port 18000 on localhost. Each customer has a distinct UUID. Payload usage is charged by the VLESS backend; DNS transport overhead is not included. Disable the customer to revoke proxy access; the outer DNS key remains shared.\n')
            if not backend:
                uri = {"v": "1", "ps": inbound.get("remark", inbound["protocol"]) + " - " + email, "domain": settings["DOMAIN"][0], "key": profile["ENCRYPTION_KEY"], "method": profile["DATA_ENCRYPTION_METHOD"], "port": profile["LISTEN_PORT"], "protocol": "SOCKS5", "resolvers": settings.get("clientResolvers", ["1.1.1.1", "8.8.8.8", "9.9.9.9"])}
                profiles.append("masterdns://" + base64.b64encode(json.dumps(uri).encode()).decode())
            continue
        public = host(settings.get("publicHost", ""))
        if core == "openvpn":
            key, cert, ca = certificate(directory / "pki", system_user(email), client=True)
            transport = "tcp-client" if settings.get("transport", "udp") == "tcp" else "udp"
            common = f"client\ndev tun\nproto {transport}\nremote {public} {inbound['port']}\nresolv-retry infinite\nnobind\npersist-key\npersist-tun\nremote-cert-tls server\n<ca>\n{ca.read_text()}</ca>\n"
            profiles.append(common + ('auth-user-pass\nauth-nocache\n' if settings.get('authentication') == 'password' else f'<cert>\n{cert.read_text()}</cert>\n<key>\n{key.read_text()}</key>\n'))
            if settings.get('authentication') == 'password':
                profiles.append(f"# OpenVPN credentials\nUsername: {system_user(email)}\nPassword: {client['password']}\nImport the common .ovpn file, then enter these credentials when prompted.\n")
        elif core == "ocserv":
            cert = directory / "pki" / "server.crt"
            fingerprint = run(["openssl", "x509", "-in", str(cert), "-noout", "-fingerprint", "-sha256"]).split("=")[-1].replace(":", "").lower()
            public_pem = run(["openssl", "x509", "-in", str(cert), "-noout", "-pubkey"])
            # OpenConnect pins the SPKI public key, rather than the complete
            # X.509 certificate. Export its native pin for verified clients.
            public_der = base64.b64decode(''.join(line for line in public_pem.splitlines() if not line.startswith('-----')), validate=True)
            if not public_der:
                raise AgentError('Could not export the OpenConnect server public key.')
            pin = base64.b64encode(hashlib.sha256(public_der).digest()).decode()
            profiles.append(f"OpenConnect\nServer: https://{public}:{inbound['port']}\nUsername: {system_user(email)}\nPassword: {client['password']}\nServer certificate SHA-256: {fingerprint}\nServer public key pin-sha256: {pin}\n")
        elif core == "openssh":
            host_key = (directory / 'ssh_host_ed25519_key.pub').read_text().strip()
            profiles.append('ssh://' + quote(system_user(email), safe='') + ':' + quote(client['password'], safe='') + '@' + public + ':' + str(inbound['port']) + '?' + urlencode({'host_key': host_key}) + '#' + quote(inbound.get('remark', inbound['protocol']) + ' - ' + email))
            profiles.append(f"SSH tunnel\nHost: {public}\nPort: {inbound['port']}\nUsername: {system_user(email)}\nPassword: {client['password']}\nHost key: {(directory / 'ssh_host_ed25519_key.pub').read_text().strip()}\n")
        elif core == "wireguard":
            public_key = run([binary(core), "pubkey"], input_text=settings["privateKey"] + "\n")
            ips = client.get("allowedIPsByInbound", {}).get(str(inbound["id"]), client.get("allowedIPs", []))
            address = ", ".join(ips) if isinstance(ips, list) else ips
            extra = f"PresharedKey = {client['preSharedKey']}\n" if client.get("preSharedKey") else ""
            routes = '0.0.0.0/0' if settings.get('internetAccess', True) else str(ipaddress.ip_network(settings['address'], strict=False))
            query = urlencode({'publickey': public_key, 'address': address, 'presharedkey': client.get('preSharedKey', ''), 'reserved': '0,0,0', 'mtu': settings.get('mtu', 1420), 'keepalive': client.get('keepAlive', 25), 'allowedips': routes})
            profiles.append('wireguard://' + quote(client['privateKey'], safe='') + '@' + public + ':' + str(inbound['port']) + '?' + query + '#' + quote(inbound.get('remark', inbound['protocol']) + ' - ' + email))
            profiles.append(f"[Interface]\nPrivateKey = {client['privateKey']}\nAddress = {address}\nDNS = {settings.get('dns', '1.1.1.1')}\n\n[Peer]\nPublicKey = {public_key}\n{extra}Endpoint = {public}:{inbound['port']}\nAllowedIPs = {routes}\nPersistentKeepalive = {int(client.get('keepAlive', 25))}\n")
    return profiles


LAST_METRICS = None
def status(state):
    global LAST_METRICS
    memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in Path("/proc/meminfo").read_text().splitlines()}
    ticks = [int(v) for v in Path("/proc/stat").read_text().splitlines()[0].split()[1:9]]
    total, idle = sum(ticks), ticks[3] + ticks[4]
    traffic = [line.split(":", 1)[1].split() for line in Path("/proc/net/dev").read_text().splitlines()[2:] if not line.strip().startswith("lo:")]
    recv, sent = sum(int(v[0]) for v in traffic), sum(int(v[8]) for v in traffic)
    now, cpu, up, down = time.monotonic(), 0, 0, 0
    if LAST_METRICS:
        previous_total, previous_idle, previous_sent, previous_recv, previous_time = LAST_METRICS
        cpu = 100 * (1 - (idle - previous_idle) / max(1, total - previous_total))
        elapsed = max(.1, now - previous_time)
        up, down = max(0, sent - previous_sent) / elapsed, max(0, recv - previous_recv) / elapsed
    LAST_METRICS = (total, idle, sent, recv, now)
    disk = shutil.disk_usage(ROOT)
    xray_states = [run(["systemctl", "is-active", unit_name(i)], check=False) for i in state["inbounds"] if core_of(i["protocol"]) == "xray"]
    def count_sockets(name):
        return sum(max(0, len(p.read_text().splitlines()) - 1) for p in [Path(f"/proc/net/{name}"), Path(f"/proc/net/{name}6")] if p.exists())
    return {"cpu": max(0, min(100, cpu)), "cpuCores": os.cpu_count(), "logicalPro": os.cpu_count(), "mem": {"current": memory["MemTotal"] - memory["MemAvailable"], "total": memory["MemTotal"]}, "swap": {"current": memory["SwapTotal"] - memory["SwapFree"], "total": memory["SwapTotal"]}, "disk": {"current": disk.used, "total": disk.total}, "xray": {"state": "running" if "active" in xray_states else "stopped", "version": "Installed" if binary("xray") else "Not installed"}, "netIO": {"up": up, "down": down}, "netTraffic": {"sent": sent, "recv": recv}, "tcpCount": count_sockets("tcp"), "udpCount": count_sockets("udp"), "uptime": int(float(Path("/proc/uptime").read_text().split()[0]))}


def dispatch(path, method, body):
    with LOCK:
        state = load_state()
        if path == '/benx/v1/control/export' and method == 'GET':
            return server_control.export(sys.modules[__name__])
        if path == '/benx/v1/control/status' and method == 'GET':
            return server_control.status(sys.modules[__name__])
        if path == '/benx/v1/control/apply' and method == 'POST':
            return server_control.start(sys.modules[__name__], body)
        if path == '/benx/v1/control/retire' and method == 'POST':
            return server_control.retire(sys.modules[__name__], body)
        if path == "/benx/v1/storefront" and method == "GET":
            return {**state.get("storefront", {}), "healthy": storefront.healthy(sys.modules[__name__], state)}
        if path == "/benx/v1/capabilities" and method == "GET":
            return capabilities(state)
        if path == "/benx/v1/jobs" and method == "GET":
            return copy.deepcopy(JOBS)
        if path == '/benx/v1/setup' and method == 'GET':
            return server_setup.status(sys.modules[__name__])
        if path == '/benx/v1/setup' and method == 'POST':
            return server_setup.start(sys.modules[__name__], body)
        if path == '/benx/v1/installed-panel/request' and method == 'POST':
            return server_setup.panel_request(sys.modules[__name__], body)
        if path == '/panel/api/server/getWebCertFiles' and method == 'GET':
            remembered = server_setup.status(sys.modules[__name__]).get('certificate') or {}
            entries = [entry for entry in remembered.get('entries', []) if entry.get('available')]
            if not entries:
                raise AgentError('Issue certificates through Server setup first. Remembered paths on a replacement may await DNS cutover.', 409)
            return {**entries[0], 'entries': entries}
        tunnel_match = re.fullmatch(r'/benx/v1/tunnels/([a-f0-9-]{36})/(prepare|commit|remove|status|test-start|test-run|test-stop)', path)
        if tunnel_match:
            tunnel_id, action = tunnel_match.groups()
            if method != ('GET' if action == 'status' else 'POST'):
                raise AgentError('Method not allowed.', 405)
            if INSTALLING:
                raise AgentError('Wait for core installation to finish.', 409)
            if action.startswith('test-'):
                return getattr(tunnel_probe, {'test-start': 'start', 'test-run': 'measure', 'test-stop': 'stop'}[action])(sys.modules[__name__], tunnel_id, body) if action != 'test-stop' else tunnel_probe.stop(sys.modules[__name__], tunnel_id)
            return getattr(tunnels, action)(sys.modules[__name__], tunnel_id, body) if action in ['prepare', 'commit'] else getattr(tunnels, action)(sys.modules[__name__], tunnel_id)
        if path == '/benx/v1/accounting' and method == 'GET':
            return accounting.collect(sys.modules[__name__], state)
        if path == '/panel/api/server/scanRealityTarget' and method == 'POST':
            return reality_probe.scan(body)
        if path == '/panel/api/server/scanRealityTargets' and method == 'POST':
            try:
                return reality_probe.discover(body)
            except ValueError as error:
                raise AgentError(str(error)) from None
        if path == '/benx/v1/policy' and method == 'POST':
            accounting.validate(sys.modules[__name__], body)
            previous_policy = accounting.read(sys.modules[__name__], 'policy.json', {'revision': -1})
            if body['revision'] < previous_policy['revision']:
                raise AgentError('A newer policy is already active.', 409)
            if body['revision'] == previous_policy['revision'] and body != previous_policy:
                raise AgentError('Policy revision already used.', 409)
            accounting.collect(sys.modules[__name__], state)
            write_private(ROOT / 'policy.json', json.dumps(body))
            return {'revision': body['revision'], 'synced': True}
        if path == '/panel/api/xray/' and method == 'POST':
            return {'xraySetting': json.dumps(state.get('xray', {'outbounds': [{'protocol': 'freedom', 'tag': 'direct'}], 'routing': {'rules': []}}))}
        if path == '/panel/api/xray/testOutbound' and method == 'POST':
            return test_outbound(object_value(body.get('outbound', {})))
        if path == '/panel/api/xray/update' and method == 'POST':
            payload = object_value(body.get('xraySetting', {}))
            if 'expectedXraySetting' in body and object_value(body['expectedXraySetting']) != state.get('xray', {'outbounds': [{'protocol': 'freedom', 'tag': 'direct'}], 'routing': {'rules': []}}):
                raise AgentError('Xray configuration changed. Refresh before saving.', 409)
            if any(k not in ['outbounds', 'routing', 'dns', 'log', 'observatory', 'burstObservatory'] for k in payload):
                raise AgentError('Native global configuration supports outbounds, routing, DNS, logs and observatories. Manage listeners through Inbounds.')
            if not isinstance(payload.get('outbounds'), list) or not payload['outbounds'] or not isinstance(payload.get('routing', {}), dict):
                raise AgentError('Set outbounds and valid routing.')
            previous = copy.deepcopy(state)
            accounting.collect(sys.modules[__name__], state)
            state['xray'] = payload
            apply_state(state, previous, {i['id'] for i in state['inbounds'] if core_of(i['protocol']) == 'xray'})
            return {'saved': True}
        action_match = re.fullmatch(r"/benx/v1/cores/([a-z0-9-]+)/(install|start|stop|restart)", path)
        if action_match and method == "POST":
            return start_job(*action_match.groups(), state)
        if INSTALLING and method != "GET":
            raise AgentError("Wait for the current server action to finish.", 409)
        if path == "/panel/api/server/status" and method == "GET":
            return status(state)
        if path == "/panel/api/inbounds/list" and method == "GET":
            return inbound_rows(state)
        if path == '/panel/api/clients/list' and method == 'GET':
            ledger = accounting.read(sys.modules[__name__], 'accounting.json', {'usage': {}})
            return [{**copy.deepcopy(c), 'expiryTime': effective_expiry(c), 'traffic': ledger['usage'].get(email, {'up': 0, 'down': 0})} for email, c in state['clients'].items()]
        reset_match = re.fullmatch(r'/panel/api/inbounds/(\d+)/resetTraffic', path)
        if method == 'POST' and (reset_match or path == '/panel/api/inbounds/resetAllTraffics'):
            number = int(reset_match[1]) if reset_match else None
            if number and not any(i['id'] == number for i in state['inbounds']):
                raise AgentError('Inbound not found.', 404)
            ledger = accounting.collect(sys.modules[__name__], state)
            if number:
                ledger.setdefault('inbounds', {}).pop(str(number), None)
            else:
                ledger['inbounds'] = {}
            write_private(ROOT / 'accounting.json', json.dumps(ledger))
            return {'reset': True}
        if path == "/panel/api/clients/onlines" and method == "POST":
            # Native traffic/online accounting is deliberately not fabricated.
            return []
        if path == "/panel/api/server/getNewX25519Cert" and method == "GET":
            if not binary("wireguard"):
                private, public = x25519_keypair()
                return {"privateKey": private, "publicKey": public}
            private = run([binary("wireguard"), "genkey"])
            return {"privateKey": private, "publicKey": run([binary("wireguard"), "pubkey"], input_text=private + "\n")}
        if path == "/panel/api/server/getDb" and method == "GET":
            return copy.deepcopy(state)
        if path in ["/panel/api/server/restartXrayService", "/panel/api/server/stopXrayService"] and method == "POST":
            return start_job("xray", "restart" if "restart" in path else "stop", state)
        if re.fullmatch(r"/panel/api/clients/(get|links)/[^/]+", path) and method == "GET":
            email = unquote(path.rsplit("/", 1)[1])
            if "/links/" in path:
                return client_profiles(state, email)
            client = state["clients"].get(email)
            if not client:
                raise AgentError("Client not found.", 404)
            ledger = accounting.read(sys.modules[__name__], 'accounting.json', {'usage': {}})
            return {**copy.deepcopy(client), 'expiryTime': effective_expiry(client), 'traffic': ledger['usage'].get(email, {'up': 0, 'down': 0})}
        inbound_match = re.fullmatch(r"/panel/api/inbounds/(add|update/\d+|get/\d+|del/\d+|setEnable/\d+)", path)
        previous = copy.deepcopy(state)
        accounting.collect(sys.modules[__name__], state)
        changed = set()
        if inbound_match:
            action = inbound_match[1].split("/")[0]
            number = int(path.rsplit("/", 1)[1]) if action != "add" else state["nextId"]
            existing = next((i for i in state["inbounds"] if i["id"] == number), None)
            if action != "add" and not existing:
                raise AgentError("Inbound not found.", 404)
            if action == "get" and method == "GET":
                return next(i for i in inbound_rows(state) if i["id"] == number)
            if method != "POST":
                raise AgentError("Method not allowed.", 405)
            if action == "del":
                state["inbounds"] = [i for i in state["inbounds"] if i["id"] != number]
                for client in state["clients"].values():
                    client["inboundIds"] = [i for i in client["inboundIds"] if i != number]
            else:
                candidate = {**existing, "enable": bool(body["enable"])} if action == "setEnable" else copy.deepcopy(body)
                candidate["id"] = number
                candidate.pop('_benxApiPort', None)
                if existing and existing.get('_benxApiPort') and core_of(candidate['protocol']) == 'xray':
                    candidate['_benxApiPort'] = existing['_benxApiPort']
                validate_inbound(candidate, state)
                # Client editing is centralized; never overwrite client identities with a stale inbound snapshot.
                incoming_clients = candidate["settings"].pop("clients", [])
                state["inbounds"] = [i for i in state["inbounds"] if i["id"] != number] + [candidate]
                if action == "add":
                    for incoming in incoming_clients:
                        email = incoming.get("email")
                        existing_client = state["clients"].get(email)
                        attached = copy.deepcopy(existing_client or incoming)
                        ids = sorted(set(attached.get("inboundIds", [])) | {number})
                        validate_client(attached, ids, state)
                        state["clients"][attached["email"]] = attached
                        changed.update(ids)
                    state["nextId"] += 1
            changed.add(number)
        elif path.startswith("/panel/api/clients/") and method == "POST":
            direct = re.fullmatch(r"/panel/api/clients/(add|update/[^/]+|del/[^/]+|resetTraffic/[^/]+)", path)
            if "email" not in body and re.fullmatch(r"/panel/api/clients/[^/]+/(attach|detach)", path):
                direct = None
            action = direct[1].split("/")[0] if direct else ""
            email = unquote(path.rsplit("/", 1)[1])
            if action in ["add", "update"]:
                client = copy.deepcopy(body.get("client", body))
                existing = state["clients"].get(email) if action == "update" else None
                if action == "update" and not existing:
                    raise AgentError("Client not found.", 404)
                ids = client.get("inboundIds", existing["inboundIds"] if existing else body.get("inboundIds", []))
                validate_client(client, ids, state)
                if action == "add" and not ids:
                    raise AgentError("Select at least one inbound.")
                if client["email"] in state["clients"] and client["email"] != (email if existing else None):
                    raise AgentError("A client with this name already exists.", 409)
                # SSH / certificate names are derived from identity; renaming creates a new identity.
                if existing:
                    changed.update(existing["inboundIds"])
                    del state["clients"][email]
                state["clients"][client["email"]] = client
                changed.update(ids)
            elif action == 'resetTraffic':
                existing = state['clients'].get(email)
                if not existing:
                    raise AgentError('Client not found.', 404)
                ledger = accounting.read(sys.modules[__name__], 'accounting.json', {'usage': {}, 'raw': {}})
                ledger['usage'].pop(email, None)
                write_private(ROOT / 'accounting.json', json.dumps(ledger))
                existing['_quotaBlocked'] = False
                changed.update(existing['inboundIds'])
            elif action == "del":
                existing = state["clients"].pop(email, None)
                if not existing:
                    raise AgentError("Client not found.", 404)
                changed.update(existing["inboundIds"])
            elif re.fullmatch(r"/panel/api/clients/[^/]+/(attach|detach)", path):
                email = unquote(path.split("/")[4])
                existing = state["clients"].get(email)
                if not existing:
                    raise AgentError("Client not found.", 404)
                ids = body.get("inboundIds", [])
                validate_client(copy.deepcopy(existing), ids, state)
                changed.update(ids)
                existing["inboundIds"] = sorted(set(existing["inboundIds"]) | set(ids)) if path.endswith("/attach") else [i for i in existing["inboundIds"] if i not in ids]
            else:
                raise AgentError("This client operation requires a 3X-UI panel connection.", 501)
        else:
            raise AgentError("This operation requires a 3X-UI panel connection. The native agent manages cores, inbounds and clients.", 501)
        apply_state(state, previous, changed)
        if path.startswith('/panel/api/clients/') and method == 'POST' and action in ['del', 'update']:
            ledger = accounting.read(sys.modules[__name__], 'accounting.json', {'usage': {}, 'raw': {}})
            if action == 'del':
                ledger['usage'].pop(email, None)
            elif email != client['email']:
                ledger['usage'][client['email']] = ledger['usage'].pop(email, {'up': 0, 'down': 0, 'rawUp': 0, 'rawDown': 0})
            write_private(ROOT / 'accounting.json', json.dumps(ledger))
        return {"saved": True, **({'id': number} if inbound_match else {})}


def test_outbound(outbound):
    """Run a disposable core, then perform a fixed HTTPS probe through it."""
    executable = binary('xray')
    if not executable:
        raise AgentError('Install Xray before testing an outbound.', 409)
    if outbound.get('protocol') not in ['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard', 'http', 'socks']:
        raise AgentError('Unsupported outbound protocol.')
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    directory = ROOT / 'probes' / secrets.token_hex(16)
    config = directory / 'probe.json'
    payload = {'log': {'loglevel': 'none'}, 'inbounds': [{'listen': '127.0.0.1', 'port': port, 'protocol': 'http', 'settings': {}}], 'outbounds': [{**outbound, 'tag': 'probe'}]}
    process = None
    try:
        write_private(config, json.dumps(payload))
        run([executable, 'run', '-test', '-config', str(config)])
        process = subprocess.Popen([executable, 'run', '-config', str(config)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(20):
            if process.poll() is not None:
                raise AgentError('Temporary probe core failed to start.', 502)
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=0.1):
                    break
            except OSError:
                time.sleep(0.1)
        started = time.monotonic()
        # ProxyHandler respects no_proxy. Force this fixed public destination through the loopback proxy.
        connection = http.client.HTTPSConnection('127.0.0.1', port, timeout=8)
        try:
            connection.set_tunnel('www.gstatic.com', 443)
            connection.request('GET', '/generate_204')
            response = connection.getresponse()
            status_code = response.status
            response.read(1024)
        finally:
            connection.close()
        if status_code != 204:
            raise AgentError('Outbound probe did not return the expected HTTPS response.', 502)
        return {'delay': round((time.monotonic() - started) * 1000), 'status': status_code}
    except AgentError:
        raise
    except Exception:
        raise AgentError('Outbound HTTPS probe failed. Check the profile and provider account.', 502) from None
    finally:
        if process:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        if directory.exists():
            shutil.rmtree(directory)


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, _format, *_args):
        # Do not record credential-bearing paths, request bodies or export responses.
        pass

    def do_GET(self):
        self.handle_api()

    def do_POST(self):
        self.handle_api()

    def handle_api(self):
        result, status_code = None, 200
        try:
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + TOKEN):
                raise AgentError("Invalid management agent token.", 401)
            if self.headers.get("Transfer-Encoding"):
                raise AgentError("Chunked requests are not accepted.")
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > 1024 * 1024:
                raise AgentError("Request is too large.", 413)
            body = json.loads(self.rfile.read(length)) if length else {}
            if not isinstance(body, dict):
                raise AgentError("Expected a JSON object.")
            path = urlsplit(self.path).path
            if any(unquote(s) in [".", ".."] or re.search(r"[\x00-\x1f\\/]", unquote(s)) for s in path.split("/") if s):
                raise AgentError("Invalid API path.")
            result = {"success": True, "obj": dispatch(path, self.command, body)}
        except AgentError as error:
            status_code, result = error.status, {"success": False, "msg": str(error)}
        except (ValueError, KeyError, TypeError):
            status_code, result = 400, {"success": False, "msg": "Invalid request configuration."}
        except Exception:
            status_code, result = 500, {"success": False, "msg": "Server action failed. Check the agent journal."}
        data = json.dumps(result).encode()
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)


def expiry_loop():
    previous = {}
    while True:
        time.sleep(30)
        try:
            with LOCK:
                if INSTALLING:
                    continue
                state = load_state()
                current = {"i:" + str(i["id"]): active_inbound(i) for i in state["inbounds"]}
                current.update({"c:" + email: eligible(c) for email, c in state["clients"].items()})
                changed = {i["id"] for i in state["inbounds"] if previous.get("i:" + str(i["id"]), True) != current["i:" + str(i["id"])]}
                for email, client in state["clients"].items():
                    if previous.get("c:" + email, True) != current["c:" + email]:
                        changed.update(client["inboundIds"])
                if changed:
                    apply_state(state, copy.deepcopy(state), changed)
                previous = current
        except Exception:
            print("Expiry reconciliation failed; retrying.", flush=True)


def main():
    if len(TOKEN) < 32:
        raise SystemExit("Set BENX_AGENT_TOKEN to a random token of at least 32 characters.")
    if platform.system() != "Linux" or os.geteuid() != 0 or not shutil.which("systemctl"):
        raise SystemExit("The full-access agent requires Linux, root privileges and systemd.")
    ROOT.mkdir(mode=0o700, parents=True, exist_ok=True)
    ROOT.chmod(0o700)
    os.umask(0o077)
    server_setup.startup(sys.modules[__name__])
    server_control.startup(sys.modules[__name__])
    threading.Thread(target=expiry_loop, daemon=True).start()
    threading.Thread(target=accounting.loop, args=(sys.modules[__name__],), daemon=True).start()
    if (ROOT / 'enrollment.json').exists():
        threading.Thread(target=outbound.loop, args=(sys.modules[__name__],), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", int(os.environ.get("BENX_AGENT_PORT", "8095"))), Handler)
    server.timeout = 15
    print("BenX management agent listening on loopback.", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
