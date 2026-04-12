<div align="center">

# LOCAL AI CHAT

**ローカルLLMチャット**

ローカルLLMを使ったプライベートなAIアシスタント。  
ドキュメントRAG・画像入力・GPU監視・Python実行をブラウザから。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-000000?logo=ollama)](https://ollama.com/)

<!-- スクリーンショット -->
<img src="docs/image.png" alt="LOCAL AI CHAT" width="800" />

</div>

---

## ✨ 特徴

### 🧠 Agentic RAG
LLMが**自ら検索の要否を判断**し、最適なクエリでドキュメントを検索します。  
従来のRAG（常に検索してプロンプト注入）とは異なり、必要なときだけ検索するため、応答品質と速度が向上します。

```
ユーザー: 「認証処理のボトルネックは？」
   ↓
LLM: search_documents("認証 ボトルネック") を呼び出し → 3件ヒット
   ↓
LLM: 検索結果に基づいて回答を生成
```

### 🖼️ 画像入力（Vision）
画像をペースト・アップロードしてビジョンモデル（gemma3, llava 等）に質問できます。

### 📊 リアルタイムGPU監視
AMD（rocm-smi）/ NVIDIA（nvidia-smi）を自動検出し、使用率・温度・電力・VRAM をリアルタイム表示。

### 🐍 Python実行
チャット内のPythonコードをワンクリックで対話的に実行。stdin入力にも対応。

### 💬 その他
- **ストリーミング応答** — リアルタイム表示、途中停止可能
- **Thinking表示** — `<think>`タグ / `message.thinking` の折りたたみ表示
- **Markdown / LaTeX** — コードハイライト、数式レンダリング
- **チャット履歴** — メッセージ＋ドキュメント＋Embeddingをサーバーに保存
- **カスタマイズ** — アプリ名・テーマカラー・推論パラメータを `config.json` で設定
- **レスポンシブUI** — モバイル対応ダークテーマ

---

## 🚀 クイックスタート

### 1. Ollamaの準備

```bash
# インストール
curl -fsSL https://ollama.com/install.sh | sh

# モデルのダウンロード
ollama pull gemma4:31b          # チャット用（例）
ollama pull nomic-embed-text    # Embedding用（RAG必須）
```

### 2. セットアップ

```bash
git clone https://github.com/Wizapply/LocalAIChat.git
cd LocalAIChat
npm install
```

### 3. 起動

```bash
npm start
```

ブラウザで **http://localhost:3000** を開いてください。

> `public/aiicon.jpg` にアイコン画像を配置すると、favicon・ロゴ・AIアバターに反映されます。

---

## 📁 ファイル構成

```
wizapply-ai-chat/
├── server.js          # Express + WebSocket サーバー
├── package.json
├── config.json        # アプリ設定（名前・カラー・推論パラメータ）
├── public/
│   ├── index.html     # フロントエンド（React SPA）
│   └── aiicon.jpg     # アイコン画像（任意）
├── chats/             # チャット履歴（自動作成）
└── settings.json      # ユーザー設定（自動作成）
```

---

## 🧩 アーキテクチャ

```
ブラウザ (React SPA)
  │
  ├── HTTP ─── :3000 Node.js (Express)
  │              ├── /api/*        → Ollama リバースプロキシ
  │              ├── /config       → アプリ設定
  │              ├── /settings     → ユーザー設定
  │              ├── /chats/*      → チャット履歴 CRUD
  │              └── /sse/gpu      → GPU監視 (SSE)
  │
  └── WS ──── /ws/python          → Python対話実行
```

---

## ⚙️ カスタマイズ（config.json）

```json
{
  "appName": "WIZAPPLY AI CHAT",
  "logoMain": "WIZAPPLY",
  "logoSub": "AI CHAT",
  "welcomeMessage": "ドキュメントをアップロードしてRAGベースの質問応答を行うか、自由にチャットを開始できます。",
  "welcomeHints": ["ドキュメントを要約して", "この資料の要点は？", "〇〇について教えて"],
  "accentColor": "#34d399",
  "ragTopK": 10,
  "ragMode": "agentic",
  "topK": 40,
  "topP": 0.9,
  "temperature": 0.9
}
```

| キー | 説明 | デフォルト |
|:--|:--|:--|
| `appName` | ページタイトル・ウェルカム画面 | `WIZAPPLY AI CHAT` |
| `logoMain` | サイドバーロゴ（メイン） | `WIZAPPLY` |
| `logoSub` | サイドバーロゴ（サブ） | `AI CHAT` |
| `welcomeMessage` | ウェルカム画面の説明文 | — |
| `welcomeHints` | ヒントチップ（配列） | — |
| `accentColor` | テーマカラー（HEX） | `#34d399` |
| `ragTopK` | RAG検索の取得チャンク数 | `10` |
| `ragMode` | `agentic`：LLMが判断 / `always`：常に検索 | `agentic` |
| `topK` | Top-K サンプリング | `40` |
| `topP` | Top-P サンプリング | `0.9` |
| `temperature` | Temperature | `0.7` |

> 変更後はサーバーを再起動してください。

---

## 🔧 環境変数

| 変数名 | デフォルト | 説明 |
|:--|:--|:--|
| `PORT` | `3000` | Webサーバーのポート |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama APIのホスト |
| `OLLAMA_PORT` | `11434` | Ollama APIのポート |
| `PYTHON_TIMEOUT` | `60000` | Python実行タイムアウト（ms） |
| `GPU_INTERVAL` | `1000` | GPU監視の更新間隔（ms） |
| `CHATS_DIR` | `./chats` | チャット履歴の保存先 |

```bash
PORT=8080 npm start
```

---

## 📡 API

| メソッド | パス | 説明 |
|:--|:--|:--|
| `*` | `/api/*` | Ollamaリバースプロキシ |
| `GET` | `/config` | アプリ設定の取得 |
| `GET` | `/sse/gpu` | GPU監視（SSE） |
| `GET/POST` | `/settings` | ユーザー設定の取得・保存 |
| `GET` | `/chats` | チャット一覧 |
| `GET/POST/DELETE` | `/chats/:id` | チャットの取得・保存・削除 |
| `WS` | `/ws/python` | Python対話実行 |

---

## 🖥️ デプロイ

### Linux（systemd）

```bash
sudo tee /etc/systemd/system/wizapply.service << EOF
[Unit]
Description=LOCAL AI CHAT
After=network.target ollama.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$(pwd)
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now wizapply
```

別PCからアクセスする場合:
```bash
sudo ufw allow 3000/tcp
```

> Ollama側のCORS設定は不要です（Node.jsプロキシ経由）。

### Windows

1. [Node.js](https://nodejs.org/) をインストール
2. [Ollama for Windows](https://ollama.com/download/windows) をインストール
3. `npm install` → `npm start`

---

## 🎮 GPU監視

起動時に **rocm-smi**（AMD）→ **nvidia-smi**（NVIDIA）の順で自動検出します。

表示項目: 使用率 / 温度 / 電力 / SCLK / MCLK / VRAM

どちらも未検出の場合、GPU監視は無効になりますがアプリ自体は正常動作します。

---

## 🛠️ 技術スタック

| レイヤー | 技術 |
|:--|:--|
| フロントエンド | React (CDN/Babel) · marked.js · highlight.js · KaTeX |
| バックエンド | Node.js · Express · WebSocket (ws) |
| AI | Ollama · nomic-embed-text · Agentic RAG (Tool Calling) |

---

## 📝 ライセンス

[MIT](LICENSE)
※ほとんどAIで生成されています。
