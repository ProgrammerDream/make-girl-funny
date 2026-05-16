// record.js — Playwright + CDP screencast 真 4K 录屏
// 用法: node record.js
//
// 原理：viewport 仍是 1080×1920（页面布局正确），用 deviceScaleFactor=SCALE 让浏览器
//      按 SCALE 倍物理像素渲染（retina 模式）。CDP Page.screencastFrame 获取的是
//      物理像素截图（2160×3840），通过 stdin 喂给 ffmpeg 实时编码成 mp4。
//
// 动作类型 (坐标都是 1080×1920 viewport 系，不用 *SCALE):
//   wait(ms)
//   move(x,y,steps)
//   click(x,y)
//   clickSel(selector,nth?)
//   clickJs(selector,nth?)        — 直接 el.click() 绕过遮挡
//   hoverSel(selector,nth?)
//   chase(selector,rounds,steps?) — 反复追逐逃跑元素
//   scrollSel(selector,nth?)      — scrollIntoView
//   scroll(y)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs   = require('fs');

const ROOT    = __dirname;
const RAW_DIR = path.join(ROOT, 'raw');
const SCRIPT  = JSON.parse(fs.readFileSync(path.join(ROOT, 'script.json'), 'utf8'));
const VW      = SCRIPT.viewport.width;
const VH      = SCRIPT.viewport.height;
const SCALE   = SCRIPT.scale || 1;
const OUT_W   = VW * SCALE;
const OUT_H   = VH * SCALE;
const FPS     = 30;

if (!fs.existsSync(RAW_DIR)) fs.mkdirSync(RAW_DIR, { recursive: true });

const CURSOR_JS = `
(() => {
  if (window.__fakeCursor) return;
  const c = document.createElement('div');
  c.id = '__fakeCursor';
  c.style.cssText = \`
    position: fixed; left: -100px; top: -100px;
    width: 32px; height: 32px; pointer-events: none;
    z-index: 2147483647;
    border-radius: 50%;
    background: radial-gradient(circle, rgba(255,255,255,.95) 0%, rgba(255,126,179,.85) 40%, rgba(255,126,179,0) 70%);
    box-shadow: 0 0 14px rgba(255,126,179,.9), 0 0 28px rgba(255,126,179,.5);
    transform: translate(-50%,-50%);
  \`;
  document.body.appendChild(c);
  window.__fakeCursor = c;
  window.__moveFakeCursor = (x,y) => { c.style.left = x+'px'; c.style.top = y+'px'; };
  window.__pulseFakeCursor = () => {
    c.animate(
      [{transform:'translate(-50%,-50%) scale(1)'},{transform:'translate(-50%,-50%) scale(2.2)',background:'radial-gradient(circle, rgba(255,255,255,1) 0%, rgba(255,30,120,.95) 40%, rgba(255,30,120,0) 70%)'},{transform:'translate(-50%,-50%) scale(1)'}],
      {duration:380, easing:'ease-out'}
    );
  };

  // ---- 心跳元素：每帧微小变化，强制 screencast 推帧 ----
  // 即使页面静止，浏览器也会把它当成"脏"，于是 dirty-rect 触发 screencastFrame。
  // 1px 大小、几乎透明，肉眼完全看不到，但合成器认它。
  // 用 setInterval(33) 而不是 rAF，因为 rAF 在 ~60fps 会让 screencast 以 60fps 推帧，
  // 而 ffmpeg image2pipe 不认 wallclock 时间戳，会按 30fps 编码导致时长翻倍。
  const heart = document.createElement('div');
  heart.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0.01;background:#000;pointer-events:none;z-index:2147483646;will-change:transform';
  document.body.appendChild(heart);
  let n = 0;
  setInterval(() => {
    heart.style.transform = 'translateX(' + ((n++) % 2) + 'px)';
  }, 33);
})();
`;

async function injectCursor(page) {
  await page.evaluate(CURSOR_JS).catch(() => {});
}

