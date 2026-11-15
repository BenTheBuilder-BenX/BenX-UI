"""Persistent per-listener counters. No historical traffic is repriced."""
import copy
import json
import math
import time


def read(agent, name, fallback):
    path = agent.ROOT / name
    return json.loads(path.read_text()) if path.exists() else fallback


def supported(agent, inbound):
    return inbound['protocol'] in ['vless', 'vmess', 'trojan', 'shadowsocks', 'wireguard-native']


def rate(policy, email, number):
    client = policy.get('clients', {}).get(email, {})
    service = next((s for s in policy.get('services', []) if s['id'] == client.get('serviceId')), {})
    service_rate = next((i['multiplier'] for i in service.get('inbounds', []) if i['inboundId'] == number), None)
    value = client.get('overrides', {}).get(str(number), service_rate if service_rate is not None else policy.get('inboundMultipliers', {}).get(str(number), 1))
    return client.get('multiplier', 1) * value


def validate(agent, policy):
    def multiplier(value):
        if type(value) not in [int, float] or not math.isfinite(value) or not 0 <= value <= 100:
            raise agent.AgentError('Invalid traffic multiplier.')
    if not isinstance(policy, dict) or type(policy.get('revision')) is not int or policy['revision'] < 0:
        raise agent.AgentError('Invalid policy revision.')
    for field in ['clients', 'inboundMultipliers']:
        if not isinstance(policy.get(field), dict):
            raise agent.AgentError('Invalid traffic policy.')
    if not isinstance(policy.get('services'), list) or len(policy['services']) > 100:
        raise agent.AgentError('Invalid service policies.')
    def rates(mapping):
        if not isinstance(mapping, dict) or len(mapping) > 1000:
            raise agent.AgentError('Invalid inbound rates.')
        for key, value in mapping.items():
            if not key.isdigit() or not 1 <= int(key) <= 999999999:
                raise agent.AgentError('Invalid inbound rate ID.')
            multiplier(value)
    rates(policy['inboundMultipliers'])
    for client in policy['clients'].values():
        if not isinstance(client, dict):
            raise agent.AgentError('Invalid client rates.')
        multiplier(client.get('multiplier'))
        rates(client.get('overrides'))
    for service in policy['services']:
        if not isinstance(service, dict) or not isinstance(service.get('id'), str) or not isinstance(service.get('inbounds'), list):
            raise agent.AgentError('Invalid service rates.')
        for entry in service['inbounds']:
            if not isinstance(entry, dict) or type(entry.get('inboundId')) is not int or entry['inboundId'] < 1:
                raise agent.AgentError('Invalid service inbound.')
            multiplier(entry.get('multiplier'))
    return policy


def counters(agent, inbound, state):
    number = inbound['id']
    invocation = agent.run(['systemctl', 'show', '--property=InvocationID', '--value', agent.unit_name(inbound)], check=False)
    if not invocation:
        return None
    if inbound['protocol'] == 'wireguard-native':
        rows = agent.run([agent.binary('wireguard'), 'show', f'bx{number}', 'dump']).splitlines()[1:]
        by_key = {c.get('publicKey'): c['email'] for c in agent.attached(state, inbound, active_only=False)}
        result = {}
        for row in rows:
            fields = row.split('\t')
            if len(fields) >= 8 and fields[0] in by_key:
                result[by_key[fields[0]]] = [int(fields[5]), int(fields[6])]
        return invocation, result
    api_port = inbound.get('_benxApiPort')
    if not api_port:
        return None  # Existing listeners acquire their API port when saved.
    value = json.loads(agent.run([agent.binary('xray'), 'api', 'statsquery', f'--server=127.0.0.1:{api_port}', '-pattern=user>>>', '-reset=false']))
    result = {}
    for entry in value.get('stat', []):
        name = entry.get('name', '')
        if not name.startswith('user>>>') or '>>>traffic>>>' not in name:
            continue
        email, direction = name[7:].rsplit('>>>traffic>>>', 1)
        if direction in ['uplink', 'downlink']:
            result.setdefault(email, [0, 0])[0 if direction == 'uplink' else 1] = int(entry.get('value', 0))
    return invocation, result


