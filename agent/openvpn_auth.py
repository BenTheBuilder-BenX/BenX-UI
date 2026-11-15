#!/usr/bin/env python3
"""OpenVPN username/password verifier; no credential output."""
import argparse
import hashlib
import hmac
import json
from pathlib import Path
import sys
import time


def allowed(state, inbound, username, password):
    if not username or not password:
        return False
    listener = next((i for i in state.get('inbounds', []) if i['id'] == inbound), None)
    if not listener or listener.get('enable') is False or listener.get('expiryTime', 0) > 0 and listener['expiryTime'] <= time.time() * 1000:
        return False
    for email, client in state.get('clients', {}).items():
        name = 'benx_' + hashlib.sha256(email.encode()).hexdigest()[:20]
        expiry = client.get('expiryTime', 0)
        if inbound in client.get('inboundIds', []) and client.get('enable', True) and not client.get('_quotaBlocked') and (expiry <= 0 or expiry > time.time() * 1000) and hmac.compare_digest(name, username) and hmac.compare_digest(str(client.get('password', '')).encode(), password.encode()):
            return True
    return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--state', required=True)
    parser.add_argument('--inbound', required=True, type=int)
    parser.add_argument('credentials')
    args = parser.parse_args()
    try:
        credentials = Path(args.credentials).read_text().splitlines()
        state = json.loads(Path(args.state).read_text())
        return 0 if len(credentials) >= 2 and allowed(state, args.inbound, credentials[0], credentials[1]) else 1
    except (OSError, ValueError, KeyError, TypeError):
        return 1


if __name__ == '__main__':
    sys.exit(main())
