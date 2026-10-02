# Book Harvester

気になったページを撮る・短く話す。原資料はすぐ保存し、AIが知見・概念・問いを整理する。本人が採用した文章だけを「自分の見方」にする個人用Webアプリ。

Issue #1の仕様検証用の最初の実装。NEXUSや既存の投資DBから独立している。常設の主操作は「記録する」一つ、低頻度操作は一つのメニュー。書名・ページ・タグの入力や解析開始・全件承認は要求しない。

## 動かす

Node.js 24以上を使用する。

```bash
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars に16文字以上のランダムなAPP_PASSWORDを設定する。
# OPENAI_API_KEYを設定すると実際の有料APIで解析する。
npm run migrate
npm run dev
```

http://localhost:8787 を開き、設定したパスワードでログインする。`.dev.vars`、`.wrangler`の保存データはGit対象外。スマホからの録音はHTTPSまたはブラウザが認める安全な接続が必要。写真はJPEG/PNG/WebP、音声はWAV/MP3/M4A/WebM/OGG/FLAC、各10MBまで。一つの記録に最大4ファイル、合計20MBまで。HEIC・PDF・EPUB・バッチ取り込みは後続の#4。

AIキーがなくても原資料は保存できる。解析成功には見せず「保存済み・AI設定待ち」と表示する。キーを追加して再起動すると、保存済みジョブを再開する。ローカルで待機ジョブを再送するときは `wrangler dev --test-scheduled` を起動し、ローカル環境の `/__scheduled` を呼び出す。本番は毎分のCronが担当する。

## インフラ

| 用途 | Cloudflare構成 |
|---|---|
| 日本語レスポンシブUI | Workers Static Assets。外部のフロントエンドサービスを追加しない |
| API・認証 | Workers。個人用パスワード＋失効可能なサーバー側セッション |
| 記録・出典・知見・問い・見方・履歴 | D1 |
| 原写真・原音声 | 非公開R2。認証済みWorker経由でのみ取得 |
| 非同期解析 | Queues。メッセージはジョブIDのみ |
| キュー登録失敗・期限切れジョブの復旧 | D1のoutbox＋毎分Cron |
| 画像理解・知識化 | OpenAI Responses API＋Structured Outputs |
| 音声の文字起こし | OpenAI Audio API。その後、同じ知識化経路へ |

標準の開発環境と`production`は、D1・R2・Queueを完全に分離している。Queueへの送信は保存応答後に試みるが、ジョブは保存と同じD1バッチで登録済み。応答後の処理が止まってもCronから再送される。R2とD1は一つのトランザクションにできないため、先行アップロード・削除予定もD1に記録し、未参照の原資料を後から回収する。

モデルは`OPENAI_MODEL`、`OPENAI_TRANSCRIBE_MODEL`で交換可能。画像入力・Structured Outputsに対応する組み合わせを指定する。利用量はAPI呼び出し単位で記録し、日次呼び出し上限と出力トークン上限を設ける。既定はUTC日次60呼び出し、1回4000出力トークン。音声は通常2回。金額上限とは異なる。外部APIのタイムアウト・429・5xxは最大3試行、拒否・不正出力は失敗として詳細から再試行できる。

## 本番へ反映する

現在の設定には実際のアカウントID・D1 ID・公開先URL・秘密を含めていない。Cloudflareにログインした環境で準備する。

```bash
npx wrangler login
npx wrangler d1 create book-harvester
npx wrangler r2 bucket create book-harvester-originals
npx wrangler queues create book-harvester-harvest
```

`wrangler.jsonc`の`env.production.d1_databases[0].database_id`を作成したIDへ置き換え、`env.production.vars.APP_ORIGIN`を実際のHTTPS公開URL（末尾スラッシュなし）へ変更する。

```bash
npx wrangler secret put APP_PASSWORD --env production
npx wrangler secret put OPENAI_API_KEY --env production
npm run deploy
```

