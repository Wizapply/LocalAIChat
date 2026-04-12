# WIZAPPLY AI CHAT — 設計ドキュメント

> このドキュメントはAIアシスタントがプロジェクトを理解し、修正・拡張を行うためのリファレンスです。

---

## 1. プロジェクト概要

Ollama連携のAgentic RAGチャットWebアプリ。ローカルLLMを使い、ドキュメントRAG・画像入力・GPU監視・Python実行をブラウザから利用できる。

- **単一HTMLアプリ**: フロントエンドは `public/index.html` 1ファイル（React/Babel CDN、ビルド不要）
- **サーバー**: `server.js` 1ファイル（Express + WebSocket）
- **設定**: `config.json`（アプリ設定）+ `settings.json`（ユーザー設定、自動生成）

---

## 2. ファイル構成

```
wizapply-ai-chat/
├── server.js              # バックエンド（Express + WS）  ~460行
├── package.json            # express, ws のみ
├── config.json             # アプリ設定（名前・カラー・推論パラメータ）
├── public/
│   ├── index.html          # フロントエンド全体（CSS + React/Babel）  ~2800行
│   └── aiicon.jpg          # アイコン画像（favicon・ロゴ・AIアバター）
├── chats/                  # チャット履歴JSON（自動作成、.gitignore済）
├── settings.json           # ユーザー設定（自動作成、.gitignore済）
├── README.md
├── LICENSE                 # MIT
└── .gitignore
```

---

## 3. アーキテクチャ

```
┌───────────────────────────────────────────────────────────────┐
│  ブラウザ (public/index.html)                                  │
│  React 18 (CDN/Babel) — 単一SPAコンポーネント                    │
│                                                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────────┐  │
│  │ サイドバー │ │ チャット  │ │ GPU監視   │ │ 入力エリア        │  │
│  │ 設定      │ │ メッセージ│ │ パネル    │ │ テキスト+画像     │  │
│  │ チャット履歴│ │ Thinking │ │ (SSE)    │ │ ペースト/D&D     │  │
│  │ ドキュメント│ │ RAG参照  │ │          │ │                  │  │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────────┘  │
└──────────┬────────────────────┬────────────────────┬──────────┘
           │ HTTP               │ SSE                │ WebSocket
           ▼                    ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│  server.js (Express + http + ws)           :3000             │
│                                                              │
│  /api/*        → Ollamaリバースプロキシ (http.request)        │
│  /config       → config.json 配信                            │
│  /settings     → settings.json 読み書き                       │
│  /chats/*      → chats/ ディレクトリ CRUD                     │
│  /sse/gpu      → rocm-smi / nvidia-smi SSE                  │
│  /ws/python    → Python子プロセス対話実行                      │
│  /*            → public/ 静的配信 + SPA fallback              │
└──────────────────────┬───────────────────────────────────────┘
                       │ http.request
                       ▼
              Ollama API (:11434)
```

---

## 4. バックエンド（server.js）

### 4.1 依存パッケージ

```json
{ "express": "^4.21.0", "ws": "^8.17.0" }
```

標準モジュール: `http`, `path`, `child_process`, `fs`, `os`

### 4.2 設定読み込み

| ソース | 用途 |
|:--|:--|
| 環境変数 | `PORT`, `OLLAMA_HOST`, `OLLAMA_PORT`, `PYTHON_TIMEOUT`, `GPU_INTERVAL`, `CHATS_DIR` |
| `config.json` | アプリ名、カラー、RAGパラメータ、推論パラメータ（起動時1回読み込み） |
| `settings.json` | ユーザーが選択したモデル、コンテキストサイズ（REST APIで読み書き） |

`config.json` は `DEFAULT_CONFIG` とマージされるため、一部キーのみの記述でも動作する。

### 4.3 Ollamaリバースプロキシ

```
app.use('/api', ...)
```

- `http.request` で `OLLAMA_HOST:OLLAMA_PORT` へ転送
- `express.json()` はこのルートに適用しない（リクエストボディをそのままパイプするため）
- ストリーミング対応（`res.pipe`）
- ログ出力: メソッド、パス、IPアドレス

**注意**: `express.json()` をグローバルに適用するとOllamaプロキシのリクエストボディを消費するため、`/chats/:id` と `/settings` のみ `jsonParser` ミドルウェアを適用。

