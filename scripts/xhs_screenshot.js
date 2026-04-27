#!/usr/bin/env node
'use strict';
/**
 * xhs_screenshot.js — 用 Playwright (Node.js) 将 HTML 截图为多张小红书图片
 *
 * 输出协议（stdout 每行一个）:
 *   INFO:<message>      — 进度信息
 *   SAVED:<filepath>    — 已保存的图片路径
 *   DONE:<count>        — 完成，共 count 张
 *   NEED_INSTALL        — 未找到 Chromium，需要下载
 *   ERROR:<message>     — 致命错误
 *
 * 用法:
 *   node xhs_screenshot.js <html_file> <output_dir> \
 *       [--width 1080] [--height 1440] [--padding 40] [--bg '#ffffff']
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ── 解析 CLI 参数 ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const htmlFile  = argv[0];
const outputDir = argv[1];

function flag(name, def) {
  const i = argv.indexOf(name);
  return (i >= 0 && argv[i + 1]) ? argv[i + 1] : def;
}

const imgW    = parseInt(flag('--width',   '1080'), 10);
const imgH    = parseInt(flag('--height',  '1440'), 10);
const padding = parseInt(flag('--padding', '40'),   10);
const bg      = flag('--bg', '#ffffff');

if (!htmlFile || !outputDir) {
  process.stderr.write('Usage: node xhs_screenshot.js <html_file> <output_dir> [--width N] [--height N] [--padding N] [--bg COLOR]\n');
  process.exit(1);
}

// ── 查找 Chromium 可执行文件 ─────────────────────────────────────────────────
function findChromium() {
  const home = os.homedir();

  // 1. Playwright 管理的 Chromium（python playwright / node playwright 共用缓存）
  const cacheDir = path.join(home, '.cache', 'ms-playwright');
  if (fs.existsSync(cacheDir)) {
    const entries = fs.readdirSync(cacheDir).filter(e => e.startsWith('chromium'));
    for (const entry of entries) {
      const candidates = {
        darwin: path.join(cacheDir, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        linux:  path.join(cacheDir, entry, 'chrome-linux', 'chrome'),
        win32:  path.join(cacheDir, entry, 'chrome-win', 'chrome.exe'),
      };
      const p = candidates[process.platform];
      if (p && fs.existsSync(p)) return p;
    }
  }

  // 2. 系统已安装的浏览器
  const system = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser', '/usr/bin/chromium',
      '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  };
  for (const p of (system[process.platform] || [])) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// ── 解析颜色 ─────────────────────────────────────────────────────────────────
function parseColor(hex) {
  let c = hex.replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  return [parseInt(c.slice(0, 2), 16), parseInt(c.slice(2, 4), 16), parseInt(c.slice(4, 6), 16)];
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────
async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  const executablePath = findChromium();
  if (!executablePath) {
    console.log('NEED_INSTALL');
    process.exit(2);
  }

  console.log(`INFO:使用浏览器: ${path.basename(path.dirname(executablePath))}`);

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-web-security'],
  });

  try {
    // 1. 渲染页面
    const page = await browser.newPage({ viewport: { width: imgW, height: 900 } });
    const fileUrl = 'file://' + path.resolve(htmlFile);
    await page.goto(fileUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // 注入 padding + 背景色
    await page.addStyleTag({
      content: `html { background:${bg}; } body { background:${bg}; margin:0; padding:${padding}px; box-sizing:border-box; }`,
    });

    await page.waitForFunction(() => document.fonts.ready);
    await page.waitForTimeout(800);

    // 2. 截全页
    console.log('INFO:正在截取全页…');
    const fullBuf = await page.screenshot({ fullPage: true, type: 'png' });
    console.log(`INFO:截图完成 (${(fullBuf.length / 1024).toFixed(1)} KB)，开始分析空白行…`);

    // 3. 把 PNG 加载进 Chromium Canvas，逐行扫描像素找安全切割点
    const bgRgb = parseColor(bg);
    const dataUrl = 'data:image/png;base64,' + fullBuf.toString('base64');

    const cutInfo = await page.evaluate(async ({ dataUrl, bgRgb, maxH, tolerance }) => {
      // 用 Image + Canvas 拿到 ImageData
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload  = () => resolve(im);
        im.onerror = reject;
        im.src = dataUrl;
      });
      const W = img.naturalWidth, H = img.naturalHeight;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const data = ctx.getImageData(0, 0, W, H).data;

      const [bgR, bgG, bgB] = bgRgb;

      function isBlankRow(y) {
        const rowStart = y * W * 4;
        for (let x = 0; x < W; x++) {
          const i = rowStart + x * 4;
          if (Math.abs(data[i]     - bgR) > tolerance ||
              Math.abs(data[i + 1] - bgG) > tolerance ||
              Math.abs(data[i + 2] - bgB) > tolerance) {
            return false;
          }
        }
        return true;
      }

      // 与 Python 版本完全一致的策略：
      // 从目标切割点往上找最近的空白行（最少切到一半高度）
      const cuts = [];
      let startY = 0;
      while (startY < H) {
        let endY = Math.min(startY + maxH, H);
        if (endY < H) {
          const minCut = startY + Math.floor(maxH / 2);
          let cutY = endY;
          while (cutY > minCut) {
            if (isBlankRow(cutY - 1)) { endY = cutY; break; }
            cutY--;
          }
        }
        cuts.push([startY, endY]);
        startY = endY;
      }
      return { W, H, cuts };
    }, { dataUrl, bgRgb, maxH: imgH, tolerance: 10 });

    console.log(`INFO:总高度 ${cutInfo.H}px → ${cutInfo.cuts.length} 张`);

    // 4. 用同一个 canvas 切片 → toBlob → 保存到本地
    const saved = [];
    for (let i = 0; i < cutInfo.cuts.length; i++) {
      const [y0, y1] = cutInfo.cuts[i];
      const sliceB64 = await page.evaluate(async ({ dataUrl, y0, y1, W }) => {
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im); im.onerror = reject;
          im.src = dataUrl;
        });
        const sliceCanvas = document.createElement('canvas');
        sliceCanvas.width = W; sliceCanvas.height = y1 - y0;
        const sctx = sliceCanvas.getContext('2d');
        sctx.drawImage(img, 0, -y0);
        const blob = await new Promise(r => sliceCanvas.toBlob(r, 'image/png'));
        const ab = await blob.arrayBuffer();
        // 转 base64
        const bytes = new Uint8Array(ab);
        let bin = '';
        for (let k = 0; k < bytes.length; k++) bin += String.fromCharCode(bytes[k]);
        return btoa(bin);
      }, { dataUrl, y0, y1, W: cutInfo.W });

      const outPath = path.join(outputDir, `xhs_${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(outPath, Buffer.from(sliceB64, 'base64'));
      console.log(`SAVED:${outPath}`);
      saved.push(outPath);
    }

    console.log(`DONE:${saved.length}`);
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.log(`ERROR:${err.message}`);
  process.exit(1);
});
