# LOCAL WEB AI CHAT — 設計ドキュメント

> AIアシスタントがプロジェクトを理解し、修正・拡張を行うためのリファレンスです。

---

## 1. プロジェクト概要

Ollama連携のAgentic RAGチャットWebアプリ。単一HTMLファイル（React/Babel CDN）+ Node.jsサーバー構成。

---

## 2. ファイル構成

```
LocalAIChat/
├── server.js              # バックエンド（Express + WS）  ~630行
├── package.json            # express, ws のみ
├── config.json             # アプリ設定（名前・カラー・パスワード・推論パラメータ）
├── hashpass.py             # パスワードMD5ハッシュ生成ツール
├── public/
│   ├── index.html          # フロントエンド全体（CSS + React/Babel）  ~3430行
│   └── aiicon.jpg          # アイコン画像（favicon・ロゴ・AIアバター）
├── chats/                  # チャット履歴JSON（自動作成、.gitignore済）
├── settings.json           # ユーザー設定（自動作成、.gitignore済）
├── README.md               # 公開用ドキュメント
├── DESIGN.md               # このファイル
├── LICENSE                 # MIT
└── .gitignore
```

---

## 3. アーキテクチャ

```
ブラウザ (React SPA)
  │
  ├── HTTP ─── :3000 Node.js (Express)
  │              ├── /web-search    → DuckDuckGo検索
  │              ├── /auth          → パスワード認証（MD5）
  │              ├── /api/*         → Ollamaリバースプロキシ（負荷分散）
  │              ├── /config        → アプリ設定
  │              ├── /settings      → ユーザー設定
  │              ├── /chats/*       → チャット履歴 CRUD
  │              └── /sse/gpu       → GPU監視 (SSE)
  │
  └── WS ──── /ws/python           → Python対話実行
```

---

## 4. バックエンド（server.js）

### 4.1 依存

```json
{ "express": "^4.21.0", "ws": "^8.17.0" }
```

標準モジュール: `http`, `https`, `path`, `child_process`, `fs`, `crypto`, `os`

### 4.2 config.json 全キー