async function moveCursor(page, x, y) {
  await page.mouse.move(x, y);
  await page.evaluate(([x, y]) => window.__moveFakeCursor && window.__moveFakeCursor(x, y), [x, y]).catch(() => {});
}

async function smoothMove(page, fromX, fromY, toX, toY, steps = 25) {
  // 拟人化移动：缓动 + 贝塞尔弧线 + 微抖动 + 偶尔停顿
  // 1) ease-in-out 缓动：起步慢、中间快、终点慢，像真人停下时减速
  // 2) 用一条带垂直偏移的贝塞尔弧线代替直线，更自然
  // 3) 每步 ±0.6px 随机抖动，模拟手抖
  // 4) 步数随距离变化，距离短时不要太多步
  const dx = toX - fromX, dy = toY - fromY;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const realSteps = Math.max(8, Math.min(steps, Math.round(dist / 14)));
  // 弧线幅度：跟距离正相关，最大 80px
  const arc = Math.min(80, dist * 0.18) * (Math.random() > 0.5 ? 1 : -1);
  // 弧线方向垂直于移动方向
  const perpX = dist > 0 ? -dy / dist : 0;
  const perpY = dist > 0 ?  dx / dist : 0;

  for (let i = 1; i <= realSteps; i++) {
    const t = i / realSteps;
    // ease-in-out cubic
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    // 弧线偏移：sin(πt) 在中间最大、两端为 0
    const off = Math.sin(Math.PI * t) * arc;
    const jitterX = (Math.random() - 0.5) * 1.2;
    const jitterY = (Math.random() - 0.5) * 1.2;
    const x = fromX + dx * eased + perpX * off + jitterX;
    const y = fromY + dy * eased + perpY * off + jitterY;
    await moveCursor(page, x, y);
    // 每步耗时也带点抖动，14~22ms
    await page.waitForTimeout(14 + Math.random() * 8);
    // ~6% 概率轻微停顿，模拟"看清楚再走"
    if (Math.random() < 0.06 && i < realSteps - 2) {
      await page.waitForTimeout(60 + Math.random() * 80);
    }
  }
  // 落点精确到目标
  await moveCursor(page, toX, toY);
}

async function clickAtRaw(page, x, y) {
  await moveCursor(page, x, y);
  await page.evaluate(() => window.__pulseFakeCursor && window.__pulseFakeCursor()).catch(() => {});
  await page.waitForTimeout(120);
  await page.mouse.click(x, y);
}

async function getCenter(page, selector, nth = 0) {
  return await page.evaluate(({ sel, nth }) => {
    const list = document.querySelectorAll(sel);
    const el = list[nth];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
  }, { sel: selector, nth });
}

