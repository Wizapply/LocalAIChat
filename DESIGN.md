# OpenGeekLLMChat - 設計ドキュメント

このドキュメントは、コード修正時にLLMが参照する設計書です。
アーキテクチャ、データフロー、主要な技術判断の理由が記載されています。

---

## 📐 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────┐
│                    Browser (Client)                     │
│  public/index.html (React SPA / 単一ファイル / ~4300行) │
│  - 認証画面                                             │
│  - チャットUI                                           │
│  - Python実行ターミナル                                 │
│  - GPU監視サイドバー                                    │
│  - Web Speech API (STT/TTS)                             │
└──────────────────────┬──────────────────────────────────┘
                       │ HTTPS / WebSocket
                       │
┌──────────────────────▼──────────────────────────────────┐
│                  server.js (Node.js)                    │
│  - Express (HTTP/HTTPS切り替え自動)                     │
│  - WebSocket (ws) - Python実行                          │
│  - セッション管理                                       │
│  - Ollamaリバースプロキシ (負荷分散)                   │
│  - DuckDuckGo検索 (+本文取得)                           │
│  - ファイル操作API                                      │
│  - GPU監視 SSE ハブ                                     │
└─────┬──────────┬──────────┬──────────┬─────────────────┘
      │          │          │          │
      ▼          ▼          ▼          ▼
  ┌───────┐ ┌───────┐ ┌───────┐ ┌───────────┐
  │Ollama │ │Python │ │DDG    │ │gpu-agent  │
  │ #0    │ │subproc│ │HTTP   │ │(別PC)     │
  └───────┘ └───────┘ └───────┘ └───────────┘
  ┌───────┐
  │Ollama │ ← 複数バックエンドで負荷分散
  │ #1    │
  └───────┘
```

---

## 📁 ファイル構成と役割

| ファイル | 役割 | 依存 |
|:--|:--|:--|
| `server.js` | メインサーバー（Express+WS） | `express`, `ws` |
| `gpu-agent.js` | リモートGPU情報配信 | なし（標準ライブラリのみ） |
| `public/index.html` | React SPA単一ファイル | CDN経由（react, marked, highlight.js, katex, three.js） |
| `config.json` | 全設定 | - |
| `hashpass.py` | パスワードハッシュ生成 | Python標準 |
| `generate-cert.sh` | 自己署名SSL生成 | openssl |
| `transcribe-server.py` | Gemma4音声認識（参考実装） | transformers, torch |
| `opengeek-llm-chat.service` | systemdテンプレート | - |

---

## 🔐 認証フロー

```
[初回アクセス]
Browser              Server
   │                   │
   │── GET /config ───>│
   │<── { hasPassword:true, authenticated:false }
   │ ログイン画面表示  │
   │                   │
   │── POST /auth ────>│ (パスワード送信)
   │                   │ crypto.timingSafeEqual で照合
   │                   │ 失敗時: loginAttempts でレートリミット
   │<── Set-Cookie ────│ wz_session=<32byteHex> HttpOnly SameSite=Strict [Secure]
   │ チャット画面       │ sessions Map に格納 (TTL 24h)

[再アクセス (Cookie有効)]
   │── GET /config (Cookie付き) ──>│
   │                               │ isValidSession() 検証
   │<── { authenticated:true } ────│
   │ ログイン画面スキップ          │
```

### セキュリティ要素
- **セッションメモリ保持**: Map (サーバー再起動でリセット)
- **Cookie属性**: `HttpOnly; SameSite=Strict; Max-Age=86400` + HTTPS時 `Secure`
- **HTTPS自動判定**: `HTTPS_ENABLED || X-Forwarded-Proto === 'https'`
- **レートリミット**: 15分5回失敗で429
- **全認証必須ルートに `requireAuth` ミドルウェア適用**

### `isValidSession(token)`
```javascript
const s = sessions.get(token);
if (!s || s.expiresAt < Date.now()) { sessions.delete(token); return false; }
return true;
```

---

## 🤖 Agentic RAG / マルチターンツール実行

### 概要

LLMが応答生成前に「ツール判断フェーズ」と「最終応答フェーズ」の2段階で動作:

```
[1] ツール判断フェーズ (非ストリーミング)
    - 軽量プロンプト (smallCtx: 2048, smallPredict: 512)
    - tools パラメータでOllamaに関数一覧を渡す
    - LLMが tool_calls を返すか、直接応答するか判断

