const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { WebSocketServer } = require('ws');

// systemd等で起動された際、カレントディレクトリをserver.jsと同じに固定する
// これにより相対パスでアクセスされるリソース(モデルキャッシュ等)も安定動作する
process.chdir(__dirname);

// ─── 設定 ───
const PORT = process.env.PORT || 3000;
const PYTHON_TIMEOUT = parseInt(process.env.PYTHON_TIMEOUT) || 60000;

// ─── アプリ設定 (config.json) ───
const CONFIG_FILE = path.join(__dirname, 'config.json');
const DEFAULT_CONFIG = {
  appName: 'OpenGeekLLMChat',
  logoMain: 'OpenGeek',
  logoSub: 'LLM Chat',
  welcomeMessage: 'ドキュメントをアップロードしてRAGベースの質問応答を行うか、自由にチャットを開始できます。',
  welcomeHints: ['ドキュメントを要約して', 'この資料の要点は？', '〇〇について教えて'],
  accentColor: '#34d399',
  defaultModel: '',  // chatModelsのname。空なら一覧の先頭
  password: '',
  pythonPath: 'python3',
  transcribe: {
    enabled: false,
    host: '127.0.0.1',
    port: 11500,
  },
  // ─── llama.cpp 設定 ───
  llamaServer: {
    binPath: '/usr/local/bin/llama-server',  // llama-server バイナリのパス
    chatHost: '127.0.0.1',
    chatPort: 8080,
    embeddingHost: '127.0.0.1',
    embeddingPort: 8081,
    // 起動時の追加共通引数（GPU offload等、chatModelsのextraArgsで上書き可）
    commonArgs: ['--host', '127.0.0.1', '-fa', 'on'],
    // 起動から ready 判定までのタイムアウト(ms)
    readyTimeoutMs: 120000,
    // モデルアンロードまでのアイドル時間(ms)、0で無効。※将来用、現在未使用
    idleUnloadMs: 0,
  },
  // チャット用モデル一覧
  chatModels: [
    // {
    //   name: 'Gemma3 12B',
    //   path: '/models/gemma-3-12b-it-Q4_K_M.gguf',
    //   ctx: 8192,
    //   ngl: 99,
    //   chatTemplate: '',  // 空ならGGUFのメタデータ使用
    //   extraArgs: []
    // }
  ],
  // RAG用Embeddingモデル（別ポートで起動）
  embeddingModel: {
    // path: '/models/mxbai-embed-large-v1-f16.gguf',
    // ctx: 512,
    // ngl: 99,
    // poolingType: 'mean'  // mean, cls, last, none
  },
  webSearch: true,
  fileAccess: true,
  imageGen: false,           // 画像生成（stable-diffusion.cpp連携）。imageModels[]を定義して有効化
  ragTopK: 10,
  ragMode: 'agentic',
  systemPrompts: {
    base: 'あなたは親切で知識豊富なAIアシスタントです。日本語で簡潔に回答してください。今日の日付は{date}です。\n\n重要な指示:\n- 思考は手短に済ませ、ユーザーへの回答を必ず出力してください。\n- ツールから取得した情報は信頼し、そのまま使ってください（妥当性を過度に疑わないこと）。\n- 日付に関する自己矛盾を感じても、与えられた{date}を真として処理してください。過去の学習データとの整合性を気にする必要はありません。\n- 天気・ニュース・株価など現在情報は、ツールの結果をそのまま引用してください。',
    documents: '【参照可能なドキュメント】(チャットに添付されたファイル): {docList}\nユーザーの質問が「ドキュメントについて」「資料を見て」「添付ファイル」などを示唆する場合、必ず最初に search_documents ツールを使ってください。\nこれらは添付ドキュメントであり、サーバーファイル（uploads配下）とは別物です。',
    webSearch: '最新の情報や知らないことについては web_search ツールでインターネット検索できます。',
    fileAccess: '【サーバーファイル操作】(uploads配下、ドキュメントとは別物)\n- list_files: uploadsフォルダの一覧を取得\n- read_file(path): uploadsフォルダのファイル読み込み\n- write_file(path, content): uploadsフォルダにファイル書き込み\n重要: pathには"uploads/"プレフィックスを付けずにファイル名のみを指定してください（例: "hello.py"、"data/config.json"）。\nユーザーが明確に「サーバーファイル」「uploadsフォルダ」「ファイルを保存して」など、サーバー側のファイルシステム操作を依頼した場合のみ使用してください。\nチャットに添付されたドキュメントについての質問では list_files/read_file/write_file は使わず、search_documents を使ってください。',
    python: 'Pythonコード実行について:\n- 応答に ```python ... ``` のコードブロックを含めると、ユーザー側で実行ボタンが表示されます。\n- グラフ・図の作成依頼には matplotlib を使ったPythonコードを提示してください（matplotlib.use(\'Agg\')の指定は不要、plt.show()で自動的にチャットに画像表示されます）。\n- データ処理・計算・可視化の依頼では、迷わずPythonコードブロックを返してください。それだけで完結します。ツール呼び出しは不要です。\n- 大量データ・CSV/Parquet/JSON処理・複雑な集計には DuckDB を使ってください。SQLでpandasより高速かつメモリ効率良く処理できます。\n  使い方: import duckdb; con = duckdb.connect(); df = con.execute("SELECT ... FROM \'data.csv\'").df()\n  CSVやParquetを直接 FROM で参照可能。pandasのDataFrameもテーブルとして使えます（con.execute("SELECT ... FROM df")）。',
    meta: '重要な指示:\n- 内部的な推論・検索戦略・計画・メタ的な説明は一切出力しないでください。\n- "I need to...", "The user wants...", "I should..." のような独り言を書かないでください。\n- ツールを呼び出すと決めたら、即座にツールを呼び出してください。テキスト応答と併用しないでください。\n- 検索結果が得られなかった場合は、その旨を簡潔に伝え、自分の知識で回答してください。',
    judge: '以下の中から必要なツールを呼び出してください。通常の質問に答えられる場合はツールを使わずそのまま応答してください。\n{toolList}\n注意: チャット添付ドキュメントとサーバーuploadsファイルは別物。ドキュメント関連は search_documents、サーバーファイル関連は list_files/read_file/write_file。\nグラフ・計算・データ処理はツール不要。```python ... ``` コードブロックを応答に含めれば自動実行されます（matplotlibで画像表示、DuckDBで高速SQL処理可能）。\n内部推論は書かず、ツールを呼ぶか直接短く応答するかのみ。',
  },
  agentContext: {
    smallPredict: 512,        // ツール判断時のmax_tokens (短文モード)
    largePredict: 8192,       // ツール判断時のmax_tokens (長文モード) + continueGen時
    judgeHistoryCount: 3,     // ツール判断時に送信する直近メッセージ数
    largeGenKeywords: null,   // 長文モード判定キーワード (null=デフォルト使用)
  },
  tokenAvgWindow: 2000,
  recentMessageCount: 6,
  topK: 40,
  topP: 0.9,
  temperature: 0.7,
  // ログレベル: 'verbose' (全ログ), 'normal' (デフォルト), 'quiet' (最小限)
  // 'quiet' にすると /v1/* プロキシの毎リクエストログとllama-serverのstdoutを抑制
  logLevel: 'normal',
};
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const userConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      const merged = { ...DEFAULT_CONFIG, ...userConfig };
      ['systemPrompts', 'agentContext', 'transcribe', 'llamaServer', 'embeddingModel'].forEach(key => {
        if (DEFAULT_CONFIG[key] && typeof DEFAULT_CONFIG[key] === 'object') {
          merged[key] = { ...DEFAULT_CONFIG[key], ...(userConfig[key] || {}) };
        }
      });
      return merged;
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}
const appConfig = loadConfig();

// ─── llama-server プロセス管理 ───
// 1チャットモデル + 1Embeddingモデルを別プロセスで管理
// チャットモデル切替時はチャットサーバーを再起動

const chatModels = (appConfig.chatModels || []).map((m, i) => ({
  name: m.name || `model-${i}`,
  path: m.path,
  ctx: m.ctx || 4096,
  ngl: typeof m.ngl === 'number' ? m.ngl : 99,
  chatTemplate: m.chatTemplate || '',
  extraArgs: m.extraArgs || [],
}));

let chatProc = null;          // 現在起動中のチャットモデルプロセス
let chatProcModel = null;     // 起動中のモデル名
let chatProcStarting = false; // 起動中フラグ
let chatLastUsed = 0;         // 最終使用時刻（idleUnload用）
let firstChatLoadDone = false; // 起動後の初回チャットモデルロード完了フラグ
let embedProc = null;         // Embeddingプロセス
let embedProcStarting = false; // Embedding起動中フラグ
let embedLastUsed = 0;        // Embedding最終使用時刻（idleUnload用）

// ─── 外部API公開サーバー管理 ───
// 外部公開用の OpenAI 互換 llama-server を独立プロセスで起動・管理する。
// メインのチャット/Embedding用とは別ポート・別プロセス。
// 構造: Map<serverId, { proc, modelName, host, port, apiKey, type, startedAt }>
const externalServers = new Map();
let nextExternalServerId = 1;
const EXTERNAL_SERVERS_STATE_FILE = path.join(__dirname, 'external-servers.json');

function findModelByName(name) {
  return chatModels.find(m => m.name === name);
}

// llama-serverのreadyを待つ（/health か /v1/models をポーリング）
function waitForReady(host, port, timeoutMs, useHttps) {
  return new Promise((resolve) => {
    const start = Date.now();
    const httpsMod = require('https');
    const mod = useHttps ? httpsMod : http;
    const check = () => {
      const req = mod.request({
        hostname: host, port, path: '/health', method: 'GET', timeout: 2000,
        // 自己署名証明書の場合も受け入れる
        rejectUnauthorized: false,
      }, (res) => {
        let body = '';
        res.on('data', d => body += d);
        res.on('end', () => {
          // status 200 でステータスがloadingでなければOK
          if (res.statusCode === 200) {
            try {
              const j = JSON.parse(body);
              if (j.status === 'ok' || !j.status) return resolve(true);
            } catch { return resolve(true); }
          }
          if (Date.now() - start > timeoutMs) return resolve(false);
          setTimeout(check, 1000);
        });
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 1000);
      });
      req.on('timeout', () => { req.destroy(); });
      req.end();
    };
    check();
  });
}

// sd-server等、/health エンドポイントを持たないサーバー用
// TCP接続が成功すれば「ポートを開いてる」と判定。さらに2秒待ってモデルロード完了を待つ
function waitForTcpReady(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const net = require('net');
    const check = () => {
      const sock = new net.Socket();
      let done = false;
      const finish = (success) => {
        if (done) return;
        done = true;
        try { sock.destroy(); } catch {}
        if (success) return resolve(true);
        if (Date.now() - start > timeoutMs) return resolve(false);
        setTimeout(check, 2000);
      };
      sock.setTimeout(2000);
      sock.once('connect', () => finish(true));
      sock.once('error', () => finish(false));
      sock.once('timeout', () => finish(false));
      sock.connect(port, host);
    };
    check();
  });
}

function spawnLlamaServer(args, label) {
  const ls = appConfig.llamaServer;
  log('-', `[${label}] spawn: ${ls.binPath} ${args.join(' ')}`);
  const isQuiet = appConfig.logLevel === 'quiet';
  // 外部APIサーバー(label='ext:...')は強制的にログを出す（デバッグ用）
  const isExternal = label.startsWith('ext:');
  const captureOutput = !isQuiet || isExternal;
  const proc = spawn(ls.binPath, args, {
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'ignore', 'ignore'],
    env: { ...process.env },
  });
  if (captureOutput) {
    proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  }
  proc.on('exit', (code) => log('-', `[${label}] exited with code ${code}`));
  return proc;
}

// ─── 外部API公開サーバー: 起動・停止・状態管理 ───

function generateApiKey() {
  return 'sk-' + crypto.randomBytes(24).toString('hex');
}

// 外部APIサーバー一覧（メタ情報のみ、プロセスは含まない）
function listExternalServers() {
  const list = [];
  for (const [id, s] of externalServers) {
    list.push({
      id,
      modelName: s.modelName,
      host: s.host,
      port: s.port,
      apiKey: s.apiKey,
      type: s.type,
      https: !!s.https,
      ctx: s.ctx || null,
      nParallel: s.nParallel || null,
      running: !!(s.proc && !s.proc.killed),
      startedAt: s.startedAt,
    });
  }
  return list.sort((a, b) => a.id - b.id);
}

// 外部APIサーバーの状態をディスクに保存
function saveExternalServersState() {
  try {
    const data = listExternalServers().map(s => ({
      id: s.id, modelName: s.modelName, host: s.host, port: s.port,
      apiKey: s.apiKey, type: s.type,
    }));
    fs.writeFileSync(EXTERNAL_SERVERS_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    log('-', `[外部API] 状態保存失敗: ${e.message}`);
  }
}

// 外部APIサーバーを起動
async function startExternalServer({ modelName, host, port, apiKey, type, https }) {
  // 同じポートが既に使われていないかチェック
  for (const [, s] of externalServers) {
    if (s.port === port && s.proc && !s.proc.killed) {
      throw new Error(`ポート ${port} は既に外部APIサーバーで使用中です`);
    }
  }
  // メインのポートと衝突しないか
  const ls = appConfig.llamaServer;
  if (port === ls.chatPort || port === ls.embeddingPort) {
    throw new Error(`ポート ${port} は内部llama-serverで使用中です`);
  }

  // HTTPS指定だが証明書がない場合はエラー
  if (https && !HTTPS_ENABLED) {
    throw new Error('HTTPSで起動するには cert.pem と key.pem が必要です（OpenGeekLLMChat本体と同じものを使用）');
  }
  // llama-serverのHTTPSオプション
  const sslArgs = https && HTTPS_ENABLED
    ? ['--ssl-cert-file', CERT_PATH, '--ssl-key-file', KEY_PATH]
    : [];

  let args;
  if (type === 'embedding') {
    const em = appConfig.embeddingModel;
    if (!em || !em.path) throw new Error('Embeddingモデルが設定されていません');
    if (!fs.existsSync(em.path)) throw new Error(`Embeddingモデルファイルが存在しません: ${em.path}`);
    args = [
      '-m', em.path,
      '-c', String(em.ctx),
      '-ngl', String(em.ngl),
      '--port', String(port),
      '--host', host,
      '--embedding',
      ...(em.poolingType ? ['--pooling', em.poolingType] : []),
      ...(apiKey ? ['--api-key', apiKey] : []),
      ...sslArgs,
      ...(em.extraArgs || []),
    ];
  } else {
    const model = findModelByName(modelName);
    if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);
    if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);
    const filterPairArgs = (arr, exclude) => {
      const out = [];
      for (let i = 0; i < arr.length; i++) {
        if (exclude.includes(arr[i])) { i++; continue; }
        out.push(arr[i]);
      }
      return out;
    };
    var ctxSize = model.ctx;
    var npSize = model.nParallel ?? appConfig.llamaServer.nParallel ?? 1;
    args = [
      '-m', model.path,
      '-c', String(ctxSize),
      '-ngl', String(model.ngl),
      '-np', String(npSize),
      '--port', String(port),
      '--host', host,
      ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
      ...(model.chatTemplate ? ['--chat-template', model.chatTemplate] : []),
      ...(apiKey ? ['--api-key', apiKey] : []),
      ...sslArgs,
      ...(model.extraArgs || []),
    ];
  }

  const id = nextExternalServerId++;
  const label = `ext:${id}:${modelName}`;
  const proc = spawnLlamaServer(args, label);

  const serverInfo = {
    proc, modelName, host, port, apiKey, type, https: !!https,
    ctx: typeof ctxSize !== 'undefined' ? ctxSize : null,
    nParallel: typeof npSize !== 'undefined' ? npSize : null,
    startedAt: Date.now(),
  };
  externalServers.set(id, serverInfo);

  proc.on('exit', (code) => {
    log('-', `[外部API ${id}] 終了 (code=${code})`);
    serverInfo.proc = null;
  });

  // 起動完了を待つ（host=0.0.0.0の場合は127.0.0.1で確認）
  const checkHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const ready = await waitForReady(checkHost, port, ls.readyTimeoutMs, https);
  if (!ready) {
    try { proc.kill('SIGTERM'); } catch {}
    externalServers.delete(id);
    throw new Error(`外部APIサーバー起動タイムアウト: ${modelName} on ${host}:${port}`);
  }

  log('-', `[外部API ${id}] 起動完了: ${modelName} @ ${host}:${port}`);
  saveExternalServersState();
  return id;
}

