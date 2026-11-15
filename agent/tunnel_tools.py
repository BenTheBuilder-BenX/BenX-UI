"""Verified, pinned tunnel engines. Downloads happen in a background job."""
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import shutil
import tarfile
import threading
from urllib.request import Request, urlopen

LOCK = threading.Lock()
RUNNING = set()


def engine(method):
    return 'iproute2' if method in ['gre', 'ipip'] else 'wireguard' if method == 'wireguard' else 'openssh' if method.startswith('ssh-') else 'frp' if method.startswith('frp-') else 'hysteria' if method == 'phormal-relay' else 'backhaul' if method.startswith('backhaul-') else 'hedioum' if method == 'hedioum' else None


def binary(agent, method, role):
    kind = engine(method)
    name = ('frpc' if role == 'source' else 'frps') if kind == 'frp' else kind
    return agent.ROOT / 'tunnel-tools' / str(kind) / str(name)


def ready(agent, method):
    if method in ['gre', 'ipip']:
        return bool(shutil.which('ip'))
    if method == 'wireguard':
        return bool(agent.binary('wireguard') and shutil.which('wg-quick'))
    if method.startswith('ssh-'):
        return bool(agent.binary('openssh') and shutil.which('ssh') and shutil.which('ssh-keygen'))
    return all(binary(agent, method, role).is_file() for role in ['source', 'target'])


def install(agent, method):
    kind = engine(method)
    if kind == 'iproute2':
        agent.server_setup.install_packages(agent, ['iproute2'])
        return
    if kind in ['wireguard', 'openssh']:
        agent.server_setup.install_core(agent, kind)
        return
    manifest = json.loads((Path(__file__).parent / 'tunnel-releases.json').read_text())[kind]
    arch = {'x86_64': 'amd64', 'aarch64': 'arm64'}.get(platform.machine().lower())
    if not arch:
        raise agent.AgentError('Tunnel engines support x86-64 and ARM64.', 409)
    asset = manifest['assets'][arch]
    if not asset['url'].startswith('https://github.com/') or '/releases/download/' not in asset['url']:
        raise agent.AgentError('Invalid pinned tunnel release.')
    with urlopen(Request(asset['url'], headers={'User-Agent': 'BenX-Agent'}), timeout=90) as response:
        data = response.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != asset['sha256']:
        raise agent.AgentError('Tunnel engine checksum verification failed.', 502)
    directory = agent.ROOT / 'tunnel-tools' / kind
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    if kind in ['frp', 'backhaul']:
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            for name in (['frpc', 'frps'] if kind=='frp' else ['backhaul']):
                info = next(i for i in archive.getmembers() if Path(i.name).name==name and i.isfile())
                if info.size > 100 * 1024 * 1024:
                    raise agent.AgentError('Tunnel engine is too large.')
                contents = archive.extractfile(info).read()
                temporary = directory / (name + '.new')
                temporary.write_bytes(contents); temporary.chmod(0o700); temporary.replace(directory / name)
    else:
        temporary = directory / (kind + '.new')
        temporary.write_bytes(data); temporary.chmod(0o700); temporary.replace(directory / kind)
    agent.write_private(directory / 'release.json', json.dumps({'version': manifest['version'], 'sha256': asset['sha256']}))


def ensure(agent, method):
    if engine(method) is None or ready(agent, method):
        return True
    kind = engine(method)
    with LOCK:
        if kind not in RUNNING:
            RUNNING.add(kind)
            def execute():
                job = agent.ROOT / ('tunnel-install-' + kind + '.json')
                agent.write_private(job, json.dumps({'state': 'running'}))
                try:
                    install(agent, method)
                    agent.write_private(job, json.dumps({'state': 'succeeded'}))
                except Exception:
                    agent.write_private(job, json.dumps({'state': 'failed', 'message': 'Pinned tunnel engine installation failed. Check GitHub reachability and the local agent journal.'}))
                finally:
                    with LOCK:
                        RUNNING.discard(kind)
            threading.Thread(target=execute, daemon=True).start()
    return False
