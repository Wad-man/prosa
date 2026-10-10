#!/usr/bin/env node
// social-posts.mjs — автопостинг релиза ProsaMD в Telegram-канал и группу VK.
// Правила постов (владелец, 2026-10-10): каждая функция — отдельный пост, багфиксы —
// пачкой одним постом; у каждого поста обязательно медиа (скриншот/GIF/видео).
// Конвенции тела релиза и имён ассетов: prosa-docs/55-marketing/SOCIAL.md.
//
// Запуск: node scripts/social-posts.mjs --tag v0.1.10 [--dry]
//   --dry  собрать и напечатать посты, ничего не отправлять.
//
// Окружение:
//   GH_TOKEN             — токен GitHub (в Actions — github.token; локально берётся из gh auth)
//   SOCIAL_TG_BOT_TOKEN  — токен бота, администратора канала @prosamd (BotFather)
//   SOCIAL_TG_CHAT       — канал, по умолчанию @prosamd
//   SOCIAL_VK_TOKEN      — ключ доступа группы VK (права: фото, стены, управление)
//   SOCIAL_VK_GROUP      — id или короткое имя группы, по умолчанию prosamd
//
// Медиа: ассеты релиза `feat-<N>[-слаг].png|.jpg|.gif|.mp4` (N = номер фичи в заметках),
// `fixes[-слаг].<ext>` — посту с багфиксами. Без своего медиа пост багфиксов берёт
// фирменную карточку kit/social/prosamd-update-card-1280x640.png из main. Фича без
// медиа — ошибка (код 2), ничего не отправляется.
// Ограничение VK: видео не постится автоматически (только фото/GIF) — см. SOCIAL.md.

import { execFileSync } from 'node:child_process';

const REPO = 'Wad-man/prosa';
const SITE = 'https://prosamd.ru';
const FALLBACK_CARD_URL =
  'https://raw.githubusercontent.com/Wad-man/prosa/main/kit/social/prosamd-update-card-1280x640.png';
const PHOTO_EXT = new Set(['png', 'jpg', 'jpeg', 'webp']);
const ANIM_EXT = new Set(['gif']);
const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v']);

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const tag = opt('--tag');
const DRY = flag('--dry');
if (!tag) {
  console.error('Нужен --tag vX.Y.Z (посмотреть: gh release list -R ' + REPO + ')');
  process.exit(1);
}

const env = process.env;
const tg = {
  token: env.SOCIAL_TG_BOT_TOKEN,
  chat: env.SOCIAL_TG_CHAT || '@prosamd',
};
const vk = {
  token: env.SOCIAL_VK_TOKEN,
  group: env.SOCIAL_VK_GROUP || 'prosamd',
};

// --- GitHub API ---------------------------------------------------------------

function ghToken() {
  if (env.GH_TOKEN || env.GITHUB_TOKEN) return env.GH_TOKEN || env.GITHUB_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    return ''; // публичный репозиторий: без токена тоже работает, только с лимитом
  }
}

const ghHeaders = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'prosamd-social-posts',
  ...(ghToken() ? { Authorization: 'Bearer ' + ghToken() } : {}),
};

// --- Разбор тела релиза -------------------------------------------------------

const FIX_WORD =
  /(больше не|исправ|почин|устран|восстанов|не портит|не вставля|перестал|краш|падает|потеря|не работал|возвращ)/i;
const GROUP_WORD = /(исправл|полировк|мелочи|прочее)/i;

function stripMd(s) {
  return s
    .replace(/<\/?sub>/g, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\s*\(#\d+\)/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s:—–-]+/, '')
    .trim();
}

function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '), cut.lastIndexOf(', '));
  return (stop > max * 0.6 ? cut.slice(0, stop + 1) : cut).trim() + ' …';
}

function parseRelease(body) {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\*\*RU\*\*/.test(l.trim()));
  if (start < 0) throw new Error('В теле релиза нет блока **RU** (конвенция prosa-changelog)');
  const features = [];
  const fixes = [];
  let inFixes = false;
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^(\*\*EN\*\*|\*\*Известное ограничение|---)/.test(t)) break;
    if (!t.startsWith('- ')) {
      // отдельная строка-заголовок группы исправлений: «**Исправления**:», «Полировка:»
      if (GROUP_WORD.test(t) && !t.startsWith('#')) inFixes = true;
      continue;
    }
    const text = t.slice(2);
    const bold = text.match(/^\*\*(.+?)\*\*/);
    const title = stripMd(bold ? bold[1] : text.split(' — ')[0]);
    let isFix = inFixes || FIX_WORD.test(text);
    if (bold && GROUP_WORD.test(bold[1])) {
      isFix = true;
      inFixes = true; // «Полировка: …» открывает хвост исправлений
    }
    if (isFix) {
      fixes.push(stripMd(text));
    } else {
      features.push({ title: truncate(title, 60), body: stripMd(text.replace(/^\*\*.+?\*\*/, '')) });
    }
  }
  return { features, fixes };
}