// 外部APIサーバーを停止
// プロセスのみ停止（設定は保持。後で再起動できる）
function stopExternalServerProcess(id) {
  const s = externalServers.get(id);
  if (!s) return false;
  if (s.proc && !s.proc.killed) {
    try { s.proc.kill('SIGTERM'); } catch {}
    setTimeout(() => {
      if (s.proc && !s.proc.killed) {
        try { s.proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }
  s.proc = null;  // 設定は残す
  log('-', `[外部API ${id}] プロセス停止: ${s.modelName}`);
  return true;
}

// 停止中サーバーを再起動（既存設定でプロセスだけ起動し直す）
async function restartExternalServer(id) {
  const s = externalServers.get(id);
  if (!s) throw new Error('Not found');
  if (s.proc && !s.proc.killed) throw new Error('既に稼働中です');

  // 元の設定で起動。既存のエントリは startExternalServer 内で別IDが振られないように
  // 一旦消してから再生成（IDは新規）
  externalServers.delete(id);
  const newId = await startExternalServer({
    modelName: s.modelName,
    host: s.host,
    port: s.port,
    apiKey: s.apiKey,
    type: s.type,
    https: s.https,
  });
  return newId;
}

function stopExternalServer(id) {
  const s = externalServers.get(id);
  if (!s) return false;
  if (s.proc && !s.proc.killed) {
    try { s.proc.kill('SIGTERM'); } catch {}
    // 強制終了タイムアウト
    setTimeout(() => {
      if (s.proc && !s.proc.killed) {
        try { s.proc.kill('SIGKILL'); } catch {}
      }
    }, 5000);
  }
  externalServers.delete(id);
  saveExternalServersState();
  log('-', `[外部API ${id}] 停止: ${s.modelName}`);
  return true;
}

// 全外部APIサーバーを停止（プロセス終了時のクリーンアップ用）
function stopAllExternalServers() {
  for (const [id] of externalServers) {
    stopExternalServer(id);
  }
}

// ════════════════════════════════════════════════
// 画像生成 (stable-diffusion.cpp の sd-server を管理)
// ════════════════════════════════════════════════
// アーキテクチャ:
//   - sd-server (stable-diffusion.cpp の HTTPサーバー) を子プロセスで起動
//   - LLMが generate_image ツールを呼ぶ → /image-gen エンドポイント → sd-serverに転送
//   - 生成画像は public/uploads/ に PNG で保存し、Markdownでチャット欄に表示
//   - アイドルアンロード機能あり（チャットモデルと同じパターン）

let sdProc = null;            // 現在のsd-serverプロセス
let sdCurrentModel = null;    // 現在ロード中の画像生成モデル名
let sdProcStarting = false;
let sdLastActivity = Date.now();

function findImageModelByName(name) {
  if (!appConfig.imageModels || !Array.isArray(appConfig.imageModels)) return null;
  return appConfig.imageModels.find(m => m.name === name);
}

async function startImageModel(modelName) {
  if (sdProcStarting) throw new Error('既に画像生成モデル起動処理中です');
  const model = findImageModelByName(modelName);
  if (!model) throw new Error(`画像生成モデルが見つかりません: ${modelName}`);
  if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);

  sdProcStarting = true;
  // 重要: 起動開始時に sdLastActivity をリセット
  // これを忘れると、前回終了時から大きく時間が経過した場合に
  // 起動中のアイドルチェックで「アイドル時間が長い」と判定されて即終了してしまう
  sdLastActivity = Date.now();
  try {
    await stopImageModel();
    const sdConfig = appConfig.stableDiffusion || {};
    const binPath = sdConfig.binPath || 'sd-server';
    const port = sdConfig.port || 7860;

    const args = [
      '--model', model.path,
      '--listen-port', String(port),
      '--listen-ip', '127.0.0.1',
      ...(model.vae ? ['--vae', model.vae] : []),
      ...(model.taesd ? ['--taesd', model.taesd] : []),
      ...(model.controlNet ? ['--control-net', model.controlNet] : []),
      ...(model.extraArgs || []),
    ];

    log('-', `[sd-server] 起動: ${binPath} ${args.join(' ')}`);
    const proc = spawn(binPath, args, {
      cwd: __dirname,
      env: { ...process.env, ...(sdConfig.env || {}) },
    });
    sdProc = proc;

    proc.stdout.on('data', (d) => {
      // sd-serverは進捗ログが重要なので常に出力（logLevel=quietでも）
      process.stdout.write(`[sd-server] ${d}`);
    });
    proc.stderr.on('data', (d) => {
      process.stderr.write(`[sd-server] ${d}`);
    });
    // クロージャでこのプロセスを保持。新プロセスに切り替わった後で
    // 古いプロセスの exit イベントが来ても sdProc を誤って null にしないよう、
    // 現在の sdProc と一致する場合のみクリアする
    proc.on('exit', (code) => {
      log('-', `[sd-server] 終了 (code=${code}, pid=${proc.pid})`);
      if (sdProc === proc) {
        sdProc = null;
        sdCurrentModel = null;
      }
    });
    proc.on('error', (err) => {
      log('-', `[sd-server] プロセスエラー: ${err.message}`);
      if (sdProc === proc) {
        sdProc = null;
        sdCurrentModel = null;
      }
    });

    // 起動完了を待つ
    // sd-server には /health エンドポイントがないため、TCP接続だけで判定
    const ready = await waitForTcpReady('127.0.0.1', port, sdConfig.readyTimeoutMs || 300000);
    if (!ready) throw new Error(`sd-server が ${sdConfig.readyTimeoutMs || 300000}ms 以内に起動しませんでした`);

    sdCurrentModel = modelName;
    sdLastActivity = Date.now();
    log('-', `[sd-server] Ready (model=${modelName}, port=${port}, pid=${proc.pid})`);
  } finally {
    sdProcStarting = false;
  }
}

async function stopImageModel() {
  if (!sdProc || sdProc.killed) {
    sdCurrentModel = null;
    return;
  }
  try { sdProc.kill('SIGTERM'); } catch {}
  await new Promise(resolve => {
    const timer = setTimeout(() => {
      if (sdProc && !sdProc.killed) {
        try { sdProc.kill('SIGKILL'); } catch {}
      }
      resolve();
    }, 5000);
    sdProc.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  sdProc = null;
  sdCurrentModel = null;
}

// アイドルアンロード（チャットモデルと同じパターン）
function checkSdIdle() {
  const idleMs = appConfig.stableDiffusion?.idleUnloadMs;
  if (!idleMs || !sdProc || sdProcStarting) return;
  const elapsed = Date.now() - sdLastActivity;
  if (elapsed >= idleMs) {
    log('-', `[sd-server] アイドル ${Math.round(elapsed / 1000)}s → アンロード`);
    stopImageModel();
  }
}
setInterval(checkSdIdle, 30000);

async function startChatModel(modelName) {
  if (chatProcStarting) throw new Error('既にモデル起動処理中です');
  const model = findModelByName(modelName);
  if (!model) throw new Error(`モデルが見つかりません: ${modelName}`);
  if (!fs.existsSync(model.path)) throw new Error(`モデルファイルが存在しません: ${model.path}`);

  chatProcStarting = true;
  try {
    await stopChatModel();
    const ls = appConfig.llamaServer;
    // commonArgsから --port と --host （値とペア）を除外
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

    const args = [
      '-m', model.path,
      '-c', String(model.ctx),
      '-ngl', String(model.ngl),
      '-np', String(model.nParallel ?? appConfig.llamaServer.nParallel ?? 1),
      '--port', String(ls.chatPort),
      '--host', ls.chatHost,
      ...filterPairArgs(ls.commonArgs || [], ['--port', '--host']),
      ...(model.chatTemplate ? ['--chat-template', model.chatTemplate] : []),
      ...(model.extraArgs || []),
    ];
    chatProc = spawnLlamaServer(args, `chat:${model.name}`);
    chatProcModel = model.name;

    const ready = await waitForReady(ls.chatHost, ls.chatPort, ls.readyTimeoutMs);
    if (!ready) {
      await stopChatModel();
      throw new Error(`チャットモデル起動タイムアウト: ${model.name}`);
    }
    chatLastUsed = Date.now();
    firstChatLoadDone = true;
    log('-', `チャットモデル起動完了: ${model.name}`);
  } finally {
    chatProcStarting = false;
  }
}

function stopChatModel() {
  return new Promise((resolve) => {
    if (!chatProc) return resolve();
    const p = chatProc;
    chatProc = null;
    chatProcModel = null;
    p.once('exit', () => resolve());
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000);
  });
}

// ─── アイドル時の自動アンロード ───
// idleUnloadMs > 0 のとき、最終使用時刻から指定msアイドルでチャットモデルをアンロード
let chatProcAutoUnloaded = null;  // 自動アンロード時のモデル名（再ロードに使用）

setInterval(async () => {
  const ls = appConfig.llamaServer;
  if (!ls.idleUnloadMs || ls.idleUnloadMs <= 0) return;
  // チャットモデルのアイドルチェック
  if (chatProc && !chatProcStarting && chatLastUsed) {
    const idleMs = Date.now() - chatLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      log('-', `アイドル ${Math.floor(idleMs/1000)}秒経過、モデル「${chatProcModel}」を自動アンロード`);
      chatProcAutoUnloaded = chatProcModel;
      await stopChatModel();
      chatLastUsed = 0;
    }
  }
  // Embeddingモデルのアイドルチェック（同じidleUnloadMsを使用）
  if (embedProc && !embedProcStarting && embedLastUsed) {
    const idleMs = Date.now() - embedLastUsed;
    if (idleMs >= ls.idleUnloadMs) {
      log('-', `アイドル ${Math.floor(idleMs/1000)}秒経過、Embeddingモデルを自動アンロード`);
      await stopEmbeddingModel();
      embedLastUsed = 0;
    }
  }
}, 30000);  // 30秒ごとにチェック

// 自動アンロード後のリクエスト時に再ロード
async function ensureChatModelLoaded() {
  if (chatProc) return true;  // 既にロード済み
  if (chatProcStarting) return false;  // 起動中（プロキシ側で待機）
  // 自動アンロードされたモデルがあればそれを優先、なければデフォルトを使う（初回ロード対応）
  const modelToReload = chatProcAutoUnloaded || appConfig.defaultModel;
  if (!modelToReload) return false;
  chatProcAutoUnloaded = null;
  log('-', `自動ロード: モデル「${modelToReload}」を起動`);
  startChatModel(modelToReload).catch(e => log('-', `自動ロードエラー: ${e.message}`));
  return false;  // 起動中なのでこのリクエストは待機（プロキシ側で待つ）
}

// Embedding未起動時に再ロード（Promise返却、完了を待てる）
async function ensureEmbeddingLoaded() {
  if (embedProc) {
    embedLastUsed = Date.now();
    return true;
  }
  if (embedProcStarting) {
    // 起動中: 完了を待つ
    const startWait = Date.now();
    while (embedProcStarting && Date.now() - startWait < 60000) {
      await new Promise(r => setTimeout(r, 500));
    }
    if (embedProc) {
      embedLastUsed = Date.now();
      return true;
    }
    return false;
  }
  // 未起動: 起動して待つ
  log('-', 'Embeddingアイドル復帰: 再起動');
  await startEmbeddingModel();
  if (embedProc) {
    embedLastUsed = Date.now();
    return true;
  }
  return false;
}

async function startEmbeddingModel() {
  const em = appConfig.embeddingModel;
  if (!em || !em.path) {
    log('-', 'Embeddingモデル未設定（RAGは無効化されます）');
    return;
  }
  if (!fs.existsSync(em.path)) {
    log('-', `Embeddingモデルファイルが存在しません: ${em.path}`);
    return;
  }
  if (embedProc || embedProcStarting) return;
  embedProcStarting = true;
  try {
    const ls = appConfig.llamaServer;
    const args = [
      '-m', em.path,
      '-c', String(em.ctx || 512),
      '-ngl', String(typeof em.ngl === 'number' ? em.ngl : 99),
      '--port', String(ls.embeddingPort),
      '--host', ls.embeddingHost,
      '--embedding',
      ...(em.poolingType ? ['--pooling', em.poolingType] : []),
      ...(em.extraArgs || []),
    ];
    embedProc = spawnLlamaServer(args, `embed`);
    const ready = await waitForReady(ls.embeddingHost, ls.embeddingPort, ls.readyTimeoutMs);
    if (!ready) {
      log('-', 'Embeddingサーバー起動タイムアウト（RAGが動作しない可能性があります）');
      try { embedProc.kill('SIGTERM'); } catch {}
      embedProc = null;
    } else {
      log('-', 'Embeddingサーバー起動完了');
      embedLastUsed = Date.now();
    }
  } finally {
    embedProcStarting = false;
  }
}

function stopEmbeddingModel() {
  return new Promise((resolve) => {
    if (!embedProc) return resolve();
    const p = embedProc;
    embedProc = null;
    p.once('exit', () => resolve());
    try { p.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, 5000);
  });
}

// プロセス終了時のクリーンアップ
function cleanup() {
  if (chatProc) try { chatProc.kill('SIGTERM'); } catch {}
  if (embedProc) try { embedProc.kill('SIGTERM'); } catch {}
  // 外部APIサーバーも全停止
  for (const [, s] of externalServers) {
    if (s.proc && !s.proc.killed) {
      try { s.proc.kill('SIGTERM'); } catch {}
    }
  }
}
process.on('SIGINT', () => { cleanup(); process.exit(0); });
process.on('SIGTERM', () => { cleanup(); process.exit(0); });
process.on('exit', cleanup);

// ─── ログ ───
function timestamp() {
  return new Date().toLocaleString('ja-JP', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

function getIP(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim()
    || req.socket?.remoteAddress?.replace('::ffff:', '')
    || '-';
}

function log(ip, message) {
  console.log(`${timestamp()}  ${ip}  ${message}`);
}

const app = express();
app.set('trust proxy', 'loopback'); // リバースプロキシからのX-Forwarded-*ヘッダーを信頼

// ─── 共通JSONパーサー（必要なエンドポイントのみで個別適用） ───
// /v1/* (LLMプロキシ) 等では使わない。bodyを再ストリームする必要があるため。
// 画像付きメッセージ、長いドキュメント、コードブロック等のため上限を大きめに設定
// config.jsonの maxRequestSize で変更可能（デフォルト 50mb）
const MAX_REQUEST_SIZE = appConfig.maxRequestSize || '50mb';
const jsonParser = express.json({ limit: MAX_REQUEST_SIZE });
log('-', `[起動] JSONリクエスト上限: ${MAX_REQUEST_SIZE}`);

// ─── HTTP/HTTPS サーバー初期化 ───
// cert.pem と key.pem がカレントディレクトリにあればHTTPS、なければHTTP
// 秘密鍵にパスフレーズが設定されている場合は SSL_PASSPHRASE 環境変数 or config.jsonのsslPassphraseに指定
const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH = path.join(__dirname, 'key.pem');
const HTTPS_ENABLED = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
// ─── HTTPサーバーオプション ───
// maxHeaderSize: HTTPヘッダー上限（デフォルト16KB → 64KB に拡大）
//   tools配列が大きい場合のRST切断対策。Authorization, tools, system prompt が大きいケース。
// requestTimeout: リクエストタイムアウト（デフォルト5分 → 10分）
//   長いLLM応答に対応
// headersTimeout: ヘッダー受信タイムアウト（デフォルト1分 → 2分）
// keepAliveTimeout: Keep-Alive（デフォルト5秒 → 60秒）
//   接続再利用を効率化
const SERVER_OPTS = {
  maxHeaderSize: appConfig.maxHeaderSize || 64 * 1024,  // 64KB
};

let server;
if (HTTPS_ENABLED) {
  const https = require('https');
  const sslOptions = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
    ...SERVER_OPTS,
  };
  const passphrase = process.env.SSL_PASSPHRASE || appConfig.sslPassphrase;
  if (passphrase) sslOptions.passphrase = passphrase;
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(SERVER_OPTS, app);
}

// サーバーインスタンスのタイムアウト設定
server.requestTimeout = (appConfig.requestTimeoutSec || 600) * 1000;     // 10分
server.headersTimeout = (appConfig.headersTimeoutSec || 120) * 1000;     // 2分
server.keepAliveTimeout = (appConfig.keepAliveTimeoutSec || 60) * 1000;  // 60秒
server.timeout = 0;  // ソケットタイムアウト無効化（長いLLM応答に対応）
log('-', `[起動] HTTPサーバー設定: maxHeaderSize=${SERVER_OPTS.maxHeaderSize}, requestTimeout=${server.requestTimeout}ms, headersTimeout=${server.headersTimeout}ms`);

// ─── WebSocket: 対話的Python実行 ───
const wss = new WebSocketServer({ server, path: '/ws/python' });

wss.on('connection', (ws, req) => {
  const ip = getIP(req);
  // 認証チェック（パスワード設定時）
  if (appConfig.password) {
    const cookieToken = (req.headers.cookie || '').split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wz_session='))?.split('=')[1];
    if (!isValidSession(cookieToken)) {
      log(ip, 'WS AUTH failed');
      ws.close(1008, 'Unauthorized');
      return;
    }
  }
  let proc = null;
  let tmpFile = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'run' && msg.code) {
      tmpFile = path.join(os.tmpdir(), `opengeek_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`);
      // 作業ディレクトリ: public/uploads/（LLMのread_file/write_fileと統一）
      const pyCwd = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(pyCwd)) fs.mkdirSync(pyCwd, { recursive: true });
      // matplotlibで生成した画像は public/plots/ に保存（uploadsとは分離）
      const plotsDir = path.join(__dirname, 'public', 'plots');
      if (!fs.existsSync(plotsDir)) fs.mkdirSync(plotsDir, { recursive: true });

      // matplotlib自動対応のプレアンブル: show()と savefig() の両方をフック
      const runId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      // Windowsパス対応のため絶対パスをJSON形式でエスケープ
      const plotsDirEscaped = JSON.stringify(plotsDir);
      const preamble = `
import os as _os, sys as _sys
import warnings as _warnings
_warnings.filterwarnings('ignore', category=UserWarning, module='matplotlib')
_IMG_COUNTER = [0]
_RUN_ID = "${runId}"
_PLOTS_DIR = ${plotsDirEscaped}
try:
    import matplotlib
    matplotlib.use('Agg')
    # 日本語フォント自動選択（環境にインストールされているもの優先）
    from matplotlib import font_manager as _fm
    _JP_CANDIDATES = [
        'IPAexGothic', 'IPAGothic',
        'Noto Sans CJK JP', 'Noto Sans JP',
        'Hiragino Sans', 'Hiragino Kaku Gothic Pro',
        'Yu Gothic', 'Meiryo', 'MS Gothic',
        'TakaoPGothic', 'VL PGothic', 'DejaVu Sans',
    ]
    _available = set(f.name for f in _fm.fontManager.ttflist)
    _jp_font = next((f for f in _JP_CANDIDATES if f in _available), 'DejaVu Sans')
    matplotlib.rcParams['font.family'] = _jp_font
    matplotlib.rcParams['axes.unicode_minus'] = False  # マイナス記号豆腐化防止
    import matplotlib.pyplot as _plt
    _orig_show = _plt.show
    _orig_savefig = _plt.savefig
    def _auto_show(*a, **kw):
        _IMG_COUNTER[0] += 1
        fname = f"plot_{_RUN_ID}_{_IMG_COUNTER[0]}.png"
        full_path = _os.path.join(_PLOTS_DIR, fname)
        _orig_savefig(full_path, bbox_inches='tight', dpi=100)
        # フロント側では /plots/<fname> でアクセスされるので plots/ プレフィックス付きマーカー
        print(f"__OGC_IMAGE__:plots/{fname}", flush=True)
        _plt.close('all')
    def _auto_savefig(fname, *a, **kw):
        # ユーザーがsavefigに明示指定したパスはそのまま尊重（uploadsに保存される）
        _orig_savefig(fname, *a, **kw)
        base = _os.path.basename(str(fname))
        print(f"__OGC_IMAGE__:{base}", flush=True)
    _plt.show = _auto_show
    _plt.savefig = _auto_savefig
    # ユーザーコードが 'import matplotlib.pyplot as plt' だけして
    # その後 'matplotlib.use(Agg)' を呼ぶケースに備え、
    # matplotlib モジュール自体もグローバル名として露出させる
except ImportError:
    pass
# LLMが 'matplotlib.use(Agg)' を呼ぶケースに備え、user code が見るグローバル空間にも
# matplotlib をバインドしておく（既にプレアンブル内で Agg バックエンド設定済みなので
# 再呼び出しは no-op に近い、警告は出るが無害）
try:
    import matplotlib
except ImportError:
    pass
# ─── user code below ───
`;
      fs.writeFileSync(tmpFile, preamble + msg.code, 'utf-8');
      const pythonCmd = appConfig.pythonPath || 'python3';
      log(ip, `PYTHON RUN (${msg.code.length} chars) using ${pythonCmd} in ${pyCwd}`);

      proc = spawn(pythonCmd, ['-u', tmpFile], {
        env: {
          ...process.env,
          PYTHONUNBUFFERED: '1',
          // matplotlib のキャッシュ先（~/.config が書けない環境向け）
          MPLCONFIGDIR: process.env.MPLCONFIGDIR || '/tmp/matplotlib',
          // 各種ライブラリの一時ディレクトリも /tmp に
          HOME: process.env.HOME || '/tmp',
        },
        cwd: pyCwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const timer = setTimeout(() => {
        if (proc) {
          proc.kill('SIGTERM');
          ws.send(JSON.stringify({ type: 'stderr', data: `\n[タイムアウト: ${PYTHON_TIMEOUT / 1000}秒で強制終了されました]\n` }));
        }
      }, PYTHON_TIMEOUT);

      proc.stdout.on('data', (data) => {
        const text = data.toString();
        // __OGC_IMAGE__:filename.png マーカーを検出して画像メッセージに変換
        const lines = text.split('\n');
        const normal = [];
        for (const line of lines) {
          const m = line.match(/^__OGC_IMAGE__:(.+)$/);
          if (m) {
            ws.send(JSON.stringify({ type: 'image', filename: m[1].trim() }));
          } else {
            normal.push(line);
          }
        }
        const filtered = normal.join('\n');
        if (filtered) ws.send(JSON.stringify({ type: 'stdout', data: filtered }));
      });

      proc.stderr.on('data', (data) => {
        ws.send(JSON.stringify({ type: 'stderr', data: data.toString() }));
      });

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        if (tmpFile) fs.unlink(tmpFile, () => {});
        log(ip, `PYTHON EXIT ${exitCode}`);
        ws.send(JSON.stringify({ type: 'exit', exitCode: exitCode ?? -1 }));
        proc = null;
        tmpFile = null;
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        if (tmpFile) fs.unlink(tmpFile, () => {});
        log(ip, `PYTHON ERROR ${err.message}`);
        ws.send(JSON.stringify({ type: 'stderr', data: err.message }));
        ws.send(JSON.stringify({ type: 'exit', exitCode: -1 }));
        proc = null;
      });
    }

    if (msg.type === 'stdin' && proc && proc.stdin.writable) {
      proc.stdin.write(msg.data + '\n');
    }

    if (msg.type === 'kill' && proc) {
      proc.kill('SIGTERM');
    }
  });

  ws.on('close', () => {
    if (proc) proc.kill('SIGTERM');
    if (tmpFile) fs.unlink(tmpFile, () => {});
  });
});

