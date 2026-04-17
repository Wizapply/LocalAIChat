#!/usr/bin/env node
/**
 * GPU Agent — 各PCに配置する軽量GPU監視サーバー
 * 依存パッケージ不要（Node.js標準モジュールのみ）
 *
 * 使い方:
 *   node gpu-agent.js [ポート] [トークン]
 *   または環境変数 GPU_AGENT_PORT / GPU_AGENT_TOKEN
 *
 * デフォルトポート: 11400
 *
 * API:
 *   GET / → GPU情報JSON配列
 *   トークン設定時はHeaderの X-Agent-Token またはクエリの ?token= で認証
 *
 * systemd例:
 *   Environment=GPU_AGENT_TOKEN=secret123
 *   ExecStart=/usr/bin/node /path/to/gpu-agent.js
 */

const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const PORT = parseInt(process.argv[2] || process.env.GPU_AGENT_PORT) || 11400;
const TOKEN = process.argv[3] || process.env.GPU_AGENT_TOKEN || '';
let gpuBackend = null;

function parseRocmSmi() {
  return new Promise((resolve) => {
    const proc = spawn('rocm-smi', ['--showuse', '-t', '-P', '--showmeminfo', 'vram', '-c', '--json'], { timeout: 5000 });
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
          gpu.usage = parseInt(val['GPU use (%)']) || 0;
          gpu.temp = parseFloat(val['Temperature (Sensor edge) (C)']) || 0;
          gpu.tempHotspot = parseFloat(val['Temperature (Sensor junction) (C)']) || 0;
          gpu.tempMem = parseFloat(val['Temperature (Sensor memory) (C)']) || 0;
          const powerKey = Object.keys(val).find(k => /power/i.test(k) && /\(W\)/.test(k));
          gpu.power = powerKey ? parseFloat(val[powerKey]) || 0 : 0;
          const vramTotal = parseInt(val['VRAM Total Memory (B)']) || 0;
          const vramUsed = parseInt(val['VRAM Total Used Memory (B)']) || 0;
          gpu.vramTotalMB = Math.round(vramTotal / 1048576);
          gpu.vramUsedMB = Math.round(vramUsed / 1048576);
          gpu.vramPct = vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0;
          const parseClock = (key) => {
            const v = val[key]; if (!v) return 0;
            const m = v.match(/\((\d+)Mhz\)/i);
            return m ? parseInt(m[1]) : 0;
          };
          gpu.sclk = parseClock('sclk clock speed:');
          gpu.mclk = parseClock('mclk clock speed:');
          gpus.push(gpu);
        }
        gpus.sort((a, b) => parseInt(a.id.replace('card', '')) - parseInt(b.id.replace('card', '')));
        resolve(gpus);
      } catch { resolve([]); }
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
            id: `GPU ${cols[0]}`, name: cols[1],
            usage: parseInt(cols[2]) || 0,
            temp: parseFloat(cols[3]) || 0, tempHotspot: 0, tempMem: 0,
            power: parseFloat(cols[4]) || 0,
            sclk: parseInt(cols[5]) || 0, mclk: parseInt(cols[6]) || 0,
            vramTotalMB: Math.round(vramTotal), vramUsedMB: Math.round(vramUsed),
            vramPct: vramTotal > 0 ? Math.round(vramUsed / vramTotal * 100) : 0,
          });
        }
        resolve(gpus);
      } catch { resolve([]); }
    });
    proc.on('error', () => resolve([]));
  });
}

async function queryGpu() {
  if (gpuBackend === 'none') return [];
  if (gpuBackend === 'nvidia') return parseNvidiaSmi();
  if (gpuBackend === 'rocm') return parseRocmSmi();
  const rocm = await parseRocmSmi();
  if (rocm.length > 0) { gpuBackend = 'rocm'; return rocm; }
  const nv = await parseNvidiaSmi();
  if (nv.length > 0) { gpuBackend = 'nvidia'; return nv; }
  gpuBackend = 'none';
  return [];
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  // 認証チェック（トークン設定時）
  if (TOKEN) {
    const headerToken = req.headers['x-agent-token'];
    const queryToken = (() => {
      const m = (req.url || '').match(/[?&]token=([^&]+)/);
      return m ? decodeURIComponent(m[1]) : null;
    })();
    if (headerToken !== TOKEN && queryToken !== TOKEN) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
  }
  const gpus = await queryGpu();
  res.end(JSON.stringify(gpus));
});

server.listen(PORT, '0.0.0.0', () => {
  const hostname = os.hostname();
  console.log(`GPU Agent running on :${PORT} (${hostname})${TOKEN ? ' [token auth enabled]' : ''}`);
});
