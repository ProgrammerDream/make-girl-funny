// tts.js — 调用小米 MiMo V2.5 TTS API 生成配音音频
// 用法: node tts.js [--only hook,seg-01]
//
// 配置: 读取 config.json（mimo_api_url, mimo_api_key, mimo_model），已 gitignore
//
// 流程:
//  1) 读 voiceovers.json 获取文案
//  2) 逐条调用 MiMo chat.completions API
//  3) 解码 base64 WAV → tmp/voice/seg-XX.wav → ffmpeg 转 MP3
//  4) 输出 tmp/voice/{hook,seg-01..seg-10,awards}.mp3

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT  = __dirname;
const VO_DIR = path.join(ROOT, 'tmp', 'voice');
const VO     = JSON.parse(fs.readFileSync(path.join(ROOT, 'voiceovers.json'), 'utf8'));

// ---------- 读取配置 ----------
const CFG_PATH = path.join(ROOT, 'config.json');
const CFG = fs.existsSync(CFG_PATH) ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')) : {};

const API_URL = CFG.mimo_api_url || 'https://api.xiaomimimo.com/v1/chat/completions';
const MODEL   = CFG.mimo_model   || 'mimo-v2.5-tts';

// ---------- CLI args ----------
const onlyArg = process.argv.find(a => a.startsWith('--only='));
const onlySet = onlyArg
  ? new Set(onlyArg.split('=')[1].split(',').map(s => s.trim()))
  : null;

// ---------- 工具 ----------
function sh(cmd) {
  console.log('$ ' + cmd);
  execSync(cmd, { stdio: 'inherit', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash' });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------- TTS 调用 ----------
async function synthesize(apiKey, key, text) {
  const messages = [];
  if (VO.context) {
    messages.push({ role: 'user', content: VO.context });
  }
  messages.push({ role: 'assistant', content: text });

  const body = {
    model: MODEL,
    messages,
    audio: { format: 'wav', voice: VO.voice },
  };

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`TTS API ${resp.status}: ${errText}`);
  }

  const data = await resp.json();
  const audioData = data.choices?.[0]?.message?.audio?.data;
  if (!audioData) {
    throw new Error(`No audio data for "${key}". Response: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return Buffer.from(audioData, 'base64');
}

// ---------- main ----------
async function main() {
  const apiKey = CFG.mimo_api_key || process.env.MIMO_API_KEY;
  if (!apiKey) {
    console.error('错误: 请在 config.json 中填写 mimo_api_key，或设置 MIMO_API_KEY 环境变量');
    process.exit(1);
  }

  if (!fs.existsSync(VO_DIR)) fs.mkdirSync(VO_DIR, { recursive: true });

  const entries = Object.entries(VO.items);
  const filtered = onlySet
    ? entries.filter(([k]) => onlySet.has(k))
    : entries;

  if (filtered.length === 0) {
    console.error(`--only 中没有匹配项。可用: ${entries.map(e => e[0]).join(', ')}`);
    process.exit(1);
  }

  console.log(`TTS 配音生成: ${filtered.length} 条 (voice=${VO.voice}, model=${MODEL})`);
  console.log('');

  for (let i = 0; i < filtered.length; i++) {
    const [key, text] = filtered[i];
    const wavPath = path.join(VO_DIR, `${key}.wav`);
    const mp3Path = path.join(VO_DIR, `${key}.mp3`);

    // 跳过已存在的 MP3（除非 --only 指定）
    if (fs.existsSync(mp3Path) && !onlySet) {
      console.log(`  [跳过] ${key} — ${mp3Path} 已存在`);
      continue;
    }

    process.stdout.write(`  [生成] ${key}: "${text.slice(0, 30)}..." `);

    try {
      const wavBuf = await synthesize(apiKey, key, text);
      fs.writeFileSync(wavPath, wavBuf);
      console.log(`WAV ${(wavBuf.length / 1024).toFixed(0)}KB`);

      // WAV → MP3
      sh(`ffmpeg -y -i "${wavPath}" -codec:a libmp3lame -b:a 128k "${mp3Path}"`);
      console.log(`  [完成] ${mp3Path}`);
    } catch (err) {
      console.error(`\n  [失败] ${key}: ${err.message}`);
    }

    // 限速: RPM=100, 保守间隔 700ms
    if (i < filtered.length - 1) {
      await sleep(700);
    }
  }

  // 列出结果
  console.log('\n生成结果:');
  const files = fs.readdirSync(VO_DIR).filter(f => f.endsWith('.mp3'));
  files.forEach(f => {
    const st = fs.statSync(path.join(VO_DIR, f));
    console.log(`  ${f}  ${(st.size / 1024).toFixed(0)}KB`);
  });
  console.log(`\n共 ${files.length} 个 MP3 文件`);
}

main().catch(err => {
  console.error('致命错误:', err);
  process.exit(1);
});
