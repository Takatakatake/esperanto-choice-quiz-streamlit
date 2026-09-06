# Streamlit Cloudへのデプロイ

PC・スマートフォンともに `mobile_app/` の共通画面を使います。6つの起動ファイルは `unified_app.py` と `mobile_streamlit_bridge.py` を共有し、`?classic=1` を付けても旧PC版へは戻りません。単語・例文の指定は `?quiz=vocab` / `?quiz=sentence` を使います。

## 1. Google Sheetsのスキーマ

既存のスプレッドシートと `Scores` を引き続き使用します。移行のための得点のコピーや、既存ログの削除は不要です。

| タブ | 役割・必須列 |
|---|---|
| `Scores` | 保存済み学習記録の正本。`user`・`points` を維持し、既存の日時・モード・分野・`save_id` などの列も残す |
| `UserStats` | 全体の累積点。`user`, `total_points`, `last_updated` |
| `UserStatsSentence` | 例文の累積点。`user`, `total_points`, `last_updated` |
| `UserSettings` | 公開設定。`user`, `ranking_public`, `updated_at` |

今回の更新では、本番の既存スプレッドシートに `UserSettings` を追加済みです。作成時は上記3列のヘッダだけで、テストユーザーの行はありません。デプロイ前にタブ名とヘッダが一致することを確認してください。別のスプレッドシートへ新規導入する場合も、このスキーマで作成します。

`ranking_public` は `true` / `false`、`updated_at` は更新日時です。設定行がない名前は公開を初期値とします。設定シートがない、読めない、ヘッダや公開値が不正な場合は、非公開ユーザーを誤って掲載しないようランキング全体を表示しません。進捗の読み取りと得点保存は公開設定から独立しています。

公開設定は `UserStats` に入れません。同じ名前の設定行が重複した場合、読み取り時は非公開を優先し、次の明示的な設定保存で一致する行を更新します。

## 2. Secretsと権限

Google Sheetsには `gspread` で直接接続します。`requirements.txt` の依存関係は `streamlit`・`pandas`・`gspread` です。従来の `st-gsheets-connection` は使用しません。

対象スプレッドシートをサービスアカウントのメールアドレスに「編集者」として共有し、Streamlit Cloudの **Settings → Secrets** に設定します。キー名は既存の `[connections.gsheets]` を維持します。

```toml
[connections.gsheets]
type = "service_account"
project_id = "YOUR_PROJECT_ID"
client_email = "YOUR_SERVICE_ACCOUNT_EMAIL"
private_key = """-----BEGIN PRIVATE KEY-----
YOUR_PRIVATE_KEY
-----END PRIVATE KEY-----
"""
spreadsheet = "https://docs.google.com/spreadsheets/d/YOUR_SPREADSHEET_ID/edit"
token_uri = "https://oauth2.googleapis.com/token"
```

ローカルで実シートへ接続する場合は `.streamlit/secrets.toml` を使います。秘密鍵や認証JSONをリポジトリ・チャット・Issue・PRに含めないでください。設定後はアプリを再起動します。

音声は通常、同梱の `mobile_app/audio/` / `mobile_app/sentence-audio/` を使用します。外部の `<base_url>/<audioKey>.wav` へ変更する場合だけ、次を追加します。

```toml
[mobile_audio]
vocab_base_url = "https://example.com/audio/"
sentence_base_url = "https://example.com/sentence-audio/"
drive_download_base_url = "https://drive.google.com/uc?export=download&id="
```

## 3. 保存と公開の運用

名前付きクイズは完了時に自動保存します。永続outboxのv2形式は保存IDごとの端末保存キーを使い、確認応答後は結果本体を小さな保存済み記録（receipt）に置き換えて、別タブによる再登録を抑えます。旧v1配列は全件を移行・確認するまで保持します。端末保存に失敗した場合は完了結果を維持し、次のクイズによる上書きを止めます。

通信切断や再読み込み後も同じ `save_id` で再送し、`Scores` に追記済みなら重複加算せず、必要な累積更新を再実行します。未送信記録の名前は、画面で別の名前へ切り替えても変わりません。

パスワードはありません。同じ名前を入力した人は、その名前の進捗閲覧・記録追加・公開設定変更ができます。「非公開」はランキング一覧への掲載を停止する設定で、記録自体の閲覧制限ではありません。

