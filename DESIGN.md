# LOCAL AI CHAT — 設計ドキュメント

> AIアシスタントがプロジェクトを理解し、修正・拡張を行うためのリファレンスです。

---

## 1. プロジェクト概要

Ollama連携のAgentic RAGチャットWebアプリ。マルチGPU・複数PC負荷分散対応。  
単一HTMLファイル（React/Babel CDN）+ Node.jsサーバー + リモートGPU監視エージェント構成。

---

## 2. ファイル構成

```
LocalAIChat/
├── server.js              # バックエンド（Express + WS）  ~800行
├── package.json            # express, ws のみ
├── config.json             # アプリ設定（名前・カラー・パスワード・バックエンド・推論パラメータ）
├── hashpass.py             # パスワードハッシュ生成ツール（MD5/SHA-256対応）
├── gpu-agent.js            # 各PCに配置するGPU監視エージェント  ~140行
├── public/
│   ├── index.html          # フロントエンド全体（CSS + React/Babel）  ~3475行
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
  ├── HTTP ─── PC-0 :3000 Node.js (Express)
  │              ├── /web-search    → DuckDuckGo検索
  │              ├── /auth          → 認証（セッションCookie発行）
  │              ├── /api/*         → Ollamaリバースプロキシ（負荷分散）
  │              ├── /config        → アプリ設定
  │              ├── /settings      → ユーザー設定
  │              ├── /chats/*       → チャット履歴 CRUD
  │              └── /sse/gpu       → 全PC統合GPU監視 (SSE)
  │
  └── WS ──── /ws/python           → Python対話実行
                       │
                       ▼
        ┌──────────────┼──────────────┬──────────────┐
        ▼              ▼              ▼              ▼
       PC-0           PC-1           PC-2    ...   PC-N
       :11434         :11434         :11434         :11434
       Ollama         Ollama         Ollama         Ollama
       :11400         :11400         :11400         :11400
       gpu-agent      gpu-agent      gpu-agent      gpu-agent
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
  "appName": "...", "logoMain": "...", "logoSub": "...",
  "welcomeMessage": "...", "welcomeHints": ["...", "..."],
  "accentColor": "#34d399",
  "defaultModel": "",
  "password": "",         // MD5(32桁)/SHA-256(64桁)ハッシュ
  "gpuAgentToken": "",    // 全バックエンド共通のGPUエージェントトークン
  "ollamaBackends": [],   // [{ host, port, gpuAgentPort, gpuAgentToken, label }]
  "webSearch": true,
  "ragTopK": 10, "ragMode": "agentic",
  "tokenAvgWindow": 2000,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

### 4.3 認証システム

**4.3.1 セッショントークン**
- `crypto.randomBytes(32)` で256bitトークン生成
- HttpOnly + SameSite=Strict のCookieとして発行
- 24時間TTL、サーバー側 `Map<token, {ip, expiresAt}>` で管理
- 期限切れセッションは1時間ごとに清掃

**4.3.2 パスワード照合 (`verifyPassword`)**
- MD5(32桁) / SHA-256(64桁) を文字長で自動判別
- `crypto.timingSafeEqual` で定時間比較
- 入力長と保存ハッシュ長が異なる場合は即false

**4.3.3 レートリミット**
- IP別に15分間で最大5回失敗まで許可 → 429
- ログイン成功時に該当IPのカウンタリセット
- `loginAttempts: Map<ip, {count, resetAt}>`

**4.3.4 認証ミドルウェア (`requireAuth`)**
- パスワード未設定なら素通り
- Cookie `wz_session=...` または `X-Auth-Token` ヘッダーから取得
- `isValidSession()` で検証
- WebSocket `/ws/python` でも `req.headers.cookie` から認証

**4.3.5 認証フロー**
```
mount → GET /config → hasPassword?
  ├── false → setAuthenticated(true) → メインUI + データ読込
  └── true → ログイン画面表示
              → POST /auth → Set-Cookie + token
              → setAuthenticated(true)
              → fetchModels() / GPU SSE接続 / チャット読込開始
