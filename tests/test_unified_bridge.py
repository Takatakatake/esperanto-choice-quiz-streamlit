"""Exercise the actual component request boundary without network or a browser."""

from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import mobile_streamlit_bridge as bridge


class SessionState(dict):
    def __getattr__(self, name):
        return self[name]

    def __setattr__(self, name, value):
        self[name] = value


class UnifiedBridgeTests(unittest.TestCase):
    def setUp(self):
        self.state = SessionState()
        self.runtime = SimpleNamespace(session_state=self.state, markdown=Mock(), rerun=Mock())
        self.component = Mock()
        for name, replacement in (
            ("st", self.runtime),
            ("_mobile_component", self.component),
            ("_mobile_audio_config", Mock(return_value={})),
            ("get_quiz_mode", Mock(return_value="vocab")),
        ):
            context = patch.object(bridge, name, replacement)
            context.start()
            self.addCleanup(context.stop)

    def render(self, payload):
        self.component.return_value = payload
        bridge.render_mobile_app_entry(source="vocab_ja", target_lang="ja")

    def test_repeated_request_is_processed_once(self):
        payload = {"type": "save_score", "requestId": "save-request", "user": "A"}
        with patch.object(bridge, "save_mobile_score_request", return_value={"ok": True}) as save:
            self.render(payload)
            self.render(payload)
            save.assert_called_once_with(payload)
        self.runtime.rerun.assert_called_once()

    def test_account_switch_loads_new_personalized_result(self):
        with patch.object(bridge, "load_mobile_rankings_request") as load:
            load.side_effect = [
                {"ok": True, "user": "A", "own": {"overall": {"user": "A"}}},
                {"ok": True, "user": "B", "own": {"overall": {"user": "B"}}},
            ]
            self.render({"type": "load_rankings", "requestId": "rank-A", "user": "A"})
            self.render({"type": "load_rankings", "requestId": "rank-B", "user": "B"})
            self.assertEqual(load.call_count, 2)
        self.assertEqual(self.state.mobile_ranking_result["own"]["overall"]["user"], "B")

    def test_progress_response_is_passed_to_component(self):
        expected = {"ok": True, "user": "A", "totals": {"overall": 123.0}}
        with patch.object(bridge, "load_user_progress_request", return_value=expected):
            self.render({"type": "load_progress", "requestId": "progress-A", "user": "A"})
            self.render(None)
        self.assertEqual(self.component.call_args.kwargs["progressResult"], expected)
        self.assertEqual(self.component.call_args.kwargs["key"], "esperanto_mobile_pwa_vocab_ja")

    def test_visibility_write_invalidates_public_results_even_if_readback_failed(self):
        self.state.mobile_ranking_result = {"ok": True, "publicNames": ["A"]}
        self.state.mobile_progress_result = {"ok": True}
        with patch.object(bridge, "save_user_settings_request", return_value={"ok": False}):
            self.render({
                "type": "save_user_settings", "requestId": "settings-A",
                "user": "A", "rankingPublic": False,
            })
        self.assertIsNone(self.state.mobile_ranking_result)
        self.assertIsNone(self.state.mobile_progress_result)
        self.assertFalse(self.state.mobile_user_settings_result["ok"])

    def test_unexpected_backend_failure_returns_ack_without_secret_details(self):
        with patch.object(bridge, "save_mobile_score_request", side_effect=RuntimeError("private-token")), \
             self.assertLogs(bridge.logger, level="ERROR"):
            self.render({
                "type": "save_score", "requestId": "request-failed",
                "saveId": "stable-save", "user": "A",
            })
        result = self.state.mobile_score_sync_result
        self.assertFalse(result["ok"])
        self.assertEqual(result["type"], "score_save_result")
        self.assertEqual(result["saveId"], "stable-save")
        self.assertNotIn("private-token", result["message"])

    def test_unknown_or_invalid_requests_do_not_write_or_rerun(self):
        with patch.object(bridge, "save_mobile_score_request") as save:
            for payload in (None, [], {"type": {}}, {"type": "delete_all", "requestId": "x"},
                            {"type": "save_score", "requestId": ""}):
                self.render(payload)
            save.assert_not_called()
        self.runtime.rerun.assert_not_called()


if __name__ == "__main__":
    unittest.main()
