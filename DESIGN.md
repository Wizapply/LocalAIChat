# WIZAPPLY AI CHAT — 設計ドキュメント

> このドキュメントはAIアシスタントがプロジェクトを理解し、修正・拡張を行うためのリファレンスです。

---

## 1. プロジェクト概要

Ollama連携のAgentic RAGチャットWebアプリ。ローカルLLMを使い、ドキュメントRAG・画像入力・Three.jsプレビュー・GPU監視・Python実行をブラウザから利用できる。

- **単一HTMLアプリ**: フロントエンドは `public/index.html` 1ファイル（React/Babel CDN、ビルド不要）
- **サーバー**: `server.js` 1ファイル（Express + WebSocket）
- **設定**: `config.json`（アプリ設定）+ `settings.json`（ユーザー設定、自動生成）

---

## 2. ファイル構成

```
wizapply-ai-chat/
├── server.js              # バックエンド（Express + WS）  ~460行
├── package.json            # express, ws のみ
├── config.json             # アプリ設定（名前・カラー・モデル・推論パラメータ）
├── public/
│   ├── index.html          # フロントエンド全体（CSS + React/Babel）  ~3200行
│   └── aiicon.jpg          # アイコン画像（favicon・ロゴ・AIアバター）
├── chats/                  # チャット履歴JSON（自動作成、.gitignore済）
├── settings.json           # ユーザー設定（自動作成、.gitignore済）
├── README.md
├── DESIGN.md               # このファイル
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
│  │ 設定      │ │ メッセージ│ │ +推論速度 │ │ テキスト+画像     │  │
│  │ チャット履歴│ │ Thinking │ │ パネル    │ │ ペースト/D&D     │  │
│  │ ドキュメント│ │ RAG参照  │ │ (SSE)    │ │                  │  │
│  │           │ │ 3Dプレビュー│          │ │                  │  │
│  │           │ │ トークン情報│          │ │                  │  │
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
| `config.json` | アプリ名、カラー、デフォルトモデル、RAGパラメータ、推論パラメータ（起動時1回読み込み） |
| `settings.json` | ユーザーが選択したモデル、コンテキストサイズ（REST APIで読み書き） |

`config.json` は `DEFAULT_CONFIG` とマージされるため、一部キーのみの記述でも動作する。

### 4.3 config.json 全キー

```json
{
  "appName": "WIZAPPLY AI CHAT",
  "logoMain": "WIZAPPLY",
  "logoSub": "AI CHAT",
  "welcomeMessage": "...",
  "welcomeHints": ["...", "..."],
  "accentColor": "#34d399",
  "defaultModel": "",
  "ragTopK": 10,
  "ragMode": "agentic",
  "tokenAvgWindow": 2000,
  "topK": 40,
  "topP": 0.9,
  "temperature": 0.7
}
```

| キー | 説明 | デフォルト |
|:--|:--|:--|
| `appName` | ページタイトル・ウェルカム画面 | `WIZAPPLY AI CHAT` |
| `logoMain` / `logoSub` | サイドバーロゴ | `WIZAPPLY` / `AI CHAT` |
| `welcomeMessage` | ウェルカム説明文 | — |
| `welcomeHints` | ヒントチップ配列 | — |
| `accentColor` | テーマカラー（HEX） | `#34d399` |
| `defaultModel` | 初期モデル（空→一覧の先頭） | `""` |
| `ragTopK` | RAG検索チャンク数 | `10` |
| `ragMode` | `agentic` / `always` | `agentic` |
| `tokenAvgWindow` | 推論速度の平均計算対象トークン数 | `2000` |
| `topK` | Top-K サンプリング | `40` |
| `topP` | Top-P サンプリング | `0.9` |
| `temperature` | Temperature | `0.7` |

### 4.4 モデル選択の優先順位

```
1. settings.json の chatModel（ユーザーがUIで最後に選択）
2. config.json の defaultModel（初回起動時）
3. Ollamaモデル一覧の先頭（上記2つとも空の場合）
```

### 4.5 Ollamaリバースプロキシ

```
app.use('/api', ...)
```

- `http.request` で `OLLAMA_HOST:OLLAMA_PORT` へ転送
- ストリーミング対応（`res.pipe`）

**注意**: `express.json()` をグローバルに適用するとOllamaプロキシのリクエストボディを消費する。`jsonParser` は `POST /chats/:id` と `POST /settings` のみに適用。

### 4.6 WebSocket: Python実行

```
/ws/python
```

- `child_process.spawn('python3', ['-u', '-i'])` で対話シェルを起動
- クライアントから `__STOP__` を受信すると `SIGKILL` で強制終了

### 4.7 GPU監視（SSE）

```
/sse/gpu
```

- 起動時に `rocm-smi` → `nvidia-smi` の順で自動検出、結果をキャッシュ（`gpuBackend` 変数）
- `GPU_INTERVAL`（デフォルト1秒）ごとにJSONを送信

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

