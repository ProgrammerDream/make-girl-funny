// build.js — 用 ffmpeg 把 raw/*.mp4 合成 final.mp4（可选配音）
// 用法: node build.js  (或 bash build.sh)
//
// 流程:
//  1) 读 captions.json，给每段 mp4 加信息带（模型名 + 吐槽）
//  2) 若 tmp/voice/ 有配音 MP3 则混入音轨，否则添加静音音轨
//  3) 用 100ms 黑帧（含静音音轨）做切场闪
//  4) concat: hook → seg01 → ... → seg10 → awards
//  5) 输出 final.mp4（有配音时含 AI 人声，需自配 BGM）

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT      = __dirname;
const RAW_DIR   = path.join(ROOT, 'raw');
const OUT_DIR   = path.join(ROOT, 'out');
const TMP_DIR   = path.join(ROOT, 'tmp');
const VOICE_DIR = path.join(ROOT, 'tmp', 'voice');
const CAPS     = JSON.parse(fs.readFileSync(path.join(ROOT, 'captions.json'), 'utf8'));
const SCRIPT   = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const SCALE    = SCRIPT.scale || 1;
const AUDIO_RATE = 24000;
const AUDIO_CHANNELS = 1;
const AUDIO_LAYOUT = 'mono';

for (const d of [OUT_DIR, TMP_DIR]) if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });

// ---------- 字体探测 ----------
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
  'C:/Windows/Fonts/Deng.ttf'
];
const FONT = FONT_CANDIDATES.find(p => fs.existsSync(p));
if (!FONT) {
  console.error('找不到中文字体。请确认 C:/Windows/Fonts 下有 msyh.ttc');
  process.exit(1);
}
// drawtext 里的路径必须把 : 转成 \:
const FONT_FF = FONT.replace(/\\/g, '/').replace(':', '\\:');

