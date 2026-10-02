# Book Harvester

気になったページを撮る・短く話す。原資料はすぐ保存し、AIが知見・概念・問いを整理する。本人が採用した文章だけを「自分の見方」にする個人用Webアプリ。

Issue #1〜#7のWeb実装。#8のネイティブアプリは対象外。NEXUSや既存の投資DBから独立している。常設の主操作は「記録する」一つ、低頻度操作は一つのメニュー。書名・ページ・タグの入力や解析開始・全件承認は要求しない。

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

http://localhost:8787 を開き、設定したパスワードでログインする。`.dev.vars`、`.wrangler`の保存データはGit対象外。スマホからの録音はHTTPSまたはブラウザが認める安全な接続が必要。写真はJPEG/PNG/WebP、音声はWAV/MP3/M4A/WebM/OGG/FLAC、各10MBまで。一つの記録に最大4ファイル、合計20MBまで。複数写真は1回12枚・合計20MBまで。PDF・EPUB・対応ハイライトは各10MBまで、保存後に本文範囲を選べる。HEICは未対応。

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

モデルは`OPENAI_MODEL`、`OPENAI_TRANSCRIBE_MODEL`、`OPENAI_RESEARCH_MODEL`で交換可能。画像入力・Structured Outputsに対応する組み合わせを指定する。利用量はAPI呼び出し単位で記録し、日次呼び出し上限と出力トークン上限を設ける。既定はUTC日次60呼び出し、1回4000出力トークン。写真・文章は通常3回（読み取り＋横断整理＋意味索引）、音声は通常4回（文字起こしを含む）。振り返り・検索・外部調査は追加。金額上限とは異なる。外部APIのタイムアウト・429・5xxは最大3試行、拒否・不正出力は失敗として詳細から再試行できる。

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
- AI結果はCapture版に紐づく`harvest/v1`。主張・概念・問いの局所ID、条件、整理主体、根拠位置を保持する。#2はこの契約から正規化ノード・方向と型を持つ関係・条件付きメカニズムを自動で育てる。
- 資料の主張・本人の発言・AI推論を区別する。疑問や引用を本人の賛同にしない。読めないところは留保を表示する。
- 読書位置は最後に記録した出典位置。読了位置とは扱わない。書名不明でも記録し、直前の本からの引き継ぎは画面で明示する。
- 訂正時はCapture版を増やす。古い版の編集・AI応答は現在の版を上書きしない。変更前の原文・解析・訂正も保持する。
- 見方の採用・編集だけを本人の判断として保存する。採用時の根拠と解析結果をスナップショット化し、復元も新しい版にする。
- 送信が二重になっても同じリクエストキーで一件にする。音声の補足先は、開いている記録に限定する。

エクスポートはメニューの「すべて書き出す」。元ファイル（base64）、出典、解析、正規化ノード・関係・概念・生成入力と処理版、Capture版、見方の履歴をJSONで持ち出せる。ファイルを一つずつ読み出すため、大量の原写真を同時にメモリへ展開しない。エクスポート中は編集・削除を避ける。サービスをまたぐ完全な時点スナップショットやインポートは未実装。

バックアップはD1のリモートエクスポートとR2のコピーをセットで取得するか、アプリの原ファイル付きエクスポートを使う。

```bash
npx wrangler d1 export DB --remote --env production --output backup.sql
```

バックアップは非公開の場所に保管する。明示的な記録削除で、関連する原資料とAI派生物を削除する。本人が採用した見方と履歴は保持し、根拠資料の訂正・削除を表示する。採用時の短い引用スナップショットも履歴に残る。R2障害時も削除予定を保持し、Cronで回収する。独立したバックアップやD1のTime Travel保持分は別管理のため、過去のコピーからの消去には保持期間と運用対応が必要。

## 自動知見グラフと見方の修正案

Harvestの成功と同じD1バッチで横断整理ジョブを登録する。通常画面に概念登録・線引き・生成開始・全件承認を増やさない。横断整理が失敗してもHarvestと原資料を読める。

