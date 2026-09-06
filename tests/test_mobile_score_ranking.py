import datetime
import unittest
from unittest.mock import patch

import mobile_ranking
import mobile_score_sync
from ranking_utils import ranking_rows, score_log_totals, summarize_rankings_from_stats


def score_payload(**overrides):
    payload = {
        "type": "save_score",
        "requestId": "req-1",
        "saveId": "mobile-session-1",
        "sessionId": "session-1",
        "appVersion": "test",
        "user": "MontaInterno",
        "mode": "vocab",
        "direction": "eo_to_ja",
        "correct": 9,
        "total": 10,
        "accuracy": 0.9,
        "points": 123.4,
        "accuracyBonus": 45.0,
        "rawPointsTotal": 78.4,
        "rawPointsMain": 78.4,
        "rawPointsSpartan": 0.0,
        "spartanScaledPoints": 0.0,
        "spartanAttempts": 0,
        "spartanCorrect": 0,
        "spartanAccuracy": 0.0,
        "spartanMode": True,
        "groupId": "g1",
        "seed": 1,
        "pos": "noun",
        "startedAt": "2026-05-13T00:00:00Z",
        "completedAt": "2026-05-13T00:03:00Z",
        "ts": "2026-05-13T00:03:00Z",
    }
    payload.update(overrides)
    return payload


class MobileScoreSyncTests(unittest.TestCase):
    @patch.object(mobile_score_sync, "_update_totals", return_value=(True, True))
    @patch.object(mobile_score_sync, "_append_score", return_value=True)
    def test_save_mobile_score_success_keeps_save_id(self, append_score, update_totals):
        result = mobile_score_sync.save_mobile_score_request(score_payload())

        self.assertTrue(result["ok"])
        self.assertEqual(result["saveId"], "mobile-session-1")
        self.assertEqual(result["requestId"], "req-1")
        self.assertEqual(result["recoverable"], "")
        append_score.assert_called_once()
        update_totals.assert_called_once()

    @patch.object(mobile_score_sync, "_update_totals", return_value=(False, True))
    @patch.object(mobile_score_sync, "_append_score", return_value=True)
    def test_save_mobile_score_marks_recoverable_when_totals_update_fails(self, append_score, update_totals):
        result = mobile_score_sync.save_mobile_score_request(score_payload())

        self.assertFalse(result["ok"])
        self.assertEqual(result["saveId"], "mobile-session-1")
        self.assertEqual(result["recoverable"], "totals_update")
        self.assertIn("累積得点", result["message"])
        append_score.assert_called_once()
        update_totals.assert_called_once()

    @patch.object(mobile_score_sync, "_update_totals")
    @patch.object(mobile_score_sync, "_append_score")
    def test_save_mobile_score_rejects_missing_user_without_writes(self, append_score, update_totals):
        result = mobile_score_sync.save_mobile_score_request(score_payload(user=""))

        self.assertFalse(result["ok"])
        self.assertIn("ユーザー名", result["message"])
        append_score.assert_not_called()
        update_totals.assert_not_called()

    @patch.object(mobile_score_sync, "_update_totals")
    @patch.object(mobile_score_sync, "_append_score")
    def test_save_rejects_names_that_cannot_read_progress_or_change_visibility(self, append_score, update_totals):
        for user in ("Audit\tUser", "Audit\nUser", "Audit\x7fUser", 12, {}, ["Alice"]):
            with self.subTest(user=user):
                result = mobile_score_sync.save_mobile_score_request(score_payload(user=user))
                self.assertFalse(result["ok"])
        append_score.assert_not_called()
        update_totals.assert_not_called()

    @patch.object(mobile_score_sync, "_update_totals", return_value=(True, True))
    @patch.object(mobile_score_sync, "_append_score", return_value=True)
    def test_valid_name_keeps_case_unicode_and_existing_length(self, append_score, update_totals):
        user = "Alice-Ĉ" + "名" * 40
        result = mobile_score_sync.save_mobile_score_request(score_payload(user=f"  {user}  "))
        self.assertTrue(result["ok"])
        self.assertEqual(append_score.call_args[0][0]["user"], user)


