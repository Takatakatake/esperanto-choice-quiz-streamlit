import unittest
from unittest.mock import patch

import user_progress
from score_append_utils import compute_user_score_totals


class UserProgressTests(unittest.TestCase):
    def test_deduplicated_history_matches_totals_and_category_sums(self):
        rows = [
            {"user": "alice", "mode": "vocab", "pos": "noun", "points": "12.5", "save_id": "one"},
            {"user": "alice", "mode": "vocab", "pos": "noun", "points": "12.5", "save_id": "one"},
            {"user": " alice ", "group_id": "verb:beginner_1:g2", "points": 20},
            {"user": "alice", "points": 2},
            {"user": "alice", "topic": "travel", "subtopic": "train", "points": 7},
            {"user": "alice", "topic": "travel", "subtopic": "train", "points": 8},
            {"user": "alice", "topic": "travel", "points": 3},
            {"user": "alice", "mode": "sentence", "points": 4},
            {"user": "Alice", "points": 500, "pos": "noun"},
            {"user": "bob", "points": 999},
            None,
        ]
        result = user_progress.compute_user_progress(rows, " alice ")
        self.assertEqual(result["totals"], compute_user_score_totals(rows, "alice"))
        self.assertEqual(result["totals"], {"overall": 56.5, "vocab": 34.5, "sentence": 22})
        for mode in ("vocab", "sentence"):
            self.assertEqual(sum(row["points"] for row in result["categories"][mode]), result["totals"][mode])
        self.assertEqual(result["categories"]["vocab"], [
            {"key": "verb", "points": 20, "attempts": 1},
            {"key": "noun", "points": 12.5, "attempts": 1},
            {"key": "unknown", "points": 2, "attempts": 1},
        ])
        self.assertEqual(result["categories"]["sentence"][0], {
            "key": "travel", "points": 18, "attempts": 3,
            "subtopics": [{"key": "train", "points": 15, "attempts": 2}, {"key": "unknown", "points": 3, "attempts": 1}],
        })

    def test_all_saved_history_is_used_and_bad_numeric_values_are_finite(self):
        rows = [{"user": "alice", "points": 1, "save_id": str(index), "pos": "noun"} for index in range(201)]
        rows.extend({"user": "alice", "points": points, "pos": "noun"} for points in ("NaN", "inf", "bad", None))
        result = user_progress.compute_user_progress(rows, "alice")
        self.assertEqual(result["totals"]["overall"], 201)
        self.assertEqual(result["categories"]["vocab"][0]["attempts"], 205)

    def test_explicit_pos_precedes_legacy_group_and_explicit_mode_precedes_hints(self):
        rows = [{"user": "alice", "mode": "vocab", "topic": "travel", "pos": "adverb", "group_id": "noun:g1", "points": 10}]
        result = user_progress.compute_user_progress(rows, "alice")
        self.assertEqual(result["categories"]["vocab"], [{"key": "adverb", "points": 10, "attempts": 1}])
        self.assertEqual(result["totals"]["sentence"], 0)

    @patch.object(user_progress, "load_ranking_visibility", return_value={"alice": False})
    @patch.object(user_progress, "load_sheet_records", return_value=[{"user": "alice", "points": 20}])
    def test_private_named_account_can_still_read_its_progress(self, load_rows, load_visibility):
        result = user_progress.load_user_progress_request({"type": "load_progress", "requestId": "req1", "user": " alice "})
        self.assertTrue(result["ok"])
        self.assertEqual(result["user"], " alice ")
        self.assertEqual(result["requestId"], "req1")
        self.assertEqual(result["totals"]["overall"], 20)
        self.assertEqual(result["settings"], {"ok": True, "rankingPublic": False, "message": ""})
        load_rows.assert_called_once_with("Scores", refresh=True, required_headers=("user", "points"))

    @patch.object(user_progress, "load_ranking_visibility", return_value=None)
    @patch.object(user_progress, "load_sheet_records", return_value=[{"user": "alice", "points": 20}])
    def test_settings_failure_does_not_block_progress(self, load_rows, load_visibility):
        result = user_progress.load_user_progress_request({"type": "load_progress", "user": "alice"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["totals"]["overall"], 20)
        self.assertFalse(result["settings"]["ok"])
        self.assertFalse(result["settings"]["rankingPublic"])

    @patch.object(user_progress, "load_ranking_visibility", return_value={})
    @patch.object(user_progress, "load_sheet_records", return_value=None)
    def test_failed_score_read_does_not_report_zero_totals(self, load_rows, load_visibility):
        result = user_progress.load_user_progress_request({"type": "load_progress", "user": "alice"})
        self.assertFalse(result["ok"])
        self.assertIsNone(result["totals"])
        self.assertTrue(result["settings"]["ok"])

    @patch.object(user_progress, "load_ranking_visibility", return_value={})
    @patch.object(user_progress, "load_sheet_records", return_value=[])
    def test_new_account_has_zero_progress_and_public_default(self, load_rows, load_visibility):
        result = user_progress.load_user_progress_request({"type": "load_progress", "user": "new"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["totals"], {"overall": 0, "vocab": 0, "sentence": 0})
        self.assertTrue(result["settings"]["rankingPublic"])

    @patch.object(user_progress, "load_ranking_visibility")
    @patch.object(user_progress, "load_sheet_records")
    def test_invalid_requests_do_not_access_sheets(self, load_rows, load_visibility):
        for payload in (None, [], {}, {"type": "other", "user": "alice"}, *({"type": "load_progress", "user": user} for user in (None, {}, 5, "", " a\nb "))):
            with self.subTest(payload=payload):
                self.assertFalse(user_progress.load_user_progress_request(payload)["ok"])
        load_rows.assert_not_called()
        load_visibility.assert_not_called()


if __name__ == "__main__":
    unittest.main()
