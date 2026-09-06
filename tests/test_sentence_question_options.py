"""The live browser question builder must never render duplicate choices."""

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def make_entries():
    pairs = [
        ("Frazo A1", "同じ日本語"),
        ("Frazo A2", "同じ日本語"),
        ("Sama frazo", "日本語B1"),
        ("Sama frazo", "日本語B2"),
        ("Pardonu min", "申し訳ありません。"),
        ("Pardonu min", "申し訳ありません。"),
    ] + [(f"Frazo {index}", f"文{index}") for index in range(7, 15)]
    return [
        {"id": index, "eo": eo, "ja": ja, "level": 1}
        for index, (eo, ja) in enumerate(pairs)
    ]


class SentenceQuestionOptionUniquenessTests(unittest.TestCase):
    def check_direction(self, direction, display_key):
        source = """
            import { buildLocalizedQuestion } from "./mobile_app/quiz_questions.mjs";
            const pool = POOL;
            const questions = [];
            for (let seed = 0; seed < 20; seed += 1) {
                let value = seed;
                const rng = () => {
                    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
                    return value / 4294967296;
                };
                for (const correct of pool) {
                    const question = buildLocalizedQuestion({
                        mode: "sentence", correct, pool, rng,
                        direction: DIRECTION, targetLang: "ja",
                    });
                    if (question) questions.push(question);
                }
            }
            console.log(JSON.stringify(questions));
        """.replace("POOL", json.dumps(make_entries())).replace("DIRECTION", json.dumps(direction))
        run = subprocess.run(
            ["node", "--input-type=module", "-e", source], cwd=ROOT,
            text=True, capture_output=True, check=True, timeout=20,
        )
        questions = json.loads(run.stdout)
        self.assertEqual(len(questions), 20 * len(make_entries()))
        for question in questions:
            labels = [option[display_key] for option in question["options"]]
            self.assertEqual(len(labels), 4)
            self.assertEqual(len(set(labels)), 4)
            correct = question["options"][question["answerIndex"]]
            self.assertEqual(correct["eo"], question["promptEo"])
            self.assertEqual(correct["ja"], question["promptJa"])

    def test_eo_to_ja_options_have_unique_japanese(self):
        self.check_direction("eo_to_ja", "ja")

    def test_ja_to_eo_options_have_unique_esperanto(self):
        self.check_direction("ja_to_eo", "eo")


if __name__ == "__main__":
    unittest.main()
