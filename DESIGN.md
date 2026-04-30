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
│  - llama-server プロセス管理 (起動/停止/再起動)          │
│  - /v1/* OpenAI互換API リバースプロキシ                 │
│  - DuckDuckGo検索 (+本文取得)                           │
│  - ファイル操作API                                      │
│  - GPU監視 SSE                                          │
└─────┬──────────┬──────────┬──────────┬─────────────────┘
      │          │          │          │
      ▼          ▼          ▼          ▼
  ┌───────┐ ┌───────┐ ┌───────┐ ┌─────────────┐
  │ chat  │ │ embed │ │Python │ │DuckDuckGo   │
  │:8080  │ │:8081  │ │subproc│ │HTTP         │
  │llama- │ │llama- │ └───────┘ └─────────────┘
  │server │ │server │
  └───────┘ └───────┘
  （子プロセスとして起動・管理）
```

---

## 📁 ファイル構成と役割

| ファイル | 役割 | 依存 |
|:--|:--|:--|
| `server.js` | メインサーバー（Express+WS、llama-server管理） | `express`, `ws` |
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
    - 軽量max_tokens (smallPredict: 512)
    - tools パラメータでllama-serverに関数一覧を渡す
    - LLMが tool_calls を返すか、直接応答するか判断
    - 注: llama.cppではctxはサーバー起動時固定なので、ctxのリクエスト時調整は不可

[2] ツール実行フェーズ (最大3ターン)
    - tool_calls があれば実行
    - 結果を messages に追加（OpenAI互換: role=tool, tool_call_id 必須）
    - 再度ツール判断へ (tool_calls がなくなるまで繰り返し)

[3] 最終応答フェーズ (ストリーミング)
    - toolsなしで /v1/chat/completions 呼び出し
    - SSEストリームで content + reasoning_content を受信
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

一部の小型モデル（Qwen 1.5B / Gemma 2B等）は、`tool_calls` を正しく出力せず、応答テキストに `search_documents(query='...')` と書いてしまうことがある。フロント側で正規表現検出して実ツール呼び出しに変換:

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

ユーザー入力に「ファイル書き出し系キーワード」があるかで `max_tokens`（OpenAI互換、Ollamaでの`num_predict`相当）を切り替え:

- **短文モード**: smallPredict=512（通常質問用、ツール判断時にも使用）
- **長文モード**: largePredict=8192（ファイル生成時）

`num_ctx`（コンテキスト長）はllama-serverの起動時に固定（`chatModels[].ctx`）されるため、リクエスト時には変えられません。

キーワードは `appConfig.agentContext.largeGenKeywords` で上書き可。

---

## 💾 RAG (Retrieval Augmented Generation)

### Embedding

- モデル: `config.embeddingModel.path`（デフォルト推奨: `mxbai-embed-large-v1`）
- 次元: モデル依存（mxbai=1024, nomic=768）
- 別ポート(`embeddingPort`、デフォルト8081)でllama-serverを起動、チャットと並列動作
- フロントから OpenAI互換 `/v1/embeddings` で取得（`/embed/v1/embeddings` プロキシ経由）

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

## 🔌 OpenAI互換 API プロキシ

llama-serverは OpenAI と同じ `/v1/chat/completions`, `/v1/embeddings` 等を提供する。OpenGeekLLMChatのフロントは認証を経由する必要があるため、Node.js側でリバースプロキシ:

```javascript
function proxyToLlama(targetHost, targetPort, pathPrefix) {
  return (req, res) => {
    const options = {
      hostname: targetHost,
      port: targetPort,
      path: pathPrefix + req.url,
      method: req.method,
      headers: { ... },
    };
    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });  // ストリームをそのまま転送
    });
    req.pipe(proxyReq, { end: true });    // bodyもストリーム転送
  };
}

app.use('/v1', requireAuth, proxyToLlama('127.0.0.1', 8080, '/v1'));
app.use('/embed/v1', requireAuth, proxyToLlama('127.0.0.1', 8081, '/v1'));
```

### Ollama → OpenAI互換 リクエスト変換

```javascript
// Before (Ollama)
fetch('/api/chat', {
  body: JSON.stringify({
    model, messages, tools, stream: true, think: false,
    options: { num_ctx, num_predict, temperature, top_k, top_p }
  })
});

// After (llama-server OpenAI互換)
fetch('/v1/chat/completions', {
  body: JSON.stringify({
    model, messages, tools, stream: true,
    stream_options: { include_usage: true },  // usage情報を流れに含める
    max_tokens: num_predict,
    temperature, top_k, top_p,
    cache_prompt: true,  // llama.cpp拡張: プロンプトキャッシュ
  })
});
```

### レスポンス形式の違い

```javascript
// Ollama (NDJSON, \n区切り)
{"message":{"content":"こんにちは"},"done":false}
{"message":{"content":"！"},"done":false}
{"done":true,"eval_count":5,"eval_duration":123456789,"prompt_eval_count":20}

// OpenAI互換 (SSE, data:プレフィックス + \n\n区切り)
data: {"choices":[{"delta":{"content":"こんにちは"}}]}

data: {"choices":[{"delta":{"content":"！"}}]}

data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":20,"completion_tokens":5}}

data: [DONE]
```

### thinking の扱い

Ollama: `delta.thinking` フィールド
OpenAI互換 (DeepSeek/QwQ系): `delta.reasoning_content` フィールド
Gemma3等: `<think>...</think>` タグでcontent内に埋め込まれる

フロント側で3パターンとも対応:

```javascript
if (delta.reasoning_content) assistantThinking += delta.reasoning_content;
if (delta.content) assistantContent += delta.content;

// <think>タグフォールバック
const thinkMatch = assistantContent.match(/^<think>([\s\S]*?)(<\/think>)?([\s\S]*)$/);
if (thinkMatch) {
  displayThinking = (assistantThinking + thinkMatch[1]).trim();
  displayContent = thinkMatch[2] ? thinkMatch[3].trim() : '';
}
```

---

## 🔧 llama-server プロセス管理

OpenGeekLLMChatは `llama-server` バイナリを **子プロセスとして起動・管理** する。Ollamaのような専用デーモンがいない構成。

### プロセス構造

```
opengeek-llm-chat (Node.js, port 3000)
  ├── llama-server (chat, port 8080) ← spawn
  └── llama-server (embedding, port 8081) ← spawn
```

両プロセスとも `spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] })` で起動。stdout/stderrはNode.js経由で共通ログに統合される。

### 起動シーケンス

```javascript
// 1. server.listen() 後、起動時に2つを並列spawn
server.listen(PORT, async () => {
  await updateGpuData();
  startEmbeddingModel().catch(e => log('-', `Embedding起動エラー: ${e.message}`));
  if (chatModels.length > 0) {
    const initialModel = appConfig.defaultModel || chatModels[0].name;
    startChatModel(initialModel).catch(e => log('-', `初期モデル起動エラー: ${e.message}`));
  }
});
```

### ready判定

llama-serverは `/health` エンドポイントを提供する。1秒間隔でポーリングして `200 OK` が返ったらreadyとみなす:

```javascript
function waitForReady(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request({ hostname: host, port, path: '/health' }, (res) => {
        if (res.statusCode === 200) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.end();
    };
    check();
  });
}
```

### モデル切替

`POST /models/load { name }` → 現在のチャットプロセスをkill → 新モデルでspawn → readyを待つ:

```javascript
async function startChatModel(modelName) {
  if (chatProcStarting) throw new Error('既にモデル起動処理中です');
  chatProcStarting = true;
  try {
    await stopChatModel();  // SIGTERM → 5秒タイムアウトでSIGKILL
    chatProc = spawnLlamaServer(args, `chat:${model.name}`);
    chatProcModel = model.name;
    const ready = await waitForReady(host, port, readyTimeoutMs);
    if (!ready) {
      await stopChatModel();
      throw new Error(`チャットモデル起動タイムアウト`);
    }
  } finally {
    chatProcStarting = false;
  }
}
```

### 引数フィルタリング

`commonArgs` に `--port` や `--host` がユーザー設定で含まれていても、llama-serverに渡す前に**ペアごと除外**する:

```javascript
const filterPairArgs = (args, exclude) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (exclude.includes(args[i])) {
      i++; // 値もスキップ
      continue;
    }
    out.push(args[i]);
  }
  return out;
};

// 使用例
const args = [
  '--port', String(ls.chatPort),
  '--host', ls.chatHost,
  ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
];
```

理由: `args.filter(a => a !== '--port')` だと `--port` だけ消えて値だけが孤立し、`error: invalid argument: 8080` になる。

### クリーンアップ

```javascript
function cleanup() {
  if (chatProc) try { chatProc.kill('SIGTERM'); } catch {}
  if (embedProc) try { embedProc.kill('SIGTERM'); } catch {}
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);
```

systemd経由で `systemctl stop` した時もクリーンに終了する。

### モデル管理API

| Method | Path | 説明 |
|:--|:--|:--|
| GET | /models | `{ models: [{name, ctx, ngl, loaded}, ...], current, starting, embeddingReady, autoUnloaded, idleUnloadMs }` |
| POST | /models/load | `{ name }` で指定モデルをロード（再起動）。自動アンロード状態をクリア |
| POST | /models/unload | 現在のチャットモデルをアンロード（停止） |

UIはモデル選択ドロップダウン変更時に `/models` で current を確認し、変更が必要なときだけ `/models/load` を呼ぶ。各モデル名の横に `(8,192)` 形式でctxを併記表示。

### オンデマンドモデルロード（起動時はロードしない）

サーバー起動時にはチャットモデル/Embeddingモデルをロードしない設計。VRAM空き状態で起動し、初回リクエスト時に自動ロード。

```javascript
// server.js 起動時
if (chatModels.length > 0) {
  let initialModel = null;
  // settings.json から前回モデル取得
  if (fs.existsSync(SETTINGS_FILE)) {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    if (settings.chatModel && findModelByName(settings.chatModel)) {
      initialModel = settings.chatModel;
    }
  }
  if (!initialModel) initialModel = appConfig.defaultModel || chatModels[0].name;
  // 起動はせず、autoUnloaded として記録 → 初回リクエスト時に自動ロード
  chatProcAutoUnloaded = initialModel;
  log('-', `初期モデル: ${initialModel}（最初のリクエスト時にロード）`);
}
log('-', 'Embeddingモデル: 最初のリクエスト時にロード');
```

優先順位: settings.json (`chatModel`) → config.json (`defaultModel`) → `chatModels[0]`

`/models` レスポンスに `firstLoadPending: true` を追加し、フロントで「初回ロード待ち」と「アイドル復帰」を区別。

### モデル自動アンロード（idleUnloadMs）

`llamaServer.idleUnloadMs > 0` の場合、最終使用時刻から指定ms経過したチャットモデル/Embeddingモデルを自動的にアンロード（VRAM解放）。次回リクエスト時に自動再ロード。

```javascript
// 30秒間隔でチェック
setInterval(async () => {
  const ls = appConfig.llamaServer;
  if (!ls.idleUnloadMs || ls.idleUnloadMs <= 0) return;
  // チャットモデル
  if (chatProc && !chatProcStarting && chatLastUsed) {
    const idleMs = Date.now() - chatLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      chatProcAutoUnloaded = chatProcModel;
      await stopChatModel();
    }
  }
  // Embeddingモデル（同じidleUnloadMs使用）
  if (embedProc && !embedProcStarting && embedLastUsed) {
    const idleMs = Date.now() - embedLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      await stopEmbeddingModel();
    }
  }
}, 30000);
```

### アイドル復帰の自動継続（フロント側）

アイドルアンロード状態でユーザーがチャット送信した場合、フロント側でロード完了をポーリング待機してから送信処理を続行:

```javascript
// sendMessage() 内、送信直前
const mres = await fetch('/models');
const mdata = await mres.json();
if (!mdata.current || mdata.starting || mdata.autoUnloaded) {
  // ダミーpingで再ロード開始トリガー
  if (mdata.autoUnloaded) {
    fetch('/v1/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: chatModel, messages: [{role:'user',content:'ping'}], max_tokens: 1, stream: false })
    }).catch(() => {});
  }
  // 最大2分まで2秒間隔でポーリング待機
  const startWait = Date.now();
  while (Date.now() - startWait < 120000) {
    await new Promise(r => setTimeout(r, 2000));
    const pres = await fetch('/models');
    const pdata = await pres.json();
    if (pdata.current && !pdata.starting && !pdata.autoUnloaded) break;
  }
  // ロード完了後、そのまま送信処理を続行
}
```

ユーザーは送信ボタンを再度押す必要なし（自動的に処理が続く）。

### Embeddingプロキシのアイドル復帰

`/embed/v1/*` プロキシでもEmbedding未起動を検知して自動ロードを待機:

```javascript
// proxyToLlama() 内
if (!isChatProxy) {
  // Embeddingプロキシ
  if (!embedProc) {
    const ready = await ensureEmbeddingLoaded();  // 起動完了まで待機
    if (!ready) return res.status(503).json({...});
  }
  embedLastUsed = Date.now();
}
```

ドキュメントD&D時、Embedding未起動なら数秒待機してから処理。

### 生成中のモデル切替防止

生成中（`isLoading === true`）はUI側でモデル選択ドロップダウンを `disabled={isLoading}` にし、🔒アイコンとツールチップを表示。useEffectの依存配列にも `isLoading` を含め、生成中のロード処理発火を防ぐ:

```javascript
useEffect(() => {
  if (!settingsLoadedRef.current) return;
  if (!chatModel) return;
  if (isLoading) return;  // 生成中はモデル切替しない
  // ...
}, [chatModel, isLoading]);
```

生成中に切替を試みても、UIで物理的にブロックされる + ロジックでも二重ガード。

### モデル状態のUI表示

フロント側のモデル状態管理:

| state | 意味 | UI |
|:--|:--|:--|
| `modelReady = true` | チャット可能 | 通常 |
| `modelStarting = true` | 実際にllama-server起動処理中 | 🟠トースト「再ロード中」 |
| `autoUnloadedName != null && !modelStarting` | アイドルアンロード状態（次回送信時にロード） | トースト無し、送信ボタン有効 |
| `firstLoadPending = true` | 起動後初回ロード待ち | トースト無し、送信ボタン有効 |

ポーリングは2系統:
- 高頻度(3秒): 接続不良 or `modelStarting=true` のとき
- 低頻度(15秒): 通常時の状態変化検出

---

## 🔇 ログレベル制御 (logLevel)

config.jsonの `logLevel` で運用ログを抑制:

| 設定 | spawn時のstdio | プロキシログ |
|:--|:--|:--|
| `"normal"` | `['ignore', 'pipe', 'pipe']` で全ログを表示 | 各リクエストで2行（in/out）出力 |
| `"quiet"` | `['ignore', 'ignore', 'ignore']` で完全破棄 | 抑制（503や502/504エラーのみ表示） |

```javascript
function spawnLlamaServer(args, label) {
  const isQuiet = appConfig.logLevel === 'quiet';
  const proc = spawn(ls.binPath, args, {
    stdio: isQuiet ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
  });
  if (!isQuiet) {
    proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  }
  // exit ログだけは常に出す
  proc.on('exit', (code) => log('-', `[${label}] exited with code ${code}`));
}
```

quietモードで残るログ:
- 起動バナー（ASCII art）
- `[label] spawn: ...`（コマンド確認用）
- プロセス終了通知
- 認証成功/失敗、Web検索、Python実行
- 502/503/504/タイムアウトなどのエラー

本番運用では `"quiet"` 推奨。デバッグ時は `"normal"` に戻して再起動。

---

## ⚡ マルチGPU構成（テンソル並列）

### llama.cpp の GPU割当

llama.cppはビルド時にCUDA / ROCm / Metal / Vulkanのバックエンドを選択し、起動時の `--device` オプションで使用するGPUを指定します。

```
config.json:
  "llamaServer": {
    "commonArgs": ["-fa", "on", "--device", "ROCm0,ROCm1"]
  }
```

### モデルとGPUの紐付け

- **`commonArgs`**: 全モデル共通（GPU指定、Flash Attention、量子化キャッシュ等）
- **`chatModels[].extraArgs`**: モデル毎に追加（大型モデルだけ複数GPU分散など）
- **`embeddingModel.extraArgs`**: 軽量Embeddingは1枚で十分

### モデル切替

`POST /models/load { name }` で別モデルに切替。サーバー側で:

1. 現在のチャットllama-serverプロセスをkill (`SIGTERM`)
2. 5秒待っても終了しなければ `SIGKILL`
3. 新しいモデルで再spawn
4. `/health` を1秒ポーリングして `ready` 待ち（最大120秒）
5. 完了後、フロントにレスポンス

切替中は `/v1/*` プロキシが502を返すため、フロントは10〜30秒待機UIを表示する。

### GPU監視

- `rocm-smi --json` または `nvidia-smi --query-gpu=...` を1秒間隔で実行
- 結果をキャッシュし、`/sse/gpu` で全クライアントにSSE配信
- 取得失敗時は前回キャッシュを保持してUIをちらつかせない

```javascript
let cachedGpuData = [];
async function updateGpuData() {
  if (gpuUpdating) return;
  gpuUpdating = true;
  try { cachedGpuData = await queryGpu(); } finally { gpuUpdating = false; }
}
setInterval(updateGpuData, GPU_INTERVAL);
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

### なぜ`/v1/*` プロキシの外に置くか

`/v1/*` は llama-server用のリバースプロキシで、リクエストボディを `req.pipe(proxyReq)` でストリーム転送する都合上 `express.json()` 未使用。Web検索やファイル操作はllama-serverと無関係なので別パスにする必要がある。

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

### 生成停止

llama-serverは Ollamaの `keep_alive` のような概念を持たないが、HTTPストリーム切断で確実に生成を中断できる:

```javascript
function stopGeneration() {
  abortRef.current.abort();  // HTTPストリーム切断
  // llama-serverはストリーム切断を検知し、生成中のスロットを解放する
  setIsLoading(false);
}
```

llama-serverは内部的にスロット (`n_parallel`) で並列推論を管理しており、HTTP切断でそのスロットがアイドル状態に戻る。GPU使用率は次のサンプリングで反映され、即座にゼロ近くまで下がる。Ollama版のような「モデル再ロード時間」は発生しない。

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
| `defaultModel` | string | "" | 初期モデル名（chatModelsの`name`） |
| `password` | string | "" | MD5/SHA-256ハッシュ |
| `pythonPath` | string | "python3" | Python実行コマンド |
| `sslPassphrase` | string | "" | 秘密鍵パスフレーズ |
| `llamaServer.binPath` | string | "/usr/local/bin/llama-server" | llama-serverバイナリのパス |
| `llamaServer.chatPort` | number | 8080 | チャット推論用ポート |
| `llamaServer.embeddingPort` | number | 8081 | Embedding用ポート |
| `llamaServer.commonArgs` | array | ["-fa", "on"] | 全モデル共通の起動引数 |
| `llamaServer.readyTimeoutMs` | number | 120000 | 起動完了待ち上限 |
| `chatModels[]` | array | [] | チャットモデル一覧（必須） |
| `chatModels[].name` | string | - | UIに表示する名前 |
| `chatModels[].path` | string | - | GGUFファイルパス |
| `chatModels[].ctx` | number | 4096 | コンテキスト長（起動時固定） |
| `chatModels[].ngl` | number | 99 | GPUレイヤー数 |
| `chatModels[].extraArgs` | array | [] | このモデル専用追加引数（`--mmproj`によるVision等） |
| `embeddingModel.path` | string | - | Embedding用GGUF（任意） |
| `embeddingModel.poolingType` | string | - | mean/cls/last/none |
| `embeddingModel.extraArgs` | array | [] | Embedding用追加引数（GPU指定など） |
| `webSearch` | bool | true | Web検索 |
| `fileAccess` | bool | true | ファイル操作 |
| `ragTopK` | number | 10 | RAG検索件数 |
| `ragMode` | string | "agentic" | agentic / always |
| `agentContext.smallPredict` | number | 512 | ツール判断時のmax_tokens（短文モード） |
| `agentContext.largePredict` | number | 8192 | ツール判断時のmax_tokens（長文モード）+ continueGen時 |
| `agentContext.judgeHistoryCount` | number | 3 | ツール判断時の履歴件数 |
| `agentContext.largeGenKeywords` | array | null | 長文モードトリガーワード（null=デフォルト使用） |
| `logLevel` | string | "normal" | "normal"/"quiet"。quietでllama-server stdout/stderrとプロキシログを抑制 |
| `llamaServer.idleUnloadMs` | number | 0 | アイドル時の自動アンロード時間（ms、0で無効、推奨600000=10分） |
| `systemPrompts.base` | string | (デフォルトプロンプト) | ベース指示文（{date}展開） |
| `systemPrompts.documents` | string | (同上) | ドキュメント添付時追記（{docList}展開） |
| `systemPrompts.webSearch` | string | (同上) | Web検索案内 |
| `systemPrompts.fileAccess` | string | (同上) | サーバーファイル操作案内 |
| `systemPrompts.python` | string | (同上) | Python実行案内 |
| `systemPrompts.meta` | string | (同上) | メタ抑制指示 |
| `systemPrompts.judge` | string | (同上) | ツール判断用プロンプト（{toolList}展開） |

---

## 🎨 システムプロンプトのカスタマイズ

`config.json` の `systemPrompts` で全プロンプトを上書き可能。`loadConfig()` で **深いマージ** されるため、`systemPrompts` 内の特定キーだけを上書きしたい場合も部分的に書ける:

```javascript
function loadConfig() {
  const merged = { ...DEFAULT_CONFIG, ...userConfig };
  ['systemPrompts', 'agentContext', 'transcribe'].forEach(key => {
    if (DEFAULT_CONFIG[key] && typeof DEFAULT_CONFIG[key] === 'object') {
      merged[key] = { ...DEFAULT_CONFIG[key], ...(userConfig[key] || {}) };
    }
  });
  return merged;
}
```

### テンプレート変数

フロント側で `fillTemplate(str, vars)` を使って展開する `{varname}` 形式の変数:

| 変数 | 展開タイミング | 値 |
|:--|:--|:--|
| `{date}` | `base` プロンプト | "2026年4月25日" 形式 |
| `{docList}` | `documents` プロンプト | "file1.csv, file2.pdf" |
| `{toolList}` | `judge` プロンプト | 動的生成された箇条書きのツール一覧 |

### 組み立てロジック（フロント側）

```javascript
const sp = appConfig.systemPrompts || {};
const fillTemplate = (str, vars) =>
  (str || '').replace(/\{(\w+)\}/g, (_, k) => vars[k] != null ? vars[k] : '');

let agentSystem = fillTemplate(sp.base, { date: dateStr });
if (documents.length > 0 && sp.documents) {
  agentSystem += '\n\n' + fillTemplate(sp.documents, { docList });
}
if (appConfig.webSearch && sp.webSearch) agentSystem += '\n\n' + sp.webSearch;
if (appConfig.fileAccess && sp.fileAccess) agentSystem += '\n\n' + sp.fileAccess;
if (sp.python) agentSystem += '\n\n' + sp.python;
if (sp.meta) agentSystem += '\n\n' + sp.meta;
```

ドキュメントなし、Web検索OFF、ファイルアクセスOFFのときは、対応する追記がスキップされる。

### `judge` プロンプトの `{toolList}` 動的構築

```javascript
const toolListLines = [];
if (documents.length > 0) toolListLines.push('- search_documents: ...');
if (appConfig.webSearch) toolListLines.push('- web_search: ...');
if (appConfig.fileAccess) toolListLines.push('- list_files/read_file/write_file: ...');
const judgeSystem = fillTemplate(sp.judge, { toolList: toolListLines.join('\n') });
```

これにより、無効化された機能のツール案内を出さない（LLMが存在しないツールを呼ばないように）。

---

## 📐 履歴の重み付け（直近優先）

長い会話で「最新質問に集中させる」ためのプロンプト整形:

```
[system] あなたは親切なアシスタント...                  ← ベースsystem
[system] 【参考: 過去の会話履歴 (4件)】                  ← 古いメッセージは
        以下は背景情報です。最新の質問への回答に           圧縮要約として
        直接関連する場合のみ参照してください。              system扱い
        [ユーザー] こんにちは
        [アシスタント] こんにちは...
[user] CSVを処理したい                                   ← 直近6件は
[assistant] DuckDB を使うと...                            そのまま
[user] グラフにできる?
[assistant] matplotlibで...
[user] 【今この質問に回答してください】                   ← 最新質問は
       seabornでもできますか?                              強調マーカー
```

### 構築ロジック

```javascript
const RECENT_COUNT = appConfig.recentMessageCount || 6;
const recentSlice = allMessages.slice(-20);
const splitIdx = Math.max(0, recentSlice.length - RECENT_COUNT);
const oldMessages = recentSlice.slice(0, splitIdx);
const recentMessages = recentSlice.slice(splitIdx);

if (oldMessages.length > 0) {
  // 各500文字に圧縮、システムロールで「参考情報」として包む
  const summary = oldMessages.map(m => `[${role}] ${m.content.slice(0, 500)}`).join('\n\n');
  history.push({ role: 'system', content: `【参考: 過去の会話履歴】\n${summary}` });
}

recentMessages.forEach((m, i) => {
  const isLast = i === recentMessages.length - 1;
  const h = { role: m.role, content: m.content };
  if (isLast && m.role === 'user') {
    h.content = `【今この質問に回答してください】\n${m.content}`;
  }
  history.push(h);
});
```

### 効果

| 項目 | 効果 |
|:--|:--|
| 古い会話の引きずり防止 | 「参考情報」と明示することでLLMの注意度を下げる |
| 最新質問への集中 | マーカー追加で確実にフォーカス誘導 |
| コンテキスト圧迫軽減 | 古いメッセージは500文字に圧縮 |

`config.recentMessageCount` で調整可能（3〜20、デフォルト6）。

---

## 🌐 Web検索ON/OFFトグル

### 状態管理

`webSearchEnabled` Reactステートで管理。初期値は `appConfig.webSearch` を反映:

```javascript
const [webSearchEnabled, setWebSearchEnabled] = useState(true);

useEffect(() => {
  // /config 取得後、デフォルト値を反映
  setWebSearchEnabled(cfg.webSearch !== false);
}, []);
```

### 判定の二段構え

```javascript
const webSearchActive = appConfig.webSearch !== false && webSearchEnabled;
```

- `appConfig.webSearch === false` → トグル自体が表示されない（管理者が完全無効化）
- `appConfig.webSearch === true` + トグルON → 利用可能
- `appConfig.webSearch === true` + トグルOFF → 一時無効

### UI

`.toolbar-btn.web-search-toggle.active` でアクセントカラー強調、非active時は不透明度0.4。

---

## 🎯 ドラッグ&ドロップ統合

3つのドロップゾーンが用途で振り分け:

| ゾーン | クラス | ハンドラ | 動作 |
|:--|:--|:--|:--|
| ドキュメントリスト（左） | `.docs-list.drag-active` | `handleDrop` | 全ファイルをRAG用ドキュメントに取り込み |
| チャット入力欄 | `.input-area.drag-active` | `handleChatDrop` | 画像→Vision添付、その他→ドキュメント |
| サーバーファイル（右） | `.files-panel-body.drag-active` | `handleServerDrop` | 全ファイルを `public/uploads/` にアップロード |

### handleChatDrop の振り分けロジック

```javascript
async function handleChatDrop(e) {
  const files = Array.from(e.dataTransfer.files);
  const images = files.filter(f => f.type.startsWith('image/'));
  const others = files.filter(f => !f.type.startsWith('image/'));

  // 画像 → チャット添付（base64化）
  for (const file of images) {
    const dataUrl = await readAsDataURL(file);
    const base64 = dataUrl.split(',')[1];
    setChatImages(prev => [...prev, { name, base64, preview: dataUrl }]);
  }

  // その他 → RAG用ドキュメント
  if (others.length > 0) handleFiles(others);
}
```

### dragLeave の誤発火防止

```javascript
onDragLeave={e => {
  // 子要素に入ったときのdragLeaveは無視
  if (e.currentTarget.contains(e.relatedTarget)) return;
  setDragActive(false);
}}
```

子要素を跨ぐとイベントが発火するため、`relatedTarget` で判定。

---

## 📦 バイナリファイルのアップロード/ダウンロード

### 問題

旧実装は `file.text()` でUTF-8テキストとして読み込んで JSON送信していたため、PNG等のバイナリが破損（先頭バイト `\x89` が `\xef\xbf\xbd` U+FFFDに置換される）。

### 解決: クライアント側

拡張子・MIMEタイプで分岐し、バイナリは FormData送信:

```javascript
const binaryExts = ['png', 'jpg', 'pdf', 'zip', ...];
const isBinary = binaryExts.includes(ext) || !file.type.startsWith('text/');

if (isBinary) {
  const fd = new FormData();
  fd.append('file', file);
  await fetch(`/files/${name}`, { method: 'POST', body: fd });
} else {
  const text = await file.text();
  await fetch(`/files/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
}
```

### 解決: サーバー側

依存追加なしの最小multipartパーサー:

```javascript
function parseMultipart(req) {
  // boundaryをContent-Typeから抽出
  // \r\n\r\n でヘッダーとファイル本体を分離
  // \r\n--boundary で末尾を切る
  // → fileBuf を返す
}

app.post('/files/*', requireAuth, async (req, res) => {
  if (req.headers['content-type'].startsWith('multipart/form-data')) {
    const fileBuf = await parseMultipart(req);
    fs.writeFileSync(abs, fileBuf);  // バイナリ書き込み
  } else {
    jsonParser(req, res, () => {
      fs.writeFileSync(abs, content, 'utf-8');  // テキスト書き込み
    });
  }
});
```

### ダウンロード側もContent-Type分岐

```javascript
const ct = res.headers.get('Content-Type');
let blob;
if (ct.startsWith('application/json')) {
  // テキスト: { content: "..." } をパース
  const data = await res.json();
  blob = new Blob([data.content], { type: 'text/plain' });
} else {
  // バイナリ: そのまま blob で取得
  blob = await res.blob();
}
```

---

## 📱 モバイル対応

### 100dvh + safe-area

`100vh` はモバイルブラウザのアドレスバー込みの高さで、下部が見切れる。`100dvh`（dynamic viewport height）に変更:

```css
body, .app-layout, .chat-area {
  height: 100vh;     /* フォールバック */
  height: 100dvh;    /* 動的高さ */
}