### 4.4 WebSocket: Python実行

```
/ws/python
```

- `child_process.spawn('python3', ['-u', '-i'])` で対話シェルを起動
- クライアントからコードを受信 → stdin に書き込み
- stdout/stderr をクライアントに送信
- タイムアウト: `PYTHON_TIMEOUT`（デフォルト60秒）
- クライアントから `__STOP__` を受信すると `SIGKILL` で強制終了

### 4.5 GPU監視（SSE）

```
/sse/gpu
```

- 起動時に `rocm-smi` → `nvidia-smi` の順で自動検出、結果をキャッシュ（`gpuBackend` 変数）
- `GPU_INTERVAL`（デフォルト1秒）ごとにJSONを送信
- `rocm-smi`: `--showuse -t -P --showmeminfo vram -c --json` → JSONパース
- `nvidia-smi`: `--query-gpu=... --format=csv,noheader,nounits` → CSVパース

**GPU データ構造**:
```typescript
{
  id: string;          // "card0" or "GPU 0"
  name?: string;       // nvidia-smiのみ
  usage: number;       // %
  temp: number;        // Edge温度 °C
  tempHotspot: number; // Junction温度 °C（rocmのみ）
  tempMem: number;     // メモリ温度 °C（rocmのみ）
  power: number;       // W
  sclk: number;        // MHz
  mclk: number;        // MHz
  vramTotalMB: number;
  vramUsedMB: number;
  vramPct: number;     // %
}
```

### 4.6 REST API一覧

| メソッド | パス | Body | 説明 |
|:--|:--|:--|:--|
| `*` | `/api/*` | passthrough | Ollamaリバースプロキシ |
| `GET` | `/config` | — | config.json（マージ済） |
| `GET` | `/settings` | — | settings.json |
| `POST` | `/settings` | `{ chatModel, numCtx }` | settings.json 保存 |
| `GET` | `/chats` | — | チャット一覧（更新日降順） |
| `GET` | `/chats/:id` | — | チャット1件取得 |
| `POST` | `/chats/:id` | `{ title, messages, documents }` | チャット保存 |
| `DELETE` | `/chats/:id` | — | チャット削除 |
| `GET` | `/sse/gpu` | — | GPU監視 SSE |
| `WS` | `/ws/python` | WebSocket | Python対話実行 |

---

## 5. フロントエンド（public/index.html）

### 5.1 構成

1ファイルに CSS + React/Babel を含む単一SPA。ビルドステップ不要。

```
<head>
  ├── CSS（~1400行） — ダークテーマ、レスポンシブ
  └── CDN読み込み
</head>
<body>
  <div id="root" />
  <script type="text/babel">
    ├── ユーティリティ関数（chunkText, cosineSim, escapeHtml, renderLatex）
    ├── MarkdownContent コンポーネント
    ├── ThinkingBlock コンポーネント
    └── App コンポーネント（メイン）
  </script>
</body>
```

### 5.2 CDN依存

| ライブラリ | バージョン | 用途 |
|:--|:--|:--|
| React | 18.2.0 | UI |
| ReactDOM | 18.2.0 | レンダリング |
| Babel Standalone | 7.23.9 | JSXトランスパイル |
| marked | 12.0.1 | Markdownレンダリング |
| highlight.js | 11.9.0 | コードハイライト（github-darkテーマ） |
| KaTeX | 0.16.9 | LaTeX数式レンダリング |
| IBM Plex Sans JP | — | 本文フォント |
| JetBrains Mono | — | コードフォント |

### 5.3 コンポーネント構造

```
App
├── 左サイドバー
│   ├── ロゴ（appConfig.logoMain / logoSub）
│   ├── 設定（モデル選択、コンテキストサイズ）
│   ├── チャット履歴パネル
│   ├── ドキュメントパネル（アップロード、一覧、ドロップゾーン）
│   └── hidden file inputs（テキスト用、画像用）
├── チャットエリア
│   ├── ヘッダー（接続状態、モデル名、新規チャット、GPUボタン）
│   ├── メッセージコンテナ
│   │   ├── ウェルカム画面（メッセージ0件時）
│   │   └── メッセージ一覧
│   │       ├── ThinkingBlock（折りたたみ）
│   │       ├── Agent Activity（検索クエリ表示）
│   │       ├── ユーザーメッセージ（テキスト + 画像サムネイル）
│   │       ├── アシスタントメッセージ（MarkdownContent）
│   │       ├── アクション（ダウンロード、ドキュメントに追加）
│   │       └── 参照資料（グループ化表示）
│   ├── 入力エリア
│   │   ├── 画像プレビューバー
│   │   ├── テキストエリア（ペースト対応）
│   │   └── ツールバー（📎, 🖼️, 送信/停止）
│   └── ローディングオーバーレイ（チャット読み込み時）
├── 右サイドバー（GPUモニター）
├── 画像ライトボックス
└── エラートースト
```

