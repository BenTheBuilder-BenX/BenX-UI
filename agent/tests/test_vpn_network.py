import json
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
sys.path.insert(0, str(Path(__file__).parents[1]))
import vpn_network


class NetworkTests(unittest.TestCase):
    def test_health_detects_missing_owned_rules_and_disabled_forwarding(self):
        mode = {'missing':False,'forwarding':'1'}
        def run(args, **kwargs):
            if args[0] == 'sysctl': return SimpleNamespace(stdout=mode['forwarding'], returncode=0)
            if args[0] == 'ip': return SimpleNamespace(stdout='[{"dev":"ens3"}]', returncode=0)
            return SimpleNamespace(returncode=1 if mode['missing'] else 0)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root/'vpn-network').mkdir()
            (root/'vpn-network/7.json').write_text('{"subnet":"10.80.10.0/24","device":"ens3"}')
            self.assertTrue(vpn_network.healthy(7, '10.80.10.0/24', root, run))
            mode['missing'] = True
            self.assertFalse(vpn_network.healthy(7, '10.80.10.0/24', root, run))
            mode.update(missing=False, forwarding='0')
            self.assertFalse(vpn_network.healthy(7, '10.80.10.0/24', root, run))
    def test_rules_are_scoped_to_private_vpn_and_never_touch_input_or_flush(self):
        entries = vpn_network.rules(7, '10.80.10.0/24', 'ens3')
        self.assertEqual([e[1] for e in entries], ['FORWARD', 'FORWARD', 'POSTROUTING'])
        self.assertTrue(all('benx-vpn-7' in args for _, _, args in entries))
        self.assertTrue(all('ens3' in args for _, _, args in entries))
        for subnet in ['0.0.0.0/0', '8.8.8.0/24', '127.0.0.0/24', '10.0.0.0/8']:
            with self.assertRaises(ValueError): vpn_network.rules(7, subnet, 'ens3')

    def test_stop_removes_only_exact_owned_rules_and_remembers_original_interface(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args[0] == 'ip': return SimpleNamespace(stdout=json.dumps([{'dev':'ens3'}]), returncode=0)
            return SimpleNamespace(returncode=1 if '-C' in args else 0)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            vpn_network.change('up', 7, '10.80.10.0/24', root, run)
            marker = root / 'vpn-network/7.json'
            self.assertEqual(json.loads(marker.read_text())['device'], 'ens3')
            self.assertEqual(sum('-I' in args for args in calls), 3)
            calls.clear()
            def stop(args, **kwargs):
                calls.append(args)
                return SimpleNamespace(returncode=0)
            vpn_network.change('down', 7, '10.80.10.0/24', root, stop)
            self.assertEqual(sum('-D' in args for args in calls), 3)
            self.assertFalse(marker.exists())
            self.assertFalse(any(args[0] == 'ip' or '-F' in args or '-P' in args for args in calls))

    def test_partial_failure_rolls_back_only_rules_added_by_this_attempt(self):
        calls = []
        def run(args, **kwargs):
            calls.append(args)
            if args[0] == 'ip': return SimpleNamespace(stdout='[{"dev":"ens3"}]', returncode=0)
            if '-I' in args and 'nat' in args: raise RuntimeError('NAT unavailable')
            return SimpleNamespace(returncode=1 if '-C' in args else 0)
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(RuntimeError): vpn_network.change('up', 7, '10.80.10.0/24', Path(directory), run)
            self.assertEqual(sum('-D' in args for args in calls), 2)
            self.assertFalse((Path(directory)/'vpn-network/7.json').exists())


if __name__ == '__main__': unittest.main()
