from pathlib import Path
import socket
import ssl
import sys
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).parents[1]))
import reality_probe


class RealityProbeTests(unittest.TestCase):
    def test_private_targets_are_blocked_before_connect_even_with_allow_private(self):
        resolved=[(socket.AF_INET,socket.SOCK_STREAM,6,'',('127.0.0.1',443))]
        with patch.object(reality_probe.socket,'getaddrinfo',return_value=resolved), patch.object(reality_probe.socket,'socket') as connection:
            result=reality_probe.scan({'target':'local.example','allowPrivate':True})
        self.assertFalse(result['feasible']); self.assertTrue(result['privateTarget']); connection.assert_not_called()

    def test_success_requires_trusted_tls13_x25519_and_h2_and_pins_resolved_address(self):
        resolved=[(socket.AF_INET6,socket.SOCK_STREAM,6,'',('2606:4700:4700::1111',443,0,0)),(socket.AF_INET,socket.SOCK_STREAM,6,'',('1.1.1.1',443))]
        context=Mock(); raw=Mock(); raw.__enter__=Mock(return_value=raw); raw.__exit__=Mock(return_value=False)
        tls=Mock(); tls.__enter__=Mock(return_value=tls); tls.__exit__=Mock(return_value=False)
        tls.getpeercert.return_value={'subjectAltName':[('DNS','www.cloudflare.com')]};tls.selected_alpn_protocol.return_value='h2'
        context.wrap_socket.return_value=tls
        with patch.object(reality_probe.socket,'getaddrinfo',return_value=resolved), patch.object(reality_probe.socket,'socket',return_value=raw), patch.object(reality_probe.ssl,'create_default_context',return_value=context):
            result=reality_probe.scan({'target':'www.cloudflare.com:443'})
        self.assertTrue(result['feasible']); raw.connect.assert_called_once_with(('1.1.1.1',443))
        self.assertEqual(context.minimum_version,ssl.TLSVersion.TLSv1_3)
        context.set_ecdh_curve.assert_called_once_with('X25519')
        context.wrap_socket.assert_called_once_with(raw,server_hostname='www.cloudflare.com')

    def test_discovery_is_bounded_and_injection_is_rejected(self):
        with self.assertRaises(ValueError): reality_probe.discover({'targets':','.join(['www.cloudflare.com']*17)})
        with patch.object(reality_probe.socket,'getaddrinfo') as resolve:
            self.assertFalse(reality_probe.scan({'target':'example.com;reboot'})['feasible'])
        resolve.assert_not_called()


if __name__ == '__main__': unittest.main()
