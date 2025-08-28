require('dotenv').config();

const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const ytdlp = require('yt-dlp-exec');

// ================= URL helpers =================

// Instagram
function isInstagramReelUrl(u) {
  try {
    const parsed = new URL(u);
    return (
      /(^|\.)instagram\.com$/i.test(parsed.hostname) &&
      /^\/reels?\//i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}
function normalizeReelUrl(u) {
  const parsed = new URL(u);
  const pathname = parsed.pathname.endsWith('/')
    ? parsed.pathname
    : parsed.pathname + '/';
  // обрезаем query/fragment
  return `https://www.instagram.com${pathname}`;
}

// TikTok
function isTikTokUrl(u) {
  try {
    const p = new URL(u);
    // домены тиктока (включая мобильный и короткие редиректы)
    const isHost =
      /(^|\.)tiktok\.com$/i.test(p.hostname) ||
      /^vm\.tiktok\.com$/i.test(p.hostname) ||
      /^vt\.tiktok\.com$/i.test(p.hostname) ||
      /^m\.tiktok\.com$/i.test(p.hostname);
    if (!isHost) return false;

    // если короткая ссылка типа vm.tiktok.com/XXXX — тоже ок (yt-dlp сам разрулит)
    if (/^vm\.tiktok\.com$|^vt\.tiktok\.com$/i.test(p.hostname)) return true;

    // классический формат: /@username/video/123456789...
    if (/^\/@[^/]+\/video\/\d+/i.test(p.pathname)) return true;

    // иногда встречается /t/… с редиректом
    if (/^\/t\//i.test(p.pathname)) return true;

    // fallback: любые ссылки на tiktok считаем кандидатами
    return true;
  } catch {
    return false;
  }
}
function normalizeTikTokUrl(u) {
  try {
    const p = new URL(u);
    // короткие ссылки возвращаем как есть — они редиректятся
    if (/^vm\.tiktok\.com$|^vt\.tiktok\.com$/i.test(p.hostname)) return u;

    // канонизируем без query/fragment
    if (/^\/@[^/]+\/video\/\d+/.test(p.pathname)) {
      const withoutTrailing = p.pathname.endsWith('/') ? p.pathname : p.pathname + '/';
      return `https://www.tiktok.com${withoutTrailing}`;
    }
    // неизвестные пути тоже можно обрезать до без query — yt-dlp обычно справится
    p.search = '';
    p.hash = '';
    return p.toString();
  } catch {
    return u;
  }
}

// Собираем ссылки из текста и entities
function extractUrls(ctx) {
  const urls = new Set();
  const text = ctx.message?.text || ctx.message?.caption || '';

  const raw = text.match(/https?:\/\/\S+/g);
  if (raw) raw.forEach((u) => urls.add(u));

  const entities = ctx.message?.entities || ctx.message?.caption_entities || [];
  for (const e of entities) {
    if (e.type === 'text_link' && e.url) urls.add(e.url);
    if (e.type === 'url') {
      const part = text.slice(e.offset, e.offset + e.length);
      if (part) urls.add(part);
    }
  }
  return Array.from(urls);
}

// ================= Downloader =================

async function downloadWithYtDlp(url) {
  if (!url) throw new Error('Empty URL passed to downloader');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'video-'));
  const outTpl = path.join(tmpDir, 'video.%(ext)s');

  // Важно: короткие флаги (-S) через третий аргумент массивом
  await ytdlp(
    url,
    {
      output: outTpl,
      noPlaylist: true,
      // при необходимости уменьшай лимит размера (например '<45M' из-за лимита Telegram)
      format: 'mp4[filesize<1000M]/mp4/best',
    },
    ['-S', 'res,ext:mp4:m4a']
  );

  const files = fs.readdirSync(tmpDir).map((f) => path.join(tmpDir, f));
  console.log(files[0]);
  const video = files.find((f) => /\.(mp4|m4v|mov)$/i.test(f));
  if (!video) throw new Error('Видео не найдено после загрузки');
  return video; // путь к файлу
}

// ================= Bot =================

const token = process.env.BOT_TOKEN;
if (!token) {
  console.error('❌ BOT_TOKEN check the .env');
  process.exit(1);
}

const bot = new Telegraf(token);

bot.use(async (ctx, next) => {
  console.log('⬅️  Update:', {
    from: ctx.from?.username || ctx.from?.id,
    type: ctx.updateType,
    text: ctx.message?.text,
  });
  await next();
});

bot.start((ctx) =>
  ctx.reply('Я живой, отошли мне ссылку на Instagram Reels или TikTok 🎬')
);

bot.help((ctx) =>
  ctx.reply('Пришли ссылку на Instagram Reels или TikTok — я скачаю и пришлю видео.')
);

bot.catch((err, ctx) => {
  console.error(`⚠️ Bot error for update ${ctx.update?.update_id}:`, err);
});

// Главный обработчик
bot.on('message', async (ctx) => {
  let filePath;
  try {
    const urls = extractUrls(ctx);

    // приоритет: сначала IG Reels, потом TikTok
    const ig = urls.find(isInstagramReelUrl);
    const tt = ig ? null : urls.find(isTikTokUrl);

    if (!ig && !tt) {
      return ctx.reply(`Ты написал: ${ctx.message?.text || 'что-то другое 😅'}`);
    }

    const targetUrl = ig ? normalizeReelUrl(ig) : normalizeTikTokUrl(tt);
    const label = ig ? 'Instagram Reels' : 'TikTok';

    const notice = await ctx.reply(`Нашёл ${label}. Скачиваю… ⏬`);

    filePath = await downloadWithYtDlp(targetUrl);

    // console.log(ctx);

     const caption =
      `👤 Автор: @${ctx.from?.username || ctx.from?.id}\n` +
      `🔗 <a href="${ctx.message?.text}">Оригинал</a>`;

    await ctx.replyWithVideo(
      { source: fs.createReadStream(filePath) },
      { caption: caption, supports_streaming: true, parse_mode: 'HTML' }
    );

    try {
      await ctx.telegram.editMessageText(
        notice.chat.id,
        notice.message_id,
        undefined,
        'Готово ✅'
      );
      await ctx.deleteMessage(ctx.message.message_id);
    } catch {}
  } catch (err) {
    console.error('Download/send error:', err);
    await ctx.reply(
      'Не удалось скачать это видео 😕\n' +
        'Убедись, что ссылка публичная и действительна. ' +
        'Если профиль приватный — скачать нельзя.'
    );
  } finally {
    if (filePath) {
      try {
        fs.unlinkSync(filePath);
        fs.rmdirSync(path.dirname(filePath));
      } catch (e) {
        console.warn('⚠️ Ошибка очистки временных файлов:', e.message);
      }
    }
  }
});

// ================= Launch & graceful shutdown =================

bot.launch().then(() => console.log('✅ Bot launched'));

const PORT = process.env.PORT || 8080;
const server = http
  .createServer((_, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  })
  .listen(PORT, () => console.log(`🩺 Healthcheck on :${PORT}`));

process.once('SIGINT', () => {
  server.close(() => console.log('HTTP server closed'));
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  server.close(() => console.log('HTTP server closed'));
  bot.stop('SIGTERM');
});