// ─── Web検索 (DuckDuckGo) ───
function ddgSearch(query, maxResults = 5) {
  return new Promise((resolve) => {
    const postData = `q=${encodeURIComponent(query)}&kl=jp-jp`;
    const req = https.request({
      hostname: 'html.duckduckgo.com',
      path: '/html/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
      },
      timeout: 15000,
    }, (res) => {
      let html = '';
      res.on('data', (d) => { html += d.toString(); });
      res.on('end', () => {
        try {
          const results = [];
          const decodeHtml = (s) => s
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

          // パターン1: class="result results_links..." ブロック
          const resultRegex = /<a[^>]+class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
          const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)/gi;

          const links = [...html.matchAll(resultRegex)];
          const snippets = [...html.matchAll(snippetRegex)];

          for (let i = 0; i < links.length && results.length < maxResults; i++) {
            let url = links[i][1];
            // DuckDuckGoリダイレクトURLをデコード
            const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
            if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
            // 広告リンクをスキップ
            if (url.includes('duckduckgo.com/y.js') || url.includes('ad_provider')) continue;
            const title = decodeHtml(links[i][2]);
            const snippet = snippets[i] ? decodeHtml(snippets[i][1]) : '';
            if (title && url && url.startsWith('http')) {
              results.push({ title, url, snippet });
            }
          }

          // パターン2: パターン1で取れなかった場合、aタグ+href全般で探す
          if (results.length === 0) {
            const altRegex = /<a[^>]+href="(\/\/duckduckgo\.com\/l\/\?[^"]*uddg=[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
            const altLinks = [...html.matchAll(altRegex)];
            for (let i = 0; i < altLinks.length && results.length < maxResults; i++) {
              let url = 'https:' + altLinks[i][1];
              const uddgMatch = url.match(/[?&]uddg=([^&]+)/);
              if (uddgMatch) url = decodeURIComponent(uddgMatch[1]);
              const title = decodeHtml(altLinks[i][2]);
              if (title && url && !url.includes('duckduckgo.com')) {
                results.push({ title, url, snippet: '' });
              }
            }
          }

          if (results.length === 0) {
            console.log('  [DDG] No results parsed. Response length:', html.length,
              'Has result__a:', html.includes('result__a'),
              'Has uddg:', html.includes('uddg='));
          }
          resolve(results);
        } catch (e) {
          console.log('  [DDG] Parse error:', e.message);
          resolve([]);
        }
      });
    });
    req.on('error', (e) => { console.log('  [DDG] Request error:', e.message); resolve([]); });
    req.on('timeout', () => { console.log('  [DDG] Timeout'); req.destroy(); resolve([]); });
    req.write(postData);
    req.end();
  });
}

// ─── ページ本文取得 (URL → テキスト) ───
function fetchPageText(url, maxChars = 3000) {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request({
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ja,en-US;q=0.9',
        },
        timeout: 8000,
      }, (res) => {
        // リダイレクト対応（3xx）
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const redirectUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : u.origin + res.headers.location;
          res.destroy();
          return resolve(fetchPageText(redirectUrl, maxChars));
        }
        const contentType = res.headers['content-type'] || '';
        if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
          res.destroy();
          return resolve('');
        }
        let html = '';
        res.on('data', (d) => {
          html += d.toString();
          // サイズ制限（巨大ページの無駄なDL防止）
          if (html.length > 500000) res.destroy();
        });
        res.on('end', () => resolve(extractMainText(html, maxChars)));
        res.on('close', () => resolve(extractMainText(html, maxChars)));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.end();
    } catch { resolve(''); }
  });
}

// HTMLから主要テキストを抽出
function extractMainText(html, maxChars = 3000) {
  if (!html) return '';
  // script, style, nav, header, footer を除去
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[\s\S]*?<\/nav>/gi, '')
    .replace(/<header[\s\S]*?<\/header>/gi, '')
    .replace(/<footer[\s\S]*?<\/footer>/gi, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '');

  // main, article要素があれば優先
  const mainMatch = text.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
  if (mainMatch) text = mainMatch[1];

  // タグ除去 + エンティティデコード + 空白整理
  text = text
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();

  return text.slice(0, maxChars);
}

