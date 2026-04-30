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

function findModelByName(name) {
  return chatModels.find(m => m.name === name);
}

// llama-serverのreadyを待つ（/health か /v1/models をポーリング）
function waitForReady(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const req = http.request({
        hostname: host, port, path: '/health', method: 'GET', timeout: 2000
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

function spawnLlamaServer(args, label) {
  const ls = appConfig.llamaServer;
  log('-', `[${label}] spawn: ${ls.binPath} ${args.join(' ')}`);
  const isQuiet = appConfig.logLevel === 'quiet';
  const proc = spawn(ls.binPath, args, {
    // quietモードではstdout/stderrを完全に捨てる
    stdio: isQuiet ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  if (!isQuiet) {
    proc.stdout.on('data', (d) => process.stdout.write(`[${label}] ${d}`));
    proc.stderr.on('data', (d) => process.stderr.write(`[${label}] ${d}`));
  }
  proc.on('exit', (code) => log('-', `[${label}] exited with code ${code}`));
  return proc;
}

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
  if (chatProcStarting) return false;  // 起動中（プロキシ側で503応答）
  if (!chatProcAutoUnloaded) return false;  // 自動アンロードされてない（手動で停止された）
  const modelToReload = chatProcAutoUnloaded;
  chatProcAutoUnloaded = null;
  log('-', `アイドル復帰: モデル「${modelToReload}」を再ロード`);
  startChatModel(modelToReload).catch(e => log('-', `再ロードエラー: ${e.message}`));
  return false;  // 起動中なのでこのリクエストは503扱い
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
const jsonParser = express.json({ limit: '10mb' });

// ─── HTTP/HTTPS サーバー初期化 ───
// cert.pem と key.pem がカレントディレクトリにあればHTTPS、なければHTTP
// 秘密鍵にパスフレーズが設定されている場合は SSL_PASSPHRASE 環境変数 or config.jsonのsslPassphraseに指定
const CERT_PATH = path.join(__dirname, 'cert.pem');
const KEY_PATH = path.join(__dirname, 'key.pem');
const HTTPS_ENABLED = fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH);
let server;
if (HTTPS_ENABLED) {
  const https = require('https');
  const sslOptions = {
    cert: fs.readFileSync(CERT_PATH),
    key: fs.readFileSync(KEY_PATH),
  };
  const passphrase = process.env.SSL_PASSPHRASE || appConfig.sslPassphrase;
  if (passphrase) sslOptions.passphrase = passphrase;
  server = https.createServer(sslOptions, app);
} else {
  server = http.createServer(app);
}

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
except ImportError:
    pass
# ─── user code below ───
`;
      fs.writeFileSync(tmpFile, preamble + msg.code, 'utf-8');
      const pythonCmd = appConfig.pythonPath || 'python3';
      log(ip, `PYTHON RUN (${msg.code.length} chars) using ${pythonCmd} in ${pyCwd}`);

      proc = spawn(pythonCmd, ['-u', tmpFile], {
        env: { ...process.env, PYTHONUNBUFFERED: '1' },
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

    // チャットプロキシの場合: モデル起動中なら503で早期返却（ユーザーに明確な状態を伝える）
    if (isChatProxy) {
      if (chatProcStarting) {
        if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (model starting)`);
        return res.status(503).json({
          error: 'モデル起動中です。10〜30秒お待ちください。',
          starting: true,
          model: chatProcModel || appConfig.defaultModel,
        });
      }
      if (!chatProc) {
        // 自動アンロードされていれば自動再ロード開始
        if (chatProcAutoUnloaded) {
          ensureChatModelLoaded();  // バックグラウンドで再ロード開始
          if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (auto-reloading)`);
          return res.status(503).json({
            error: 'アイドル状態からモデルを再ロード中です。10〜30秒お待ちください。',
            starting: true,
            model: chatProcModel || appConfig.defaultModel,
          });
        }
        if (!isQuiet) log(ip, `503 ${req.method} ${targetPath} (no model loaded)`);
        return res.status(503).json({
          error: 'チャットモデルがロードされていません。',
          starting: false,
        });
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

// ─── GPU ステータス (SSE) ───
const GPU_INTERVAL = parseInt(process.env.GPU_INTERVAL) || 1000;
let gpuBackend = null; // 'rocm' | 'nvidia' | 'none'

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

          gpus.push(gpu);
        }
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
  if (gpuBackend === 'nvidia') return parseNvidiaSmi();
  if (gpuBackend === 'rocm') return parseRocmSmi();

  // 初回: 自動検出
  const rocm = await parseRocmSmi();
  if (rocm.length > 0) { gpuBackend = 'rocm'; console.log('  GPU backend: rocm-smi'); return rocm; }
  const nv = await parseNvidiaSmi();
  if (nv.length > 0) { gpuBackend = 'nvidia'; console.log('  GPU backend: nvidia-smi'); return nv; }
  gpuBackend = 'none';
  console.log('  GPU backend: none (rocm-smi / nvidia-smi not found)');
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
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

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
