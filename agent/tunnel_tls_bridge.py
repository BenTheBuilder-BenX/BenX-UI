"""TLS-only public entrance for FRP WSS, with the FRP backend on loopback.

FRP's force-TLS check runs again after WebSocket termination. WSS therefore
needs a separate TLS entrance to enforce encryption without nested TLS.
"""
import argparse
import signal
import socket
import socketserver
import ssl
import subprocess
import threading


def serve(args):
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)

    class Handler(socketserver.BaseRequestHandler):
        def handle(self):
            frontend = backend = None
            try:
                self.request.settimeout(15)
                frontend = context.wrap_socket(self.request, server_side=True)
                backend = socket.create_connection(('127.0.0.1', args.target), timeout=15)
                frontend.settimeout(None)
                backend.settimeout(None)

                def copy(source, destination):
                    try:
                        while chunk := source.recv(65536):
                            destination.sendall(chunk)
                    except (OSError, ssl.SSLError):
                        pass
                    finally:
                        for stream in [source, destination]:
                            try:
                                stream.shutdown(socket.SHUT_RDWR)
                            except OSError:
                                pass

                incoming = threading.Thread(target=copy, args=(frontend, backend), daemon=True)
                incoming.start()
                copy(backend, frontend)
                incoming.join(timeout=2)
            except (OSError, ssl.SSLError):
                # Plaintext and failed handshakes never reach the FRP backend.
                pass
            finally:
                for stream in [frontend, backend]:
                    if stream:
                        stream.close()

    class Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    process = subprocess.Popen([args.engine, '-c', args.config])
    try:
        with Server(('0.0.0.0', args.port), Handler) as server:
            server.timeout = 1
            while process.poll() is None:
                server.handle_request()
        raise RuntimeError('The private FRP backend stopped.')
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    for name in ['engine', 'config', 'cert', 'key']:
        parser.add_argument('--' + name, required=True)
    for name in ['port', 'target']:
        parser.add_argument('--' + name, type=int, required=True)
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(SystemExit(0)))
    serve(parser.parse_args())
