# girl-fun 视频自动剪辑

把 `cn/` + `us/` 下的 10 个 html 自动录屏 + 拼成一支竖屏成片，无声，后期自配音乐和人声。

支持 **1080×1920** 或 **2160×3840（真 4K）** 一键切换（改 `script.json` 的 `"scale": 1` 或 `2`）。

> 踩坑历史看 `总结本次所有踩坑记录.md`。

## 一次性安装

```powershell
cd C:\record\develop\important\hermes-agent\girl-fun\edit
npm install
npx playwright install chromium
```

确认 ffmpeg 在 PATH：

```powershell
ffmpeg -version
```

## 出片三步

```powershell
# 1) 录屏 — CDP screencast 真 4K 录制，约 3~5 分钟
node record.js

# 2) 合成 — ffmpeg 加钢印/字幕/拼接，输出 out/final.mp4
node build.js

# 3) 看片
start out\final.mp4
```

## 分辨率切换

编辑 `script.json` 第 4 行：

```json
"scale": 1    // 1080×1920，录制快，文件小
"scale": 2    // 2160×3840 真 4K，retina 渲染，文件大
```

改完重新 `node record.js && node build.js`。

## 想改什么去哪改

| 改什么 | 改哪个文件 | 改完要做什么 |
|---|---|---|
| **吐槽文案** | `captions.json` | 重新跑 `node build.js` |
| **顺序 / 哪段几秒 / 点哪里** | `script.json` | 重新跑 `node record.js` 再 `node build.js` |
| **钩子页 / 颁奖榜样式** | `extras/hook.html`、`extras/awards.html` | 重新跑 `node record.js` 再 `node build.js` |
| **钢印颜色/字号、字幕条样式** | `build.js` 里 `filter` 那段 | 重新跑 `node build.js` |
| **分辨率 (1K/4K)** | `script.json` 的 `"scale"` | 重新跑两步 |

## 输出说明

- `raw/*.mp4` — CDP screencast 原始录屏（已是真 4K），做完成片可删
- `tmp/*.mp4` — 中间产物（每段加完字幕/钢印）
- `out/final.mp4` — 最终成片，无声

## 后期建议

1. 拖进剪映/CapCut，**这条 mp4 直接放主轨**
2. 上面叠你的人声配音
3. 下面铺一条 BGM，在 GLM 烟花那段（最后一段）做个 drop
4. 切场黑帧那 0.1s 处加一个"咔"音效会更顺

## 常见问题

**录屏卡在某一段不动？** 大概率是页面里的 modal 拦截了点击。打开对应 html 手动玩一遍，把选择器在 `script.json` 里调一下。

**字幕变乱码 / 框框？** `build.js` 默认找微软雅黑（`C:/Windows/Fonts/msyhbd.ttc`）。如果你电脑没有，改 `FONT_CANDIDATES` 数组指向已有字体。

**鼠标看不到？** record.js 注入了一个粉色虚拟光标（`__fakeCursor`），跟着 `page.mouse.move` 走。如果某个页面的 z-index 把它盖住了，去 `record.js` 的 `CURSOR_JS` 里把 `z-index` 调更大。

**hook/awards 录出 0 帧？** 心跳元素没注入成功。检查页面是否有 CSP 限制 inline script，或打开 DevTools 看 `__fakeCursor` 是否存在。

**seg-XX.mp4 文件很小（<100KB）？** screencast 没推出帧。确认 `--force-device-scale-factor` 和 `maxWidth/maxHeight` 参数都传了。

**录出来的视频不是 4K？** 跑 `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of default=nw=1 raw/seg-01.mp4` 验证。如果还是 1080，看坑 12。
