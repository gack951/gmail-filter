# Gmail Filter

家族それぞれが自分のGoogleアカウントでログインし、Gmailフィルタを簡単に作成できるCloudflare Workersアプリです。

- 差出人、宛先、件名、本文、Gmail検索式で絞り込み
- 受信トレイからメールを選び、差出人を自動入力
- 選択したメールに件名・本文の入力語が含まれるか、その場で確認
- 既読、アーカイブ、ゴミ箱、スター、重要、ラベル付与
- 受信トレイにある既存メールにもデフォルトで即時適用
- 作成済みフィルタの一覧表示と削除
- DB不要。フィルタはGmailに保存し、OAuth更新トークンは暗号化したHTTP-only Cookieに保存

## 1. Google Cloudの準備

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクトを作成します。
2. 「APIとサービス」→「ライブラリ」で **Gmail API** を有効にします。
3. 「Google Auth Platform」でアプリ情報を設定します。
4. Audienceを「外部」にし、家族のGoogleアカウントをテストユーザーに追加します。
5. 「クライアント」から **ウェブ アプリケーション** のOAuth 2.0クライアントを作ります。
6. 承認済みリダイレクトURIに次を追加します。

```text
http://localhost:8787/auth/callback
https://<デプロイ先のホスト名>/auth/callback
```

URIは末尾まで完全一致が必要です。Workers標準ドメインなら、デプロイ後に表示される `https://gmail-filter.<subdomain>.workers.dev/auth/callback` を登録してください。

要求するGoogle権限は次の2つです。

- `gmail.modify`: メールの検索とラベル操作
- `gmail.settings.basic`: Gmailフィルタの作成・削除

テスト公開のOAuthアプリでは、Googleの仕様により更新トークンが短期間で期限切れになる場合があります。その場合は再ログインしてください。継続利用する場合はGoogle Auth Platformで公開ステータスを「本番環境」にします（未確認アプリの警告が表示される場合があります）。

## 2. ローカル起動

Node.js 20以降を使用します。

```bash
npm install
cp .dev.vars.example .dev.vars
```

`.dev.vars` にGoogleのクライアントID、クライアントシークレット、32文字以上のランダムな `APP_SECRET` を設定します。`APP_SECRET` は `openssl rand -base64 32` などで生成できます。

```bash
npm run dev
```

[http://localhost:8787](http://localhost:8787) を開きます。

## 3. Cloudflare Workersへデプロイ

Cloudflareへログインし、まずWorkerを作成します。

```bash
npx wrangler login
npm run deploy
```

表示された本番URLの `/auth/callback` を、Google OAuthクライアントの承認済みリダイレクトURIへ追加します。その後、値をコマンドライン引数には書かず、各コマンドの対話プロンプトへ入力します。

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put APP_SECRET
```

必要なら最後に `npm run deploy` をもう一度実行します。独自ドメインを使う場合も、そのドメインの `/auth/callback` をGoogle側へ登録してください。

## 開発時の確認

```bash
npm run check
```

型チェック、ユニットテスト、Wranglerのdry-runをまとめて実行します。`wrangler.jsonc` やバインディングを変更した場合は、`.dev.vars` を用意した状態で次も実行してください。

```bash
npx wrangler types
```

## 挙動と上限

- 複数の検索条件はAND条件です。
- 「本文に含む」はGmail検索のフレーズ検索に変換されます。Gmail自体の検索仕様に従うため、任意位置の文字列検索とは結果が異なる場合があります。
- 既存メールへの適用対象は、作成時点で受信トレイにある一致メールです。
- 受信トレイには直近12件を表示し、本文は選択したメールだけ取得します。
- 件名・本文の一致表示は、作成するGmailフィルタとは別の入力補助です。実際の適用結果はGmailの検索仕様に従います。
- Cloudflare Workers無料プランの外部サブリクエスト上限を超えないよう、既存メールへの1回の適用は10,000件までです。
- Gmail APIの仕様上、1つのフィルタに付けられるユーザー定義ラベルは1つです。
- フィルタを削除しても、すでに既読・アーカイブ・削除・ラベル付与したメールは元に戻りません。
- `APP_SECRET` を変更すると、全員の既存ログインCookieが無効になります。

## 主要ファイル

- `src/index.ts`: OAuth、セッション、Gmail API、APIルーティング
- `src/filter.ts`: 入力からGmailフィルタ・検索式への変換
- `src/message.ts`: 受信メールのヘッダー・本文抽出
- `public/`: ブラウザUI
- `wrangler.jsonc`: Workersと静的アセットの設定
