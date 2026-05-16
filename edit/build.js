// build.js — 用 ffmpeg 把 raw/*.webm 合成 final.mp4
// 用法: node build.js  (或 bash build.sh)
//
// 流程:
//  1) 读 captions.json，给每段 webm 加左上角"模型名 · 国内/国外"钢印 + 底部一行吐槽
//  2) 用 100ms 黑帧做切场闪
//  3) concat: hook → seg01 → ... → seg10 → awards
//  4) 输出无声 final.mp4，用户后期自配音乐 + 人声

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

const ROOT     = __dirname;
const RAW_DIR  = path.join(ROOT, 'raw');
const OUT_DIR  = path.join(ROOT, 'out');
const TMP_DIR  = path.join(ROOT, 'tmp');
const CAPS     = JSON.parse(fs.readFileSync(path.join(ROOT, 'captions.json'), 'utf8'));
const SCRIPT   = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const SCALE    = SCRIPT.scale || 1;

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

// ---------- 1. 处理每段 webm ----------
const VW = 1080 * SCALE, VH = 1920 * SCALE;
const FS_NAME = 52 * SCALE, FS_ORI = 32 * SCALE, FS_CAP = 68 * SCALE;
const BOX_X = 40 * SCALE, BOX_Y = 40 * SCALE, BOX_W = 540 * SCALE, BOX_H = 130 * SCALE;
const NAME_X = 70 * SCALE, NAME_Y = 58 * SCALE, ORI_X = 70 * SCALE, ORI_Y = 120 * SCALE;
const CAP_BAR_H = 220 * SCALE, CAP_Y = 160 * SCALE;
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

  const tName = writeText(`seg-${padded}-name.txt`,    seg.model);
  const tOri  = writeText(`seg-${padded}-origin.txt`,  `${seg.origin} · #${idx}`);
  const tCap  = writeText(`seg-${padded}-cap.txt`,     seg.caption);

  const filter = [
    `scale=${VW}:${VH}:flags=lanczos:force_original_aspect_ratio=increase,crop=${VW}:${VH}`,
    `drawbox=x=${BOX_X}:y=${BOX_Y}:w=${BOX_W}:h=${BOX_H}:color=black@0.55:t=fill`,
    `drawtext=fontfile='${FONT_FF}':textfile='${tName}':fontcolor=white:fontsize=${FS_NAME}:x=${NAME_X}:y=${NAME_Y}`,
    `drawtext=fontfile='${FONT_FF}':textfile='${tOri}':fontcolor=0xff8fab:fontsize=${FS_ORI}:x=${ORI_X}:y=${ORI_Y}`,
    `drawbox=x=0:y=${VH - CAP_BAR_H}:w=${VW}:h=${CAP_BAR_H}:color=black@0.55:t=fill`,
    `drawtext=fontfile='${FONT_FF}':textfile='${tCap}':fontcolor=white:fontsize=${FS_CAP}:x=(w-text_w)/2:y=${VH - CAP_Y}`
  ].join(',');

  sh(`ffmpeg -y -i "${inFile}" -vf "${filter}" -an -c:v libx264 -pix_fmt yuv420p -r 30 -preset medium -crf ${CRF} "${outFile}"`);
  segMp4s.push(outFile);
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
  return outFile;
}

const hookMp4   = processExtra('hook');
const awardsMp4 = processExtra('awards');

// ---------- 3. 切场黑帧 (0.1s) ----------
const blackMp4 = path.join(TMP_DIR, 'black.mp4');
sh(`ffmpeg -y -f lavfi -i color=c=black:s=${VW}x${VH}:d=0.1:r=30 -c:v libx264 -pix_fmt yuv420p -preset medium -crf ${CRF} "${blackMp4}"`);

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
sh(`ffmpeg -y -f concat -safe 0 -i "${concatFile}" -c copy "${finalMp4}"`);

console.log(`\n✅ 完成: ${finalMp4}`);
console.log(`   ${VW}x${VH} 竖屏, 30fps, 无声 (后期自配 BGM + 人声)`);