個人の進捗は `Scores` の全履歴から全体・単語・例文と分野別得点を集計します。古い行のモードは既存の推定規則、品詞は `pos` または `group_id` の接頭辞を使い、不明な分野は未分類として計上します。

集計シートの値を通常の得点保存で引き下げる処理は行いません。過去ログの欠落や集計シートの手修正があると、個人進捗と累積ランキングが異なる場合があります。その場合は `Scores` と集計表を照合し、元データを保全して別途修復します。2026-09-06の読み取り監査では、既存13名の両集計に不一致はありませんでした。

Google Sheetsは複数プロセス間の条件付き更新を提供しないため、同時書込みの完全な直列化は保証しません。保存IDでログ集計の重複を除外し、設定書込み後の曖昧な応答では旧変更の再送を止めます。既に開いている別タブのランキングには、更新操作まで以前の表示が残る場合があります。

旧PC版の端末保存は検出後に引継ぎを選択した場合だけ変換し、旧保存原文を保持します。既存モバイル保存を優先します。保存状態が不明な旧完了結果は閲覧専用で、再送しません。

## 4. デプロイ前後の確認

CSVを変更した場合はJSON生成とアプリバージョン更新を行います。以下のバージョン文字列は例です。

```bash
npm run build:mobile -- 2026-09-06-unified-learning
```

JavaScript・CSSなど画面だけの変更では、JSONを再生成せず次を実行します。

```bash
npm run version:mobile -- 2026-09-06-unified-learning
```

どちらのコマンドも `APP_VERSION`、CSSのURLに付ける版番号、PWAの `CACHE_VERSION` と事前保存するCSSのURLをまとめて更新します。画面変更には新しい版番号を指定し、以下の検証後、本番を通常の再読み込みで開いて更新を確認します。

```bash
npm run test:unit
npm run test:client
npm run validate:mobile-assets
```

Driveの音声対応表も変更した場合は `build:mobile` に `--with-drive-manifest` を追加します。WAVヘッダ確認を省く補助チェックは `npm run validate:mobile-assets:quick` です。

得点追加や公開設定変更のブラウザ検証は、[tests/README.md](tests/README.md) のメモリ内シートfixtureで実施します。`STUDY_APP_URL` はそのローカルfixtureのURLです。fixtureを本番へデプロイせず、本番へテストユーザーを追加しない運用にします。

本番への反映後は、次を確認します。

1. PC・スマートフォンで共通画面が開き、日本語・中国語・韓国語の入口と単語・例文の指定が機能する。
2. 再読み込みでクイズを復元でき、旧 `?classic=1` のURLでも共通画面が開く。
3. 既存ユーザーの進捗と公開設定を読み取れ、設定取得に失敗した場合はランキングにエラーを表示する。
4. 既存の記録を使った分野別集計と各ランキングが表示され、エスペラントの問題・選択肢・復習音声を再生できる。

## 5. 集計シートの再構築と障害対応

`Scores` が正本です。累積シートだけが古くなった場合は、まずdry-runで差分を確認します。

```bash
python3 tools/rebuild_user_stats.py
```

対象と差分を確認して書き込む場合は `--apply` を付けます。ツールはバックアップを作成してから更新します。`UserSettings` は集計の再構築対象に含めません。

```bash
python3 tools/rebuild_user_stats.py --apply
```

- 認証・書き込み失敗: Secretsの鍵の改行と、対象シートの編集権限を確認する。
- ランキングだけ表示されない: `UserSettings` のタブ名、3列のヘッダ、各行のユーザー名と公開値を確認する。欠損を初期公開とみなして迂回しない。
- 進捗が取得できない: `Scores` の読み取り権限と `user` / `points` ヘッダを確認する。取得失敗を0点で上書きしない。
- 結果が未送信: 端末データを消さず、通信回復後に結果・学習記録画面から再試行する。端末保存に失敗した完了結果は上書きせず保存領域を確認する。ログ保存済みで累積更新だけ失敗した場合も同じ保存IDを使う。
- 表示が古い: 学習記録画面で更新する。画面の読み取りキャッシュは最大約2分で、名前の切替や保存成功時には無効化する。サーバー側で別名ユーザーの応答を流用しない。
