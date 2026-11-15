"""Fixed, resumable server setup recipes; no user-provided commands."""
import copy
import base64
import http.client
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import secrets
import shutil
import socket
import subprocess
import sqlite3
from contextlib import closing
import threading
import time
import uuid
import zipfile
import certificates
from urllib.request import Request, urlopen
from urllib.parse import unquote, urlencode

CORES = ['xray', 'openvpn', 'ocserv', 'openssh', 'wireguard', 'masterdnsvpn', 'dnsproxy']
BBR_FILE = Path('/etc/sysctl.d/90-benx-bbr.conf')


def validate(agent, plan):
    if not isinstance(plan, dict) or plan.get('panel') not in ['native', '3x-ui'] or not isinstance(plan.get('cores'), list) or any(c not in CORES for c in plan['cores']) or type(plan.get('bbr')) is not bool:
        raise agent.AgentError('Unsupported setup options.')
    cert = plan.get('certificate')
    if not isinstance(cert, dict) or type(cert.get('enabled')) is not bool:
        raise agent.AgentError('Invalid certificate settings.')
    if cert['enabled']:
        certificates.targets(agent, cert)
    if platform.freedesktop_os_release().get('ID') not in ['debian', 'ubuntu'] or not shutil.which('apt-get'):
        raise agent.AgentError('Automatic setup requires Debian/Ubuntu with apt-get.', 409)
    plan = copy.deepcopy(plan)
    method = plan.get('tunnelMethod', 'none')
    if method not in ['none', 'wireguard', 'ssh-direct', 'ssh-reverse']:
        raise agent.AgentError('Unsupported tunnel preparation method.')
    core = 'wireguard' if method == 'wireguard' else 'openssh' if method != 'none' else None
    if core and core not in plan['cores']:
        plan['cores'].append(core)
    return plan


PACKAGE_LOCK = threading.Lock()


def install_packages(agent, packages):
    with PACKAGE_LOCK:
        return _install_packages(agent, packages)


def _install_packages(agent, packages):
    created = False
    try:
        if not agent.PACKAGE_POLICY.exists():
            with os.fdopen(os.open(agent.PACKAGE_POLICY, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o755), 'w') as file:
                file.write('#!/bin/sh\n# BenX temporary package-install policy\nexit 101\n')
            created = True
        agent.run(['apt-get', 'update'], timeout=600)
        agent.run(['apt-get', 'install', '--yes', '--no-install-recommends', *packages], timeout=900)
    finally:
        if created and agent.PACKAGE_POLICY.read_text() == '#!/bin/sh\n# BenX temporary package-install policy\nexit 101\n':
            agent.PACKAGE_POLICY.unlink()


def install_xray(agent):
    arch = {'amd64': 'x86_64', 'arm64': 'aarch64'}.get(platform.machine().lower(), platform.machine().lower())
    manifest = json.loads((Path(__file__).parent / 'xray-release.json').read_text())
    asset = manifest['assets'].get(arch)
    if not asset or not asset['url'].startswith('https://github.com/XTLS/Xray-core/releases/download/'):
        raise agent.AgentError('No verified Xray build for this architecture.', 409)
    with urlopen(Request(asset['url'], headers={'User-Agent': 'BenX-Agent'}), timeout=120) as response:
        archive = response.read(100 * 1024 * 1024 + 1)
    if len(archive) > 100 * 1024 * 1024 or hashlib.sha256(archive).hexdigest() != asset['sha256']:
        raise agent.AgentError('Xray release checksum verification failed.', 502)
    with zipfile.ZipFile(io.BytesIO(archive)) as files:
        for name in ['xray', 'geoip.dat', 'geosite.dat']:
            info = files.getinfo(name)
            if info.file_size > 150 * 1024 * 1024:
                raise agent.AgentError('Xray release file exceeds the installation limit.')
            destination = Path('/usr/local/bin/xray') if name == 'xray' else Path('/usr/local/share/xray') / name
            destination.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            temporary = destination.with_suffix('.new')
            with os.fdopen(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o755 if name == 'xray' else 0o644), 'wb') as file:
                file.write(files.read(info))
            temporary.replace(destination)
    agent.run(['/usr/local/bin/xray', 'version'])