[2] ツール実行フェーズ (最大3ターン)
    - tool_calls があれば実行
    - 結果を messages に追加
    - 再度ツール判断へ (tool_calls がなくなるまで繰り返し)

[3] 最終応答フェーズ (ストリーミング)
    - toolsなしで /api/chat 呼び出し
    - ストリームで content + thinking を受信
```

### マルチターン実装のポイント

```javascript
const MAX_TOOL_TURNS = 3;
while (toolTurn < MAX_TOOL_TURNS) {
  toolTurn++;
  const turnMessages = toolTurn === 1
    ? judgeMessages
    : [judgeSystem, ...apiMessages.slice(1)];

  const res = await chat({ messages: turnMessages, tools, stream: false });
  if (!res.message.tool_calls?.length) break;  // ツール呼び出しなくなったら終了
  apiMessages.push(res.message);
  // 各 tool_call を実行して apiMessages に結果追加
}
// 最終応答はtoolsなしでストリーミング
```

### ツールセット

| 関数名 | 引数 | 説明 |
|:--|:--|:--|
| `search_documents` | `query` | アップロードドキュメントのベクター検索 |
| `web_search` | `query` | DuckDuckGo検索+上位3件の本文取得 |
| `list_files` | なし | `public/uploads/` 一覧 |
| `read_file` | `path` | ファイル読み込み |
| `write_file` | `path`, `content` | ファイル書き込み |

### 引数の揺れ対応

LLMが `path`/`filename`/`file`/`filepath` など揺らぎで呼ぶため、フロント側で吸収:

```javascript
const fpath = fnArgs.path || fnArgs.filename || fnArgs.file || fnArgs.filepath || '';
```

### ドキュメントとサーバーファイルの優先順位

LLMが「資料を見て」「ドキュメントを参照」と言われた時にうっかり `list_files`（uploads配下）を呼ぶ問題への対処。**ツール定義のdescriptionに利用可能なドキュメント名を埋め込み**、システムプロンプトで明示的に区別する:

```javascript
tools.push({
  function: {
    name: 'search_documents',
    description: `チャットに添付されたドキュメントから関連情報を検索する。検索対象のドキュメント: ${docNames}。これらのドキュメントについての質問は必ずこのツールを使用すること。テキストで関数呼び出しを書くのではなく、必ず実際のtool_callとして呼び出すこと。`,
    ...
  }
});
```

システムプロンプトでも「【参照可能なドキュメント】(チャットに添付されたファイル)」と「【サーバーファイル操作】(uploads配下)」をはっきり分けて説明する。

### テキストツール呼び出しのフォールバック

一部の小型モデル（Qwen 1.5B / Gemma 2B等）は、Ollamaの `tool_calls` を正しく出力せず、応答テキストに `search_documents(query='...')` と書いてしまうことがある。フロント側で正規表現検出して実ツール呼び出しに変換:

```javascript
const textCallMatch = assistantMsg.content.match(
  /(search_documents|web_search|read_file|list_files|write_file)\s*\(\s*([^)]*)\)/
);
if (textCallMatch) {
  const fname = textCallMatch[1];
  const argsStr = textCallMatch[2];
  // query='...' / path='...' を抽出して fakeCall を構築
  const fakeCall = { function: { name: fname, arguments: {...} } };
  assistantMsg.tool_calls = [fakeCall];
  assistantMsg.content = '';  // テキスト応答は破棄
}
```

### 動的コンテキスト調整

ユーザー入力に「ファイル書き出し系キーワード」があるかで `num_ctx` / `num_predict` を切り替え:

- **短文モード**: smallCtx=2048, smallPredict=512（通常質問用）
- **長文モード**: mediumCtx=8192, largePredict=8192（ファイル生成時）

キーワードは `appConfig.agentContext.largeGenKeywords` で上書き可。

---

## 💾 RAG (Retrieval Augmented Generation)

### Embedding

- モデル: `config.embedModel`（デフォルト `mxbai-embed-large:latest`）
- 次元: モデル依存（mxbai=1024, nomic=768）
- サーバー送信せず、フロントで Ollama に直接 POST

### チャンク化

```javascript
function chunkText(text, size = 500, overlap = 100) {
  // 500文字ずつ、100文字オーバーラップで分割
}
```

### 類似度検索

```javascript
cosineSimilarity(a, b) = dot(a,b) / (norm(a) * norm(b))
```

ragTopK 件（デフォルト10）を取得してプロンプトに注入、またはツール結果として返却。

### モデル選択から除外

Embeddingモデルはチャット用途で使えないので、以下パターンに該当するモデルをチャット選択ドロップダウンから自動除外:

```javascript
const embedPatterns = /embed|embedding|nomic-embed|mxbai-embed|bge-|e5-|gte-/i;
const names = allNames.filter(n =>
  n.toLowerCase() !== config.embedModel.toLowerCase() && !embedPatterns.test(n)
);
```

---

## ⚡ マルチGPU・複数PCロードバランサ

### 構成

```
config.json:
  "ollamaBackends": [
    { "host": "127.0.0.1", "port": 11434, "label": "PC-0" },
    { "host": "192.168.1.101", "port": 11434, "label": "PC-1" }
  ]