// ---------- 工具 ----------
function sh(cmd) {
  console.log('$ ' + cmd);
  execSync(cmd, { stdio: 'inherit', shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/bash' });
}

function writeText(name, text) {
  // ffmpeg 的 textfile= 要 UTF-8 无 BOM
  const p = path.join(TMP_DIR, name);
  fs.writeFileSync(p, text, { encoding: 'utf8' });
  return p.replace(/\\/g, '/').replace(':', '\\:');
}

// ---------- 配音音频 ----------
const VOICE_EXISTS = fs.existsSync(VOICE_DIR) && fs.readdirSync(VOICE_DIR).some(f => f.endsWith('.mp3'));

function voicePath(name) {
  return path.join(VOICE_DIR, `${name}.mp3`);
}

function probeDuration(file) {
  return parseFloat(execSync(
    `ffprobe -v error -show_entries format=duration -of csv=p=0 "${file}"`,
    { encoding: 'utf8' }
  ).trim());
}

// 视频 + 配音对齐。两条独立分支，避免 if/else。
// 关键 bug 教训：
//   1. 不能用 `-c:v copy + -t` 截视频 —— 容器写元数据但 packet 没真截，concat copy 后尾巴回来。
//   2. 所有 concat 输入必须统一音频格式；黑帧若是 44100/stereo、配音段是 24000/mono，
//      ffmpeg 会在拼接点重写 DTS，音轨被拉长几十秒。
//   3. 配音补齐后用 atrim 明确截到目标时长，避免 apad 的无限流泄到输出。
function mixVoiceVideoLongerOrEqual(videoFile, vp, vd, outFile) {
  // 视频 ≥ 配音：copy 视频全部 packet，配音 apad 后用 atrim 精确截断到视频时长
  const cmd = `ffmpeg -y -i "${videoFile}" -i "${vp}" ` +
    `-filter_complex "[1:a]aformat=sample_rates=${AUDIO_RATE}:channel_layouts=${AUDIO_LAYOUT},apad,atrim=0:${vd.toFixed(3)},asetpts=N/SR/TB[a]" ` +
    `-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 128k -ar ${AUDIO_RATE} -ac ${AUDIO_CHANNELS} "${outFile}"`;
  sh(cmd);
}

function mixVoiceAudioLonger(videoFile, vp, vd, ad, outFile) {
  // 配音 > 视频：视频末尾 freeze 最后一帧扩展到配音时长（必须重编视频）
  const padDur = (ad - vd).toFixed(3);
  const cmd = `ffmpeg -y -i "${videoFile}" -i "${vp}" ` +
    `-filter_complex "[0:v]tpad=stop_mode=clone:stop_duration=${padDur},fps=30[v];[1:a]aformat=sample_rates=${AUDIO_RATE}:channel_layouts=${AUDIO_LAYOUT},atrim=0:${ad.toFixed(3)},asetpts=N/SR/TB[a]" ` +
    `-map "[v]" -map "[a]" -c:v libx264 -pix_fmt yuv420p -preset medium -crf ${CRF} ` +
    `-c:a aac -b:a 128k -ar ${AUDIO_RATE} -ac ${AUDIO_CHANNELS} "${outFile}"`;
  sh(cmd);
}

function mixVoiceSilent(videoFile, vd, outFile) {
  // 无配音：补静音音轨，atrim 精确截到视频时长
  const cmd = `ffmpeg -y -i "${videoFile}" -f lavfi -i anullsrc=channel_layout=${AUDIO_LAYOUT}:sample_rate=${AUDIO_RATE} ` +
    `-filter_complex "[1:a]atrim=0:${vd.toFixed(3)},asetpts=N/SR/TB[a]" ` +
    `-map 0:v -map "[a]" -c:v copy -c:a aac -b:a 128k -ar ${AUDIO_RATE} -ac ${AUDIO_CHANNELS} "${outFile}"`;
  sh(cmd);
}

function mixVoice(videoFile, voiceName) {
  const vp = voicePath(voiceName);
  const outFile = path.join(TMP_DIR, `${voiceName}-voiced.mp4`);
  const vd = probeDuration(videoFile);

  if (!fs.existsSync(vp)) {
    mixVoiceSilent(videoFile, vd, outFile);
    return outFile;
  }

  const ad = probeDuration(vp);
  if (vd >= ad) {
    mixVoiceVideoLongerOrEqual(videoFile, vp, vd, outFile);
    return outFile;
  }

  mixVoiceAudioLonger(videoFile, vp, vd, ad, outFile);
  return outFile;
}

// ---------- 1. 处理每段 webm ----------
const VW = 1080 * SCALE, VH = 1920 * SCALE;
// 信息带放在 70~80% 位置：拇指停留视觉焦点区，且避开各 html 页面顶部 logo/标题。
// y=1340~1570，下方仍留 50px 给抖音底部 UI（作者名/原声/进度条从 y≈1620 起）。
const TOP_BAR_Y = 1340 * SCALE;
const TOP_BAR_H = 230 * SCALE;
const FS_TITLE  = 44 * SCALE;
const FS_CAP    = 60 * SCALE;
const TITLE_Y   = TOP_BAR_Y + 28 * SCALE;
const CAP_Y     = TOP_BAR_Y + 110 * SCALE;
const segMp4s = [];

// 输出码率控制：1080p 用 crf=20 够清晰；4K 像素是 1080p 的 4 倍，需要更低 CRF 才能保留细节
const CRF = SCALE >= 2 ? 16 : 20;
console.log(`输出分辨率: ${VW}x${VH} (scale=${SCALE}), crf=${CRF}`);

CAPS.segments.forEach((seg, i) => {
  const idx     = i + 1;
  const padded  = String(idx).padStart(2, '0');
  // raw 现在是 mp4（CDP screencast 直出 4K），向后兼容 webm
  let inFile = path.join(RAW_DIR, `seg-${padded}.mp4`);
  if (!fs.existsSync(inFile)) inFile = path.join(RAW_DIR, `seg-${padded}.webm`);
  const outFile = path.join(TMP_DIR, `seg-${padded}.mp4`);
  if (!fs.existsSync(inFile)) {
    console.warn(`! 缺少 ${inFile}，跳过`);
    return;
  }

  const tTitle = writeText(`seg-${padded}-title.txt`, `${seg.model}  ·  ${seg.origin}  ·  #${idx}`);
  const tCap   = writeText(`seg-${padded}-cap.txt`,   seg.caption);

  const filter = [
    `scale=${VW}:${VH}:flags=lanczos:force_original_aspect_ratio=increase,crop=${VW}:${VH}`,
    // 顶部信息带：横贯黑条
    `drawbox=x=0:y=${TOP_BAR_Y}:w=${VW}:h=${TOP_BAR_H}:color=black@0.42:t=fill`,
    // 上半行：模型名 · 国内 · #N（粉色，居中）
    `drawtext=fontfile='${FONT_FF}':textfile='${tTitle}':fontcolor=0xff8fab:fontsize=${FS_TITLE}:x=(w-text_w)/2:y=${TITLE_Y}`,
    // 下半行：吐槽（白色，居中）
    `drawtext=fontfile='${FONT_FF}':textfile='${tCap}':fontcolor=white:fontsize=${FS_CAP}:x=(w-text_w)/2:y=${CAP_Y}`
  ].join(',');

  sh(`ffmpeg -y -i "${inFile}" -vf "${filter}" -an -c:v libx264 -pix_fmt yuv420p -r 30 -preset medium -crf ${CRF} "${outFile}"`);
  // 混入配音
  const voicedFile = mixVoice(outFile, `seg-${padded}`);
  segMp4s.push(voicedFile);
});

// ---------- 2. hook & awards ----------
function processExtra(name, durationSec) {
  let inFile = path.join(RAW_DIR, `${name}.mp4`);
  if (!fs.existsSync(inFile)) inFile = path.join(RAW_DIR, `${name}.webm`);
  const outFile = path.join(TMP_DIR, `${name}.mp4`);
  if (!fs.existsSync(inFile)) {
    console.warn(`! 缺少 ${inFile}，跳过 ${name}`);
    return null;
  }
  // hook/awards 不加钢印
  sh(`ffmpeg -y -i "${inFile}" -vf "scale=${VW}:${VH}:flags=lanczos:force_original_aspect_ratio=increase,crop=${VW}:${VH}" -an -c:v libx264 -pix_fmt yuv420p -r 30 -preset medium -crf ${CRF} "${outFile}"`);
  // 混入配音
  return mixVoice(outFile, name);
}

const hookMp4   = processExtra('hook');
const awardsMp4 = processExtra('awards');

// ---------- 3. 切场黑帧 (0.1s, 含静音音轨) ----------
const blackMp4 = path.join(TMP_DIR, 'black.mp4');
sh(`ffmpeg -y -f lavfi -i color=c=black:s=${VW}x${VH}:d=0.1:r=30 -f lavfi -i anullsrc=channel_layout=${AUDIO_LAYOUT}:sample_rate=${AUDIO_RATE} -c:v libx264 -pix_fmt yuv420p -preset medium -crf ${CRF} -c:a aac -b:a 128k -ar ${AUDIO_RATE} -ac ${AUDIO_CHANNELS} -t 0.1 -map 0:v -map 1:a "${blackMp4}"`);

// ---------- 4. concat ----------
const orderList = [];
if (hookMp4)   { orderList.push(hookMp4); orderList.push(blackMp4); }
segMp4s.forEach((f, i) => {
  orderList.push(f);
  if (i < segMp4s.length - 1) orderList.push(blackMp4);
});
if (awardsMp4) { orderList.push(blackMp4); orderList.push(awardsMp4); }

const concatList = orderList
  .map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`)
  .join('\n');
const concatFile = path.join(TMP_DIR, 'concat.txt');
fs.writeFileSync(concatFile, concatList, 'utf8');

const finalMp4 = path.join(OUT_DIR, 'final.mp4');
// 视频 copy 保持帧；音频重编码并保持 24000/mono，避免 concat 输入参数变化导致 DTS 被改写。
sh(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c:v copy -c:a aac -b:a 128k -ar ${AUDIO_RATE} -ac ${AUDIO_CHANNELS} -shortest "${finalMp4}"`);

console.log(`\n✅ 完成: ${finalMp4}`);
const voiceNote = VOICE_EXISTS ? '含 AI 配音 (需自配 BGM)' : '无声 (后期自配 BGM + 人声)';
console.log(`   ${VW}x${VH} 竖屏, 30fps, ${voiceNote}`);