```json
{
  "appName": "WIZAPPLY AI CHAT",
  "logoMain": "WIZAPPLY", "logoSub": "AI CHAT",
  "welcomeMessage": "...", "welcomeHints": ["...", "..."],
  "accentColor": "#34d399",
  "defaultModel": "",
  "password": "",
  "webSearch": true,
  "ollamaBackends": [],
  "ragTopK": 10, "ragMode": "agentic",
  "tokenAvgWindow": 2000,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

全キーは `DEFAULT_CONFIG` とマージされるため、一部省略可。

### 4.3 パスワード認証

- `config.json` の `password` にMD5ハッシュを保存（`hashpass.py` で生成）
- 空文字 → 制限なし（ログイン画面スキップ）
- `GET /config` → `hasPassword: true/false` のみ返す（ハッシュ自体は非公開）
- `POST /auth { password: "平文" }` → サーバーでMD5化して照合
- セッション管理なし（リロードで再認証）

### 4.4 モデル選択の優先順位

```
1. settings.json の chatModel（ユーザーがUIで最後に選択）
2. config.json の defaultModel（初回起動時）
3. Ollamaモデル一覧の先頭（上記2つとも空の場合）
```

### 4.5 Ollamaリバースプロキシ & ロードバランシング

```
/api/* → selectBackend() → 最適なバックエンドにhttp.request転送
```

- `ollamaBackends` 未設定 → 環境変数 `OLLAMA_HOST:OLLAMA_PORT` の1台構成
- 複数バックエンド設定時:
  - `selectBackend()`: `スコア = GPU使用率 + アクティブ接続数 × 30` → 最小スコアを選択
  - `gpuIndex` で `cachedGpuData` のGPU使用率を参照
  - `cachedGpuData` は5秒ごと + SSE送信時に更新
  - `res.on('close')` でアクティブ接続数をデクリメント
- ログに振り分け先を表示: `POST /api/chat [127.0.0.1:11435]`

**注意**: `express.json()` はグローバル適用禁止。`jsonParser` は個別ルートのみ。

### 4.6 Web検索（DuckDuckGo）

```
GET /web-search?q=クエリ&n=5
```

- `https://html.duckduckgo.com/html/` にPOSTしHTMLをパース
- 2段階パーサー: `class="result__a"` → フォールバック `uddg=` リダイレクトURL
- `kl=jp-jp` で日本語リージョン
- エンドポイントは `/web-search`（`/api/*` プロキシと競合しないよう `/api` の外に配置）
- 検索失敗時はサーバーコンソールに `[DDG]` プレフィックスのデバッグログ出力

### 4.7 WebSocket: Python実行

```
/ws/python → spawn('python3', ['-u', '-i'])
```

タイムアウト: `PYTHON_TIMEOUT`（デフォルト60秒）。`__STOP__` で `SIGKILL`。

### 4.8 GPU監視（SSE）

```
/sse/gpu → rocm-smi / nvidia-smi 自動検出 → JSON送信
```

`GPU_INTERVAL`（デフォルト1秒）ごと。バックグラウンドでも5秒ごとに `cachedGpuData` を更新。

### 4.9 REST API一覧

| メソッド | パス | 説明 |
|:--|:--|:--|
| `GET` | `/web-search?q=&n=` | DuckDuckGo Web検索 |
| `POST` | `/auth` | パスワード認証（MD5照合） |
| `*` | `/api/*` | Ollamaリバースプロキシ（負荷分散） |
| `GET` | `/config` | config.json（password除外、hasPassword付与） |
| `GET/POST` | `/settings` | ユーザー設定 |
| `GET` | `/chats` | チャット一覧（更新日降順） |
| `GET/POST/DELETE` | `/chats/:id` | チャット CRUD |
| `GET` | `/sse/gpu` | GPU監視 SSE |
| `WS` | `/ws/python` | Python対話実行 |

---

## 5. フロントエンド（public/index.html）

### 5.1 構成

```
<head>
  ├── CSS（~1700行） — ダークテーマ、レスポンシブ、ログイン画面、プレビューUI
  └── CDN読み込み
</head>
<body>
  <div id="root" />
  <script type="text/babel">
    ├── ユーティリティ（chunkText, cosineSim, escapeHtml, renderLatex）
    ├── Markdownカスタムレンダラー（コピー/Python実行/プレビューボタン）
    ├── グローバル関数（copyCode, fallbackCopy, runPython, runPreview, closePreview, resizePreview）
    ├── MarkdownContent / ThinkingBlock コンポーネント
    └── App コンポーネント（ログイン画面 + メインUI）
  </script>
</body>
```

### 5.2 CDN依存

| ライブラリ | バージョン | 用途 |
|:--|:--|:--|
| React / ReactDOM | 18.2.0 | UI |
| Babel Standalone | 7.23.9 | JSXトランスパイル |
| marked | 12.0.1 | Markdown |
| highlight.js | 11.9.0 | コードハイライト（github-dark） |
| KaTeX | 0.16.9 | LaTeX数式 |
| Three.js | r128 | 3Dプレビュー（iframeに動的注入） |
| IBM Plex Sans JP / JetBrains Mono | — | フォント |

### 5.3 コンポーネント構造

```
App
├── ログイン画面（hasPassword && !authenticated のとき表示）
│   └── パスワード入力 → POST /auth → 認証成功でメインUIへ
├── 左サイドバー
│   ├── ロゴ、設定（モデル選択、コンテキストサイズ）
│   ├── チャット履歴パネル
│   ├── ドキュメントパネル（アップロード、一覧、ドロップゾーン）
│   └── hidden file inputs（テキスト用、画像用）
├── チャットエリア
│   ├── ヘッダー（接続状態、モデル名、新規チャット、GPUボタン）
│   ├── メッセージコンテナ
│   │   ├── ウェルカム画面（0件時）
│   │   └── メッセージ一覧
│   │       ├── ThinkingBlock（折りたたみ）
│   │       ├── Agent Activity（🔍ドキュメント / 🌐Web検索 + 件数）
│   │       ├── ユーザーメッセージ（テキスト + 画像サムネイル）
│   │       ├── アシスタントメッセージ（MarkdownContent）
│   │       │   ├── コードブロック（コピー / Python実行 / プレビュー）
│   │       │   └── Three.js / HTMLプレビュー（sandbox iframe）
│   │       ├── アクション（ダウンロード、ドキュメントに追加）
│   │       ├── 参照資料（グループ化表示）
│   │       └── トークン情報（入力/出力 + コンテキスト使用率バー）
│   ├── 入力エリア（画像プレビュー、テキストエリア、📎 🖼️ 送信/停止）
│   └── ローディングオーバーレイ
├── 右サイドバー（推論速度 + GPUモニター）
├── 画像ライトボックス
└── エラートースト
```

### 5.4 認証フロー

```
mount → GET /config → hasPassword?
  ├── false → setAuthenticated(true) → メインUI表示 + データ読み込み
  └── true → ログイン画面表示
              → ユーザーがパスワード入力 → POST /auth
              → 成功 → setAuthenticated(true) → データ読み込み
              → 失敗 → エラー表示
```

認証前: チャット履歴・設定・モデル一覧を読み込まない。

**設定保存の注意**: `settingsLoadedRef` フラグにより、認証後の設定読み込みが完了するまで自動保存を抑制（読み込み前の空値で上書きするのを防止）。

### 5.5 State一覧

| State | 型 | 説明 |
|:--|:--|:--|
| `authenticated` | `boolean` | 認証済みフラグ |
| `hasPassword` | `boolean\|null` | パスワード設定有無（null=確認中） |
| `appConfig` | `object` | config.json設定 |
| `chatModel` | `string` | 選択中モデル |
| `availableModels` | `string[]` | モデル一覧 |
| `connected` | `boolean` | Ollama接続状態 |
| `documents` | `Document[]` | アップロード済みドキュメント |
| `numCtx` | `number` | コンテキストサイズ |
| `messages` | `Message[]` | メッセージ履歴 |
| `input` | `string` | 入力テキスト |
| `isLoading` | `boolean` | 生成中フラグ |
| `error` | `string` | エラー（5秒で消去） |
| `gpuData` | `GpuInfo[]` | GPU監視データ |
| `tokenSpeed` | `TokenSpeed\|null` | 推論速度平均 |
| `chatId` / `chatList` / `chatTitle` | — | チャット管理 |
| `chatLoading` | `boolean` | チャット読み込み中 |
| `chatImages` | `ChatImage[]` | 送信前画像バッファ |
| `lightboxSrc` | `string\|null` | ライトボックス |

### 5.6 データ型定義

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  contexts?: RagResult[];
  images?: ChatImage[];
  searchQueries?: SearchQuery[];  // { query, resultCount, type: 'doc'|'web' }
  agentStatus?: string | null;
  tokenInfo?: { promptTokens: number; completionTokens: number } | null;
}

interface Document { name: string; text: string; chunks: string[]; embeddings: number[][]; }
interface RagResult { chunk: string; docName: string; score: number; }
interface ChatImage { name: string; base64: string; preview: string; }
interface TokenSpeed { tokPerSec: number; totalTokens: number; samples: number; }
interface GpuInfo { id: string; name?: string; usage: number; temp: number; tempHotspot: number; tempMem: number; power: number; sclk: number; mclk: number; vramTotalMB: number; vramUsedMB: number; vramPct: number; }
```

---

## 6. Agentic RAG + Web検索

### 6.1 ツール定義

| ツール | 条件 | 説明 |
|:--|:--|:--|
| `search_documents` | `documents.length > 0` | ドキュメントRAG検索 |
| `web_search` | `appConfig.webSearch === true` | DuckDuckGo Web検索 |

### 6.2 フロー（ragMode: "agentic"）

```
1. LLM呼び出し（stream: false, tools: [search_documents?, web_search?]）
2. tool_calls があれば実行:
   - search_documents → retrieveContext() → コサイン類似度Top-K
   - web_search → GET /web-search → DDGスニペット
3. LLM呼び出し（stream: true, tools なし）→ ストリーミング応答
```

### 6.3 システムプロンプト

```
あなたは親切で知識豊富なAIアシスタントです。日本語で回答してください。
今日の日付は{年}年{月}月{日}日です。
[ドキュメント一覧（あれば）]
[Web検索可能（有効時）]
内部的な推論や検索戦略の説明は出力せず、ユーザーへの回答だけを出力してください。
```

### 6.4 従来RAG（ragMode: "always"）

```
retrieveContext(ユーザーメッセージ) → systemプロンプトに注入 → stream: true
```

---

## 7. Three.js / HTMLプレビュー

### 対応言語: `/^(html|threejs|three\.js|3d|webgl|canvas)$/`

### 自動処理パイプライン

```
LLMコード → 壊れたThree.js scriptタグ全除去(正規表現)
→ 正規CDN注入(r128 + OrbitControls + window.OrbitControlsシム)
→ ESM→UMD変換（順序: addons先→three後）
→ 非HTMLならラッピング
→ エラーヘルパー注入(onerror→赤オーバーレイ8秒)
→ iframe.srcdoc(sandbox="allow-scripts")
```

r128 UMD使用。r142以降のAPI不可。

---

## 8. 自動スクロール

```
autoScrollRef    — 有効フラグ
programScrollRef — プログラムスクロール中フラグ（scrollイベント誤判定防止）
ストリーミング中: rAF ループで scrollTop = scrollHeight
ユーザーが上スクロール: 追従停止 / メッセージ送信: リセット
```

---

## 9. チャット履歴

保存: `{ title, messages, documents }` — 1.5秒デバウンス、生成中は保存しない。

画像base64もJSON保存 → `jsonParser` limit `10mb`。

グローバル設定（settings.json）: `chatModel`, `numCtx` のみ。`settingsLoadedRef` で読み込み完了まで保存抑制。

---

## 10. 拡張時の注意事項

| 項目 | 注意 |
|:--|:--|
| express.json() | グローバル適用禁止。個別ルートのみ |
| /web-search | `/api/*` プロキシの外に配置必須 |
| ストリーミング | `streamResponse()` に共通化済み |
| Embeddingモデル | `nomic-embed-text:latest` 固定（`embedModel` 変数） |
| Agentic RAG | Tool Calling対応モデル必須。非対応は `ragMode: "always"` |
| 画像保存 | base64でJSON保存。limit: 10mb |
| Three.js | r128 UMD。ESM import/壊れたURLは自動変換 |
| コピー機能 | HTTP環境は `execCommand('copy')` フォールバック |
| 認証 | `settingsLoadedRef` で初回読み込み完了前の保存を抑制 |
| rocm-smiキー名 | ROCmバージョンで異なる。電力キーは部分一致 |
| marked引数形式 | v12+(オブジェクト)と旧(位置引数)の両方に対応 |
