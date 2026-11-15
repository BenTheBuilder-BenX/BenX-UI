import time
import unittest
import openvpn_auth


class PasswordTests(unittest.TestCase):
    def test_credentials_are_scoped_to_listener_and_customer_state(self):
        state = {'inbounds': [{'id': 1}], 'clients': {'alice': {'inboundIds': [1], 'password': 'secret'}}}
        user = 'benx_' + openvpn_auth.hashlib.sha256(b'alice').hexdigest()[:20]
        self.assertTrue(openvpn_auth.allowed(state, 1, user, 'secret'))
        self.assertFalse(openvpn_auth.allowed(state, 1, user, 'wrong'))
        self.assertFalse(openvpn_auth.allowed(state, 2, user, 'secret'))
        self.assertFalse(openvpn_auth.allowed(state, 1, 'alice', 'secret'))
        state['clients']['alice']['enable'] = False
        self.assertFalse(openvpn_auth.allowed(state, 1, user, 'secret'))
        state['clients']['alice']['enable'] = True
        state['clients']['alice']['expiryTime'] = time.time() * 1000 - 1000
        self.assertFalse(openvpn_auth.allowed(state, 1, user, 'secret'))

    def test_empty_credentials_never_authenticate(self):
        self.assertFalse(openvpn_auth.allowed({'clients': {}}, 1, '', ''))
