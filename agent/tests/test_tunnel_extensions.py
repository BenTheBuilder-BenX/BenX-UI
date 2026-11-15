import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).parents[1]))
import certificates
import tunnel_adapters
import tunnel_probe
import tunnel_tools

class Error(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

class ExtensionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.commands = []
        def write(path, text):
            path.parent.mkdir(parents=True, exist_ok=True); path.write_text(text, encoding='utf-8')
        def run(args, **kwargs):
            self.commands.append(args)
            return '--ip-address' if args[-2:] == ['--help', 'all'] else ''
        self.agent = SimpleNamespace(ROOT=self.root, UNITS_DIR=self.root/'units', AgentError=Error, write_private=write, run=run, unit_text=lambda args: '[Service]\nType=simple\nExecStart='+' '.join(args)+'\nRestart=on-failure\nRestartSec=3\n', server_setup=SimpleNamespace(install_packages=Mock()), tunnels=SimpleNamespace(names=lambda agent, id: (self.root, '', '', '')))
    def tearDown(self):
        tunnel_probe.stop(self.agent, 'test'); self.tmp.cleanup()
    def test_backhaul_pairs_private_tokens_and_only_exposes_loopback_forwarding(self):
        import tomllib
        for transport in ['tcp','tcpmux','ws']:
            data={'method':'backhaul-'+transport,'role':'target','port':32100,'listenPort':32101,'destinationHost':'127.0.0.1','destinationPort':32102,'peerHost':'1.1.1.1','peerPort':32100}
            own=tunnel_adapters.prepare(self.agent,self.root,data)
            (self.root/'public.json').write_text(json.dumps(own))
            command=tunnel_adapters.commit(self.agent,self.root,data,{},'benx-test')
            conf=tomllib.loads((self.root/'backhaul.toml').read_text())['server']
            self.assertEqual(conf['ports'],['127.0.0.1:32101=127.0.0.1:32102'])
            self.assertFalse(conf['sniffer']);self.assertEqual(conf['web_port'],0)
            self.assertIn('backhaul',command)
            data['role']='source'
            tunnel_adapters.commit(self.agent,self.root,data,own,'benx-test')
            self.assertEqual(tomllib.loads((self.root/'backhaul.toml').read_text())['client']['token'],own['token'])
            with self.assertRaises(Error):tunnel_adapters.commit(self.agent,self.root,data,{'token':'x;reboot'},'benx-test')
    def test_multiple_certificate_domains_are_deduplicated_and_validated(self):
        request={'target':'both','domain':'vpn.example.com','domains':['cdn.example.com','vpn.example.com'],'ip':'1.1.1.1','email':'admin@example.com'}
        self.assertEqual(certificates.targets(self.agent,request),[('domain','vpn.example.com'),('domain','cdn.example.com'),('ip','1.1.1.1')])
        with self.assertRaises(Error):certificates.targets(self.agent,{**request,'domains':['x;reboot']})
    def test_ip_and_domain_issuance_remembers_distinct_paths_and_owned_renewal(self):
        request = {'enabled': True, 'target': 'both', 'domain': 'vpn.example.com', 'ip': '1.1.1.1', 'email': 'admin@example.com'}
        with patch.object(certificates.socket, 'getaddrinfo'), patch.object(certificates.socket, 'socket'), patch.object(Path, 'is_file', return_value=True), patch.object(certificates.shutil, 'which', return_value='/usr/bin/certbot'):
            certificates.issue(self.agent, request)
        commands = [c for c in self.commands if 'certonly' in c]
        self.assertEqual(len(commands), 2)
        ip_command = next(c for c in commands if '--ip-address' in c)
        self.assertIn('--required-profile', ip_command); self.assertIn('shortlived', ip_command)
        saved = json.loads((self.root/'certificate.json').read_text()); self.assertEqual(len(saved['entries']), 2)
        self.assertEqual({e['identifier'] for e in saved['entries']}, {'vpn.example.com', '1.1.1.1'})
        self.assertNotEqual(saved['entries'][0]['certificateFile'], saved['entries'][1]['certificateFile'])
        self.assertIn('--cert-name', (self.root/'renew-certificates.py').read_text())
        self.assertIn('00,06,12,18', (self.agent.UNITS_DIR/'benx-certificate-renew.timer').read_text())
    def test_certificates_reject_private_ips_and_command_injection_before_commands(self):
        for ip in ['127.0.0.1', '10.0.0.1', '100.64.1.1', '1.1.1.1;reboot', '::1']:
            with self.assertRaises(Error): certificates.targets(self.agent, {'target':'ip', 'ip':ip, 'email':'a@example.com'})
        self.assertEqual(self.commands, [])
    def test_old_certbot_uses_owned_venv_instead_of_upgrading_system_python(self):
        self.agent.run = Mock(return_value='')
        with patch.object(certificates.socket, 'socket'), patch.object(Path, 'is_file', return_value=True), patch.object(certificates.shutil, 'which', return_value='/usr/bin/certbot'):
            certificates.issue(self.agent, {'target':'ip','ip':'1.1.1.1','email':'a@example.com'})
        commands = [c.args[0] for c in self.agent.run.call_args_list]
        self.assertTrue(any('certbot==5.3.0' in c for c in commands))
        self.assertTrue(any(str(self.root/'certbot-venv/bin/certbot') == c[0] and 'certonly' in c for c in commands))
    def test_stock_renewal_timer_uses_ip_capable_certbot_but_custom_jobs_are_preserved(self):
        executable = str(self.root/'certbot-venv/bin/certbot')
        self.agent.run = Mock(return_value='[Service]\nExecStart=/usr/bin/certbot -q renew\n')
        self.assertTrue(certificates.system_renewal_compatibility(self.agent, executable))
        dropin = self.agent.UNITS_DIR/'certbot.service.d/20-benx-ip-compat.conf'
        self.assertIn(executable, dropin.read_text())
        dropin.unlink()
        self.agent.run = Mock(return_value='ExecStart=/usr/bin/certbot renew --config /custom.conf\n')
        self.assertFalse(certificates.system_renewal_compatibility(self.agent, executable))
        self.assertFalse(dropin.exists())
    def test_replacement_remembers_paths_but_does_not_claim_missing_files_are_available(self):
        old = {'identifier':'vpn.example.com','certificateFile':'/old/fullchain.pem','keyFile':'/old/privkey.pem'}
        issued = {'identifier':'1.1.1.1','certificateFile':str(self.root/'certificates'/('a'*32)/'fullchain.pem'),'keyFile':str(self.root/'certificates'/('a'*32)/'privkey.pem')}
        (self.root/'certificate-paths.json').write_text(json.dumps({'entries':[old]}))
        (self.root/'certificate.json').write_text(json.dumps({'entries':[issued]}))
        for field in ['certificateFile','keyFile']: self.agent.write_private(Path(issued[field]),'fixture')
        result = certificates.remembered(self.agent)
        self.assertEqual(result['identifier'],'1.1.1.1')
        self.assertFalse(next(e for e in result['entries'] if e['identifier']=='vpn.example.com')['available'])
    def test_certificate_inventory_never_reads_arbitrary_profile_paths(self):
        (self.root/'secret').write_text('not a certificate')
        (self.root/'certificate-paths.json').write_text(json.dumps({'entries':[{'identifier':'evil.example','certificateFile':str(self.root/'secret'),'keyFile':str(self.root/'secret')}] }))
        result=certificates.remembered(self.agent)
        self.assertFalse(result['available']);self.assertFalse(self.commands)
    def test_gre_installs_only_the_required_distro_tools_when_missing(self):
        with patch.object(tunnel_tools.shutil,'which',return_value=None):
            self.assertFalse(tunnel_tools.ready(self.agent,'gre'))
            tunnel_tools.install(self.agent,'gre')
        self.agent.server_setup.install_packages.assert_called_once_with(self.agent,['iproute2'])
    def test_real_authenticated_probe_counts_acknowledged_upload_and_received_download(self):
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0)); port = reservation.getsockname()[1]
        (self.root/'setup.json').write_text(json.dumps({'method':'ssh-direct','role':'source','address':'10.0.0.1/30','peerAddress':'10.0.0.2/30','listenPort':port,'destinationPort':port}))
        token = 'a'*64
        self.assertTrue(tunnel_probe.start(self.agent, 'test', {'token':token})['ready'])
        result = tunnel_probe.measure(self.agent, 'test', {'token':token, 'byteLimit':65536, 'host':'ignored-untrusted-host'})
        self.assertEqual(result['state'],'passed'); self.assertEqual(result['bytes'],131072); self.assertEqual(result['lossPercent'],0)
        self.assertGreater(result['uploadMbps'],0); self.assertGreater(result['downloadMbps'],0)
        self.assertTrue(tunnel_probe.stop(self.agent,'test')['stopped'])
    def test_probe_rejects_excessive_payload_and_invalid_auth(self):
        (self.root/'setup.json').write_text(json.dumps({'method':'ssh-direct','role':'source','address':'10.0.0.1/30','peerAddress':'10.0.0.2/30','listenPort':1234,'destinationPort':1235}))
        for body in [{'token':'bad'}, {'token':'a'*64,'byteLimit':100*1024*1024}]:
            with self.assertRaises(Error): tunnel_probe.measure(self.agent,'test',body)
    def test_hysteria_recipe_trusts_paired_ca_and_never_disables_verification(self):
        (self.root/'public.json').write_text('{}')
        data={'method':'phormal-relay','role':'source','peerHost':'8.8.8.8','peerPort':8443,'listenHost':'127.0.0.1','listenPort':1081,'destinationHost':'127.0.0.1','destinationPort':443}
        peer={'certificate':'-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----','token':'test-token','obfs':'test-obfs'}
        tunnel_adapters.commit(self.agent,self.root,data,peer,'bt1234')
        config=json.loads((self.root/'phormal.json').read_text())
        self.assertEqual(config['tls']['ca'],str(self.root/'peer.crt')); self.assertNotIn('insecure',config['tls'])
        self.assertEqual(config['obfs']['type'],'salamander'); self.assertEqual(config['tcpForwarding'][0]['listen'],'127.0.0.1:1081')
    def test_frp_wss_terminates_verified_tls_before_a_private_backend(self):
        (self.root/'public.json').write_text(json.dumps({'token':'test-token'}))
        data={'method':'frp-wss','role':'target','port':8443,'listenPort':1081}
        unit=tunnel_adapters.commit(self.agent,self.root,data,{},'bt1234')
        config=json.loads((self.root/'frp.json').read_text())
        self.assertEqual(config['bindAddr'],'127.0.0.1')
        self.assertNotEqual(config['bindPort'],8443)
        self.assertEqual(config['proxyBindAddr'],'127.0.0.1')
        self.assertIn('tunnel_tls_bridge.py',unit)
        self.assertIn('--port 8443',unit)
        self.assertIn('--cert',unit)
        self.assertIn('--key',unit)
    def test_pinned_download_tampering_does_not_install_a_binary(self):
        response=Mock();response.__enter__=Mock(return_value=response);response.__exit__=Mock(return_value=False);response.read.return_value=b'untrusted-binary'
        with patch.object(tunnel_tools.platform,'machine',return_value='x86_64'), patch.object(tunnel_tools,'urlopen',return_value=response):
            with self.assertRaisesRegex(Error,'checksum'): tunnel_tools.install(self.agent,'hedioum')
        self.assertFalse(tunnel_tools.binary(self.agent,'hedioum','source').exists())

if __name__ == '__main__': unittest.main()