// --- Медиа --------------------------------------------------------------------

function kindByUrl(url) {
  const ext = (url.split('.').pop() || '').toLowerCase().split('?')[0];
  if (PHOTO_EXT.has(ext)) return 'photo';
  if (ANIM_EXT.has(ext)) return 'animation';
  if (VIDEO_EXT.has(ext)) return 'video';
  return null;
}

function resolveMedia(assets, inlineImgs, features, fixes) {
  const used = new Set();
  const byPattern = (re) =>
    assets.find((a) => !used.has(a.name) && re.test(a.name.toLowerCase()));
  const inline = () => inlineImgs.find((u) => !used.has(u));

  features.forEach((f, i) => {
    const n = i + 1;
    const asset =
      byPattern(new RegExp(`^feat-${n}(?:[-_.].*)?\\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$`)) ||
      byPattern(new RegExp(`^feat[-_]${n}[-_]`)) ||
      null;
    const url = asset ? asset.browser_download_url : inline();
    if (url) {
      used.add(asset ? asset.name : url);
      f.media = { url, kind: kindByUrl(url) };
    }
  });

  if (fixes.length) {
    const asset =
      byPattern(/^fixes(?:[-_.].*)?\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$/) ||
      byPattern(/^fixes[-_]/) ||
      null;
    const url = asset ? asset.browser_download_url : null;
    if (url) {
      used.add(asset.name);
      fixes.media = { url, kind: kindByUrl(url) };
    } else {
      fixes.media = { url: FALLBACK_CARD_URL, kind: 'photo', fallback: true };
    }
  }
}

// --- Тексты постов ------------------------------------------------------------

const releaseUrl = `https://github.com/${REPO}/releases/tag/${tag}`;
const footer = `Подробнее: ${releaseUrl}\nСкачать: ${SITE}`;

function featureCaption(tagName, f) {
  const body = truncate(f.body, 620);
  const head = `ProsaMD ${tagName} — ${f.title}`;
  const cap = `${head}\n\n${body}\n\n${footer}`;
  return cap.length > 1024 ? `${head}\n\n${truncate(f.body, 1024 - head.length - footer.length - 4)}\n\n${footer}` : cap;
}

function fixesCaption(tagName, fixes) {
  const MAX = 10;
  const lines = fixes.slice(0, MAX).map((s) => '— ' + truncate(s, 110));
  if (fixes.length > MAX) lines.push(`— и ещё ${fixes.length - MAX} — в заметках релиза`);
  const head = `ProsaMD ${tagName} — обновление и исправления`;
  const list = lines.join('\n');
  const cap = `${head}\n\nЧто исправлено:\n${list}\n\n${footer}`;
  return cap.length > 1024 ? `${head}\n\nЧто исправлено:\n${lines.slice(0, 6).join('\n')}\n— полный список — в заметках релиза\n\n${footer}` : cap;
}

// --- Отправка: Telegram -------------------------------------------------------

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
};

