# WIZAPPLY AI CHAT

Ollama連携のRAG（検索拡張生成）チャットWebアプリケーション。  
ローカルLLMを使ったプライベートなAIアシスタントをブラウザから利用できます。

![screenshot](docs/screenshot.png)

## 特徴

- **Ollamaプロキシ** — 同一オリジンでOllama APIにアクセス（CORS設定不要）
- **RAG** — ドキュメントをアップロードしてチャンク分割→Embedding→コサイン類似度検索
- **ストリーミング応答** — リアルタイムでトークン生成を表示、途中停止可能
- **Thinking表示** — `<think>` タグや `message.thinking` の折りたたみ表示
- **Markdown / LaTeX** — marked.js + highlight.js + KaTeX で数式・コードを美しく表示
- **Python実行** — WebSocket経由で対話的にPythonコードを実行（stdin入力対応）
- **GPU監視** — rocm-smi / nvidia-smi を自動検出し、リアルタイムでGPUステータスを表示
- **チャット履歴** — サーバーにJSONで保存・一覧・読み込み・削除
- **グローバル設定** — モデル・Top-K・コンテキストサイズをサーバーに保存（全チャット共通）
- **レスポンシブUI** — モバイル対応、ダークテーマ

## 必要なもの

- [Node.js](https://nodejs.org/) v18以上
- [Ollama](https://ollama.com/)
- Python 3（Python実行機能を使用する場合）

## クイックスタート

### 1. Ollamaのインストールとモデルの準備

```bash
# Ollamaインストール
curl -fsSL https://ollama.com/install.sh | sh

# チャット用モデル（例）
ollama pull gemma3:12b

# Embedding用モデル（RAG用・必須）
ollama pull nomic-embed-text
```

### 2. アプリのセットアップ

```bash
git clone https://github.com/<your-username>/wizapply-ai-chat.git
cd wizapply-ai-chat
npm install
```

### 3. アイコン画像の配置

`public/aiicon.jpg` にアイコン画像を配置してください（favicon・ロゴ・AIアバターに使用されます）。

### 4. 起動

```bash
npm start
```

ブラウザで **http://localhost:3000** にアクセスしてください。

## ファイル構成

```
wizapply-ai-chat/
├── server.js          # Express + WebSocket サーバー
├── package.json
├── config.json        # アプリ名・テーマカラー等のカスタマイズ
├── public/
│   ├── index.html     # フロントエンド（React/Babel SPA）
│   └── aiicon.jpg     # アイコン画像（要配置）
├── chats/             # チャット履歴の保存先（自動作成）
└── settings.json      # モデル等のユーザー設定（自動作成）
```

## カスタマイズ（config.json）

`config.json` を編集してアプリ名やテーマカラーを変更できます。

```json
{
  "appName": "WIZAPPLY AI CHAT",
  "logoMain": "WIZAPPLY",
  "logoSub": "AI CHAT",
  "welcomeMessage": "ドキュメントをアップロードしてRAGベースの質問応答を行うか、自由にチャットを開始できます。",
  "welcomeHints": ["ドキュメントを要約して", "この資料の要点は？", "〇〇について教えて"],
  "accentColor": "#34d399"
}
```

| キー | 説明 |
|---|---|
| `appName` | ページタイトル・ウェルカム画面の表示名 |
| `logoMain` | サイドバーロゴのメインテキスト |
| `logoSub` | サイドバーロゴのサブテキスト |
| `welcomeMessage` | ウェルカム画面の説明文 |
| `welcomeHints` | ウェルカム画面のヒントチップ（配列） |
| `accentColor` | テーマのアクセントカラー（HEX） |

変更後はサーバーを再起動してください。

## 環境変数

| 変数名 | デフォルト | 説明 |
|---|---|---|
| `PORT` | `3000` | Webサーバーのポート番号 |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama APIのホスト |
| `OLLAMA_PORT` | `11434` | Ollama APIのポート |
| `PYTHON_TIMEOUT` | `60000` | Python実行のタイムアウト（ms） |
| `GPU_INTERVAL` | `1000` | GPU監視の更新間隔（ms） |
| `CHATS_DIR` | `./chats` | チャット履歴の保存ディレクトリ |

```bash
# 例: ポートを変更して起動
PORT=8080 npm start
```

## API エンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `*` | `/api/*` | Ollamaへのリバースプロキシ |
| `GET` | `/sse/gpu` | GPU監視（Server-Sent Events） |
| `GET` | `/settings` | グローバル設定の取得 |
| `POST` | `/settings` | グローバル設定の保存 |
| `GET` | `/chats` | チャット一覧の取得 |
| `GET` | `/chats/:id` | チャットの取得 |
| `POST` | `/chats/:id` | チャットの保存 |
| `DELETE` | `/chats/:id` | チャットの削除 |
| `WS` | `/ws/python` | Python対話実行（WebSocket） |

## デプロイ

### systemdサービス化（Ubuntu / Linux）

```bash
sudo nano /etc/systemd/system/wizapply.service
```

```ini
[Unit]
Description=WIZAPPLY AI CHAT
After=network.target ollama.service

[Service]
Type=simple
User=<your-username>
WorkingDirectory=/home/<your-username>/wizapply-ai-chat
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now wizapply
```

### 別PCからのアクセス

```bash
sudo ufw allow 3000/tcp
```

Ollama側の設定変更は不要です（Node.jsプロキシ経由のためCORS問題なし）。

### Windows

1. [Node.js](https://nodejs.org/) をインストール
2. [Ollama for Windows](https://ollama.com/download/windows) をインストール
3. `npm install` → `npm start`

> Python実行機能を使う場合、`python3` コマンドが見つからないときは `python` に読み替えてください。

## GPU監視

起動時に `rocm-smi`（AMD）と `nvidia-smi`（NVIDIA）を自動検出します。  
どちらも見つからない場合、GPU監視機能は無効になりますがアプリ自体は正常に動作します。

## 技術スタック

**フロントエンド**: React (CDN/Babel) · marked.js · highlight.js · KaTeX  
**バックエンド**: Node.js · Express · WebSocket (ws)  
**AI**: Ollama · nomic-embed-text (Embedding)

## ライセンス

[MIT](LICENSE)

※すべてAIで作成されました。
