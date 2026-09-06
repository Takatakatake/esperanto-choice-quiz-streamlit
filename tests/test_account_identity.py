"""Validation errors retain transport identity without changing account identity."""

import unittest
from unittest.mock import patch

import mobile_ranking
import mobile_score_sync
import user_progress
import user_settings


class AccountIdentityTests(unittest.TestCase):
    def test_control_characters_never_alias_another_account_or_reach_a_write(self):
        names = ("Ali\tce", "\u0085Alice\u0085", "\x1cAlice\x1c", "Al\x7fice", "Alice\u009f")
        with patch.object(user_progress, "load_sheet_records") as load, \
             patch.object(user_settings, "upsert_user_settings") as setting_write, \
             patch.object(mobile_score_sync, "_append_score") as score_write:
            for name in names:
                with self.subTest(name=name):
                    self.assertEqual(user_settings.normalize_user(name), "")
                    progress = user_progress.load_user_progress_request({
                        "type": "load_progress", "requestId": "progress-error", "user": name,
                    })
                    self.assertFalse(progress["ok"])
                    self.assertIsNone(progress["totals"])
                    self.assertEqual(progress["user"], name)
                    self.assertEqual(progress["requestId"], "progress-error")
                    self.assertIn("有効なユーザー名", progress["message"])
                    setting = user_settings.save_user_settings_request({
                        "type": "save_user_settings", "requestId": "setting-error", "user": name,
                        "rankingPublic": False,
                    })
                    self.assertFalse(setting["ok"])
                    self.assertEqual(setting["user"], name)
                    self.assertEqual(setting["requestId"], "setting-error")
                    score = mobile_score_sync.save_mobile_score_request({
                        "type": "save_score", "user": name, "total": 10, "points": 100,
                    })
                    self.assertFalse(score["ok"])
            load.assert_not_called()
            setting_write.assert_not_called()
            score_write.assert_not_called()

    def test_ranking_response_echoes_request_but_does_not_treat_invalid_name_as_current_account(self):
        name = "\u0085Alice\u0085"
        with patch.object(mobile_ranking, "load_ranking_visibility", return_value={}), \
             patch.object(mobile_ranking, "load_sheet_records", side_effect=[
                 [{"user": "Alice", "total_points": 20}], [{"user": "Alice", "points": 20}],
             ]):
            result = mobile_ranking.load_mobile_rankings_request({
                "type": "load_rankings", "requestId": "ranking-name", "user": name,
            })
        self.assertTrue(result["ok"])
        self.assertEqual(result["user"], name)
        self.assertIsNone(result["own"]["overall"])
        self.assertFalse(result["rankings"]["overall"][0]["isCurrentUser"])

    def test_ordinary_names_keep_whitespace_trimming_and_case_sensitive_identity(self):
        for name in ("Alice-Ĉ", "山田 太郎", "用户", "사용자", "LongName" * 20):
            with self.subTest(name=name):
                self.assertEqual(user_settings.normalize_user(f" \u3000{name}\u00a0 "), name)
        self.assertNotEqual(user_settings.normalize_user("Alice"), user_settings.normalize_user("alice"))


if __name__ == "__main__":
    unittest.main()
