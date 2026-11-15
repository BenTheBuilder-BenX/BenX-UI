"""Owned static HTTPS site with explicit WebSocket routes; no global nginx edits."""
import json
import re
import shutil
from pathlib import Path

UNIT = 'benx-storefront.service'

def validate_html(agent, html):
    if not isinstance(html, str) or not html.strip() or len(html.encode('utf8')) > 200000:
        raise agent.AgentError('Choose an HTML file smaller than 200 KB.')
    if not re.search(r'<(?:html|body|!doctype)\b', html, re.I) or re.search(r"<(?:script|iframe|object|embed|base|form)\b|\bon[a-z]+\s*=|javascript\s*:|http-equiv\s*=\s*[\"']?refresh", html, re.I):
        raise agent.AgentError('Use static HTML and CSS without scripts, forms, embedded frames or redirects.')
    return html

def validate(agent, state):
    s = state.get('storefront', {})
    if s.get('template') == 'custom':
        validate_html(agent, s.get('html'))
    if not s or s.get('enabled') is False:
        return s
    if s.get('enabled') is not True or s.get('template') not in ['arcade', 'custom'] or s.get('mode') not in ['direct', 'cdn'] or not isinstance(s.get('domain'), str) or not re.fullmatch(r'(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', s['domain']):
        raise agent.AgentError('Invalid Storefront domain, template or mode.')
    port = s.get('port')
    if type(port) is not int or not 1 <= port <= 65535 or port in [22,80,8095,9443] or s['mode'] == 'cdn' and port not in [443,2053,2083,2087,2096,8443]:
        raise agent.AgentError('Choose an available HTTPS port supported by the selected hosting mode.')
    paths = set()
    ids = s.get('inboundIds')
    if not isinstance(ids, list) or len(ids) > 100:
        raise agent.AgentError('Invalid Storefront inbound selection.')
    for row in state['inbounds']:
        settings = agent.object_value(row.get('settings'))
        if row['port'] == port or row['protocol'] == 'dns-resolver' and port in [settings.get(k) for k in ['httpsPort','tlsPort','quicPort']]:
            raise agent.AgentError('Storefront port conflicts with an existing listener.')
    for number in ids:
        row = next((i for i in state['inbounds'] if i['id'] == number), {})
        stream = agent.object_value(row.get('streamSettings'))
        path = agent.object_value(stream.get('wsSettings')).get('path', '')
        if row.get('protocol') not in ['vless','vmess','trojan','shadowsocks'] or stream.get('network') != 'ws' or stream.get('security') not in [None, '', 'none'] or not isinstance(path, str) or not re.fullmatch(r'/[A-Za-z0-9_/-]+', path) or path in paths:
            raise agent.AgentError('Select plain WebSocket inbounds with unique non-root paths.')
        paths.add(path)
    return s

def certificate(agent, s):
    remembered = agent.server_setup.certificates.remembered(agent) or {}
    entry = next((e for e in remembered.get('entries', [remembered]) if e.get('identifier', e.get('domain')) == s['domain'] and e.get('available')), None)
    if not entry:
        raise agent.AgentError('Issue a certificate for the Storefront domain in server setup before enabling it.', 409)
    return entry

def config(agent, state):
    s = validate(agent, state)
    cert = certificate(agent, s)
    directory = agent.ROOT / 'storefront'
    q = lambda v: json.dumps(str(v))
    routes = []
    for row in state['inbounds']:
        if row['id'] not in s['inboundIds'] or not agent.should_run(row, state):
            continue
        path = row['streamSettings']['wsSettings']['path']
        routes.append(f'location = {path} {{ proxy_pass http://127.0.0.1:{row["port"]}; proxy_http_version 1.1; proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade"; proxy_set_header Host $host; proxy_read_timeout 300s; }}')
    return f'''user root;
pid {q(directory / 'nginx.pid')};
error_log {q(directory / 'error.log')} warn;
events {{ worker_connections 256; }}
http {{ access_log off; default_type text/html; server_tokens off;
server {{ listen {s['port']} ssl; server_name {s['domain']};
ssl_certificate {q(cert['certificateFile'])}; ssl_certificate_key {q(cert['keyFile'])};
ssl_protocols TLSv1.2 TLSv1.3; root {q(directory / 'www')};
add_header X-Content-Type-Options nosniff always;
add_header Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src https:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
location / {{ try_files $uri /index.html; }}
{' '.join(routes)}
}} }}
'''

def healthy(agent, state):
    wanted = bool(state.get('storefront', {}).get('enabled'))
    if not wanted and not (agent.UNITS_DIR / UNIT).exists():
        return True
    return (agent.run(['systemctl', 'is-active', UNIT], check=False) == 'active') == wanted

def apply(agent, state, previous, repair=False):
    s = validate(agent, state)
    old = previous.get('storefront', {})
    if not s.get('enabled'):
        if old.get('enabled') or (agent.UNITS_DIR / UNIT).exists():
            agent.run(['systemctl', 'disable', '--now', UNIT])
        return
    wanted = config(agent, state)  # Validate credentials before package installation or service changes.
    nginx = shutil.which('nginx')
    if not nginx:
        agent.server_setup.install_packages(agent, ['nginx-light'])
        nginx = shutil.which('nginx')
    if not nginx:
        raise agent.AgentError('Nginx installation failed.', 502)
    directory = agent.ROOT / 'storefront'; directory.mkdir(parents=True, exist_ok=True)
    www = directory / 'www'; www.mkdir(exist_ok=True)
    # Owned nginx runs as root so files stay private to the agent; it cannot access panel API routes.
    html = validate_html(agent, s.get('html')) if s.get('template') == 'custom' else (Path(__file__).parent / 'arcade.html').read_text(encoding='utf8')
    old_html = (www / 'index.html').read_text(encoding='utf8') if (www / 'index.html').exists() else None
    path = directory / 'nginx.conf'; old_config = path.read_text() if path.exists() else None
    if not repair and s == old and old_config == wanted and (www / 'index.html').is_file() and (www / 'index.html').read_text(encoding='utf8') == html and healthy(agent, state):
        return
    try:
        agent.write_private(path, wanted); agent.write_private(www / 'index.html', html)
        agent.run([nginx, '-t', '-c', str(path)])
        agent.write_private(agent.UNITS_DIR / UNIT, f'[Unit]\nDescription=BenX Arcade static Storefront\nAfter=network.target\n[Service]\nType=simple\nExecStart={nginx} -c {path} -g "daemon off;"\nExecReload=/bin/kill -HUP $MAINPID\nRestart=on-failure\nNoNewPrivileges=true\nProtectHome=true\n[Install]\nWantedBy=multi-user.target\n')
        agent.server_setup.certificates.renewal_hook(agent)
        agent.run(['systemctl', 'daemon-reload']); agent.run(['systemctl', 'enable', UNIT]); agent.run(['systemctl', 'restart', UNIT])
        import time
        time.sleep(0.4)
        if not healthy(agent, state):
            raise agent.AgentError('Storefront could not start. Check HTTPS port availability.', 502)
    except Exception:
        if old_html is not None:
            agent.write_private(www / 'index.html', old_html)
        else:
            (www / 'index.html').unlink(missing_ok=True)
        if old_config is not None:
            agent.write_private(path, old_config)
            agent.run(['systemctl', 'restart', UNIT], check=False)
        else:
            path.unlink(missing_ok=True); agent.run(['systemctl', 'disable', '--now', UNIT], check=False)
        raise
