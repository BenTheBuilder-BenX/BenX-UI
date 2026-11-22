"""Bounded authenticated payload measurement through a disposable tunnel."""
import hmac
import ipaddress
import json
import os
import secrets
import socket
import struct
import threading
import time

SERVERS = {}
LOCK = threading.Lock()
LIMIT = 16 * 1024 * 1024


def receive(sock, count, deadline=None):
    chunks = []
    while count:
        if deadline is not None:
            left = deadline - time.monotonic()
            if left <= 0:
                raise socket.timeout('The bounded tunnel sample exceeded ten seconds.')
            sock.settimeout(min(1.5, left))
        data = sock.recv(min(count, 65536))
        if not data:
            raise OSError('Peer closed the test stream.')
        chunks.append(data); count -= len(data)
    return b''.join(chunks)


def start(agent, tunnel_id, body):
    directory, _, _, _ = agent.tunnels.names(agent, tunnel_id)
    data = json.loads((directory / 'setup.json').read_text())
    token = body.get('token', '')
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise agent.AgentError('Invalid test token.')
    # Listener host/port come only from the prepared tunnel, never an arbitrary bind.
    private = data['method'] in ['wireguard', 'gre', 'ipip']
    host = str(ipaddress.ip_interface(data['address']).ip) if private else '127.0.0.1'
    if data['method'] == 'hedioum':
        if data['role'] != 'target' or body.get('publicProbe') is not True:
            raise agent.AgentError('Hedioum needs the explicit temporary public probe on the target.')
        host = '0.0.0.0'
    port = data['destinationPort']
    with LOCK:
        if tunnel_id in SERVERS:
            return {'ready': True}
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            if os.name == 'posix':
                # Consecutive methods reuse this port while previous connections are in TIME_WAIT.
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.settimeout(1)
            listener.bind((host, port))
            listener.listen(4)
        except OSError:
            listener.close()
            raise
        stop_event = threading.Event(); SERVERS[tunnel_id] = (listener, stop_event)
    def serve():
        expires = time.monotonic() + 120
        try:
            while time.monotonic() < expires and not stop_event.is_set():
                try:
                    conn, _ = listener.accept()
                except socket.timeout:
                    continue
                except OSError:
                    break
                try:
                    with conn:
                        conn.settimeout(8)
                        if not hmac.compare_digest(receive(conn, 64).decode('ascii'), token):
                            continue
                        command = receive(conn, 1)
                        if command == b'P':
                            conn.sendall(b'P')
                        elif command in [b'U', b'D']:
                            count = struct.unpack('!I', receive(conn, 4))[0]
                            if count < 1 or count > LIMIT:
                                continue
                            if command == b'U':
                                received = 0
                                while received < count:
                                    received += len(receive(conn, min(65536, count - received)))
                                conn.sendall(struct.pack('!I', received))
                            else:
                                payload = secrets.token_bytes(65536)
                                sent = 0
                                while sent < count:
                                    size = min(len(payload), count - sent); conn.sendall(payload[:size]); sent += size
                except (OSError, ValueError, UnicodeError):
                    continue
        finally:
            stop(agent, tunnel_id, expected=listener)
    threading.Thread(target=serve, daemon=True).start()
    return {'ready': True}


def stop(agent, tunnel_id, expected=None):
    with LOCK:
        entry = SERVERS.get(tunnel_id)
        if expected is not None and entry and entry[0] is not expected:
            return {'stopped': True}
        entry = SERVERS.pop(tunnel_id, None)
    if entry:
        listener, stopped = entry
        stopped.set()
        try:
            listener.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        listener.close()
    return {'stopped': True}


