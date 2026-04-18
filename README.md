# OpenGeekLLMChat

<div align="center">
ギークのためのブラウザベース・ローカルLLMチャットアプリ。クラスタやGPU監視などが可能。
Ollama と React 1ファイル、Node.js サーバー1ファイル。ビルド不要、依存は最小。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Ollama](https://img.shields.io/badge/Ollama-Local%20LLM-000000?logo=ollama)](https://ollama.com/)
[![Self-Hosted](https://img.shields.io/badge/Self--Hosted-100%25-blueviolet)](#)
[![No Cloud](https://img.shields.io/badge/No%20Cloud-ever-red)](#)
</div>

---

## 🎯 何ができるのか

OpenGeekLLMChatは、**クラウドに依存しないローカルLLM環境を自宅サーバーや社内LANで動かすため** に設計されたチャットアプリです。ギークが自由に弄り倒せるよう、**依存を最小限に絞り、すべてがファイル1枚で完結する構成** になっています。

- サーバー: `server.js` 1ファイル（依存は `express` と `ws` のみ）
- クライアント: `public/index.html` 1ファイル（React/Babel CDN、ビルドツール不要）
- GPU監視エージェント: `gpu-agent.js` 1ファイル（依存ゼロ）

データは全て手元に残ります。**クラウドAPIへの送信は一切ありません。**

---

## ✨ 主な機能

### 🤖 Agentic RAG
LLMが自ら検索要否を判断し、必要なときだけドキュメントRAGとWeb検索を呼び出します。タグなし・プロンプト手動挿入なし。Ollamaのネイティブ `tools` 機能（Tool Calling）を使います。

### 🌐 DuckDuckGo Web検索
APIキー不要。LLMが「今日のニュース」「最新バージョン」等の質問に自動で検索・引用。

### 📁 サーバーファイル読み書き
LLMが直接サーバーのファイルシステムに `.py` / `.xml` / `.json` 等を保存可能。Agenticツールとして `read_file`, `write_file`, `list_files` を実装。

### ⚡ マルチGPU・複数PC負荷分散
複数のOllamaインスタンス（別GPU / 別PC）を **GPU使用率 + アクティブ接続数** で自動振り分け。軽量GPU監視エージェント（`gpu-agent.js`）を各PCに配置すれば、統合GPUモニターが全PC分のGPU状態を1画面で表示。

### 🖼️ Vision対応
gemma3 / llava 等のビジョンモデルに画像を直接送信。ペースト・D&D・アップロードに対応。

### 🎮 Three.js / HTMLプレビュー
LLMが生成したThree.jsコードをチャット内でワンクリック実行。CDN自動注入・ESM→UMD変換・壊れたCDN URL自動修正。

### 🐍 Python対話実行
コードブロックの「▶ 実行」で対話的実行。`input()` 入力も可能。

### 📊 リアルタイムメトリクス
トークン生成速度（tok/s）、コンテキスト使用率（%バー）、GPU使用率/温度/電力/VRAM を右サイドバーにリアルタイム表示。

### 🔒 セキュリティ
- セッションCookie認証（HttpOnly + SameSite=Strict、24h TTL）
- MD5/SHA-256ハッシュ（`crypto.timingSafeEqual` 使用）
- ログイン試行レートリミット（15分5回）
- パストラバーサル対策
- 全認証必須エンドポイント

### 🛠️ その他
- Markdown / LaTeX（KaTeX）/ コードハイライト（highlight.js）
- Thinking表示（DeepSeek R1等の `<think>` タグ対応）
- チャット履歴保存（メッセージ+ドキュメント+Embedding）
- レスポンシブ・ダークテーマ
- 全設定を `config.json` でカスタマイズ可能

---

## 🚀 クイックスタート

### 1. Ollama

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma3:12b           # お好みのチャットモデル
ollama pull nomic-embed-text     # RAG用Embedding（必須）
```

### 2. Node.js（未インストールの場合）

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node

# Windows: https://nodejs.org/ からLTS版をDL
```

### 3. 起動

```bash
git clone https://github.com/<your-username>/opengeek-llm-chat.git
cd opengeek-llm-chat
npm install
npm start
```

ブラウザで **http://localhost:3000**

---

## 📁 リポジトリ構成

```
opengeek-llm-chat/
├── server.js          # Express + WebSocket（~930行、依存最小）
├── gpu-agent.js       # リモートGPU監視エージェント（~140行、依存ゼロ）
├── hashpass.py        # パスワードハッシュ生成ツール
├── config.json        # 全設定
├── package.json       # express + ws のみ
├── public/
│   ├── index.html     # React SPA（~3900行、単一ファイル）
│   ├── aiicon.jpg     # アイコン（任意）
│   └── uploads/       # LLMが読み書きするディレクトリ
├── chats/             # チャット履歴JSON（自動生成）
├── settings.json      # ユーザー設定（自動生成）
├── DESIGN.md          # 設計ドキュメント（コード修正用）
├── README.md          # これ
└── LICENSE            # MIT
```

---

## ⚙️ config.json

全ての挙動は `config.json` で制御できます。

```json
{
  "appName": "OpenGeekLLMChat",
  "logoMain": "OpenGeek",
  "logoSub": "LLM Chat",
  "accentColor": "#34d399",
  "defaultModel": "",
  "password": "",
  "gpuAgentToken": "",
  "ollamaBackends": [],
  "webSearch": true,
  "fileAccess": true,
  "ragTopK": 10,
  "ragMode": "agentic",
  "agentContext": {
    "smallCtx": 2048,
    "mediumCtx": 8192,
    "smallPredict": 512,
    "largePredict": 8192,
    "smallThreshold": 2000,
    "mediumThreshold": 8000,
    "largeGenKeywords": null
  },
  "tokenAvgWindow": 2000,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

| キー | 説明 |
|:--|:--|
| `appName` / `logoMain` / `logoSub` | 表示名・ロゴ |
| `accentColor` | テーマカラー（HEX） |
| `defaultModel` | 初期モデル（空→一覧先頭を自動選択） |
| `password` | MD5/SHA-256ハッシュ（空→認証なし） |
| `gpuAgentToken` | gpu-agent共有トークン |
| `ollamaBackends` | 複数バックエンド配列（後述） |
| `webSearch` | DuckDuckGo検索 ON/OFF |
| `fileAccess` | サーバーファイル読み書き ON/OFF |
| `ragTopK` | RAG検索チャンク数 |
| `ragMode` | `agentic` / `always` |
| `agentContext.*` | ツール判断時の動的ctx/predict調整 |
| `topK`/`topP`/`temperature` | LLM推論パラメータ |

---

## 🔒 パスワード認証

```bash
# MD5ハッシュ生成
python3 hashpass.py mysecret
# → "098f6bcd..."
```

```json
"password": "098f6bcd4621d373cade4e832627b4f6"
```

サーバー再起動でログイン画面が表示されます。空文字で認証解除。

---

## ⚡ マルチGPU・複数PC構成

10台のPCでロードバランスする例。

### 各PCで Ollama + gpu-agent 起動

```bash
# Ollama (全PC)
OLLAMA_HOST=0.0.0.0:11434 ollama serve

# gpu-agent (全PC)
GPU_AGENT_TOKEN=mysecret123 node gpu-agent.js
```

### フロントサーバーのconfig.json

```json
{
  "gpuAgentToken": "mysecret123",
  "ollamaBackends": [
    { "host": "192.168.10.0", "port": 11434, "label": "node-0" },
    { "host": "192.168.10.1", "port": 11434, "label": "node-1" },
    { "host": "192.168.10.2", "port": 11434, "label": "node-2" }
  ]
}
```

### 振り分けアルゴリズム

```
score = avg(GPU_usage) + active_connections × 30
→ 最小スコアのバックエンドを選択
```

- GPUが複数枚あるPCも自動認識
- リモートPCダウン時はキャッシュを保持し、UIはちらつかない
- 右サイドバーのGPUタブに全PC分のGPUが並んで表示

### 1台で複数GPU

```bash
CUDA_VISIBLE_DEVICES=0 OLLAMA_HOST=0.0.0.0:11434 ollama serve
CUDA_VISIBLE_DEVICES=1 OLLAMA_HOST=0.0.0.0:11435 ollama serve
```

`ROCR_VISIBLE_DEVICES` はROCm（AMD）用。

---

## 🧠 Agentic RAG の仕組み

```
ユーザー: "今日のニュース教えて"
  ↓
LLM: 🌐 web_search("2026年4月14日 主要ニュース") → 5件取得
  ↓
LLM: 検索結果を元に回答生成（ストリーミング）

ユーザー: "このdata.jsonを要約して"
  ↓
LLM: 📁 read_file("data.json") → 内容取得
  ↓
LLM: 要約してストリーミング応答

ユーザー: "cube_sim.py に物理シミュレーションコードを保存"
  ↓
LLM: ✍️ write_file("cube_sim.py", "...長いコード...") → 保存完了
  ↓
LLM: 保存しましたと応答 + コード解説
```

LLMが自分で判断してツールを呼びます。プロンプトに「検索してから回答しろ」と書く必要はありません。

---

## 🧪 環境変数

| 変数名 | デフォルト | 説明 |
|:--|:--|:--|
| `PORT` | `3000` | HTTPサーバーポート |
| `OLLAMA_HOST` | `127.0.0.1` | Ollama API（単一構成時） |
| `OLLAMA_PORT` | `11434` | 同上 |
| `PYTHON_TIMEOUT` | `60000` | Python実行タイムアウト(ms) |
| `GPU_INTERVAL` | `1000` | GPU監視間隔(ms) |
| `CHATS_DIR` | `./chats` | チャット履歴保存先 |

---

## 📡 API

| Method | Path | Auth | 説明 |
|:--|:--|:--:|:--|
| `*` | `/api/*` | ✓ | Ollamaリバースプロキシ（負荷分散） |
| `GET` | `/web-search?q=` | ✓ | DuckDuckGo検索 |
| `GET/POST` | `/files/*` | ✓ | サーバーファイル読み書き |
| `DELETE` | `/files/*` | ✓ | ファイル削除 |
| `GET` | `/files` | ✓ | ファイル一覧 |
| `GET` | `/config` | — | 公開設定 |
| `POST` | `/auth` | — | ログイン（Cookie発行） |
| `GET` | `/sse/gpu` | ✓ | GPU監視 SSE |
| `GET/POST` | `/settings` | ✓ | ユーザー設定 |
| `GET/POST/DELETE` | `/chats/:id` | ✓ | チャット履歴 |
| `WS` | `/ws/python` | ✓ | Python対話実行 |

---

## 🖥️ デプロイ（systemd）

### OpenGeekLLMChat 本体

```ini
# /etc/systemd/system/opengeek-llm-chat.service
[Unit]
Description=OpenGeekLLMChat
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/opengeek-llm-chat
ExecStart=/usr/bin/node server.js
Restart=always
Environment=PORT=3000

[Install]
WantedBy=multi-user.target
```

### GPU Agent（各ノード）

```ini
# /etc/systemd/system/gpu-agent.service
[Unit]
Description=GPU Agent
After=network.target

[Service]
Type=simple
User=your-user
ExecStart=/usr/bin/node /path/to/gpu-agent.js
Restart=always
Environment=GPU_AGENT_TOKEN=mysecret123

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-llm-chat gpu-agent
```

---

## 🛠️ 技術スタック

| Layer | Tech |
|:--|:--|
| Frontend | React 18 (CDN/Babel) · marked · highlight.js · KaTeX · Three.js r128 |
| Backend | Node.js · Express · ws（依存2つのみ） |
| AI | Ollama · nomic-embed-text · Tool Calling |
| Search | DuckDuckGo HTML Lite |
| Auth | セッションCookie · MD5/SHA-256 + timingSafeEqual |
| GPU監視 | rocm-smi / nvidia-smi |

---

## 🤝 Contributing

PR大歓迎。ギーク的な改造ほど歓迎します。

---

## 📝 ライセンス

[MIT](LICENSE)   
※一部はAIによって生成されています。