```

### スコアリング

```javascript
score(backend) = averageGpuUsage(backend) + activeConnections(backend) * 30
```

最もスコアが低い（=空いている）バックエンドを選択。

### アクティブ接続数管理

```javascript
backend.activeConns++;
let connDecremented = false;
const decrementConn = () => {
  if (!connDecremented) {
    connDecremented = true;
    backend.activeConns--;
  }
};
// 複数のイベント(error/close/end)で二重減算を防ぐ
```

### GPU情報の取得

- **ローカル**: `rocm-smi` / `nvidia-smi` を子プロセス起動
- **リモート**: `gpu-agent.js` を対象PCで起動、HTTP経由で情報取得
  - 認証: `X-Agent-Token` ヘッダー
- **自動検出**: 自IPが `ollamaBackends` に含まれていたら `gpu-agent` 不要とみなす

### 統合SSE

全バックエンドのGPU情報を1秒ごとに集約し、SSEで `/sse/gpu` から配信:

```javascript
updateAllGpuData() {
  for (const backend of ollamaBackends) {
    const data = isLocal(backend) ? localGpuQuery() : fetchFromAgent(backend);
    lastKnownGpuData[backend.label] = data || lastKnownGpuData[backend.label]; // 失敗時は前回値保持
  }
  broadcastSSE(aggregated);
}
```

---

## 🔊 音声入出力

### 音声入力 (Web Speech API)

```javascript
const recognition = new SpeechRecognition();
recognition.lang = 'ja-JP';
recognition.continuous = true;       // 止めるまで認識継続
recognition.interimResults = true;   // 中間結果取得

