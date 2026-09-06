# テスト

リポジトリ直下から実行します。Pythonの集計・保存処理、ブラウザ側の送信待ち管理・旧版移行、実画面の動作を分けて確認します。

## PythonとJavaScriptの単体テスト

```bash
npm run test:unit
# 同じPythonテストを直接実行する場合
python3 -m unittest discover -s tests -p 'test_*.py'

npm run test:client
```

`tests/` はPythonパッケージではないため、`python3 -m unittest tests.<module>` ではなく `discover` を使います。

| 対象 | 主なテスト |
|---|---|
| 得点・4択・品詞 | `test_quiz_scoring_values.py`, `test_quiz_logic_parity.py`, `test_classify_pos.py`, `test_vocab_question_options.py`, `quiz-questions.test.mjs` |
| 例文と多言語データ | `test_sentence_question_options.py`, `test_sentence_locale_column.py`, `test_phrase_offset_consistency.py` |
| 共通の6入口・URL・応答処理 | `test_app_imports.py`, `test_quiz_navigation.py`, `test_entry_routing.py`, `test_unified_bridge.py` |
| 保存・集計・列整列 | `test_score_sync_service.py`, `test_compute_score_totals.py`, `test_score_row_alignment.py`, `test_infer_mode.py` |
| 個人進捗・公開設定・ランキング | `test_user_progress.py`, `test_user_settings.py`, `test_mobile_score_ranking.py` |
| outbox・複数タブ・応答順序・名前切替 | `learning-sync.test.mjs` |
| 旧PC版からの明示的な引継ぎ | `legacy-session-migration.test.mjs`, `test_classic_session_persistence.py` |
| メモリ内シートを使う実バックエンド | `test_learning_fixture.py` |

公開設定のテストでは、非公開ユーザーが全ランキングと自身の追加行から除外されること、設定取得失敗時に一覧を出さないこと、設定の読取失敗で既存行を上書きしないこと、書込み後の応答途切れで古い公開要求を再送しないことを確認します。進捗は全履歴・旧形式・重複除去を確認し、名前変更前の応答を混ぜないようにします。

outboxは保存IDごとの保持、確認応答後のreceiptによる再登録抑止、旧v1配列の全件移行、端末保存失敗時の完了結果保護を確認します。receipt保存失敗後の再読み込み、保存済みセッションだけ／履歴だけの復元、保存証拠が全て書き込めなかった場合の同じIDでの再送、遅延した失敗応答も確認します。

旧版移行のテストは、検出のみでは書き換えず明示選択を必要とすること、原文保持、既存モバイル保存の優先、保存状態が不明な旧完了結果の閲覧専用扱いを確認します。

## データと音声の整合性

```bash
npm run validate:mobile-assets
# WAVヘッダ確認を省く高速チェック
npm run validate:mobile-assets:quick
```

CSV・生成JSON・音声キー・同梱音声・Driveフォールバックmanifestの対応を確認します。

## ブラウザ検証の準備

```bash
npm ci
npx playwright install chromium
```

静的PWAの検証は、別ターミナルでHTTPサーバーを起動して実行します。

```bash
python3 -m http.server 8765
```

```bash
npm run test:mobile
```

`mobile-pwa.spec.js` は再読み込み復元、結果・履歴、保存データ復旧などを確認します。

## 学習記録を保存するローカルfixture

```bash
streamlit run tests/fixtures/learning_app.py --server.address 127.0.0.1 --server.port 8502
```

このfixtureは実際の `unified_app.py`・Streamlit橋渡し・進捗集計・公開設定保存・得点保存を使い、シート接続だけをメモリ内の仮実装に置き換えます。実シート・認証情報・Drive音声manifestは使用しません。fixtureを本番へデプロイしないでください。

| 名前 | 初期公開設定 | 全体 | 単語 | 例文 |
|---|---|---:|---:|---:|
| `Review-A` | 公開 | 200 | 150 | 50 |
| `Review-B` | 非公開 | 1,200,000 | 1,000,000 | 200,000 |

`Review-A` の内訳は名詞120点、旧形式の動詞30点、例文の `travel` / `train` が50点です。`Review-B` は名前を入力すれば進捗を閲覧できますが、ランキングには出ません。仮シートは同じサーバープロセスのタブと再読み込みの間で共有され、サーバーを再起動すると初期化されます。

`?lang=ja` / `?lang=zh` / `?lang=ko` と `?quiz=sentence` を指定できます。`?preview_width=390` は実際のクイズiframeの表示幅を指定するfixture専用オプションです（320〜1600px）。外側のブラウザウィンドウをリサイズできない場合も、スマートフォン幅の折り返しや操作配置を目視確認できます。

別ターミナルから、通常表示の確認先と得点保存の確認先を同じfixtureに向けて実行します。

```bash
STREAMLIT_APP_URL=http://127.0.0.1:8502/ STUDY_APP_URL=http://127.0.0.1:8502/ npm run test:streamlit-mobile
```

`STREAMLIT_APP_URL` は通常の共通画面確認先（既定8501番）、`STUDY_APP_URL` は仮シートへの保存・進捗確認先（既定8502番）です。ブラウザ回帰テストはlocalhostのサーバーだけを許可し、得点を追加する前にfixture専用の非表示マーカーを確認します。

`streamlit-mobile.spec.js` はPCからの初期表示、旧 `classic=1` URL、名前付きクイズの完了時自動保存、outboxの消込、個人進捗、非公開設定の保持、全ランキングからの除外、多言語、音声を確認します。ブラウザの通信切断を使う手動確認でも、このfixtureで未送信結果を作り、再接続後の送信と重複がないことを確認します。


## CI

`.github/workflows/mobile-quality.yml` はPRごとに、Python・JavaScript・公開対象アセットの検査と、Chromiumのブラウザー回帰テストを実行します。ブラウザー用のHTTPサーバーとStreamlit fixtureはCI内で起動し、認証情報は使用しません。失敗時はトレースとサーバーログを7日間保存します。

ブラウザーでは保存確認用receiptの書込みだけを失敗させ、実クイズの自動保存後、再読み込みで得点を再送せず保存済み表示を維持することも確認します。別名の記録を閲覧してから元のクイズを再挑戦した際、元の名前・得点・公開設定に戻ることも検査します。


## 長い学習記録のスクロール

Streamlitの埋め込みiframeは `scrolling="no"` で動くため、固定高の画面ではアプリ内の要素スクロールが必要です。`Review-Long` は多数のテーマ・小テーマを持つ専用の非公開仮ユーザーです。既存の `Review-A` / `Review-B` の得点は変えません。

ブラウザー回帰では本番と同様にiframeを入れ子にし、PC幅とスマートフォン幅の両方で、ホイール操作により最終テーマ、公開設定、ランキング、末尾の言語リンクまで到達できることを確認します。要素を直接スクロールさせるスクリプトや、自動スクロール付きのclickに頼って到達を判定しません。画面切替とテーマ展開も確認します。