app.get('/web-search', requireAuth, async (req, res) => {
  const ip = getIP(req);
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q parameter required' });
  const maxResults = parseInt(req.query.n) || 5;
  const fetchBodies = req.query.fetch !== '0'; // デフォルト有効
  const bodyCount = parseInt(req.query.bodyCount) || 3; // 上位何件の本文を取るか
  log(ip, `WEB SEARCH: ${query}`);
  const results = await ddgSearch(query, maxResults);
  log(ip, `WEB SEARCH: ${results.length} results, fetching bodies: ${fetchBodies ? bodyCount : 0}`);

  // 上位N件のページ本文を並列取得
  if (fetchBodies && results.length > 0) {
    const targets = results.slice(0, bodyCount);
    await Promise.all(targets.map(async (r, i) => {
      try {
        const body = await fetchPageText(r.url, 2500);
        if (body) {
          r.body = body;
          log(ip, `  [${i+1}] ${r.url}  (${body.length} chars)`);
        }
      } catch {}
    }));
  }

  res.json({ results });
});

// ─── 音声認識プロキシ (Python Transcribe Server へ転送) ───
app.post('/transcribe', requireAuth, (req, res) => {
  const ip = getIP(req);
  if (!appConfig.transcribe || !appConfig.transcribe.enabled) {
    return res.status(503).json({ error: '音声認識が無効です。config.jsonでtranscribe.enabledをtrueにしてください。' });
  }
  const host = appConfig.transcribe.host || '127.0.0.1';
  const port = appConfig.transcribe.port || 11500;
  const contentLength = req.headers['content-length'];
  log(ip, `TRANSCRIBE POST ${contentLength || '?'} bytes → ${host}:${port}`);

  const proxyReq = http.request({
    hostname: host, port, path: '/transcribe', method: 'POST',
    headers: {
      'Content-Type': req.headers['content-type'] || 'application/octet-stream',
      ...(contentLength && { 'Content-Length': contentLength }),
    },
    timeout: 120000,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, { 'Content-Type': 'application/json' });
    proxyRes.pipe(res, { end: true });
  });
  proxyReq.on('error', (err) => {
    log(ip, `TRANSCRIBE ERROR: ${err.message}`);
    if (!res.headersSent) res.status(502).json({ error: '音声認識サーバーに接続できません: ' + err.message });
  });
  proxyReq.on('timeout', () => {
    log(ip, `TRANSCRIBE TIMEOUT`);
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: '音声認識タイムアウト' });
  });
  req.pipe(proxyReq, { end: true });
});

app.get('/transcribe/health', requireAuth, (req, res) => {
  if (!appConfig.transcribe || !appConfig.transcribe.enabled) {
    return res.json({ enabled: false });
  }
  const host = appConfig.transcribe.host || '127.0.0.1';
  const port = appConfig.transcribe.port || 11500;
  const r = http.get({ hostname: host, port, path: '/health', timeout: 3000 }, (proxyRes) => {
    let data = '';
    proxyRes.on('data', d => data += d);
    proxyRes.on('end', () => {
      try { res.json({ enabled: true, ...JSON.parse(data) }); }
      catch { res.json({ enabled: true, status: 'unknown' }); }
    });
  });
  r.on('error', () => res.json({ enabled: true, status: 'offline' }));
  r.on('timeout', () => { r.destroy(); res.json({ enabled: true, status: 'timeout' }); });
});

// ─── llama-server (OpenAI互換) へのリバースプロキシ ───
// /v1/* をlocalhost:chatPortへ転送（チャット推論用）
// /embed/v1/* をlocalhost:embeddingPortへ転送（Embedding用）
function proxyToLlama(targetHost, targetPort, pathPrefix, isChatProxy) {
  return async (req, res) => {
    const ip = getIP(req);
    const targetPath = pathPrefix + req.url;
    const isQuiet = appConfig.logLevel === 'quiet';

    // チャットプロキシの場合: モデル起動中・未ロード時は起動完了を待ってから処理を続行
    // （Embeddingプロキシと同様の挙動。クライアントは「初回送信で503」を見ずに済む）
    if (isChatProxy) {
      // 既に起動中の場合は完了を待つ
      if (chatProcStarting) {
        if (!isQuiet) log(ip, `${req.method} ${targetPath} → モデル起動中、完了を待機`);
        // 最大60秒待つ（モデルロードのタイムアウト）
        const startWait = Date.now();
        while (chatProcStarting && (Date.now() - startWait < 60000)) {
          await new Promise(r => setTimeout(r, 500));
        }
        if (chatProcStarting || !chatProc) {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (起動タイムアウト)`);
          return res.status(503).json({
            error: 'モデル起動がタイムアウトしました。サーバーログを確認してください。',
            starting: false,
          });
        }
      }
      // プロセスが存在しない場合: アイドル復帰または初回ロードを行う
      if (!chatProc) {
        // 初回ロード（サーバー起動後の最初のチャット）または自動アンロードからの復帰
        if (chatProcAutoUnloaded || appConfig.defaultModel) {
          if (!isQuiet) log(ip, `${req.method} ${targetPath} → モデル自動ロード待機`);
          ensureChatModelLoaded();  // バックグラウンドで起動開始
          // 起動完了を待つ（最大60秒）
          const startWait = Date.now();
          while ((chatProcStarting || !chatProc) && (Date.now() - startWait < 60000)) {
            await new Promise(r => setTimeout(r, 500));
          }
          if (!chatProc) {
            if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (自動ロード失敗)`);
            return res.status(503).json({
              error: 'モデル自動ロードに失敗しました。サーバーログを確認してください。',
              starting: false,
            });
          }
        } else {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (モデル未ロード)`);
          return res.status(503).json({
            error: 'チャットモデルがロードされていません。',
            starting: false,
          });
        }
      }
      chatLastUsed = Date.now();
    } else {
      // Embeddingプロキシ: アイドルアンロード後なら起動を待ってから処理を続行
      if (!embedProc) {
        if (!isQuiet) log(ip, `Embedding未起動、再ロードを待機 (${targetPath})`);
        const ready = await ensureEmbeddingLoaded();
        if (!ready) {
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (embed reload failed)`);
          return res.status(503).json({ error: 'Embeddingモデルの再ロードに失敗しました。' });
        }
      }
      embedLastUsed = Date.now();
    }

    if (!isQuiet) {
      log(ip, `${req.method} ${targetPath} -> ${targetHost}:${targetPort}`);
    }

    const options = {
      hostname: targetHost,
      port: targetPort,
      path: targetPath,
      method: req.method,
      headers: {
        'content-type': req.headers['content-type'] || 'application/json',
        'accept': req.headers['accept'] || '*/*',
      },
      timeout: 600000,
    };
    if (req.headers['content-length']) {
      options.headers['content-length'] = req.headers['content-length'];
    }

    const proxyReq = http.request(options, (proxyRes) => {
      if (!isQuiet) {
        log(ip, `${proxyRes.statusCode} ${req.method} ${targetPath}`);
      }
      const headers = {
        'content-type': proxyRes.headers['content-type'] || 'application/json',
        'cache-control': 'no-cache',
      };
      if (proxyRes.headers['transfer-encoding']) {
        headers['transfer-encoding'] = proxyRes.headers['transfer-encoding'];
      }
      res.writeHead(proxyRes.statusCode, headers);
      proxyRes.pipe(res, { end: true });
    });

    proxyReq.on('error', (err) => {
      log(ip, `ERROR ${targetPath} ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: 'llama-server に接続できません: ' + err.message });
      }
    });
    proxyReq.on('timeout', () => {
      log(ip, `TIMEOUT ${targetPath}`);
      proxyReq.destroy();
      if (!res.headersSent) {
        res.status(504).json({ error: 'llama-server タイムアウト' });
      }
    });

    req.pipe(proxyReq, { end: true });
  };
}

// チャット推論: /v1/chat/completions, /v1/completions, /v1/models 等
app.use('/v1', requireAuth, proxyToLlama(
  appConfig.llamaServer.chatHost,
  appConfig.llamaServer.chatPort,
  '/v1',
  true  // isChatProxy
));

// Embedding: /embed/v1/embeddings
app.use('/embed/v1', requireAuth, proxyToLlama(
  appConfig.llamaServer.embeddingHost,
  appConfig.llamaServer.embeddingPort,
  '/v1',
  false
));

// ─── モデル管理API ───
// 利用可能モデル一覧（config.jsonから）+ 現在のロード状態
app.get('/models', requireAuth, (req, res) => {
  res.json({
    models: chatModels.map(m => ({
      name: m.name,
      ctx: m.ctx,
      ngl: m.ngl,
      loaded: m.name === chatProcModel,
    })),
    current: chatProcModel,
    starting: chatProcStarting,
    embeddingReady: !!embedProc,
    autoUnloaded: chatProcAutoUnloaded,  // アイドルでアンロード済みのモデル名（次のリクエストで再ロードされる）
    idleUnloadMs: appConfig.llamaServer.idleUnloadMs || 0,
    firstLoadPending: !firstChatLoadDone,  // サーバー起動後、まだ一度もチャットモデルがロードされていない
  });
});

// モデル切替（再起動）
app.post('/models/load', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  // 自動アンロード状態をクリア（手動切替が始まったので）
  chatProcAutoUnloaded = null;
  if (name === chatProcModel) return res.json({ ok: true, current: chatProcModel, message: 'すでにロード中' });
  if (chatProcStarting) return res.status(409).json({ error: '別のモデルが起動中です' });

  log(ip, `MODEL LOAD ${name}`);
  try {
    await startChatModel(name);
    res.json({ ok: true, current: chatProcModel });
  } catch (e) {
    log(ip, `MODEL LOAD ERROR ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// モデルアンロード
app.post('/models/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, `MODEL UNLOAD ${chatProcModel}`);
  await stopChatModel();
  res.json({ ok: true });
});

// ─── 外部API公開サーバー ───

app.get('/external-servers', requireAuth, (req, res) => {
  res.json({ servers: listExternalServers() });
});

app.post('/external-servers', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  try {
    const { modelName, host, port, apiKey, type, https } = req.body || {};
    if (!port || typeof port !== 'number' || port < 1 || port > 65535) {
      return res.status(400).json({ error: 'portは1-65535の数値で指定してください' });
    }
    const targetHost = (typeof host === 'string' && host) ? host : '0.0.0.0';
    const targetType = type === 'embedding' ? 'embedding' : 'chat';
    if (targetType === 'chat' && !modelName) {
      return res.status(400).json({ error: 'modelName を指定してください' });
    }
    // APIキー: 指定がなければ自動生成
    const finalApiKey = (typeof apiKey === 'string' && apiKey.trim())
      ? apiKey.trim()
      : generateApiKey();

    log(ip, `EXTERNAL API START: ${modelName || 'embedding'} @ ${targetHost}:${port} (https=${!!https})`);
    const id = await startExternalServer({
      modelName: modelName || appConfig.embeddingModel?.path?.split('/').pop() || 'embedding',
      host: targetHost,
      port,
      apiKey: finalApiKey,
      type: targetType,
      https: !!https,
    });
    res.json({ ok: true, id, apiKey: finalApiKey });
  } catch (e) {
    log(ip, `EXTERNAL API ERROR: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// HTTPS有効化されているか（フロント側で表示制御するため）
app.get('/external-servers/https-available', requireAuth, (req, res) => {
  res.json({ available: HTTPS_ENABLED });
});

app.delete('/external-servers/:id', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API STOP: ${id}`);
  const ok = stopExternalServer(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// プロセスのみ停止（設定は保持）
app.post('/external-servers/:id/stop', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API PROC STOP: ${id}`);
  const ok = stopExternalServerProcess(id);
  if (!ok) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// 停止中のサーバーを再起動
app.post('/external-servers/:id/start', requireAuth, async (req, res) => {
  const ip = getIP(req);
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });
  log(ip, `EXTERNAL API PROC START: ${id}`);
  try {
    const newId = await restartExternalServer(id);
    res.json({ ok: true, id: newId });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
// 画像生成 API (/image-gen)
// ════════════════════════════════════════════════
// LLMの generate_image ツールから呼ばれる。
// - sd-server が未起動なら自動起動（オンデマンドロード）
// - 生成画像は public/uploads/ に PNG 保存し、URLを返す
// - チャットUIは Markdown ![](...) で表示するだけ

app.get('/image-gen/info', requireAuth, (req, res) => {
  const sdConfig = appConfig.stableDiffusion || {};
  res.json({
    available: !!(appConfig.imageModels && appConfig.imageModels.length > 0),
    currentModel: sdCurrentModel,
    starting: sdProcStarting,
    running: !!(sdProc && !sdProc.killed),
    models: (appConfig.imageModels || []).map(m => ({ name: m.name, desc: m.desc })),
    defaultModel: sdConfig.defaultModel || appConfig.imageModels?.[0]?.name || null,
  });
});

app.post('/image-gen', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  const {
    prompt,
    negativePrompt = '',
    model = null,             // 省略時は defaultModel または現在ロード中
    width = 1024,
    height = 1024,
    steps = 20,
    cfgScale = 7.0,
    sampler = 'euler_a',      // sd-server のサンプラー名
    seed = -1,                // -1 = ランダム
    batchCount = 1,           // 同じ設定で何枚生成するか
  } = req.body || {};

  if (!prompt || typeof prompt !== 'string') {
    return res.status(400).json({ error: 'prompt が必要です' });
  }
  if (!appConfig.imageModels || appConfig.imageModels.length === 0) {
    return res.status(400).json({
      error: '画像生成モデルが設定されていません。config.json の imageModels に追加してください。',
    });
  }

  // モデル決定
  const sdConfig = appConfig.stableDiffusion || {};
  const targetModel = model || sdCurrentModel || sdConfig.defaultModel || appConfig.imageModels[0].name;

  // 既に別モデルがロードされていれば切り替え
  if (sdCurrentModel && sdCurrentModel !== targetModel) {
    log(ip, `[IMAGE-GEN] モデル切替: ${sdCurrentModel} → ${targetModel}`);
    await stopImageModel();
  }

  // モデルが起動していなければ起動（オンデマンド）
  if (!sdProc || sdProc.killed || sdProc.exitCode !== null) {
    try {
      log(ip, `[IMAGE-GEN] sd-server を起動: ${targetModel}`);
      await startImageModel(targetModel);
    } catch (e) {
      return res.status(500).json({ error: `sd-server起動失敗: ${e.message}` });
    }
  }

  sdLastActivity = Date.now();
  const port = sdConfig.port || 7860;

  // 一括生成 (batchCount 回ループ)
  const generatedUrls = [];
  const startTime = Date.now();
  for (let i = 0; i < Math.min(batchCount, 4); i++) {
    try {
      // sd-server プロセスが生きてるか確認（ループ中に死んだ場合の検知）
      if (!sdProc || sdProc.killed || sdProc.exitCode !== null) {
        throw new Error('sd-serverプロセスが終了しています。再試行してください。');
      }

      // タイムアウト付き fetch（hangを防ぐ）
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 180000);  // 3分

      // sd-server の HTTP API に転送
      // sd-server (stable-diffusion.cpp) は AUTOMATIC1111互換だが、
      // サポートされてるパラメータが限定的。
      // 検証: curlで {prompt, width, height, steps} のみで成功する
      // 追加パラメータは存在する場合だけ送る
      const sdBody = {
        prompt,
        width: Math.min(Math.max(width, 64), 2048),
        height: Math.min(Math.max(height, 64), 2048),
        steps: Math.min(Math.max(steps, 1), 100),
        batch_size: 1,
        n_iter: 1,
      };
      if (negativePrompt) sdBody.negative_prompt = negativePrompt;
      if (cfgScale != null && cfgScale > 0) sdBody.cfg_scale = cfgScale;
      if (seed !== -1) sdBody.seed = seed;
      // サンプラー名は省略するとデフォルト (SDXL用は euler_a が自動選択)
      // 明示指定しない方が互換性が高い

      const sdResp = await fetch(`http://127.0.0.1:${port}/sdapi/v1/txt2img`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sdBody),
        signal: ctrl.signal,
      }).finally(() => clearTimeout(timer));
      if (!sdResp.ok) {
        const errText = await sdResp.text().catch(() => '');
        throw new Error(`sd-server エラー ${sdResp.status}: ${errText.slice(0, 200)}`);
      }
      const sdData = await sdResp.json();
      if (!sdData.images || sdData.images.length === 0) {
        throw new Error('sd-serverから画像が返されませんでした');
      }

      // base64 PNG をデコードして保存
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const fileName = `sd_${ts}_${rand}_${i}.png`;
      const uploadsDir = path.join(__dirname, 'public', 'uploads');
      if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
      const filePath = path.join(uploadsDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(sdData.images[0], 'base64'));
      generatedUrls.push(`/uploads/${fileName}`);
    } catch (e) {
      // 部分的に成功している場合もあるので、エラーでも続行
      log(ip, `[IMAGE-GEN] error: ${e.message}`);
      if (generatedUrls.length === 0) {
        return res.status(500).json({ error: e.message });
      }
      break;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(ip, `[IMAGE-GEN] 完了: ${generatedUrls.length}枚, ${elapsed}秒, prompt="${prompt.slice(0, 60)}"`);

  res.json({
    ok: true,
    images: generatedUrls,
    model: targetModel,
    prompt,
    negativePrompt,
    parameters: { width, height, steps, cfgScale, sampler },
    elapsed: Number(elapsed),
  });
});

// 手動でモデル停止
app.post('/image-gen/unload', requireAuth, async (req, res) => {
  const ip = getIP(req);
  log(ip, '[IMAGE-GEN] 手動アンロード');
  await stopImageModel();
  res.json({ ok: true });
});

// ════════════════════════════════════════════════
// ファインチューニング機能
// ════════════════════════════════════════════════

const TUNING_DIR = path.join(__dirname, 'tuning');
const TUNING_DATA_DIR = path.join(TUNING_DIR, 'datasets');
const TUNING_RUNS_DIR = path.join(TUNING_DIR, 'runs');
const TUNING_SAMPLES_FILE = path.join(TUNING_DIR, 'samples.jsonl');
const TUNING_JOBS_FILE = path.join(TUNING_DIR, 'jobs.json');

// ディレクトリ作成
for (const d of [TUNING_DIR, TUNING_DATA_DIR, TUNING_RUNS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

let currentTuningJob = null;  // 実行中ジョブ { id, proc, ... }

// ─── 学習サンプル管理 ───
// JSONLファイルで管理。1行 = 1サンプル
// {id, instruction, response, system?, createdAt, tags?}

function loadAllSamples() {
  if (!fs.existsSync(TUNING_SAMPLES_FILE)) return [];
  try {
    return fs.readFileSync(TUNING_SAMPLES_FILE, 'utf-8')
      .split('\n')
      .filter(line => line.trim())
      .map(line => JSON.parse(line));
  } catch (e) {
    log('-', `[tuning] サンプル読み込みエラー: ${e.message}`);
    return [];
  }
}

function saveAllSamples(samples) {
  const data = samples.map(s => JSON.stringify(s)).join('\n') + (samples.length > 0 ? '\n' : '');
  fs.writeFileSync(TUNING_SAMPLES_FILE, data);
}

function generateSampleId() {
  return 's_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// 学習用のプリセット情報を返す（config.json の tuning.modelPresets から）
app.get('/tuning/presets', requireAuth, (req, res) => {
  const presets = appConfig.tuning?.modelPresets || [];
  res.json({ presets });
});

// 全サンプル取得
app.get('/tuning/samples', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  res.json({ samples, count: samples.length });
});

// サンプル追加（1件）
app.post('/tuning/samples', requireAuth, jsonParser, (req, res) => {
  const { instruction, response, system, tags } = req.body || {};
  if (!instruction || !response) {
    return res.status(400).json({ error: 'instruction と response は必須です' });
  }
  const samples = loadAllSamples();
  const newSample = {
    id: generateSampleId(),
    instruction: String(instruction),
    response: String(response),
    system: system ? String(system) : '',
    tags: Array.isArray(tags) ? tags : [],
    createdAt: Date.now(),
  };
  samples.push(newSample);
  saveAllSamples(samples);
  res.json({ ok: true, sample: newSample, total: samples.length });
});

// サンプル更新
app.put('/tuning/samples/:id', requireAuth, jsonParser, (req, res) => {
  const samples = loadAllSamples();
  const idx = samples.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const { instruction, response, system, tags } = req.body || {};
  if (instruction !== undefined) samples[idx].instruction = String(instruction);
  if (response !== undefined) samples[idx].response = String(response);
  if (system !== undefined) samples[idx].system = String(system);
  if (tags !== undefined) samples[idx].tags = Array.isArray(tags) ? tags : [];
  samples[idx].updatedAt = Date.now();
  saveAllSamples(samples);
  res.json({ ok: true, sample: samples[idx] });
});

// サンプル削除
app.delete('/tuning/samples/:id', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  const idx = samples.findIndex(s => s.id === req.params.id);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  const removed = samples.splice(idx, 1)[0];
  saveAllSamples(samples);
  res.json({ ok: true, removed });
});

// 全サンプル削除
app.delete('/tuning/samples', requireAuth, (req, res) => {
  saveAllSamples([]);
  res.json({ ok: true });
});

// CSV/JSONLインポート
app.post('/tuning/samples/import', requireAuth, jsonParser, (req, res) => {
  const { format, content } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content が必要です' });
  const samples = loadAllSamples();
  let added = 0;
  try {
    if (format === 'jsonl') {
      const lines = content.split('\n').filter(l => l.trim());
      for (const line of lines) {
        const obj = JSON.parse(line);
        if (!obj.instruction || !obj.response) continue;
        samples.push({
          id: generateSampleId(),
          instruction: String(obj.instruction),
          response: String(obj.response),
          system: obj.system ? String(obj.system) : '',
          tags: Array.isArray(obj.tags) ? obj.tags : [],
          createdAt: Date.now(),
        });
        added++;
      }
    } else if (format === 'csv') {
      // 簡易CSVパーサー: 1行目をヘッダーとして使う
      const lines = content.split('\n').filter(l => l.trim());
      if (lines.length < 2) return res.status(400).json({ error: 'CSVが空です' });
      const headers = parseCsvLine(lines[0]).map(h => h.trim().toLowerCase());
      const instructionIdx = headers.indexOf('instruction');
      const responseIdx = headers.indexOf('response');
      const systemIdx = headers.indexOf('system');
      if (instructionIdx < 0 || responseIdx < 0) {
        return res.status(400).json({ error: 'CSVに instruction と response カラムが必要です' });
      }
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvLine(lines[i]);
        if (cols.length <= Math.max(instructionIdx, responseIdx)) continue;
        const instruction = (cols[instructionIdx] || '').trim();
        const response = (cols[responseIdx] || '').trim();
        if (!instruction || !response) continue;
        samples.push({
          id: generateSampleId(),
          instruction,
          response,
          system: systemIdx >= 0 ? (cols[systemIdx] || '').trim() : '',
          tags: [],
          createdAt: Date.now(),
        });
        added++;
      }
    } else {
      return res.status(400).json({ error: 'format は "csv" または "jsonl"' });
    }
    saveAllSamples(samples);
    res.json({ ok: true, added, total: samples.length });
  } catch (e) {
    res.status(400).json({ error: `パースエラー: ${e.message}` });
  }
});

// シンプルなCSV行パーサー（クォート対応）
function parseCsvLine(line) {
  const result = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') { inQuote = false; }
      else { cur += c; }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { result.push(cur); cur = ''; }
      else cur += c;
    }
  }
  result.push(cur);
  return result;
}