def measure(agent, tunnel_id, body):
    directory, _, _, _ = agent.tunnels.names(agent, tunnel_id)
    data = json.loads((directory / 'setup.json').read_text())
    host = str(ipaddress.ip_interface(data['peerAddress']).ip) if data['method'] in ['wireguard', 'gre', 'ipip'] else '127.0.0.1'
    port = data['destinationPort'] if data['method'] in ['wireguard', 'gre', 'ipip'] else data['listenPort']
    token = body.get('token', '')
    if len(token) != 64 or any(c not in '0123456789abcdef' for c in token):
        raise agent.AgentError('Invalid test token.')
    count = body.get('byteLimit', 2 * 1024 * 1024)
    if type(count) is not int or not 65536 <= count <= LIMIT:
        raise agent.AgentError('Test size must be between 64 KiB and 16 MiB per direction.')
    deadline = time.monotonic() + 10
    def remaining(sock=None):
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise socket.timeout('The bounded tunnel sample exceeded ten seconds.')
        if sock is not None:
            sock.settimeout(min(1.5, seconds))
        return min(1.5, seconds)
    def read(sock, count):
        remaining(sock)
        return receive(sock, count, deadline)
    def send(sock, payload):
        remaining(sock)
        sock.sendall(payload)
    def connect(command):
        sock = socket.create_connection((host, port), timeout=remaining())
        remaining(sock)
        if data['method'] == 'hedioum':
            # The target's authenticated public probe avoids upstream's private-IP
            # egress restriction. No external benchmark service is used.
            try:
                send(sock, b'\x05\x01\x00')
                if read(sock, 2) != b'\x05\x00':
                    raise OSError('SOCKS greeting failed.')
                hostname = data['peerHost'].encode('ascii')
                send(sock, b'\x05\x01\x00\x03' + bytes([len(hostname)]) + hostname + struct.pack('!H', data['destinationPort']))
                reply = read(sock, 4)
                if reply[1] != 0:
                    raise OSError('SOCKS egress test destination failed.')
                length = 4 if reply[3] == 1 else 16 if reply[3] == 4 else read(sock, 1)[0]
                read(sock, length + 2)
            except Exception:
                sock.close(); raise
        try:
            send(sock, token.encode() + command)
        except Exception:
            sock.close(); raise
        return sock
    started = time.monotonic(); samples = []
    for _ in range(5):
        begin = time.monotonic()
        try:
            with connect(b'P') as sock:
                if read(sock, 1) == b'P':
                    samples.append((time.monotonic() - begin) * 1000)
        except OSError:
            pass
    if not samples:
        return {'state': 'failed', 'message': 'Authenticated payload could not reach the peer. Check ports, routing and firewalls; this alone does not prove DPI blocking.', 'lossPercent': 100, 'scope': 'Selected VPS pair'}
    begin = time.monotonic()
    with connect(b'U') as sock:
        send(sock, struct.pack('!I', count)); payload = secrets.token_bytes(65536)
        sent = 0
        while sent < count:
            size = min(len(payload), count - sent); send(sock, payload[:size]); sent += size
        acknowledged = struct.unpack('!I', read(sock, 4))[0]
        if acknowledged != count:
            raise agent.AgentError('Upload acknowledgement did not match the payload.')
    upload = acknowledged * 8 / max(time.monotonic() - begin, .001) / 1e6
    begin = time.monotonic()
    with connect(b'D') as sock:
        send(sock, struct.pack('!I', count)); received = 0
        while received < count:
            received += len(read(sock, min(65536, count - received)))
    download = received * 8 / max(time.monotonic() - begin, .001) / 1e6
    return {'state': 'passed', 'message': 'Authenticated traffic passed in both directions.', 'latencyMs': round(sum(samples) / len(samples), 2), 'jitterMs': round(max(samples) - min(samples), 2), 'lossPercent': (5 - len(samples)) * 20, 'uploadMbps': round(upload, 2), 'downloadMbps': round(download, 2), 'bytes': acknowledged + received, 'durationMs': round((time.monotonic() - started) * 1000), 'scope': 'Selected VPS pair; TCP probe loss, not UDP packet loss'}