.input-area {
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 12px);
}
```

`<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">` でセーフエリア対応。

### 2行ヘッダー（≤768px）

```css
@media (max-width: 768px) {
  .chat-header {
    flex-direction: column;       /* 縦に並べる */
    align-items: stretch;
  }
  .chat-header-left {
    width: 100%;                  /* 上段: メニュー+ステータス+タイトル */
  }
  .chat-header-right {
    width: 100%;
    justify-content: flex-end;     /* 下段: アクションボタンを右寄せ */
    flex-wrap: wrap;
  }
}
```

### iOS自動ズーム抑制

```css
.input-box {
  font-size: 16px;  /* 16px未満だとフォーカス時に自動ズームする */
}
```

### サイドバー: ドロワー化

```css
.sidebar {
  position: fixed;
  transform: translateX(-100%);
  transition: transform 0.3s;
}
.sidebar.open {
  transform: translateX(0);
}
```

---

## 🧪 注意事項（実装時の罠）

1. **`express.json()` をグローバル適用しない**
   `/v1/*` プロキシのリクエストボディが消費されてしまうため、必要なエンドポイントのみに個別適用。`jsonParser` を定義してから後続のミドルウェアより先に呼ぶこと（`const jsonParser` の TDZ エラーに注意）。

2. **`/web-search`, `/files` は `/v1/*` の外に置く**
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