### 5.4 State一覧

| State | 型 | 説明 |
|:--|:--|:--|
| `appConfig` | `object` | config.jsonから読み込んだアプリ設定 |
| `ollamaUrl` | `string` | Ollama APIのベースURL（空文字=相対パス） |
| `chatModel` | `string` | 選択中のチャットモデル |
| `availableModels` | `string[]` | Ollamaから取得したモデル一覧 |
| `connected` | `boolean` | Ollama接続状態 |
| `documents` | `Document[]` | アップロード済みドキュメント |
| `numCtx` | `number` | コンテキストサイズ |
| `messages` | `Message[]` | チャットメッセージ履歴 |
| `input` | `string` | 入力テキスト |
| `isLoading` | `boolean` | 生成中フラグ |
| `error` | `string` | エラーメッセージ（5秒で自動消去） |
| `dragActive` | `boolean` | ドラッグ中フラグ |
| `sidebarOpen` | `boolean` | モバイルサイドバー開閉 |
| `embeddingJobs` | `EmbeddingJob[]` | Embedding生成中ジョブ |
| `gpuData` | `GpuInfo[]` | GPU監視データ |
| `gpuPanelOpen` | `boolean` | GPUパネル開閉 |
| `chatId` | `string` | 現在のチャットID |
| `chatList` | `ChatSummary[]` | チャット一覧 |
| `chatTitle` | `string` | 現在のチャットタイトル |
| `chatLoading` | `boolean` | チャット読み込み中 |
| `chatImages` | `ChatImage[]` | 送信前の画像バッファ |
| `lightboxSrc` | `string\|null` | ライトボックス画像URL |

### 5.5 データ型定義

```typescript
interface Document {
  name: string;
  text: string;
  chunks: string[];
  embeddings: number[][];
}

interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;          // Thinking表示用
  contexts?: RagResult[];     // 参照した資料
  images?: ChatImage[];       // ユーザーが添付した画像
  searchQueries?: SearchQuery[]; // Agenticの検索クエリ
  agentStatus?: string | null;   // Agentステータス表示
}

interface RagResult {
  chunk: string;
  docName: string;
  score: number;
}

interface ChatImage {
  name: string;
  base64: string;      // 生base64（data:プレフィックスなし）
  preview: string;     // data:URL（表示用）
}

interface SearchQuery {
  query: string;
  resultCount: number | null;
}

interface EmbeddingJob {
  id: string;
  name: string;
  current: number;
  total: number;
}

interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
  docCount: number;
}

interface GpuInfo {
  id: string;
  name?: string;
  usage: number;
  temp: number;
  tempHotspot: number;
  tempMem: number;
  power: number;
  sclk: number;
  mclk: number;
  vramTotalMB: number;
  vramUsedMB: number;
  vramPct: number;
}
```

---

## 6. RAGシステム

### 6.1 ドキュメント処理

```
ファイルアップロード → chunkText() → getEmbedding() × N → documents stateに追加
```

- **チャンク分割**: `chunkText(text, chunkSize=500, overlap=100)` — 文字数ベース
- **Embeddingモデル**: `nomic-embed-text:latest` 固定（`/api/embed` 経由）
- **保存**: Embedding含めてチャット履歴JSONに保存（再読み込み時に再計算不要）

### 6.2 検索

```typescript
retrieveContext(query) → getEmbedding(query) → cosineSim() × 全チャンク → Top-K
```

- コサイン類似度でソート → `appConfig.ragTopK` 件取得

### 6.3 Agentic RAG（`ragMode: "agentic"`）

LLMが自律的に検索するかどうかを判断する方式。

