"""Durable desired-state jobs. Fixed adapters; no arbitrary shell/file writes."""
import base64
import copy
import json
import hashlib
import ipaddress
import re
import threading
import time
from pathlib import Path


def read(agent, name, default):
    file = agent.ROOT / name
    return json.loads(file.read_text()) if file.exists() else copy.deepcopy(default)


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items() if k not in ['up', 'down', 'traffic', 'clientStats', '_benxApiPort', '_quotaBlocked', '_firstUse', 'createdAt', 'updatedAt', 'lastOnline']}
    if isinstance(value, list):
        return [clean(v) for v in value]
    return value


def asset_path(agent, name):
    if not re.fullmatch(r'(?:certificates/[a-f0-9]{32}/(?:fullchain|privkey)\.pem|listeners/[1-9]\d{0,8}/(?:pki/[a-zA-Z0-9_-]{1,100}\.(?:crt|key|pem)|dns-encryption-key\.txt|ssh_host_ed25519_key(?:\.pub)?))', name):
        raise agent.AgentError('Profile contains an unsupported credential file.')
    path = agent.ROOT / name
    root = agent.ROOT.resolve()
    if not path.resolve().is_relative_to(root) or path.is_symlink() or any(p.is_symlink() for p in path.parents if p != root):
        raise agent.AgentError('Credential files cannot follow symlinks.')
    return path


def export(agent):
    state = agent.load_state()
    assets = {}
    for inbound in state['inbounds']:
        directory = agent.ROOT / 'listeners' / str(inbound['id'])
        for file in directory.rglob('*') if directory.exists() else []:
            if not file.is_file():
                continue
            name = file.relative_to(agent.ROOT).as_posix()
            try:
                asset_path(agent, name)
            except agent.AgentError:
                continue
            if file.stat().st_size > 65536:
                raise agent.AgentError('Credential file exceeds the profile limit.', 413)
            assets[name] = base64.b64encode(file.read_bytes()).decode()
    plan = read(agent, 'setup-plan.json', {'panel': 'native', 'cores': [], 'bbr': False, 'certificate': {'enabled': False, 'domain': '', 'email': ''}, 'tunnelMethod': 'none'})
    plan['cores'] = sorted(set(plan['cores']) | {c for c in agent.CORES if agent.binary(c) and (agent.CORES[c]['packages'] or c in ['xray', 'masterdnsvpn', 'dnsproxy'])})
    # Embed Xray TLS material, rather than accepting arbitrary destination file writes.
    for inbound in state['inbounds']:
        for cert in agent.object_value(inbound.get('streamSettings', {})).get('tlsSettings', {}).get('certificates', []):
            for content_key, file_key in [('certificate', 'certificateFile'), ('key', 'keyFile')]:
                file = cert.get(file_key)
                if file and Path(file).is_file():
                    contents = Path(file).read_text()
                    if len(contents) > 65536:
                        raise agent.AgentError('TLS file exceeds the profile limit.', 413)
                    cert[content_key] = contents.splitlines()
                    cert.pop(file_key, None)
    certificate_files = agent.server_setup.certificates.remembered(agent) or {}
    copied_entries=[]
    for entry in certificate_files.get('entries', []):
        updated=dict(entry)
        for field,filename in [('certificateFile','fullchain.pem'),('keyFile','privkey.pem')]:
            source=Path(entry.get(field,''))
            if not agent.server_setup.certificates.owned_certificate_path(agent,str(source),field) or not source.is_file():continue
            name='certificates/'+hashlib.sha256(str(entry.get('identifier',entry.get('domain',''))).encode()).hexdigest()[:32]+'/'+filename
            asset_path(agent,name)
            if source.stat().st_size>65536:raise agent.AgentError('Certificate exceeds the profile limit.',413)
            assets[name]=base64.b64encode(source.read_bytes()).decode()
            updated[field]=str(agent.ROOT/name)
        copied_entries.append(updated)
    if copied_entries:certificate_files={**copied_entries[0],'entries':copied_entries}
    ledger = agent.accounting.read(agent, 'accounting.json', {'usage': {}, 'inbounds': {}})
    document = {'format': 1, 'mode': 'native', 'state': state, 'policy': read(agent, 'policy.json', {'revision': 0, 'services': [], 'inboundMultipliers': {}, 'clients': {}, 'subscriptions': {}}), 'setup': plan, 'coreEnabled': state.get('coreEnabled', {}), 'assets': assets, 'runtime': {'usage': ledger.get('usage', {}), 'inbounds': ledger.get('inbounds', {}), 'firstUse': ledger.get('firstUse', {}), 'certificateFiles': certificate_files, 'certificateRenewalPending': read(agent, 'certificate-renewal-pending.json', False)}, 'settings': {}, 'nodes': [], 'hosts': read(agent, 'advertised-hosts.json', [])}
    document['state'].setdefault('xray', {'outbounds': [{'protocol': 'freedom', 'tag': 'direct'}], 'routing': {'rules': []}})
    if len(json.dumps(document).encode()) > 700000:
        raise agent.AgentError('Server profile exceeds the encrypted storage limit.', 413)
    return document