12. **`file.text()` でバイナリを読まない**
    UTF-8として解釈不能なバイト（PNGの `\x89` 等）が U+FFFD（`\xef\xbf\xbd`）に置換され、ファイルが破損する。バイナリは必ず FormData / Blob 経由で扱う。

13. **`100vh` はモバイルで見切れる**
    アドレスバーの分が含まれて画面下が隠れるため、`100dvh` を使用。フォールバックで `100vh` も併記する。

14. **dragLeave は子要素遷移でも発火する**
    `e.currentTarget.contains(e.relatedTarget)` で子に入った場合を除外しないと、ドラッグ中にドロップゾーンのハイライトがチカチカする。

15. **`/files/*` の content-type 競合**
    multipart と JSON の両方を受けるため、`jsonParser` をミドルウェア配列ではなくハンドラ内で条件付きで呼ぶ必要がある。

16. **llama-server のモデル切替には数十秒かかる**
    `POST /models/load` 実行中はチャット推論ができない。フロントは `/models` で `current` を確認し、変更時のみリスタートを要求する（同じモデルなら何もしない）。

17. **`num_ctx` (コンテキスト長) はリクエスト時に変えられない**
    llama-server は起動時の `-c` で固定。動的に変えるには `chatModels[].ctx` を変えてサーバー再起動。

