// Ziddi Power - bot ka code
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import sharp from 'sharp';
import QRCode from 'qrcode';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  delay,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  normalizeMessageContent,
} from '@whiskeysockets/baileys';

export const CFG = {
  prefix: '.',
  name: 'Ziddi Power',
  owner: 'Ziddi Boy',
  version: '1.0.0',
  menuImage: path.join(process.cwd(), 'public', 'menu.jpg'),
  channel: process.env.CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbDdwnhKGGGOSd9rHl1D',
  extraOwners: (process.env.OWNER || '').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean),
};
const CHANNEL_CODE = CFG.channel.split('/channel/')[1];
const logger = pino({ level: 'silent' });
export const bots = new Map();

const norm = (j) => (j || '').split(':')[0].split('@')[0];
const fmtTime = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${Math.floor(s % 60)}s`;

// ---------- SESSION SAVE / RESTORE (MongoDB) ----------
// Render free plan mein files har deploy par mit jati hain, isliye session
// MongoDB mein save hota hai aur bot start hote hi wapas aa jata hai.
// Render > Environment mein MONGO_URL set karo. Na ho to purana tareeqa chalega.
let _col = null;
async function db() {
  if (!process.env.MONGO_URL) return null;
  if (_col) return _col;
  try {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(process.env.MONGO_URL);
    await client.connect();
    const d = client.db('ziddi_power');
    _col = { meta: d.collection('sessions'), files: d.collection('files') };
    return _col;
  } catch (e) {
    console.error('MongoDB connect nahi hua:', e?.message);
    return null;
  }
}

const seenFiles = new Map(); // key -> Map(fileName -> signature)
const timers = new Map();

async function backupSession(key, dir) {
  const c = await db();
  if (!c) return;
  if (!bots.get(key)?.sock?.authState?.creds?.registered) return; // pairing poori hone se pehle save nahi
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const old = seenFiles.get(key) || new Map();
  const next = new Map(old);
  const ops = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const sig = st.mtimeMs + ':' + st.size;
    if (old.get(n) === sig) continue;
    ops.push({ updateOne: { filter: { _id: `${key}::${n}` }, update: { $set: { key, name: n, data: fs.readFileSync(p, 'utf8') } }, upsert: true } });
    next.set(n, sig);
  }
  for (const n of old.keys()) {
    if (!names.includes(n)) {
      ops.push({ deleteOne: { filter: { _id: `${key}::${n}` } } });
      next.delete(n);
    }
  }
  await c.meta.updateOne({ _id: key }, { $set: { dir } }, { upsert: true });
  if (ops.length) await c.files.bulkWrite(ops);
  seenFiles.set(key, next);
}

function scheduleBackup(key, dir) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => backupSession(key, dir).catch(() => {}), 3000));
}

async function restoreSession(key, dir) {
  const c = await db();
  if (!c) return false;
  if (fs.existsSync(path.join(dir, 'creds.json'))) return true;
  const docs = await c.files.find({ key }).toArray();
  if (!docs.length) return false;
  fs.mkdirSync(dir, { recursive: true });
  for (const d of docs) fs.writeFileSync(path.join(dir, d.name), d.data);
  return true;
}

async function forgetSession(key) {
  seenFiles.delete(key);
  clearTimeout(timers.get(key));
  const c = await db();
  if (!c) return;
  await c.files.deleteMany({ key });
  await c.meta.deleteOne({ _id: key });
}

// Bot start hote hi saare saved sessions wapas chalu
export async function restoreAll() {
  const c = await db();
  if (!c) return;
  const list = await c.meta.find({}).toArray();
  for (const s of list) {
    try {
      if (bots.has(s._id)) continue;
      if (!(await restoreSession(s._id, s.dir))) continue;
      if (bots.has(s._id)) continue;
      await startBot(s._id, s.dir, { flags: { linked: true } });
      console.log('Session restore hua:', s._id);
      await delay(1500);
    } catch (e) {
      console.error('Restore fail', s._id, e?.message);
    }
  }
}

// har 60 second mein backup + deploy band hone se pehle aakhri backup
setInterval(() => {
  for (const [k, e] of bots) if (!e.stopped && e.dir) backupSession(k, e.dir).catch(() => {});
}, 60000).unref();
process.on('SIGTERM', async () => {
  try {
    await Promise.race([
      Promise.all([...bots].map(([k, e]) => (e.dir ? backupSession(k, e.dir) : null))),
      new Promise((r) => setTimeout(r, 8000)),
    ]);
  } catch {}
  process.exit(0);
});

export function stopBot(key, removeDir) {
  const e = bots.get(key);
  if (!e) return;
  e.stopped = true;
  try { e.sock?.ev.removeAllListeners(); e.sock?.end(undefined); } catch {}
  bots.delete(key);
  if (removeDir) {
    try { fs.rmSync(removeDir, { recursive: true, force: true }); } catch {}
    forgetSession(key).catch(() => {});
  }
}

export async function startBot(key, dir, opts = {}) {
  const flags = opts.flags || { linked: false };
  await restoreSession(key, dir).catch(() => {});
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu('Chrome'),
    auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logger) },
    markOnlineOnConnect: false,
  });
  const entry = bots.get(key) || { mode: 'public', anti: new Set(), started: Date.now(), stopped: false };
  entry.sock = sock;
  entry.dir = dir;
  bots.set(key, entry);
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    scheduleBackup(key, dir);
  });

  if (!state.creds.registered && opts.onCode) {
    await delay(2500);
    const raw = await sock.requestPairingCode(opts.number);
    opts.onCode(raw.match(/.{1,4}/g).join('-'));
  }

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
    if (connection === 'open') {
      entry.number = norm(sock.user.id);
      if (!entry.announced) {
        entry.announced = true;
        sendActivated(sock, entry).catch(() => {});
      }
      if (!flags.linked && opts.onLinked) {
        flags.linked = true;
        opts.onLinked(sock, entry).catch(() => {});
      }
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      try { sock.ev.removeAllListeners(); } catch {}
      if (entry.stopped) return;
      if (code === DisconnectReason.loggedOut) {
        bots.delete(key);
        forgetSession(key).catch(() => {});
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        opts.onEnd?.('loggedOut');
      } else if (opts.number && !flags.linked && code !== DisconnectReason.restartRequired) {
        stopBot(key, dir);
        opts.onEnd?.('failed');
      } else {
        const wait = code === DisconnectReason.restartRequired ? 500 : 3000;
        setTimeout(() => startBot(key, dir, { ...opts, onCode: undefined, flags }).catch(() => {}), wait);
      }
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) handle(sock, entry, m).catch(() => {});
  });
  return sock;
}

async function getMedia(sock, m, types) {
  const msg = normalizeMessageContent(m.message);
  let target = null;
  if (types.some((t) => msg[t])) target = { key: m.key, message: msg };
  else {
    const ci = msg.extendedTextMessage?.contextInfo;
    const q = ci?.quotedMessage && normalizeMessageContent(ci.quotedMessage);
    if (q && types.some((t) => q[t])) {
      target = { key: { remoteJid: m.key.remoteJid, id: ci.stanzaId, participant: ci.participant }, message: q };
    }
  }
  if (!target) return null;
  return downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
}

const idsOf = (p) => [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean).map(norm);
const isAdminIn = (meta, ids) => meta.participants.some((p) => p.admin && idsOf(p).some((x) => ids.map(norm).includes(x)));

// ---------- MENU ----------
// Nayi command add karo to bas yahan category ki list mein naam likh do.
const MENU = {
  MAIN: ['menu', 'ping', 'alive', 'owner', 'runtime', 'channel'],
  DOWNLOADER: ['song', 'video', 'tiktok', 'aio'],
  'STICKER & MEDIA': ['sticker', 'toimg', 'qr'],
  TOOLS: ['calc', 'time', 'flip', 'dice'],
  GROUP: ['tagall', 'hidetag', 'kick', 'promote', 'demote', 'open', 'close', 'link', 'groupinfo', 'antilink'],
  OWNER: ['mode', 'follow'],
};

function buildMenu(entry) {
  const total = Object.values(MENU).flat().length;
  const tail = '└────────────────────────\n┄┄●-○\n\n';
  let t = `✨ *${CFG.name.toUpperCase()} MULTI-DEVICE* ✨\n\n` +
    `┌─────── 〔 *INFO BOX* 〕 ───────•┄┄●-○\n` +
    `│ 👑 *OWNER:* ${CFG.owner}\n` +
    `│ 🔰 *PREFIX:* ${CFG.prefix}\n` +
    `│ 🌐 *MODE:* ${entry.mode}\n` +
    `│ 📊 *COMMANDS:* ${total}\n` +
    `│ ⏳ *RUNTIME:* ${fmtTime((Date.now() - entry.started) / 1000)}\n` +
    `│ 🏷️ *VERSION:* ${CFG.version}\n` + tail;
  for (const [name, cmds] of Object.entries(MENU)) {
    t += `┌─────── 〔 *${name}* 〕 ───────•┄┄●-○\n`;
    t += cmds.map((c) => `│ ⚡ \`${c.toUpperCase()}\``).join('\n') + '\n' + tail;
  }
  return t.trimEnd();
}