// 3秒無音で自動送信
const resetSilenceTimer = () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    recognition.abort();
    if (hasText) sendMessageRef.current();  // 自動送信
  }, 3000);
};
```

- HTTPSまたはlocalhostでのみ動作（Secure Context必須）
- Chrome/Edge対応（Firefoxは非対応）
- 送信時に `stopRecording()` 自動呼び出し

### 音声出力 (SpeechSynthesis)

```javascript
function toggleSpeak(content, idx) {
  if (speakingIndex === idx) { cancel(); return; }
  cancel();  // 別メッセージを読み上げ中なら止める
  const text = stripMarkdownForSpeech(content);  // Markdown記号除去
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'ja-JP';
  utter.voice = findJapaneseVoice();
  speak(utter);
}
```

#### 停止トリガー
- 別メッセージの読み上げボタン押下
- 新規チャット作成
- チャット履歴切替
- ページ離脱（cleanup）

---

## 🐍 Python 実行システム

### WebSocketプロトコル

```
Client → Server:
  { type: 'run', code: '...' }           // 実行開始
  { type: 'stdin', data: '...' }         // 標準入力
  { type: 'stop' }                       // 強制終了

Server → Client:
  { type: 'stdout', data: '...' }        // 標準出力
  { type: 'stderr', data: '...' }        // エラー出力
  { type: 'image', filename: '...' }     // 画像（matplotlib等）
  { type: 'exit', exitCode: N }          // 終了
```

### 作業ディレクトリ

`public/uploads/` をcwdに設定。LLMのファイル操作ツール（read_file/write_file）と統一。

### matplotlib 自動対応 Preamble

ユーザー/LLMコードの前に以下を自動注入:

```python
import matplotlib
matplotlib.use('Agg')  # GUIバックエンド無効

# 日本語フォント自動選択
candidates = ['IPAexGothic', 'Noto Sans CJK JP', 'Hiragino Sans', ...]
matplotlib.rcParams['font.family'] = first_available(candidates)

# plt.show() → public/plots/ に保存（uploadsとは分離）
def _auto_show():
    fname = f"plot_{run_id}_{n}.png"
    full_path = os.path.join(_PLOTS_DIR, fname)  # public/plots/
    _orig_savefig(full_path)
    print(f"__OGC_IMAGE__:plots/{fname}")  # server.js が検出
    plt.close('all')

# plt.savefig('myfile.png') → ユーザー指定パス（uploads配下）はそのまま尊重
def _auto_savefig(fname, *a, **kw):
    _orig_savefig(fname, *a, **kw)
    print(f"__OGC_IMAGE__:{os.path.basename(fname)}")