### 4.8 REST API一覧

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
  ├── CSS（~1600行） — ダークテーマ、レスポンシブ、プレビューUI
  └── CDN読み込み
</head>
<body>
  <div id="root" />
  <script type="text/babel">
    ├── ユーティリティ関数（chunkText, cosineSim, escapeHtml, renderLatex）
    ├── Markdownカスタムレンダラー（コピー/Python実行/プレビューボタン）
    ├── グローバル関数（copyCode, fallbackCopy, runPython, runPreview, closePreview, resizePreview）
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
| Three.js | r128 | 3Dプレビュー（iframeに動的注入） |
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
│   │       ├── Agent Activity（検索クエリ・件数表示）
│   │       ├── ユーザーメッセージ（テキスト + 画像サムネイル）
│   │       ├── アシスタントメッセージ（MarkdownContent）
│   │       │   ├── コードブロック（コピー / Python実行 / プレビューボタン）
│   │       │   └── Three.js / HTMLプレビュー（sandbox iframe）
│   │       ├── アクション（ダウンロード、ドキュメントに追加）
│   │       ├── 参照資料（グループ化表示）
│   │       └── トークン情報（入力/出力/合計 + コンテキスト使用率バー）
│   ├── 入力エリア
│   │   ├── 画像プレビューバー
│   │   ├── テキストエリア（ペースト対応）
│   │   └── ツールバー（📎, 🖼️, 送信/停止）
│   └── ローディングオーバーレイ（チャット読み込み時）
├── 右サイドバー（GPUモニター + 推論速度）
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
| `tokenSpeed` | `TokenSpeed\|null` | 推論速度の平均値 |
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
  thinking?: string;             // Thinking表示用
  contexts?: RagResult[];        // 参照した資料
  images?: ChatImage[];          // ユーザーが添付した画像
  searchQueries?: SearchQuery[]; // Agenticの検索クエリ
  agentStatus?: string | null;   // Agentステータス表示
  tokenInfo?: TokenInfo | null;  // トークン使用量
}

interface TokenInfo {
  promptTokens: number;     // 入力トークン数
  completionTokens: number; // 出力トークン数
}

interface TokenSpeed {
  tokPerSec: number;    // トークン/秒
  totalTokens: number;  // 集計対象の合計トークン数
  samples: number;      // 集計対象の応答回数
}

interface RagResult { chunk: string; docName: string; score: number; }
interface ChatImage { name: string; base64: string; preview: string; }
interface SearchQuery { query: string; resultCount: number | null; }
interface EmbeddingJob { id: string; name: string; current: number; total: number; }
interface ChatSummary { id: string; title: string; updatedAt: string; messageCount: number; docCount: number; }
interface GpuInfo { id: string; name?: string; usage: number; temp: number; tempHotspot: number; tempMem: number; power: number; sclk: number; mclk: number; vramTotalMB: number; vramUsedMB: number; vramPct: number; }
```

---

## 6. RAGシステム

### 6.1 ドキュメント処理

```
ファイルアップロード → chunkText(500文字, 100重複) → getEmbedding() × N → documents stateに追加
```

- **Embeddingモデル**: `nomic-embed-text:latest` 固定
- **保存**: Embedding含めてチャット履歴JSONに保存（再読み込み時に再計算不要）

### 6.2 Agentic RAG（`ragMode: "agentic"`）

```
1. LLM呼び出し（stream: false, tools: [search_documents]）→ 検索判断
2. search_documents(query) → retrieveContext() → 結果を tool message に追加
3. LLM呼び出し（stream: true, tools なし）→ ストリーミング応答
```

### 6.3 従来RAG（`ragMode: "always"`）

```
1. retrieveContext(ユーザーメッセージ) → systemプロンプトに注入
2. LLM呼び出し（stream: true）
```

---

## 7. 画像入力

| 方法 | ハンドラ |
|:--|:--|
| 🖼️ ボタン | `imageInputRef` → `handleImageFiles()` |
| 📎 ボタン | `fileInputRef` → `handleFiles()` → 画像判定 |
| クリップボードペースト | `handlePaste()` |
| ドラッグ＆ドロップ | `handleDrop()` → `handleFiles()` |

Ollama APIの `images` フィールドに生base64配列として送信。会話履歴の全画像を含める。

---

## 8. Three.js / HTMLプレビュー

### 8.1 対応言語

```
/^(html|threejs|three\.js|3d|webgl|canvas)$/
```

### 8.2 自動処理パイプライン

```
LLMのコード → 壊れたThree.js scriptタグ全除去(正規表現)
  → 正規CDN注入(r128 + OrbitControls + window.OrbitControlsシム)
  → ESM→UMD変換(順序: addons先→three後)
    import * as THREE → コメント化
    import {X} from 'three/addons/...' → コメント化(シムで定義済み)
    import {X,Y} from 'three' → const {X,Y} = THREE
    <script type="module"> → <script>
  → 非HTMLならラッピング(html/head/body/style自動付与)
  → エラーヘルパー注入(onerror→赤オーバーレイ8秒)
  → iframe.srcdoc(sandbox="allow-scripts")