class MobileRankingTests(unittest.TestCase):
    def setUp(self):
        visibility_patch = patch.object(mobile_ranking, "load_ranking_visibility", return_value={})
        self.visibility = visibility_patch.start()
        self.addCleanup(visibility_patch.stop)

    def test_score_log_totals_deduplicates_save_id_and_uses_jst_dates(self):
        rows = [
            {"user": "A", "points": "10", "ts": "2026-05-12T15:30:00Z", "save_id": "same"},
            {"user": "A", "points": "10", "ts": "2026-05-12T15:30:00Z", "save_id": "same"},
            {"user": "B", "points": "5", "ts": "2026-05-01T00:00:00Z", "save_id": "other"},
        ]
        now = datetime.datetime(2026, 5, 13, 12, 0, tzinfo=datetime.timezone(datetime.timedelta(hours=9)))

        overall, today, month = score_log_totals(rows, now=now)

        self.assertEqual(overall, {"A": 10.0, "B": 5.0})
        self.assertEqual(today, {"A": 10.0})
        self.assertEqual(month, {"A": 10.0, "B": 5.0})

    def test_partial_legacy_logs_do_not_erase_larger_existing_ranking_totals(self):
        stats_rows = [
            {"user": "A", "total_points": "100"},
            {"user": "B", "total_points": "20"},
        ]
        score_rows = [
            {"user": "A", "points": "30", "ts": "2026-05-13T00:00:00Z", "save_id": "a1"},
            {"user": "C", "points": "40", "ts": "2026-05-13T00:00:00Z", "save_id": "c1"},
        ]

        overall, _, _, hof = summarize_rankings_from_stats(stats_rows, score_rows=score_rows, hof_threshold=90)
        rows, current = ranking_rows(overall, current_user="C", top_n=2)

        self.assertEqual(overall["A"], 100.0)
        self.assertEqual(overall["B"], 20.0)
        self.assertEqual(overall["C"], 40.0)
        self.assertEqual(hof, {"A": 100.0})
        self.assertEqual([row["user"] for row in rows], ["A", "C"])
        self.assertEqual(current["user"], "C")

    def test_a_zero_point_log_does_not_prove_historical_total_is_zero(self):
        totals, _, _, hof = summarize_rankings_from_stats(
            [{"user": "A", "total_points": 2_000_000}],
            score_rows=[{"user": "A", "points": 0}],
        )
        self.assertEqual(totals, {"A": 2_000_000})
        self.assertEqual(hof, {"A": 2_000_000})

    def test_month_ranking_excludes_prior_and_future_months_across_year_boundary(self):
        rows = [
            {"user": "A", "points": 1, "ts": "2026-11-30T14:59:59Z"},
            {"user": "A", "points": 2, "ts": "2026-11-30T15:00:00Z"},
            {"user": "A", "points": 4, "ts": "2026-12-31T14:59:59Z"},
            {"user": "A", "points": 8, "ts": "2026-12-31T15:00:00Z"},
        ]
        now = datetime.datetime(2026, 12, 31, 12, tzinfo=datetime.timezone(datetime.timedelta(hours=9)))
        overall, today, month = score_log_totals(rows, now=now)
        self.assertEqual(overall, {"A": 15})
        self.assertEqual(today, {"A": 4})
        self.assertEqual(month, {"A": 6})

    @patch.object(mobile_ranking, "load_sheet_records")
    def test_mobile_ranking_request_returns_live_rankings(self, load_sheet_records):
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        load_sheet_records.side_effect = [
            [{"user": "A", "total_points": "100"}],
            [
                {"user": "B", "points": "50", "ts": now, "save_id": "b1"},
                {"user": "B", "points": "50", "ts": now, "save_id": "b1"},
            ],
        ]

        result = mobile_ranking.load_mobile_rankings_request({
            "type": "load_rankings",
            "requestId": "rank-1",
            "user": "B",
        })

        self.assertTrue(result["ok"])
        self.assertEqual(result["requestId"], "rank-1")
        self.assertEqual(result["user"], "B")
        self.assertEqual(result["source"], "live")
        self.assertEqual(result["rankings"]["overall"][0]["user"], "A")
        self.assertEqual(result["own"]["overall"]["user"], "B")
        self.assertEqual(result["own"]["overall"]["points"], 50.0)
        self.assertGreaterEqual(load_sheet_records.call_count, 2)

    @patch.object(mobile_ranking, "load_sheet_records", return_value=None)
    def test_mobile_ranking_request_reports_sheet_error(self, load_sheet_records):
        result = mobile_ranking.load_mobile_rankings_request({
            "type": "load_rankings",
            "requestId": "rank-error",
        })

        self.assertFalse(result["ok"])
        self.assertEqual(result["requestId"], "rank-error")
        self.assertIn("再読み込み", result["message"])
        self.assertGreaterEqual(load_sheet_records.call_count, 2)

    @patch.object(mobile_ranking, "load_sheet_records")
    def test_private_current_user_is_excluded_from_every_public_list(self, load_sheet_records):
        self.visibility.return_value = {"Private": False, "Public": True}
        now = datetime.datetime.now(datetime.timezone.utc).isoformat()
        load_sheet_records.side_effect = [
            [{"user": "Private", "total_points": 3_000_000}, {"user": "Public", "total_points": 2_000_000}],
            [
                {"user": "Private", "points": 3_000_000, "ts": now},
                {"user": "Public", "points": 2_000_000, "ts": now},
                {"user": "NoPreference", "points": 1_000_000, "ts": now},
            ],
        ]
        result = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Private"})
        self.assertTrue(result["ok"])
        for period in ("overall", "today", "month", "hof"):
            self.assertEqual([row["user"] for row in result["rankings"][period]], ["Public", "NoPreference"])
            self.assertEqual([row["rank"] for row in result["rankings"][period]], [1, 2])
            self.assertIsNone(result["own"][period])

    @patch.object(mobile_ranking, "load_sheet_records")
    def test_unavailable_preferences_do_not_publish_any_cached_or_fallback_ranking(self, load_sheet_records):
        self.visibility.return_value = None
        result = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Private"})
        self.assertFalse(result["ok"])
        self.assertTrue(all(rows == [] for rows in result["rankings"].values()))
        self.assertEqual(result["own"], {})
        self.assertIn("公開設定", result["message"])
        load_sheet_records.assert_not_called()

    @patch.object(mobile_ranking, "load_sheet_records")
    def test_private_users_stay_hidden_in_stats_only_fallback(self, load_sheet_records):
        self.visibility.return_value = {"Private": False}
        load_sheet_records.side_effect = [[{"user": "Private", "total_points": 100}], None]
        result = mobile_ranking.load_mobile_rankings_request({"type": "load_rankings", "user": "Private"})
        self.assertTrue(result["ok"])
        self.assertEqual(result["source"], "stats_only")
        self.assertEqual(result["rankings"]["overall"], [])


class LearningRecordWordingTests(unittest.TestCase):
    @patch.object(mobile_score_sync, "_update_totals", return_value=(True, True))
    @patch.object(mobile_score_sync, "_append_score", return_value=True)
    def test_saved_record_message_is_independent_of_public_ranking(self, append_score, update_totals):
        for lang, expected in (("ja", "学習記録"), ("zh", "学习记录"), ("ko", "학습 기록")):
            with self.subTest(lang=lang):
                result = mobile_score_sync.save_mobile_score_request(score_payload(targetLang=lang, rankingPublic=False))
                self.assertTrue(result["ok"])
                self.assertIn(expected, result["message"])


if __name__ == "__main__":
    unittest.main()
