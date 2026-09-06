"""The live JSON must retain the correct translation for all three languages."""

import csv
import json
import unittest
from pathlib import Path

from data_sources import PHRASE_CSV

ROOT = Path(__file__).resolve().parents[1]


class SentenceLocaleColumnTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with PHRASE_CSV.open(encoding="utf-8-sig", newline="") as handle:
            cls.source_rows = {int(row["PhraseID"]): row for row in csv.DictReader(handle)}
        cls.entries = json.loads((ROOT / "mobile_app/data/sentences.json").read_text())["entries"]

    def test_live_data_uses_each_localized_column(self):
        self.assertEqual(len(self.entries), len(self.source_rows))
        for entry in self.entries:
            source = self.source_rows[entry["id"]]
            for lang, column in (("ja", "日本語"), ("zh", "中文"), ("ko", "한국어")):
                expected = source[column].strip() or source["日本語"].strip()
                with self.subTest(phrase_id=entry["id"], language=lang):
                    self.assertEqual(entry["translations"][lang], expected)

    def test_chinese_and_korean_are_not_replaced_with_japanese(self):
        for lang, column in (("zh", "中文"), ("ko", "한국어")):
            distinct_count = 0
            for entry in self.entries:
                source = self.source_rows[entry["id"]]
                translation = source[column].strip()
                if translation and translation != source["日本語"].strip():
                    distinct_count += 1
                    self.assertNotEqual(entry["translations"][lang], entry["translations"]["ja"])
            self.assertGreater(distinct_count, 0)


if __name__ == "__main__":
    unittest.main()