```

### 4.4 モデル選択の優先順位

```
1. settings.json の chatModel
2. config.json の defaultModel
3. Ollamaモデル一覧の先頭
```

### 4.5 ロードバランシング

**4.5.1 バックエンド構造**
```javascript
{
  host: '192.168.10.0',
  port: 11434,
  gpuAgentPort: 11400,
  gpuAgentToken: 'mysecret123',  // 個別 or 共通の gpuAgentToken
  label: 'PC-0',
  activeConns: 0,
  gpus: []  // gpu-agent から取得した最新GPU情報
}
```

**4.5.2 selectBackend()**
```
スコア = GPU平均使用率(0-100) + アクティブ接続数 × 30
→ 最小スコアを選択
```

**4.5.3 アクティブ接続管理**
- `connDecremented` フラグで二重デクリメント防止
- error / timeout / `res.on('close')` 全てで `decrementConn()` 呼び出し

**4.5.4 後方互換**
- `ollamaBackends` 未設定 → 環境変数 `OLLAMA_HOST:OLLAMA_PORT` の1台構成
- 1台構成時は起動バナーで `Ollama: http://...` 形式
- 複数構成時は `Ollama: N backends (load-balanced)` + 一覧表示

### 4.6 リモートGPU監視

**4.6.1 GPUエージェント (`gpu-agent.js`)**
- 各PCで起動する独立したHTTPサーバー（依存パッケージなし）
- ポート 11400（デフォルト）
- `GET /` → GPU情報JSON配列を返す
- `GPU_AGENT_TOKEN` 環境変数または引数でトークン認証
- `X-Agent-Token` ヘッダーまたは `?token=` クエリで照合

**4.6.2 統合GPU取得 (`updateAllGpuData`)**
```javascript
// ローカル（host=127.0.0.1/localhost/OLLAMA_HOST）→ 直接 queryGpu()
// リモート → fetchRemoteGpu(host, port, token)
// 全バックエンド並列取得（Promise.all）
```

**4.6.3 共有タイマー方式**
- バックグラウンド `setInterval` 1本でキャッシュ更新（GPU_INTERVAL ms ごと）
- `gpuUpdating` フラグで重複実行防止
- SSE送信時は更新せずキャッシュ (`buildGpuSseData()`) のみ送信
- → SSEクライアントが複数いてもリモートGPU取得は1本に集約

**4.6.4 SSEデータ構造**
```typescript
[
  { label: "PC-0", host: "192.168.10.0", port: 11434, gpus: [...] },
  { label: "PC-1", host: "192.168.10.1", port: 11434, gpus: [...] }
]
```

### 4.7 Web検索（DuckDuckGo）

```
GET /web-search?q=クエリ&n=5  (要認証)
```

- `https://html.duckduckgo.com/html/` にPOST + `kl=jp-jp`（日本語リージョン）
- 2段階パーサー: `class="result__a"` → フォールバック `uddg=` リダイレクトURL
- 失敗時: `[DDG]` プレフィックスのデバッグログをコンソール出力
- `/api/*` プロキシと競合しないよう `/api` の外に配置

### 4.8 Ollamaリバースプロキシ

```
/api/* → requireAuth → selectBackend() → http.request転送
```

**注意**: `express.json()` グローバル適用禁止（プロキシのbody消費）。`jsonParser` は個別ルートのみ。

### 4.9 WebSocket: Python実行

```
/ws/python → 認証チェック → spawn('python3', ['-u', ...])
```

タイムアウト: `PYTHON_TIMEOUT`（デフォルト60秒）。`__STOP__` で `SIGKILL`。

### 4.10 チャット履歴

**パストラバーサル対策 (`sanitizeChatId`)**
```javascript
if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
if (id.length > 64) return null;
```

全 `/chats/:id` エンドポイントで適用。不正IDは400。

### 4.11 REST API一覧

| メソッド | パス | 認証 | 説明 |
|:--|:--|:--:|:--|
| `*` | `/api/*` | ✓ | Ollamaリバースプロキシ（負荷分散） |
| `GET` | `/web-search?q=&n=` | ✓ | DuckDuckGo検索 |
| `POST` | `/auth` | — | 認証（セッションCookie発行） |
| `GET` | `/config` | — | config（password/ollamaBackends除外、hasPassword付与） |
| `GET/POST` | `/settings` | ✓ | ユーザー設定 |
| `GET` | `/chats` | ✓ | チャット一覧 |
| `GET/POST/DELETE` | `/chats/:id` | ✓ | チャット CRUD |
| `GET` | `/sse/gpu` | ✓ | 統合GPU監視 SSE |
| `WS` | `/ws/python` | ✓ | Python対話実行 |

---

## 5. フロントエンド（public/index.html）

### 5.1 構成

```
<head>CSS（~1700行） + CDN読み込み</head>
<body>
  <div id="root" />
  <script type="text/babel">
    ├── ユーティリティ
    ├── Markdownカスタムレンダラー（コピー/Python実行/プレビュー）
    ├── グローバル関数（copyCode, fallbackCopy, runPython, runPreview, ...）
    ├── MarkdownContent / ThinkingBlock コンポーネント
    └── App コンポーネント（ログイン画面 + メインUI + GPUモニター）
  </script>
</body>
```

