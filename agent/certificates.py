"""Domain and short-lived IP ACME certificates with owned renewal service."""
import hashlib
import ipaddress
import json
import re
import shlex
import shutil
import socket
from pathlib import Path


def targets(agent, cert):
    mode = cert.get('target', 'domain')
    if mode not in ['domain', 'ip', 'both']:
        raise agent.AgentError('Choose domain, IP or both for certificates.')
    result = []
    if mode != 'ip':
        domain = cert.get('domain', '')
        if not isinstance(domain, str) or not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', domain):
            raise agent.AgentError('Enter a valid certificate domain.')
        domains = cert.get('domains', [])
        if not isinstance(domains, list) or len(domains) > 20 or any(not isinstance(n,str) for n in domains):
            raise agent.AgentError('Enter up to 20 certificate domains.')
        for name in dict.fromkeys([domain, *domains]):
            if not isinstance(name, str) or not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', name):
                raise agent.AgentError('Enter valid certificate domains.')
            result.append(('domain', name))
    if mode != 'domain':
        try:
            ip = ipaddress.ip_address(cert.get('ip', ''))
            if not ip.is_global:
                raise ValueError()
        except ValueError:
            raise agent.AgentError('IP certificates need a public IPv4 or IPv6 address owned by this VPS.') from None
        result.append(('ip', str(ip)))
    if not isinstance(cert.get('email'), str) or len(cert['email']) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', cert['email']):
        raise agent.AgentError('Enter a valid certificate renewal email.')
    return result


def current(agent, cert):
    file = agent.ROOT / 'certificate.json'
    if not file.exists():
        return False
    saved = json.loads(file.read_text())
    expected = targets(agent, cert)
    entries = saved.get('entries', [saved])
    return all(any(e.get('identifier', e.get('domain')) == identifier and Path(e.get('certificateFile', '')).is_file() and Path(e.get('keyFile', '')).is_file() for e in entries) for _, identifier in expected)


def owned_certificate_path(agent, value, field):
    if not isinstance(value,str):return False
    filename='fullchain.pem' if field=='certificateFile' else 'privkey.pem'
    path=Path(value)
    if re.fullmatch(r'/etc/letsencrypt/live/benx-(?:domain|ip)-[a-f0-9]{16}/'+re.escape(filename),path.as_posix()):return True
    try:
        relative=path.relative_to(agent.ROOT).as_posix()
        return bool(re.fullmatch(r'certificates/[a-f0-9]{32}/'+re.escape(filename),relative)) and not path.is_symlink()
    except ValueError:return False


def remembered(agent):
    entries = {}
    for name in ['certificate-paths.json', 'certificate.json']:
        file = agent.ROOT / name
        if not file.exists():
            continue
        saved = json.loads(file.read_text())
        for entry in saved.get('entries', [saved]):
            if isinstance(entry, dict) and entry.get('certificateFile') and entry.get('keyFile'):
                available = all(owned_certificate_path(agent,entry[f],f) and Path(entry[f]).is_file() for f in ['certificateFile','keyFile'])
                metadata = {}
                if available:
                    raw = agent.run(['openssl', 'x509', '-in', entry['certificateFile'], '-noout', '-enddate', '-issuer', '-ext', 'subjectAltName'], check=False)
                    metadata = {'expires': next((l.split('=', 1)[1] for l in raw.splitlines() if l.startswith('notAfter=')), ''), 'issuer': next((l.split('=', 1)[1] for l in raw.splitlines() if l.startswith('issuer=')), ''), 'names': [v.strip() for l in raw.splitlines() if 'DNS:' in l or 'IP Address:' in l for v in l.split(',')]}
                entries[entry.get('identifier', entry.get('domain'))] = {**entry, 'available': available, **metadata}
    values = list(entries.values())
    if not values:
        return None
    primary = next((e for e in values if e['available']), values[0])
    return {**primary, 'entries': values}