async function download(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Не скачать медиа ${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

async function sendTelegram(posts) {
  if (!tg.token) {
    console.log('TG: SOCIAL_TG_BOT_TOKEN не задан — пропуск.');
    return false;
  }
  for (const p of posts) {
    const method =
      p.media.kind === 'animation' ? 'sendAnimation' :
      p.media.kind === 'video' ? 'sendVideo' : 'sendPhoto';
    const ext = p.media.url.split('.').pop().toLowerCase().split('?')[0];
    const bytes = await download(p.media.url);
    const form = new FormData();
    form.append('chat_id', tg.chat);
    form.append('caption', p.caption);
    const field = method === 'sendPhoto' ? 'photo' : method === 'sendAnimation' ? 'animation' : 'video';
    form.append(field, new Blob([bytes], { type: MIME[ext] }), `prosamd.${ext}`);
    const r = await fetch(`https://api.telegram.org/bot${tg.token}/${method}`, { method: 'POST', body: form });
    const j = await r.json();
    if (!j.ok) throw new Error(`TG ${method}: ${j.description}`);
    console.log(`TG: отправлен пост «${p.title}» (message_id ${j.result.message_id})`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  return true;
}

// --- Отправка: VK -------------------------------------------------------------

async function vkApi(method, params) {
  const url = new URL(`https://api.vk.com/method/${method}`);
  const body = new URLSearchParams({ ...params, access_token: vk.token, v: '5.199' });
  const r = await fetch(url, { method: 'POST', body });
  const j = await r.json();
  if (j.error) throw new Error(`VK ${method}: ${j.error.error_msg} (${j.error.error_code})`);
  return j.response;
}

async function sendVk(posts) {
  if (!vk.token) {
    console.log('VK: SOCIAL_VK_TOKEN не задан — пропуск.');
    return false;
  }
  let gid = vk.group;
  if (!/^-?\d+$/.test(gid)) {
    const res = await vkApi('groups.getById', { group_ids: gid });
    gid = String(res.groups[0].id);
  }
  const groupId = String(Math.abs(Number(gid)));
  for (const p of posts) {
    if (p.media.kind === 'video') {
      console.log(`VK: пост «${p.title}» пропущен — видео в VK постится вручную (SOCIAL.md).`);
      continue;
    }
    const upload = await vkApi('photos.getWallUploadServer', { group_id: groupId });
    const bytes = await download(p.media.url);
    const ext = p.media.url.split('.').pop().toLowerCase().split('?')[0];
    const form = new FormData();
    form.append('photo', new Blob([bytes], { type: MIME[ext] }), `prosamd.${ext}`);
    const up = await fetch(upload.upload_url, { method: 'POST', body: form });
    const upj = await up.json();
    const saved = await vkApi('photos.saveWallPhoto', {
      group_id: groupId, server: upj.server, photo: upj.photo, hash: upj.hash,
    });
    const att = `photo${saved[0].owner_id}_${saved[0].id}`;
    const res = await vkApi('wall.post', {
      owner_id: '-' + groupId, from_group: '1', message: p.caption, attachments: att,
    });
    console.log(`VK: отправлен пост «${p.title}» (post_id ${res.post_id})`);
    await new Promise((res) => setTimeout(res, 1500));
  }
  return true;
}

// --- Главный ход --------------------------------------------------------------

async function main() {
  console.log(`Релиз ${tag}: забираю из ${REPO}…`);
  const rel = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${encodeURIComponent(tag)}`, { headers: ghHeaders });
  if (!rel.ok) throw new Error(`GitHub API: HTTP ${rel.status}`);
  const release = await rel.json();
  if (release.draft) throw new Error('Релиз ещё черновик — сначала публикация.');

  const { features, fixes } = parseRelease(release.body || '');
  const inlineImgs = [...(release.body || '').matchAll(/!\[[^\]]*\]\((https?:[^)]+)\)/g)].map((m) => m[1]);
  resolveMedia(release.assets || [], inlineImgs, features, fixes);

  const posts = features.map((f) => ({
    title: f.title,
    caption: featureCaption(tag, f),
    media: f.media,
  }));
  if (fixes.length) {
    posts.push({
      title: 'исправления',
      caption: fixesCaption(tag, fixes),
      media: fixes.media,
    });
  }

  const missing = posts.filter((p) => !p.media);
  console.log(`Собрано постов: ${posts.length} (фичи: ${features.length}, багфиксы: ${fixes.length}).\n`);
  for (const p of posts) {
    console.log('═'.repeat(72));
    console.log(`ПОСТ «${p.title}»`);
    console.log(`Медиа: ${p.media ? p.media.url + (p.media.fallback ? '  (фирменная карточка — своего скриншота нет)' : '') : 'НЕТ — нарушение правила «у каждого поста медиа»'}`);
    console.log('─'.repeat(72));
    console.log(p.caption);
    console.log();
  }

  if (!posts.length) throw new Error('Не нашлось ни фич, ни багфиксов — проверь блок **RU** в теле релиза.');
  if (missing.length) {
    console.error(`\n${missing.length} пост(ов) без медиа — отправка отменена. Приложи к релизу ассеты`);
    console.error('feat-1.png … feat-N.png (или .gif/.mp4), см. prosa-docs/55-marketing/SOCIAL.md.');
    process.exit(2);
  }
  if (DRY) {
    console.log('Dry run — ничего не отправлено.');
    return;
  }

  const tgOk = await sendTelegram(posts);
  const vkOk = await sendVk(posts);
  if (!tgOk && !vkOk) {
    console.error('Ни одна площадка не настроена (нет токенов) — см. SOCIAL.md, раздел «Токены».');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('ОШИБКА: ' + e.message);
  process.exit(1);
});