### 5.2 CDN依存

| ライブラリ | バージョン | 用途 |
|:--|:--|:--|
| React / ReactDOM | 18.2.0 | UI |
| Babel Standalone | 7.23.9 | JSXトランスパイル |
| marked | 12.0.1 | Markdown |
| highlight.js | 11.9.0 | コードハイライト |
| KaTeX | 0.16.9 | LaTeX数式 |
| Three.js | r128 | 3Dプレビュー（iframeに動的注入） |
| IBM Plex Sans JP / JetBrains Mono | — | フォント |

### 5.3 useEffect実行順序

```
1. mount: GET /config → setAppConfig + setHasPassword
2. hasPassword === true && !authenticated → ログイン画面
3. POST /auth → setAuthenticated(true)
4. authenticated useEffect:
   - fetchModels() → GET /api/tags → setConnected(true)
   - GPU SSE接続開始
   - loadChatList()
   - GET /settings → setChatModel / setNumCtx
   - 1秒後に settingsLoadedRef.current = true（自動保存有効化）
```

**重要**: `fetchModels` と GPU SSE は `[authenticated]` 依存のuseEffectで実行（認証前は401で失敗するため）。

### 5.4 コンポーネント構造

```
App
├── ログイン画面（hasPassword && !authenticated のとき表示）
├── 左サイドバー
│   ├── ロゴ、設定（モデル選択、コンテキストサイズ）
│   ├── チャット履歴パネル
│   ├── ドキュメントパネル
│   └── hidden file inputs
├── チャットエリア
│   ├── ヘッダー（接続状態、モデル名、新規チャット、GPUボタン）
│   ├── メッセージコンテナ
│   │   ├── ウェルカム画面（0件時）
│   │   └── メッセージ一覧
│   │       ├── ThinkingBlock
│   │       ├── Agent Activity（🔍/🌐 検索クエリ）
│   │       ├── ユーザー/アシスタントメッセージ
│   │       │   ├── コードブロック（コピー/Python実行/プレビュー）
│   │       │   └── Three.js/HTMLプレビュー（sandbox iframe）
│   │       ├── アクション、参照資料
│   │       └── トークン情報（入力/出力 + 使用率バー）
│   ├── 入力エリア（画像プレビュー、テキスト、📎🖼️送信/停止）
│   └── ローディングオーバーレイ
├── 右サイドバー（推論速度 + PC別GPU群）
├── 画像ライトボックス
└── エラートースト
```

### 5.5 State一覧

| State | 型 | 説明 |
|:--|:--|:--|
| `authenticated` | `boolean` | 認証済みフラグ |
| `hasPassword` | `boolean\|null` | パスワード設定有無（null=確認中） |
| `appConfig` | `object` | config.json設定 |
| `chatModel` / `availableModels` / `connected` | — | Ollama接続管理 |
| `documents` / `numCtx` | — | RAG/コンテキスト |
| `messages` / `input` / `isLoading` | — | チャット |
| `gpuData` | `GpuGroup[]` | PC別GPU群 |
| `tokenSpeed` | `TokenSpeed\|null` | 推論速度平均 |
| `chatId` / `chatList` / `chatTitle` | — | チャット管理 |
| `chatImages` / `lightboxSrc` | — | 画像 |

### 5.6 データ型

```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  contexts?: RagResult[];
  images?: ChatImage[];
  searchQueries?: { query: string; resultCount: number; type: 'doc'|'web' }[];
  agentStatus?: string | null;
  tokenInfo?: { promptTokens: number; completionTokens: number } | null;
}

interface GpuGroup {
  label: string;    // "PC-0"
  host: string;
  port: number;
  gpus: GpuInfo[];
}

interface GpuInfo {
  id: string; name?: string;
  usage: number; temp: number; tempHotspot: number; tempMem: number;
  power: number; sclk: number; mclk: number;
  vramTotalMB: number; vramUsedMB: number; vramPct: number;
}

interface TokenSpeed { tokPerSec: number; totalTokens: number; samples: number; }
```

### 5.7 設定保存の二重防止

`settingsLoadedRef` フラグで以下を防止:
- 初期化時: モデル一覧読込でsetChatModelが発火 → 空値で保存される問題
- 認証直後: settings読込前にsetChatModelが発火 → 上書き問題

```
authenticated → settings読込 → 1秒後に settingsLoadedRef = true
→ 以降の chatModel/numCtx 変更で保存される
```

---

## 6. リモートGPU監視エージェント（gpu-agent.js）

### 6.1 概要