def issue(agent, cert):
    requested = targets(agent, cert)
    try:
        for kind, identifier in requested:
            if kind == 'domain':
                socket.getaddrinfo(identifier, 80)
        with socket.socket() as probe:
            probe.bind(('0.0.0.0', 80))
    except OSError:
        raise agent.AgentError('Domain DNS must resolve and port 80 must be free. Point DNS at this VPS, allow port 80, then retry.', 409) from None
    agent.server_setup.install_packages(agent, ['certbot', 'python3-venv'])
    executable = shutil.which('certbot') or '/usr/bin/certbot'
    if any(kind == 'ip' for kind, _ in requested):
        # Older Debian/Ubuntu packages cannot request IP certificates. An owned venv
        # avoids replacing the system Python or Certbot installation.
        if '--ip-address' not in agent.run([executable, '--help', 'all']):
            venv = agent.ROOT / 'certbot-venv'
            agent.run(['python3', '-m', 'venv', str(venv)], timeout=180)
            agent.run([str(venv / 'bin/pip'), 'install', 'certbot==5.3.0'], timeout=600)
            executable = str(venv / 'bin/certbot')
    hook = renewal_hook(agent)
    system_renewal_compatibility(agent, executable)
    file = agent.ROOT / 'certificate.json'
    saved = json.loads(file.read_text()) if file.exists() else {}
    entries = saved.get('entries', [saved] if saved else [])
    for kind, identifier in requested:
        cert_name = 'benx-' + kind + '-' + hashlib.sha256(identifier.encode()).hexdigest()[:16]
        args = [executable, 'certonly', '--standalone', '--non-interactive', '--agree-tos', '--email', cert['email'], '--cert-name', cert_name, '--keep-until-expiring', '--deploy-hook', str(hook)]
        args += ['--ip-address', identifier, '--required-profile', 'shortlived'] if kind == 'ip' else ['--domain', identifier]
        agent.run(args, timeout=600)
        entry = {'kind': kind, 'identifier': identifier, 'domain': identifier, 'certName': cert_name, 'certificateFile': f'/etc/letsencrypt/live/{cert_name}/fullchain.pem', 'keyFile': f'/etc/letsencrypt/live/{cert_name}/privkey.pem'}
        if not Path(entry['certificateFile']).is_file() or not Path(entry['keyFile']).is_file():
            raise agent.AgentError('Certificate issuance did not produce the expected files.', 502)
        entries = [e for e in entries if e.get('identifier', e.get('domain')) != identifier] + [entry]
        # Persist each result so a second issuance failure does not lose the first.
        primary = next((e for e in entries if e.get('identifier') == requested[0][1]), entry)
        agent.write_private(file, json.dumps({**primary, 'entries': entries, 'request': cert}))
    unit = 'benx-certificate-renew.service'
    renewal = agent.ROOT / 'renew-certificates.py'
    agent.write_private(renewal, 'import json,re,subprocess,sys\nfrom pathlib import Path\nentries=json.loads(Path(sys.argv[2]).read_text()).get("entries",[])\nfailed=False\nfor entry in entries:\n name=entry.get("certName", "")\n if not re.fullmatch(r"benx-(domain|ip)-[a-f0-9]{16}",name): continue\n result=subprocess.run([sys.argv[1],"renew","--cert-name",name,"--quiet","--deploy-hook",sys.argv[3]])\n failed=failed or result.returncode!=0\nsys.exit(1 if failed else 0)\n')
    agent.write_private(agent.UNITS_DIR / unit, agent.unit_text(['python3', str(renewal), executable, str(file), str(hook)]).replace('Type=simple', 'Type=oneshot').replace('Restart=on-failure\nRestartSec=3\n', ''))
    agent.write_private(agent.UNITS_DIR / 'benx-certificate-renew.timer', '[Unit]\nDescription=Renew BenX domain and IP certificates\n[Timer]\nOnCalendar=*-*-* 00,06,12,18:00:00\nRandomizedDelaySec=1800\nPersistent=true\n[Install]\nWantedBy=timers.target\n')
    agent.run(['systemctl', 'daemon-reload'])
    agent.run(['systemctl', 'enable', '--now', 'benx-certificate-renew.timer'])
    return 'Certificates issued and paths saved. Automatic renewal runs four times daily, including short-lived IP certificates.'


def renewal_hook(agent):
    script = Path(__file__).parent / 'dns_service.py'
    hook = agent.ROOT / 'renew-benx-cert'
    agent.write_private(hook, f'#!/bin/sh\nset -eu\nfor config in {agent.ROOT}/listeners/*/dns-access.json; do\n [ -f \"$config\" ] || continue\n /usr/bin/python3 {script} refresh \"$config\"\ndone\nfor unit in /etc/systemd/system/benx-xray-*.service /etc/systemd/system/benx-ocserv-*.service /etc/systemd/system/benx-dnsproxy-*.service; do\n [ -f "$unit" ] || continue\n systemctl try-restart "$(basename "$unit")"\ndone\nif systemctl is-active --quiet benx-storefront.service; then systemctl reload benx-storefront.service; fi\n')
    hook.chmod(0o700)
    return hook


def system_renewal_compatibility(agent, executable):
    """Keep a stock distro renewal timer compatible with IP certificates."""
    if executable != str(agent.ROOT / 'certbot-venv/bin/certbot'):
        return False
    unit = agent.run(['systemctl', 'cat', 'certbot.service'], check=False)
    starts = re.findall(r'^ExecStart=(.*)$', unit, re.MULTILINE)
    if len(starts) != 1:
        return False  # Preserve custom services/drop-ins.
    args = shlex.split(starts[0])
    if not args or args[0] != '/usr/bin/certbot' or 'renew' not in args or any(a not in ['-q', 'renew', '--no-random-sleep-on-renew'] for a in args[1:]):
        return False
    path = agent.UNITS_DIR / 'certbot.service.d/20-benx-ip-compat.conf'
    path.parent.mkdir(parents=True, exist_ok=True)
    agent.write_private(path, '[Service]\nExecStart=\nExecStart="' + executable + '" ' + ' '.join(args[1:]) + '\n')
    agent.run(['systemctl', 'daemon-reload'])
    return True