def status(agent):
    marker = read(agent, 'control-marker.json', {})
    job = read(agent, 'control-job.json', {})
    drift = False
    if job.get('state') == 'succeeded':
        applied = read(agent, 'control-applied.json', {})
        current = export(agent)
        drift = clean(current['state']) != clean(applied.get('state')) or current['policy'] != applied.get('policy')
        if not drift:
            drift = not agent.storefront.healthy(agent, agent.load_state())
        if not drift:
            drift = material(agent) != read(agent, 'control-material.json', {})
        if not drift:
            state = agent.load_state()
            for inbound in state['inbounds']:
                running = agent.run(['systemctl', 'is-active', agent.unit_name(inbound)], check=False) == 'active'
                enabled = agent.run(['systemctl', 'is-enabled', agent.unit_name(inbound)], check=False) == 'enabled'
                wanted = agent.should_run(inbound, state)
                if running != wanted or enabled != wanted:
                    drift = True
                    break
                if wanted and inbound['protocol'] == 'dns-resolver' and not agent.dns_service.healthy(inbound):
                    drift = True
                    break
                if wanted and inbound['protocol'] in ['openvpn', 'openconnect', 'wireguard-native']:
                    settings = inbound.get('settings', {})
                    if settings.get('internetAccess', True):
                        subnet = str(ipaddress.IPv4Interface(settings.get('address', '10.82.0.1/24')).network) if inbound['protocol'] == 'wireguard-native' else settings.get('subnet', '10.80.0.0/24' if inbound['protocol'] == 'openvpn' else '10.81.0.0/24')
                        if not agent.vpn_network.healthy(inbound['id'], subnet, agent.ROOT):
                            drift = True
                            break
        if not drift and applied.get('setup', {}).get('bbr'):
            drift = agent.run(['sysctl', '-n', 'net.ipv4.tcp_congestion_control'], check=False) != 'bbr'
    return {**marker, 'job': job, 'drift': drift}