async function runActions(page, actions, current) {
  let cur = current || { x: VW / 2, y: VH / 2 };
  await moveCursor(page, cur.x, cur.y);

  for (const a of actions) {
    if (a.type === 'wait') {
      await page.waitForTimeout(a.ms);

    } else if (a.type === 'move') {
      await smoothMove(page, cur.x, cur.y, a.x, a.y, a.steps || 25);
      cur = { x: a.x, y: a.y };

    } else if (a.type === 'click') {
      await smoothMove(page, cur.x, cur.y, a.x, a.y, 15);
      await clickAtRaw(page, a.x, a.y);
      cur = { x: a.x, y: a.y };

    } else if (a.type === 'clickSel') {
      const c = await getCenter(page, a.selector, a.nth || 0);
      if (!c) { console.warn(`  !! clickSel 找不到 ${a.selector}`); continue; }
      await smoothMove(page, cur.x, cur.y, c.x, c.y, a.steps || 18);
      await clickAtRaw(page, c.x, c.y);
      cur = { x: c.x, y: c.y };

    } else if (a.type === 'clickJs') {
      const c = await getCenter(page, a.selector, a.nth || 0);
      if (c) {
        await smoothMove(page, cur.x, cur.y, c.x, c.y, a.steps || 18);
        await page.evaluate(() => window.__pulseFakeCursor && window.__pulseFakeCursor()).catch(() => {});
        cur = { x: c.x, y: c.y };
      }
      await page.evaluate(({ sel, nth }) => {
        const el = document.querySelectorAll(sel)[nth];
        if (el) el.click();
      }, { sel: a.selector, nth: a.nth || 0 }).catch(() => {});
      await page.waitForTimeout(120);

    } else if (a.type === 'scrollSel') {
      await page.evaluate(({ sel, nth }) => {
        const el = document.querySelectorAll(sel)[nth];
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, { sel: a.selector, nth: a.nth || 0 }).catch(() => {});
      await page.waitForTimeout(250);

    } else if (a.type === 'hoverSel') {
      const c = await getCenter(page, a.selector, a.nth || 0);
      if (!c) { console.warn(`  !! hoverSel 找不到 ${a.selector}`); continue; }
      await smoothMove(page, cur.x, cur.y, c.x, c.y, a.steps || 20);
      cur = { x: c.x, y: c.y };

    } else if (a.type === 'chase') {
      const rounds = a.rounds || 6;
      for (let i = 0; i < rounds; i++) {
        const c = await getCenter(page, a.selector, a.nth || 0);
        if (!c) break;
        await smoothMove(page, cur.x, cur.y, c.x, c.y, a.steps || 22);
        cur = { x: c.x, y: c.y };
        await page.waitForTimeout(180);
      }

    } else if (a.type === 'scroll') {
      await page.mouse.wheel(0, a.y);
      await page.waitForTimeout(200);

    } else {
      console.warn(`  !! 未知 action: ${a.type}`);
    }
  }
  return cur;
}

async function recordOne({ name, fileUrl, duration, actions }) {
  console.log(`\n▶ 录制: ${name}  (${duration}s)  ${fileUrl}`);
  const outPath = path.join(RAW_DIR, `${name}.mp4`);
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);

  const browser = await chromium.launch({
    headless: true,
    // 关键：headless chromium 里 newContext 的 deviceScaleFactor 不影响 screencast 输出尺寸。
    // 必须用 Chrome 启动参数 --force-device-scale-factor 才能让合成器按物理像素渲染。
    args: [`--force-device-scale-factor=${SCALE}`]
  });
  const context = await browser.newContext({
    viewport: { width: VW, height: VH },
    deviceScaleFactor: SCALE
  });
  const page = await context.newPage();
  await page.goto(fileUrl, { waitUntil: 'load' });
  await page.waitForTimeout(400);
  await injectCursor(page);

  // ---- 启动 ffmpeg：从 stdin 读取墙钟时间戳的 mjpeg 流 ----
  // screencast 帧间隔不固定，用 wallclock 时间戳，输出 -vsync cfr 重采样到 30fps
  const ffmpegArgs = [
    '-y',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-use_wallclock_as_timestamps', '1',
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'fast',
    '-crf', SCALE >= 2 ? '16' : '20',
    '-vsync', 'cfr',
    '-r', String(FPS),
    outPath
  ];
  const ffmpeg = spawn('ffmpeg', ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  ffmpeg.stderr.on('data', () => {});
  const ffmpegExit = new Promise((resolve) => ffmpeg.on('exit', resolve));

  // ---- CDP screencast：被动接帧 + 心跳元素强制每帧脏 ----
  // CURSOR_JS 注入了 1px 心跳元素，每个 rAF 都微动一下，让浏览器认为页面"脏"。
  // 这样静态页（hook/awards）也能稳定推帧，rAF 在 headless 下约 60fps。
  const client = await context.newCDPSession(page);
  let frameCount = 0;
  let stopped = false;
  let writeBacklog = Promise.resolve();

  client.on('Page.screencastFrame', async ({ data, sessionId }) => {
    if (stopped) {
      try { await client.send('Page.screencastFrameAck', { sessionId }); } catch (e) {}
      return;
    }
    writeBacklog = writeBacklog.then(() => new Promise((resolve) => {
      try {
        const buf = Buffer.from(data, 'base64');
        const ok = ffmpeg.stdin.write(buf);
        if (!ok) ffmpeg.stdin.once('drain', resolve);
        else resolve();
        frameCount++;
      } catch (e) { resolve(); }
    }));
    try { await client.send('Page.screencastFrameAck', { sessionId }); } catch (e) {}
  });

  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 85,        // 4K 下 quality 92 太重，85 仍然清晰且压力小
    maxWidth: OUT_W,    // 关键：不传的话 screencast 只给 viewport CSS 像素 (1080)
    maxHeight: OUT_H,   // 传 2160/3840 才会按 dsf 出物理像素
    everyNthFrame: 1
  });

  // ---- 严格按 duration 硬截断 ----
  // duration 是 max cap：到点就停录，不管 actions 跑完没。
  // 这样片长完全按 script.json 走，不会被 smoothMove/wait 累积时长拖长。
  const maxDurationMs = duration * 1000;
  let stopRequested = false;
  let actionsErr = null;

  // actions 在后台跑，但全程检查 stopRequested 不会卡死收尾
  const actionsPromise = (actions && actions.length)
    ? runActions(page, actions).catch(e => { actionsErr = e; })
    : Promise.resolve();

  // 到点就停，无论 actions 是否完成
  await Promise.race([
    actionsPromise,
    new Promise(r => setTimeout(r, maxDurationMs))
  ]);
  stopRequested = true;
  if (actionsErr) console.warn(' actions error:', actionsErr.message);

  // ---- 收尾 ----
  stopped = true;
  try { await client.send('Page.stopScreencast'); } catch (e) {}
  await new Promise(r => setTimeout(r, 250));
  await writeBacklog.catch(() => {});
  try { await client.detach(); } catch (e) {}
  try { ffmpeg.stdin.end(); } catch (e) {}
  await ffmpegExit;

  await page.close().catch(() => {});
  await context.close().catch(() => {});
  await browser.close().catch(() => {});

  console.log(`  ✓ ${name}.mp4  (${frameCount} 帧, ~${(frameCount / FPS).toFixed(1)}s)`);
}

