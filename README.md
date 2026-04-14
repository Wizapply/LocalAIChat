# LOCAL AI CHAT
<div align="center">
<h2>ブラウザベースのローカルLLMのWEBチャット</h2>

ローカルLLMを使ったプライベートなAIアシスタント。  
ドキュメントRAG・Web検索・画像入力・Three.jsプレビュー・GPU監視・Python実行をブラウザから。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-000000?logo=ollama)](https://ollama.com/)

<!-- スクリーンショット -->
<img src="docs/image.png" alt="WIZAPPLY AI CHAT" width="800" />

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
画像をペースト・アップロード・ドラッグ＆ドロップでビジョンモデル（gemma3, llava 等）に質問できます。  
複数画像の同時送信、会話履歴内の画像参照にも対応。

### 🎮 Three.js / HTMLプレビュー
AIが生成したThree.jsやHTMLコードをチャット内でワンクリックプレビュー。  
Three.js CDNの自動注入、ESM→UMDの自動変換、LLMが生成する壊れたURLの自動修正に対応。

対応言語指定: ` ```html ` ` ```threejs ` ` ```three.js ` ` ```3d ` ` ```webgl ` ` ```canvas `

### 📊 リアルタイムGPU監視 & 推論速度
AMD（rocm-smi）/ NVIDIA（nvidia-smi）を自動検出し、使用率・温度・電力・VRAM をリアルタイム表示。  
直近のトークン生成速度（tok/s）の平均値も表示。

### 📈 コンテキスト使用量表示
各メッセージの下に入力・出力トークン数とコンテキスト使用率バーを表示。  
コンテキスト溢れの危険を色で警告（緑→オレンジ→赤）。

### 🐍 Python実行
チャット内のPythonコードをワンクリックで対話的に実行。stdin入力にも対応。

### 💬 その他
- **ストリーミング応答** — リアルタイム表示、途中停止可能
- **Thinking表示** — `<think>`タグ / `message.thinking` の折りたたみ表示
- **Markdown / LaTeX** — コードハイライト（GitHub Dark）、KaTeX数式レンダリング
- **チャット履歴** — メッセージ＋ドキュメント＋Embeddingをサーバーに保存・復元
- **カスタマイズ** — アプリ名・テーマカラー・デフォルトモデル・推論パラメータを `config.json` で設定
- **レスポンシブUI** — モバイル対応ダークテーマ

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

確認:
```bash
node -v   # v18以上
npm -v
```

### 3. セットアップ

```bash
git clone https://github.com/<your-username>/wizapply-ai-chat.git
cd wizapply-ai-chat
npm install
```

### 4. 起動

```bash
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
  "ragTopK": 30,
  "password": "",
  "webSearch": true,
  "ollamaBackends": [],
  "ragMode": "agentic",
  "tokenAvgWindow": 3000,
  "topK": 40,
  "topP": 0.9,
  "temperature": 0.9
}
```

| キー | 説明 | デフォルト |
|:--|:--|:--|
| `appName` | ページタイトル・ウェルカム画面 | `WIZAPPLY AI CHAT` |
| `logoMain` / `logoSub` | サイドバーロゴ | `WIZAPPLY` / `AI CHAT` |
| `welcomeMessage` | ウェルカム画面の説明文 | — |
| `welcomeHints` | ヒントチップ（配列） | — |
| `accentColor` | テーマカラー（HEX） | `#34d399` |
| `defaultModel` | 初期選択モデル（空→一覧の先頭） | `""` |
| `password` | MD5ハッシュ（空→制限なし）| `""` |
| `webSearch` | Web検索（DuckDuckGo）の有効/無効 | `true` |
| `ollamaBackends` | 複数バックエンド（後述） | `[]` |
| `ragTopK` | RAG検索の取得チャンク数 | `10` |
| `ragMode` | `agentic`：LLMが判断 / `always`：常に検索 | `agentic` |
| `tokenAvgWindow` | 推論速度の平均計算対象トークン数 | `2000` |
| `topK` | Top-K サンプリング | `40` |
| `topP` | Top-P サンプリング | `0.9` |
| `temperature` | Temperature | `0.7` |

> 変更後はサーバーを再起動してください。

---

## 🔒 パスワード設定

パスワードはMD5ハッシュで `config.json` に保存します。

```bash
# ハッシュ生成（対話モード）
python3 hashpass.py

# ハッシュ生成（引数指定）
python3 hashpass.py mypassword
```

出力例:
```
  パスワード: mypassword
  MD5ハッシュ: 34819d7beeabb9260a5c854bc85b3e44

  config.json に以下を設定してください:
  "password": "34819d7beeabb9260a5c854bc85b3e44"
```

パスワードを空 `""` にすると制限なし（ログイン画面なし）。

---

## ⚡ マルチGPU構成

### Ollamaインスタンスの起動（GPUごと）

```bash
# GPU 0 (ポート 11434)
CUDA_VISIBLE_DEVICES=0 OLLAMA_HOST=0.0.0.0:11434 ollama serve
# GPU 1 (ポート 11435)
CUDA_VISIBLE_DEVICES=1 OLLAMA_HOST=0.0.0.0:11435 ollama serve
```

AMD（ROCm）の場合は `ROCR_VISIBLE_DEVICES` を使用。

### config.json

```json
"ollamaBackends": [
  { "host": "127.0.0.1", "port": 11434, "gpuIndex": 0 },
  { "host": "127.0.0.1", "port": 11435, "gpuIndex": 1 }
]
```

| キー | 説明 |
|:--|:--|
| `host` | Ollamaホスト |
| `port` | Ollamaポート |
| `gpuIndex` | GPU監視データのインデックス（負荷ベース振り分けに使用） |

振り分けロジック: `スコア = GPU使用率 + アクティブ接続数 × 30` → 最小スコアのバックエンドを選択。

未設定時は環境変数 `OLLAMA_HOST:OLLAMA_PORT` の1台構成で動作。

### systemd自動起動（GPU別）

```bash
# /etc/systemd/system/ollama-gpu0.service
[Unit]
Description=Ollama (GPU 0)
After=network.target
[Service]
Type=simple
User=<your-username>
Environment=CUDA_VISIBLE_DEVICES=0
Environment=OLLAMA_HOST=0.0.0.0:11434
Environment=OLLAMA_MODELS=/usr/share/ollama/.ollama/models
ExecStart=/usr/local/bin/ollama serve
Restart=always
[Install]
WantedBy=multi-user.target
```

GPU 1用は `CUDA_VISIBLE_DEVICES=1` / `OLLAMA_HOST=0.0.0.0:11435` に変更。

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

---

## 📡 API

| メソッド | パス | 説明 |
|:--|:--|:--|
| `*` | `/api/*` | Ollamaリバースプロキシ（負荷分散対応） |
| `GET` | `/web-search?q=...` | DuckDuckGo Web検索 |
| `GET` | `/config` | アプリ設定（パスワード除外） |
| `POST` | `/auth` | パスワード認証 |
| `GET` | `/sse/gpu` | GPU監視（SSE） |
| `GET/POST` | `/settings` | ユーザー設定 |
| `GET/POST/DELETE` | `/chats/:id` | チャット履歴 |
| `WS` | `/ws/python` | Python対話実行 |

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

### Windows

1. [Node.js](https://nodejs.org/) をインストール
2. [Ollama for Windows](https://ollama.com/download/windows) をインストール
3. `npm install` → `npm start`

---

## 🛠️ 技術スタック

| レイヤー | 技術 |
|:--|:--|
| フロントエンド | React (CDN/Babel) · marked.js · highlight.js · KaTeX · Three.js (r128) |
| バックエンド | Node.js · Express · WebSocket (ws) |
| AI | Ollama · nomic-embed-text · Agentic RAG (Tool Calling) |
| Web検索 | DuckDuckGo HTML Lite |

---

## 📝 ライセンス

[MIT](LICENSE)  
※一部はAIによって作成されました。
