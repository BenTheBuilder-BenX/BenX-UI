"""Outbound control with a private result journal. Started actions are never replayed."""
import json
import secrets
import time
from urllib.parse import urlsplit, unquote
import re
from urllib.request import Request, build_opener, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_origin(origin):
    url = urlsplit(origin)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.path not in ['', '/'] or url.query or url.fragment:
        raise ValueError('Outbound management needs an HTTPS origin without credentials or a path.')
    return origin.rstrip('/')


def post(config, action, token, body):
    origin = validate_origin(config['origin'])
    request = Request(f"{origin}/api/agent/{action}/{config['id']}", data=json.dumps(body).encode(),
                      headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'}, method='POST')
    with build_opener(NoRedirect()).open(request, timeout=20) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError('Agent channel response is too large.')
        return json.loads(raw)


def execute(agent, command):
    payload = command.get('input', {})
    if not isinstance(payload, dict):
        return {'status': 400, 'result': {'success': False, 'msg': 'Expected a JSON command.'}}
    path, method, body = payload.get('path', ''), payload.get('method'), payload.get('body', {})
    if method not in ['GET', 'POST'] or not isinstance(path, str) or not path.startswith(('/benx/v1/', '/panel/api/')) or not isinstance(body, dict) or '?' in path or '#' in path or '\\' in path or any(unquote(s) in ['.', '..'] or re.search(r'[\x00-\x1f\\/]', unquote(s)) for s in path.split('/') if s):
        return {'status': 400, 'result': {'success': False, 'msg': 'Unsupported agent command.'}}
    try:
        result = {'status': 200, 'result': {'success': True, 'obj': agent.dispatch(path, method, body)}}
        if len(json.dumps(result).encode()) > 650000:
            return {'status': 413, 'result': {'success': False, 'msg': 'Result exceeds outbound channel limit. Use a smaller export.'}}
        return result
    except agent.AgentError as error:
        return {'status': error.status, 'result': {'success': False, 'msg': str(error)}}
    except Exception:
        return {'status': 500, 'result': {'success': False, 'msg': 'Server action failed. Check the private agent journal.'}}


def uncertain_result():
    return {'status': 409, 'result': {'success': False, 'msg': 'Agent restarted during this action. It was not replayed. Check actual server state before retrying.'}}


def loop(agent):
    config_path, journal_path = agent.ROOT / 'enrollment.json', agent.ROOT / 'outbound-journal.json'
    config = json.loads(config_path.read_text())
    validate_origin(config['origin'])
    # Persist the identity before pairing, allowing the same identity to retry a lost reply.
    if 'nodeToken' not in config:
        config['nodeToken'] = secrets.token_hex(32)
        agent.write_private(config_path, json.dumps(config))
    journal = json.loads(journal_path.read_text()) if journal_path.exists() else {}
    if journal.get('state') == 'started':
        journal.update(state='result', **uncertain_result())
        agent.write_private(journal_path, json.dumps(journal))
    failures = 0
    while True:
        try:
            if not config.get('paired'):
                reply = post(config, 'pair', config['pairingToken'], {'token': config['nodeToken']})
                if not reply.get('paired'):
                    raise ValueError('Pairing was not confirmed.')
                config['paired'] = True
                config.pop('pairingToken', None)
                agent.write_private(config_path, json.dumps(config))
            if journal.get('state') == 'result':
                reply = post(config, 'result', config['nodeToken'], {k: journal[k] for k in ['id', 'status', 'result']})
                if not reply.get('received'):
                    raise ValueError('Result not acknowledged.')
                journal = {}
                agent.write_private(journal_path, '{}')
            reply = post(config, 'poll', config['nodeToken'], {})
            failures = 0
            command = reply.get('command')
            if not command:
                time.sleep(max(1, min(10, int(reply.get('pollSeconds', 3)))))
                continue
            journal = {'id': command['id'], 'state': 'started'}
            agent.write_private(journal_path, json.dumps(journal))
            if command.get('expiresAt', 0) < int(time.time() * 1000):
                result = {'status': 409, 'result': {'success': False, 'msg': 'Command expired before execution. Server clock must use NTP.'}}
            else:
                result = execute(agent, command)
            journal.update(state='result', **result)
            agent.write_private(journal_path, json.dumps(journal))
        except Exception:
            failures += 1
            if failures == 1 or failures % 10 == 0:
                print('Outbound management unavailable; results retained. Check HTTPS, enrollment and server time.', flush=True)
            time.sleep(min(60, 2 ** min(failures, 6)))