def material(agent):
    fingerprints = {}
    for inbound in agent.load_state()['inbounds']:
        directory = agent.ROOT / 'listeners' / str(inbound['id'])
        files = [p for p in directory.rglob('*') if p.is_file() and p.suffix not in ['.log', '.pid', '.sock']] if directory.exists() else []
        unit = agent.UNITS_DIR / agent.unit_name(inbound)
        if unit.exists():
            files.append(unit)
        for file in files:
            fingerprints[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
    directory = agent.ROOT / 'storefront'
    for file in [directory / 'nginx.conf', directory / 'www' / 'index.html', agent.UNITS_DIR / agent.storefront.UNIT]:
        if file.is_file(): fingerprints[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
    return fingerprints


def same_intent(original, candidate, applied):
    expected = copy.deepcopy(original)
    # Checkpoints may fill keys generated by the agent, but cannot alter existing credentials.
    actual_rows = {i['id']: i for i in applied.get('state', {}).get('inbounds', [])}
    for row in expected['state']['inbounds']:
        actual = actual_rows.get(row['id'], {})
        settings = row.setdefault('settings', {})
        if not settings.get('privateKey') and actual.get('settings', {}).get('privateKey'):
            settings['privateKey'] = actual['settings']['privateKey']
        tls = row.get('streamSettings', {}).get('tlsSettings', {})
        actual_tls = actual.get('streamSettings', {}).get('tlsSettings', {})
        if any(c.get('certificateFile') or c.get('keyFile') for c in tls.get('certificates', [])) and actual_tls.get('certificates'):
            tls['certificates'] = actual_tls['certificates']
    for email, client in expected['state']['clients'].items():
        actual = applied.get('state', {}).get('clients', {}).get(email, {})
        for field in ['privateKey', 'publicKey']:
            if not client.get(field) and actual.get(field):
                client[field] = actual[field]
    # Either the original input or the verified generated-material checkpoint is valid for this revision.
    if clean(candidate['state']) not in [clean(original['state']), clean(expected['state'])]:
        return False
    if candidate.get('assets') not in [original.get('assets'), applied.get('assets')]:
        return False
    return all(candidate.get(k) == original.get(k) for k in ['policy', 'setup', 'coreEnabled', 'settings', 'nodes', 'hosts'])


def validate(agent, body):
    if not isinstance(body, dict) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', str(body.get('serverId', ''))) or type(body.get('revision')) is not int or body['revision'] < 1:
        raise agent.AgentError('Invalid logical server identity or configuration revision.')
    document = copy.deepcopy(body.get('document'))
    if not isinstance(document, dict) or document.get('format') != 1 or document.get('mode') != 'native':
        raise agent.AgentError('This agent requires a native BenX profile.')
    state = document.get('state')
    if not isinstance(state, dict) or not isinstance(state.get('inbounds'), list) or len(state['inbounds']) > 1000 or not isinstance(state.get('clients'), dict) or len(state['clients']) > 10000:
        raise agent.AgentError('Invalid desired listeners or clients.')
    ids = [i.get('id') for i in state['inbounds']]
    if any(type(i) is not int or not 1 <= i <= 999999999 for i in ids) or len(ids) != len(set(ids)) or type(state.get('nextId')) is not int or state['nextId'] <= max([0, *ids]):
        raise agent.AgentError('Invalid or duplicate inbound IDs.')
    plan = agent.server_setup.validate(agent, document.get('setup'))
    plan['cores'] = sorted(set(plan['cores']) | {agent.core_of(i.get('protocol')) for i in state['inbounds']})
    agent.accounting.validate(agent, document.get('policy'))
    if not isinstance(document.get('coreEnabled'), dict) or any(c not in agent.CORES or type(v) is not bool for c, v in document['coreEnabled'].items()):
        raise agent.AgentError('Invalid desired core states.')
    if not isinstance(document.get('assets'), dict) or len(document['assets']) > 10000:
        raise agent.AgentError('Invalid credential bundle.')
    for name, content in document['assets'].items():
        asset_path(agent, name)
        try:
            data = base64.b64decode(content, validate=True)
            if len(data) > 65536:
                raise ValueError()
            data.decode('utf8')
        except (ValueError, TypeError, UnicodeError):
            raise agent.AgentError('Invalid encoded credential file.') from None
    if any(k not in ['outbounds', 'routing', 'dns', 'log', 'observatory', 'burstObservatory'] for k in state.get('xray', {})):
        raise agent.AgentError('This native Xray adapter cannot restore these global options.')
    document['setup'] = plan
    return document


def start(agent, body):
    if (agent.ROOT / 'retired.json').exists():
        raise agent.AgentError('This VPS has been retired. Connect a fresh VPS to restore its profile.', 409)
    document = validate(agent, body)
    marker = read(agent, 'control-marker.json', {})
    if marker and marker.get('serverId') != body['serverId']:
        raise agent.AgentError('This agent is already bound to another logical server.', 409)
    if body['revision'] < marker.get('revision', 0):
        raise agent.AgentError('A newer configuration revision is already saved.', 409)
    if agent.INSTALLING:
        raise agent.AgentError('Wait for the current server action to finish.', 409)
    previous_input = read(agent, 'control-input.json', {})
    if body['revision'] == marker.get('revision') and previous_input:
        prior = validate(agent, previous_input)
        if not same_intent(prior, document, read(agent, 'control-applied.json', {})):
            raise agent.AgentError('This configuration revision was already used for different settings.', 409)
    repair = bool(body.get('repair'))
    job = {'id': str(body['revision']), 'state': 'queued', 'message': 'Applying the saved BenX-UI configuration.', 'createdAt': int(time.time() * 1000), 'steps': []}
    agent.write_private(agent.ROOT / 'control-input.json', json.dumps(body))
    agent.write_private(agent.ROOT / 'control-marker.json', json.dumps({'serverId': body['serverId'], 'revision': body['revision']}))
    agent.write_private(agent.ROOT / 'control-job.json', json.dumps(job))
    agent.INSTALLING = True

    def execute():
        old_assets = {}
        old_policy = None
        old_ledger = None
        policy_written = False
        ledger_written = False
        try:
            job.update(state='running', message='Installing required cores and restoring managed listeners.')
            agent.write_private(agent.ROOT / 'control-job.json', json.dumps(job))
            plan = document['setup']
            for inbound in document['state']['inbounds']:
                tls = inbound.get('streamSettings', {}).get('tlsSettings', {})
                missing = any(c.get(field) and not Path(c[field]).is_file() for c in tls.get('certificates', []) for field in ['certificateFile', 'keyFile'])
                backup = document.get('runtime', {}).get('tlsCertificates', {}).get(str(inbound['id']))
                if missing and isinstance(backup, list) and backup and all(c.get('certificate') and c.get('key') for c in backup):
                    tls['certificates'] = copy.deepcopy(backup)
            if body.get('replacement') and document.get('runtime', {}).get('certificateFiles'):
                # Remember original paths without writing arbitrary exported files.
                agent.write_private(agent.ROOT / 'certificate-paths.json', json.dumps(document['runtime']['certificateFiles']))
            for core in plan['cores']:
                agent.server_setup.install_core(agent, core)
            if plan['panel'] == '3x-ui' and not (agent.ROOT / 'installed-panel.json').exists():
                agent.server_setup.install_panel(agent)
            if plan['panel'] == '3x-ui' and (agent.ROOT / 'installed-panel.json').exists():
                agent.server_setup.private_panel_bindings(agent)
            if plan['bbr'] and (not agent.server_setup.BBR_FILE.is_file() or agent.run(['sysctl', '-n', 'net.ipv4.tcp_congestion_control'], check=False) != 'bbr'):
                agent.server_setup.enable_bbr(agent)
            if plan['certificate']['enabled'] and not agent.server_setup.certificates.current(agent, plan['certificate']):
                preserved_dns = any(i.get('protocol') == 'dns-resolver' and all((agent.ROOT / 'listeners' / str(i['id']) / 'pki' / name).is_file() for name in ['dns-cert.pem', 'dns-key.pem']) for i in document['state']['inbounds'])
                preserved_tls = preserved_dns or any(n.startswith('certificates/') for n in document['assets']) or any(c.get('certificate') and c.get('key') for i in document['state']['inbounds'] for c in agent.object_value(i.get('streamSettings', {})).get('tlsSettings', {}).get('certificates', []))
                if body.get('replacement') and preserved_tls and plan['certificate'].get('target', 'domain') != 'ip':
                    # Keep the existing certificate working before DNS cutover. ACME renewal needs the new IP.
                    agent.write_private(agent.ROOT / 'certificate-renewal-pending.json', 'true')
                    if plan['certificate'].get('target') == 'both':
                        # The new VPS can prove IP ownership before domain DNS cutover.
                        agent.server_setup.certificate(agent, {**plan['certificate'], 'target': 'ip'})
                else:
                    agent.server_setup.certificate(agent, plan['certificate'])
                    (agent.ROOT / 'certificate-renewal-pending.json').unlink(missing_ok=True)
            with agent.LOCK:
                previous = agent.load_state()
                state = copy.deepcopy(document['state'])
                state['coreEnabled'] = document['coreEnabled']
                for inbound in state['inbounds']:
                    inbound.pop('_benxApiPort', None)
                    agent.validate_inbound(inbound, state)
                    inbound['settings'].pop('clients', None)
                for email, client in state['clients'].items():
                    if client.get('email') != email:
                        raise agent.AgentError('Client identity does not match its saved key.')
                    agent.validate_client(client, client.get('inboundIds'), state)
                    if not body.get('replacement'):
                        client['_quotaBlocked'] = previous.get('clients', {}).get(email, {}).get('_quotaBlocked', False)
                    else:
                        total = document.get('runtime', {}).get('usage', {}).get(email, {})
                        client['_quotaBlocked'] = bool(client.get('totalGB') and total.get('up', 0) + total.get('down', 0) >= client['totalGB'])
                for name, contents in document['assets'].items():
                    path = asset_path(agent, name)
                    old_assets[name] = path.read_text() if path.exists() else None
                    agent.write_private(path, base64.b64decode(contents).decode())
                old_policy = read(agent, 'policy.json', None)
                agent.write_private(agent.ROOT / 'policy.json', json.dumps(document['policy']))
                policy_written = True
                if body.get('replacement'):
                    old_ledger = read(agent, 'accounting.json', None)
                    runtime = document.get('runtime', {})
                    agent.write_private(agent.ROOT / 'accounting.json', json.dumps({'usage': runtime.get('usage', {}), 'inbounds': runtime.get('inbounds', {}), 'raw': {}, 'errors': {}, 'firstUse': runtime.get('firstUse', {})}))
                    ledger_written = True
                changed = {i['id'] for i in [*state['inbounds'], *previous['inbounds']]}
                before = {i['id']: clean(i) for i in previous['inbounds']}
                after = {i['id']: clean(i) for i in state['inbounds']}
                global_change = clean(previous.get('storefront')) != clean(state.get('storefront')) or clean(previous.get('xray')) != clean(state.get('xray')) or clean(previous.get('clients')) != clean(state.get('clients')) or previous.get('coreEnabled', {}) != state.get('coreEnabled', {})
                if not global_change and not repair:
                    changed = {i for i in changed if before.get(i) != after.get(i)}
                    for i in state['inbounds']:
                        wanted = agent.should_run(i, state)
                        if (agent.run(['systemctl', 'is-active', agent.unit_name(i)], check=False) == 'active') != wanted or (agent.run(['systemctl', 'is-enabled', agent.unit_name(i)], check=False) == 'enabled') != wanted:
                            changed.add(i['id'])
                        old = next((r for r in previous['inbounds'] if r['id'] == i['id']), {})
                        if old.get('_benxApiPort'):
                            i['_benxApiPort'] = old['_benxApiPort']
                agent.apply_state(state, previous, changed)
                agent.write_private(agent.ROOT / 'advertised-hosts.json', json.dumps(document.get('hosts', [])))
                agent.write_private(agent.ROOT / 'setup-plan.json', json.dumps(plan))
                agent.write_private(agent.ROOT / 'control-applied.json', json.dumps(export(agent)))
                agent.write_private(agent.ROOT / 'control-material.json', json.dumps(material(agent)))
                job.update(state='succeeded', message='Saved configuration applied and managed services verified.')
        except Exception as error:
            with agent.LOCK:
                for name, content in old_assets.items():
                    path = asset_path(agent, name)
                    if content is None:
                        path.unlink(missing_ok=True)
                    else:
                        agent.write_private(path, content)
                for name, value, written in [('policy.json', old_policy, policy_written), ('accounting.json', old_ledger, ledger_written)]:
                    if written:
                        if value is None:
                            (agent.ROOT / name).unlink(missing_ok=True)
                        else:
                            agent.write_private(agent.ROOT / name, json.dumps(value))
            job.update(state='failed', message=str(error) if isinstance(error, agent.AgentError) else 'Profile application failed. Previous managed listeners were retained; check the agent journal.')
        finally:
            agent.write_private(agent.ROOT / 'control-job.json', json.dumps(job))
            agent.INSTALLING = False

    threading.Thread(target=execute, daemon=True).start()
    return copy.deepcopy(job)


def startup(agent):
    job = read(agent, 'control-job.json', {})
    if job.get('state') in ['queued', 'running']:
        job.update(state='failed', message='The agent restarted during synchronization. BenX-UI will retry the saved revision.')
        agent.write_private(agent.ROOT / 'control-job.json', json.dumps(job))


def retire(agent, body):
    marker = read(agent, 'control-marker.json', {})
    if not isinstance(body, dict) or body.get('serverId') != marker.get('serverId'):
        raise agent.AgentError('Retirement must match the saved logical server identity.', 409)
    if agent.INSTALLING:
        raise agent.AgentError('Wait for the current configuration job before retiring this VPS.', 409)
    agent.write_private(agent.ROOT / 'retired.json', json.dumps({'serverId': body['serverId'], 'state': 'pending', 'at': int(time.time() * 1000)}))
    units = {agent.unit_name(i) for i in agent.load_state()['inbounds']}
    if (agent.UNITS_DIR / 'benx-certificate-renew.timer').is_file():
        units.update(['benx-certificate-renew.timer', 'benx-certificate-renew.service'])
    for directory in (agent.ROOT / 'tunnels').iterdir() if (agent.ROOT / 'tunnels').exists() else []:
        if re.fullmatch(r'[a-f0-9-]{36}', directory.name) and (directory / 'setup.json').is_file():
            units.add(agent.tunnels.names(agent, directory.name)[1])
    if (agent.ROOT / 'installed-panel.json').exists():
        units.add('x-ui.service')
    for unit in sorted(units):
        agent.run(['systemctl', 'disable', '--now', unit], check=False)
        if agent.run(['systemctl', 'is-active', unit], check=False) == 'active' or agent.run(['systemctl', 'is-enabled', unit], check=False) == 'enabled':
            raise agent.AgentError('An old managed service could not be stopped. Retirement will retry.', 502)
    agent.write_private(agent.ROOT / 'retired.json', json.dumps({'serverId': body['serverId'], 'state': 'retired', 'at': int(time.time() * 1000)}))
    return {'retired': True}