const readMenuImage = () => { try { return fs.readFileSync(CFG.menuImage); } catch { return null; } };

// "Forwarded many times + View channel" wala look
async function channelContext(sock, entry) {
  try {
    if (!entry.channelId) entry.channelId = (await sock.newsletterMetadata('invite', CHANNEL_CODE)).id;
    return {
      forwardingScore: 999,
      isForwarded: true,
      forwardedNewsletterMessageInfo: { newsletterJid: entry.channelId, newsletterName: CFG.name, serverMessageId: -1 },
    };
  } catch { return undefined; }
}

async function sendMenu(sock, chat, m, entry) {
  const caption = buildMenu(entry);
  const image = readMenuImage();
  const contextInfo = await channelContext(sock, entry);
  const content = image ? { image, caption, contextInfo } : { text: caption, contextInfo };
  return sock.sendMessage(chat, content, { quoted: m });
}

// Bot connect hote hi apne number par "Activated" message
async function sendActivated(sock, entry) {
  const image = readMenuImage();
  const caption = `🤖 *${CFG.name.toUpperCase()} Activated*\n\nType ${CFG.prefix}menu for commands\n\n🔥 Version: ${CFG.version}`;
  const to = norm(sock.user.id) + '@s.whatsapp.net';
  await sock.sendMessage(to, image ? { image, caption } : { text: caption });
}