- Claim・Concept・QuestionはCapture版に基づく安定ID。Claimの話者・対象・範囲・時期と整理主体AIを別に保持する。
- 同名だけで概念をまとめない。名前＋意味が完全一致する重複は同じID、意味による再利用はAIの判断理由、曖昧な同義候補は別IDと候補の対応を保存する。
- Relationは型・方向・理由・条件・両側の引用を保存。AIの類推と今回の資料の説明を区別する。引用があることは主張の正しさの外部検証ではない。
- Mechanismは2本以上の方向がつながる因果/機能関係の連鎖。構成主張・関係・条件・時間差を保持する。資料に連鎖の根拠がなければ0件でよい。
- 過去候補は直近8件に意味索引の候補と概念/問いのSQL一致を追加し、合計12記録・120ノード、現行View最大6件。意味索引は現行版の最新1,000記録を対象にする。直近候補は語が一致しなくても比較する。モデルへの入力は180,000文字以内、関係8件・メカニズム2件・表示発見3件以内。外部調査はしない。
- 見方の修正案は一意に一致する部分だけを置換し、無関係な段落を維持する。採用時にのみViewRevisionを追加。資料版・見方の版が変わった場合は自動で比較し直す。古い案で本人の編集を上書きしない。
- 本文訂正で古いノードを現行から外す。依存先が変わった横断接続は直ちに除外し、Cronで影響範囲を再比較する。非表示にした接続は端点・方向・型・解釈・条件・引用の指紋で保存し、同じ接続の言い換えを再表示しない。根拠の版や条件が変われば表示対象に戻る。修正案の非表示は文面で保存する。
- 再構成時は検証済み新世代をD1の同じバッチで有効化する。失敗時は現行世代を維持。履歴の生成入力・出力・モデル・処理版を保持し、採用時の根拠を追える。

管理用の最小経路は `POST /api/graph/rebuild`。ログイン済みセッションCookie、通常の`Origin`ヘッダー、JSON `{ "capture_ids": ["記録UUID"] }` を送る。1回1〜20件、現行Harvestがある記録だけを対象にし、202で受け付ける。AIグラフだけを再構成し、本文の再抽出や本人Viewの自動改稿は行わない。削除済みCaptureは復活しない。詳細の高度な整理から任意で再構成できる。

[横断グラフの確認結果と画面](docs/graph-verification.md)。まだ実APIでの意味判断の精度や、大量データでの候補検索の評価は済んでいない。

## 追加したWeb機能

| Issue | 操作と保存内容 |
|---|---|
| #3 | 同じ本の45分以内の記録を自動で区切り、静かになってから持ち帰りを整理。日本時間の日・週、採用履歴、過去の問いとの再会。通知は任意・既定オフ・開いている間のみ |
| #4 | Open Libraryの書誌候補、写真バッチ、PDF/EPUB原ファイルと選択範囲、Kindle My Clippingsと専用ハイライトJSON。成功分を保持して失敗分だけ再試行 |
| #5 | 問い・見方の詳細から外部調査。送信する問い・期間を確認し、最大3本文を取得。引用付きの支持・反証・条件・不明を整理し、取得資料を通常の知見化へ接続 |
| #6 | 既存検索に意味の候補を統合。本・公開年・発言由来の絞り込み。局所グラフと同等の一覧、原資料への参照。概念の統合・分割はAI案の明示採用と取り消し履歴 |
| #7 | PWA、最近の記録・見方の自動キャッシュ、写真/音声/文章のIndexedDB原資料保存、再開・再接続時の自動同期。編集競合を両方保持し、削除・再送・認証変更を区別 |

入力口は「記録する」一つ、低頻度操作は既存メニューと詳細の折りたたみへ統合している。原資料・資料の主張・本人メモ・AI案・採用した見方を分ける。詳細と制限は[追加機能の検証記録](docs/web-expansions-verification.md)と[同期API](docs/sync-api.md)に記載。

未確認は実APIの意味判断・読解精度・費用・遅延、本番Cloudflare、スマホ実機、バックアップ復元。Issueは検証が終わるまで閉じない。ネイティブ#8は未実装。

## 実装に使用した一次資料

