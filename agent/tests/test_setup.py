import importlib.util
import json
import sqlite3
from contextlib import closing
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock
import sys
sys.path.insert(0, str(Path(__file__).parents[1]))
import setup

class SetupError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

class SetupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        def write(path, text):
            Path(path).parent.mkdir(parents=True, exist_ok=True)
            Path(path).write_text(text)
        self.agent = SimpleNamespace(ROOT=self.root, AgentError=SetupError, LOCK=threading.RLock(), INSTALLING=False, JOBS=[], write_private=write, run=Mock(return_value=''), binary=Mock(return_value=None), PACKAGE_POLICY=self.root / 'policy', CORES={'openvpn': {'packages': ['openvpn','openssl']}}, install_masterdns=Mock())
        self.plan = {'panel':'native','cores':['xray'],'bbr':False,'certificate':{'enabled':False,'domain':'','email':''}}
    def tearDown(self):
        self.tmp.cleanup()
    def test_rejects_unsupported_core_and_certificate_injection(self):
        with self.assertRaises(SetupError):
            setup.validate(self.agent, {**self.plan, 'cores':['shell']})
        with self.assertRaises(SetupError):
            setup.validate(self.agent, {**self.plan, 'certificate':{'enabled':True,'domain':'a.example;reboot','email':'a@example.com'}})
    def test_existing_core_is_retained_without_install_commands(self):
        self.agent.binary.return_value = '/existing/xray'
        self.assertIn('retained', setup.install_core(self.agent, 'xray'))
        self.agent.run.assert_not_called()

    def test_fresh_ocserv_package_does_not_enable_an_unconfigured_vendor_listener(self):
        self.agent.CORES['ocserv'] = {'packages': ['ocserv']}
        self.agent.binary.side_effect = [None, '/usr/sbin/ocserv']
        with patch.object(setup, 'install_packages'), patch.object(setup.shutil, 'which', return_value='/usr/sbin/iptables'):
            setup.install_core(self.agent, 'ocserv')
        self.agent.run.assert_any_call(['systemctl', 'disable', '--now', 'ocserv.service'])
        self.agent.binary.side_effect = None
        self.agent.binary.return_value = '/existing/ocserv'
        self.agent.run.reset_mock()
        with patch.object(setup.shutil, 'which', return_value='/usr/sbin/iptables'):
            setup.install_core(self.agent, 'ocserv')
        self.agent.run.assert_not_called()

    def test_private_panel_binds_subscription_and_admin_without_changing_other_settings(self):
        database = self.root / 'panel.db'
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute('CREATE TABLE settings(id INTEGER PRIMARY KEY, key TEXT, value TEXT)')
            connection.executemany('INSERT INTO settings(key,value) VALUES(?,?)', [('webListen', ''), ('webPort', '2053'), ('apiToken', 'private-token')])
        self.assertTrue(setup.private_panel_bindings(self.agent, database))
        with closing(sqlite3.connect(database)) as connection:
            settings = dict(connection.execute('SELECT key,value FROM settings'))
        self.assertEqual(settings, {'webListen':'127.0.0.1','subListen':'127.0.0.1','webPort':'2053','apiToken':'private-token'})
        self.agent.run.assert_called_once_with(['systemctl','restart','x-ui'])
        self.agent.run.reset_mock()
        self.assertFalse(setup.private_panel_bindings(self.agent, database))
        self.agent.run.assert_not_called()
    def test_package_policy_is_restored_after_failed_install(self):
        self.agent.run.side_effect = SetupError('apt failed')
        with self.assertRaises(SetupError):
            setup.install_packages(self.agent, ['openvpn'])
        self.assertFalse(self.agent.PACKAGE_POLICY.exists())
    def test_existing_package_policy_is_never_overwritten(self):
        self.agent.PACKAGE_POLICY.write_text('existing policy')
        setup.install_packages(self.agent, ['openvpn'])
        self.assertEqual(self.agent.PACKAGE_POLICY.read_text(), 'existing policy')
    def test_bbr_unsupported_does_not_change_sysctl_configuration(self):
        self.agent.run.return_value = 'reno cubic'
        with patch.object(setup,'install_packages'), patch.object(setup,'BBR_FILE', self.root / 'bbr'):
            with self.assertRaisesRegex(SetupError,'does not support BBR'):
                setup.enable_bbr(self.agent)
            self.assertFalse((self.root / 'bbr').exists())
    def test_bbr_failure_restores_previous_values(self):
        def run(args, **kwargs):
            if args == ['sysctl','-n','net.ipv4.tcp_available_congestion_control']:
                return 'reno cubic bbr'
            if args == ['sysctl','-p',str(self.root / 'bbr')]:
                raise SetupError('failed')
            return 'cubic' if args[-1] == 'net.ipv4.tcp_congestion_control' else 'fq_codel'
        self.agent.run.side_effect = run
        with patch.object(setup,'install_packages'), patch.object(setup,'BBR_FILE', self.root / 'bbr'):
            with self.assertRaises(SetupError):
                setup.enable_bbr(self.agent)
            self.assertFalse((self.root / 'bbr').exists())
            self.agent.run.assert_any_call(['sysctl','-w','net.ipv4.tcp_congestion_control=cubic'],check=False)
    def test_optional_failure_does_not_skip_later_steps_and_status_is_persistent(self):
        self.plan['bbr'] = True
        class ImmediateThread:
            def __init__(self,target,**kwargs): self.target = target
            def start(self): self.target()
        with patch.object(setup,'validate',side_effect=lambda a,p:p), patch.object(setup.threading,'Thread',ImmediateThread), patch.object(setup,'install_core',side_effect=SetupError('download failed')), patch.object(setup,'enable_bbr',return_value='BBR enabled'):
            job = setup.start(self.agent,self.plan)
            self.assertEqual(job['state'],'failed')
            self.assertEqual([s['state'] for s in job['steps']],['failed','succeeded'])
            self.assertEqual(json.loads((self.root / 'setup-status.json').read_text()),job)
            self.assertFalse(self.agent.INSTALLING)
    def test_setup_actions_are_serialized(self):
        self.agent.INSTALLING = True
        with patch.object(setup,'validate',side_effect=lambda a,p:p), self.assertRaisesRegex(SetupError,'Wait'):
            setup.start(self.agent,self.plan)
    def test_restart_marks_interrupted_work_and_retains_completed_steps(self):
        job = {'state':'running','steps':[{'state':'succeeded'},{'state':'running'}]}
        (self.root / 'setup-status.json').write_text(json.dumps(job))
        setup.startup(self.agent)
        saved = json.loads((self.root / 'setup-status.json').read_text())
        self.assertEqual(saved['state'],'failed')
        self.assertEqual([s['state'] for s in saved['steps']],['succeeded','failed'])
    def test_certificate_does_not_stop_a_busy_web_server(self):
        with patch.object(setup.socket,'getaddrinfo'), patch.object(setup.socket,'socket') as sock:
            sock.return_value.__enter__.return_value.bind.side_effect = OSError('busy')
            with self.assertRaisesRegex(SetupError,'port 80'):
                setup.certificate(self.agent,{'domain':'a.example.com','email':'a@example.com'})
            self.agent.run.assert_not_called()
    def test_private_panel_bridge_pins_loopback_and_rejects_unlisted_paths(self):
        (self.root / 'installed-panel.json').write_text(json.dumps({'basePath':'/privatepath/','token':'private-token'}))
        with self.assertRaises(SetupError):
            setup.panel_request(self.agent, {'path':'/panel/api/../login','method':'GET'})
        with self.assertRaises(SetupError):
            setup.panel_request(self.agent, {'path':'/panel/api/shell','method':'POST'})
        with patch.object(setup.http.client,'HTTPConnection') as connection:
            response = connection.return_value.getresponse.return_value
            response.status = 200
            response.read.return_value = b'{"success":true,"obj":[]}'
            response.getheader.side_effect = lambda name,default='': 'application/json' if name == 'Content-Type' else default
            result = setup.panel_request(self.agent, {'path':'/panel/api/inbounds/list','method':'GET'})
            connection.assert_called_once_with('127.0.0.1',2053,timeout=15)
            self.assertEqual(connection.return_value.request.call_args.args[:2], ('GET','/privatepath/panel/api/inbounds/list'))
            self.assertEqual(connection.return_value.request.call_args.kwargs['headers']['Authorization'],'Bearer private-token')
            self.assertEqual(result['status'],200)
            self.assertNotIn('private-token',json.dumps(result))
    def test_private_panel_bridge_rejects_redirects_and_oversized_downloads(self):
        (self.root / 'installed-panel.json').write_text(json.dumps({'basePath':'/privatepath/','token':'private-token'}))
        with patch.object(setup.http.client,'HTTPConnection') as connection:
            response = connection.return_value.getresponse.return_value
            response.read.return_value = b'a' * (2 * 1024 * 1024 + 1)
            with self.assertRaisesRegex(SetupError,'2 MB'):
                setup.panel_request(self.agent, {'path':'/panel/api/inbounds/list','method':'GET'})
            response.read.return_value = b'private-redirect'
            response.status = 302
            with self.assertRaisesRegex(SetupError,'redirected'):
                setup.panel_request(self.agent, {'path':'/panel/api/inbounds/list','method':'GET'})
    def test_pinned_installer_checksum_matches_checked_in_source(self):
        import hashlib
        root = Path(__file__).parents[1]
        manifest = json.loads((root / '3x-ui-release.json').read_text())
        self.assertEqual(hashlib.sha256((root / '3x-ui-install.sh').read_bytes()).hexdigest(),manifest['installerSha256'])
        self.assertEqual((root / '3x-ui-install.sh').read_text(encoding='utf-8').count('bind_local="n"'),1)

if __name__ == '__main__': unittest.main()
