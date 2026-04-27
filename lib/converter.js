'use strict';

const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const cheerio = require('cheerio');
const hljs = require('highlight.js');
const juice = require('juice');
const matter = require('gray-matter');
const katex = require('katex');

// ─────────────────────────────────────────────
//  工具函数
// ─────────────────────────────────────────────

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─────────────────────────────────────────────
//  marked 扩展：Block 公式 $$...$$
// ─────────────────────────────────────────────

const blockMathExt = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const idx = src.indexOf('$$');
    return idx >= 0 ? idx : undefined;
  },
  tokenizer(src) {
    // 匹配 $$...$$ (greedy 最短)
    const match = src.match(/^\$\$([\s\S]+?)\$\$/);
    if (match) {
      return {
        type: 'blockMath',
        raw: match[0],
        math: match[1].trim(),
      };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: true,
        throwOnError: false,
        output: 'html',
        strict: false,
      });
      return (
        `<div class="math-block" style="text-align:center;overflow-x:auto;` +
        `margin:1.2em 0;padding:0.5em 0;">${html}</div>\n`
      );
    } catch (e) {
      return `<pre><code class="math">${escapeHtml(token.math)}</code></pre>\n`;
    }
  },
};

// ─────────────────────────────────────────────
//  marked 扩展：Inline 公式 $...$
// ─────────────────────────────────────────────

const inlineMathExt = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    // 找到下一个单 $ 的位置（跳过 $$）
    let i = src.indexOf('$');
    while (i !== -1 && src[i + 1] === '$') {
      i = src.indexOf('$', i + 2);
    }
    return i >= 0 ? i : undefined;
  },
  tokenizer(src) {
    // 必须以单 $ 开头（不是 $$）
    if (src.startsWith('$$')) return undefined;
    const match = src.match(/^\$([^\$\n]+?)\$/);
    if (match) {
      return {
        type: 'inlineMath',
        raw: match[0],
        math: match[1],
      };
    }
  },
  renderer(token) {
    try {
      const html = katex.renderToString(token.math, {
        displayMode: false,
        throwOnError: false,
        output: 'html',
        strict: false,
      });
      return `<span class="math-inline">${html}</span>`;
    } catch (e) {
      return `<code class="math">${escapeHtml(token.math)}</code>`;
    }
  },
};

// ─────────────────────────────────────────────
//  创建 marked 实例（不污染全局）
// ─────────────────────────────────────────────

const markedInstance = new Marked();

markedInstance.use({
  gfm: true,
  breaks: false,
  extensions: [blockMathExt, inlineMathExt],
  renderer: {
    // 图片渲染：支持 caption（alt 文本作为说明文字）
    image(href, title, text) {
      const alt = text || '';
      const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
      const imgStyle =
        'max-width:100%;display:block;margin:0 auto;';
      const img = `<img src="${href}" alt="${escapeHtml(alt)}"${titleAttr} style="${imgStyle}">`;

      const captionStyle =
        'display:block;text-align:center;color:#999;font-size:14px;' +
        'margin-top:8px;line-height:1.5;font-style:normal;';
      const figStyle = 'margin:1.5em auto;text-align:center;';

      if (alt) {
        return (
          `<figure style="${figStyle}">` +
          img +
          `<figcaption style="${captionStyle}">${alt}</figcaption>` +
          `</figure>\n`
        );
      }
      return `<figure style="${figStyle}">${img}</figure>\n`;
    },
  },
});

// ─────────────────────────────────────────────
//  图片转 Base64
// ─────────────────────────────────────────────

function convertImagesToBase64($, baseDir) {
  $('img').each((_, elem) => {
    const img = $(elem);
    const src = img.attr('src');
    if (!src || src.startsWith('data:') || /^https?:\/\//.test(src) || src.startsWith('//')) {
      return;
    }
    const imagePath = path.isAbsolute(src)
      ? path.join(baseDir, src)
      : path.resolve(baseDir, src);
    try {
      if (!fs.existsSync(imagePath)) return;
      const buf = fs.readFileSync(imagePath);
      const ext = path.extname(imagePath).toLowerCase();
      const mimeMap = {
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.png': 'image/png',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
      };
      const mime = mimeMap[ext] || 'image/jpeg';
      img.attr('src', `data:${mime};base64,${buf.toString('base64')}`);
    } catch (_) {
      // 忽略，继续处理
    }
  });
}

// ─────────────────────────────────────────────
//  代码块高亮（macOS 风格）
// ─────────────────────────────────────────────