```
1. ユーザーメッセージ送信
2. LLM呼び出し（stream: false, tools: [search_documents]）
   → LLMが検索不要と判断 → ステップ4へ
   → LLMが search_documents(query) を呼び出し → ステップ3
3. retrieveContext(query) 実行 → 結果を tool message として追加
4. LLM呼び出し（stream: true, tools なし）→ ストリーミング応答
```

**UI表示フロー**:
- 「ツール判断中...」→「"クエリ"を検索中...」→「1回検索完了」→ ストリーミング開始

**制約**:
- 検索は1ターン1回（ループなし — 2回目の非ストリーミング呼び出しで応答が止まる問題を回避）
- LLMが1回のtool_callsで複数検索を返した場合は全て実行
- ツール呼び出し非対応モデルでは `ragMode: "always"` を使用

### 6.4 従来RAG（`ragMode: "always"`）

```
1. ユーザーメッセージ → retrieveContext() → 常に検索
2. 結果をsystemプロンプトに注入
3. LLM呼び出し（stream: true）
```

---

## 7. 画像入力

### 7.1 入力方法

| 方法 | ハンドラ |
|:--|:--|
| 🖼️ ボタン | `imageInputRef` → `handleImageFiles()` |
| 📎 ボタン（画像ファイル選択時） | `fileInputRef` → `handleFiles()` → 画像判定 |
| クリップボードペースト | `handlePaste()` → `handleImageFiles()` |
| ドラッグ＆ドロップ | `handleDrop()` → `handleFiles()` → 画像判定 |

### 7.2 データフロー

```
File → FileReader.readAsDataURL → base64抽出 → chatImages state
  → 送信時: userMsg.images に格納 → Ollama API の images フィールドに base64配列
  → メッセージ表示: preview URLでサムネイル → クリックでライトボックス
```

### 7.3 Ollama APIへの送信形式

```json
{
  "model": "gemma3:12b",
  "messages": [
    { "role": "user", "content": "この画像は何？", "images": ["base64..."] }
  ]
}
```

- `images` は生base64文字列の配列（`data:` プレフィックスなし）
- 会話履歴の過去メッセージの画像も含める

---

## 8. 自動スクロール

### 8.1 課題

ストリーミング中に `scrollIntoView({ behavior: 'smooth' })` を毎チャンク呼ぶと、スムーズアニメーションが追いつかず途中で止まる。また `scrollTop = scrollHeight` がブラウザの `scroll` イベントを発火させ、ユーザーの手動スクロールと誤判定される。

### 8.2 解決策

```
autoScrollRef    — 自動スクロール有効フラグ
programScrollRef — プログラムスクロール中フラグ

scroll イベント:
  programScrollRef が true → 無視
  bottom付近なら autoScrollRef = true
  上にスクロールしたら autoScrollRef = false

ストリーミング中:
  rAF ループで scrollTop = scrollHeight（programScrollRef で保護）

メッセージ送信時:
  autoScrollRef = true にリセット
```

---

## 9. チャット履歴

### 9.1 保存タイミング

- メッセージ・ドキュメント変更時（1.5秒デバウンス、生成中は保存しない）
- `POST /chats/:id` に `{ title, messages, documents }` を送信

### 9.2 保存データ

```json
{
  "id": "m1abc123",
  "title": "最初のユーザーメッセージ先頭40文字",
  "createdAt": "2025-...",
  "updatedAt": "2025-...",
  "messages": [
    { "role": "user", "content": "...", "images": [...] },
    { "role": "assistant", "content": "...", "thinking": "...", "contexts": [...], "searchQueries": [...] }
  ],
  "documents": [
    { "name": "file.cpp", "text": "...", "chunks": ["..."], "embeddings": [[...]] }
  ]
}
```

### 9.3 グローバル設定（settings.json）

- チャットモデルとコンテキストサイズのみ
- ブラウザから変更時に0.5秒デバウンスで自動保存
- 初回読み込み時に反映（初回保存スキップ用の `settingsInitRef` あり）

---

## 10. CSS設計

### 10.1 テーマ

ダークテーマ固定。CSS変数で定義。`config.json` の `accentColor` から `--accent`, `--accent-dim`, `--accent-glow` を動的に上書き。

### 10.2 レイアウト

