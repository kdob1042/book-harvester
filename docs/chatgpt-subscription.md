# ChatGPT サブスク連携（個人用プレビュー）

本番は `AI_AUTH_MODE=chatgpt`。このモードは OPENAI_API_KEY を無視し、有料APIへ自動切り替えしない。
文章・画像の読み取り、知見の接続、振り返り、質問回答に OAuth の Responses API を使う。
音声文字起こしと embeddings は呼び出さず、原資料は保存する。検索は語句検索。

## 初回接続（Mac のターミナル）

Node.js 24 以上を入れ、リポジトリの最新 main を取得して実行する。

```sh
git clone https://github.com/kdob1042/book-harvester.git
cd book-harvester
npm ci
npx wrangler login
npm run connect:chatgpt
```

既に取得済みなら clone の代わりに `git pull origin main`。
Cloudflare は所有者のアカウント、ChatGPT はサブスクのあるアカウントで認可する。
ブラウザの ChatGPT 認可画面で Book Harvester のサブスク枠使用を許可する。
公式の dynamic OAuth は `127.0.0.1` のコールバックを必要とするため、所有者のパソコンでこの操作を行う。
モデルは OAuth で取得した `visibility=list` の候補から選ぶ。指定するなら `CHATGPT_MODEL=<slug> npm run connect:chatgpt`。
トークンや API キーをチャットへ貼らない。

CLI は PKCE・state・nonce・ID token の署名/issuer/audience/期限/subject を検証し、Cloudflare Worker の secret へ標準入力で安全に転送する。
ローカルの登録情報は `~/.config/book-harvester/registration.json` に0600で保存。アップロード失敗時のみ同ディレクトリに0600の pending-session.json が残る。`npm run connect:chatgpt -- --retry-upload` で再送し、成功後に削除する。
Worker は AES-GCM 暗号化した認証情報を D1 に保存し、排他リースで refresh token を更新する。このテーブルを記録の書き出し・端末同期へ含めない。

## 確認・解除

アプリの「AIと保存について」でモード・接続状態を確認し、短い文章を保存して読み取りを確認する。
サブスクの利用状況は ChatGPT の設定で確認する。Cloudflare Workers / D1 / R2 の料金は別。
上限時は原資料を保持し翌UTC日以降に再試行。認可失効時は `npm run connect:chatgpt` で再接続。
「ChatGPT 接続を解除」で refresh token を revoke し、旧 secret からの復活を防止する。失敗した場合は解除済みと表示せず、再試行する。

## 未検証の条件

公式プレビューは OSS / 個人セルフホスト向け。公式にはセルフホスト VM への認証情報移行手順があるが、Cloudflare Workers が対象になるかは明記されていない。
この個人用 Worker での認可・実推論は所有者による接続後に検証する。動作・対象条件を保証しない。対象外なら有料 API に切り替えず停止する。

公式資料:
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
