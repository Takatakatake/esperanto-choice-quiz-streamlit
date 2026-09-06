"""Exercise the actual persistence/aggregation path without credentials or network."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import mobile_ranking
import mobile_score_sync
import score_append_utils
import user_progress
import user_settings


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "learning_app.py"
spec = importlib.util.spec_from_file_location("local_learning_fixture", FIXTURE_PATH)
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)


class LearningFixtureIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.store = fixture.MemorySheetStore()
        opener = patch.object(score_append_utils, "_open_worksheet", side_effect=self.store.open_worksheet)
        opener.start()
        self.addCleanup(opener.stop)
        # If the fixture ever falls through to production setup, fail immediately.
        credentials = patch.object(score_append_utils, "_get_conn_config", side_effect=AssertionError("Fixture must never read credentials"))
        credentials.start()
        self.addCleanup(credentials.stop)

    def test_actual_progress_and_settings_flow_preserves_private_progress(self):
        progress = user_progress.load_user_progress_request({"type": "load_progress", "user": "Review-A"})
        self.assertTrue(progress["ok"])
        self.assertEqual(progress["totals"], {"overall": 200, "vocab": 150, "sentence": 50})
        self.assertEqual({row["key"]: row["points"] for row in progress["categories"]["vocab"]}, {"noun": 120, "verb": 30})
        rankings = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Review-B"})
        self.assertTrue(rankings["ok"])
        self.assertEqual(rankings["rankings"]["hof"], [])
        for period in ("overall", "today", "month"):
            self.assertEqual([row["user"] for row in rankings["rankings"][period]], ["Review-A"])
        saved = user_settings.save_user_settings_request({"type": "save_user_settings", "user": "Review-A", "rankingPublic": False})
        self.assertTrue(saved["ok"])
        for name, total in (("Review-A", 200), ("Review-B", 1_200_000)):
            progress = user_progress.load_user_progress_request({"type": "load_progress", "user": name})
            self.assertEqual(progress["totals"]["overall"], total)
            self.assertFalse(progress["settings"]["rankingPublic"])
        rankings = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Review-A"})
        self.assertTrue(all(not rows for rows in rankings["rankings"].values()))

    def test_actual_score_save_is_idempotent_and_updates_derived_sheets(self):
        payload = {
            "type": "save_score", "requestId": "fixture-request", "saveId": "fixture-new-result",
            "sessionId": "fixture-session", "user": "Review-A", "mode": "sentence",
            "topic": "travel", "subtopic": "train", "total": 5, "correct": 4,
            "points": 25, "accuracy": 0.8,
        }
        self.assertTrue(mobile_score_sync.save_mobile_score_request(payload)["ok"])
        self.assertTrue(mobile_score_sync.save_mobile_score_request(payload)["ok"])
        progress = user_progress.load_user_progress_request({"type": "load_progress", "user": "Review-A"})
        self.assertEqual(progress["totals"], {"overall": 225, "vocab": 150, "sentence": 75})
        scores = score_append_utils.load_sheet_records("Scores")
        self.assertEqual(sum(row["save_id"] == "fixture-new-result" for row in scores), 1)
        overall = score_append_utils.load_sheet_records("UserStats")
        sentence = score_append_utils.load_sheet_records("UserStatsSentence")
        self.assertEqual(float(next(row["total_points"] for row in overall if row["user"] == "Review-A")), 225)
        self.assertEqual(float(next(row["total_points"] for row in sentence if row["user"] == "Review-A")), 75)


if __name__ == "__main__":
    unittest.main()
