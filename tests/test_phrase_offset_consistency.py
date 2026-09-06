"""例文音声/画像キーの PhraseID オフセットが一元化されていることを守る。

例文の音声/画像キーは `f"{PhraseID - PHRASE_ID_OFFSET:04d}_<正規化キー>"`（PhraseID
156–5155 を連番 0001–5000 に対応づける）で生成される。2026-06-07 に、以前は5+2ファイルへ
直書きされていたオフセット `155` を `data_sources.PHRASE_ID_OFFSET` へ一元化した
（DRY / 単一の信頼できる情報源）。本テストはその一元化を守る:

  1. `data_sources.PHRASE_ID_OFFSET == 155`（単一の真実の源）。
  2. 利用側ファイルが PhraseID オフセットを **直書きしていない**（`<phrase系> - <整数>` が無い）。
  3. 利用側ファイルが中央定数 `PHRASE_ID_OFFSET` を参照している。

これにより、誰かが再びどこかに `- 155` を直書きしてキーを食い違わせる退行を検知する。
各言語の画面は共通JSONを利用し、音声キーの生成は以下のツールに集約されている。
"""
import ast
import unittest
from pathlib import Path

from data_sources import PHRASE_ID_OFFSET

ROOT = Path(__file__).resolve().parents[1]

# PhraseID オフセットでキーを作る利用側ファイル群。
FILES = [
    "tools/build_mobile_data.py",
    "tools/validate_mobile_assets.py",
    "tools/reconcile_phrase_audio_rhvoice.py",
    "tools/verify_spomenka_audio.py",
]


def _hardcoded_phrase_offsets(path: Path) -> list:
    """`<phrase_id 系の名前> - <整数リテラル>` という直書き減算を検出する。"""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    found = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.BinOp)
            and isinstance(node.op, ast.Sub)
            and isinstance(node.right, ast.Constant)
            and isinstance(node.right.value, int)
        ):
            names = [n.id.lower() for n in ast.walk(node.left) if isinstance(n, ast.Name)]
            if any("phrase" in name or name == "pid" for name in names):
                found.append(node.right.value)
    return found


def _references_offset_constant(path: Path) -> bool:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    return any(isinstance(n, ast.Name) and n.id == "PHRASE_ID_OFFSET" for n in ast.walk(tree))


class PhraseOffsetCentralizationTests(unittest.TestCase):
    def test_offset_single_source_value(self):
        self.assertEqual(PHRASE_ID_OFFSET, 155)

    def test_no_file_hardcodes_offset(self):
        for rel in FILES:
            with self.subTest(file=rel):
                hardcoded = _hardcoded_phrase_offsets(ROOT / rel)
                self.assertEqual(
                    hardcoded,
                    [],
                    msg=(
                        f"{rel} に PhraseID オフセットの直書き {hardcoded} が残存。"
                        " data_sources.PHRASE_ID_OFFSET を参照してください。"
                    ),
                )

    def test_files_reference_central_constant(self):
        for rel in FILES:
            with self.subTest(file=rel):
                self.assertTrue(
                    _references_offset_constant(ROOT / rel),
                    msg=f"{rel} が中央定数 PHRASE_ID_OFFSET を参照していません。",
                )


if __name__ == "__main__":
    unittest.main()
