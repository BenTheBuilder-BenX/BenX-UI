import json
import sys
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).parents[1]))
import benx_agent as agent
import dns_service


class DNSTests(unittest.TestCase):
    def row(self):
        return {'id': 20, 'protocol': 'dns-resolver', 'port': 5353, 'listen': '192.0.2.1', 'settings': {'upstreams': ['1.1.1.1'], 'allowedClients': ['192.0.2.2/32'], 'cache': True, 'rateLimit': 20, 'cacheSize': 1048576}}

    def test_secondary_port_conflict(self):
        row = self.row(); row['settings'].update(httpsPort=443, certificateFile='/c', keyFile='/k')
        with self.assertRaisesRegex(agent.AgentError, 'conflict'):
            dns_service.validate(agent, row, {'inbounds': [row, {'id': 1, 'protocol': 'vless', 'port': 443}]})

    def test_masterdns_conflict_and_separate_transports(self):
        row = self.row(); row['settings'].update(tlsPort=853, quicPort=853, certificateFile='/c', keyFile='/k')
        dns_service.validate(agent, row, {'inbounds': [row, {'id': 1, 'protocol': 'masterdnsvpn', 'port': 53}]})
        row['port'] = 53
        with self.assertRaisesRegex(agent.AgentError, 'conflict'):
            dns_service.validate(agent, row, {'inbounds': [row, {'id': 1, 'protocol': 'masterdnsvpn', 'port': 53}]})

    def test_private_acl_and_no_shell_in_unit(self):
        row = self.row()
        with tempfile.TemporaryDirectory() as temp, patch.object(agent, 'binary', return_value='/usr/local/bin/benx-dnsproxy'):
            unit = dns_service.compile(agent, row, {'inbounds': [row]}, Path(temp))
            self.assertIn('--cache', unit)
            self.assertIn('ExecStartPre=', unit)
            self.assertNotIn('/bin/sh', unit)
            self.assertEqual(json.loads((Path(temp)/'dns-access.json').read_text())['allowed'], ['192.0.2.2/32'])

    def test_empty_acl_and_invalid_upstream_are_rejected(self):
        row = self.row(); row['settings']['allowedClients'] = []
        with self.assertRaises(agent.AgentError): dns_service.validate(agent, row, {'inbounds': [row]})

    def test_health_accepts_iptables_canonical_any_source_but_rejects_changed_acl(self):
        from types import SimpleNamespace
        row = self.row()
        row['settings']['allowedClients'] = ['0.0.0.0/0']
        canonical = '-N BXD20\n-A BXD20 -s 127.0.0.0/8 -j ACCEPT\n-A BXD20 -j ACCEPT\n-A BXD20 -j DROP\n'
        with patch.object(dns_service.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=canonical)):
            self.assertTrue(dns_service.healthy(row))
        changed = canonical.replace('-A BXD20 -j DROP', '-A BXD20 -j ACCEPT')
        with patch.object(dns_service.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout=changed)):
            self.assertFalse(dns_service.healthy(row))
        row = self.row(); row['settings']['upstreams'] = ['--bogus']
        with self.assertRaises(agent.AgentError): dns_service.validate(agent, row, {'inbounds': [row]})

    def test_firewall_cleans_old_ports_without_flushing_shared_chains(self):
        from types import SimpleNamespace
        commands = []
        def run(args, **kw):
            commands.append(args)
            return SimpleNamespace(returncode=0, stdout='-A INPUT -p tcp --dport 443 -j BXD20\n-A INPUT -p tcp --dport 22 -j OTHER\n' if '-S' in args else '')
        with patch.object(dns_service.subprocess, 'run', side_effect=run):
            dns_service.firewall('up', {'id': 20, 'listen': '192.0.2.1', 'endpoints': [(5353, 'any')], 'allowed': ['192.0.2.2/32']})
        self.assertTrue(any('-D' in c and '443' in c for c in commands))
        self.assertFalse(any('-F' in c and c[-1] != 'BXD20' for c in commands))
        self.assertFalse(any('-D' in c and 'OTHER' in c for c in commands))