function fileToUrl(p) {
  const abs = path.resolve(ROOT, p);
  return 'file:///' + abs.replace(/\\/g, '/');
}

(async () => {
  console.log(`分辨率: ${OUT_W}x${OUT_H} (scale=${SCALE}, dsf=${SCALE}, viewport=${VW}x${VH})`);
  console.log(`帧率: ${FPS}fps  编码: x264 crf=${SCALE >= 2 ? 16 : 20}\n`);

  // ---- --only 参数：只录指定段，复用其他已有 raw ----
  // 用法: node record.js --only hook
  //       node record.js --only hook,awards,seg-04
  //       node record.js --only seg-04,seg-07
  // 不传则全部重录。名字匹配 'hook' / 'awards' / 'seg-XX'（XX 是 01~10 的两位数字）。
  const onlyArg = process.argv.find(a => a.startsWith('--only'));
  let only = null;
  if (onlyArg) {
    const raw = onlyArg.includes('=') ? onlyArg.split('=')[1] : process.argv[process.argv.indexOf(onlyArg) + 1];
    if (raw) only = new Set(raw.split(',').map(s => s.trim()).filter(Boolean));
  }
  const should = (name) => !only || only.has(name);
  if (only) console.log(`仅录制: ${[...only].join(', ')}\n`);

  if (should('hook')) {
    await recordOne({
      name: 'hook',
      fileUrl: fileToUrl('extras/hook.html'),
      duration: 3,
      actions: []
    });
  }

  for (const seg of SCRIPT.segments) {
    const name = `seg-${String(seg.id).padStart(2, '0')}`;
    if (!should(name)) continue;
    await recordOne({
      name,
      fileUrl: fileToUrl(seg.file),
      duration: seg.duration,
      actions: seg.actions
    });
  }

  if (should('awards')) {
    await recordOne({
      name: 'awards',
      fileUrl: fileToUrl('extras/awards.html'),
      duration: 5,
      actions: []
    });
  }

  console.log('\n✅ 录制完成。raw/*.mp4 已经是真 4K。下一步: node build.js');
})().catch(e => {
  console.error(e);
  process.exit(1);
});
