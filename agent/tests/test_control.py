import base64
import copy
from contextlib import ExitStack
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


if 'benx_agent' in sys.modules:
    agent = sys.modules['benx_agent']
else:
    spec = importlib.util.spec_from_file_location('benx_agent', Path(__file__).parents[1] / 'benx_agent.py')
    agent = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = agent
    spec.loader.exec_module(agent)
control = agent.server_control


class ImmediateThread:
    def __init__(self, target, **_kwargs):
        self.target = target

    def start(self):
        self.target()


class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.commands = []
        self.running = {}
        self.enabled = {}
        self.fail_restart = False
        self.stack = ExitStack()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(agent, 'ROOT', self.root))
        self.stack.enter_context(patch.object(agent, 'UNITS_DIR', self.root / 'units'))
        self.stack.enter_context(patch.object(agent, 'SSH_RUNTIME_DIR', self.root / 'run'))
        self.stack.enter_context(patch.object(agent, 'binary', side_effect=lambda c: '/usr/bin/' + agent.CORES[c]['binary']))
        self.stack.enter_context(patch.object(agent, 'run', side_effect=self.fake_run))
        self.stack.enter_context(patch.object(agent.time, 'sleep'))
        self.stack.enter_context(patch.object(control.threading, 'Thread', ImmediateThread))
        self.stack.enter_context(patch.object(agent.server_setup.platform, 'freedesktop_os_release', return_value={'ID': 'debian'}))
        self.stack.enter_context(patch.object(agent.server_setup.shutil, 'which', side_effect=lambda name: '/usr/bin/' + name))
        self.install_core = self.stack.enter_context(patch.object(agent.server_setup, 'install_core', return_value='Installed'))
        self.install_panel = self.stack.enter_context(patch.object(agent.server_setup, 'install_panel', return_value='Installed'))
        self.stack.enter_context(patch.object(agent.server_setup, 'private_panel_bindings', return_value=False))
        self.stack.enter_context(patch.object(agent.vpn_network, 'healthy', return_value=True))
        self.enable_bbr = self.stack.enter_context(patch.object(agent.server_setup, 'enable_bbr', return_value='Enabled'))
        self.issue_certificate = self.stack.enter_context(patch.object(agent.server_setup, 'certificate', return_value='Issued'))
        agent.INSTALLING = False

    def fake_run(self, args, input_text=None, check=True, **_kwargs):
        self.commands.append((args, input_text))
        if args[0] == 'openssl':
            for option in ['-keyout', '-out']:
                if option in args:
                    path = Path(args[args.index(option) + 1])
                    agent.write_private(path, ('PRIVATE KEY ' if option == '-keyout' else 'CERTIFICATE ') + path.name)
            return ''
        if args[0] == 'systemctl':
            action, name = args[1], args[-1]
            if action == 'is-active':
                return 'active' if self.running.get(name, True) else 'inactive'
            if action == 'is-enabled':
                return 'enabled' if self.enabled.get(name, True) else 'disabled'
            if action == 'enable':
                self.enabled[name] = True
            elif action == 'disable':
                self.enabled[name] = False
                if '--now' in args:
                    self.running[name] = False
            elif action in ['restart', 'start']:
                if self.fail_restart and check:
                    self.fail_restart = False
                    raise agent.AgentError('Listener refused the new configuration.', 502)
                self.running[name] = True
            elif action == 'stop':
                self.running[name] = False
            return ''
        if args[:2] == ['sysctl', '-n']:
            return 'bbr'
        if args[-1] in ['genkey', 'pubkey']:
            return base64.b64encode(b'a' * 32).decode()
        return ''

    def test_export_preserves_certificates_not_currently_attached_to_an_inbound(self):
        agent.write_private(self.root/'certificates'/('a'*32)/'fullchain.pem','PUBLIC CERTIFICATE')
        agent.write_private(self.root/'certificates'/('a'*32)/'privkey.pem','PRIVATE KEY')
        agent.write_private(self.root/'certificate.json',json.dumps({'entries':[{'kind':'domain','identifier':'unused.example.com','certificateFile':str(self.root/'certificates'/('a'*32)/'fullchain.pem'),'keyFile':str(self.root/'certificates'/('a'*32)/'privkey.pem')}] }))
        exported=control.export(agent)
        entry=exported['runtime']['certificateFiles']['entries'][0]
        self.assertIn('certificates',entry['keyFile'])
        self.assertEqual(len([n for n in exported['assets'] if n.startswith('certificates/')]),2)
        self.assertIn(base64.b64encode(b'PRIVATE KEY').decode(),exported['assets'].values())
        with self.assertRaises(agent.AgentError):control.asset_path(agent,'certificates/../../etc/passwd')

    def document(self, protocol='vless'):
        inbound = {'id': 1, 'protocol': protocol, 'port': 444, 'listen': '', 'enable': True, 'expiryTime': 0, 'total': 0, 'settings': {'publicHost': 'vpn.example.com'} if protocol == 'openvpn' else {}, 'streamSettings': {}, 'sniffing': {}}
        client = {'email': 'alice', 'id': 'alice-id', 'uuid': 'alice-id', 'password': 'keep-this-password', 'subId': 'keep-this-sub-id', 'inboundIds': [1], 'enable': True, 'expiryTime': 0, 'totalGB': 0, 'limitIp': 0}
        return {'format': 1, 'mode': 'native', 'state': {'inbounds': [inbound], 'clients': {'alice': client}, 'nextId': 2, 'xray': {'outbounds': [{'protocol': 'freedom', 'tag': 'direct'}], 'routing': {'rules': []}}}, 'setup': {'panel': 'native', 'cores': [], 'bbr': False, 'certificate': {'enabled': False, 'domain': '', 'email': ''}, 'tunnelMethod': 'none'}, 'policy': {'revision': 0, 'services': [], 'inboundMultipliers': {}, 'clients': {}, 'subscriptions': {}}, 'coreEnabled': {}, 'assets': {}, 'runtime': {'usage': {}, 'inbounds': {}}, 'settings': {}, 'nodes': [], 'hosts': []}

    def body(self, document=None, revision=1, server_id='saved-server', replacement=False):
        return {'serverId': server_id, 'revision': revision, 'document': document or self.document(), 'replacement': replacement}

    def write_json(self, name, value):
        agent.write_private(agent.ROOT / name, json.dumps(value))

    def encode(self, value):
        return base64.b64encode(value.encode()).decode()

    def test_applies_fixed_recipes_and_reports_verified_revision(self):
        document = self.document()
        document['setup'].update(panel='3x-ui', bbr=True)
        document['setup']['certificate'] = {'enabled': True, 'domain': 'vpn.example.com', 'email': 'admin@example.com'}
        result = control.start(agent, self.body(document, revision=4))
        self.assertEqual(result['state'], 'succeeded')
        self.install_core.assert_called_once_with(agent, 'xray')
        self.install_panel.assert_called_once_with(agent)
        self.enable_bbr.assert_called_once_with(agent)
        self.issue_certificate.assert_called_once_with(agent, document['setup']['certificate'])
        result = control.status(agent)
        self.assertEqual((result['serverId'], result['revision'], result['job']['state']), ('saved-server', 4, 'succeeded'))
        self.assertFalse(result['drift'])
        self.assertFalse(agent.INSTALLING)

    def test_rejects_stale_revision_without_changing_saved_marker(self):
        marker = {'serverId': 'saved-server', 'revision': 4}
        self.write_json('control-marker.json', marker)
        with self.assertRaisesRegex(agent.AgentError, 'newer configuration'):
            control.start(agent, self.body(revision=3))
        self.assertEqual(control.read(agent, 'control-marker.json', {}), marker)
        self.assertFalse((self.root / 'control-job.json').exists())
        self.install_core.assert_not_called()

    def test_rejects_binding_another_logical_server(self):
        self.write_json('control-marker.json', {'serverId': 'saved-server', 'revision': 1})
        with self.assertRaisesRegex(agent.AgentError, 'another logical server'):
            control.start(agent, self.body(revision=2, server_id='different-server'))
        self.assertFalse((self.root / 'control-input.json').exists())

    def test_rejects_reusing_revision_for_changed_desired_sections(self):
        original = self.body()
        self.write_json('control-marker.json', {'serverId': original['serverId'], 'revision': original['revision']})
        self.write_json('control-input.json', original)
        changes = {
            'listeners': lambda d: d['state']['inbounds'][0].update(port=445),
            'policy': lambda d: d['policy']['inboundMultipliers'].update({'1': 2}),
            'setup': lambda d: d['setup'].update(bbr=True),
            'core states': lambda d: d['coreEnabled'].update(xray=False),
            'credentials': lambda d: d['assets'].update({'listeners/1/pki/server.key': self.encode('different key')}),
        }
        for name, change in changes.items():
            with self.subTest(section=name):
                body = copy.deepcopy(original)
                change(body['document'])
                with self.assertRaisesRegex(agent.AgentError, 'different settings'):
                    control.start(agent, body)
                self.assertEqual(control.read(agent, 'control-input.json', {}), original)

    def test_identical_revision_can_be_retried_without_changing_client_secrets(self):
        body = self.body()
        self.assertEqual(control.start(agent, copy.deepcopy(body))['state'], 'succeeded')
        before = agent.load_state()['clients']['alice']
        self.assertEqual(control.start(agent, copy.deepcopy(body))['state'], 'succeeded')
        after = agent.load_state()['clients']['alice']
        for field in ['id', 'uuid', 'password', 'subId']:
            self.assertEqual(after[field], before[field], field)
        self.assertFalse(control.status(agent)['drift'])

    def test_verified_wireguard_and_tls_checkpoints_keep_revision_but_changed_keys_are_rejected(self):
        for protocol in ['wireguard-native', 'vless']:
            with self.subTest(protocol=protocol):
                destination = self.root / protocol
                with patch.object(agent, 'ROOT', destination), patch.object(agent, 'UNITS_DIR', destination / 'units'):
                    document = self.document(protocol)
                    if protocol == 'wireguard-native':
                        document['state']['inbounds'][0]['settings'] = {'publicHost': 'vpn.example.com', 'address': '10.82.0.1/24'}
                        document['state']['clients']['alice']['allowedIPs'] = ['10.82.0.2/32']
                    else:
                        cert, key = destination / 'cert.pem', destination / 'key.pem'
                        agent.write_private(cert, 'certificate line 1\ncertificate line 2\n')
                        agent.write_private(key, 'private key line\n')
                        document['state']['inbounds'][0]['streamSettings'] = {'security': 'tls', 'tlsSettings': {'certificates': [{'certificateFile': str(cert), 'keyFile': str(key)}]}}
                    self.assertEqual(control.start(agent, self.body(copy.deepcopy(document)))['state'], 'succeeded')
                    exported = control.export(agent)
                    checkpoint = copy.deepcopy(document)
                    checkpoint['assets'] = exported['assets']
                    if protocol == 'wireguard-native':
                        checkpoint['state']['inbounds'][0]['settings']['privateKey'] = exported['state']['inbounds'][0]['settings']['privateKey']
                        for field in ['privateKey', 'publicKey']:
                            checkpoint['state']['clients']['alice'][field] = exported['state']['clients']['alice'][field]
                    else:
                        checkpoint['state']['inbounds'][0]['streamSettings']['tlsSettings']['certificates'] = exported['state']['inbounds'][0]['streamSettings']['tlsSettings']['certificates']
                    self.assertEqual(control.start(agent, self.body(copy.deepcopy(checkpoint)))['state'], 'succeeded')
                    changed = copy.deepcopy(checkpoint)
                    if protocol == 'wireguard-native':
                        changed['state']['inbounds'][0]['settings']['privateKey'] = base64.b64encode(b'b' * 32).decode()
                    else:
                        changed['state']['inbounds'][0]['streamSettings']['tlsSettings']['certificates'][0]['key'] = ['different private key']
                    with self.assertRaisesRegex(agent.AgentError, 'different settings'):
                        control.start(agent, self.body(changed))

    def test_repair_rewrites_corrupted_config_without_rotating_client_secrets(self):
        body = self.body()
        self.assertEqual(control.start(agent, copy.deepcopy(body))['state'], 'succeeded')
        before = agent.load_state()['clients']['alice']
        config = self.root / 'listeners/1/xray.json'
        changed = json.loads(config.read_text())
        changed['outbounds'] = [{'protocol': 'blackhole', 'tag': 'direct'}]
        agent.write_private(config, json.dumps(changed))
        self.assertTrue(control.status(agent)['drift'])
        body['repair'] = True
        self.assertEqual(control.start(agent, copy.deepcopy(body))['state'], 'succeeded')
        self.assertEqual(json.loads(config.read_text())['outbounds'], [{'protocol': 'freedom', 'tag': 'direct'}])
        self.assertFalse(control.status(agent)['drift'])
        after = agent.load_state()['clients']['alice']
        for field in ['id', 'uuid', 'password', 'subId']:
            self.assertEqual(after[field], before[field], field)

    def test_invalid_identity_and_revision_cannot_start_a_job(self):
        for server_id, revision in [('server; reboot', 1), ('saved-server', 0), ('saved-server', True), ('saved-server', 1.5)]:
            with self.subTest(identity=server_id, revision=revision), self.assertRaises(agent.AgentError):
                control.start(agent, self.body(server_id=server_id, revision=revision))
        self.assertFalse((self.root / 'control-marker.json').exists())

    def test_rejects_asset_traversal_and_unmanaged_files(self):
        for name in ['../root.key', 'listeners/1/pki/../../root.key', '/etc/shadow', 'listeners/1/sshd.conf', 'listeners/0/pki/server.key', 'listeners/1/pki/server.csr']:
            with self.subTest(path=name):
                document = self.document()
                document['assets'] = {name: self.encode('private credential')}
                with self.assertRaises(agent.AgentError):
                    control.validate(agent, self.body(document))

    def test_rejects_symlink_credential_file_or_parent(self):
        target = self.root / 'outside-key'
        target.write_text('outside secret')
        directory = self.root / 'listeners' / '1' / 'pki'
        directory.mkdir(parents=True)
        linked = directory / 'server.key'
        try:
            linked.symlink_to(target)
        except OSError:
            # Windows may deny creating symlinks without Developer Mode. Exercise
            # the same security gate rather than silently skipping the check.
            original = Path.is_symlink
            with patch.object(Path, 'is_symlink', side_effect=lambda p: p == linked or original(p), autospec=True):
                with self.assertRaisesRegex(agent.AgentError, 'symlinks'):
                    control.asset_path(agent, 'listeners/1/pki/server.key')
        else:
            with self.assertRaisesRegex(agent.AgentError, 'symlinks'):
                control.asset_path(agent, 'listeners/1/pki/server.key')
            linked.unlink()
        original = Path.is_symlink
        with patch.object(Path, 'is_symlink', side_effect=lambda p: p == directory or original(p), autospec=True):
            with self.assertRaisesRegex(agent.AgentError, 'symlinks'):
                control.asset_path(agent, 'listeners/1/pki/server.crt')

    def test_rejects_malformed_or_oversized_credential_contents(self):
        for content in ['invalid base64!', base64.b64encode(b'\xff').decode(), self.encode('a' * 65537)]:
            with self.subTest(size=len(content)):
                document = self.document()
                document['assets'] = {'listeners/1/pki/server.key': content}
                with self.assertRaisesRegex(agent.AgentError, 'encoded credential'):
                    control.validate(agent, self.body(document))

    def test_generated_pki_is_exported_and_restored_without_reissuing(self):
        self.assertEqual(control.start(agent, self.body(self.document('openvpn')))['state'], 'succeeded')
        exported = control.export(agent)
        client_name = agent.system_user('alice')
        expected = {f'listeners/1/pki/{name}' for name in ['ca.crt', 'ca.key', 'server.crt', 'server.key', client_name + '.crt', client_name + '.key']}
        self.assertEqual(set(exported['assets']), expected)
        self.assertNotIn('listeners/1/pki/server.csr', exported['assets'])
        destination = self.root / 'replacement'
        self.commands.clear()
        with patch.object(agent, 'ROOT', destination), patch.object(agent, 'UNITS_DIR', destination / 'units'):
            result = control.start(agent, self.body(exported, replacement=True))
            self.assertEqual(result['state'], 'succeeded')
            for name, content in exported['assets'].items():
                self.assertEqual((destination / name).read_bytes(), base64.b64decode(content))
            self.assertEqual(agent.load_state()['clients']['alice']['password'], 'keep-this-password')
            self.assertEqual(agent.load_state()['clients']['alice']['subId'], 'keep-this-sub-id')
        self.assertFalse(any(args[0] == 'openssl' for args, _ in self.commands))

    def test_core_stop_intent_disables_services_and_survives_export(self):
        document = self.document()
        document['coreEnabled']['xray'] = False
        self.assertEqual(control.start(agent, self.body(document))['state'], 'succeeded')
        self.assertIn((['systemctl', 'disable', '--now', 'benx-xray-1.service'], None), self.commands)
        self.assertFalse(any(args[:2] == ['systemctl', 'restart'] for args, _ in self.commands))
        self.assertEqual(agent.load_state()['coreEnabled'], {'xray': False})
        self.assertEqual(control.export(agent)['coreEnabled'], {'xray': False})
        self.assertFalse(control.status(agent)['drift'])

    def test_listener_failure_restores_config_policy_assets_and_unit(self):
        document = self.document()
        document['assets'] = {'listeners/1/pki/server.key': self.encode('original key')}
        self.assertEqual(control.start(agent, self.body(document))['state'], 'succeeded')
        paths = ['state.json', 'policy.json', 'listeners/1/xray.json', 'listeners/1/pki/server.key', 'units/benx-xray-1.service']
        before = {name: (self.root / name).read_bytes() for name in paths}
        changed = copy.deepcopy(document)
        changed['state']['inbounds'][0]['port'] = 445
        changed['policy']['inboundMultipliers']['1'] = 2
        changed['assets'] = {'listeners/1/pki/server.key': self.encode('replacement key'), 'listeners/1/pki/new.crt': self.encode('new certificate')}
        self.fail_restart = True
        result = control.start(agent, self.body(changed, revision=2, replacement=True))
        self.assertEqual(result['state'], 'failed')
        for name, content in before.items():
            self.assertEqual((self.root / name).read_bytes(), content, name)
        self.assertFalse((self.root / 'listeners/1/pki/new.crt').exists())
        self.assertFalse(agent.INSTALLING)

    def test_failed_initial_listener_removes_new_policy_and_credentials(self):
        document = self.document()
        document['assets'] = {'listeners/1/pki/server.key': self.encode('new key')}
        self.fail_restart = True
        self.assertEqual(control.start(agent, self.body(document, replacement=True))['state'], 'failed')
        self.assertFalse((self.root / 'state.json').exists())
        self.assertFalse((self.root / 'policy.json').exists())
        self.assertFalse((self.root / 'listeners/1/pki/server.key').exists())
        self.assertFalse((self.root / 'units/benx-xray-1.service').exists())

    def test_normal_apply_keeps_local_usage_but_replacement_restores_checkpoint(self):
        original = {'usage': {'alice': {'up': 23, 'down': 31}}, 'inbounds': {'1': {'up': 23, 'down': 31}}, 'raw': {'local-baseline': {'invocation': 'old', 'values': [23, 31]}}, 'errors': {}}
        self.write_json('accounting.json', original)
        document = self.document()
        document['runtime'] = {'usage': {'alice': {'up': 100, 'down': 200}}, 'inbounds': {'1': {'up': 100, 'down': 200}}}
        self.assertEqual(control.start(agent, self.body(document))['state'], 'succeeded')
        ledger = control.read(agent, 'accounting.json', {})
        self.assertEqual(ledger['usage'], original['usage'])
        self.assertEqual(ledger['raw'], original['raw'])
        self.assertEqual(control.start(agent, self.body(document, revision=2, replacement=True))['state'], 'succeeded')
        ledger = control.read(agent, 'accounting.json', {})
        self.assertEqual(ledger['usage'], document['runtime']['usage'])
        self.assertEqual(ledger['inbounds'], document['runtime']['inbounds'])
        self.assertEqual(ledger['raw'], {})

    def test_failed_replacement_restores_previous_usage_checkpoint(self):
        document = self.document()
        self.assertEqual(control.start(agent, self.body(document))['state'], 'succeeded')
        original = {'usage': {'alice': {'up': 23, 'down': 31}}, 'inbounds': {}, 'raw': {}, 'errors': {}}
        self.write_json('accounting.json', original)
        document['runtime'] = {'usage': {'alice': {'up': 900, 'down': 900}}, 'inbounds': {}}
        document['state']['inbounds'][0]['port'] = 445
        self.fail_restart = True
        self.assertEqual(control.start(agent, self.body(document, revision=2, replacement=True))['state'], 'failed')
        self.assertEqual(control.read(agent, 'accounting.json', {}), original)

    def test_normal_sync_keeps_current_quota_blocking_state(self):
        previous = self.document()['state']
        previous['clients']['alice']['_quotaBlocked'] = True
        self.write_json('state.json', previous)
        self.assertEqual(control.start(agent, self.body())['state'], 'succeeded')
        self.assertTrue(agent.load_state()['clients']['alice']['_quotaBlocked'])

    def test_drift_detects_external_config_or_service_change(self):
        self.assertEqual(control.start(agent, self.body())['state'], 'succeeded')
        self.assertFalse(control.status(agent)['drift'])
        self.running['benx-xray-1.service'] = False
        self.assertTrue(control.status(agent)['drift'])
        self.running['benx-xray-1.service'] = True
        state = agent.load_state()
        state['inbounds'][0]['port'] = 445
        self.write_json('state.json', state)
        self.assertTrue(control.status(agent)['drift'])

    def test_drift_detects_modified_listener_config_on_disk(self):
        self.assertEqual(control.start(agent, self.body())['state'], 'succeeded')
        self.assertFalse(control.status(agent)['drift'])
        config = self.root / 'listeners/1/xray.json'
        changed = json.loads(config.read_text())
        changed['outbounds'] = [{'protocol': 'blackhole', 'tag': 'direct'}]
        agent.write_private(config, json.dumps(changed))
        self.assertTrue(control.status(agent)['drift'])

    def test_drift_detects_missing_vpn_forwarding_even_while_listener_runs(self):
        self.assertEqual(control.start(agent, self.body(self.document('openvpn')))['state'], 'succeeded')
        self.assertFalse(control.status(agent)['drift'])
        with patch.object(agent.vpn_network, 'healthy', return_value=False):
            self.assertTrue(control.status(agent)['drift'])

    def test_drift_detects_missing_or_modified_generated_credentials(self):
        self.assertEqual(control.start(agent, self.body(self.document('openvpn')))['state'], 'succeeded')
        self.assertFalse(control.status(agent)['drift'])
        key = self.root / 'listeners/1/pki/server.key'
        original = key.read_text()
        agent.write_private(key, 'different server key')
        self.assertTrue(control.status(agent)['drift'])
        agent.write_private(key, original)
        key.unlink()
        self.assertTrue(control.status(agent)['drift'])

    def test_replacement_uses_saved_tls_before_dns_switch_and_reports_renewal_needed(self):
        document = self.document()
        document['setup']['certificate'] = {'enabled': True, 'domain': 'vpn.example.com', 'email': 'admin@example.com'}
        document['state']['inbounds'][0]['streamSettings'] = {'network': 'tcp', 'security': 'tls', 'tlsSettings': {'certificates': [{'certificate': ['SAVED CERTIFICATE'], 'key': ['SAVED PRIVATE KEY']}]}}
        self.assertEqual(control.start(agent, self.body(document, replacement=True))['state'], 'succeeded')
        self.issue_certificate.assert_not_called()
        self.assertTrue(control.export(agent)['runtime']['certificateRenewalPending'])
        self.assertIn('SAVED PRIVATE KEY', (self.root / 'listeners/1/inline-0.key').read_text() if (self.root / 'listeners/1/inline-0.key').exists() else json.dumps(agent.load_state()))

    def test_replacement_restores_portable_tls_when_remembered_files_are_absent(self):
        document = self.document()
        document['setup']['certificate'] = {'enabled': True, 'domain': 'vpn.example.com', 'email': 'admin@example.com'}
        document['state']['inbounds'][0]['streamSettings'] = {'network': 'tcp', 'security': 'tls', 'tlsSettings': {'certificates': [{'certificateFile': '/missing/fullchain.pem', 'keyFile': '/missing/privkey.pem'}]}}
        document['runtime']['tlsCertificates'] = {'1': [{'certificate': ['PORTABLE CERT'], 'key': ['PORTABLE PRIVATE KEY']}]}
        self.assertEqual(control.start(agent, self.body(document, replacement=True))['state'], 'succeeded')
        self.issue_certificate.assert_not_called()
        self.assertIn('PORTABLE PRIVATE KEY', json.dumps(agent.load_state()))

    def test_retirement_verifies_owned_services_and_rejects_foreign_identity(self):
        self.assertEqual(control.start(agent, self.body())['state'], 'succeeded')
        with self.assertRaisesRegex(agent.AgentError, 'identity'):
            control.retire(agent, {'serverId': 'someone-else'})
        self.assertTrue(control.retire(agent, {'serverId': 'saved-server'})['retired'])
        unit = agent.unit_name(agent.load_state()['inbounds'][0])
        self.assertFalse(self.running[unit])
        self.assertFalse(self.enabled[unit])
        self.assertFalse(any(args[-1] == 'sshd.service' for args, _ in self.commands))

    def test_combined_replacement_issues_new_ip_and_keeps_domain_renewal_pending(self):
        document = self.document()
        document['setup']['certificate'] = {'enabled':True,'target':'both','domain':'vpn.example.com','ip':'1.1.1.1','email':'admin@example.com'}
        document['state']['inbounds'][0]['streamSettings'] = {'network':'tcp','security':'tls','tlsSettings':{'certificates':[{'certificate':['SAVED CERTIFICATE'],'key':['SAVED PRIVATE KEY']}]}}
        self.assertEqual(control.start(agent,self.body(document,replacement=True))['state'],'succeeded')
        self.issue_certificate.assert_called_once()
        self.assertEqual(self.issue_certificate.call_args.args[1]['target'],'ip')
        self.assertTrue(control.export(agent)['runtime']['certificateRenewalPending'])

    def test_retirement_failure_remains_unconfirmed(self):
        self.assertEqual(control.start(agent, self.body())['state'], 'succeeded')
        with patch.object(agent, 'run', return_value='active'):
            with self.assertRaisesRegex(agent.AgentError, 'could not be stopped'):
                control.retire(agent, {'serverId': 'saved-server'})
        self.assertEqual(control.read(agent, 'retired.json', {})['state'], 'pending')
        self.assertFalse(agent.should_run(agent.load_state()['inbounds'][0], agent.load_state()))
        with self.assertRaisesRegex(agent.AgentError, 'retired'):
            control.start(agent, self.body(revision=2))

    def test_restart_marks_interrupted_job_for_safe_retry(self):
        self.write_json('control-marker.json', {'serverId': 'saved-server', 'revision': 4})
        self.write_json('control-job.json', {'id': '4', 'state': 'running', 'steps': [{'state': 'succeeded'}]})
        control.startup(agent)
        result = control.status(agent)
        self.assertEqual(result['job']['state'], 'failed')
        self.assertIn('restarted', result['job']['message'])
        self.assertEqual(result['revision'], 4)


if __name__ == '__main__':
    unittest.main()