18. **OpenAI互換: `tool_calls.arguments` はJSON文字列**
    Ollamaは object で返すが、OpenAI互換 API（llama-server）は **stringified JSON**。フロント側で `JSON.parse` する必要がある。

19. **OpenAI互換: tool結果メッセージに `tool_call_id` が必須**
    `{ role: 'tool', content }` だけでは不可。`{ role: 'tool', tool_call_id: tc.id, content }` の形式で送る。

20. **AMD iGPU (gfx1036等) はLLM推論には使えない**
    メモリ計算でオーバーフローバグが発生し、ウォームアップ中にクラッシュする。`--device ROCm0,ROCm1` のように明示的に dGPU だけ指定する。

21. **トークン速度は実時間ベースで計算**
    Ollamaは `eval_duration` (nanoseconds) を返すが、llama-server (OpenAI互換) は `usage.completion_tokens` のみ。フロント側で `firstTokenTime` から `Date.now()` までの実測値で `tok/s` を計算する。

22. **llama-server ストリームは SSE 形式**
    Ollama: NDJSON（`\n` 区切り）、llama-server: SSE（`data: ...\n\n` 区切り）。バッファ管理して `\n\n` で分割し、`data: ` プレフィックスを剥がして JSON パースする。

23. **config.json で同じキーを2回定義すると後者で上書きされる**
    JSON仕様では同名キーが重複すると後者で上書きされ、エラーにならない。`chatModels` や `embeddingModel` を誤って2回書くと前者の `extraArgs` が消えて事故が発生する。`python3 -m json.tool` で確認できないため、目視か別ツールでチェック。