`npm run deploy`は未設定のD1 IDや`.invalid`のURLで止まる。正しく設定されていれば本番マイグレーションの後、Workersをデプロイする。カスタムドメインやCloudflare Accessはアカウント側で必要に応じて追加できる。WorkersのAPI・原ファイル・エクスポートはアプリ自身の認証で保護しているため、Access追加前も非公開データを返さない。R2の公開URLは有効化しない。

開発用クラウド環境を使う場合も、対応するdev D1 ID・HTTPSの`APP_ORIGIN`・devのR2/Queue・秘密を別に設定する。ローカルDBを本番にコピーしない。

## 検証

```bash
npm run check
npm test
npm run build
```

画面・操作の自動確認は `npx playwright install chromium` の後、`npm run test:browser`。合成資料とモックAIを使い、実APIへ送らない。画面例は`test-results/`へ出力する。

`build`はCloudflare向けのdry runであり公開しない。PRとmain/devへのpushはGitHub Actionsで型・統合テスト・dry runを実行する。認証情報が未設定のため、自動デプロイはまだ設定していない。

テストは実際のWorkerコードを呼び、D1互換のSQLiteアダプターとR2/Queueアダプター、合成したAI応答を使用する。実際のD1・R2・QueuesはWranglerのローカルランタイムでも確認する。[確認結果と未確認項目](docs/verification.md)を参照。OpenAIへの課金される実呼び出しやスマホ実機確認の代わりにはならない。

## データと変更

- 原写真・原音声・貼った原文、AIの構造化結果、本人の見方は別層。
- AI結果はCapture版に紐づく`harvest/v1`。主張・概念・問いの局所ID、条件、整理主体、根拠位置を保持する。#2はこの契約を使って横断グラフを育てる。
- 資料の主張・本人の発言・AI推論を区別する。疑問や引用を本人の賛同にしない。読めないところは留保を表示する。
- 読書位置は最後に記録した出典位置。読了位置とは扱わない。書名不明でも記録し、直前の本からの引き継ぎは画面で明示する。
- 訂正時はCapture版を増やす。古い版の編集・AI応答は現在の版を上書きしない。変更前の原文・解析・訂正も保持する。
- 見方の採用・編集だけを本人の判断として保存する。採用時の根拠と解析結果をスナップショット化し、復元も新しい版にする。
- 送信が二重になっても同じリクエストキーで一件にする。音声の補足先は、開いている記録に限定する。

エクスポートはメニューの「すべて書き出す」。元ファイル（base64）、出典、解析、局所関係、Capture版、見方の履歴をJSONで持ち出せる。ファイルを一つずつ読み出すため、大量の原写真を同時にメモリへ展開しない。エクスポート中は編集・削除を避ける。サービスをまたぐ完全な時点スナップショットやインポートは未実装。

バックアップはD1のリモートエクスポートとR2のコピーをセットで取得するか、アプリの原ファイル付きエクスポートを使う。

```bash
npx wrangler d1 export DB --remote --env production --output backup.sql
```

バックアップは非公開の場所に保管する。明示的な記録削除で、関連する原資料・解析・採用した見方・履歴を削除する。R2障害時も削除予定を保持し、Cronで回収する。独立したバックアップやD1のTime Travel保持分は別管理のため、過去のコピーからの消去には保持期間と運用対応が必要。

## 次の実装順

1. 実際のOpenAIキーで、写真・音声の読解精度と費用・応答時間を確認する。スマホ実機で撮影・録音・読書へ戻る負担を確認する。
2. #1残件：実機での操作確認、バックアップからの復元を実演する。
3. #2：Capture単位の概念を既存概念と照合し、根拠付きの型付き関係・書籍横断の比較・見方の修正案を自動生成する。

オフライン・ネイティブ・巨大なグラフUIは初期検証の必須に含めない。

## 実装に使用した一次資料

- [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Queues retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)
