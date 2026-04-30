# OpenGeekLLMChat

<div align="center">
ギークのためのブラウザベース・ローカルLLMチャットアプリ。GPU監視・RAG・Web検索・Python実行を統合。
llama.cpp と React 1ファイル、Node.js サーバー1ファイル。ビルド不要、依存は最小（express + ws のみ）。

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![llama.cpp](https://img.shields.io/badge/llama.cpp-OpenAI%20Compatible-blue)](https://github.com/ggml-org/llama.cpp)
[![Self-Hosted](https://img.shields.io/badge/Self--Hosted-100%25-blueviolet)](#)
[![No Cloud](https://img.shields.io/badge/No%20Cloud-ever-red)](#)

<!-- スクリーンショット -->
<img src="docs/image.png" alt="OpenGeekLLMChat" width="800" />

</div>

---

## 🎯 何ができるのか

OpenGeekLLMChatは、**クラウドに依存しないローカルLLM環境を自宅サーバーや社内LANで動かすため** に設計されたチャットアプリです。ギークが自由に弄り倒せるよう、**依存を最小限に絞り、すべてがファイル1枚で完結する構成** になっています。

- サーバー: `server.js` 1ファイル（依存は `express` と `ws` のみ）
- クライアント: `public/index.html` 1ファイル（React/Babel CDN、ビルドツール不要）
- LLM推論: llama.cppの `llama-server` バイナリを子プロセスとして起動・管理

データは全て手元に残ります。**クラウドAPIへの送信は一切ありません。**

---

## ✨ 主な機能

### 🤖 Agentic RAG（マルチターン対応）
LLMが自ら検索要否を判断し、必要なときだけドキュメントRAG・Web検索・ファイル操作を呼び出します。最大3ターンのツール実行ループで、「一覧取得 → 内容読み込み → 応答」の段階的処理が可能。

### 🌐 DuckDuckGo Web検索（本文取得対応）
APIキー不要。検索結果のスニペットだけでなく、上位3件のページ本文も自動取得。天気・ニュース・株価なども回答可能。

### 📁 サーバーファイル読み書き
LLMが直接サーバーのファイルシステムに `.py` / `.xml` / `.json` 等を保存可能。Agenticツールとして `read_file`, `write_file`, `list_files` を実装。バイナリファイル（PNG/PDF/Parquet等）もFormData経由で安全にアップロード・ダウンロード可能。

### 🎯 ドラッグ&ドロップ統合UI
3つのドロップゾーンが状況に応じて自動で振り分け:
- **チャット入力欄**: 画像→Vision添付、その他→ドキュメント取り込み
- **左サイドバー（ドキュメント）**: RAG用ドキュメントとして取り込み（embedding生成）
- **右サイドバー（サーバーファイル）**: `public/uploads/` にバイナリ含めて保存

### 🌐 Web検索ON/OFFトグル
チャット入力欄の🌐ボタンで検索の有効/無効を即座に切り替え可能。社内ドキュメントだけで答えてほしい時はOFF、最新情報が必要な時はONに。デフォルトは `config.webSearch` で設定。

### 📐 履歴の重み付け（直近優先）
直近6件のメッセージはそのまま送信、それ以前は「参考情報」として圧縮、最新ユーザー質問には「今この質問に回答してください」マーカーを付加。長い会話でも最新文脈を確実に優先させます。`config.recentMessageCount` で件数調整可能。

### ⚡ マルチGPU・テンソル並列
1台のサーバー内で複数GPU（NVIDIA / AMD ROCm）を使ったテンソル並列推論が可能。`commonArgs` で `--device ROCm0,ROCm1` のように指定するだけ。VRAMを束ねて大規模モデルを実行できます。

### 🖼️ Vision対応
gemma3 / llava 等のビジョンモデルに画像を直接送信。ペースト・D&D・アップロードに対応。

### 📊 matplotlib グラフ自動表示
`plt.show()` や `plt.savefig()` を呼ぶだけで、生成画像がチャットにインライン表示されます。日本語フォントも自動選択。生成画像は `public/plots/` に分離保存されるため、`list_files` でLLMの作業領域を汚しません。チャット内の **📎 チャットに添付** ボタンで、生成したグラフを次のチャット入力に画像として渡せます（Visionモデルとの連携）。

### 🦆 DuckDB 対応（高速SQL処理）
CSV / Parquet / JSON ファイルを直接SQLでクエリ可能。pandasより高速・省メモリで数百万行のデータを扱えます。LLMが大量データの集計依頼を受けたときに自動的にDuckDBコードを生成します。

### 🎮 Three.js / HTMLプレビュー
LLMが生成したThree.jsコードをチャット内でワンクリック実行。CDN自動注入・ESM→UMD変換・壊れたCDN URL自動修正。

### 🐍 Python対話実行
コードブロックの「▶ 実行」で対話的実行。`input()` 入力も可能。matplotlibでのグラフ描画自動対応。作業ディレクトリはuploads配下でLLMツールと統一。

### 🎤 音声入力 (Web Speech API)
マイクボタンから日本語音声認識。リアルタイムで入力欄に反映。**3秒無音で自動送信**、送信後は録音自動停止。

### 🔊 音声出力 (Web Speech Synthesis)
アシスタントメッセージ下の🔊ボタンでOS内蔵TTSでの読み上げ。Markdown記号・コードブロック自動除去。別メッセージ切替・チャット切替時は自動停止。

### 📈 リアルタイムメトリクス
トークン生成速度（tok/s）、コンテキスト使用率（%バー）、GPU使用率/温度/電力/VRAM を右サイドバーにリアルタイム表示。

### 🔄 思考中断からの復旧 / ループ検出
Thinking中にモデルが停止した場合、メッセージ下の「🔄 続きを生成」ボタンで自動的に続きを要求できます。さらに、**同じ思考が3回繰り返されると自動的にループを検出して停止**し、「⚠️ 思考ループを中断・回答を要求」ボタンが表示されます。小型モデルの暴走を未然に防げます。

### ⏹️ 確実な生成停止
停止ボタンでHTTPストリームを切断、llama-serverのスロットを即座に解放します。

### ⚡ ツール判断の高速化
ツール（search_documents/web_search 等）を呼ぶか判断するフェーズでは `think: false` を指定し、思考プロセスをスキップして即座に判定。応答速度向上＆思考ループ防止を兼ねた効果あり。

### 🛌 モデル自動アンロード（idleUnloadMs）
チャットモデルのアイドル時間が `idleUnloadMs` を超えると自動でアンロード（VRAM解放）。次回リクエスト時に自動再ロード。複数モデルを切替使用するときのVRAM節約に有効。30秒間隔でチェック。Embeddingモデルも同設定でアンロード対象。

### 🚀 オンデマンドモデルロード
サーバー起動時にはモデルをロードせず、初回チャット送信時にロード。サーバー起動直後はVRAMほぼ空の状態を維持。前回使用モデル(`settings.json`)を記憶しUI上に表示、送信時に自動ロードされる。Embeddingも同様にドキュメントD&D時に初めてロード。

### 🔁 アイドル復帰の自動継続
アイドルアンロード後にチャット送信した場合、自動的にロード完了を待機してそのまま送信処理を続行。ユーザーは送信ボタンを再度押す必要なし（最大2分まで待機）。

### 🔒 生成中のモデル切替防止
チャット生成中は、設定パネルのモデル選択ドロップダウンが自動的に無効化され🔒アイコンが表示。生成完了/停止後に再度切替可能になる。生成途中で違うモデルに切り替えてしまう事故を防止。

### 🟠 ロード中のオレンジ色UI表示
モデル切替時、画面下部にオレンジ色の進捗トースト + 回転スピナーが表示。エラー（赤色）と明確に区別され、進行中であることが一目で分かる。

### 📱 モバイル対応（2行ヘッダー）
スマートフォンサイズでは自動的にヘッダーを2行レイアウトに切替。`100dvh` + iOSセーフエリア対応で、アドレスバー表示時もホームバー被りも回避。チャット入力欄は16pxフォントでiOSフォーカス時の自動ズームを抑制。

### 🔒 セキュリティ
- **HTTPS対応**: `cert.pem` / `key.pem` を配置で自動HTTPS起動。正規SSL証明書（Let's Encrypt等）も利用可能
- セッションCookie認証（HttpOnly + SameSite=Strict + Secure自動付与、24h TTL）
- **Cookie維持で再ログイン不要**（TTL以内）
- MD5/SHA-256ハッシュ（`crypto.timingSafeEqual` 使用）
- ログイン試行レートリミット（15分5回）
- パストラバーサル対策
- 全認証必須エンドポイント

### 🛠️ その他
- Markdown / LaTeX（KaTeX）/ コードハイライト（highlight.js）
- Thinking表示（DeepSeek R1 / gemma3等の `<think>` タグ対応）
- チャット履歴保存（メッセージ+ドキュメント+Embedding）
- チャットタイトル編集
- ストリーミング中のスクロール制御（ユーザーが上にスクロールしたら自動追従停止）
- systemd対応（`process.chdir(__dirname)` で起動位置非依存）
- レスポンシブ・ダークテーマ
- ログレベル制御（`logLevel: "quiet"` で本番運用ログを最小化）
- モデル選択ドロップダウンに `モデル名 (8,192)` 形式でctx併記
- 全設定を `config.json` でカスタマイズ可能

---

## 🚀 クイックスタート

### 1. llama.cpp ビルド

```bash
git clone https://github.com/ggml-org/llama.cpp
cd llama.cpp

# CUDA (NVIDIA)
cmake -S . -B build -DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# ROCm (AMD)
HIPCXX="$(hipconfig -l)/clang" HIP_PATH="$(hipconfig -R)" \
  cmake -S . -B build -DGGML_HIP=ON -DAMDGPU_TARGETS=gfx1100 -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(nproc)

# Metal (Apple Silicon) - デフォルトで有効
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j$(sysctl -n hw.logicalcpu)

# バイナリを配置
sudo cp build/bin/llama-server /usr/local/bin/
```

### 2. GGUFモデル取得

HuggingFaceから直接ダウンロード:

```bash
mkdir -p ~/models && cd ~/models

# チャット用（例: Gemma 3 12B Q4）
wget https://huggingface.co/bartowski/google_gemma-3-12b-it-GGUF/resolve/main/google_gemma-3-12b-it-Q4_K_M.gguf

# RAG用Embedding（必須）
wget https://huggingface.co/mixedbread-ai/mxbai-embed-large-v1/resolve/main/gguf/mxbai-embed-large-v1-f16.gguf
```

### 3. Node.js（未インストールの場合）

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# macOS
brew install node

# Windows: https://nodejs.org/ からLTS版をDL
```

### 4. Python・matplotlib・DuckDB（任意）

```bash
# Ubuntu / Debian
sudo apt install python3-matplotlib python3-numpy python3-pandas fonts-ipaexfont fonts-noto-cjk
rm -rf ~/.cache/matplotlib  # フォントキャッシュ更新

# DuckDB（大量データのSQL処理）
pip3 install duckdb --break-system-packages

# まとめてpipで
pip3 install matplotlib numpy pandas duckdb --break-system-packages
```

DuckDB はLLMが大量データのSQL集計を求められたときに自動的に使用します（CSV/Parquetを直接FROMで参照、pandasのDataFrameもSQL対象に）。

### 5. 設定 + 起動

`config.json` を編集して、ダウンロードしたモデルのパスを設定:

```json
{
  "llamaServer": {
    "binPath": "/usr/local/bin/llama-server",
    "chatPort": 8080,
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on"]
  },
  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "/home/USER/models/google_gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99
    }
  ],
  "embeddingModel": {
    "path": "/home/USER/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  }
}
```

```bash
git clone https://github.com/<your-username>/opengeek-llm-chat.git
cd opengeek-llm-chat
npm install
npm start
```

ブラウザで **http://localhost:3000**

### 6. HTTPS化（任意・推奨）

**自己署名証明書で試す:**
```bash
./generate-cert.sh localhost 192.168.1.100 your-hostname
npm start    # 起動バナーが https:// になる
```

**正規SSL証明書を使う（Let's Encrypt等）:**
```bash
# 証明書を cert.pem と key.pem として配置
cp /path/to/fullchain.pem cert.pem
cp /path/to/privkey.pem key.pem
chmod 600 key.pem
# 秘密鍵にパスフレーズがある場合は事前に解除
# openssl rsa -in key.pem -out key.pem
npm start
```

HTTPS化すると、マイク・音声合成・クリップボード等のブラウザAPI制約が全て解消されます。

---

## 📁 リポジトリ構成

```
opengeek-llm-chat/
├── server.js                   # Express + WebSocket、llama-serverプロセス管理
├── generate-cert.sh            # 自己署名SSL証明書生成スクリプト
├── hashpass.py                 # パスワードハッシュ生成ツール
├── config.json                 # 全設定
├── package.json                # express + ws のみ
├── opengeek-llm-chat.service   # systemdサービステンプレート
├── transcribe-server.py        # Gemma4 E2B音声認識サーバー（参考実装・非推奨）
├── TRANSCRIBE.md               # 音声認識セットアップガイド（参考）
├── cert.pem / key.pem          # SSL証明書（配置時にHTTPSモード起動）
├── public/
│   ├── index.html              # React SPA（単一ファイル）
│   ├── aiicon.jpg              # アイコン（任意）
│   ├── uploads/                # LLMが読み書きするディレクトリ
│   │                           #  （Python実行の作業ディレクトリでもある）
│   └── plots/                  # matplotlibが自動生成した画像（list_filesから除外）
├── chats/                      # チャット履歴JSON（自動生成）
├── settings.json               # ユーザー設定（自動生成）
├── DESIGN.md                   # 設計ドキュメント
├── README.md                   # これ
└── LICENSE                     # MIT
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
  "pythonPath": "python3",
  "logLevel": "quiet",

  "llamaServer": {
    "binPath": "/usr/local/bin/llama-server",
    "chatHost": "127.0.0.1",
    "chatPort": 8080,
    "embeddingHost": "127.0.0.1",
    "embeddingPort": 8081,
    "commonArgs": ["-fa", "on"],
    "readyTimeoutMs": 120000,
    "idleUnloadMs": 600000
  },

  "chatModels": [
    {
      "name": "Gemma3 12B Q4",
      "path": "/home/USER/models/gemma-3-12b-it-Q4_K_M.gguf",
      "ctx": 8192,
      "ngl": 99,
      "extraArgs": []
    }
  ],

  "embeddingModel": {
    "path": "/home/USER/models/mxbai-embed-large-v1-f16.gguf",
    "ctx": 512,
    "ngl": 99,
    "poolingType": "mean"
  },

  "webSearch": true,
  "fileAccess": true,
  "ragTopK": 10,
  "ragMode": "agentic",
  "agentContext": {
    "smallPredict": 512,
    "largePredict": 8192,
    "judgeHistoryCount": 3,
    "largeGenKeywords": null
  },
  "tokenAvgWindow": 2000,
  "recentMessageCount": 6,
  "topK": 40, "topP": 0.9, "temperature": 0.7
}
```

| キー | 説明 |
|:--|:--|
| `appName` / `logoMain` / `logoSub` | 表示名・ロゴ |
| `accentColor` | テーマカラー（HEX） |
| `defaultModel` | 初期モデル名（chatModels の `name`、空→一覧先頭） |
| `password` | MD5/SHA-256ハッシュ（空→認証なし） |
| `pythonPath` | Python実行時のコマンド（venv対応、例: `.venv/bin/python3`） |
| `logLevel` | `normal`(全ログ) / `quiet`(最小限、本番推奨) |
| `llamaServer.binPath` | `llama-server` バイナリのパス |
| `llamaServer.chatPort` | チャット推論用llama-serverのポート（デフォルト8080） |
| `llamaServer.embeddingPort` | Embedding用llama-serverのポート（デフォルト8081） |
| `llamaServer.commonArgs` | 全モデル共通の起動引数（GPU指定、Flash Attention等） |
| `llamaServer.readyTimeoutMs` | モデル起動完了までのタイムアウト（デフォルト120000ms） |
| `llamaServer.idleUnloadMs` | アイドル時の自動アンロード時間（ms、0で無効、推奨600000=10分） |
| `chatModels[]` | 利用可能なチャットモデル一覧（複数可） |
| `chatModels[].name` | UIに表示される名前 |
| `chatModels[].path` | GGUFファイルのフルパス |
| `chatModels[].ctx` | コンテキスト長（モデル毎、起動時固定。UIにも表示される） |
| `chatModels[].ngl` | GPUレイヤー数（99で全レイヤーGPU、0でCPUのみ） |
| `chatModels[].extraArgs` | このモデル専用の追加引数（`--mmproj`によるVision対応等） |
| `embeddingModel.path` | RAG用Embeddingモデル（GGUF） |
| `embeddingModel.poolingType` | `mean` / `cls` / `last` / `none` |
| `embeddingModel.extraArgs` | Embedding専用の追加引数（GPU指定など） |
| `webSearch` | DuckDuckGo検索 ON/OFF（UIトグル初期値） |
| `fileAccess` | サーバーファイル読み書き ON/OFF |
| `ragTopK` | RAG検索チャンク数 |
| `ragMode` | `agentic` / `always` |
| `agentContext.smallPredict` | ツール判断時のmax_tokens（短文モード）デフォルト512 |
| `agentContext.largePredict` | ツール判断時のmax_tokens（長文モード）+ continueGen時、デフォルト8192 |
| `agentContext.judgeHistoryCount` | ツール判断時に送る直近メッセージ件数、デフォルト3 |
| `agentContext.largeGenKeywords` | 長文モード判定キーワード（null=デフォルト使用） |
| `recentMessageCount` | 直近何件のメッセージを「そのまま」送信するか（それ以前は「参考情報」化）デフォルト6 |
| `systemPrompts.*` | システムプロンプトのカスタマイズ（後述） |
| `topK`/`topP`/`temperature` | LLM推論パラメータ |

### ⚙️ logLevel について

llama-serverは起動時に大量のメタデータをstderrに出力します。本番運用では `"logLevel": "quiet"` を推奨します。

| 設定 | 動作 |
|:--|:--|
| `"normal"` (デフォルト) | llama-serverの全stdout/stderr + プロキシ毎リクエストログを表示 |
| `"quiet"` | llama-serverのstdout/stderrを破棄、プロキシログも抑制。残るのは起動バナー・spawn・認証・Python実行・Web検索・エラーのみ |

### 🛌 idleUnloadMs（自動アンロード）

`llamaServer.idleUnloadMs > 0` の場合、最終使用時刻から指定ms経過するとチャットモデル/Embeddingモデルを自動アンロード（VRAM解放）します。次のリクエスト時に自動再ロードされます。

| 値 | 動作 |
|:--|:--|
| `0` (デフォルト) | 自動アンロード無効（モデル常駐） |
| `300000` (5分) | 短め、頻繁にアンロード |
| `600000` (10分) | バランス推奨 |
| `1800000` (30分) | 長め |
| `3600000` (1時間) | ほぼ常駐 |

複数のモデルを使い分けたいが、VRAMを節約したい場合に有効です。30秒間隔でチェックするため、実際のアンロードは設定時間 +0〜30秒。

**動作仕様**:
- **サーバー起動時**: モデルは起動せず、前回使用モデル名のみ記憶（`settings.json`）
- **初回チャット送信時**: 記憶したモデルが自動ロード（10〜30秒）→ 送信処理続行
- **アイドル超過時**: 自動アンロード → 次回送信時に自動再ロード
- **モデル切替時**: 古いモデル停止 → 新モデル起動（自動）
- **Embeddingモデル**: ドキュメントD&D時にオンデマンドロード、同じ `idleUnloadMs` でアンロード

### 🎨 systemPrompts のカスタマイズ

LLMへの指示文を `config.json` の `systemPrompts` キーで完全カスタマイズ可能。`{date}` は実時間で、`{docList}` はドキュメント名カンマ区切りで、`{toolList}` は利用可能ツール一覧で動的に展開されます。

```json
{
  "systemPrompts": {
    "base": "あなたは親切で知識豊富なAIアシスタントです。日本語で簡潔に回答してください。今日の日付は{date}です。\n\n重要な指示:\n- 思考は手短に済ませ...",
    "documents": "【参照可能なドキュメント】(チャットに添付されたファイル): {docList}\nユーザーの質問が「ドキュメントについて」「資料を見て」「添付ファイル」などを示唆する場合、必ず最初に search_documents ツールを使ってください。",
    "webSearch": "最新の情報や知らないことについては web_search ツールでインターネット検索できます。",
    "fileAccess": "【サーバーファイル操作】(uploads配下、ドキュメントとは別物)\n- list_files: uploadsフォルダの一覧を取得\n...",
    "python": "Pythonコード実行について:\n- 応答に ```python ... ``` のコードブロックを含めると...",
    "meta": "重要な指示:\n- 内部的な推論・検索戦略・計画・メタ的な説明は一切出力しないでください...",
    "judge": "以下の中から必要なツールを呼び出してください...\n{toolList}\n注意:..."
  }
}
```

部分的に上書きすることもできます（指定しないキーはデフォルトが使用される深いマージ）。例えば「役割」だけ変えたい場合:

```json
{
  "systemPrompts": {
    "base": "あなたは社内文書専門のアシスタントです。質問には必ず添付ドキュメントから根拠を引用して回答してください。今日の日付は{date}です。"
  }
}
```

| キー | 用途 | 利用可能変数 |
|:--|:--|:--|
| `base` | 全フェーズ共通の土台 | `{date}` |
| `documents` | ドキュメント添付時の追記 | `{docList}` |
| `webSearch` | Web検索有効時の追記 | - |
| `fileAccess` | サーバーファイル操作有効時の追記 | - |
| `python` | Python実行案内（常時） | - |
| `meta` | メタ抑制指示（常時） | - |
| `judge` | ツール判断専用（軽量） | `{toolList}` |

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

## ⚡ マルチGPU構成（テンソル並列）

llama.cppは1モデルを複数GPUに分散できます（テンソル並列）。VRAMを束ねて大規模モデルを動かしたい場合に有効。

### 全GPUを使う（デフォルト）

config.jsonで何も指定しなければ全GPUが使用されます:

```json
{
  "llamaServer": {
    "commonArgs": ["-fa", "on"]
  }
}
```

### 特定GPUのみ使う

複数GPUの中で特定のものだけ使いたい場合（iGPU除外、特定枚数だけ等）:

```json
{
  "llamaServer": {
    "commonArgs": ["-fa", "on", "--device", "ROCm0,ROCm1"]
  }
}
```

NVIDIA環境なら `--device CUDA0,CUDA1` のように指定。

### モデル毎にGPU指定

`chatModels[].extraArgs` でモデル毎にGPUを変えることも可能:

```json
{
  "chatModels": [
    {
      "name": "Big Model 70B",
      "path": "/models/big.gguf",
      "ctx": 8192,
      "ngl": 99,
      "extraArgs": ["--device", "ROCm0,ROCm1,ROCm2"]
    },
    {
      "name": "Small Model 7B",
      "path": "/models/small.gguf",
      "ctx": 16384,
      "ngl": 99,
      "extraArgs": ["--device", "ROCm0"]
    }
  ]
}
```

### Embedding専用GPU

軽量なEmbeddingモデルは1枚で十分:

```json
{
  "embeddingModel": {
    "path": "/models/mxbai-embed-large-v1-f16.gguf",
    "extraArgs": ["--device", "ROCm0"]
  }
}
```

### `nvidia-smi` / `rocm-smi` での確認

OpenGeekLLMChatのGPUタブで全GPUの使用率がリアルタイム表示されます。Linuxサーバーの場合 `rocm-smi`（AMD）または `nvidia-smi`（NVIDIA）が `PATH` にあれば自動検出されます。

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
| `PYTHON_TIMEOUT` | `60000` | Python実行タイムアウト(ms) |
| `GPU_INTERVAL` | `1000` | GPU監視間隔(ms) |
| `CHATS_DIR` | `./chats` | チャット履歴保存先 |

`llama-server` の接続先（ホスト・ポート）は `config.json` の `llamaServer.*` で設定します。

---

## 📡 API

| Method | Path | Auth | 説明 |
|:--|:--|:--:|:--|
| `*` | `/v1/*` | ✓ | llama-server (チャット推論) リバースプロキシ |
| `*` | `/embed/v1/*` | ✓ | llama-server (Embedding) リバースプロキシ |
| `GET` | `/models` | ✓ | 利用可能モデル一覧 + 現在ロード中モデル |
| `POST` | `/models/load` | ✓ | モデル切替（サーバー再起動） |
| `POST` | `/models/unload` | ✓ | 現在のチャットモデルをアンロード |
| `GET` | `/web-search?q=&n=&fetch=&bodyCount=` | ✓ | DuckDuckGo検索+本文取得 |
| `GET/POST` | `/files/*` | ✓ | サーバーファイル読み書き（画像等はバイナリ配信） |
| `DELETE` | `/files/*` | ✓ | ファイル削除 |
| `GET` | `/files` | ✓ | ファイル一覧 |
| `GET` | `/plots/*` | ✓ | matplotlib生成画像の配信（uploadsとは分離管理） |
| `GET` | `/config` | — | 公開設定（セッション有効時は `authenticated:true`） |
| `POST` | `/auth` | — | ログイン（Cookie発行・24h TTL） |
| `GET` | `/sse/gpu` | ✓ | GPU監視 SSE |
| `GET/POST` | `/settings` | ✓ | ユーザー設定 |
| `GET/POST/DELETE` | `/chats/:id` | ✓ | チャット履歴 |
| `WS` | `/ws/python` | ✓ | Python対話実行（画像生成対応） |

---

## 🖥️ デプロイ（systemd）

### OpenGeekLLMChat 本体

テンプレートファイル `opengeek-llm-chat.service` が同梱されています:

```bash
# 内容を確認・編集（User, WorkingDirectory, ExecStart等を環境に合わせる）
sudo cp opengeek-llm-chat.service /etc/systemd/system/
sudo nano /etc/systemd/system/opengeek-llm-chat.service

# 有効化・起動
sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-llm-chat

# ログ確認
sudo journalctl -u opengeek-llm-chat -f
```

`process.chdir(__dirname)` により、systemd経由で起動してもカレントディレクトリは自動的にserver.jsと同じ場所になります。

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now opengeek-llm-chat
sudo journalctl -u opengeek-llm-chat -f  # ログ確認
```

---

## 🛠️ 技術スタック

| Layer | Tech |
|:--|:--|
| Frontend | React 18 (CDN/Babel) · marked · highlight.js · KaTeX · Three.js r128 · Web Speech API (STT/TTS) |
| Backend | Node.js · Express · ws（依存2つのみ）· HTTPS対応 |
| AI | llama.cpp (llama-server, OpenAI互換API) · mxbai-embed-large · Tool Calling · マルチターン実行 |
| Python | matplotlib（画像自動表示）· 日本語フォント自動選択 · DuckDB（SQL処理） |
| Search | DuckDuckGo HTML Lite + 本文取得 |
| Auth | セッションCookie (24h) · MD5/SHA-256 + timingSafeEqual · HTTPS時Secure自動付与 |
| GPU監視 | rocm-smi / nvidia-smi |

---

## 📋 変更履歴

### v1.0.0 (2026-04)
- **バックエンドを Ollama → llama.cpp (llama-server) に完全移行**
- マルチGPUテンソル並列対応（AMD ROCm環境で動作確認）
- OpenAI互換 `/v1/*` API プロキシ実装
- モデル動的切替（`/models/load`）
- `idleUnloadMs` による自動アンロード（チャット・Embedding両対応）
- **オンデマンドモデルロード**（サーバー起動時はロードせず、初回送信時にロード）
- アイドル復帰の自動継続（送信時にロード→そのまま処理続行）
- `logLevel: "quiet"` で運用ログ最小化
- 生成中のモデル切替防止UI
- ロード中のオレンジ色トースト表示
- 新規チャットの自動タイトル生成
- Vision対応（mmproj設定によるGemma3/Qwen3.6/Gemma4等）
- Gemma独自トークン形式 `<|tool_call|>` のフォールバックパース
- Qwen3系 thinking モード制御（ツール判断時はオフ）
- 思考プロセス内に答えが閉じこもる問題の救済処理
- Embedding処理中の送信ブロック（並行リクエスト詰まり防止）
- ファイル選択「すべてのファイル」対応

---

## 🤝 Contributing

PR大歓迎。ギーク的な改造ほど歓迎します。

---

## 📝 ライセンス

[MIT](LICENSE)   
※一部はAIによって生成されています。