// エクスポート (JSONL形式でダウンロード)
app.get('/tuning/samples/export', requireAuth, (req, res) => {
  const samples = loadAllSamples();
  const jsonl = samples.map(s => JSON.stringify({
    instruction: s.instruction,
    response: s.response,
    system: s.system || undefined,
    tags: s.tags && s.tags.length > 0 ? s.tags : undefined,
  })).join('\n');
  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Content-Disposition', 'attachment; filename="training_samples.jsonl"');
  res.send(jsonl);
});

// ─── ジョブ管理 ───

function loadJobs() {
  if (!fs.existsSync(TUNING_JOBS_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(TUNING_JOBS_FILE, 'utf-8'));
  } catch { return []; }
}

function saveJobs(jobs) {
  fs.writeFileSync(TUNING_JOBS_FILE, JSON.stringify(jobs, null, 2));
}

function generateJobId() {
  return 'j_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ジョブ一覧
app.get('/tuning/jobs', requireAuth, (req, res) => {
  const jobs = loadJobs();
  res.json({ jobs, current: currentTuningJob ? currentTuningJob.id : null });
});

// ジョブ開始
app.post('/tuning/jobs', requireAuth, jsonParser, async (req, res) => {
  const ip = getIP(req);
  if (currentTuningJob) {
    return res.status(409).json({ error: '既にジョブが実行中です' });
  }
  const samples = loadAllSamples();
  if (samples.length === 0) {
    return res.status(400).json({ error: '学習サンプルがありません' });
  }
  const {
    baseModel,           // HuggingFace model ID (例: "Qwen/Qwen2.5-7B-Instruct")
    outputName,          // 出力モデル名 (任意)
    method = 'lora',     // 'lora' | 'qlora' | 'full'
    epochs = 3,
    learningRate = 0.0002,
    batchSize = 2,
    gradAccumSteps = 4,
    loraR = 16,
    loraAlpha = 32,
    loraDropout = 0.05,
    maxSeqLength = 2048,
    systemPrompt = '',   // 全サンプルに適用するデフォルトsystem
  } = req.body || {};

  if (!baseModel) return res.status(400).json({ error: 'baseModel を指定してください' });

  const jobId = generateJobId();
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // 学習データを JSONL で保存
  const dataPath = path.join(jobDir, 'train.jsonl');
  fs.writeFileSync(dataPath, samples.map(s => JSON.stringify({
    instruction: s.instruction,
    response: s.response,
    system: s.system || '',
  })).join('\n'));

  // 設定保存
  const config = {
    jobId,
    baseModel,
    outputName: outputName || `tuned-${jobId}`,
    method, epochs, learningRate, batchSize, gradAccumSteps,
    loraR, loraAlpha, loraDropout, maxSeqLength,
    systemPrompt,
    sampleCount: samples.length,
    startedAt: Date.now(),
  };
  fs.writeFileSync(path.join(jobDir, 'config.json'), JSON.stringify(config, null, 2));

  // Python実行
  const pythonPath = appConfig.tuning?.pythonPath || appConfig.pythonPath || 'python3';
  const tuneScript = path.join(__dirname, 'tune_runner.py');
  if (!fs.existsSync(tuneScript)) {
    return res.status(500).json({ error: `tune_runner.py が見つかりません: ${tuneScript}` });
  }

  log(ip, `TUNING START: ${jobId} baseModel=${baseModel} samples=${samples.length}`);
  const logPath = path.join(jobDir, 'training.log');
  const logStream = fs.createWriteStream(logPath);
  // 環境変数: AMD Radeon AI PRO R9700 (gfx1201) 安定化対策
  // config.json の tuning.env で上書き可能（旧 tuningEnv も互換維持）
  const tuningEnv = {
    HSA_OVERRIDE_GFX_VERSION: '12.0.1',
    PYTORCH_HIP_ALLOC_CONF: 'expandable_segments:True',
    HIP_VISIBLE_DEVICES: '0',  // 単一GPU限定（マルチGPU環境での暴走防止）
    ...(appConfig.tuning?.env || appConfig.tuningEnv || {}),
  };
  const proc = spawn(pythonPath, [tuneScript, jobDir], {
    cwd: __dirname,
    env: { ...process.env, ...tuningEnv, JOB_DIR: jobDir },
  });
  proc.stdout.on('data', d => logStream.write(d));
  proc.stderr.on('data', d => logStream.write(d));
  proc.on('exit', (code) => {
    logStream.end();
    const jobs = loadJobs();
    const j = jobs.find(j => j.id === jobId);
    if (j) {
      j.status = code === 0 ? 'completed' : 'failed';
      j.exitCode = code;
      j.endedAt = Date.now();
      saveJobs(jobs);
    }
    log('-', `[tuning ${jobId}] 終了 code=${code}`);
    currentTuningJob = null;
  });

  // ジョブ記録に追加
  const jobs = loadJobs();
  jobs.unshift({
    id: jobId, ...config,
    status: 'running',
    pid: proc.pid,
  });
  saveJobs(jobs);
  currentTuningJob = { id: jobId, proc, dir: jobDir };

  res.json({ ok: true, jobId });
});

// ジョブログ取得
app.get('/tuning/jobs/:id/log', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const logPath = path.join(TUNING_RUNS_DIR, jobId, 'training.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'ログがありません' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fs.createReadStream(logPath).pipe(res);
});

// ジョブ中断
app.post('/tuning/jobs/:id/stop', requireAuth, (req, res) => {
  if (!currentTuningJob || currentTuningJob.id !== req.params.id) {
    return res.status(404).json({ error: '実行中ジョブではありません' });
  }
  try { currentTuningJob.proc.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    if (currentTuningJob && currentTuningJob.proc) {
      try { currentTuningJob.proc.kill('SIGKILL'); } catch {}
    }
  }, 5000);
  const jobs = loadJobs();
  const j = jobs.find(j => j.id === req.params.id);
  if (j) { j.status = 'cancelled'; j.endedAt = Date.now(); saveJobs(jobs); }
  res.json({ ok: true });
});

