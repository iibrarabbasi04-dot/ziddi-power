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

export function stopBot(key, removeDir) {
  const e = bots.get(key);
  if (!e) return;
  e.stopped = true;
  try { e.sock?.ev.removeAllListeners(); e.sock?.end(undefined); } catch {}
  bots.delete(key);
  if (removeDir) try { fs.rmSync(removeDir, { recursive: true, force: true }); } catch {}
}

export async function startBot(key, dir, opts = {}) {
  const flags = opts.flags || { linked: false };
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
  bots.set(key, entry);
  sock.ev.on('creds.update', saveCreds);

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
  DOWNLOADER: ['tiktok', 'aio'],
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
