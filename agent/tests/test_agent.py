import base64
import copy
import importlib.util
import json
import hashlib
import io
import tarfile
import threading
import http.client
from pathlib import Path
import tempfile
import unittest
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("benx_agent", Path(__file__).parents[1] / "benx_agent.py")
agent = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = agent
spec.loader.exec_module(agent)
KEY = base64.b64encode(b"a" * 32).decode()


class AgentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.patchers = [patch.object(agent, "ROOT", self.root), patch.object(agent, "UNITS_DIR", self.root / "units"), patch.object(agent, "SSH_RUNTIME_DIR", self.root / "run"), patch.object(agent, "binary", side_effect=lambda core: "/usr/bin/" + agent.CORES[core]["binary"]), patch.object(agent, "run", side_effect=self.fake_run)]
        for patcher in self.patchers:
            patcher.start()
        agent.INSTALLING = False
        self.commands = []

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temp.cleanup()

    def fake_run(self, args, input_text=None, **_kwargs):
        self.commands.append((args, input_text))
        if "genkey" in args or "pubkey" in args:
            return KEY
        if "-genkey" in args:
            config = json.loads(Path(args[args.index("-json") + 1]).read_text())
            agent.write_private(config["ENCRYPTION_KEY_FILE"], "dns-secret-key")
        return "active" if "is-active" in args else ""

    def inbound(self, protocol="vless", number=1, settings=None):
        return {"id": number, "protocol": protocol, "port": 443 + number, "listen": "", "enable": True, "expiryTime": 0, "settings": settings or {}, "streamSettings": {}, "sniffing": {}, "total": 0}

    def state(self, inbound=None, clients=None):
        return {"inbounds": [inbound or self.inbound()], "clients": clients or {}, "nextId": 2}

    def client(self, email="alice", ids=None):
        return {"email": email, "id": "uuid", "uuid": "uuid", "password": "private-password", "inboundIds": ids or [1], "enable": True, "expiryTime": 0, "totalGB": 0, "limitIp": 0}

    def test_mixed_attachment_quota_accepts_measured_traffic_and_excludes_all_when_depleted(self):
        client={**self.client(ids=[1,2]),'totalGB':100,'expiryTime':-30*86400000}
        state={'inbounds':[self.inbound(),self.inbound('ssh',2)],'clients':{'alice':client},'nextId':3}
        agent.validate_client(client,[1,2],state)
        self.assertEqual(client['inboundIds'],[1,2])
        client['_quotaBlocked']=True
        self.assertFalse(agent.eligible(client))
        with self.assertRaises(agent.AgentError):agent.validate_client({**client,'inboundIds':[2]},[2],state)
    def test_first_use_starts_only_from_traffic_and_survives_reload(self):
        client = {**self.client(), 'expiryTime': -30*86400000, 'firstUseId': 'renewal-1'}
        state = self.state(clients={'alice': client})
        agent.validate_client(client, [1], state)
        self.assertEqual(agent.effective_expiry(client), -30*86400000)
        with patch.object(agent.accounting, 'counters', return_value=('run', {'alice': [0, 0]})):
            agent.accounting.collect(agent, state)
        self.assertNotIn('alice', agent.accounting.read(agent, 'accounting.json', {}).get('firstUse', {}))
        with patch.object(agent.accounting, 'counters', return_value=('run', {'alice': [10, 20]})), patch.object(agent.accounting.time, 'time', return_value=1000):
            ledger = agent.accounting.collect(agent, state)
        client['_firstUse'] = ledger['firstUse']['alice']
        self.assertEqual(agent.effective_expiry(client), 1000000+30*86400000)
        with patch.object(agent.accounting, 'counters', return_value=('run', {'alice': [20, 40]})):
            later = agent.accounting.collect(agent, state)
        self.assertEqual(later['firstUse']['alice'], ledger['firstUse']['alice'])
        client['firstUseId'] = 'renewal-2'
        self.assertEqual(agent.effective_expiry(client), -30*86400000)

    def test_custom_storefront_html_rejects_executable_or_oversized_files(self):
        html = '<!doctype html><html><body><h1>Custom</h1></body></html>'
        self.assertEqual(agent.storefront.validate_html(agent, html), html)
        for bad in ['<html><script>alert(1)</script></html>', '<html><img onerror=x></html>', '<html><form></form></html>', '<html>' + 'x'*200000 + '</html>']:
            with self.assertRaises(agent.AgentError):
                agent.storefront.validate_html(agent, bad)

    def test_storefront_conflicts_and_local_websocket_compilation(self):
        row = self.inbound(); row['streamSettings'] = {'network': 'ws', 'security': 'none', 'wsSettings': {'path': '/proxy'}}
        state = self.state(row)
        state['storefront'] = {'enabled': True, 'template': 'arcade', 'domain': 'arcade.example.com', 'mode': 'cdn', 'port': 2083, 'inboundIds': [1]}
        agent.storefront.validate(agent, state)
        agent.compile_inbound(row, state)
        compiled = json.loads((self.root / 'listeners/1/xray.json').read_text())
        self.assertEqual(compiled['inbounds'][0]['listen'], '127.0.0.1')
        state['storefront']['port'] = row['port']
        with self.assertRaises(agent.AgentError): agent.storefront.validate(agent, state)
        state['storefront']['port'] = 2083; row['streamSettings']['security'] = 'tls'
        with self.assertRaises(agent.AgentError): agent.storefront.validate(agent, state)

    def test_disabled_routing_rules_stay_saved_but_never_enter_xray(self):
        inbound = self.inbound()
        state = self.state(inbound)
        state['xray'] = {'outbounds': [{'tag': 'direct', 'protocol': 'freedom'}], 'routing': {'rules': [
            {'type': 'field', 'domain': ['disabled.example'], 'outboundTag': 'direct', 'enabled': False},
            {'type': 'field', 'domain': ['enabled.example'], 'outboundTag': 'direct', 'enabled': True},
        ]}}
        agent.compile_inbound(inbound, state)
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())
        rules = config['routing']['rules']
        self.assertFalse(any('disabled.example' in r.get('domain', []) for r in rules))
        self.assertTrue(any('enabled.example' in r.get('domain', []) for r in rules))
        self.assertTrue(all('enabled' not in r for r in rules))
        self.assertEqual(len(state['xray']['routing']['rules']), 2)
        self.assertFalse(state['xray']['routing']['rules'][0]['enabled'])

    def test_command_injection_is_rejected_in_native_values(self):
        with self.assertRaises(agent.AgentError):
            agent.safe_line("password\nroot:injected")
        with self.assertRaises(agent.AgentError):
            agent.host("example.com\nPermitRootLogin yes")
        with self.assertRaises(agent.AgentError):
            agent.peer_key("not-a-real-key")

    def test_fixed_native_account_names_are_independent_of_input_syntax(self):
        self.assertRegex(agent.system_user("x; rm -rf /"), r"^benx_[a-f0-9]{20}$")

    def test_blank_listen_address_compiles_as_all_interfaces(self):
        inbound = self.inbound()
        agent.compile_inbound(inbound, self.state(inbound))
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())
        self.assertEqual(config['inbounds'][0]['listen'], '0.0.0.0')
        self.assertEqual(config['inbounds'][0]['tag'], 'inbound-1')
        inbound['listen'] = '127.0.0.1'
        agent.compile_inbound(inbound, self.state(inbound))
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())
        self.assertEqual(config['inbounds'][0]['listen'], '127.0.0.1')

    def test_vpn_internet_access_creates_owned_lifecycle_hooks_and_can_be_disabled(self):
        unit = agent.vpn_unit(['/usr/bin/openvpn', '--config', '/private/config'], 7, '10.80.10.0/24')
        self.assertIn('up --id 7 --subnet 10.80.10.0/24', unit)
        self.assertIn('ExecStopPost=', unit)
        private = agent.vpn_unit(['/usr/bin/openvpn'], 7, '10.80.10.0/24', False)
        self.assertNotIn(' up --id', private)
        self.assertIn('ExecStartPre=', private)
        self.assertIn('down --id 7', private)
        with self.assertRaises(agent.AgentError): agent.vpn_unit(['/usr/bin/openvpn'], 7, '0.0.0.0/0')
        with self.assertRaises(agent.AgentError): agent.vpn_unit(['/usr/bin/openvpn'], 7, '10.80.10.0/24', 'false')
        self.assertNotEqual(agent.system_user("alice"), agent.system_user("bob"))

    def test_unimplemented_cores_and_accounting_fail_closed(self):
        with self.assertRaises(agent.AgentError):
            agent.core_of("unknown-core")
        with self.assertRaises(agent.AgentError):
            agent.validate_client({**self.client(), "totalGB": 1000}, [1], self.state(self.inbound("ssh")))
        with self.assertRaises(agent.AgentError):
            agent.validate_client({**self.client(), "expiryTime": -86400000}, [1], self.state(self.inbound("ssh")))
        with self.assertRaises(agent.AgentError):
            agent.dispatch("/panel/api/setting/update", "POST", {"x": 1})

    def test_port_conflicts_and_invalid_listen_addresses_are_rejected(self):
        state = self.state()
        with self.assertRaises(agent.AgentError):
            agent.validate_inbound({**self.inbound(number=2), "port": 444}, state)
        with self.assertRaises(agent.AgentError):
            agent.validate_inbound({**self.inbound(), "listen": "localhost; id"}, state)

    def test_masterdns_allows_shared_identities_and_strong_encryption(self):
        inbound = self.inbound("masterdnsvpn", settings={"DOMAIN": ["v.example.com"], "DATA_ENCRYPTION_METHOD": 5})
        state = self.state(inbound, {"alice": self.client()})
        self.assertEqual(agent.validate_client(self.client("bob"), [1], state)["email"], "bob")
        unit = agent.compile_inbound(inbound, state)
        config = json.loads((self.root / "listeners/1/masterdnsvpn.json").read_text())
        self.assertEqual(config["UDP_PORT"], 444)
        self.assertEqual(config["DATA_ENCRYPTION_METHOD"], 5)
        self.assertTrue(config["ENCRYPTION_KEY_FILE"].startswith(str(self.root)))
        self.assertIn('"-json"', unit)
        self.assertNotIn("dns-secret-key", unit)
        self.assertEqual(json.loads(agent.client_profiles(state, "alice")[0])["ENCRYPTION_KEY"], "dns-secret-key")
        with self.assertRaises(agent.AgentError):
            agent.compile_inbound({**inbound, "settings": {"DOMAIN": ["v.example.com"], "DATA_ENCRYPTION_METHOD": 0}}, state)

    def test_masterdns_methods_default_to_chacha_and_accept_explicit_xor(self):
        inbound = self.inbound('masterdnsvpn', settings={'DOMAIN': ['v.example.com']})
        state = self.state(inbound, {'alice': self.client()})
        agent.compile_inbound(inbound, state)
        self.assertEqual(inbound['settings']['DATA_ENCRYPTION_METHOD'], 2)
        for method in [1, 2, 3, 4, 5]:
            inbound['settings']['DATA_ENCRYPTION_METHOD'] = method
            agent.compile_inbound(inbound, state)
            uri = next(p for p in agent.client_profiles(state, 'alice') if p.startswith('masterdns://'))
            self.assertEqual(json.loads(base64.b64decode(uri[12:]))['method'], method)
        with self.assertRaises(agent.AgentError):
            agent.validate_inbound({**inbound, 'id': 2, 'port': 5353}, state)

    def test_shared_masterdns_compiles_private_forwarding_and_preserves_meter_baselines(self):
        backend = self.inbound(number=2, settings={'decryption': 'none'})
        backend.update(listen='127.0.0.1', excludeFromSub=True)
        dns = self.inbound('masterdnsvpn', settings={'DOMAIN': ['v.example.com'], 'meteredInboundId': 2})
        clients = {name: {**self.client(name, [1, 2]), 'id': identity, 'uuid': identity} for name, identity in [('alice', '11111111-1111-4111-8111-111111111111'), ('bob', '22222222-2222-4222-8222-222222222222')]}
        state = {'inbounds': [dns, backend], 'clients': clients}
        agent.compile_inbound(dns, state)
        config = json.loads((self.root / 'listeners/1/masterdnsvpn.json').read_text())
        self.assertEqual((config['PROTOCOL_TYPE'], config['FORWARD_IP'], config['FORWARD_PORT']), ('TCP', '127.0.0.1', backend['port']))
        policy = {'revision': 1, 'clients': {}, 'services': [], 'inboundMultipliers': {'1': 2}}
        agent.write_private(self.root / 'policy.json', json.dumps(policy))
        agent.write_private(self.root / 'accounting.json', json.dumps({'raw': {'2:alice': {'invocation': 'a', 'values': [100, 10]}}, 'usage': {'alice': {'up': 100, 'down': 10, 'rawUp': 100, 'rawDown': 10}}}))
        with patch.object(agent.accounting, 'counters', return_value=('a', {'alice': [110, 20], 'bob': [5, 5]})):
            ledger = agent.accounting.collect(agent, state)
        self.assertEqual(ledger['usage']['alice']['up'], 120)
        self.assertEqual(ledger['usage']['bob']['up'], 10)
        self.assertEqual(ledger['inbounds']['1']['up'], 15)
        clients['bob']['uuid'] = clients['alice']['uuid']
        with self.assertRaises(agent.AgentError): agent.masterdns_backend(dns, state)

    def test_masterdns_stops_when_its_identity_is_disabled(self):
        inbound = self.inbound("masterdnsvpn")
        state = self.state(inbound, {"alice": self.client()})
        self.assertTrue(agent.should_run(inbound, state))
        state["clients"]["alice"]["enable"] = False
        self.assertFalse(agent.should_run(inbound, state))

    def test_xray_config_uses_only_active_attached_clients(self):
        inbound = self.inbound()
        state = self.state(inbound, {"alice": self.client(), "bob": {**self.client("bob"), "enable": False}})
        unit = agent.compile_inbound(inbound, state)
        config = json.loads((self.root / "listeners/1/xray.json").read_text())
        self.assertEqual([c["email"] for c in config["inbounds"][0]["settings"]["clients"]], ["alice"])
        self.assertIn('"-config"', unit)
        self.assertTrue(any("-test" in args for args, _ in self.commands))

    def test_weighted_usage_counts_only_new_traffic_and_survives_counter_resets(self):
        ledger = {'raw': {}, 'usage': {}}
        policy = {'clients': {'alice': {'serviceId': 'standard', 'multiplier': 1.5, 'overrides': {}}}, 'services': [{'id': 'standard', 'inbounds': [{'inboundId': 1, 'multiplier': 2}]}]}
        agent.accounting.accumulate(ledger, 1, 'process-a', {'alice': [100, 50]}, policy)
        self.assertEqual(ledger['usage']['alice']['up'], 300)
        policy['services'][0]['inbounds'][0]['multiplier'] = 1
        agent.accounting.accumulate(ledger, 1, 'process-a', {'alice': [120, 50]}, policy)
        self.assertEqual(ledger['usage']['alice']['up'], 330)
        agent.accounting.accumulate(ledger, 1, 'process-a', {'alice': [120, 50]}, policy)
        self.assertEqual(ledger['usage']['alice']['up'], 330)
        agent.accounting.accumulate(ledger, 1, 'process-b', {'alice': [10, 5]}, policy)
        self.assertEqual(ledger['usage']['alice']['up'], 345)
        policy['clients']['alice']['overrides']['1'] = 0
        agent.accounting.accumulate(ledger, 1, 'process-b', {'alice': [20, 10]}, policy)
        self.assertEqual(ledger['usage']['alice']['up'], 345)
        self.assertEqual(ledger['usage']['alice']['rawUp'], 140)

    def test_depleted_client_is_removed_from_all_active_listener_credentials(self):
        client = {**self.client(), 'totalGB': 100, '_quotaBlocked': True}
        state = self.state(clients={'alice': client})
        self.assertFalse(agent.eligible(client))
        agent.compile_inbound(state['inbounds'][0], state)
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())
        self.assertEqual(config['inbounds'][0]['settings']['clients'], [])
        self.assertEqual(config['inbounds'][1]['listen'], '127.0.0.1')
        self.assertIn('StatsService', config['api']['services'])

    def test_http_and_socks_never_become_open_proxies_after_disabling_users(self):
        for protocol in ['http', 'socks']:
            inbound = self.inbound(protocol, settings={'auth': 'noauth'})
            client = self.client()
            state = self.state(inbound, clients={'alice': client})
            agent.compile_inbound(inbound, state)
            config = json.loads((self.root / 'listeners/1/xray.json').read_text())
            settings = config['inbounds'][0]['settings']
            self.assertEqual(settings['accounts'], [{'user': agent.system_user('alice'), 'pass': client['password']}])
            if protocol == 'socks':
                self.assertEqual(settings['auth'], 'password')
            self.assertTrue(agent.should_run(inbound, state))
            client['enable'] = False
            agent.compile_inbound(inbound, state)
            config = json.loads((self.root / 'listeners/1/xray.json').read_text())
            self.assertEqual(config['inbounds'][0]['settings']['accounts'][0]['user'], 'benx_disabled')
            self.assertGreater(len(config['inbounds'][0]['settings']['accounts'][0]['pass']), 32)
            self.assertFalse(agent.should_run(inbound, state))
            client['enable'] = True
            client['expiryTime'] = 1
            self.assertFalse(agent.should_run(inbound, state))

    def test_legacy_shadowsocks_users_inherit_the_selected_cipher(self):
        inbound = self.inbound('shadowsocks', settings={'method': 'aes-256-gcm', 'password': 'server-key'})
        state = self.state(inbound, clients={'alice': self.client()})
        agent.compile_inbound(inbound, state)
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())
        user = config['inbounds'][0]['settings']['clients'][0]
        self.assertEqual(user['method'], 'aes-256-gcm')
        self.assertEqual(user['password'], 'private-password')

    def test_openconnect_profile_exports_spki_pin_not_certificate_digest(self):
        inbound = self.inbound('openconnect', settings={'publicHost': 'vpn.example.com'})
        public_der = b'public-spki-fixture'
        public_pem = '-----BEGIN PUBLIC KEY-----\n' + base64.b64encode(public_der).decode() + '\n-----END PUBLIC KEY-----'
        with patch.object(agent, 'run', side_effect=lambda args, **kwargs: public_pem if '-pubkey' in args else 'SHA256 Fingerprint=' + 'ab:' * 31 + 'ab'):
            profile = agent.client_profiles(self.state(inbound, {'alice': self.client()}), 'alice')[0]
        expected = base64.b64encode(hashlib.sha256(public_der).digest()).decode()
        self.assertIn('Server public key pin-sha256: ' + expected, profile)
        self.assertIn('Server certificate SHA-256: ' + 'ab' * 32, profile)

    def test_quota_reconciliation_retries_after_service_failure(self):
        state = self.state(clients={'alice': {**self.client(), 'totalGB': 100}})
        agent.write_private(self.root / 'state.json', json.dumps(state))
        ledger = {'usage': {'alice': {'up': 60, 'down': 50}}}
        with patch.object(agent.accounting, 'collect', return_value=ledger), patch.object(agent, 'apply_state', side_effect=agent.AgentError('service failed')):
            with self.assertRaises(agent.AgentError):
                agent.accounting.reconcile(agent)
        self.assertNotIn('_quotaBlocked', agent.load_state()['clients']['alice'])
        with patch.object(agent.accounting, 'collect', return_value=ledger):
            agent.accounting.reconcile(agent)
        self.assertTrue(agent.load_state()['clients']['alice']['_quotaBlocked'])

    def test_manual_traffic_reset_preserves_raw_baselines(self):
        state = self.state(clients={'alice': {**self.client(), 'totalGB': 100, '_quotaBlocked': True}})
        agent.write_private(self.root / 'state.json', json.dumps(state))
        agent.write_private(self.root / 'accounting.json', json.dumps({'usage': {'alice': {'up': 200, 'down': 0}}, 'raw': {'1:alice': {'invocation': 'a', 'values': [200, 0]}}}))
        agent.dispatch('/panel/api/clients/resetTraffic/alice', 'POST', {})
        ledger = json.loads((self.root / 'accounting.json').read_text())
        self.assertNotIn('alice', ledger['usage'])
        self.assertIn('1:alice', ledger['raw'])
        self.assertFalse(agent.load_state()['clients']['alice']['_quotaBlocked'])

    def test_inbound_reset_preserves_client_quota_usage(self):
        state = self.state(clients={'alice': self.client()})
        agent.write_private(self.root / 'state.json', json.dumps(state))
        agent.write_private(self.root / 'accounting.json', json.dumps({'usage': {'alice': {'up': 200, 'down': 100}}, 'raw': {}, 'inbounds': {'1': {'up': 200, 'down': 100}}}))
        agent.dispatch('/panel/api/inbounds/1/resetTraffic', 'POST', {})
        ledger = json.loads((self.root / 'accounting.json').read_text())
        self.assertEqual(ledger['usage']['alice']['up'], 200)
        self.assertNotIn('1', ledger['inbounds'])

    def test_failed_client_reset_keeps_usage_until_the_listener_applies(self):
        state = self.state(clients={'alice': {**self.client(), 'totalGB': 100, '_quotaBlocked': True}})
        agent.write_private(self.root / 'state.json', json.dumps(state))
        usage = {'alice': {'up': 180, 'down': 20, 'rawUp': 90, 'rawDown': 10}}
        agent.write_private(self.root / 'accounting.json', json.dumps({'usage': usage, 'raw': {}}))
        with patch.object(agent, 'apply_state', side_effect=agent.AgentError('service failed')):
            with self.assertRaises(agent.AgentError):
                agent.dispatch('/panel/api/clients/resetTraffic/alice', 'POST', {})
        self.assertEqual(json.loads((self.root / 'accounting.json').read_text())['usage'], usage)
        self.assertTrue(agent.load_state()['clients']['alice']['_quotaBlocked'])

    def test_expired_listener_counters_are_collected_before_stopping(self):
        inbound = {**self.inbound(), 'expiryTime': 1}
        state = self.state(inbound, {'alice': self.client()})
        with patch.object(agent.accounting, 'counters', return_value=('a', {'alice': [100, 10]})):
            ledger = agent.accounting.collect(agent, state)
        self.assertEqual(ledger['usage']['alice']['up'], 100)
        self.assertEqual(ledger['inbounds']['1']['down'], 10)

    def tunnel_body(self, role='source', method='wireguard'):
        return {'method': method, 'role': role, 'port': 51830, 'peerPort': 51830, 'listenPort': 1081, 'destinationPort': 443, 'peerHost': 'peer.example.com', 'destinationHost': '127.0.0.1', 'address': '10.83.0.1/30', 'peerAddress': '10.83.0.2/30', 'listenHost': '127.0.0.1'}

    def test_wireguard_tunnel_keeps_private_keys_out_of_responses_and_units(self):
        tunnel_id = '11111111-1111-4111-8111-111111111111'
        with patch.object(agent.shutil, 'which', return_value='/usr/bin/wg-quick'):
            response = agent.tunnels.prepare(agent, tunnel_id, self.tunnel_body())
            self.assertEqual(response, {'publicKey': KEY})
            self.assertEqual(agent.tunnels.prepare(agent, tunnel_id, self.tunnel_body()), response)
            agent.tunnels.commit(agent, tunnel_id, {'publicKey': KEY})
            directory, unit, interface, _ = agent.tunnels.names(agent, tunnel_id)
            text = (directory / (interface + '.conf')).read_text()
            self.assertIn('AllowedIPs = 10.83.0.2/32', text)
            self.assertNotIn(KEY, (agent.UNITS_DIR / unit).read_text())
            agent.tunnels.remove(agent, tunnel_id)
            self.assertFalse(directory.exists())
            self.assertFalse((agent.UNITS_DIR / unit).exists())

    def test_tunnel_rejects_broad_bind_and_command_injection(self):
        with self.assertRaises(agent.AgentError):
            agent.tunnels.validate(agent, {**self.tunnel_body(), 'listenHost': '0.0.0.0'})
        with self.assertRaises(agent.AgentError):
            agent.tunnels.validate(agent, {**self.tunnel_body(), 'peerHost': 'x\nHostKey stolen'})
        with self.assertRaises(agent.AgentError):
            agent.tunnels.names(agent, '../../etc')

    def test_reverse_ssh_pins_host_key_and_binds_loopback(self):
        tunnel_id = '11111111-1111-4111-8111-111111111111'
        directory, unit, _, _ = agent.tunnels.names(agent, tunnel_id)
        directory.mkdir(parents=True)
        agent.write_private(directory / 'setup.json', json.dumps(self.tunnel_body(method='ssh-reverse')))
        key = 'ssh-ed25519 ' + base64.b64encode(b'a' * 51).decode()
        agent.write_private(directory / 'public.json', json.dumps({'publicKey': key}))
        agent.tunnels.commit(agent, tunnel_id, {'publicKey': key, 'user': 'bxt_1234567890'})
        text = (agent.UNITS_DIR / unit).read_text()
        self.assertIn('StrictHostKeyChecking=yes', text)
        self.assertIn('ExitOnForwardFailure=yes', text)
        self.assertIn('"-R" "127.0.0.1:1081:127.0.0.1:443"', text)
        self.assertIn(key, (directory / 'known_hosts').read_text())

    def test_wireguard_export_and_peer_config_preserve_keys(self):
        inbound = self.inbound("wireguard-native", settings={"publicHost": "vpn.example.com", "address": "10.82.0.1/24", "privateKey": KEY})
        client = {**self.client(), "privateKey": KEY, "publicKey": KEY, "allowedIPs": ["10.82.0.2/32"], "preSharedKey": KEY}
        state = self.state(inbound, {"alice": client})
        with patch.object(agent.shutil, "which", return_value="/usr/bin/wg-quick"):
            unit = agent.compile_inbound(inbound, state)
        config = (self.root / "listeners/1/bx1.conf").read_text()
        self.assertIn("AllowedIPs = 10.82.0.2/32", config)
        self.assertIn("ExecStop=", unit)
        profile = next(p for p in agent.client_profiles(state, "alice") if p.startswith("[Interface]"))
        self.assertIn("Endpoint = vpn.example.com:444", profile)
        self.assertIn("PrivateKey = " + KEY, profile)
        self.assertIn("AllowedIPs = 0.0.0.0/0", profile)
        inbound['settings']['internetAccess'] = False
        self.assertIn("AllowedIPs = 10.82.0.0/24", next(p for p in agent.client_profiles(state, "alice") if p.startswith("[Interface]")))

    def test_hysteria_uses_compatible_authenticated_clients_and_tls(self):
        inbound = self.inbound('hysteria', settings={'version': 2})
        inbound['streamSettings'] = {'network': 'hysteria', 'security': 'tls'}
        agent.compile_inbound(inbound, self.state(inbound, {'alice': self.client()}))
        config = json.loads((self.root / 'listeners/1/xray.json').read_text())['inbounds'][0]
        self.assertEqual(config['settings']['clients'][0]['auth'], self.client()['password'])
        self.assertTrue(config['streamSettings']['hysteriaSettings']['auth'])
        inbound['streamSettings']['security'] = 'none'
        with self.assertRaises(agent.AgentError):
            agent.compile_inbound(inbound, self.state(inbound, {}))

    def test_wireguard_key_generation_does_not_require_native_tools(self):
        with patch.object(agent, 'binary', return_value=None), patch.object(agent, 'x25519_keypair', return_value=(KEY, KEY)):
            result = agent.dispatch('/panel/api/server/getNewX25519Cert', 'GET', {})
        self.assertEqual(result, {'privateKey': KEY, 'publicKey': KEY})

    def test_ssh_listener_has_no_root_or_interactive_shell(self):
        inbound = self.inbound("ssh", settings={"publicHost": "vpn.example.com", "allowTcpForwarding": True})
        state = self.state(inbound, {"alice": self.client()})
        unit = agent.compile_inbound(inbound, state)
        config = (self.root / "listeners/1/sshd.conf").read_text()
        self.assertIn("PermitRootLogin no", config)
        self.assertIn("ForceCommand /bin/false", config)
        self.assertIn("AllowUsers " + agent.system_user("alice"), config)
        self.assertNotIn("private-password", config + unit)
        self.assertTrue(any(args == ["chpasswd"] and "private-password" in stdin for args, stdin in self.commands))

    def test_reserved_client_names_work_with_attach_routes(self):
        state = self.state(clients={"update": self.client("update")})
        state["inbounds"].append(self.inbound(number=2))
        agent.write_private(self.root / "state.json", json.dumps(state))
        with patch.object(agent, "apply_state") as apply:
            agent.dispatch("/panel/api/clients/update/attach", "POST", {"inboundIds": [2]})
            updated = apply.call_args.args[0]
            self.assertEqual(updated["clients"]["update"]["inboundIds"], [1, 2])

    def test_failed_config_does_not_leave_new_authorized_files(self):
        inbound = self.inbound()
        old = self.state(inbound)
        directory = self.root / "listeners/1"
        agent.write_private(directory / "old.conf", "old")
        def fail(*_args):
            agent.write_private(directory / "ccd/new-account", "authorized")
            raise agent.AgentError("bad config")
        with patch.object(agent, "compile_inbound", side_effect=fail):
            with self.assertRaises(agent.AgentError):
                agent.apply_state(copy.deepcopy(old), old, {1})
        self.assertFalse((directory / "ccd/new-account").exists())
        self.assertEqual((directory / "old.conf").read_text(), "old")

    def test_only_benx_service_names_are_generated(self):
        self.assertEqual(agent.unit_name(self.inbound("ssh", number=17)), "benx-openssh-17.service")
        self.assertNotEqual(agent.unit_name(self.inbound("ssh")), "ssh.service")
        with self.assertRaises(agent.AgentError):
            agent.start_job("openssh; reboot", "install", self.state())

    def test_failed_ssh_edit_restores_existing_account_password(self):
        old = self.state(self.inbound("ssh"), {"alice": self.client()})
        new = copy.deepcopy(old)
        new["clients"]["alice"]["password"] = "new-password"
        def fail(*_args):
            agent.run(["chpasswd"], input_text=agent.system_user("alice") + ":new-password\n")
            raise agent.AgentError("bad config")
        with patch.object(agent, "compile_inbound", side_effect=fail):
            with self.assertRaises(agent.AgentError):
                agent.apply_state(new, old, {1})
        passwords = [stdin for args, stdin in self.commands if args == ["chpasswd"]]
        self.assertEqual(passwords[-1], agent.system_user("alice") + ":private-password\n")

    def test_masterdns_archive_rejects_tampering_and_symlinks(self):
        def archive(link=False):
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as files:
                info = tarfile.TarInfo("../../MasterDnsVPN_Server_Linux_AMD64_v2026.test")
                if link:
                    info.type = tarfile.SYMTYPE
                    info.linkname = "/etc/shadow"
                    files.addfile(info)
                else:
                    info.size = 6
                    files.addfile(info, io.BytesIO(b"binary"))
            return buffer.getvalue()
        data = archive()
        asset = {"sha256": hashlib.sha256(data).hexdigest()}
        self.assertEqual(agent.masterdns_binary(data, asset), b"binary")
        with self.assertRaises(agent.AgentError):
            agent.masterdns_binary(data + b"tampered", asset)
        data = archive(link=True)
        with self.assertRaises(agent.AgentError):
            agent.masterdns_binary(data, {"sha256": hashlib.sha256(data).hexdigest()})

    def test_cloned_inbound_preserves_centralized_client_credentials(self):
        state = self.state(clients={"alice": self.client()})
        agent.write_private(self.root / "state.json", json.dumps(state))
        clone = self.inbound(number=2, settings={"clients": [{**self.client(), "password": "stale"}]})
        with patch.object(agent, "apply_state") as apply:
            agent.dispatch("/panel/api/inbounds/add", "POST", clone)
            updated = apply.call_args.args[0]
        self.assertEqual(updated["clients"]["alice"]["password"], "private-password")
        self.assertEqual(updated["clients"]["alice"]["inboundIds"], [1, 2])

    def test_http_authentication_precedes_actions_and_rejects_invalid_bodies(self):
        server = agent.ThreadingHTTPServer(("127.0.0.1", 0), agent.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with patch.object(agent, "TOKEN", "test-token"), patch.object(agent, "dispatch", return_value={"saved": True}) as dispatch:
                def request(token, body):
                    connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                    connection.request("POST", "/panel/api/clients/add", body, {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
                    response = connection.getresponse()
                    result = response.status, json.loads(response.read())
                    connection.close()
                    return result
                self.assertEqual(request("wrong-token", '{}')[0], 401)
                dispatch.assert_not_called()
                self.assertEqual(request("test-token", '[]')[0], 400)
                dispatch.assert_not_called()
                self.assertEqual(request("test-token", '{}')[0], 200)
                dispatch.assert_called_once()
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == "__main__":
    unittest.main()