各PCで起動する単一ファイルNode.jsスクリプト。依存パッケージなし。

### 6.2 機能

- HTTP `GET /` でGPU情報JSON配列を返す
- `rocm-smi` → `nvidia-smi` の順で自動検出
- トークン認証（オプション）
- CORS有効（`Access-Control-Allow-Origin: *`）

### 6.3 起動例

```bash
# 引数指定
node gpu-agent.js 11400 mysecret

# 環境変数指定（systemd向け）
GPU_AGENT_PORT=11400 GPU_AGENT_TOKEN=mysecret node gpu-agent.js
```

### 6.4 認証

```
リクエスト → ヘッダー X-Agent-Token または ?token=... → トークン照合
不一致 → 401
```

`server.js` 側は `fetchRemoteGpu(host, port, token)` でヘッダーに付与して送信。

---

## 7. Agentic RAG + Web検索

### 7.1 ツール定義

| ツール | 条件 | 説明 |
|:--|:--|:--|
| `search_documents` | `documents.length > 0` | ドキュメントRAG検索 |
| `web_search` | `appConfig.webSearch === true` | DuckDuckGo Web検索 |

### 7.2 フロー（ragMode: "agentic"）

```
1. LLM呼び出し（stream: false, tools: [search_documents?, web_search?]）
2. tool_calls があれば実行:
   - search_documents → retrieveContext() → コサイン類似度Top-K
   - web_search → GET /web-search → DDGスニペット
3. LLM呼び出し（stream: true, tools なし）→ ストリーミング応答
```

### 7.3 システムプロンプト

```
あなたは親切で知識豊富なAIアシスタントです。日本語で回答してください。
今日の日付は{年}年{月}月{日}日です。
[ドキュメント一覧（あれば）]
[Web検索可能（webSearch有効時）]
内部的な推論や検索戦略の説明は出力せず、ユーザーへの回答だけを出力してください。
```

---

## 8. Three.js / HTMLプレビュー

### 対応言語: `/^(html|threejs|three\.js|3d|webgl|canvas)$/`

### 自動処理パイプライン

```
LLMコード → 壊れたThree.js scriptタグ全除去
→ 正規CDN注入(r128 + OrbitControls + window.OrbitControlsシム)
→ ESM→UMD変換（addons先→three後）
→ 非HTMLならラッピング
→ エラーヘルパー注入(onerror→赤オーバーレイ8秒)
→ iframe.srcdoc(sandbox="allow-scripts")
```

r128 UMD固定。r142以降のAPI不可。

---

## 9. トークン情報 & 推論速度

### 9.1 トークン情報（メッセージ下部）

Ollama最終チャンクの `prompt_eval_count` / `eval_count` を取得。  
表示: `入力: X  出力: Y  計: Z  | 使用率バー(%) コンテキストサイズ`  
バー色: 緑(<70%) → オレンジ(70-90%) → 赤(90%+)

### 9.2 推論速度（GPUパネル上部）

`eval_count / eval_duration` を蓄積。`tokenAvgWindow`（デフォルト2000）超で古いものから削除。  
表示: `23.4 tok/s  直近 1,847 トークン / 5 回`

---

## 10. 自動スクロール

```
autoScrollRef    — 有効フラグ
programScrollRef — プログラムスクロール中フラグ（scrollイベント誤判定防止）
ストリーミング中: rAF ループで scrollTop = scrollHeight
ユーザーが上スクロール: 追従停止 / メッセージ送信: リセット
```

---

## 11. チャット履歴

保存: `{ title, messages, documents }` — 1.5秒デバウンス、生成中は保存しない。  
画像base64もJSON保存 → `jsonParser` limit `10mb`。  
グローバル設定（settings.json）: `chatModel`, `numCtx` のみ。  
`settingsLoadedRef` で読み込み完了まで保存抑制。

---

## 12. 拡張時の注意事項

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
| 認証 | `fetchModels` と GPU SSE は `[authenticated]` 依存に必須 |
| 設定保存 | `settingsLoadedRef` で初回読み込み完了前の保存を抑制 |
| GPU取得 | バックグラウンド共有タイマー1本に集約（並列爆発防止） |
| アクティブ接続 | `connDecremented` フラグで二重デクリメント防止 |
| パストラバーサル | `sanitizeChatId()` で英数字・ハイフン・アンダースコアのみ |
| セッション | サーバー再起動でリセット（Map保持） |
| HTTPS | 本番運用時はリバースプロキシで終端し Set-Cookie に Secure 属性追加が必要 |
| rocm-smiキー名 | ROCmバージョンで異なる。電力キーは部分一致 |
