"""Exercise the actual persistence/aggregation path without credentials or network."""

import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import mobile_ranking
import mobile_score_sync
import score_append_utils
import score_sync_service
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

    def test_larger_stored_totals_are_preserved_without_proof_of_complete_history(self):
        self.store.sheets["UserStats"].update("B2", [[999]], value_input_option="RAW")
        self.store.sheets["UserStatsSentence"].update("B2", [[999]], value_input_option="RAW")
        rankings = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Review-A"})
        self.assertEqual(rankings["own"]["overall"]["points"], 999)
        self.assertEqual(score_sync_service.update_totals_for_record({"user": "Review-A", "mode": "sentence"}), (True, True))
        self.assertEqual(float(self.store.sheets["UserStats"].get_all_values()[1][1]), 999)
        self.assertEqual(float(self.store.sheets["UserStatsSentence"].get_all_values()[1][1]), 999)

    def test_lower_stale_snapshot_keeps_the_existing_larger_total(self):
        self.assertTrue(score_append_utils.upsert_user_total("UserStats", user="Review-A", total_points=100, last_updated="old", retries=1))
        self.assertEqual(float(self.store.sheets["UserStats"].get_all_values()[1][1]), 200)

    def test_failed_canonical_read_does_not_change_derived_totals(self):
        before = self.store.sheets["UserStats"].get_all_values()
        with patch.object(self.store.sheets["Scores"], "get_all_values", side_effect=TimeoutError("Scores unavailable")):
            with patch.object(score_sync_service.time, "sleep"):
                self.assertEqual(score_sync_service.update_totals_for_record({"user": "Review-A", "mode": "vocab"}), (False, True))
        self.assertEqual(self.store.sheets["UserStats"].get_all_values(), before)

    def test_first_new_score_does_not_replace_a_legacy_total_with_partial_history(self):
        self.store.sheets["UserStats"].append_row(["Legacy", "70", "old"], value_input_option="RAW")
        self.store.sheets["UserStatsSentence"].append_row(["Legacy", "70", "old"], value_input_option="RAW")
        result = mobile_score_sync.save_mobile_score_request({
            "type": "save_score", "user": "Legacy", "saveId": "legacy-first-new-score",
            "mode": "sentence", "topic": "travel", "points": 5, "total": 1,
        })
        self.assertTrue(result["ok"])
        for name in ("UserStats", "UserStatsSentence"):
            row = next(row for row in score_append_utils.load_sheet_records(name) if row["user"] == "Legacy")
            self.assertEqual(float(row["total_points"]), 70)
        self.assertEqual(score_append_utils.compute_user_score_totals(score_append_utils.load_sheet_records("Scores"), "Legacy")["overall"], 5)
        rankings = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Legacy"})
        self.assertEqual(rankings["own"]["overall"]["points"], 70)

    def test_concurrent_score_does_not_trigger_an_unsafe_downward_repair(self):
        stats = self.store.sheets["UserStats"]
        stats.update("B2", [[999]], value_input_option="RAW")
        original_update = stats.update
        concurrent = {"ran": False, "ok": None}

        def new_score_before_older_stats_write(*args, **kwargs):
            if not concurrent["ran"]:
                concurrent["ran"] = True
                concurrent["ok"] = mobile_score_sync.save_mobile_score_request({
                    "type": "save_score", "user": "Review-A", "saveId": "concurrent-new-score",
                    "mode": "vocab", "pos": "noun", "points": 25, "total": 1,
                })["ok"]
            return original_update(*args, **kwargs)

        with patch.object(stats, "update", side_effect=new_score_before_older_stats_write):
            self.assertTrue(score_append_utils.upsert_user_total("UserStats", user="Review-A", total_points=200, last_updated="older", retries=1))
        self.assertTrue(concurrent["ok"])
        self.assertEqual(float(stats.get_all_values()[1][1]), 999)
        self.assertEqual(score_append_utils.compute_user_score_totals(score_append_utils.load_sheet_records("Scores"), "Review-A")["overall"], 225)

    def test_malformed_scores_headers_use_stats_fallback_without_fabricating_zero(self):
        self.store.sheets["Scores"] = fixture.MemoryWorksheet("Scores", ["user", "wrong_points"], [
            {"user": "Review-A", "wrong_points": 200},
        ])
        rankings = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Review-A"})
        self.assertTrue(rankings["ok"])
        self.assertEqual(rankings["source"], "stats_only")
        self.assertEqual(rankings["own"]["overall"]["points"], 200)
        self.assertIsNone(score_sync_service.load_score_records_for_totals(retries=1))

    def test_legacy_stats_only_name_keeps_its_total_when_no_score_logs_exist(self):
        self.store.sheets["UserStats"].append_row(["Legacy", "70", "old"], value_input_option="RAW")
        self.assertTrue(score_append_utils.upsert_user_total("UserStats", user="Legacy", total_points=0, last_updated="now", retries=1))
        legacy = next(row for row in score_append_utils.load_sheet_records("UserStats") if row["user"] == "Legacy")
        self.assertEqual(float(legacy["total_points"]), 70)

    def test_header_extension_preserves_existing_columns_with_an_interior_blank(self):
        sheet = fixture.MemoryWorksheet("Scores", ["user", "", "points", "save_id"], [
            {"user": "Legacy", "points": 42, "save_id": "legacy-score"},
        ])
        self.store.sheets["Scores"] = sheet
        self.assertTrue(score_sync_service.append_score_record({"user": "New", "points": 5, "save_id": "new-score", "mode": "vocab"}))
        self.assertEqual(sheet.row_values(1)[:4], ["user", "", "points", "save_id"])
        records = score_append_utils.load_sheet_records("Scores")
        self.assertEqual(records[0], {"user": "Legacy", "points": "42", "save_id": "legacy-score", "mode": ""})
        self.assertEqual(score_append_utils.compute_user_score_totals(records, "Legacy")["overall"], 42)


if __name__ == "__main__":
    unittest.main()