24. **mmproj未配置でVisionモデルが503**
    `chatModels[].extraArgs` に `--mmproj <path>` を指定したが、ファイルが存在しないと llama-server がspawn直後に死ぬ。`exit code null` が出ているか確認し、必ずモデル本体と一緒にmmprojもダウンロードする（unsloth版・bartowski版で名前が違うので注意）。

25. **生成中のモデル切替は二重ガードが必要**
    フロントの useEffect だけで防ぐと、ユーザーがドロップダウンを変更した瞬間に即座にロードリクエストが飛ぶ。`disabled={isLoading}` でUIを物理ブロックしつつ、`if (isLoading) return` でロジックも二重チェック。useEffect 依存配列にも `isLoading` を含める。

26. **idleUnloadMs の自動再ロードは「同じモデル」判定に注意**
    アイドルでアンロード→再リクエストで自動再ロード中、フロントの `chatModel` 変更useEffectは「同じモデルが消えた」と判定して `/models/load` を呼びたくなる。`/models` レスポンスに `autoUnloaded` フィールドを含め、フロント側で `sdata.autoUnloaded === chatModel` なら手を出さない（自動再ロード任せ）ロジックが必要。

27. **コンテキストサイズUIは混乱の元**
    Ollama時代は `num_ctx` をリクエスト毎に変えられたが、llama.cppでは起動時固定。ユーザーが選べるUIにすると「変えても動作が変わらない」と誤解される。`chatModels[].ctx` を読み取り専用で表示するか、モデル名横に `(8,192)` 形式で併記するのが親切。

