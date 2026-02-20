# Reservation Form

## 構成
- frontend: GitHub Pages（静的）
- gas: Apps Script Webアプリ（API）

## セットアップ
### 1) Apps Script
1. Apps Script プロジェクト作成
2. `gas/Code.gs` を貼り付け
3. デプロイ → 新しいデプロイ → 種類「ウェブアプリ」
   - 実行ユーザー：自分
   - アクセス：全員
4. 発行されたURL（/exec）をコピー

### 2) フロント
1. `frontend/app.js` の `API_URL` にApps Script URLを貼る
2. GitHub に push
3. GitHub Pages を有効化（/frontend を公開する or rootに配置する）

## 注意
- Apps Script 側は CORS を許可しています
- 送信は fetch + JSON で行います