import copy
import re
import unittest
from unittest.mock import patch

import user_settings


HEADERS = ["user", "ranking_public", "updated_at"]


class FakeWorksheet:
    def __init__(self, values):
        self.values = copy.deepcopy(values)
        self.writes = []
        self.fail_reads = False
        self.fail_next_batch = False

    def get_all_values(self):
        if self.fail_reads:
            raise TimeoutError("private credential detail")
        return copy.deepcopy(self.values)

    def append_row(self, row, **kwargs):
        self.writes.append(("append", row, kwargs))
        self.values.append(list(row))

    def batch_update(self, updates, **kwargs):
        self.writes.append(("batch", updates, kwargs))
        if self.fail_next_batch:
            self.fail_next_batch = False
            raise TimeoutError("private credential detail")
        for update in updates:
            match = re.fullmatch(r"([A-Z]+)(\d+)", update["range"])
            column = 0
            for letter in match[1]:
                column = column * 26 + ord(letter) - ord("A") + 1
            row = self.values[int(match[2]) - 1]
            row.extend([""] * max(0, column - len(row)))
            row[column - 1] = update["values"][0][0]


class UserSettingsTests(unittest.TestCase):
    def setUp(self):
        self.sheet = FakeWorksheet([HEADERS])
        opener = patch.object(user_settings.sheet_store, "_open_worksheet", side_effect=lambda *args, **kwargs: (self.sheet, "test-settings"))
        self.open_sheet = opener.start()
        self.addCleanup(opener.stop)

    def test_valid_empty_sheet_defaults_to_public(self):
        visibility = user_settings.load_ranking_visibility()
        self.assertEqual(visibility, {})
        self.assertEqual(user_settings.user_settings_result("new", visibility, {}), {"ok": True, "rankingPublic": True, "message": ""})

    def test_duplicate_names_use_private_preference_even_when_public_is_later(self):
        self.sheet.values.extend([[" alice ", "FALSE", "old"], ["alice", "true", "new"], ["Bob", "1", ""]])
        self.assertEqual(user_settings.load_ranking_visibility(), {"alice": False, "Bob": True})

    def test_missing_or_malformed_settings_fail_closed_without_writes(self):
        cases = [
            [], [["user", "ranking_public"]], [["user", "ranking_public", "ranking_public", "updated_at"]],
            [HEADERS, ["alice", "", ""]], [HEADERS, ["alice", "maybe", ""]],
            [HEADERS, ["", "false", ""]], [HEADERS, ["a\nb", "false", ""]],
        ]
        for values in cases:
            with self.subTest(values=values):
                self.sheet.values = values
                self.assertIsNone(user_settings.load_ranking_visibility())
                self.assertFalse(user_settings.upsert_user_settings("alice", False, retries=1))
                self.assertEqual(self.sheet.writes, [])

    def test_read_failure_never_appends_default_or_changes_saved_preference(self):
        self.sheet.values.append(["alice", "false", "existing"])
        self.sheet.fail_reads = True
        self.assertIsNone(user_settings.load_ranking_visibility())
        self.assertFalse(user_settings.upsert_user_settings("alice", True, retries=1))
        self.assertEqual(self.sheet.writes, [])
        self.assertEqual(self.sheet.values[1], ["alice", "false", "existing"])

    def test_existing_duplicate_rows_are_updated_preserving_other_columns_and_users(self):
        self.sheet.values = [
            ["note", "ranking_public", "", "user", "updated_at"],
            ["keep me", "false", "unlabelled", " alice ", "old"],
            ["keep me too", "false", "", "alice", "old"],
            ["other user", "false", "", "bob", "unchanged"],
        ]
        self.assertTrue(user_settings.upsert_user_settings("alice", True, retries=1))
        self.assertEqual(self.sheet.values[1][:4], ["keep me", "true", "unlabelled", " alice "])
        self.assertEqual(self.sheet.values[2][:4], ["keep me too", "true", "", "alice"])
        self.assertEqual(self.sheet.values[3], ["other user", "false", "", "bob", "unchanged"])
        self.assertNotEqual(self.sheet.values[1][4], "old")
        self.assertEqual(len(self.sheet.writes), 1)
        self.assertEqual(self.sheet.writes[0][2]["value_input_option"], "RAW")

    def test_new_settings_are_appended_in_actual_header_order_as_raw_text(self):
        self.sheet.values = [["updated_at", "user", "ranking_public", "note"]]
        self.assertTrue(user_settings.upsert_user_settings("=safe-name", False, retries=1))
        self.assertEqual(self.sheet.values[1][1:], ["=safe-name", "false", ""])
        self.assertEqual(self.sheet.writes[0][2]["value_input_option"], "RAW")

    def test_prewrite_read_failure_can_retry_before_mutating(self):
        self.sheet.values.append(["alice", "true", "old"])
        original_read = self.sheet.get_all_values
        reads = {"count": 0}

        def fail_first_read():
            reads["count"] += 1
            if reads["count"] == 1:
                raise TimeoutError("read failed before any write")
            return original_read()

        with patch.object(self.sheet, "get_all_values", side_effect=fail_first_read):
            with patch.object(user_settings.time, "sleep"):
                self.assertTrue(user_settings.upsert_user_settings("alice", False))
        self.assertEqual(self.sheet.values[1][1], "false")
        self.assertEqual(len(self.sheet.writes), 1)

    def test_write_timeout_does_not_retry_unconfirmed_mutation(self):
        self.sheet.values.append(["alice", "true", "old"])
        self.sheet.fail_next_batch = True
        with patch.object(user_settings.time, "sleep") as sleep:
            self.assertFalse(user_settings.upsert_user_settings("alice", False))
        self.assertEqual(len(self.sheet.values), 2)
        self.assertEqual(self.sheet.values[1][1], "true")
        self.assertEqual(len(self.sheet.writes), 1)
        sleep.assert_called_once_with(0.2)

    def test_applied_write_with_lost_response_is_confirmed_without_another_write(self):
        self.sheet.values.append(["alice", "true", "old"])
        original_batch = self.sheet.batch_update

        def write_then_timeout(*args, **kwargs):
            original_batch(*args, **kwargs)
            raise TimeoutError("write response was lost")

        with patch.object(self.sheet, "batch_update", side_effect=write_then_timeout):
            with patch.object(user_settings.time, "sleep"):
                self.assertTrue(user_settings.upsert_user_settings("alice", False))
        self.assertEqual(self.sheet.values[1][1], "false")
        self.assertEqual(len(self.sheet.writes), 1)

    def test_verification_failure_does_not_claim_success_or_expose_backend_details(self):
        original_append = self.sheet.append_row

        def append_then_fail_read(*args, **kwargs):
            original_append(*args, **kwargs)
            self.sheet.fail_reads = True

        with patch.object(self.sheet, "append_row", side_effect=append_then_fail_read):
            with patch.object(user_settings.time, "sleep"):
                result = user_settings.save_user_settings_request({"type": "save_user_settings", "user": "alice", "rankingPublic": False})
        self.assertFalse(result["ok"])
        self.assertNotIn("credential", result["message"])
        self.assertEqual(len(self.sheet.values), 2)

    def test_concurrent_conflicting_change_is_not_overwritten_by_retry(self):
        self.sheet.values.append(["alice", "false", "old"])
        original_batch = self.sheet.batch_update

        def concurrent_private_change(*args, **kwargs):
            original_batch(*args, **kwargs)
            self.sheet.values[1][1] = "false"

        with patch.object(self.sheet, "batch_update", side_effect=concurrent_private_change):
            with patch.object(user_settings.time, "sleep") as sleep:
                self.assertFalse(user_settings.upsert_user_settings("alice", True))
        self.assertEqual(self.sheet.values[1][1], "false")
        self.assertEqual(len(self.sheet.writes), 1)
        sleep.assert_not_called()

    def test_readback_timeout_does_not_replay_public_over_newer_private_choice(self):
        self.sheet.values.append(["alice", "false", "old"])
        real_read = user_settings._read_settings_sheet
        reads = {"count": 0, "new_private_ok": None}

        def newer_private_before_failed_readback():
            reads["count"] += 1
            if reads["count"] == 2:
                reads["new_private_ok"] = user_settings.upsert_user_settings("alice", False)
                raise TimeoutError("readback response was lost")
            return real_read()

        with patch.object(user_settings, "_read_settings_sheet", side_effect=newer_private_before_failed_readback):
            with patch.object(user_settings.time, "sleep"):
                self.assertFalse(user_settings.upsert_user_settings("alice", True))
        self.assertTrue(reads["new_private_ok"])
        self.assertEqual(self.sheet.values[1][1], "false")
        self.assertEqual(len(self.sheet.writes), 2)

    def test_payload_requires_boolean_and_preserves_name_identity(self):
        with patch.object(user_settings, "upsert_user_settings", return_value=True) as save:
            for value in ("false", "true", 1, None, []):
                self.assertFalse(user_settings.save_user_settings_request({"type": "save_user_settings", "user": "alice", "rankingPublic": value})["ok"])
            for user in ("", None, {}, 5, "al\nice"):
                self.assertFalse(user_settings.save_user_settings_request({"type": "save_user_settings", "user": user, "rankingPublic": False})["ok"])
            save.assert_not_called()
            result = user_settings.save_user_settings_request({"type": "save_user_settings", "requestId": "setting-1", "user": " Alice-Ĉ ", "rankingPublic": False})
            self.assertTrue(result["ok"])
            self.assertEqual(result["user"], " Alice-Ĉ ")
            self.assertEqual(result["requestId"], "setting-1")
            save.assert_called_once_with("Alice-Ĉ", False)


if __name__ == "__main__":
    unittest.main()