plt.show = _auto_show
plt.savefig = _auto_savefig
```

**plotsとuploadsの使い分け:**
- `plt.show()` で自動生成された画像 → `public/plots/` 配下（list_filesから見えない）
- `plt.savefig('result.png')` で明示保存された画像 → `public/uploads/` 配下（LLMが認識可能）
- これによりLLMが list_files したときに大量のプロット画像が出てこない

### 画像マーカー検出

```javascript
// server.js: stdoutから __OGC_IMAGE__:filename.png を検出
const m = line.match(/^__OGC_IMAGE__:(.+)$/);
if (m) ws.send({ type: 'image', filename: m[1] });
```

クライアント側では `filename` のプレフィックスで配信パスを切り替え:
- `plots/xxx.png` → `/plots/xxx.png`（認証付き専用エンドポイント）
- `xxx.png` → `/files/xxx.png`（uploads配下）

### `/plots/*` エンドポイント

```javascript
// 認証付き、パストラバーサル対策済み
app.get('/plots/*', requireAuth, (req, res) => {
  const abs = path.resolve(PLOTS_DIR, req.params[0]);
  if (!abs.startsWith(PLOTS_DIR)) return res.status(400).json(...);
  res.setHeader('Content-Type', mimes[ext]);
  fs.createReadStream(abs).pipe(res);
});
// express.staticから /plots/ を除外する必要あり
app.use((req, res, next) => {
  if (req.path.startsWith('/plots/')) return next();
  express.static(...)(req, res, next);
});
```

### DuckDB によるSQL処理

LLMには以下の使い方を案内している:

```python
import duckdb
con = duckdb.connect()

# CSVを直接クエリ
df = con.execute("SELECT region, SUM(amount) FROM 'sales.csv' GROUP BY region").df()

# Parquetも同様
df = con.execute("SELECT * FROM 'logs.parquet' WHERE level='ERROR'").df()

# pandasのDataFrameもテーブル参照可能
con.execute("SELECT * FROM df WHERE value > 100").df()
```

pandasのread_csv→集計→matplotlibのフローよりも、数百万行のデータで明確に高速。メモリ使用量も少ない。LLMに対しては、データ量が多そうなときや複雑な集計時にDuckDBを推奨するよう案内している。

### 画像をチャットに添付するボタン

実行結果エリアの画像下に「📎 チャットに添付」ボタンを表示。

```javascript
window.attachImageToChat = async (filename) => {
  const url = filename.startsWith('plots/') ? '/' + filename : '/files/' + filename;
  const blob = await (await fetch(url)).blob();
  const dataUrl = await blobToDataUrl(blob);
  setChatImagesRef.current(prev => [...prev, { name, base64, preview: dataUrl }]);
};
```

vanilla JSのターミナルUIから React state にアクセスするため、`setChatImagesRef` で setState関数を保持。Vision対応モデル（gemma3, llava等）に画像を渡して分析させる用途。

### セキュリティ

- 実行タイムアウト: `PYTHON_TIMEOUT` (デフォルト60秒)
- SIGTERM による強制終了
- 一時ファイルは `/tmp/opengeek_<runId>.py`、終了後即削除

---

## 🌐 Web検索 (DuckDuckGo)

### エンドポイント

```
GET /web-search?q=<query>&n=5&fetch=1&bodyCount=2500
```

- `q`: クエリ
- `n`: 取得件数（デフォルト5）
- `fetch=1`: 上位3件の本文も取得
- `bodyCount`: 本文切り詰め文字数

### 処理フロー

```
1. https://html.duckduckgo.com/html/?q=<query>&kl=jp-jp にPOST
2. HTMLから .result__a / .result__snippet 等を2段階パーサーで抽出
3. 上位3件のURLを順次 web_fetch でHTML取得
4. main > article > bodyの順でメインコンテンツ抽出
5. HTMLタグ除去 → 2500文字で切り詰め
```

### なぜ`/api/*` プロキシの外に置くか

`/api/*` は Ollama用のリバースプロキシなので、express.json() 未使用。
Web検索は Ollama と無関係なので別パスにする必要がある。`/files/*` も同じ理由。

---

## 🖼️ ファイル操作 API

### `safeUploadPath(path)`

パストラバーサル対策:

```javascript
function safeUploadPath(rel) {
  // uploads/ プレフィックスの除去
  rel = rel.replace(/^uploads\//, '');
  // 正規化 + uploads配下かチェック
  const abs = path.resolve(UPLOADS_DIR, rel);
  if (!abs.startsWith(UPLOADS_DIR)) return null;
  return abs;
}
```

### バイナリ配信

拡張子で判定し、画像/PDF/動画/音声は直接配信:

```javascript
const binaryExts = {
  '.png': 'image/png', '.jpg': 'image/jpeg', ...
};
if (binaryExts[ext]) {
  res.setHeader('Content-Type', binaryExts[ext]);
  fs.createReadStream(abs).pipe(res);
}
```

テキストファイルはJSON形式で返却（従来互換）:
```json
{ "path": "hello.py", "size": 123, "content": "...", "modified": "..." }
```

---

## 📜 自動スクロール

ストリーミング中、下端に追従しつつ、ユーザーが上にスクロールしたら自動追従停止:

### 検出方法（多重化）

```javascript
// 1. wheel イベント (document level)
onWheel: if (deltaY < 0) autoScrollRef = false;

// 2. touchmove (モバイル)
onTouchMove: if (fingerGoingDown) autoScrollRef = false;

// 3. keydown (ArrowUp, PageUp, Home)
onKeyDown: autoScrollRef = false;

// 4. rAF で差分チェック（フォールバック）
if (el.scrollTop < lastProgScroll - 30) autoScrollRef = false;
```

### 自動追従再開

- 下端まで戻ったら再開
- 新しいメッセージ送信時にリセット (`autoScrollRef = true`)

### プログラムスクロールの判別

`lastProgScrollRef` に自動スクロール位置を記録し、現在位置と比較することでユーザー操作を検出。

---

## 🔒 HTTPS

### 証明書配置の検出

```javascript
const HTTPS_ENABLED = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
if (HTTPS_ENABLED) {
  server = https.createServer({ cert, key, passphrase }, app);
} else {
  server = http.createServer(app);
}
```

### パスフレーズ対応

```javascript
const passphrase = process.env.SSL_PASSPHRASE || appConfig.sslPassphrase;
if (passphrase) sslOptions.passphrase = passphrase;
```

### 自己署名証明書生成 (`generate-cert.sh`)

複数ホスト/IP対応:
```bash
./generate-cert.sh localhost 192.168.1.100 my-server.example.com
```

SAN (Subject Alternative Name) に全ホストを含めて生成。

### リバースプロキシ対応

nginx経由の場合、Node.js側はHTTPで動作。`X-Forwarded-Proto` ヘッダーでHTTPS判定:

```javascript
app.set('trust proxy', 'loopback');
const isSecure = HTTPS_ENABLED || req.headers['x-forwarded-proto'] === 'https';
```

---

## 🚀 起動と systemd

### `process.chdir(__dirname)`

systemd経由で起動するとデフォルトcwdが `/` になるため、server.js先頭で明示的に移動:

```javascript
const { WebSocketServer } = require('ws');
process.chdir(__dirname);  // cwd を server.js と同じ場所に固定
```

ただし、主要パスは既に `path.join(__dirname, ...)` で絶対パス化済み。このchdirは保険。

### systemd ユニットファイル

`opengeek-llm-chat.service` がテンプレートとして同梱。`WorkingDirectory` と `ExecStart` を環境に合わせて編集。

---

## 🔄 思考中断からの復旧 / ループ検出

### 思考ループ自動検出

ストリーミング中、思考+応答の末尾を **100文字ウィンドウ** でハッシュ化し、同じ内容が **3回以上出現** したらループとして自動検出:

```javascript
const seenChunks = new Map();
const LOOP_CHUNK_SIZE = 100;
const LOOP_THRESHOLD = 3;

// 100文字単位でカウント
const chunkText = fullText.slice(-LOOP_CHUNK_SIZE).replace(/\s+/g, ' ').trim();
const count = (seenChunks.get(chunkText) || 0) + 1;
seenChunks.set(chunkText, count);
if (count >= LOOP_THRESHOLD) {
  loopDetected = true;
  abortRef.current.abort();  // 即停止
}
```

検出時はメッセージに `loopDetected: true` フラグをセットし、UIに「⚠️ 思考ループを中断・回答を要求」ボタンを表示する。

### 「続きを生成」ボタン

Thinkingモデルが応答途中で停止・ループした場合の対策:

```javascript
function continueGeneration(idx) {
  // 履歴 + 途中までの思考/応答を assistant メッセージとして追加
  const partial = [thinking ? `<think>${thinking}</think>` : '', content].join('\n');
  const nudge = [
    { role: 'assistant', content: partial },
    { role: 'user', content: '思考が途中で止まっています。続きから応答を完成させてください。' }
  ];
  // 新規応答をストリーミングで取得し、既存メッセージに追記
}
```

### 表示条件

- メッセージが会話の最後
- かつ `thinking` があるか `content` が空
- ストリーミング中（isLoading）でない

`loopDetected: true` のメッセージでは、ボタンラベルが「⚠️ 思考ループを中断・回答を要求」に変わる。

### 確実な生成停止

通常の `AbortController.abort()` だけではOllama側のGPU生成は止まらない（HTTPストリーム切断のみ）。停止ボタン押下時は、Ollamaに `keep_alive: 0` の空リクエストを送ることで、現在ロード中のモデルをアンロードし、生成プロセスを強制停止する:

```javascript
function stopGeneration() {
  abortRef.current.abort();
  // モデルアンロード → GPU処理も即停止
  fetch('/api/generate', {
    method: 'POST',
    body: JSON.stringify({
      model: chatModel,
      prompt: '',
      keep_alive: 0,
      stream: false
    })
  });
  setIsLoading(false);
}
```

副作用として次回のリクエスト時にモデル再ロード時間が発生するが、停止意図の明確さを優先。

### ThinkingBlock の isStreaming 判定

```javascript
// 続きを生成中も「思考中」ランプを点灯させるため、
// !msg.content の条件は外している
isStreaming={isLoading && i === messages.length - 1}
```

---

## ⚙️ 主要設定一覧

| キー | 型 | デフォルト | 説明 |
|:--|:--|:--|:--|
| `appName` | string | "OpenGeekLLMChat" | 表示名 |
| `defaultModel` | string | "" | 初期モデル |
| `embedModel` | string | "mxbai-embed-large:latest" | RAG用モデル |
| `password` | string | "" | MD5/SHA-256ハッシュ |
| `pythonPath` | string | "python3" | Python実行コマンド |
| `gpuAgentToken` | string | "" | gpu-agent共有トークン |
| `ollamaBackends` | array | [{127.0.0.1:11434}] | バックエンド配列 |
| `sslPassphrase` | string | "" | 秘密鍵パスフレーズ |
| `webSearch` | bool | true | Web検索 |
| `fileAccess` | bool | true | ファイル操作 |
| `ragTopK` | number | 10 | RAG検索件数 |
| `ragMode` | string | "agentic" | agentic / always |
| `agentContext.smallCtx` | number | 2048 | ツール判断時のctx |
| `agentContext.mediumCtx` | number | 8192 | 本応答ctx |
| `agentContext.smallPredict` | number | 512 | ツール判断時のpredict |
| `agentContext.largePredict` | number | 8192 | 長文応答のpredict |
| `agentContext.judgeHistoryCount` | number | 3 | ツール判断時の履歴件数 |
| `agentContext.largeGenKeywords` | array | null | 長文モードトリガーワード |

---

## 🧪 注意事項（実装時の罠）

1. **`express.json()` をグローバル適用しない**
   Ollamaプロキシのリクエストボディが消費されてしまうため、必要なエンドポイントのみに個別適用。

2. **`/web-search`, `/files` は `/api/*` の外に置く**
   同上、プロキシミドルウェアに吸収されないように。

3. **WebSocket認証はCookieから取得**
   `ws` パッケージは `req.headers.cookie` で標準送信されたCookieを参照可能。

4. **Three.js はr128固定**
   r142以降のAPI（CapsuleGeometry等）は使わない。CDN URL `https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js`。

5. **rocm-smiキー名はROCmバージョン依存**
   `GPU use (%)`, `GPU use (Mem) %`, `GPU use (VRAM) %` 等で揺れる。柔軟にパース。

6. **セッションは再起動でリセット**
   `sessions` はメモリMap。必要ならRedis等に差し替え可能。

7. **HTTPS環境では `Set-Cookie` に `Secure` 属性必須**
   `HTTPS_ENABLED` または `X-Forwarded-Proto` で判定して自動付与。

8. **LLMの英語独白対策**
   思考モデルが "I need to..." 等の英語独り言を出す場合、システムプロンプトに「内部的な推論・メタ説明を出力するな」と明示的に指示。

9. **Python preambleで UserWarning 抑制**
   matplotlibのフォント警告は非表示に。Errorは通常通り表示される。

10. **マルチターンツール実行の無限ループ防止**
    `MAX_TOOL_TURNS = 3` で必ず終了。それ以降は最終応答フェーズへ移行。

11. **LLMにはツールだけでなくPython実行機能も明示する**
    システムプロンプトに「グラフや計算はPythonコードブロックで返せば自動実行される」と書かないと、ツールしか選択肢がないと思い込んで思考ループに陥る。