28. **`autoUnloaded` ≠ `starting` で扱う**
    `chatProcAutoUnloaded` は「次回ロード予定のモデル名」を記録するだけで、実際のロードは始まっていない。フロントの `setModelStarting(!!data.starting || !!data.autoUnloaded)` のように両方TRUEにすると、ブラウザを開きっぱなしの間ずっと「再ロード中」トーストが表示されてしまう。`modelStarting` は `data.starting` のみ、`autoUnloadedName` は別state で管理する。

29. **Embeddingプロキシは async 化必須**
    Embeddingアイドルアンロード対応のため、`/embed/v1/*` プロキシで `await ensureEmbeddingLoaded()` する必要がある。`proxyToLlama()` を `return async (req, res) => {...}` 形式にすること。チャットプロキシ側は同期で503返却するので非同期化不要だが、Embeddingは数秒待ってでも処理を続けるべきなので非同期。

30. **Gemma系の独自トークン形式を吸収**
    Gemma3/4 はOpenAI互換のtool_callsではなく `<|tool_call|>call:web_search{query:<|"|>...<|"|>}<tool_call|>` のような独自形式でツール呼び出しを出力することがある。さらに非対称トークン（`<|tool_call>`, `<tool_call|>`, `<tool_call>` など）も混在する。正規表現は `<\|?tool_call\|?>` のように `|` を任意にして両方マッチさせる。