def install_core(agent, core):
    if core in ['openvpn', 'ocserv', 'wireguard', 'dnsproxy'] and not shutil.which('iptables'):
        install_packages(agent, ['iptables'])
    if agent.binary(core):
        return 'Already installed; existing core retained.'
    if core == 'xray':
        install_xray(agent)
    elif core == 'dnsproxy':
        agent.dns_service.install(agent)
    elif core == 'masterdnsvpn':
        agent.install_masterdns()
    else:
        install_packages(agent, agent.CORES[core]['packages'])
        if core == 'ocserv':
            # A fresh package's default listener is not a BenX inbound. It can
            # start with placeholder certificates and fail after reboot.
            agent.run(['systemctl', 'disable', '--now', 'ocserv.service'])
            agent.run(['systemctl', 'reset-failed', 'ocserv.service'], check=False)
    if not agent.binary(core):
        raise agent.AgentError('Installation finished but the core binary was not found.', 502)
    return 'Installed. Add an inbound to configure the listener.'


def enable_bbr(agent):
    install_packages(agent, ['kmod', 'procps'])
    agent.run(['modprobe', 'tcp_bbr'], check=False)
    available = agent.run(['sysctl', '-n', 'net.ipv4.tcp_available_congestion_control']).split()
    if 'bbr' not in available:
        raise agent.AgentError('This kernel does not support BBR. No sysctl changes were applied.', 409)
    old = {key: agent.run(['sysctl', '-n', key]) for key in ['net.core.default_qdisc', 'net.ipv4.tcp_congestion_control']}
    previous = BBR_FILE.read_text() if BBR_FILE.exists() else None
    try:
        agent.write_private(BBR_FILE, 'net.core.default_qdisc=fq\nnet.ipv4.tcp_congestion_control=bbr\n')
        agent.run(['sysctl', '-p', str(BBR_FILE)])
        if agent.run(['sysctl', '-n', 'net.ipv4.tcp_congestion_control']) != 'bbr':
            raise agent.AgentError('BBR verification failed.', 502)
    except Exception:
        if previous is None:
            BBR_FILE.unlink(missing_ok=True)
        else:
            agent.write_private(BBR_FILE, previous)
        for key, value in old.items():
            agent.run(['sysctl', '-w', f'{key}={value}'], check=False)
        raise
    return 'BBR enabled and verified. No reboot required.'


def certificate(agent, cert):
    return certificates.issue(agent, cert)


def private_panel_bindings(agent, database=Path('/etc/x-ui/x-ui.db')):
    # Only call for the optional panel installed and owned by this agent.
    if not database.is_file():
        raise agent.AgentError('The privately installed panel database is missing.', 409)
    changed = False
    with closing(sqlite3.connect(database, timeout=30)) as connection, connection:
        for key in ['webListen', 'subListen']:
            value = connection.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
            if value and value[0] == '127.0.0.1':
                continue
            result = connection.execute('UPDATE settings SET value=? WHERE key=?', ('127.0.0.1', key))
            if not result.rowcount:
                connection.execute('INSERT INTO settings(key,value) VALUES(?,?)', (key, '127.0.0.1'))
            changed = True
    if changed:
        agent.run(['systemctl', 'restart', 'x-ui'])
    return changed