function enhanceCodeBlocks($) {
  const hlCssPath = require.resolve('highlight.js/styles/github.css');
  const hlCss = fs.readFileSync(hlCssPath, 'utf8');

  if ($('head').length === 0) $('html').prepend('<head></head>');
  $('head').append(`<style>${hlCss}</style>`);

  const macStyle = `
    pre.mac-code {
      font-size: 90%; overflow-x: auto; border-radius: 8px;
      padding: 0 !important; line-height: 1.5; margin: 10px 8px;
      background-color: #f6f8fa; border: 1px solid #eaedf0;
    }
    .mac-dots { display: block; margin: 12px 16px 0; }
    pre.mac-code code.hljs {
      display: -webkit-box; padding: 0.5em 1em 1em;
      overflow-x: auto; text-indent: 0; color: inherit;
      background: none; white-space: nowrap; margin: 0;
    }
  `;
  $('head').append(`<style>${macStyle}</style>`);

  const svgDots =
    `<svg width="52" height="12" viewBox="0 0 52 12" fill="none" xmlns="http://www.w3.org/2000/svg">` +
    `<circle cx="6" cy="6" r="6" fill="#FF5F56"/>` +
    `<circle cx="26" cy="6" r="6" fill="#FFBD2E"/>` +
    `<circle cx="46" cy="6" r="6" fill="#27C93F"/></svg>`;

  $('pre').each((_, elem) => {
    const pre = $(elem);
    const code = pre.find('code');
    if (code.length === 0 || pre.hasClass('mac-code')) return;

    const rawCode = code.text();
    let language = 'plaintext';
    const classes = (pre.attr('class') || '') + ' ' + (code.attr('class') || '');
    const langMatch = classes.match(/language-([\w-]+)/);
    if (langMatch && hljs.getLanguage(langMatch[1])) {
      language = langMatch[1];
    }

    let highlighted;
    try {
      highlighted = hljs.highlight(rawCode, { language }).value;
    } catch (_) {
      highlighted = hljs.highlightAuto(rawCode).value;
    }

    // 换行和空格兼容微信
    highlighted = highlighted.replace(/(<[^>]+>)|([^<]+)/g, (m, tag, txt) => {
      if (tag) return tag;
      return txt.replace(/\r\n|\r|\n/g, '<br>').replace(/ /g, '&nbsp;');
    });

    pre.replaceWith(
      `<pre class="mac-code"><span class="mac-dots">${svgDots}</span>` +
      `<code class="hljs ${language}">${highlighted}</code></pre>`
    );
  });
}

// ─────────────────────────────────────────────
//  核心渲染函数：Markdown → 文章 body HTML
// ─────────────────────────────────────────────

/**
 * 解析 Markdown 文件，返回文章 body HTML + 元数据。
 * @param {string} mdFilePath 绝对路径
 * @returns {{ bodyHtml: string, title: string, rawMarkdown: string }}
 */
function renderMarkdown(mdFilePath) {
  const fullPath = path.isAbsolute(mdFilePath)
    ? mdFilePath
    : path.join(process.cwd(), mdFilePath);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`Markdown 文件不存在: ${fullPath}`);
  }

  const raw = fs.readFileSync(fullPath, 'utf8');
  const { content: mdContent, data: frontmatter } = matter(raw);

  // Markdown → HTML
  const parsedHtml = markedInstance.parse(mdContent);

  // cheerio 处理
  const $ = cheerio.load(parsedHtml, { decodeEntities: false });
  const baseDir = path.dirname(fullPath);

  convertImagesToBase64($, baseDir);
  enhanceCodeBlocks($);

  // 提取 body HTML（去掉 cheerio 自动包裹的 <html><body> 等标签）
  const bodyHtml = $('body').html() || $.html();

  // 从 frontmatter 或第一个 h1 提取标题
  let title = frontmatter.title || '';
  if (!title) {
    const firstH1 = $('h1').first().text();
    title = firstH1 || path.basename(fullPath, '.md');
  }

  return { bodyHtml, title, rawMarkdown: raw };
}

// ─────────────────────────────────────────────
//  构建完整 HTML（供导出/保存用）
// ─────────────────────────────────────────────

/**
 * 将 body HTML 包裹进模板并内联 CSS（for WeChat 粘贴）。
 * @param {string} bodyHtml
 * @param {string} templatePath
 * @returns {string} 完整 HTML
 */
function buildFullHtml(bodyHtml, templatePath) {
  let template = fs.readFileSync(templatePath, 'utf8');
  template = template.replace('{{body}}', bodyHtml);

  const $ = cheerio.load(template, { decodeEntities: false });

  // 加入 KaTeX CSS（去掉 @font-face，避免字体路径问题）
  const katexCssPath = require.resolve('katex/dist/katex.min.css');
  const katexCss = fs.readFileSync(katexCssPath, 'utf8')
    .replace(/@font-face\s*\{[\s\S]*?\}/g, '');
  $('head').append(`<style>${katexCss}</style>`);

  let processedHtml = $.html();

  // juice 内联 CSS（保留 &nbsp; 和 <br>）
  const NBSP = '\u200B__NBSP__\u200B';
  const BR = '\u200B__BR__\u200B';
  processedHtml = processedHtml
    .replace(/&nbsp;/g, NBSP)
    .replace(/<br\s*\/?>/gi, BR);

  let finalHtml = juice(processedHtml, {
    removeStyleTags: false,
    applyStyleTags: true,
    preserveImportant: true,
  });

  finalHtml = finalHtml
    .replace(new RegExp(NBSP.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '&nbsp;')
    .replace(new RegExp(BR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), '<br>');

  return finalHtml;
}

// ─────────────────────────────────────────────
//  高级入口：一步完成转换并写文件
// ─────────────────────────────────────────────

/**
 * @param {string} mdFilePath
 * @param {string} templatePath
 * @param {string} outputPath
 * @returns {string} 输出文件路径
 */
function convertMarkdownToWeChat(mdFilePath, templatePath, outputPath) {
  const { bodyHtml } = renderMarkdown(mdFilePath);
  const finalHtml = buildFullHtml(bodyHtml, templatePath);

  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  fs.writeFileSync(outputPath, finalHtml, 'utf8');
  return outputPath;
}

module.exports = {
  renderMarkdown,
  buildFullHtml,
  convertMarkdownToWeChat,
};