- [OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI Speech to text](https://developers.openai.com/api/docs/guides/speech-to-text)
- [Cloudflare Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare D1 Database API](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- [Cloudflare Queues retries](https://developers.cloudflare.com/queues/configuration/batching-retries/)

- [OpenAI Web search](https://developers.openai.com/api/docs/guides/tools-web-search)
- [OpenAI Embeddings](https://developers.openai.com/api/docs/guides/embeddings)
- [Cloudflare R2 PDF/unpdf tutorial](https://developers.cloudflare.com/r2/tutorials/summarize-pdf/)
- [Open Library Search API](https://openlibrary.org/dev/docs/api/search)
- [MDN IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB)

## テーマごとに理解を育てる（#14〜#19）

ホームは6領域の継続的な問いを入口にする。記録後、AIが既存テーマに根拠付きで接続し、
同じテーマの説明・条件・反例・未解決の問いを更新する。新しい記録で過去同士の関係も再検討する。
分類・生成開始・全件承認は不要。本人の見方は明示採用時だけ変わる。
既存Harvestは0009の移行ジョブから自動接続する。原画像・音声の再読解は行わない。
処理状況・停止/再開・上限・検証範囲は [テーマ機能の検証記録](docs/theme-verification.md) を参照。

## Book-only remote MCP (Issue #20)

Endpoint: `https://book-harvester-mcp.mashstock.workers.dev/mcp`.
Connect as an OAuth remote MCP in ChatGPT. The authorization page uses Cloudflare Access, permits only the configured owner, displays the requesting client and callback hostname, and uses browser-bound, single-use consent. No API key or AI provider credential is given to ChatGPT. Protocol discovery and 401 challenges are outside the Access HTML login gate; `/authorize` alone has the Access owner policy.

The MCP Worker lives in this repository and calls the named private `BookService` entrypoint of the existing Web Worker. It reuses Web validation, versions, records and ingestion/research jobs. `book:read`, `book:write`, and `book:manage` are enforced per tool. Record save explicitly clears inherited source for independent notes; searches use all-history SQL and bounded cursor pages, without AI. Delete requires an expiring owner/record/version-bound preview confirmation. Source deletion preserves adopted user views and immutable revision snapshots; their evidence status becomes deleted.

Implemented: record save/search/read/correction, saved graph read, user-view adoption/read/edit, ingestion and research status/retry, explicit external research/cancel, delete preview/delete, domains/themes/context/history/scope correction, migration status/pause/resume/retry. Theme operations use the #15–#19 implementation, not a parallel database. Web and MCP authorization are separate from AI authentication and usage mode.

Additional implementation: theme-owned conversation drafts with context fingerprint/evidence snapshots (no AI on save), explicit record discovery and theme integration, revision restoration, concept proposal/apply/undo, theme membership overrides/adoption/merge, document-import selection, OpenAI file-input descriptors and restricted 10MB download transfer, bounded entity exports, and persistent write receipts. Signed file URLs are not persisted; refreshed URLs replay the same operation by stable file ID. Interrupted operations remain blocked and can be inspected with `get_operation`, rather than risking duplicate side effects.

Production `AI_EXECUTION_POLICY=explicit` permits ingestion and explicitly requested discovery/integration/research only. Saving or revising records/views/themes does not automatically start graph, membership, synthesis, embedding, bibliography or reflection processing. Existing queued automatic jobs cannot run without a version-bound explicit grant. Migration resume/retry authorizes at most 20 records per request. Legacy development/test mode remains available without this production flag.

Theme changes now have a preview/apply/undo lifecycle for edits, aliases, merge, split, candidate creation and archive. Apply/undo compare all affected metadata and memberships inside one DB batch; newer edits or memberships refuse an undo. Original records and user view revisions remain intact. Changes do not start AI. Large change previews are bounded at 300 affected rows and split selection at 20 records.

Search covers all-history records, claims, concepts, questions, views and themes with period/source/origin/theme/state/unorganized filters and cursor pages. Visibility is reversible and independent of deletion. Overview, versioned evidence and history pages are saved-data reads. Web offers “関連を探す” and “理解を更新する”; progress refreshes without starting new AI. Graph/theme jobs expose retry and cancel, and conversation view proposals require a separate adoption.

Implementation is covered by synthetic integration and browser checks. Authenticated ChatGPT connection and actual ChatGPT file transfer are delegated to the user's local AI; they are not claimed as verified. Live AI meaning/quality, audio subscription limitations and external research host configuration remain explicit runtime/acceptance limits. Original export uses the authenticated Web download; MCP entity pages do not expand all original files into one response.

Validation: TypeScript, 77 Node tests (including MCP shared storage/source/idempotency/theme tests), Web/MCP dry-run builds; production discovery returns OAuth metadata, `/mcp` returns 401 with resource metadata, and `/authorize` redirects to owner-restricted Cloudflare Access. Real user OAuth consent and ChatGPT tools/call remain unverified until the connection is authorized.

Build/deploy: `npm run build`; `npx wrangler deploy --config wrangler.mcp.jsonc`. Deploy Web first (named `BookService` export), then MCP. Production deploy must retain the current Web assets and all existing bindings/secrets, including the ChatGPT session. Each environment requires its own OAuth KV, canonical resource URL, Access audience, and Book service binding; the checked-in MCP configuration is production only.
