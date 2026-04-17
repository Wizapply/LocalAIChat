# WEB LOCAL AI CHAT

<div align="center">
<h2>ブラウザベースのローカルLLMのWEBチャット</h2>

ウェブベースのローカルLLMを使ったプライベートなAIアシスタント。  
ドキュメントRAG・Web検索・画像入力・Three.jsプレビュー・GPU監視・Python実行・マルチGPU負荷分散をブラウザから。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-000000?logo=ollama)](https://ollama.com/)

<!-- スクリーンショット -->
<img src="docs/image.png" alt="WIZAPPLY AI CHAT" width="800" />

</div>

---

## ✨ 特徴

### 🧠 Agentic RAG + Web検索
LLMが**自ら検索の要否を判断**し、ドキュメント検索とWeb検索を自律的に使い分けます。

```
ユーザー: 「認証処理のボトルネックは？」
  → LLM: 🔍 search_documents("認証 ボトルネック") → 3件ヒット → 回答生成

ユーザー: 「今日のニュースを教えて」
  → LLM: 🌐 web_search("今日のニュース") → 5件ヒット → 回答生成
```

### 🖼️ 画像入力（Vision）
ペースト・アップロード・ドラッグ＆ドロップで画像を送信。gemma3, llava 等のビジョンモデルに対応。

### 🎮 Three.js / HTMLプレビュー
AIが生成したThree.jsやHTMLコードをチャット内でワンクリックプレビュー。CDN自動注入・ESM→UMD変換・壊れたURL自動修正に対応。

### ⚡ マルチGPU・複数PCロードバランシング
複数のPCに分散したOllamaインスタンスを**GPU負荷ベース**で自動振り分け。各PCに軽量GPU監視エージェント（`gpu-agent.js`）を配置すれば、全PCのGPU状態を一括監視。

### 📊 リアルタイムGPU監視 & 推論速度
AMD/NVIDIA自動検出。複数PCをグループ表示。トークン生成速度（tok/s）平均値も表示。

### 🔒 セキュリティ
- セッションCookieベースの認証（HttpOnly + SameSite=Strict）
- パスワードのMD5/SHA-256ハッシュ照合 + タイミング攻撃対策
- ログイン試行レートリミット（15分5回）
- パストラバーサル対策
- gpu-agentトークン認証

### 📈 コンテキスト使用量
各メッセージの下に入力・出力トークン数と使用率バーを表示。

### 🐍 Python実行 / 💬 その他
対話的Python実行、Thinking表示、Markdown/LaTeX、チャット履歴保存（メッセージ+ドキュメント+Embedding）、レスポンシブUI。

---

## 🚀 クイックスタート

### 1. Ollamaの準備

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3:12b          # チャット用（例）
ollama pull nomic-embed-text    # Embedding用（RAG必須）
```

### 2. Node.jsのインストール（未導入の場合）

**Ubuntu / Debian:**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
```

**macOS（Homebrew）:**
```bash
brew install node
```

**Windows:**  
[Node.js公式サイト](https://nodejs.org/) からLTS版をダウンロード。

### 3. セットアップ・起動

```bash
git clone https://github.com/<your-username>/wizapply-ai-chat.git
cd wizapply-ai-chat
npm install
npm start
```

ブラウザで **http://localhost:3000** を開いてください。

> `public/aiicon.jpg` にアイコン画像を配置すると、favicon・ロゴ・AIアバターに反映されます。

---

## 📁 ファイル構成

```
LocalAIChat/
├── server.js          # Express + WebSocket サーバー
├── package.json
├── config.json        # アプリ設定
├── hashpass.py        # パスワードハッシュ生成ツール
├── gpu-agent.js       # リモートPC用GPU監視エージェント
├── DESIGN.md          # AI向け設計ドキュメント
├── public/
│   ├── index.html     # フロントエンド（React SPA）
│   └── aiicon.jpg     # アイコン画像（任意）
├── chats/             # チャット履歴（自動作成）
└── settings.json      # ユーザー設定（自動作成）
```

---

## ⚙️ カスタマイズ（config.json）

```json
{
  "appName": "WIZAPPLY AI CHAT",
  "logoMain": "WIZAPPLY",
  "logoSub": "AI CHAT",
  "welcomeMessage": "...",
  "welcomeHints": ["...", "..."],
  "accentColor": "#34d399",
  "defaultModel": "",
  "password": "",
  "gpuAgentToken": "",
  "ollamaBackends": [],
  "webSearch": true,
  "ragTopK": 10,
  "ragMode": "agentic",
  "tokenAvgWindow": 2000,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

| キー | 説明 | デフォルト |
|:--|:--|:--|
| `appName` | ページタイトル・ウェルカム画面 | `WIZAPPLY AI CHAT` |
| `logoMain` / `logoSub` | サイドバーロゴ | `WIZAPPLY` / `AI CHAT` |
| `welcomeMessage` | ウェルカム説明文 | — |
| `welcomeHints` | ヒントチップ（配列） | — |
| `accentColor` | テーマカラー（HEX） | `#34d399` |
| `defaultModel` | 初期選択モデル（空→一覧の先頭） | `""` |
| `password` | MD5/SHA-256ハッシュ（空→認証なし）| `""` |
| `gpuAgentToken` | GPUエージェント共有トークン | `""` |
| `ollamaBackends` | バックエンド配列（マルチPC構成） | `[]` |
| `webSearch` | DuckDuckGo検索の有効/無効 | `true` |
| `ragTopK` | RAG検索の取得チャンク数 | `10` |
| `ragMode` | `agentic` / `always` | `agentic` |
| `tokenAvgWindow` | 推論速度の平均計算対象トークン数 | `2000` |
| `topK` / `topP` / `temperature` | LLM推論パラメータ | `40` / `0.9` / `0.7` |

> 変更後はサーバーを再起動してください。

---

## 🔒 パスワード設定

```bash
# ハッシュ生成
python3 hashpass.py mypassword
```

出力されたハッシュを `config.json` の `password` に設定:
```json
"password": "34819d7beeabb9260a5c854bc85b3e44"
```

サーバー再起動でログイン画面が表示されます。空 `""` で認証なし。

**セキュリティ機能:**
- セッションCookie（HttpOnly + SameSite=Strict、24時間TTL）
- ログイン試行レートリミット（15分間に5回失敗で429）
- MD5/SHA-256両対応（ハッシュ長で自動判別）
- タイミング攻撃対策（`crypto.timingSafeEqual`）

---

## ⚡ マルチGPU・複数PC構成

### ステップ1: 各PCでOllama起動

```bash
# 全リモートPCで実行
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

### ステップ2: 各PCでGPUエージェント起動

```bash
# トークン付きで起動
GPU_AGENT_TOKEN=mysecret123 node gpu-agent.js
```

systemd自動起動例:
```bash
sudo tee /etc/systemd/system/gpu-agent.service << 'EOF'
[Unit]
Description=GPU Agent
After=network.target
[Service]
Type=simple
User=ubuntu
Environment=GPU_AGENT_TOKEN=mysecret123
ExecStart=/usr/bin/node /path/to/gpu-agent.js
Restart=always
[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now gpu-agent
```

### ステップ3: フロントサーバーのconfig.json

```json
{
  "gpuAgentToken": "mysecret123",
  "ollamaBackends": [
    { "host": "192.168.10.0", "port": 11434, "label": "PC-0" },
    { "host": "192.168.10.1", "port": 11434, "label": "PC-1" },
    { "host": "192.168.10.2", "port": 11434, "label": "PC-2" }
  ]
}
```

| キー | 説明 |
|:--|:--|
| `host` | Ollamaホスト |
| `port` | Ollamaポート（デフォルト 11434） |
| `gpuAgentPort` | GPUエージェントポート（デフォルト 11400） |
| `gpuAgentToken` | バックエンド個別のトークン（省略時は共通の `gpuAgentToken` 使用） |
| `label` | GPUモニターの表示名 |

### 振り分けロジック

```
スコア = GPU平均使用率(0-100) + アクティブ接続数 × 30
→ 最小スコアのバックエンドを選択
```

### 1台で複数GPU（GPU別Ollamaインスタンス）

```bash
CUDA_VISIBLE_DEVICES=0 OLLAMA_HOST=0.0.0.0:11434 ollama serve
CUDA_VISIBLE_DEVICES=1 OLLAMA_HOST=0.0.0.0:11435 ollama serve
```

config.json:
```json
"ollamaBackends": [
  { "host": "127.0.0.1", "port": 11434, "label": "GPU0" },
  { "host": "127.0.0.1", "port": 11435, "label": "GPU1" }
]
```

AMD（ROCm）の場合は `ROCR_VISIBLE_DEVICES` を使用。

### ファイアウォール

各リモートPCで:
```bash
sudo ufw allow 11434/tcp   # Ollama
sudo ufw allow 11400/tcp   # GPU Agent
```

---

## 🔧 環境変数

| 変数名 | デフォルト | 説明 |
|:--|:--|:--|
| `PORT` | `3000` | Webサーバーのポート |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama APIのホスト（単一構成時） |
| `OLLAMA_PORT` | `11434` | Ollama APIのポート |
| `PYTHON_TIMEOUT` | `60000` | Python実行タイムアウト（ms） |
| `GPU_INTERVAL` | `1000` | GPU監視の更新間隔（ms） |
| `CHATS_DIR` | `./chats` | チャット履歴の保存先 |

---

## 📡 API

| メソッド | パス | 認証 | 説明 |
|:--|:--|:--:|:--|
| `*` | `/api/*` | ✓ | Ollamaリバースプロキシ（負荷分散） |
| `GET` | `/web-search?q=` | ✓ | DuckDuckGo Web検索 |
| `GET` | `/config` | — | アプリ設定（パスワード除外） |
| `POST` | `/auth` | — | パスワード認証 |
| `GET` | `/sse/gpu` | ✓ | GPU監視 SSE |
| `GET/POST` | `/settings` | ✓ | ユーザー設定 |
| `GET/POST/DELETE` | `/chats/:id` | ✓ | チャット履歴 |
| `WS` | `/ws/python` | ✓ | Python対話実行 |

---

## 🖥️ デプロイ

### Linux（systemd）

```bash
sudo tee /etc/systemd/system/wizapply.service << EOF
[Unit]
Description=WIZAPPLY AI CHAT
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

### Windows

1. [Node.js](https://nodejs.org/) をインストール
2. [Ollama for Windows](https://ollama.com/download/windows) をインストール
3. `npm install` → `npm start`

---

## 🛠️ 技術スタック

| レイヤー | 技術 |
|:--|:--|
| フロントエンド | React (CDN/Babel) · marked.js · highlight.js · KaTeX · Three.js (r128) |
| バックエンド | Node.js · Express · WebSocket (ws) · 標準モジュールのみ（gpu-agent依存ゼロ） |
| AI | Ollama · nomic-embed-text · Agentic RAG (Tool Calling) |
| Web検索 | DuckDuckGo HTML Lite |
| 認証 | セッションCookie · MD5/SHA-256 + timingSafeEqual |

---

## 📝 ライセンス

[MIT](LICENSE)  
※これらは一部AIによって作成されました。
