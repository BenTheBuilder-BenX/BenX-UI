import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import outbound


class AgentError(Exception):
    status = 409


class OutboundTests(unittest.TestCase):
    def test_refuses_plaintext_and_credential_bearing_origins(self):
        for value in ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com/?token=secret']:
            with self.assertRaises(ValueError):
                outbound.validate_origin(value)
        self.assertEqual(outbound.validate_origin('https://panel.example.com/'), 'https://panel.example.com')

    def test_only_fixed_json_dispatch_is_executable(self):
        agent = types.SimpleNamespace(dispatch=Mock(return_value={'saved': True}), AgentError=AgentError)
        for path in ['/bin/sh', '/benx/v1/../exec', '/benx/v1/%2e%2e/exec', '/benx/v1/a%2fb', '/benx/v1/jobs?command=whoami']:
            self.assertEqual(outbound.execute(agent, {'input': {'path': path, 'method': 'POST'}})['status'], 400)
        agent.dispatch.assert_not_called()
        self.assertTrue(outbound.execute(agent, {'input': {'path': '/benx/v1/jobs', 'method': 'GET'}})['result']['success'])

    def test_interrupted_action_is_reported_without_reexecution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'enrollment.json').write_text(json.dumps({'origin': 'https://panel.example.com', 'id': 'node', 'nodeToken': 'b' * 64, 'paired': True}))
            (root / 'outbound-journal.json').write_text(json.dumps({'id': 'interrupted', 'state': 'started'}))
            agent = types.SimpleNamespace(ROOT=root, write_private=lambda path, text: path.write_text(text), dispatch=Mock(), AgentError=AgentError)
            with patch.object(outbound, 'post', side_effect=[{'received': True}, SystemExit]) as post:
                with self.assertRaises(SystemExit):
                    outbound.loop(agent)
            agent.dispatch.assert_not_called()
            self.assertEqual(post.call_args_list[0].args[3]['status'], 409)
            self.assertEqual(json.loads((root / 'outbound-journal.json').read_text()), {})

    def test_retains_completed_result_until_acknowledged(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'enrollment.json').write_text(json.dumps({'origin': 'https://panel.example.com', 'id': 'node', 'nodeToken': 'b' * 64, 'paired': True}))
            result = {'id': 'done', 'state': 'result', 'status': 200, 'result': {'success': True}}
            (root / 'outbound-journal.json').write_text(json.dumps(result))
            agent = types.SimpleNamespace(ROOT=root, write_private=lambda path, text: path.write_text(text), dispatch=Mock(), AgentError=AgentError)
            with patch.object(outbound, 'post', side_effect=[OSError('offline'), SystemExit]), patch.object(outbound.time, 'sleep'):
                with self.assertRaises(SystemExit):
                    outbound.loop(agent)
            self.assertEqual(json.loads((root / 'outbound-journal.json').read_text()), result)
            agent.dispatch.assert_not_called()