// ---------- DOWNLOADER helpers ----------
const URL_RE = /https?:\/\/\S+/i;
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('Server ne jawab nahi diya (' + r.status + ')');
  return r.json();
}
const isImageUrl = (u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u);

// Naam se YouTube par search (bina link ke)
async function ytSearch(q) {
  let yts;
  try { yts = (await import('yt-search')).default; }
  catch { throw new Error('yt-search package install nahi hai (package.json mein add karo)'); }
  return (await yts(q)).videos?.[0] || null;
}
// Cobalt se direct download link lena
async function cobaltGet(link, body = {}) {
  const api = process.env.COBALT_API;
  if (!api) throw new Error('COBALT_API set nahi hai (Render > Environment)');
  const j = await getJson(api, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(process.env.COBALT_KEY ? { Authorization: 'Api-Key ' + process.env.COBALT_KEY } : {}) },
    body: JSON.stringify({ url: link, ...body }),
  });
  if (j.status === 'error') throw new Error(j.error?.code || 'download fail');
  if (!j.url) throw new Error('Is link se kuch nahi mila');
  return j.url;
}
const isAudioUrl = (u) => /\.(mp3|m4a|opus|ogg|wav)(\?|$)/i.test(u);
const mediaPayload = (u, caption) =>
  isImageUrl(u) ? { image: { url: u }, caption } : isAudioUrl(u) ? { audio: { url: u }, mimetype: 'audio/mpeg' } : { video: { url: u }, caption };

