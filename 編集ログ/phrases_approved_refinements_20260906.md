# 承認済み例文の改善を適用 — 2026-09-06

全5,000例文の再点検後、ユーザーが承認した4行・6セルを後継アプリの教材へ反映した。本文2件は意味の明確化、翻訳2件は語義・方向の修正である。本文の旧表現を一律に誤文と判定したものではない。

対象CSV：`phrases_eo_en_ja_zh_ko_ru_fulfilled_260505.csv`

## 適用内容

データ行はヘッダを除く1始まり。PhraseIDとは異なる。

| PhraseID | データ行 / CSV行 | 列 | 変更前 | 変更後 |
|---|---|---|---|---|
| 840 | 685 / 686 | 한국어 | 성함이 어떻게 되세요? | 성이 어떻게 되세요? |
| 2274 | 2119 / 2120 | 日本語 | 高速道路の出口はどこですか。 | 高速道路への入口はどこですか。 |
| 2274 | 2119 / 2120 | 中文 | 高速公路的出口在哪里？ | 高速公路的入口在哪里？ |
| 2274 | 2119 / 2120 | 한국어 | 고속도로 출구가 어디에 있나요? | 고속도로 진입로가 어디에 있나요? |
| 2742 | 2587 / 2588 | Esperanto | Mi bezonas ĝin ĝis la kvina | Mi bezonas ĝin preta ĝis la kvina |
| 4615 | 4460 / 4461 | Esperanto | Mi pensas, ke mi streĉis muskolon en mia kruro | Mi pensas, ke mi trostreĉis muskolon en mia kruro |

PID840は、姓を問う `familinomo` に合わせ、名前全般の敬語 `성함` を姓の `성` へ変更した。元の丁寧な疑問文を保っている。語義は国立国語院の [성함](https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=49073) と [성](https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=63033) に基づく。

