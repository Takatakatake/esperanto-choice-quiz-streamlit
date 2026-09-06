# 承認済み3例文の修正 — 2026-09-06

再点検の追加候補のうち、ユーザーが承認したID4949・406・2515のみ適用した。
対象は `phrases_eo_en_ja_zh_ko_ru_fulfilled_260505.csv`。過去の編集ログ配下のCSVは履歴として保持する。

## 変更内容

| PhraseID | データ行 / CSV行 | 列 | 変更前 | 変更後 |
|---|---|---|---|---|
| 406 | 251 / 252 | Esperanto | Mi lernas la urduon | Mi lernas urduon |
| 2515 | 2360 / 2361 | Esperanto | Ĉu la restoracia vagono estas antaŭe aŭ malantaŭe de la trajno? | Ĉu la restoracia vagono estas antaŭe aŭ malantaŭe en la trajno? |
| 4949 | 4794 / 4795 | 日本語 | 一等郵便の切手を1シートいただけますか。 | 一等郵便の切手帳を1冊いただけますか。 |

406は名詞の言語名の冠詞を教材の標準的な用法に合わせた。冠詞付きの歴史的用例を否定する修正ではない。[PMEG](https://bertilow.com/pmeg/gramatiko/propraj_nomoj/landoj_popoloj_lingvoj.html)

2515は食堂車が列車編成の中の前方・後方にあることを明示した。元の文も文脈から理解できるが、承認された明確化を適用した。[PMEGの参考説明](https://bertilow.com/pmeg/gramatiko/rolmontriloj/rolvortetoj/lokaj_rolvortetoj/antau.html)

4949は `libreto` および他言語訳の冊子という意味に合わせた。切手帳とシートは別の形態である。[郵便事業者の用例](https://shop.royalmail.com/postage-and-packaging/first-and-second-class-stamps)

任意のコンマ追加候補2061・4544・4678は今回の対象に含めていない。

## 音声

エスペラント本文が変わった406・2515のみ再生成した。実モデルの `voice.info` が `name=Spomenka`、`language=Esperanto` であることを確認した。
生成コマンドは `/usr/bin/RHVoice-test -p spomenka -R 24000 -o <出力WAV>`、入力は変更後の本文と末尾改行である。
RHVoice / Esperanto（eo）/ spomenka、パッケージ版1.8.0+dfsg-3build3。PCM WAV、24,000 Hz、モノラル、16-bit。
同じ本文・条件で別ファイルへ再生成したWAVとバイト一致し、認証なしでDriveから取得したWAVもSHA-256で一致した。

| PhraseID | 新WAV | 長さ | SHA-256 |
|---|---|---|---|
| 406 | `0251_mi_lernas_urduon.wav` | 1.655秒 | `7a81fa86e77338308123e9564800c8248a6bd29794347f439d3efc3db84f919c` |
| 2515 | `2360_cxu_la_restoracia_vagono_estas_antauxe_aux_malantauxe_en_la_trajno.wav` | 5.365秒 | `2274087a7013421dadb288252f5c20954b398a3c87c52a3b27d7cc926cff3004` |

元音声フォルダーと `mobile_app/sentence-audio/` に同じ新WAVを配置した。旧2音声は独立バックアップとの一致を確認後、現行のローカル音声フォルダーから除いた。
4949は日本語訳のみの修正であり、エスペラント本文・WAV・音声キー・Drive IDを維持した。

旧版クライアントのためDrive上の旧音声は保持した。現行manifestは5,000キー、Driveは5,004音声、旧版保持分は4キーである。

## 配信用データと確認

- CSV全セルを比較し、5,000行・ヘッダ・ID・行順を保持したまま3行・3セルのみ変更。
- `tools/build_mobile_data.py` で例文JSONを再生成し、差分が406・2515・4949のみであることを確認。単語JSONは不変。
- 音声manifestは対象2キー・ファイルIDのみ変更し、その他の単語・例文の対応は不変。
- `tools/update_mobile_version.py` でアプリ・CSS URL・サービスワーカーを `2026-09-06-phrases-2` に統一。
- Python126件、JavaScript70件の既存テストが成功。
- `tools/validate_mobile_assets.py --strict-warnings` が成功。全15,768 WAVのヘッダとCSV・JSON・音声・Drive対応を確認。
- Git管理情報、依存関係、実行キャッシュ、認証情報を除き、両フォルダーの20,983ファイルがSHA-256で一致。
- 音声の検証は生成入力・モデル・再生成一致・WAV形式・配信用バイト列の照合であり、人による聞き取り評価は含まない。

適用前CSV SHA-256：`cf01bf3d02551a9b20d3f02a45ad5c8479fcd05272201ecbe627e9f49f341fd2`

適用後CSV SHA-256：`4b99ba24c44d423ce71a73953a0368f66d9b18f75549755e4ed4855d4b1e6e9a`