async function handle(sock, entry, m) {
  if (!m.message || m.key.remoteJid === 'status@broadcast') return;
  const chat = m.key.remoteJid;
  const isGroup = chat.endsWith('@g.us');
  const msg = normalizeMessageContent(m.message);
  const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
  const sender = m.key.fromMe ? sock.user.id : m.key.participant || chat;
  const senderIds = [sender, m.key.participantAlt].filter(Boolean);
  const isOwner = m.key.fromMe || senderIds.some((x) => CFG.extraOwners.includes(norm(x)));
  const reply = (t, extra = {}) => sock.sendMessage(chat, { text: t, ...extra }, { quoted: m });

  if (isGroup && !m.key.fromMe && entry.anti.has(chat) && /chat\.whatsapp\.com\//i.test(text)) {
    try {
      const meta = await sock.groupMetadata(chat);
      const botIds = [sock.user.id, sock.user.lid];
      if (isAdminIn(meta, botIds) && !isAdminIn(meta, senderIds)) {
        await sock.sendMessage(chat, { delete: m.key });
        await sock.sendMessage(chat, { text: 'Group link allowed nahi hai.' });
      }
    } catch {}
    return;
  }

  if (!text.startsWith(CFG.prefix)) return;
  const [cmdRaw, ...rest] = text.slice(CFG.prefix.length).trim().split(/\s+/);
  const cmd = (cmdRaw || '').toLowerCase();
  const args = rest.join(' ');
  if (!cmd) return;
  if (entry.mode === 'private' && !isOwner) return;

  const groupOnly = async () => {
    if (!isGroup) { await reply('Ye command sirf group me chalti hai.'); return null; }
    return sock.groupMetadata(chat);
  };
  const adminGate = async () => {
    const meta = await groupOnly();
    if (!meta) return null;
    if (!isOwner && !isAdminIn(meta, senderIds)) { await reply('Sirf group admin ye command use kar sakta hai.'); return null; }
    if (!isAdminIn(meta, [sock.user.id, sock.user.lid])) { await reply('Pehle mujhe group admin banao.'); return null; }
    return meta;
  };
  const targetOf = () => {
    const ci = msg.extendedTextMessage?.contextInfo;
    return ci?.mentionedJid?.[0] || ci?.participant || null;
  };

  try {
    switch (cmd) {
      case 'menu': case 'help':
        return sendMenu(sock, chat, m, entry);
      case 'ping': {
        const t0 = Date.now();
        const s = await reply('Pong...');
        return sock.sendMessage(chat, { text: `Pong: ${Date.now() - t0} ms`, edit: s.key });
      }
      case 'alive': return reply(`${CFG.name} zinda hai ✅\nUptime: ${fmtTime((Date.now() - entry.started) / 1000)}`);
      case 'runtime': return reply(`Uptime: ${fmtTime((Date.now() - entry.started) / 1000)}`);
      case 'owner': return reply(`Owner: ${CFG.owner}\nBot number: wa.me/${entry.number || norm(sock.user.id)}`);
      case 'channel': return reply(`Hamara WhatsApp channel:\n${CFG.channel}`);

      case 'sticker': case 's': {
        const buf = await getMedia(sock, m, ['imageMessage']);
        if (!buf) return reply(`Photo bhejo ya kisi photo par reply karke ${CFG.prefix}sticker likho. (Video sticker abhi supported nahi.)`);
        const webp = await sharp(buf).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 80 }).toBuffer();
        return sock.sendMessage(chat, { sticker: webp }, { quoted: m });
      }
      case 'toimg': {
        const buf = await getMedia(sock, m, ['stickerMessage']);
        if (!buf) return reply(`Kisi sticker par reply karke ${CFG.prefix}toimg likho.`);
        return sock.sendMessage(chat, { image: await sharp(buf).png().toBuffer(), caption: 'Ye lo photo' }, { quoted: m });
      }
      case 'qr': {
        if (!args) return reply(`Aise likho: ${CFG.prefix}qr text ya link`);
        return sock.sendMessage(chat, { image: await QRCode.toBuffer(args, { width: 512, margin: 2 }), caption: 'QR ready' }, { quoted: m });
      }

      case 'song': case 'play': case 'video': {
        const isVideo = cmd === 'video';
        if (!args) return reply(`Aise likho: ${CFG.prefix}${cmd} ${isVideo ? 'video' : 'gane'} ka naam\nMisal: ${CFG.prefix}${cmd} tum hi ho`);
        await reply('Dhoond raha hoon... 🔎');
        const given = args.match(URL_RE)?.[0];
        const v = given ? { url: given, title: '', seconds: 0 } : await ytSearch(args);
        if (!v) return reply('Kuch nahi mila. Naam badal kar dobara try karo.');
        const maxSec = isVideo ? 900 : 1800;
        if (v.seconds > maxSec) return reply(`Ye bohat lamba hai (${v.timestamp}). ${isVideo ? '15' : '30'} minute tak ki hi milegi.`);
        if (!given) {
          await sock.sendMessage(chat, { image: { url: v.thumbnail }, caption: `${isVideo ? '🎬' : '🎧'} *${v.title}*\n👤 ${v.author?.name || ''}\n⏱️ ${v.timestamp}\n\nDownload ho raha hai... ⏳` }, { quoted: m });
        }
        const url = await cobaltGet(v.url, isVideo ? { videoQuality: '720' } : { downloadMode: 'audio', audioFormat: 'mp3' });
        if (isVideo) return sock.sendMessage(chat, { video: { url }, caption: `🎬 ${v.title || 'Video'}\n\n_${CFG.name}_` }, { quoted: m });
        return sock.sendMessage(chat, { audio: { url }, mimetype: 'audio/mpeg', fileName: `${v.title || 'song'}.mp3` }, { quoted: m });
      }

      case 'tiktok': case 'tt': {
        const link = args.match(URL_RE)?.[0];
        if (!link) return reply(`Aise likho: ${CFG.prefix}tiktok TikTok ka link`);
        await reply('Download ho raha hai... ⏳');
        const d = (await getJson('https://www.tikwm.com/api/?hd=1&url=' + encodeURIComponent(link)))?.data;
        if (!d) return reply('Video nahi mili. Link check karo (video public honi chahiye).');
        const caption = `🎵 ${d.title || 'TikTok'}\n\n_${CFG.name}_`;
        if (d.images?.length) {
          for (const img of d.images.slice(0, 5)) await sock.sendMessage(chat, { image: { url: img }, caption }, { quoted: m });
          return;
        }
        return sock.sendMessage(chat, { video: { url: d.hdplay || d.play }, caption }, { quoted: m });
      }
      case 'aio': case 'dl': {
        const link = args.match(URL_RE)?.[0];
        if (!link) return reply(`Aise likho: ${CFG.prefix}aio link\n(Instagram, Facebook, Twitter/X, YouTube waghera)`);
        const api = process.env.COBALT_API;
        if (!api) return reply('AIO downloader abhi set nahi hai. Owner ko Render mein COBALT_API set karni hogi.');
        await reply('Download ho raha hai... ⏳');
        const j = await getJson(api, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(process.env.COBALT_KEY ? { Authorization: 'Api-Key ' + process.env.COBALT_KEY } : {}) },
          body: JSON.stringify({ url: link }),
        });
        if (j.status === 'error') return reply('Download nahi ho saka: ' + (j.error?.code || 'unknown'));
        const caption = `✅ ${CFG.name}`;
        if (j.status === 'picker') {
          for (const it of (j.picker || []).slice(0, 5)) await sock.sendMessage(chat, mediaPayload(it.url, caption), { quoted: m });
          return;
        }
        if (!j.url) return reply('Is link se kuch nahi mila.');
        return sock.sendMessage(chat, mediaPayload(j.url, caption), { quoted: m });
      }

      case 'calc': {
        if (!args || args.length > 100 || !/^[0-9+\-*/().%\s]+$/.test(args)) return reply(`Aise likho: ${CFG.prefix}calc 12*(3+4)`);
        const v = Function(`"use strict";return (${args})`)();
        return reply(`${args} = ${v}`);
      }
      case 'time': {
        const tz = args || 'Asia/Karachi';
        try { return reply(`${tz}: ${new Date().toLocaleString('en-GB', { timeZone: tz })}`); }
        catch { return reply('Timezone galat hai. Misal: .time Asia/Kolkata'); }
      }
      case 'flip': return reply(Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙');
      case 'dice': return reply(`🎲 ${1 + Math.floor(Math.random() * 6)}`);

      case 'tagall': {
        const meta = await adminGate(); if (!meta) return;
        const ids = meta.participants.map((p) => p.id);
        return sock.sendMessage(chat, { text: `${args || 'Sab ke liye elaan'}\n\n` + ids.map((i) => '@' + norm(i)).join('\n'), mentions: ids }, { quoted: m });
      }
      case 'hidetag': {
        const meta = await adminGate(); if (!meta) return;
        return sock.sendMessage(chat, { text: args || '📢', mentions: meta.participants.map((p) => p.id) });
      }
      case 'kick': case 'promote': case 'demote': {
        const meta = await adminGate(); if (!meta) return;
        const t = targetOf();
        if (!t) return reply(`Kisi ko @mention karo ya uske message par reply karo.`);
        const action = cmd === 'kick' ? 'remove' : cmd;
        await sock.groupParticipantsUpdate(chat, [t], action);
        return reply('Ho gaya ✅');
      }
      case 'open': case 'close': {
        const meta = await adminGate(); if (!meta) return;
        await sock.groupSettingUpdate(chat, cmd === 'close' ? 'announcement' : 'not_announcement');
        return reply(cmd === 'close' ? 'Group band: sirf admin msg kar sakte hain.' : 'Group khul gaya: sab msg kar sakte hain.');
      }
      case 'link': {
        const meta = await adminGate(); if (!meta) return;
        return reply('https://chat.whatsapp.com/' + (await sock.groupInviteCode(chat)));
      }
      case 'groupinfo': {
        const meta = await groupOnly(); if (!meta) return;
        return reply(`*${meta.subject}*\nMembers: ${meta.participants.length}\nAdmins: ${meta.participants.filter((p) => p.admin).length}`);
      }
      case 'antilink': {
        const meta = await adminGate(); if (!meta) return;
        if (args === 'on') { entry.anti.add(chat); return reply('Antilink ON ✅'); }
        if (args === 'off') { entry.anti.delete(chat); return reply('Antilink OFF'); }
        return reply(`Aise likho: ${CFG.prefix}antilink on  ya  ${CFG.prefix}antilink off`);
      }

      case 'mode': {
        if (!isOwner) return reply('Ye command sirf owner ke liye hai.');
        if (args !== 'public' && args !== 'private') return reply(`Abhi mode: ${entry.mode}\nBadalne ke liye: ${CFG.prefix}mode public ya ${CFG.prefix}mode private`);
        entry.mode = args;
        return reply(`Mode ab ${args} hai ✅`);
      }
      case 'follow': {
        if (!isOwner) return reply('Ye command sirf owner ke liye hai.');
        const meta = await sock.newsletterMetadata('invite', CHANNEL_CODE);
        await sock.newsletterFollow(meta.id);
        return reply('Channel follow ho gaya ✅');
      }
      default: return;
    }
  } catch (e) {
    return reply('Command fail hui: ' + (e?.message || 'unknown error'));
  }
}

// Server start hote hi saved sessions wapas chalu karo
restoreAll().catch(() => {});