def install_panel(agent):
    # Never run the upstream update installer over an existing panel/database.
    if Path('/usr/local/x-ui').exists() or Path('/etc/x-ui/x-ui.db').exists():
        raise agent.AgentError('3X-UI already exists. Connect it through Panel access; its files were left untouched.', 409)
    manifest = json.loads((Path(__file__).parent / '3x-ui-release.json').read_text())
    script = Path(__file__).parent / '3x-ui-install.sh'
    if hashlib.sha256(script.read_bytes()).hexdigest() != manifest['installerSha256']:
        raise agent.AgentError('Pinned 3X-UI installer verification failed.', 502)
    # The upstream noninteractive installer verifies its pinned release archive too.
    # Keep the optional panel local; its generated credentials stay in its root-only result file.
    environment = {**os.environ, 'DEBIAN_FRONTEND': 'noninteractive', 'XUI_NONINTERACTIVE': '1', 'XUI_SSL_MODE': 'none', 'XUI_PANEL_PORT': '2053', 'XUI_USERNAME': 'benx-admin', 'XUI_PASSWORD': secrets.token_urlsafe(24), 'XUI_WEB_BASE_PATH': secrets.token_hex(12), 'XUI_DB_TYPE': 'sqlite', 'XUI_SERVER_IP': '127.0.0.1'}
    with socket.socket() as probe:
        try:
            probe.bind(('0.0.0.0', 2053))
        except OSError:
            raise agent.AgentError('Port 2053 is occupied. Existing services were left untouched.', 409) from None
    original = script.read_text(encoding='utf-8')
    if original.count('bind_local="n"') != 1:
        raise agent.AgentError('Pinned 3X-UI installer layout changed; review required.', 409)
    # Override the upstream noninteractive default before the new panel starts.
    private_installer = agent.ROOT / '3x-ui-install-private.sh'
    agent.write_private(private_installer, original.replace('bind_local="n"', 'bind_local="y"'))
    try:
        result = subprocess.run(['/bin/bash', str(private_installer), manifest['version']], input='', capture_output=True, text=True, timeout=1800, env=environment)
    finally:
        private_installer.unlink(missing_ok=True)
    if result.returncode:
        raise agent.AgentError('3X-UI installation failed. Check local installation state before retrying.', 502)
    # Bind the additional Linux panel to loopback; the BenX agent remains the full-access control plane.
    agent.run(['/usr/local/x-ui/x-ui', 'setting', '-listenIP', '127.0.0.1'])
    private_panel_bindings(agent)
    agent.run(['systemctl', 'restart', 'x-ui'])
    output = agent.run(['/usr/local/x-ui/x-ui', 'setting', '-getApiToken'])
    token = re.search(r'apiToken:\s*([^\s]+)', output)
    if not token:
        raise agent.AgentError('3X-UI installed but its API token could not be read. Check its local configuration.', 502)
    agent.write_private(agent.ROOT / 'installed-panel.json', json.dumps({'basePath': '/' + environment['XUI_WEB_BASE_PATH'].strip('/') + '/', 'token': token[1]}))
    return '3X-UI installed privately. Its managed panel workspace is available in the server picker; its clients are separate from BenX native clients.'


def panel_request(agent, body):
    file = agent.ROOT / 'installed-panel.json'
    if not file.is_file():
        raise agent.AgentError('No privately installed 3X-UI API is available.', 404)
    if not isinstance(body, dict) or body.get('method') not in ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'] or not isinstance(body.get('path'), str):
        raise agent.AgentError('Invalid panel request.')
    path, method = body['path'], body['method']
    parts = path.split('/')
    if not path.startswith('/panel/api/') or len(path) > 2048 or any(s in ['.', '..'] or any(c in unquote(s) for c in ['/', '\\', '?', '#']) or re.search(r'%[0-9a-fA-F]{2}', unquote(s)) or any(ord(c) < 32 for c in unquote(s)) for s in parts):
        raise agent.AgentError('Invalid private panel API path.')
    operations = json.loads((Path(__file__).parent / 'panel-operations.json').read_text())
    allowed = False
    for op in operations:
        pattern = ''.join('[^/]+' if item.startswith('{') else re.escape(item) for item in re.split(r'(\{[^}]+\})', op['path']))
        if op['method'] == method and re.fullmatch(pattern, path):
            allowed = True
            break
    if not allowed:
        raise agent.AgentError('Unsupported private panel operation.')
    query = body.get('query', {})
    data = body.get('body', {})
    if not isinstance(query, dict) or len(query) > 30 or any(not isinstance(k, str) or not isinstance(v, str) or len(k) > 100 or len(v) > 2048 for k, v in query.items()) or not isinstance(data, dict):
        raise agent.AgentError('Invalid private panel request values.')
    settings = json.loads(file.read_text())
    if not re.fullmatch(r'/[a-zA-Z0-9]+/', settings['basePath']) or not re.fullmatch(r'[^\s\r\n]+', settings['token']):
        raise agent.AgentError('Invalid private panel credentials.')
    target = settings['basePath'].rstrip('/') + path + ('?' + urlencode(query) if query else '')
    form = body.get('encoding') == 'application/x-www-form-urlencoded'
    pairs = []
    for key, value in data.items():
        if path.startswith('/panel/api/sub-balancers') and key == 'inboundIds' and isinstance(value, list):
            pairs.extend((key, str(item)) for item in value)
        else:
            pairs.append((key, json.dumps(value) if isinstance(value, (dict, list)) else str(value)))
    payload = None if method == 'GET' else urlencode(pairs) if form else json.dumps(data)
    connection = http.client.HTTPConnection('127.0.0.1', 2053, timeout=15)
    try:
        connection.request(method, target, body=payload, headers={'Authorization': 'Bearer ' + settings['token'], 'Content-Type': 'application/x-www-form-urlencoded' if form else 'application/json', 'Accept': 'application/json'})
        response = connection.getresponse()
        content = response.read(2 * 1024 * 1024 + 1)
        if len(content) > 2 * 1024 * 1024:
            raise agent.AgentError('Private panel response exceeds the 2 MB bridge limit.', 502)
        if 300 <= response.status < 400:
            raise agent.AgentError('Private panel redirected the API request. Check its configured base path.', 502)
        return {'status': response.status, 'contentType': response.getheader('Content-Type', 'application/json'), 'disposition': response.getheader('Content-Disposition', ''), 'body': base64.b64encode(content).decode()}
    except (OSError, http.client.HTTPException):
        raise agent.AgentError('The private 3X-UI API is unreachable.', 502) from None
    finally:
        connection.close()