```
.app-layout: CSS Grid — grid-template-columns: 340px minmax(0, 1fr)
  ├── .sidebar: 左サイドバー（固定幅340px）
  ├── .chat-area: メインチャット（flex column, height: 100vh）
  │   ├── .chat-header: flex-shrink: 0
  │   ├── .messages-container: flex: 1, overflow-y: auto, min-height: 0
  │   └── .input-area: flex-shrink: 0
  └── .right-sidebar: GPUパネル（固定幅320px、右からスライドイン）
```

### 10.3 レスポンシブ（768px以下）

- `.app-layout`: `grid-template-columns: 1fr`
- サイドバー: オーバーレイスライドイン（ハンバーガーメニュー）
- GPUパネル: オーバーレイスライドイン

### 10.4 レイアウト修正の注意点

- `.app-layout` の `minmax(0, 1fr)` が重要。`1fr` のみだとコンテンツがはみ出す
- `.msg-content` には `min-width: 0; overflow-x: hidden` が必須
- `.msg-bubble` には `overflow-x: auto; min-width: 0` が必須
- `.messages-container` には `min-height: 0` が必須（flex子要素のスクロール）
- `overflow: hidden` を `.msg-content` に付けると縦方向も切り詰めるため使用不可

---

## 11. Markdown / LaTeX レンダリング

### 11.1 処理順序

```
content
  → コードブロック内の$を保護（__DOLLAR_INLINE__ / __DOLLAR_DISPLAY__）
  → renderLatex() — $...$ / $$...$$ / \(...\) / \[...\] を KaTeX でレンダリング
  → marked.parse() — Markdownレンダリング
  → highlight.js — コードハイライト
  → コピーボタン追加（各コードブロック）
  → Pythonコードブロックに「▶ 実行」ボタン追加
```

### 11.2 markedカスタムレンダラー

- コードレンダラー: highlight.js適用、言語表示、コピーボタン、Python実行ボタン
- 引数形式: v12+（オブジェクト）と旧バージョン（位置引数）の両方に対応

---

## 12. Thinking表示

### 12.1 対応形式

| 形式 | ソース |
|:--|:--|
| `message.thinking` フィールド | Ollama APIのネイティブthinking |
| `<think>...</think>` タグ | DeepSeek R1等のコンテンツ内タグ |

### 12.2 パース処理

```javascript
// content内の<think>タグ
const thinkMatch = content.match(/^<think>([\s\S]*?)(<\/think>)?([\s\S]*)$/);
if (thinkMatch) {
  displayThinking = (apiThinking + tagThinking).trim();
  displayContent = closed ? afterThink.trim() : '';
}
```

- ストリーミング中は `<think>` が閉じるまで `displayContent` は空文字
- 両形式は結合される

---

## 13. 拡張時の注意事項

### 13.1 express.json() の適用範囲

`express.json()` をグローバルに適用するとOllamaプロキシのリクエストボディを消費する。`jsonParser` は個別ルートにのみ適用すること。

### 13.2 ストリーミング応答の処理

`streamResponse()` 関数に共通化済み。新しいモードを追加する場合はこの関数を再利用。

### 13.3 チャット保存のデバウンス

`isLoading` 中は保存しない。ストリーミング中にメッセージが高頻度更新されるため、生成完了後に1.5秒後保存。

### 13.4 Embeddingモデル

`nomic-embed-text:latest` 固定（ソースコード内定数）。変更する場合は `embedModel` 変数を修正。

### 13.5 Agentic RAGのモデル互換性

Ollamaの `tools` パラメータ（Tool Calling）対応が必要。非対応モデルでは `ragMode: "always"` に切り替え。

### 13.6 画像保存

チャット履歴に画像をbase64で保存するため、大量の画像を含むチャットはJSONファイルが大きくなる。`jsonParser` の `limit` は `10mb` に設定済み。

### 13.7 rocm-smiのキー名

ROCmバージョンによりJSONキー名が異なる。現在のパーサーは以下のキー名に最適化:
- `GPU use (%)`, `Temperature (Sensor edge) (C)`, `Temperature (Sensor junction) (C)`
- `sclk clock speed:`, `mclk clock speed:`（括弧内Mhz）
- `VRAM Total Memory (B)`, `VRAM Total Used Memory (B)`
- 電力キーは部分一致（`/power/i` かつ `/(W)/`）