def accumulate(ledger, number, invocation, current, policy):
    raw = ledger.setdefault('raw', {})
    usage = ledger.setdefault('usage', {})
    listener = ledger.setdefault('inbounds', {}).setdefault(str(number), {'up': 0, 'down': 0})
    for email, values in current.items():
        key = f'{number}:{email}'
        old = raw.get(key)
        deltas = [max(0, v - old['values'][n]) if old and old['invocation'] == invocation and v >= old['values'][n] else max(0, v) for n, v in enumerate(values)]
        weight = rate(policy, email, number)
        total = usage.setdefault(email, {'up': 0, 'down': 0, 'rawUp': 0, 'rawDown': 0})
        total['up'] += deltas[0] * weight
        total['down'] += deltas[1] * weight
        total['rawUp'] += deltas[0]
        total['rawDown'] += deltas[1]
        listener['up'] += deltas[0]
        listener['down'] += deltas[1]
        raw[key] = {'invocation': invocation, 'values': values}


def collect(agent, state):
    ledger = read(agent, 'accounting.json', {'usage': {}, 'raw': {}, 'errors': {}})
    policy = read(agent, 'policy.json', {})
    errors = {}
    for inbound in state['inbounds']:
        if not supported(agent, inbound) or agent.run(['systemctl', 'is-active', agent.unit_name(inbound)], check=False) != 'active':
            continue
        try:
            value = counters(agent, inbound, state)
            if value is None:
                errors[str(inbound['id'])] = 'Save this listener to enable accounting, then check that its service is running.'
            else:
                source = next((i['id'] for i in state['inbounds'] if i['protocol'] == 'masterdnsvpn' and i.get('settings', {}).get('meteredInboundId') == inbound['id']), inbound['id'])
                if source != inbound['id']:
                    raw = ledger.setdefault('raw', {})
                    for email in value[1]:
                        logical, physical = f'{source}:{email}', f"{inbound['id']}:{email}"
                        if logical not in raw and physical in raw:
                            raw[logical] = copy.deepcopy(raw[physical])
                previous_raw = copy.deepcopy(ledger.get('raw', {}))
                accumulate(ledger, source, *value, policy)
                for email, values in value[1].items():
                    client = state['clients'].get(email, {})
                    duration = client.get('expiryTime', 0)
                    old = previous_raw.get(f'{source}:{email}', {})
                    delta = sum(max(0, v-old.get('values', [0, 0])[n]) if old.get('invocation') == value[0] and v >= old.get('values', [0, 0])[n] else max(0, v) for n, v in enumerate(values))
                    identity = client.get('firstUseId', client.get('id', client.get('uuid')))
                    first = ledger.setdefault('firstUse', {}).get(email, {})
                    if duration < 0 and delta > 0 and (first.get('duration') != duration or first.get('identity') != identity):
                        ledger['firstUse'][email] = {'duration': duration, 'identity': identity, 'startedAt': int(time.time()*1000)}
                if source != inbound['id']:
                    for email in value[1]:
                        ledger['raw'][f"{inbound['id']}:{email}"] = copy.deepcopy(ledger['raw'][f'{source}:{email}'])
        except Exception:
            errors[str(inbound['id'])] = 'Counters unavailable. Check the listener and its local stats API.'
    ledger['errors'], ledger['checkedAt'] = errors, int(time.time() * 1000)
    agent.write_private(agent.ROOT / 'accounting.json', json.dumps(ledger))
    return ledger


def reconcile(agent):
    with agent.LOCK:
        if agent.INSTALLING:
            return
        state = agent.load_state()
        ledger = collect(agent, state)
        previous = copy.deepcopy(state)
        changed = set()
        for email, client in state['clients'].items():
            client['_firstUse'] = ledger.get('firstUse', {}).get(email, {})
            total = ledger['usage'].get(email, {})
            blocked = bool(client.get('totalGB') and total.get('up', 0) + total.get('down', 0) >= client['totalGB'])
            if blocked != client.get('_quotaBlocked', False):
                client['_quotaBlocked'] = blocked
                changed.update(client['inboundIds'])
        if changed:
            agent.apply_state(state, previous, changed)


def loop(agent):
    while True:
        try:
            reconcile(agent)
        except Exception:
            print('Traffic accounting reconciliation failed; retrying.', flush=True)
        time.sleep(10)