// ジョブ削除（履歴とアーティファクトを消す）
app.delete('/tuning/jobs/:id', requireAuth, (req, res) => {
  const jobId = req.params.id;
  if (currentTuningJob && currentTuningJob.id === jobId) {
    return res.status(409).json({ error: '実行中ジョブは削除できません。先に停止してください' });
  }
  const jobs = loadJobs();
  const idx = jobs.findIndex(j => j.id === jobId);
  if (idx < 0) return res.status(404).json({ error: 'Not found' });
  jobs.splice(idx, 1);
  saveJobs(jobs);
  // ディレクトリ削除
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (fs.existsSync(jobDir)) {
    try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}
  }
  res.json({ ok: true });
});

// ─── 後工程: マージ + GGUF + 量子化 ───
// 学習完了後にアダプタをベースモデルにマージし、GGUF化、必要なら量子化する
//
// POST /tuning/jobs/:id/postprocess
// body: { quantize?: "Q4_K_M" | "Q5_K_M" | "Q8_0" | "f16" | null }
//
// 内部的に下記を順次実行（バックグラウンド）:
//   1. python merge_adapter.py <job_dir>             → <job_dir>/merged/
//   2. python convert_hf_to_gguf.py merged --outfile <out>.gguf --outtype f16
//   3. llama-quantize <out>.gguf <out>-Q4_K_M.gguf Q4_K_M  (任意)

let currentPostprocess = null;  // { jobId, proc, step }

app.post('/tuning/jobs/:id/postprocess', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  if (currentPostprocess) {
    return res.status(409).json({ error: '別の後処理が実行中です' });
  }
  const jobId = req.params.id;
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'ジョブが見つかりません' });

  const adapterDir = path.join(jobDir, 'adapter');
  if (!fs.existsSync(adapterDir)) {
    return res.status(400).json({ error: '学習が完了していません（adapterがありません）' });
  }

  const { quantize = null, llamaCppDir = null } = req.body || {};
  const validQuants = ['Q2_K', 'Q3_K_M', 'Q4_K_S', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'f16', 'bf16', null];
  if (quantize !== null && !validQuants.includes(quantize)) {
    return res.status(400).json({ error: `quantize は次のいずれか: ${validQuants.join(', ')}` });
  }

  const jobConfig = JSON.parse(fs.readFileSync(path.join(jobDir, 'config.json'), 'utf-8'));
  const outputName = jobConfig.outputName || `tuned-${jobId}`;

  // llama.cpp ディレクトリ
  const llamaDir = llamaCppDir || appConfig.tuning?.llamaCppDir || appConfig.llamaCppDir || path.join(process.env.HOME || '', 'llama.cpp');
  if (!fs.existsSync(llamaDir)) {
    return res.status(400).json({
      error: `llama.cpp ディレクトリが見つかりません: ${llamaDir} (config.json で llamaCppDir を指定するか、~/llama.cpp に配置してください)`
    });
  }

  const postLogPath = path.join(jobDir, 'postprocess.log');
  const postLog = fs.createWriteStream(postLogPath);
  const pythonPath = appConfig.tuning?.pythonPath || appConfig.pythonPath || 'python3';

  function runStep(label, cmd, args, cwd, onDone) {
    postLog.write(`\n=== ${label} ===\n`);
    postLog.write(`$ ${cmd} ${args.join(' ')}\n`);
    const p = spawn(cmd, args, { cwd, env: { ...process.env } });
    currentPostprocess = { jobId, proc: p, step: label };
    p.stdout.on('data', d => postLog.write(d));
    p.stderr.on('data', d => postLog.write(d));
    p.on('exit', (code) => {
      postLog.write(`\n[${label}] exit code=${code}\n`);
      onDone(code);
    });
  }

  function step1Merge() {
    const mergeScript = path.join(__dirname, 'merge_adapter.py');
    if (!fs.existsSync(mergeScript)) {
      postLog.end(`ERROR: merge_adapter.py が見つかりません: ${mergeScript}\n`);
      currentPostprocess = null;
      return;
    }
    runStep('Step 1: マージ', pythonPath, [mergeScript, jobDir], __dirname, (code) => {
      if (code !== 0) { postLog.end(`マージ失敗 code=${code}\n`); currentPostprocess = null; return; }
      step2Gguf();
    });
  }

  function step2Gguf() {
    const mergedDir = path.join(jobDir, 'merged');
    if (!fs.existsSync(mergedDir)) {
      postLog.end(`ERROR: マージ済みモデルがありません: ${mergedDir}\n`);
      currentPostprocess = null;
      return;
    }
    const convertScript = path.join(llamaDir, 'convert_hf_to_gguf.py');
    if (!fs.existsSync(convertScript)) {
      postLog.end(`ERROR: convert_hf_to_gguf.py が見つかりません: ${convertScript}\n`);
      currentPostprocess = null;
      return;
    }
    const ggufFile = path.join(jobDir, `${outputName}.gguf`);
    runStep('Step 2: GGUF変換',
      pythonPath, [convertScript, mergedDir, '--outfile', ggufFile, '--outtype', 'f16'],
      llamaDir,
      (code) => {
        if (code !== 0) { postLog.end(`GGUF変換失敗 code=${code}\n`); currentPostprocess = null; return; }
        if (quantize && quantize !== 'f16' && quantize !== 'bf16') step3Quantize(ggufFile);
        else finalize(ggufFile);
      });
  }

  function step3Quantize(ggufFile) {
    const quantBin = path.join(llamaDir, 'build', 'bin', 'llama-quantize');
    if (!fs.existsSync(quantBin)) {
      postLog.end(`ERROR: llama-quantize が見つかりません: ${quantBin}\n`);
      currentPostprocess = null;
      return;
    }
    const quantFile = path.join(jobDir, `${outputName}-${quantize}.gguf`);
    runStep(`Step 3: 量子化 (${quantize})`,
      quantBin, [ggufFile, quantFile, quantize],
      llamaDir,
      (code) => {
        if (code !== 0) { postLog.end(`量子化失敗 code=${code}\n`); currentPostprocess = null; return; }
        finalize(quantFile);
      });
  }

  function finalize(finalGgufFile) {
    // ファイルサイズ取得（人間に読める形式に変換）
    let fileSizeStr = '';
    if (finalGgufFile && fs.existsSync(finalGgufFile)) {
      const sizeBytes = fs.statSync(finalGgufFile).size;
      const sizeMB = sizeBytes / (1024 * 1024);
      const sizeGB = sizeMB / 1024;
      fileSizeStr = sizeGB >= 1 ? `${sizeGB.toFixed(2)} GB` : `${sizeMB.toFixed(1)} MB`;
    }

    postLog.write('\n');
    postLog.write('=====================================================\n');
    postLog.write('  ✅ 後処理完了\n');
    postLog.write('=====================================================\n');
    if (finalGgufFile) {
      postLog.write(`\n📦 生成されたGGUFファイル:\n`);
      postLog.write(`   ${finalGgufFile}\n`);
      if (fileSizeStr) postLog.write(`   (サイズ: ${fileSizeStr})\n`);
      postLog.write(`\n💡 使い方:\n`);
      postLog.write(`   1) config.json の models[] にこのパスを追加してチャットに組み込み\n`);
      postLog.write(`   2) または llama-server で直接起動:\n`);
      postLog.write(`      llama-server -m "${finalGgufFile}" --port 8080 -c 4096 -ngl 99 -fa on\n`);
    }
    postLog.write('\n');
    postLog.end();

    // ジョブ情報に postprocess 完了 + 最終GGUFパスを記録
    const jobs = loadJobs();
    const j = jobs.find(j => j.id === jobId);
    if (j) {
      j.postprocessStatus = 'completed';
      j.postprocessEndedAt = Date.now();
      if (finalGgufFile) {
        j.ggufPath = finalGgufFile;
        try {
          j.ggufSize = fs.statSync(finalGgufFile).size;
        } catch {}
      }
      saveJobs(jobs);
    }
    currentPostprocess = null;
    log('-', `[tuning ${jobId}] 後処理完了 → ${finalGgufFile || '(GGUF生成なし)'}`);
  }

  log(ip, `TUNING POSTPROCESS START: ${jobId} quantize=${quantize}`);
  step1Merge();
  res.json({ ok: true, message: '後処理を開始しました。/tuning/jobs/:id/postprocess-log でログを確認できます' });
});

// 後処理ログ取得
app.get('/tuning/jobs/:id/postprocess-log', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const logPath = path.join(TUNING_RUNS_DIR, jobId, 'postprocess.log');
  if (!fs.existsSync(logPath)) return res.status(404).json({ error: 'ログがありません' });
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  fs.createReadStream(logPath).pipe(res);
});

// 後処理停止
app.post('/tuning/jobs/:id/postprocess/stop', requireAuth, (req, res) => {
  if (!currentPostprocess || currentPostprocess.jobId !== req.params.id) {
    return res.status(404).json({ error: '後処理は実行中ではありません' });
  }
  try { currentPostprocess.proc.kill('SIGTERM'); } catch {}
  res.json({ ok: true });
});

// ジョブのアーティファクト一覧（gguf等）
app.get('/tuning/jobs/:id/artifacts', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const jobDir = path.join(TUNING_RUNS_DIR, jobId);
  if (!fs.existsSync(jobDir)) return res.status(404).json({ error: 'ジョブが見つかりません' });
  const artifacts = [];
  for (const f of fs.readdirSync(jobDir)) {
    const fp = path.join(jobDir, f);
    const st = fs.statSync(fp);
    if (st.isFile()) {
      artifacts.push({
        name: f,
        size: st.size,
        sizeHuman: (st.size > 1024 * 1024) ? `${(st.size / 1024 / 1024).toFixed(1)} MB` : `${(st.size / 1024).toFixed(1)} KB`,
        downloadable: f.endsWith('.gguf') || f.endsWith('.log') || f.endsWith('.json'),
      });
    }
  }
  res.json({ artifacts, jobDir });
});