```

### 8.3 Three.js バージョン注意

r128（UMDビルド）。`THREE.OrbitControls` としてグローバル登録。r142以降のAPI不可。

---

## 9. トークン情報 & 推論速度

### 9.1 トークン情報（メッセージ下部）

Ollamaの最終チャンク（`done: true`）に含まれる `prompt_eval_count` と `eval_count` を取得。

表示: `入力: X  出力: Y  計: Z  | 使用率バー(%) コンテキストサイズ`

使用率バーの色: 緑(<70%) → オレンジ(70-90%) → 赤(90%+)

### 9.2 推論速度（GPUパネル）

`eval_count` / `eval_duration`（ナノ秒）からトークン/秒を計算。

- `tokenHistoryRef` に各応答の `{ tokens, durationNs }` を蓄積
- 合計トークン数が `appConfig.tokenAvgWindow`（デフォルト2000）を超えたら古いものから削除
- 平均 = 合計トークン / 合計時間

GPUパネル上部に `23.4 tok/s` + `直近 1,847 トークン / 5 回` と表示。

---

## 10. コードブロック処理

### 10.1 カスタムレンダラー

| 言語 | ボタン |
|:--|:--|
| `python`, `py` 等 | ▶ 実行 + コピー |
| `html`, `threejs`, `3d` 等 | ▶ プレビュー + コピー |
| その他 | コピー |

### 10.2 コピー機能

HTTPS: `navigator.clipboard.writeText()` / HTTP: `fallbackCopy()`（textarea + `execCommand('copy')`）

---

## 11. 自動スクロール

```
autoScrollRef    — 自動スクロール有効フラグ
programScrollRef — プログラムスクロール中フラグ

ストリーミング中: rAF ループで scrollTop = scrollHeight（programScrollRefで保護）
ユーザーが上にスクロール: autoScrollRef = false で追従停止
メッセージ送信: autoScrollRef = true にリセット
```

---

## 12. チャット履歴

### 12.1 保存データ

```json
{
  "title": "...",
  "messages": [{ "role": "...", "content": "...", "images": [...], "tokenInfo": {...} }],
  "documents": [{ "name": "...", "text": "...", "chunks": [...], "embeddings": [[...]] }]
}
```

- 1.5秒デバウンス、生成中は保存しない
- 画像base64も保存 → `jsonParser` limit `10mb`

### 12.2 グローバル設定（settings.json）

- `chatModel` と `numCtx` のみ
- 0.5秒デバウンス自動保存

---

## 13. CSS設計

### 13.1 レイアウト

```
.app-layout: CSS Grid — grid-template-columns: 340px minmax(0, 1fr)
  ├── .sidebar: 左サイドバー（固定幅340px）
  ├── .chat-area: メインチャット（flex column, height: 100vh, position: relative）
  │   ├── .chat-header: flex-shrink: 0
  │   ├── .messages-container: flex: 1, overflow-y: auto, min-height: 0
  │   └── .input-area: flex-shrink: 0
  └── .right-sidebar: GPUパネル（固定幅320px、右からスライドイン）
```

### 13.2 レイアウト修正の注意点

- `.app-layout` の `minmax(0, 1fr)` が重要（`1fr` のみだとはみ出す）
- `.msg-content`: `min-width: 0; overflow-x: hidden` 必須
- `.msg-bubble`: `overflow-x: auto; min-width: 0` 必須
- `.messages-container`: `min-height: 0` 必須

### 13.3 テーマカラー動的上書き

`config.json` の `accentColor` から `--accent`, `--accent-dim`, `--accent-glow` をJS側でCSSカスタムプロパティに設定。

---

## 14. 拡張時の注意事項

| 項目 | 注意 |
|:--|:--|
| express.json() | グローバル適用禁止。個別ルートのみ |
| ストリーミング | `streamResponse()` に共通化済み。新モードでも再利用 |
| Embeddingモデル | `nomic-embed-text:latest` 固定（`embedModel` 変数） |
| Agentic RAG | Tool Calling対応モデル必須。非対応モデルは `ragMode: "always"` |
| 画像保存 | base64でJSON保存。大量画像は容量増大。limit: 10mb |
| Three.js | r128 UMD。ESM import / 壊れたURL は自動変換・修正 |
| コピー機能 | HTTP環境は `execCommand('copy')` フォールバック |
| rocm-smiキー名 | ROCmバージョンで異なる。電力キーは部分一致 |
| 自動スクロール | `programScrollRef` でプログラム/ユーザースクロール分離 |
| marked引数形式 | v12+（オブジェクト）と旧（位置引数）の両方に対応 |
