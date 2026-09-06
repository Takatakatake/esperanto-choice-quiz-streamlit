import unittest
from unittest.mock import patch

import user_progress
from data_sources import VOCAB_CSV
from score_append_utils import compute_user_score_totals
from vocab_grouping import build_groups


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
        self.assertEqual([{key: row[key] for key in ("key", "points", "attempts")} for row in result["categories"]["vocab"]], [
            {"key": "verb", "points": 20, "attempts": 1},
            {"key": "noun", "points": 12.5, "attempts": 1},
            {"key": "unknown", "points": 2, "attempts": 1},
        ])
        for row in result["categories"]["vocab"]:
            self.assertEqual(sum(level["points"] for level in row["levels"]), row["points"])
            self.assertEqual(sum(level["attempts"] for level in row["levels"]), row["attempts"])
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
        category = result["categories"]["vocab"][0]
        self.assertEqual((category["key"], category["points"], category["attempts"]), ("adverb", 10, 1))
        self.assertEqual(category["levels"][-1], {"key": "unknown", "points": 10, "attempts": 1})
        self.assertEqual(result["totals"]["sentence"], 0)

    def test_vocab_sublevels_accumulate_in_difficulty_order_with_zero_unplayed_levels(self):
        rows = [
            {"user": "alice", "group_id": "noun:advanced_6:g1", "points": 40, "save_id": "a"},
            {"user": "alice", "group_id": "noun:beginner_1:g2", "points": 10.5, "save_id": "b"},
            {"user": " alice ", "group_id": "noun:beginner_2+beginner_3:g1", "points": 20, "save_id": "c"},
            {"user": "alice", "group_id": "noun:beginner_1:g2", "points": 10.5, "save_id": "b"},
            {"user": "Alice", "group_id": "noun:intermediate_3:g1", "points": 1000},
            {"user": "bob", "group_id": "noun:intermediate_3:g1", "points": 2000},
        ]
        result = user_progress.compute_user_progress(rows, "alice")
        self.assertEqual(result["totals"], {"overall": 70.5, "vocab": 70.5, "sentence": 0})
        self.assertEqual(result["categories"]["vocab"], [{
            "key": "noun", "points": 70.5, "attempts": 3, "levels": [
                {"key": "beginner", "points": 30.5, "attempts": 2},
                {"key": "intermediate", "points": 0, "attempts": 0},
                {"key": "advanced", "points": 40, "attempts": 1},
            ],
        }])

    def test_mixed_quizzes_keep_their_points_together_and_canonicalize_stage_order(self):
        rows = [
            {"user": "alice", "group_id": "suffix:intermediate_1+beginner_3:g1", "points": 10},
            {"user": "alice", "group_id": "suffix:beginner_2+intermediate_2:g1", "points": 20},
            {"user": "alice", "group_id": "suffix:advanced_1+intermediate_3:g2", "points": 40},
            {"user": "alice", "group_id": "suffix:beginner_1+intermediate_1+advanced_1:g1", "points": 80},
        ]
        category = user_progress.compute_user_progress(rows, "alice")["categories"]["vocab"][0]
        self.assertEqual(category["points"], 150)
        self.assertEqual([level["points"] for level in category["levels"][:3]], [0, 0, 0])
        self.assertEqual(category["levels"][3:], [
            {"key": "beginner+intermediate", "points": 30, "attempts": 2},
            {"key": "beginner+intermediate+advanced", "points": 80, "attempts": 1},
            {"key": "intermediate+advanced", "points": 40, "attempts": 1},
        ])
        self.assertEqual(sum(level["points"] for level in category["levels"]), category["points"])
        self.assertEqual(sum(level["attempts"] for level in category["levels"]), category["attempts"])

    def test_missing_invalid_or_conflicting_difficulty_keeps_points_as_level_unknown(self):
        invalid_ids = [
            None, "", "noun:g1", "noun:beginner_1", "noun:beginner_1:g0", "noun:beginner_1:g1:extra",
            "noun:beginner_0:g1", "noun:beginner_4:g1", "noun:advanced_7:g1", "noun:intermediate_4:g1",
            "noun:beginner_1++advanced_1:g1", "noun:beginner_1+invalid:g1", "noun:beginner_1:garbage",
            "noun:beginner_1 :g1", "verb:beginner_1:g1", {}, 123,
        ]
        for group_id in invalid_ids:
            with self.subTest(group_id=group_id):
                rows = [{"user": "alice", "mode": "vocab", "pos": "noun", "group_id": group_id, "points": 12.5}]
                category = user_progress.compute_user_progress(rows, "alice")["categories"]["vocab"][0]
                self.assertEqual((category["key"], category["points"]), ("noun", 12.5))
                self.assertEqual([level["points"] for level in category["levels"][:3]], [0, 0, 0])
                self.assertEqual(category["levels"][-1], {"key": "unknown", "points": 12.5, "attempts": 1})

    def test_plain_stage_names_and_outer_whitespace_remain_readable(self):
        rows = [{"user": "alice", "pos": "noun", "group_id": " noun:intermediate:g1 ", "points": 5}]
        levels = user_progress.compute_user_progress(rows, "alice")["categories"]["vocab"][0]["levels"]
        self.assertEqual(levels[1], {"key": "intermediate", "points": 5, "attempts": 1})
        self.assertEqual(len(levels), 3)

    def test_current_quiz_groups_recover_their_actual_difficulties(self):
        groups = build_groups(VOCAB_CSV, seed=1)
        self.assertTrue(groups)
        mixed_seen = False
        for group in groups:
            with self.subTest(group_id=group.id):
                expected = {stage.split("_", 1)[0] for stage in group.stages}
                rows = [{"user": "alice", "group_id": group.id, "points": 7}]
                category = user_progress.compute_user_progress(rows, "alice")["categories"]["vocab"][0]
                earned = [level for level in category["levels"] if level["attempts"]]
                self.assertEqual(len(earned), 1)
                self.assertEqual(set(earned[0]["key"].split("+")), expected)
                self.assertEqual(earned[0]["points"], category["points"])
                mixed_seen |= len(expected) > 1
        self.assertTrue(mixed_seen)

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