31. **Qwen3系の thinking モードでツール判断が遅延**
    Qwen3.6 などのthinking機能は `<think>...</think>` 内で推論する。ツール判断時にこれが入ると `max_tokens=512` で時間切れになり tool_calls が返らない。`chat_template_kwargs: { enable_thinking: false }` を渡してツール判断時のみthinking無効化する。最終応答時はそのまま使う。

32. **`<think>` タグが閉じないまま終わるケース**
    Qwen3系で `max_tokens` 切れにより `<think>...</think>` の閉じタグが出ない場合、フロント側で「全文がthinking、本文が空」と解釈されて表示が止まる。ストリーミング完了後の救済処理として、`!content && thinking` ならthinking内容を本文に昇格させる。

33. **Embedding処理中の並行リクエストでサーバー詰まり**
    ドキュメントD&D中はチャンクごとに大量の `/embed/v1/embeddings` が発生する。同時にチャット送信されるとllama-server側で詰まることがある。フロント側で `embeddingJobs.length > 0` の間は送信ボタンを無効化し、並行リクエストを防ぐ。

34. **`fakeFileList` でiteratorエラー**
    プレーンオブジェクト `{0: file, 1: file, length: 2}` を `for...of` で回すとTypeError。FileListはイテレーブルだが擬似オブジェクトには `[Symbol.iterator]` がない。`Array.from(files)` で配列化してから for...of するか、最初から配列を直接渡す。