PID2274は、EO `al la aŭtovojo`、EN `to the motorway`、RU `на шоссе` が示す高速道路へ入る方向に日中韓訳を合わせた。EO本文・英露訳は維持した。[PMEGのal](https://bertilow.com/pmeg/gramatiko/rolmontriloj/rolvortetoj/direktaj_rolvortetoj/al.html)、国立国語院の [진입로](https://krdict.korean.go.kr/eng/dicSearch/SearchView?ParaWordNo=76312)、[NEXCO中日本の入口案内](https://www.c-nexco.co.jp/en/safety/safety_drive/false_entry/)、[北京市交通委員会の入口に関する説明](https://jtw.beijing.gov.cn/xxgk/zcjd/202011/t20201119_2140264.html) を参照した。完成した3文自体は引用ではなく、語義・用例に基づく最小変更である。

PID2742は、直前の洗濯・スーツの仕上がりの会話に合わせて `preta` を一語補い、5時までに仕上がっている必要を明示した。[PMEGのĝis](https://bertilow.com/pmeg/gramatiko/rolmontriloj/rolvortetoj/direktaj_rolvortetoj/ghis.html) は `preta ĝis` による作業完了期限を説明している。現形でも文脈から期限を理解できるが、単独で「5時まで必要」と読まれる余地を減らした。

PID4615は、各訳の筋肉を痛めたという意味に合わせ、`trostreĉis` で過度な負荷を明示した。普通に筋肉を張る動作も表す `streĉis` を、損傷文脈で明確にする改善である。[PIVのstreĉi](../PIV2020.html#k42832) と [Futbala terminaro 2024](https://www.eventoj.hu/steb/vortaroj/futbalo-de-eo-2024.pdf#page=32) を参照した。

## 音声と配信用データ

EO本文を変更したPID2742・4615のみ、新しい本文から準備済みの音声を適用した。翻訳のみのPID840・2274の音声は変更していない。

音声生成条件：RHVoice、Esperantoモデル、`spomenka`、パッケージ版 `1.8.0+dfsg-3build3`。出力はPCM WAV、24,000 Hz、モノラル、16-bit。準備時に同じ条件で再生成した検証用WAVとのバイト一致を、適用時にもSHA-256で確認した。

| PhraseID | 新WAV | 長さ | SHA-256 |
|---|---|---|---|
| 2742 | `2587_mi_bezonas_gxin_preta_gxis_la_kvina.wav` | 3.030秒 | `805f4a8319587a5ee7d2c860ee19dc1891324034391acdec9d7cc2ac72e35e16` |
| 4615 | `4460_mi_pensas_ke_mi_trostrecxis_muskolon_en_mia_kruro.wav` | 4.715秒 | `4f6fb69b5cb0e01f156f7107fd32a35efe1d8af1d2283fe3a53cb46b4282d14c` |

新WAVを `Esperanto例文5000文_収録音声/` と `mobile_app/sentence-audio/` の双方へ配置した。旧WAVは独立したバックアップのハッシュ一致を確認した後、双方の使用中フォルダーから除いた。

| 旧WAV | 退避確認済みSHA-256 |
|---|---|
| `2587_mi_bezonas_gxin_gxis_la_kvina.wav` | `761c1cacc0bab7687b58b447861a8fdc64d57fe8e38cabaf9fc2c8e36f8aa8da` |
| `4460_mi_pensas_ke_mi_strecxis_muskolon_en_mia_kruro.wav` | `559f34c5539de463350775493c7adec358eb3989c6cd34b689e7c55ea653e60b` |

`python3 -B tools/build_mobile_data.py` で `mobile_app/data/sentences.json` を再生成した。例文音声のキーは `PhraseID - 155` とEO本文から算出されるため、本文を変更した2件のキーも更新された。

## 適用時の確認

- 適用前CSVのSHA-256：`2c099e662593705b9a37fbe0a82e1d30bb66497b4d053aac3b8f6988ef5f2ab1`。CRLF改行の作業ファイルの値であり、Git内のLF改行の値とは異なる。準備時の値・バックアップと一致してから変更した。
- 適用後CSVのSHA-256：`cf01bf3d02551a9b20d3f02a45ad5c8479fcd05272201ecbe627e9f49f341fd2`。準備済みCSVと一致。
- ヘッダ、5,000行の行順・PhraseIDを維持。全セル比較で変更は上表の4行・6セルのみ。
- 例文JSONは5,000件。変更したIDは840・2274・2742・4615のみで、本文・各言語訳・新音声キーがCSVと一致。
- `vocab.json` は再生成前後で同一ハッシュ。単語データに内容変更なし。
- 例文音声は元資材・スマホ用とも5,000本。新2WAVのSHA-256が準備済み音声・検証用音声・両配置先ですべて一致。
- 新2WAVのヘッダ、サンプル形式、長さを確認。この適用工程では新たな聞き取り検証や統合テストは実施していない。

## 統合確認

- Python 126件・JavaScript 70件のテストは全件成功。
- `python3 tools/validate_mobile_assets.py --strict-warnings` は合格。全15,768 WAVのヘッダ、CSV・JSON・ローカル音声・Drive対応表の整合性を確認した。
- PWA版を `2026-09-06-phrases-1` に更新。教材・音声・配信用データを両ローカルフォルダーへ同期した。
- 新2音声を既存の公開Driveフォルダーに追加し、認証なしでダウンロードしたWAVのSHA-256が生成物と完全一致することを確認した。
- Drive対応表は単語2,884キー・例文5,000キーを維持。例文の変更対象2キー以外は、配信ファイルIDも不変。

| PhraseID | 公開Driveファイル | バイト数 | 生成物との一致 |
|---|---|---:|---|
| 2742 | [2587_mi_bezonas_gxin_preta_gxis_la_kvina.wav](https://drive.google.com/file/d/11OK6KCHifROvYxCP2A6nDz-DYjQ2Ib3s/view) | 145,484 | SHA-256一致 |
| 4615 | [4460_mi_pensas_ke_mi_trostrecxis_muskolon_en_mia_kruro.wav](https://drive.google.com/file/d/1Cax91UWj9MrxTOQNDbc9ZR2ixHepX4ma/view) | 226,364 | SHA-256一致 |

旧版を開いたままの端末にも音声を提供できるよう、旧2音声はDrive上に残している。Driveフォルダーの総数5,002本に対して、現行の対応表は5,000本だけを参照する。対応表再生成時の「参照されない2ファイル」という通知は、この旧版用の保持分であり、現行データの欠落ではない。

公開は専用ブランチからPRの自動検査を経て本番ブランチへ反映する。
