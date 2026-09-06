import unittest
from unittest.mock import patch

import quiz_navigation


class QuizNavigationTests(unittest.TestCase):
    def test_defaults_to_entrypoint_mode(self):
        with patch.object(quiz_navigation.st, "query_params", {}):
            self.assertEqual(quiz_navigation.get_quiz_mode("vocab"), "vocab")
            self.assertEqual(quiz_navigation.get_quiz_mode("sentence"), "sentence")

    def test_resolves_sentence_aliases(self):
        for value in ("sentence", "sentences", "phrase", "例文"):
            with self.subTest(value=value):
                with patch.object(quiz_navigation.st, "query_params", {"quiz": value}):
                    self.assertEqual(quiz_navigation.get_quiz_mode("vocab"), "sentence")

    def test_resolves_vocab_aliases(self):
        for value in ("vocab", "word", "words", "単語"):
            with self.subTest(value=value):
                with patch.object(quiz_navigation.st, "query_params", {"mode": value}):
                    self.assertEqual(quiz_navigation.get_quiz_mode("sentence"), "vocab")

    def test_invalid_value_falls_back_to_default(self):
        with patch.object(quiz_navigation.st, "query_params", {"quiz": "unknown"}):
            self.assertEqual(quiz_navigation.get_quiz_mode("sentence"), "sentence")


if __name__ == "__main__":
    unittest.main()