def status(agent):
    file = agent.ROOT / 'setup-status.json'
    job = json.loads(file.read_text()) if file.exists() else None
    return {'job': job, 'plan': json.loads((agent.ROOT / 'setup-plan.json').read_text()) if (agent.ROOT / 'setup-plan.json').exists() else None, 'certificate': certificates.remembered(agent), 'bbr': agent.run(['sysctl', '-n', 'net.ipv4.tcp_congestion_control'], check=False) == 'bbr', 'panelInstalled': Path('/usr/local/x-ui/x-ui').is_file(), 'panelReady': (agent.ROOT / 'installed-panel.json').is_file()}


def start(agent, raw_plan):
    plan = validate(agent, raw_plan)
    if agent.INSTALLING:
        raise agent.AgentError('Wait for the current server action to finish.', 409)
    steps = [{'id': f'core:{c}', 'label': f'Install {c}', 'state': 'queued', 'message': ''} for c in dict.fromkeys(plan['cores'])]
    if plan['panel'] == '3x-ui':
        steps.append({'id': 'panel', 'label': 'Install 3X-UI', 'state': 'queued', 'message': ''})
    if plan['bbr']:
        steps.append({'id': 'bbr', 'label': 'Enable BBR', 'state': 'queued', 'message': ''})
    if plan['certificate']['enabled']:
        steps.append({'id': 'certificate', 'label': 'Issue domain/IP certificates', 'state': 'queued', 'message': ''})
    job = {'id': str(uuid.uuid4()), 'core': 'server-setup', 'action': 'configure', 'state': 'queued', 'steps': steps, 'message': 'Preparing your server choices.', 'createdAt': int(time.time() * 1000)}
    agent.INSTALLING = True
    agent.JOBS.insert(0, job)

    def save():
        with agent.LOCK:
            agent.write_private(agent.ROOT / 'setup-status.json', json.dumps(job))

    save()
    agent.write_private(agent.ROOT / 'setup-plan.json', json.dumps(plan))

    def execute():
        try:
            job.update(state='running')
            save()
            for step in steps:
                step.update(state='running', message='Applying this option.')
                job['message'] = step['label']
                save()
                try:
                    message = install_core(agent, step['id'][5:]) if step['id'].startswith('core:') else install_panel(agent) if step['id'] == 'panel' else enable_bbr(agent) if step['id'] == 'bbr' else certificate(agent, plan['certificate'])
                    step.update(state='succeeded', message=message)
                except Exception as error:
                    step.update(state='failed', message=str(error) if isinstance(error, agent.AgentError) else 'This option failed. Check the private agent journal and retry.')
                save()
            failed = any(step['state'] == 'failed' for step in steps)
            job.update(state='failed' if failed else 'succeeded', message='Server connected. Some options need attention; review the steps and retry those options.' if failed else 'Server setup complete. You can add more features at any time.')
            save()
        finally:
            agent.INSTALLING = False

    threading.Thread(target=execute, daemon=True).start()
    return copy.deepcopy(job)


def startup(agent):
    file = agent.ROOT / 'setup-status.json'
    if file.exists():
        old = json.loads(file.read_text())
        if old['state'] in ['queued', 'running']:
            old.update(state='failed', message='The agent restarted during setup. Completed options are retained; retry the remaining choices.')
            for step in old.get('steps', []):
                if step['state'] in ['queued', 'running']:
                    step.update(state='failed', message='Interrupted by agent restart.')
            agent.write_private(file, json.dumps(old))
        agent.JOBS.insert(0, old)
    initial = agent.ROOT / 'initial-setup.json'
    if initial.exists():
        plan = json.loads(initial.read_text())
        initial.rename(agent.ROOT / 'initial-setup.applied.json')
        start(agent, plan)
