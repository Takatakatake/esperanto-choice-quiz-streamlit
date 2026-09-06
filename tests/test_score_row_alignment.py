"""スコアシートの列整列レイヤ（純粋関数）の契約を固定する。

`score_append_utils` には、ネットワーク非依存だが **データの列整列を司る** 2 つの
load-bearing 関数があり、いずれも直接テストが無かった:

  - `_row_from_headers(record, headers)`:
      append 直前に、レコード(dict)を **シートの実ヘッダ順** に並べた行(list)へ変換する。
      ここがずれると全データが誤った列に書き込まれる。
  - `_read_records_from_values(values)`:
      `get_all_values()` の生 2 次元配列を records(dict のリスト)へ解析する。
      `load_sheet_records` → 集計(`compute_user_score_totals`)・ランキングの入口。

本テストは現行の正しい振る舞いを特性化(characterization)して回帰ガードにする。
**稼働コードは変更しない**（純粋追加）。

なお重要なコントラスト:
  読み側 `_read_records_from_values` は **内部の空ヘッダ列があっても位置整列を保つ**
  （空ヘッダ列を出力 dict から落とすだけで、右隣の列を左詰めしない＝堅牢）。
  一方、書き側 `_write_header_row` は内部空白を詰めるため、手動編集で内部空セルが
  でき且つ必須列が欠けるとヘッダが左シフトしうる（既知の潜在バグ。Sheets 書込経路に
  触れるため修正は意図的に見送り中）。本テストは「読み側は安全」を明示的に固定する。
"""
import unittest
from unittest.mock import Mock, patch

import score_append_utils
from score_append_utils import _read_records_from_values, _row_from_headers


class RowFromHeadersTests(unittest.TestCase):
    def test_orders_values_by_header_sequence(self):
        # 出力はレコードの挿入順ではなく headers の順に従う。
        record = {"points": "2", "user": "1"}
        self.assertEqual(_row_from_headers(record, ["user", "points"]), ["1", "2"])

    def test_missing_keys_become_empty_string(self):
        self.assertEqual(_row_from_headers({"a": "1"}, ["a", "b", "c"]), ["1", "", ""])

    def test_none_becomes_empty_string(self):
        self.assertEqual(_row_from_headers({"a": None, "b": "x"}, ["a", "b"]), ["", "x"])

    def test_numeric_and_zero_are_stringified_not_dropped(self):
        # 0 / 0.0 は None ではないので "" にならず文字列化される（欠損と区別される）。
        self.assertEqual(_row_from_headers({"a": 0, "b": 0.0}, ["a", "b"]), ["0", "0.0"])

    def test_extra_keys_not_in_headers_are_ignored(self):
        self.assertEqual(_row_from_headers({"a": "1", "z": "9"}, ["a"]), ["1"])


class ReadRecordsFromValuesTests(unittest.TestCase):
    def test_required_headers_distinguish_empty_account_from_invalid_sheet(self):
        worksheet = Mock()
        with patch.object(score_append_utils, "_open_worksheet", return_value=(worksheet, None)):
            for values in ([], [["user", "wrong"]], [["user", "points", "points"]]):
                with self.subTest(values=values):
                    worksheet.get_all_values.return_value = values
                    self.assertIsNone(score_append_utils.load_sheet_records("Scores", required_headers=("user", "points")))
            worksheet.get_all_values.return_value = [["user", "points"]]
            self.assertEqual(score_append_utils.load_sheet_records("Scores", required_headers=("user", "points")), [])

    def test_basic_parse(self):
        values = [["user", "points"], ["alice", "100"], ["bob", "50"]]
        self.assertEqual(
            _read_records_from_values(values),
            [{"user": "alice", "points": "100"}, {"user": "bob", "points": "50"}],
        )

    def test_empty_and_header_only(self):
        self.assertEqual(_read_records_from_values([]), [])
        self.assertEqual(_read_records_from_values([["user", "points"]]), [])

    def test_short_rows_are_padded(self):
        values = [["user", "points", "mode"], ["alice", "100"]]
        self.assertEqual(
            _read_records_from_values(values),
            [{"user": "alice", "points": "100", "mode": ""}],
        )

    def test_all_blank_rows_are_dropped(self):
        values = [["user", "points"], ["", ""], ["  ", ""], ["alice", "100"]]
        self.assertEqual(
            _read_records_from_values(values),
            [{"user": "alice", "points": "100"}],
        )

    def test_extra_trailing_cells_ignored(self):
        values = [["user", "points"], ["alice", "100", "EXTRA"]]
        self.assertEqual(
            _read_records_from_values(values),
            [{"user": "alice", "points": "100"}],
        )

    def test_interior_blank_header_column_is_skipped_without_shifting(self):
        # 読み側は堅牢: 内部の空ヘッダ列の値は dropされるが、右隣の "points" は
        # 位置どおり正しく対応づく（左シフトしない）。書き側バグの対になる安全側。
        values = [["user", "", "points"], ["alice", "junk", "100"]]
        self.assertEqual(
            _read_records_from_values(values),
            [{"user": "alice", "points": "100"}],
        )


if __name__ == "__main__":
    unittest.main()