// アーティファクトダウンロード
app.get('/tuning/jobs/:id/artifacts/:name', requireAuth, (req, res) => {
  const jobId = req.params.id;
  const name = req.params.name;
  // ディレクトリトラバーサル防止
  if (name.includes('..') || name.includes('/') || name.includes('\\')) {
    return res.status(400).json({ error: 'Invalid name' });
  }
  const fp = path.join(TUNING_RUNS_DIR, jobId, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  fs.createReadStream(fp).pipe(res);
});

// ─── GPU ステータス (SSE) ───
const GPU_INTERVAL = parseInt(process.env.GPU_INTERVAL) || 1000;
let gpuBackend = null; // 'amd' | 'rocm' | 'nvidia' | 'none'

// 初回のみフィールド一覧をログに出力
let amdSmiFieldsLogged = false;
let rocmSmiFieldsLogged = false;

// amd-smi はROCm 6.x以降の新しい標準ツール
// 出力構造:
//   { "gpu_data": [ { gpu: 0, asic: {...}, vram: {...}, clock: {...}, ... }, ... ] }
// 注意: トップレベルは "gpu_data" でラップされている（配列ではない）

function execAmdSmi(args) {
  return new Promise((resolve) => {
    const proc = spawn('amd-smi', args, { timeout: 5000 });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const parsed = JSON.parse(out);
        // gpu_data でラップされている場合はその中身を返す、そうでなければそのまま
        if (parsed && Array.isArray(parsed.gpu_data)) return resolve(parsed.gpu_data);
        if (Array.isArray(parsed)) return resolve(parsed);
        resolve(null);
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
}

// 値ヘルパー
function amdVal(v) {
  if (v == null || v === 'N/A') return 0;
  if (typeof v === 'number') return v;
  if (typeof v === 'object' && v.value != null && v.value !== 'N/A') return parseFloat(v.value) || 0;
  return parseFloat(v) || 0;
}

// 文字列から先頭の数値を抜き出す ("1040MHz" → 1040)
function amdParseClock(s) {
  if (!s || s === 'N/A') return 0;
  if (typeof s === 'object') {
    return amdParseClock(s.current_frequency ?? s.value ?? s.current);
  }
  const m = String(s).match(/(\d+(?:\.\d+)?)/);
  return m ? parseInt(m[1]) : 0;
}

async function parseAmdSmi() {
  const [staticData, metricData] = await Promise.all([
    execAmdSmi(['static', '--json']),
    execAmdSmi(['metric', '--json']),
  ]);

  // staticData だけでも基本情報は出せるよう、両方なくても落ちないように
  const staticArr = Array.isArray(staticData) ? staticData : [];
  const metricArr = Array.isArray(metricData) ? metricData : [];

  // gpu番号でstatic/metricをマップ化
  const staticByGpu = {};
  for (const item of staticArr) {
    const num = item.gpu ?? item.gpu_id;
    if (typeof num === 'number') staticByGpu[num] = item;
  }
  const metricByGpu = {};
  for (const item of metricArr) {
    const num = item.gpu ?? item.gpu_id;
    if (typeof num === 'number') metricByGpu[num] = item;
  }

  // staticとmetricのGPU番号を統合
  const allGpuNums = new Set([
    ...Object.keys(staticByGpu).map(Number),
    ...Object.keys(metricByGpu).map(Number),
  ]);

  const gpus = [];
  for (const gpuNum of [...allGpuNums].sort((a, b) => a - b)) {
    const st = staticByGpu[gpuNum] || {};
    const mt = metricByGpu[gpuNum] || {};

    if (!amdSmiFieldsLogged) {
      console.log(`[amd-smi gpu${gpuNum}] static キー:`, Object.keys(st).sort());
      console.log(`[amd-smi gpu${gpuNum}] metric キー:`, Object.keys(mt).sort());
      for (const k of ['power', 'temperature', 'usage', 'mem_usage', 'fb_usage']) {
        if (mt[k]) console.log(`  metric.${k}:`, JSON.stringify(mt[k]).slice(0, 200));
      }
    }

    const asic = st.asic || mt.asic || {};
    const vram = st.vram || {};
    const clock = st.clock || mt.clock || {};

    // ─── iGPU除外 ───
    // 1. target_graphics_version で gfx10[345]x はiGPU（Phoenix, Raphael, Rembrandt等）
    // 2. compute units が極端に少ない（R9700は64、iGPU Raphael は2）
    // 3. VRAMサイズが2GB以下
    const gfxVer = asic.target_graphics_version || '';
    const numCU = asic.num_compute_units || 0;
    const vramMB = amdVal(vram.size);
    const isIGPU =
      /^gfx10(3[3-9]|4[0-9])/.test(gfxVer) ||  // gfx103x/104x はAPU
      (numCU > 0 && numCU < 8) ||              // 8CU未満はiGPU
      (vramMB > 0 && vramMB <= 4096);          // VRAM 4GB以下はiGPU
    if (isIGPU) continue;

    const gpu = { id: `gpu${gpuNum}` };

    // ─── 製品名 (static.asic.market_name が確実) ───
    gpu.name = asic.market_name || asic.product_name ||
               (st.board?.product_name && st.board.product_name !== 'N/A' ? st.board.product_name : null) ||
               '';
    if (typeof gpu.name === 'object') gpu.name = '';
    gpu.name = String(gpu.name || '').trim();
    if (/^(n\/a|none|null|unknown)$/i.test(gpu.name)) gpu.name = '';

    // ─── 使用率 ───
    const usage = mt.usage || {};
    gpu.usage = parseInt(amdVal(usage.gfx_activity ?? usage.gpu_activity)) || 0;

    // ─── 温度 ───
    const temp = mt.temperature || {};
    gpu.temp = amdVal(temp.edge ?? temp.edge_temperature);
    gpu.tempHotspot = amdVal(temp.hotspot ?? temp.junction ?? temp.hotspot_temperature);
    gpu.tempMem = amdVal(temp.mem ?? temp.memory ?? temp.vram ?? temp.hbm);

    // ─── 電力 ───
    const power = mt.power || {};
    gpu.power = amdVal(power.current_socket_power ?? power.socket_power ??
                        power.average_socket_power ?? power.gfx);

    // ─── VRAM ───
    // amd-smi 26.x では mem_usage を使う (旧バージョンでは fb_usage / vram_usage)
    // static.vram.size.value = 30576 (MB) を総容量として優先
    const mem = mt.mem_usage || mt.fb_usage || mt.vram_usage || {};
    // 使用量フィールド候補: used_vram (amd-smi 26.x) / used / vram_used
    const totalMB = vramMB || amdVal(mem.total_vram ?? mem.total ?? mem.vram_total);
    const usedMB = amdVal(mem.used_vram ?? mem.used ?? mem.vram_used);
    gpu.vramTotalMB = totalMB;
    gpu.vramUsedMB = usedMB;
    gpu.vramPct = totalMB > 0 ? Math.round(usedMB / totalMB * 100) : 0;

    // ─── クロック ("1040MHz" 形式) ───
    // static.clock.sys.current_frequency や metric.clock.gfx を見る
    gpu.sclk = amdParseClock(clock.sys ?? clock.gfx ?? clock.gfxclk);
    gpu.mclk = amdParseClock(clock.mem ?? clock.memclk ?? clock.memory);

    gpus.push(gpu);
  }

  amdSmiFieldsLogged = true;
  return gpus;
}

function parseRocmSmi() {
  return new Promise((resolve) => {
    const proc = spawn('rocm-smi', ['--showuse', '-t', '-P', '--showmeminfo', 'vram', '-c', '--json'], {
      timeout: 5000,
    });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const data = JSON.parse(out);
        const gpus = [];
        for (const [key, val] of Object.entries(data)) {
          if (!key.startsWith('card')) continue;
          const gpu = { id: key };

          // 初回のみフィールド名を全部ログ出力（デバッグ用）
          if (!rocmSmiFieldsLogged) {
            console.log(`[rocm-smi ${key}] 利用可能なフィールド:`, Object.keys(val).sort());
          }

          // GPU使用率
          gpu.usage = parseInt(val['GPU use (%)']) || 0;

          // 温度
          gpu.temp = parseFloat(val['Temperature (Sensor edge) (C)']) || 0;
          gpu.tempHotspot = parseFloat(val['Temperature (Sensor junction) (C)']) || 0;
          gpu.tempMem = parseFloat(val['Temperature (Sensor memory) (C)']) || 0;

          // 電力 (キー名がカードによって異なる)
          const powerKey = Object.keys(val).find(k => /power/i.test(k) && /\(W\)/.test(k));
          gpu.power = powerKey ? parseFloat(val[powerKey]) || 0 : 0;

          // VRAM (バイト → MB)
          const vramTotal = parseInt(val['VRAM Total Memory (B)']) || 0;
          const vramUsed = parseInt(val['VRAM Total Used Memory (B)']) || 0;
          gpu.vramTotalMB = Math.round(vramTotal / 1048576);
          gpu.vramUsedMB = Math.round(vramUsed / 1048576);
          gpu.vramPct = vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0;

          // クロック (値が "(3480Mhz)" 形式)
          const parseClock = (key) => {
            const v = val[key];
            if (!v) return 0;
            const m = v.match(/\((\d+)Mhz\)/i);
            return m ? parseInt(m[1]) : 0;
          };
          gpu.sclk = parseClock('sclk clock speed:');
          gpu.mclk = parseClock('mclk clock speed:');

          // GPU 製品名: rocm-smi のバージョンで大きく変動するので幅広く探す
          // 完全マッチで試したあと、見つからなければ部分マッチで探す
          const exactKeys = [
            'Card Series', 'Card Model', 'Card SKU',
            'GFX Version', 'Device Name', 'Product Name', 'Marketing Name',
          ];
          for (const k of exactKeys) {
            if (val[k] && typeof val[k] === 'string' && val[k].trim()) {
              gpu.name = val[k].trim();
              break;
            }
          }
          // 部分マッチ: "name", "series", "model", "product" を含むキー
          if (!gpu.name) {
            const fallbackKey = Object.keys(val).find(k =>
              /\b(name|series|model|product|marketing)\b/i.test(k) &&
              !/path|node|number|id|guid|uuid|firmware|driver|version|date|count|level/i.test(k)
            );
            if (fallbackKey && val[fallbackKey]) {
              gpu.name = String(val[fallbackKey]).trim();
            }
          }
          // "0x73a5" のような16進ID形式は捨てる
          if (gpu.name && /^0x[0-9a-f]+$/i.test(gpu.name)) gpu.name = '';
          // "N/A" や空文字も捨てる
          if (gpu.name && /^(n\/a|none|null|unknown)$/i.test(gpu.name)) gpu.name = '';

          gpus.push(gpu);
        }
        rocmSmiFieldsLogged = true;
        // card番号でソート
        gpus.sort((a, b) => {
          const na = parseInt(a.id.replace('card', ''));
          const nb = parseInt(b.id.replace('card', ''));
          return na - nb;
        });
        resolve(gpus);
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

function parseNvidiaSmi() {
  return new Promise((resolve) => {
    const proc = spawn('nvidia-smi', [
      '--query-gpu=index,name,utilization.gpu,temperature.gpu,power.draw,clocks.gr,clocks.mem,memory.total,memory.used',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000 });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.stderr.on('data', () => {});
    proc.on('close', () => {
      try {
        const gpus = [];
        for (const line of out.trim().split('\n')) {
          if (!line.trim()) continue;
          const cols = line.split(',').map(s => s.trim());
          if (cols.length < 9) continue;
          const vramTotal = parseFloat(cols[7]) || 0;
          const vramUsed = parseFloat(cols[8]) || 0;
          gpus.push({
            id: `GPU ${cols[0]}`,
            name: cols[1],
            usage: parseInt(cols[2]) || 0,
            temp: parseFloat(cols[3]) || 0,
            tempHotspot: 0,
            tempMem: 0,
            power: parseFloat(cols[4]) || 0,
            sclk: parseInt(cols[5]) || 0,
            mclk: parseInt(cols[6]) || 0,
            vramTotalMB: Math.round(vramTotal),
            vramUsedMB: Math.round(vramUsed),
            vramPct: vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0,
          });
        }
        resolve(gpus);
      } catch {
        resolve([]);
      }
    });
    proc.on('error', () => resolve([]));
  });
}

async function queryGpu() {
  if (gpuBackend === 'none') return [];
  if (gpuBackend === 'amd') return parseAmdSmi();
  if (gpuBackend === 'nvidia') return parseNvidiaSmi();
  if (gpuBackend === 'rocm') return parseRocmSmi();

  // 初回: 自動検出（amd-smi → rocm-smi → nvidia-smi の順）
  // amd-smi はROCm 6.x以降の新標準。GPU名やセンサー値が正確に取れる
  const amd = await parseAmdSmi();
  if (amd.length > 0) { gpuBackend = 'amd'; console.log('  GPU backend: amd-smi'); return amd; }
  const rocm = await parseRocmSmi();
  if (rocm.length > 0) { gpuBackend = 'rocm'; console.log('  GPU backend: rocm-smi'); return rocm; }
  const nv = await parseNvidiaSmi();
  if (nv.length > 0) { gpuBackend = 'nvidia'; console.log('  GPU backend: nvidia-smi'); return nv; }
  gpuBackend = 'none';
  console.log('  GPU backend: none (amd-smi / rocm-smi / nvidia-smi not found)');
  return [];
}

app.get('/sse/gpu', requireAuth, (req, res) => {
  const ip = getIP(req);
  log(ip, 'SSE GPU connected');
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // 即座にキャッシュを送信（updateAllGpuDataはバックグラウンドタイマーが行う）
  const send = () => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify(buildGpuSseData())}\n\n`);
    }
  };

  send();
  const timer = setInterval(send, GPU_INTERVAL);

  req.on('close', () => {
    clearInterval(timer);
    log(ip, 'SSE GPU disconnected');
  });
});

// ─── アプリ設定配信 ───

// ─── セッショントークン管理 ───
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24時間
const sessions = new Map(); // token → { ip, expiresAt }

function newSession(ip) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { ip, expiresAt: Date.now() + SESSION_TTL });
  return token;
}

function isValidSession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

// 期限切れセッションを定期清掃
setInterval(() => {
  const now = Date.now();
  for (const [tok, s] of sessions.entries()) {
    if (s.expiresAt < now) sessions.delete(tok);
  }
}, 60 * 60 * 1000);

// ─── ログイン試行レートリミット ───
const loginAttempts = new Map(); // ip → { count, resetAt }
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15分

function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || rec.resetAt < now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW });
    return true;
  }
  return rec.count < MAX_LOGIN_ATTEMPTS;
}

function recordLoginFail(ip) {
  const rec = loginAttempts.get(ip);
  if (rec) rec.count++;
}

function resetLoginRate(ip) {
  loginAttempts.delete(ip);
}

// ─── パスワード照合（MD5 / SHA-256両対応）───
// MD5: 32文字hex / SHA-256: 64文字hex
function verifyPassword(input, stored) {
  if (!stored) return false;
  const isSha256 = stored.length === 64;
  const algo = isSha256 ? 'sha256' : 'md5';
  const hash = crypto.createHash(algo).update(input || '').digest('hex');
  // タイミング攻撃対策で定時間比較
  if (hash.length !== stored.length) return false;
  return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(stored));
}

// ─── 認証ミドルウェア ───
function requireAuth(req, res, next) {
  if (!appConfig.password) return next(); // パスワード未設定なら認証不要
  // CookieまたはAuthorizationヘッダーからトークン取得
  const cookieToken = (req.headers.cookie || '').split(';')
    .map(c => c.trim())
    .find(c => c.startsWith('wz_session='))?.split('=')[1];
  const headerToken = req.headers['x-auth-token'];
  const token = cookieToken || headerToken;
  if (isValidSession(token)) return next();
  res.status(401).json({ error: '認証が必要です' });
}

app.get('/config', (req, res) => {
  // 公開しない: password, llamaServer内のbinPath, embeddingModelの実体パス
  const { password, llamaServer, embeddingModel, ...rest } = appConfig;
  const safeConfig = {
    ...rest,
    // llamaServer情報は最小限のみ
    llamaServer: { chatPort: llamaServer.chatPort, embeddingPort: llamaServer.embeddingPort },
  };
  safeConfig.hasPassword = !!password;

  // 既存セッションCookieが有効かどうかを判定
  if (password) {
    const cookieToken = (req.headers.cookie || '').split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('wz_session='))?.split('=')[1];
    safeConfig.authenticated = !!(cookieToken && isValidSession(cookieToken));
  } else {
    safeConfig.authenticated = true;
  }

  res.json(safeConfig);
});

// ─── config.json 編集（認証必須・raw JSON） ───
// editconfig.html から呼ばれる。生のJSONファイル内容を返す/保存する。
// 注意:
// - 保存前に必ずバックアップを作成（config.json.bak.<timestamp>）
// - JSON構文チェックを行う
// - 必須トップレベルキー（chatModels, llamaServer等）の存在確認
// - 保存しても運用中の appConfig は再起動するまで反映されない（注意書きをUIに出す）

app.get('/config/raw', requireAuth, (req, res) => {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    res.type('application/json').send(raw);
  } catch (e) {
    res.status(500).json({ error: `読み込み失敗: ${e.message}` });
  }
});

app.post('/config/raw', requireAuth, express.text({ type: '*/*', limit: '5mb' }), (req, res) => {
  const ip = getIP(req);
  const newContent = req.body;
  if (!newContent || typeof newContent !== 'string') {
    return res.status(400).json({ error: '本文がありません' });
  }

  // JSON構文チェック
  let parsed;
  try {
    parsed = JSON.parse(newContent);
  } catch (e) {
    return res.status(400).json({ error: `JSON構文エラー: ${e.message}` });
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed) || parsed === null) {
    return res.status(400).json({ error: 'ルートはオブジェクトである必要があります' });
  }

  // 必須キーの簡易チェック（ある程度の暴発防止）
  const required = ['chatModels', 'llamaServer'];
  const missing = required.filter(k => !(k in parsed));
  if (missing.length > 0) {
    return res.status(400).json({ error: `必須キーが欠落しています: ${missing.join(', ')}` });
  }

  // バックアップ作成
  try {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${CONFIG_FILE}.bak.${ts}`;
    if (fs.existsSync(CONFIG_FILE)) {
      fs.copyFileSync(CONFIG_FILE, backupPath);
    }
    // 古いバックアップを掃除（最新10件のみ保持）
    try {
      const dir = path.dirname(CONFIG_FILE);
      const base = path.basename(CONFIG_FILE);
      const backups = fs.readdirSync(dir)
        .filter(f => f.startsWith(`${base}.bak.`))
        .map(f => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      backups.slice(10).forEach(b => {
        try { fs.unlinkSync(path.join(dir, b.f)); } catch {}
      });
    } catch {}
    // pretty-print して保存
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2));
    log(ip, `CONFIG SAVED: backup=${path.basename(backupPath)}`);
    res.json({ ok: true, backup: path.basename(backupPath) });
  } catch (e) {
    res.status(500).json({ error: `保存失敗: ${e.message}` });
  }
});

// バックアップ一覧
app.get('/config/backups', requireAuth, (req, res) => {
  try {
    const dir = path.dirname(CONFIG_FILE);
    const base = path.basename(CONFIG_FILE);
    const backups = fs.readdirSync(dir)
      .filter(f => f.startsWith(`${base}.bak.`))
      .map(f => {
        const st = fs.statSync(path.join(dir, f));
        return { name: f, mtime: st.mtimeMs, size: st.size };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ backups });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// バックアップから復元
app.post('/config/restore', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name が必要です' });
  // パストラバーサル対策: basename のみ受け付ける
  const safeName = path.basename(name);
  const base = path.basename(CONFIG_FILE);
  if (!safeName.startsWith(`${base}.bak.`)) {
    return res.status(400).json({ error: 'バックアップファイル名ではありません' });
  }
  const fullPath = path.join(path.dirname(CONFIG_FILE), safeName);
  if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'バックアップが見つかりません' });

  try {
    // 現在のconfigを今のタイムスタンプでバックアップ
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(CONFIG_FILE, `${CONFIG_FILE}.bak.${ts}-before-restore`);
    fs.copyFileSync(fullPath, CONFIG_FILE);
    log(ip, `CONFIG RESTORED FROM ${safeName}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: `復元失敗: ${e.message}` });
  }
});

// ─── サーバー再起動 ───
// systemd の Restart=always (または on-failure) に依存して、プロセスを終了 → 自動復活する方式。
// 起動方法に応じた挙動:
//   - systemd 起動: 数秒後に自動復活 ✓
//   - 直接 node server.js: 復活せず、手動で再起動が必要
// クライアントには「再起動可能か」のヒントを返すため /restart/info も用意
app.get('/restart/info', requireAuth, (req, res) => {
  // INVOCATION_ID は systemd 起動時のみ付与される環境変数
  const isSystemd = !!process.env.INVOCATION_ID;
  res.json({
    isSystemd,
    pid: process.pid,
    uptime: process.uptime(),
    nodeVersion: process.version,
  });
});

app.post('/restart', requireAuth, (req, res) => {
  const ip = getIP(req);
  const isSystemd = !!process.env.INVOCATION_ID;
  log(ip, `RESTART requested (systemd=${isSystemd})`);

  if (!isSystemd) {
    // systemd で動いていないなら警告を返すが、ユーザーの意思を尊重して終了は実行する
    // （nodemon や pm2 でも動く可能性があるため）
    log(ip, 'RESTART warning: not running under systemd, may not auto-restart');
  }

  // レスポンスを先に返してから、少し待ってプロセス終了
  res.json({
    ok: true,
    message: isSystemd
      ? 'systemd経由で自動再起動します（数秒以内）'
      : '警告: systemd下ではないため、自動再起動されない可能性があります',
    isSystemd,
  });

  // 進行中のリクエストへの配慮で少し待つ
  setTimeout(() => {
    console.log('[RESTART] Exiting now for systemd to restart...');
    // 外部APIサーバーも停止しておく（自動でやってくれるが念のため）
    try { stopAllExternalServers(); } catch {}
    process.exit(0);
  }, 1500);
});

app.post('/auth', jsonParser, (req, res) => {
  const ip = getIP(req);
  if (!appConfig.password) {
    return res.json({ ok: true, token: null });
  }
  if (!checkLoginRate(ip)) {
    log(ip, 'AUTH rate limited');
    return res.status(429).json({ ok: false, error: 'ログイン試行回数が多すぎます。しばらくしてから再度お試しください。' });
  }
  const { password } = req.body || {};
  if (verifyPassword(password, appConfig.password)) {
    const token = newSession(ip);
    resetLoginRate(ip);
    log(ip, 'AUTH success');
    // HTTPS時（直接or リバースプロキシ経由）は Secure 属性を付与
    const isSecure = HTTPS_ENABLED || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `wz_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL / 1000)}${isSecure ? '; Secure' : ''}`);
    return res.json({ ok: true, token });
  }
  recordLoginFail(ip);
  log(ip, 'AUTH failed');
  return res.status(401).json({ ok: false, error: 'パスワードが正しくありません' });
});

// ─── ユーザーファイルストレージ (public/uploads) ───
const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
// アップロードファイル1個あたりの上限（config.jsonの maxFileSize で変更可能、デフォルト 50MB）
const MAX_FILE_SIZE = (appConfig.maxFileSize || 50) * 1024 * 1024;

// uploadsディレクトリ作成
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

// パス安全性チェック（ディレクトリトラバーサル対策）
function safeUploadPath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null;
  // 先頭の/を除去
  let clean = relativePath.replace(/^[\/\\]+/, '');
  // "uploads/" プレフィックスが付いていたら除去（LLMが付けてくることがある）
  clean = clean.replace(/^(public\/)?uploads[\/\\]/, '');
  // nullバイト拒否
  if (clean.includes('\0')) return null;
  // 絶対パスに解決
  const abs = path.resolve(UPLOADS_DIR, clean);
  // UPLOADS_DIR配下であることを確認
  if (!abs.startsWith(UPLOADS_DIR + path.sep) && abs !== UPLOADS_DIR) return null;
  return abs;
}

// ファイル一覧
app.get('/files', requireAuth, (req, res) => {
  try {
    const walk = (dir, base = '') => {
      const items = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const rel = base ? `${base}/${name}` : name;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            items.push(...walk(full, rel));
          } else if (stat.isFile()) {
            items.push({
              path: rel,
              size: stat.size,
              modified: stat.mtime.toISOString(),
            });
          }
        } catch {}
      }
      return items;
    };
    const files = walk(UPLOADS_DIR);
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    res.json({ files });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ファイル読み込み
app.get('/files/*', requireAuth, (req, res) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > MAX_FILE_SIZE) return res.status(413).json({ error: 'File too large' });

    // バイナリ拡張子の場合は直接配信（画像等）
    const ext = path.extname(abs).toLowerCase();
    const binaryExts = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif', '.webp': 'image/webp',
      '.svg': 'image/svg+xml', '.bmp': 'image/bmp',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4', '.webm': 'video/webm',
      '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
      '.zip': 'application/zip',
    };
    if (binaryExts[ext] || req.query.raw === '1') {
      res.setHeader('Content-Type', binaryExts[ext] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=60');
      log(ip, `FILE READ ${relativePath} (${stat.size} bytes, binary)`);
      return fs.createReadStream(abs).pipe(res);
    }

    // テキストファイルはJSON形式で返す（従来互換）
    const content = fs.readFileSync(abs, 'utf-8');
    log(ip, `FILE READ ${relativePath} (${stat.size} bytes)`);
    res.json({ path: relativePath, size: stat.size, content, modified: stat.mtime.toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ファイル書き込み（新規 or 上書き）
// バイナリファイルのアップロード（multipart/form-data）パーサー
// 単一ファイル想定、依存を増やさない最小実装
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!m) return reject(new Error('No boundary in Content-Type'));
    const boundary = m[1] || m[2];
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_FILE_SIZE + 4096) { // 余裕分のmultipartヘッダ用
        req.destroy();
        return reject(new Error('File too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const buf = Buffer.concat(chunks);
        const boundaryBuf = Buffer.from('--' + boundary);
        const headerSepBuf = Buffer.from('\r\n\r\n');
        // 最初のboundaryを探す
        let start = buf.indexOf(boundaryBuf);
        if (start < 0) return reject(new Error('Boundary not found'));
        start += boundaryBuf.length + 2; // skip CRLF
        const headerEnd = buf.indexOf(headerSepBuf, start);
        if (headerEnd < 0) return reject(new Error('Headers not found'));
        const contentStart = headerEnd + headerSepBuf.length;
        // 終端: \r\n--boundary
        const endBoundary = buf.indexOf(Buffer.from('\r\n--' + boundary), contentStart);
        if (endBoundary < 0) return reject(new Error('End boundary not found'));
        const fileBuf = buf.slice(contentStart, endBoundary);
        resolve(fileBuf);
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

app.post('/files/*', requireAuth, async (req, res, next) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  const ct = req.headers['content-type'] || '';

  // multipart/form-data（バイナリファイル）
  if (ct.startsWith('multipart/form-data')) {
    try {
      const fileBuf = await parseMultipart(req);
      if (fileBuf.length > MAX_FILE_SIZE) {
        return res.status(413).json({ error: `File too large (${fileBuf.length} bytes)` });
      }
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, fileBuf);
      log(ip, `FILE WRITE ${relativePath} (${fileBuf.length} bytes, binary)`);
      return res.json({ ok: true, path: relativePath, size: fileBuf.length });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // application/json（テキストファイル、従来動作）
  jsonParser(req, res, () => {
    const { content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content required (string)' });
    const size = Buffer.byteLength(content, 'utf-8');
    if (size > MAX_FILE_SIZE) return res.status(413).json({ error: `File too large (${size} bytes, max ${MAX_FILE_SIZE})` });
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, 'utf-8');
      log(ip, `FILE WRITE ${relativePath} (${size} bytes)`);
      res.json({ ok: true, path: relativePath, size });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// ファイル削除
app.delete('/files/*', requireAuth, (req, res) => {
  const ip = getIP(req);
  const relativePath = req.params[0];
  const abs = safeUploadPath(relativePath);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(abs);
    log(ip, `FILE DELETE ${relativePath}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── グローバル設定 ───
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.get('/settings', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) return res.json({});
    const data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/settings', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(req.body, null, 2), 'utf-8');
    log(ip, `SETTINGS SAVE`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── チャット履歴保存 ───
const CHATS_DIR = process.env.CHATS_DIR || path.join(__dirname, 'chats');
if (!fs.existsSync(CHATS_DIR)) fs.mkdirSync(CHATS_DIR, { recursive: true });

// 一覧取得
// チャットIDのサニタイズ（パストラバーサル防止）
function sanitizeChatId(id) {
  if (!id || typeof id !== 'string') return null;
  // 英数字・ハイフン・アンダースコアのみ許可
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return null;
  if (id.length > 64) return null;
  return id;
}

app.get('/chats', requireAuth, (req, res) => {
  try {
    const files = fs.readdirSync(CHATS_DIR).filter(f => f.endsWith('.json'));
    const list = files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CHATS_DIR, f), 'utf-8'));
        return {
          id: f.replace('.json', ''),
          title: data.title || '無題',
          updatedAt: data.updatedAt || data.createdAt || '',
          messageCount: (data.messages || []).length,
          docCount: (data.documents || []).length,
        };
      } catch { return null; }
    }).filter(Boolean);
    list.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    res.json(list);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 1件取得
app.get('/chats/:id', requireAuth, (req, res) => {
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 保存（新規 or 上書き）
app.post('/chats/:id', requireAuth, jsonParser, (req, res) => {
  const ip = getIP(req);
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  try {
    const payload = {
      ...req.body,
      id,
      updatedAt: new Date().toISOString(),
    };
    if (!payload.createdAt) payload.createdAt = payload.updatedAt;
    fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8');
    log(ip, `CHAT SAVE ${id} (${(payload.messages || []).length} msgs)`);
    res.json({ ok: true, id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 削除
app.delete('/chats/:id', requireAuth, (req, res) => {
  const ip = getIP(req);
  const id = sanitizeChatId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid chat id' });
  const file = path.join(CHATS_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Not found' });
  try {
    fs.unlinkSync(file);
    log(ip, `CHAT DELETE ${id}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── matplotlib生成画像の配信（認証必須） ───
// uploadsとは別管理。LLMのファイル操作ツール（list_files/read_file/write_file）からは見えない。
app.get('/plots/*', requireAuth, (req, res) => {
  const relativePath = req.params[0];
  const PLOTS_DIR = path.join(__dirname, 'public', 'plots');
  // パストラバーサル防止
  const abs = path.resolve(PLOTS_DIR, relativePath);
  if (!abs.startsWith(PLOTS_DIR)) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Not found' });
  const ext = path.extname(abs).toLowerCase();
  const mimes = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  };
  res.setHeader('Content-Type', mimes[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'private, max-age=300');
  fs.createReadStream(abs).pipe(res);
});

// ─── 静的ファイル配信 ───
// /plots/ は認証付きの専用ルート（上記）で処理するため、静的配信の対象外にする
app.use((req, res, next) => {
  if (req.path.startsWith('/plots/')) return next();
  express.static(path.join(__dirname, 'public'))(req, res, next);
});

// ─── フォールバック ───
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── サーバー起動 ───
server.listen(PORT, '0.0.0.0', async () => {
  const name = `${appConfig.appName} Server`;
  const ls = appConfig.llamaServer;
  const lines = [];
  lines.push(`  URL    : ${HTTPS_ENABLED ? 'https' : 'http'}://localhost:${PORT}`);
  lines.push(`  Backend: llama.cpp (llama-server)`);
  lines.push(`  Bin    : ${ls.binPath}`);
  lines.push(`  Chat   : ${ls.chatHost}:${ls.chatPort}`);
  lines.push(`  Embed  : ${ls.embeddingHost}:${ls.embeddingPort}`);
  lines.push(`  Models : ${chatModels.length} chat model(s)`);
  chatModels.forEach((m, i) => {
    lines.push(`    [${i}] ${m.name} (ctx=${m.ctx}, ngl=${m.ngl})`);
  });
  lines.push(`  Python : ${appConfig.pythonPath || 'python3'}`);
  const w = Math.max(name.length + 6, ...lines.map(l => l.length + 2), 40);
  const pad = (s) => s + ' '.repeat(Math.max(0, w - s.length));
  console.log('');
  console.log(`  ╔${'═'.repeat(w)}╗`);
  console.log(`  ║${pad('   ' + name)}║`);
  console.log(`  ╠${'═'.repeat(w)}╣`);
  for (const l of lines) console.log(`  ║${pad(l)}║`);
  console.log(`  ╚${'═'.repeat(w)}╝`);
  console.log('');

  // 起動時にGPUデータ取得
  await updateGpuData();

  // 初期モデル名のみ決定（実際のロードは最初のリクエスト時）
  // 優先順位: 1) settings.json の前回モデル, 2) defaultModel, 3) chatModels[0]
  if (chatModels.length > 0) {
    let initialModel = null;
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
        if (settings.chatModel && findModelByName(settings.chatModel)) {
          initialModel = settings.chatModel;
        }
      }
    } catch (e) {
      log('-', `settings.json読み込みエラー: ${e.message}`);
    }
    if (!initialModel) initialModel = appConfig.defaultModel || chatModels[0].name;
    // VRAM節約のため起動はせず、「自動アンロード状態」として記録 → 初回リクエスト時に自動ロード
    chatProcAutoUnloaded = initialModel;
    log('-', `初期モデル: ${initialModel}（最初のリクエスト時にロード）`);
  } else {
    log('-', 'chatModels が空です。config.json でモデルを設定してください。');
  }
  // Embeddingも同様に初回リクエスト時にロード
  log('-', 'Embeddingモデル: 最初のリクエスト時にロード');
});

// ─── バックグラウンドGPU監視（ローカル単体） ───
let cachedGpuData = [];
let gpuUpdating = false;

async function updateGpuData() {
  if (gpuUpdating) return;
  gpuUpdating = true;
  try { cachedGpuData = await queryGpu(); } finally { gpuUpdating = false; }
}
function buildGpuSseData() {
  return [{ label: 'localhost', host: '127.0.0.1', port: appConfig.llamaServer.chatPort, gpus: cachedGpuData }];
}
setInterval(updateGpuData, GPU_INTERVAL);
