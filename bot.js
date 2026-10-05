// Ziddi Power - bot ka code
import fs from 'fs';
import path from 'path';
import os from 'os';
import pino from 'pino';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { spawn } from 'child_process';
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
  menuImage: path.join(process.cwd(), 'public', 'images', 'IMG-20261005-WA0023.jpg'),
  channel: process.env.CHANNEL_LINK || 'https://whatsapp.com/channel/0029VbDdwnhKGGGOSd9rHl1D',
  extraOwners: (process.env.OWNER || '').split(',').map((x) => x.replace(/\D/g, '')).filter(Boolean),
};
const CHANNEL_CODE = CFG.channel.split('/channel/')[1];
const logger = pino({ level: 'silent' });
export const bots = new Map();

const norm = (j) => (j || '').split(':')[0].split('@')[0];
const fmtTime = (s) => `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ${Math.floor(s % 60)}s`;
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const pct = () => Math.floor(Math.random() * 101);
const w = (s) => s.trim().split(/\s+/);
const range = (base, to, from = 1) => Array.from({ length: to - from + 1 }, (_, i) => base + (i + from));

// ---------- SESSION SAVE / RESTORE (Upstash Redis, free) ----------
const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const hasDb = () => !!(REDIS_URL && REDIS_TOKEN);

async function redis(cmds) {
  const r = await fetch(REDIS_URL + '/pipeline', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + REDIS_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds),
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) throw new Error('Redis error ' + r.status);
  return (await r.json()).map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}
const pairsOf = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };

const seenFiles = new Map();
const timers = new Map();

async function backupSession(key, dir) {
  if (!hasDb()) return;
  if (!bots.get(key)?.sock?.authState?.creds?.registered) return;
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const old = seenFiles.get(key) || new Map();
  const next = new Map(old);
  const cmds = [];
  for (const n of names) {
    const p = path.join(dir, n);
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const sig = st.mtimeMs + ':' + st.size;
    if (old.get(n) === sig) continue;
    cmds.push(['HSET', 'zp:f:' + key, n, fs.readFileSync(p, 'utf8')]);
    next.set(n, sig);
  }
  for (const n of old.keys()) {
    if (!names.includes(n)) { cmds.push(['HDEL', 'zp:f:' + key, n]); next.delete(n); }
  }
  cmds.unshift(['HSET', 'zp:meta', key, dir]);
  for (let i = 0; i < cmds.length; i += 40) await redis(cmds.slice(i, i + 40));
  seenFiles.set(key, next);
}

function scheduleBackup(key, dir) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => backupSession(key, dir).catch((e) => console.error('Backup fail:', e?.message)), 3000));
}

async function restoreSession(key, dir) {
  if (!hasDb()) return false;
  if (fs.existsSync(path.join(dir, 'creds.json'))) return true;
  const files = pairsOf((await redis([['HGETALL', 'zp:f:' + key]]))[0]);
  const names = Object.keys(files);
  if (!names.includes('creds.json')) return false;
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), files[n]);
  return true;
}

async function forgetSession(key) {
  seenFiles.delete(key);
  clearTimeout(timers.get(key));
  if (!hasDb()) return;
  await redis([['DEL', 'zp:f:' + key], ['HDEL', 'zp:meta', key]]);
}

export async function restoreAll() {
  if (!hasDb()) return;
  const meta = pairsOf((await redis([['HGETALL', 'zp:meta']]))[0]);
  for (const [key, dir] of Object.entries(meta)) {
    try {
      if (bots.has(key)) continue;
      if (!(await restoreSession(key, dir))) continue;
      if (bots.has(key)) continue;
      await startBot(key, dir, { flags: { linked: true } });
      console.log('Session restore hua:', key);
      await delay(1500);
    } catch (e) {
      console.error('Restore fail', key, e?.message);
    }
  }
}

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
  const entry = bots.get(key) || {
    mode: 'public', started: Date.now(), stopped: false,
    g: { antilink: new Set(), antimedia: new Set(), antispam: new Set(), antitagall: new Set(), antibot: new Set(), antistatus: new Set() },
    settings: {}, spam: new Map(), anti: new Set(),
  };
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

  sock.ev.on('call', async (calls) => {
    if (!entry.settings.anticall) return;
    for (const c of calls) if (c.status === 'offer') { try { await sock.rejectCall(c.id, c.from); } catch {} }
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
  const type = types.find((t) => target.message[t]);
  const buf = await downloadMediaMessage(target, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
  buf.mediaType = type;
  buf.mediaMsg = target.message[type];
  return buf;
}

const idsOf = (p) => [p.id, p.phoneNumber, p.jid, p.lid].filter(Boolean).map(norm);
const isAdminIn = (meta, ids) => meta.participants.some((p) => p.admin && idsOf(p).some((x) => ids.map(norm).includes(x)));

// ---------- MENU ----------
const MENU = {
  MAIN: ['menu', 'ping', 'ping2', 'alive', 'owner', 'runtime', 'channel', 'fetch', 'anime'],
  ISLAMIC: w(`dua_forgiveness dua_rizq dua_guidance dua_health zikr_astaghfirullah zikr_alhamdulillah zikr_subhanallah
    zikr_allahuakbar zikr_lailahaillallah zikr_lahawla hadith_good_morals hadith_cleanliness hadith_truth hadith_patience
    darood_sharif kalima_tayyiba islam_fact quran_reminder naat`),
  AI: w(`autochat ai ai2 gemini qwen heckai sonu3 imagine tts2 editimg photoedit clearchat nsfwcheck`),
  DOWNLOADER: w(`song play video yta ytmp3 ytmp4 ytvideo videot video2 video3 mv tiktok tt aio fb igdl igdl2 igdl3
    soundcloud spotify capcut playch dafont drama mlfbd movie apk baiscopes thenkiri drama65 moviebox cinesubz
    sinhalasub movie3 song2 song65 tts`),
  'STICKER & MEDIA': w(`sticker toimg qr tourl tomp3 toptt attp`),
  ANIME: w(`waifu waifu2 neko megumin maid awoo garl storyanime anime1 anime2 anime3 anime4 anime5`),
  GROUP: w(`tagall hidetag tag kick kick1 kickall add promote demote open close mute unmute link invite revoke ginfo
    groupinfo updategname updategdesc gcpp poll delete out end newgc join requests accept reject acceptall rejectall
    antilink antimedia antispam antitagall antibot antistatus antibothelp botlist kickbot gcstatus chreact`),
  OWNER: w(`mode follow vv vv2 vv3 vvaudio vv5 forward leave block unblock fullpp count countx status pair pair64 ik mentionreply`),
  SETTINGS: w(`autoread autotyping recording statusview statuslike anticall autoreact online prefix botname ownername
    settings antidelete antiedit sudo delsudo listsudo ban unban banlist welcome goodbye setwelcome setgoodbye botdp`),
  UTILITY: w(`calc calculate time timenow date id getlid rcolor binary dbinary base64 unbase64 urlencode urldecode
    uptime define short npm news raw cpp boom`),
  SEARCH: w(`yts lyrics img grub pinterest ttsearch ttsearch2 ytstalk`),
  TOOLS: w(`flip dice happy heart angry sad shy moon confused hot nikal fancy fixerror gagstock rch proxy sim
    encryptv2 vote removebg removebg2 unblur blurface colorize remini`).concat(range('enhance', 16).filter((n) => [1, 4, 8, 16].includes(+n.slice(7))), range('upscale', 16)),
  TEXT: w(`tiny circle square gothic cursive double bubble firetext startext hearttext cloudtext matrix upsidedown
    spacing dash dot underline overline strikethrough slash`).concat(range('fancy', 10)),
  TRICK: w(`trick joke fakehack hack prank troll magic luck truth fakeerror coinflip scream silent`),
  FUN: w(`character fun rain fight puzzle story transform dance race weathercast emojimenu compatibility aura roast 8ball
    compliment lovetest emoji bacha bachi ship dad mom son daughter boyfriend girlfriend twin partner bodyguard boss
    employee pet servant idol fan ghost angel devil king queen slave master genius fool rich poor bhai bahan wife husband
    chacha chachi nana nani mama mami bestfriend enemy crush teacher student rival ishqmeter andhaishq lafzmohabbat
    pehlinazar dillagi khoobsurat dhadkan pehlaakhat ziddidil yaadaata taubataubaa pehlamuhabbat wafaimtihaan
    donokikahani gulabbhejo aankhein shayarban dushmandost tangkarna smilechurao jaan qismatwala jhoothpyaar siyaanibaat
    mohabbatqarz nazarutarao romanticbakwaas aashiqanaaward mohabbatteri dilkhol gussapyaar jasoos tangaphanda muftadvice
    nakhrebaaz anokhapyaar bhaagaya khushnaseebi ronewala waqtguzarna chandsa dostyadildar galatfehmi perfectmatch
    raazkhola mohabbatdarja dua khwaabon dare gayrate lesbianrate handsome cute smart dumb pro noob legend god hero villain
    sociopath psycho crazy funny single taken lover hater friend bitch chad sigma alpha beta omega wizard ninja samurai
    pirate alien zombie roll animegirl animegirl1 animegirl2 animegirl3 animegirl4 animegirl5 dog fakevote livevote
    fakesubs welcomevote membergrowth fakepoll votelist technologia lurk shoot sleep clap shrug stare wave poke smile peck
    wink sip blush smug tickle yeet think highfive feed wag bite teehee shocked bleh bored nom nya yawn facepalm cuddle
    kick carry hug kabedon baka bonk pat spin shake run nod nope kiss punch handshake slap cry lappillow pout blowkiss
    handhold salute thumbsup laugh tableflip kids pick shapar rate`),
  BOYDP: range('boydp', 22), GIRLDP: range('girldp', 22), COUPLEDP: range('coupledp', 22),
  NEWS: ['newscountries', 'kemkesnews'],
  GAME: ['akinator'],
  LOGO: w(`3dcomic dragonball deadpool blackpink neonlight cat sadgirl naruto thor america eraser 3dpaper futuristic clouds
    sans galaxy leaf sunset nigeria devilwings hacker luxury zodiac angelwings bulb tattoo castle frozen paint birthday
    typography bear valorant ephoto`),
  SOUND: ['sound'].concat(range('sound', 16, 2)),
  MISC: ['afk'],
  OTHER: ['getpp', 'mee', 'srepo', 'unban'].concat(range('unban', 100, 2)),
};
const ALL_NAMES = new Set(Object.values(MENU).flat());

function buildMenu(entry) {
  const total = ALL_NAMES.size;
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
    t += [...new Set(cmds)].map((c) => `│ ⚡ \`${c.toUpperCase()}\``).join('\n') + '\n' + tail;
  }
  return t.trimEnd();
}

const readMenuImage = () => { try { return fs.readFileSync(CFG.menuImage); } catch { return null; } };

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
  // Pehle picture (chhote caption ke saath), phir poora menu text
  if (image) {
    await sock.sendMessage(chat, { image, caption: `✨ *${CFG.name.toUpperCase()}* ✨\n👑 ${CFG.owner}  |  🔰 ${CFG.prefix}  |  🌐 ${entry.mode}` }, { quoted: m });
  }
  return sock.sendMessage(chat, { text: caption, contextInfo });
}

async function sendActivated(sock, entry) {
  const image = readMenuImage();
  const caption = `🤖 *${CFG.name.toUpperCase()} Activated*\n\nType ${CFG.prefix}menu for commands\n\n🔥 Version: ${CFG.version}`;
  const to = norm(sock.user.id) + '@s.whatsapp.net';
  await sock.sendMessage(to, image ? { image, caption } : { text: caption });
}

// ---------- HTTP / DOWNLOAD helpers ----------
const URL_RE = /https?:\/\/\S+/i;
async function getJson(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('Server ne jawab nahi diya (' + r.status + ')');
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error('Server ne jawab nahi diya (' + r.status + ')');
  return r.text();
}
const isImageUrl = (u) => /\.(jpe?g|png|webp)(\?|$)/i.test(u);
const isAudioUrl = (u) => /\.(mp3|m4a|opus|ogg|wav)(\?|$)/i.test(u);
const mediaPayload = (u, caption) =>
  isImageUrl(u) ? { image: { url: u }, caption } : isAudioUrl(u) ? { audio: { url: u }, mimetype: 'audio/mpeg' } : { video: { url: u }, caption };

function findVideo(o) {
  if (!o || typeof o !== 'object') return null;
  if (o.videoRenderer?.videoId) return o.videoRenderer;
  for (const k in o) { const f = findVideo(o[k]); if (f) return f; }
  return null;
}
async function ytSearch(q) {
  const r = await fetch('https://www.youtube.com/results?hl=en&sp=EgIQAQ%3D%3D&search_query=' + encodeURIComponent(q), {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'CONSENT=YES+1; SOCS=CAI',
    },
    signal: AbortSignal.timeout(20000),
  });
  const html = await r.text();
  const raw = html.match(/var ytInitialData = (\{.*?\});<\/script>/s)?.[1];
  if (!raw) throw new Error('YouTube search nahi ho saki (YouTube ne block kiya ho sakta hai)');
  const v = findVideo(JSON.parse(raw).contents);
  if (!v) return null;
  const ts = v.lengthText?.simpleText || '0:00';
  return {
    url: 'https://www.youtube.com/watch?v=' + v.videoId,
    title: v.title?.runs?.[0]?.text || '',
    seconds: ts.split(':').reduce((a, p) => a * 60 + Number(p), 0),
    timestamp: ts,
    thumbnail: 'https://i.ytimg.com/vi/' + v.videoId + '/hqdefault.jpg',
    author: { name: v.ownerText?.runs?.[0]?.text || '' },
  };
}
const cobaltHeaders = () => ({ Accept: 'application/json', 'Content-Type': 'application/json', ...(process.env.COBALT_KEY ? { Authorization: 'Api-Key ' + process.env.COBALT_KEY } : {}) });
async function cobaltGet(link, body = {}) {
  const api = process.env.COBALT_API;
  if (!api) throw new Error('COBALT_API set nahi hai (Render > Environment)');
  const j = await getJson(api, { method: 'POST', headers: cobaltHeaders(), body: JSON.stringify({ url: link, ...body }) });
  if (j.status === 'error') throw new Error(j.error?.code || 'download fail');
  if (!j.url) throw new Error('Is link se kuch nahi mila');
  return j.url;
}

// YouTube: song / video (naam ya link se)
async function ytDownload(x, isVideo) {
  const { sock, chat, m, args, reply, cmd } = x;
  if (!args) return reply(`Aise likho: ${CFG.prefix}${cmd} ${isVideo ? 'video' : 'gane'} ka naam ya YouTube link\nMisal: ${CFG.prefix}${cmd} tum hi ho`);
  await reply('Dhoond raha hoon... 🔎');
  const given = args.match(URL_RE)?.[0];
  const v = given ? { url: given, title: '', seconds: 0 } : await ytSearch(args);
  if (!v) return reply('Kuch nahi mila. Naam badal kar dobara try karo.');
  const maxSec = isVideo ? 900 : 1800;
  if (v.seconds > maxSec) return reply(`Ye bohat lamba hai (${v.timestamp}). ${isVideo ? '15' : '30'} minute tak ki hi milegi.`);
  if (!given) {
    await sock.sendMessage(chat, { image: { url: v.thumbnail }, caption: `${isVideo ? '🎬' : '🎧'} *${v.title}*\n👤 ${v.author?.name || ''}\n⏱️ ${v.timestamp}\n\nDownload ho raha hai... ⏳` }, { quoted: m });
  }
  let url;
  if (!isVideo && process.env.RAPIDAPI_KEY && !process.env.COBALT_API) {
    // mp3 ke liye RapidAPI (youtube-mp36)
    const id = v.url.match(/(?:v=|youtu\.be\/|shorts\/)([\w-]{11})/)?.[1];
    if (!id) return reply('YouTube link sahi nahi hai.');
    const j = await getJson('https://youtube-mp36.p.rapidapi.com/dl?id=' + id, { headers: { 'x-rapidapi-key': process.env.RAPIDAPI_KEY, 'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com' } });
    if (!j.link) throw new Error(j.msg || 'mp3 link nahi mili');
    url = j.link;
  } else {
    url = await cobaltGet(v.url, isVideo ? { videoQuality: '720' } : { downloadMode: 'audio', audioFormat: 'mp3' });
  }
  if (isVideo) return sock.sendMessage(chat, { video: { url }, caption: `🎬 ${v.title || 'Video'}\n\n_${CFG.name}_` }, { quoted: m });
  return sock.sendMessage(chat, { audio: { url }, mimetype: 'audio/mpeg', fileName: `${v.title || 'song'}.mp3` }, { quoted: m });
}

async function tiktokDl(x) {
  const { sock, chat, m, args, reply } = x;
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

async function aioDl(x) {
  const { sock, chat, m, args, reply } = x;
  const link = args.match(URL_RE)?.[0];
  if (!link) return reply(`Aise likho: ${CFG.prefix}${x.cmd} link\n(Instagram, Facebook, Twitter/X, YouTube, SoundCloud waghera)`);
  if (/tiktok\.com/i.test(link)) return tiktokDl(x);
  const api = process.env.COBALT_API;
  if (!api) return reply('Ye downloader abhi set nahi hai. Owner ko Render mein COBALT_API set karni hogi.');
  await reply('Download ho raha hai... ⏳');
  const j = await getJson(api, { method: 'POST', headers: cobaltHeaders(), body: JSON.stringify({ url: link }) });
  if (j.status === 'error') return reply('Download nahi ho saka: ' + (j.error?.code || 'unknown'));
  const caption = `✅ ${CFG.name}`;
  if (j.status === 'picker') {
    for (const it of (j.picker || []).slice(0, 5)) await sock.sendMessage(chat, mediaPayload(it.url, caption), { quoted: m });
    return;
  }
  if (!j.url) return reply('Is link se kuch nahi mila.');
  return sock.sendMessage(chat, mediaPayload(j.url, caption), { quoted: m });
}

// ---------- AI / misc helpers ----------
async function aiText(prompt) {
  const t = await getText('https://text.pollinations.ai/' + encodeURIComponent(prompt));
  return t.trim();
}
function ffmpeg(input, args, outExt) {
  const tmpIn = path.join(os.tmpdir(), 'zp_' + Date.now() + '_in');
  const tmpOut = path.join(os.tmpdir(), 'zp_' + Date.now() + '_out.' + outExt);
  fs.writeFileSync(tmpIn, input);
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', '-i', tmpIn, ...args, tmpOut]);
    p.on('error', () => { reject(new Error('ffmpeg install nahi hai')); });
    p.on('close', (code) => {
      try {
        if (code !== 0) return reject(new Error('convert fail'));
        resolve(fs.readFileSync(tmpOut));
      } finally { try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {} }
    });
  });
}
async function uploadCatbox(buf, name = 'file.bin') {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('fileToUpload', new Blob([buf]), name);
  const r = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: fd, signal: AbortSignal.timeout(60000) });
  const t = await r.text();
  if (!t.startsWith('http')) throw new Error('Upload fail');
  return t.trim();
}

const ABC = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const mapText = (text, from, to) => {
  const t = [...to];
  return [...text].map((c) => { const i = from.indexOf(c); return i >= 0 ? t[i] : c; }).join('');
};
const STYLES = {
  tiny: (s) => mapText(s.toLowerCase(), 'abcdefghijklmnopqrstuvwxyz', 'ᴀʙᴄᴅᴇғɢʜɪᴊᴋʟᴍɴᴏᴘǫʀsᴛᴜᴠᴡxʏᴢ'),
  circle: (s) => mapText(s, ABC, 'ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩⒶⒷⒸⒹⒺⒻⒼⒽⒾⒿⓀⓁⓂⓃⓄⓅⓆⓇⓈⓉⓊⓋⓌⓍⓎⓏ'),
  bubble: (s) => STYLES.circle(s),
  square: (s) => mapText(s, ABC, '🄰🄱🄲🄳🄴🄵🄶🄷🄸🄹🄺🄻🄼🄽🄾🄿🅀🅁🅂🅃🅄🅅🅆🅇🅈🅉🄰🄱🄲🄳🄴🄵🄶🄷🄸🄹🄺🄻🄼🄽🄾🄿🅀🅁🅂🅃🅄🅅🅆🅇🅈🅉'),
  gothic: (s) => mapText(s, ABC, '𝖆𝖇𝖈𝖉𝖊𝖋𝖌𝖍𝖎𝖏𝖐𝖑𝖒𝖓𝖔𝖕𝖖𝖗𝖘𝖙𝖚𝖛𝖜𝖝𝖞𝖟𝕬𝕭𝕮𝕯𝕰𝕱𝕲𝕳𝕴𝕵𝕶𝕷𝕸𝕹𝕺𝕻𝕼𝕽𝕾𝕿𝖀𝖁𝖂𝖃𝖄𝖅'),
  cursive: (s) => mapText(s, ABC, '𝓪𝓫𝓬𝓭𝓮𝓯𝓰𝓱𝓲𝓳𝓴𝓵𝓶𝓷𝓸𝓹𝓺𝓻𝓼𝓽𝓾𝓿𝔀𝔁𝔂𝔃𝓐𝓑𝓒𝓓𝓔𝓕𝓖𝓗𝓘𝓙𝓚𝓛𝓜𝓝𝓞𝓟𝓠𝓡𝓢𝓣𝓤𝓥𝓦𝓧𝓨𝓩'),
  double: (s) => mapText(s, ABC, '𝕒𝕓𝕔𝕕𝕖𝕗𝕘𝕙𝕚𝕛𝕜𝕝𝕞𝕟𝕠𝕡𝕢𝕣𝕤𝕥𝕦𝕧𝕨𝕩𝕪𝕫𝔸𝔹ℂ𝔻𝔼𝔽𝔾ℍ𝕀𝕁𝕂𝕃𝕄ℕ𝕆ℙℚℝ𝕊𝕋𝕌𝕍𝕎𝕏𝕐ℤ'),
  upsidedown: (s) => [...mapText(s.toLowerCase(), 'abcdefghijklmnopqrstuvwxyz', 'ɐqɔpǝɟƃɥᴉɾʞlɯuodbɹsʇnʌʍxʎz')].reverse().join(''),
  spacing: (s) => [...s].join(' '),
  dash: (s) => [...s].join('-'),
  dot: (s) => [...s].join('.'),
  underline: (s) => [...s].map((x) => x + '\u0332').join(''),
  overline: (s) => [...s].map((x) => x + '\u0305').join(''),
  strikethrough: (s) => [...s].map((x) => x + '\u0336').join(''),
  slash: (s) => [...s].map((x) => x + '\u0338').join(''),
  firetext: (s) => `🔥 ${s} 🔥`, startext: (s) => `⭐ ${s} ⭐`, hearttext: (s) => `❤️ ${s} ❤️`, cloudtext: (s) => `☁️ ${s} ☁️`,
  matrix: (s) => '```' + [...s].join(' ') + '```',
};
const FANCY = ['✧', '☆', '★', '✦', '❖', '♛', '☠', '⚡', '♥', '✿'];

// ---------- EXTRA COMMAND REGISTRY ----------
const EXTRA = new Map();
const add = (names, fn) => (Array.isArray(names) ? names : [names]).forEach((n) => EXTRA.set(n, fn));
const need = (x, msg) => x.reply(msg);

// Islamic
const ISLAMIC = {
  dua_forgiveness: ['رَبِّ اغْفِرْ لِي وَتُبْ عَلَيَّ إِنَّكَ أَنْتَ التَّوَّابُ الرَّحِيمُ', 'Ae mere Rab, mujhe bakhsh de aur meri tauba qabool farma.'],
  dua_rizq: ['اللّٰهُمَّ اكْفِنِي بِحَلَالِكَ عَنْ حَرَامِكَ وَأَغْنِنِي بِفَضْلِكَ عَمَّنْ سِوَاكَ', 'Ae Allah, halal rizq se mujhe kafi kar aur apne fazl se mujhe dusron se beniyaz kar de.'],
  dua_guidance: ['اللّٰهُمَّ إِنِّي أَسْأَلُكَ الْهُدَىٰ وَالتُّقَىٰ وَالْعَفَافَ وَالْغِنَىٰ', 'Ae Allah, main tujh se hidayat, taqwa, pakdamani aur beniyazi mangta hoon.'],
  dua_health: ['اللّٰهُمَّ عَافِنِي فِي بَدَنِي، اللّٰهُمَّ عَافِنِي فِي سَمْعِي، اللّٰهُمَّ عَافِنِي فِي بَصَرِي', 'Ae Allah, mujhe mere jism, kaan aur aankhon me sehat de.'],
  zikr_astaghfirullah: ['أَسْتَغْفِرُ اللّٰهَ', 'Astaghfirullah - main Allah se maafi mangta hoon.'],
  zikr_alhamdulillah: ['الْحَمْدُ لِلّٰهِ', 'Alhamdulillah - tamam tareef Allah ke liye hai.'],
  zikr_subhanallah: ['سُبْحَانَ اللّٰهِ', 'SubhanAllah - Allah paak hai.'],
  zikr_allahuakbar: ['اللّٰهُ أَكْبَرُ', 'Allahu Akbar - Allah sab se bara hai.'],
  zikr_lailahaillallah: ['لَا إِلٰهَ إِلَّا اللّٰهُ', 'La ilaha illallah - Allah ke siwa koi ibadat ke laiq nahi.'],
  zikr_lahawla: ['لَا حَوْلَ وَلَا قُوَّةَ إِلَّا بِاللّٰهِ', 'La hawla wa la quwwata illa billah.'],
  kalima_tayyiba: ['لَا إِلٰهَ إِلَّا اللّٰهُ مُحَمَّدٌ رَسُولُ اللّٰهِ', 'Kalima Tayyiba'],
  darood_sharif: ['اللّٰهُمَّ صَلِّ عَلَىٰ مُحَمَّدٍ وَعَلَىٰ آلِ مُحَمَّدٍ', 'Darood Sharif'],
  hadith_good_morals: [null, 'Hadith: Tum me sab se behtar wo hai jis ke akhlaq sab se acche hon. (Bukhari)'],
  hadith_cleanliness: [null, 'Hadith: Paaki aadha imaan hai. (Muslim)'],
  hadith_truth: [null, 'Hadith: Sach neki ki taraf le jata hai, aur neki jannat ki taraf. (Bukhari, Muslim)'],
  hadith_patience: [null, 'Hadith: Sabr roshni hai. (Muslim)'],
};
for (const [k, [ar, ur]] of Object.entries(ISLAMIC)) add(k, (x) => x.reply(`🕌 *${k.replace(/_/g, ' ').toUpperCase()}*\n\n${ar ? ar + '\n\n' : ''}${ur}`));
add('islam_fact', (x) => x.reply('📿 ' + pick(['Islam ke 5 arkaan hain: Kalima, Namaz, Roza, Zakat, Hajj.', 'Quran me 114 surah hain.', 'Ramzan me Quran nazil hona shuru hua.', 'Jumma haftay ka afzal din hai.'])));
add('naat', (x) => x.reply('🎧 Naat ke liye naam likho: ' + CFG.prefix + 'song <naat ka naam>'));
add('quran_reminder', async (x) => {
  const n = 1 + Math.floor(Math.random() * 6236);
  const j = await getJson(`https://api.alquran.cloud/v1/ayah/${n}/editions/quran-uthmani,en.sahih`);
  const [a, e] = j.data;
  x.reply(`📖 *${a.surah.englishName}* (${a.surah.number}:${a.numberInSurah})\n\n${a.text}\n\n_${e.text}_`);
});

// Text styles
for (const [k, f] of Object.entries(STYLES)) add(k, (x) => (x.args ? x.reply(f(x.args)) : x.reply(`Aise likho: ${CFG.prefix}${k} text`)));
FANCY.forEach((s, i) => add('fancy' + (i + 1), (x) => (x.args ? x.reply(`${s} ${x.args} ${s}`) : x.reply(`Aise likho: ${CFG.prefix}fancy${i + 1} text`))));

// Utility
add(['calculate'], (x) => EXTRA.get('calc')(x));
add('calc', (x) => {
  if (!x.args || x.args.length > 100 || !/^[0-9+\-*/().%\s^]+$/.test(x.args)) return x.reply(`Aise likho: ${CFG.prefix}calc 12*(3+4)`);
  x.reply(`${x.args} = ${Function(`"use strict";return (${x.args.replace(/\^/g, '**')})`)()}`);
});
add('timenow', (x) => x.reply(`🕒 ${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Karachi' })}`));
add('date', (x) => x.reply(`📅 ${new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Karachi', dateStyle: 'full' })}`));
add('uptime', (x) => x.reply(`⏳ ${fmtTime((Date.now() - x.entry.started) / 1000)}`));
add('id', (x) => x.reply(`🆔 Chat: ${x.chat}\nUser: ${norm(x.sender)}`));
add('getlid', (x) => x.reply(`LID/JID: ${x.sender}`));
add('rcolor', (x) => x.reply('🎨 #' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')));
add('binary', (x) => x.reply([...x.args].map((c) => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ')));
add('dbinary', (x) => x.reply(x.args.split(/\s+/).map((b) => String.fromCharCode(parseInt(b, 2))).join('')));
add('base64', (x) => x.reply(Buffer.from(x.args).toString('base64')));
add('unbase64', (x) => x.reply(Buffer.from(x.args, 'base64').toString('utf8')));
add('urlencode', (x) => x.reply(encodeURIComponent(x.args)));
add('urldecode', (x) => x.reply(decodeURIComponent(x.args)));
add('raw', (x) => x.reply('```' + JSON.stringify(x.m.message, null, 1).slice(0, 3500) + '```'));
add('define', async (x) => {
  const j = await getJson('https://api.dictionaryapi.dev/api/v2/entries/en/' + encodeURIComponent(x.args));
  x.reply(`📖 *${j[0].word}*\n${j[0].meanings[0].definitions[0].definition}`);
});
add('short', async (x) => x.reply(await getText('https://tinyurl.com/api-create.php?url=' + encodeURIComponent(x.args))));
add('npm', async (x) => {
  const j = await getJson('https://registry.npmjs.org/' + encodeURIComponent(x.args) + '/latest');
  x.reply(`📦 *${j.name}* v${j.version}\n${j.description || ''}\nhttps://npmjs.com/package/${j.name}`);
});
add('fetch', async (x) => {
  if (!URL_RE.test(x.args)) return x.reply(`Aise likho: ${CFG.prefix}fetch link`);
  x.reply((await getText(x.args.match(URL_RE)[0])).slice(0, 3000));
});

// Fun / Trick
add('coinflip', (x) => x.reply(Math.random() < 0.5 ? 'Heads 🪙' : 'Tails 🪙'));
add('roll', (x) => x.reply('🎲 ' + (1 + Math.floor(Math.random() * 6))));
add('8ball', (x) => x.reply('🎱 ' + pick(['Haan', 'Nahi', 'Shayad', 'Bilkul', 'Baad me pucho', 'Kabhi nahi'])));
add('joke', (x) => x.reply(pick(['Programmer ki biwi: "Doodh le aana, agar anday ho to 6 le aana." Wo 6 doodh le aya 😂', 'Bug feature ban gaya jab client ko pasand aa gaya 😄', 'Teacher: 2+2? Student: WiFi ka password kya hai? 😂'])));
add('pick', (x) => x.reply('🎯 ' + pick(x.args ? x.args.split(/[,|]/).map((s) => s.trim()) : ['Kuch to likho'])));
add('luck', (x) => x.reply(`🍀 Aaj ki luck: ${pct()}%`));
add('roast', (x) => x.reply(pick(['Tumhara WiFi tumse zyada strong hai 😂', 'Tum wo ho jo "seen" karke bhool jate ho 😜', 'Tumhari battery bhi tumse zyada active hai 😆'])));
add('compliment', (x) => x.reply(pick(['Tum kamaal ho! ✨', 'Tumhari smile best hai 😊', 'Tum sab se alag ho 🌟'])));
add('truth', (x) => x.reply('🎭 ' + pick(['Aakhri jhoot kab bola?', 'Sab se bara dar kya hai?', 'Kis pe crush hai?'])));
add('dare', (x) => x.reply('🔥 ' + pick(['Group me voice note bhejo 🎤', 'Apni purani photo bhejo 📸', 'Kisi ko "I miss you" likho 😂'])));
add(['hack', 'fakehack'], async (x) => {
  const s = await x.reply('💻 Hacking start...');
  for (const f of ['📡 Connecting 25%', '🔓 Bypassing 60%', '📂 Files copy 90%', '✅ Done (mazak tha 😂)']) { await delay(1200); await x.sock.sendMessage(x.chat, { text: f, edit: s.key }); }
});
add('prank', (x) => x.reply('😂 Prank ho gaya!'));
add('troll', (x) => x.reply('🧌 Trolled!'));
add('magic', (x) => x.reply('🪄✨ Abracadabra!'));
add('scream', (x) => x.reply('AAAAAAAAAAHHHHH!!! 😱'));
add('silent', (x) => x.reply('🤫'));
add('fakeerror', (x) => x.reply('❌ ERROR 404: Dimaag not found 😂'));
add('trick', (x) => x.reply(pick(['🃏 Ek card socho!', '🎩 Trick time!'])));

const RATE = w(`gayrate lesbianrate handsome cute smart dumb pro noob legend god hero villain sociopath psycho crazy funny
  single taken lover hater friend bitch chad sigma alpha beta omega wizard ninja samurai pirate alien zombie lovetest
  ishqmeter aura rate compatibility perfectmatch mohabbatdarja khoobsurat gayrate`);
RATE.forEach((n) => add(n, (x) => {
  const t = x.targetOf();
  x.reply(`📊 *${n}* meter${t ? ' @' + norm(t) : ''}: ${pct()}%`, { mentions: t ? [t] : [] });
}));
const ROLES = w(`dad mom son daughter boyfriend girlfriend twin partner bodyguard boss employee pet servant idol fan ghost
  angel devil king queen slave master genius fool rich poor bhai bahan wife husband chacha chachi nana nani mama mami
  bestfriend enemy crush teacher student rival bacha bachi ship`);
ROLES.forEach((n) => add(n, (x) => {
  const t = x.targetOf();
  const ids = [x.sender, t].filter(Boolean);
  x.reply(`💫 ${t ? '@' + norm(t) : 'Tumhara'} *${n}* hai: @${norm(x.sender)}`, { mentions: ids });
}));
const LOVE_LINES = w(`lafzmohabbat pehlinazar dillagi dhadkan pehlaakhat ziddidil yaadaata taubataubaa pehlamuhabbat
  wafaimtihaan donokikahani gulabbhejo aankhein shayarban dushmandost tangkarna smilechurao jaan qismatwala jhoothpyaar
  siyaanibaat mohabbatqarz nazarutarao romanticbakwaas aashiqanaaward mohabbatteri dilkhol gussapyaar jasoos tangaphanda
  muftadvice nakhrebaaz anokhapyaar bhaagaya khushnaseebi ronewala waqtguzarna chandsa dostyadildar galatfehmi raazkhola
  andhaishq dua khwaabon gayrate`);
LOVE_LINES.forEach((n) => add(n, (x) => {
  const t = x.targetOf();
  x.reply(`💌 *${n}*\n${pick(['Dil ki baat dil hi jaanta hai ❤️', 'Mohabbat me sab jaiz hai 😉', 'Aaj ka din tumhara hai ✨', 'Kisi ki yaad me ho kya? 🥹'])}${t ? '\n@' + norm(t) : ''}`, { mentions: t ? [t] : [] });
}));
['character', 'fun', 'rain', 'fight', 'puzzle', 'story', 'transform', 'race', 'weathercast', 'emojimenu', 'technologia', 'lurk', 'shoot', 'sleep', 'clap', 'shrug', 'stare', 'think', 'feed', 'wag', 'teehee', 'shocked', 'bleh', 'spin', 'shake', 'run', 'nod', 'nope', 'lappillow', 'pout', 'blowkiss', 'salute', 'thumbsup', 'laugh', 'tableflip', 'kids', 'kabedon', 'baka', 'carry', 'peck', 'sip', 'tickle', 'punch', 'handshake', 'emoji', 'shapar', 'fakevote', 'livevote', 'fakesubs', 'welcomevote', 'membergrowth', 'fakepoll', 'votelist']
  .forEach((n) => add(n, (x) => {
    const e = { rain: '🌧️', fight: '🥊', race: '🏁', sleep: '😴', clap: '👏', shrug: '🤷', stare: '👀', think: '🤔', laugh: '😂', salute: '🫡', thumbsup: '👍', run: '🏃', shoot: '🔫💦', tableflip: '(╯°□°）╯︵ ┻━┻', spin: '🌀', nod: '🙂‍↕️', nope: '🙅' }[n] || '✨';
    const t = x.targetOf();
    x.reply(`${e} *${n}*${t ? ' → @' + norm(t) : ''}\n${x.args || ''}`.trim(), { mentions: t ? [t] : [] });
  }));

// Emoji animations
const ANIMS = {
  happy: ['😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😇'],
  heart: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💖'],
  angry: ['😡', '😠', '🤬', '😤', '😾', '👿', '💢'],
  sad: ['🥺', '😟', '😕', '😔', '😢', '😭', '💔'],
  shy: ['😳', '😊', '🥰', '😚', '🙈', '☺️'],
  moon: ['🌑', '🌒', '🌓', '🌔', '🌕', '🌖', '🌗', '🌘'],
  confused: ['😕', '🤔', '🧐', '😵‍💫', '❓', '🤯'],
  hot: ['🥵', '🔥', '☀️', '🌡️', '🥵', '🔥'],
  nikal: ['🚶', '🚶‍♂️', '🏃', '💨', '👋'],
  dance: ['💃', '🕺', '💃', '🕺', '🪩'],
};
for (const [k, frames] of Object.entries(ANIMS)) add(k, async (x) => {
  const s = await x.reply(frames[0]);
  for (const f of frames.slice(1)) { await delay(700); await x.sock.sendMessage(x.chat, { text: f, edit: s.key }); }
});
add('fancy', (x) => x.reply(`✨ ${[...x.args || 'Ziddi'].join(' ')} ✨`));
add('fixerror', (x) => x.reply('🛠️ Error ki puri detail (log) bhejo, phir main dekhta hoon.'));

// Anime / reactions (waifu.pics, SFW)
async function wpImage(x, type) {
  const j = await getJson('https://api.waifu.pics/sfw/' + type);
  return x.sock.sendMessage(x.chat, { image: { url: j.url }, caption: `_${CFG.name}_` }, { quoted: x.m });
}
['waifu', 'neko', 'megumin', 'maid', 'awoo'].forEach((t) => add(t, (x) => wpImage(x, t)));
add(['waifu2', 'garl', 'anime', 'anime1', 'anime2', 'anime3', 'anime4', 'anime5', 'storyanime', 'animegirl', 'animegirl1', 'animegirl2', 'animegirl3', 'animegirl4', 'animegirl5'], (x) => wpImage(x, pick(['waifu', 'neko', 'shinobu'])));
add('dog', async (x) => { const j = await getJson('https://dog.ceo/api/breeds/image/random'); x.sock.sendMessage(x.chat, { image: { url: j.message } }, { quoted: x.m }); });
const REACT = { hug: 'hug', kiss: 'kiss', slap: 'slap', pat: 'pat', cry: 'cry', bite: 'bite', bonk: 'bonk', yeet: 'yeet', blush: 'blush', smile: 'smile', wave: 'wave', poke: 'poke', wink: 'wink', smug: 'smug', highfive: 'highfive', handhold: 'handhold', nom: 'nom', kick: 'kick', cuddle: 'cuddle', bored: 'bored', yawn: 'yawn', nya: 'happy' };
for (const [cmd, t] of Object.entries(REACT)) add(cmd, async (x) => {
  const tg = x.targetOf();
  const caption = `${cmd} ${tg ? '@' + norm(tg) : ''}`;
  try {
    const j = await getJson('https://api.waifu.pics/sfw/' + t);
    await x.sock.sendMessage(x.chat, { video: { url: j.url }, gifPlayback: true, caption, mentions: tg ? [tg] : [] }, { quoted: x.m });
  } catch { await x.reply(caption, { mentions: tg ? [tg] : [] }); }
});

// AI
const aiCmd = (x) => (x.args ? aiText(x.args).then((t) => x.reply(t)) : x.reply(`Aise likho: ${CFG.prefix}${x.cmd} apna sawal`));
add(['ai', 'ai2', 'gemini', 'qwen', 'heckai', 'sonu3'], aiCmd);
add('imagine', async (x) => {
  if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}imagine tasveer ka description`);
  await x.reply('Ban rahi hai... 🎨');
  const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(x.args) + '?width=768&height=768&nologo=true';
  await x.sock.sendMessage(x.chat, { image: { url }, caption: `🎨 ${x.args}` }, { quoted: x.m });
});
add('clearchat', (x) => x.reply('🧹 Chat history saaf.'));
add('autochat', (x) => toggleSetting(x, 'autochat', 'AutoChat (private chat me AI reply)'));
add(['tts', 'tts2'], async (x) => {
  if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}${x.cmd} ur salam kaise ho\n(pehla lafz language code: ur, en, hi, ar)`);
  const parts = x.args.split(' ');
  const lang = /^[a-z]{2}$/.test(parts[0]) ? parts.shift() : 'ur';
  const q = parts.join(' ').slice(0, 200);
  const r = await fetch(`https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${lang}&q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error('TTS fail');
  await x.sock.sendMessage(x.chat, { audio: Buffer.from(await r.arrayBuffer()), mimetype: 'audio/mpeg', ptt: true }, { quoted: x.m });
});

// Downloaders
add(['song', 'play', 'yta', 'ytmp3', 'song2', 'song65', 'playch', 'spotify', 'soundcloud', 'mv'], (x) => (/soundcloud\.com/i.test(x.args) ? aioDl(x) : ytDownload(x, false)));
add(['video', 'ytmp4', 'ytvideo', 'videot', 'video2', 'video3'], (x) => ytDownload(x, true));
add(['tiktok', 'tt'], tiktokDl);
add(['aio', 'dl', 'fb', 'igdl', 'igdl2', 'igdl3', 'capcut'], aioDl);
add('yts', async (x) => {
  if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}yts naam`);
  const v = await ytSearch(x.args);
  if (!v) return x.reply('Kuch nahi mila.');
  x.sock.sendMessage(x.chat, { image: { url: v.thumbnail }, caption: `🔎 *${v.title}*\n👤 ${v.author.name}\n⏱️ ${v.timestamp}\n${v.url}` }, { quoted: x.m });
});
add('lyrics', async (x) => {
  const [a, ...t] = x.args.split('|').map((s) => s.trim());
  if (!a || !t.length) return x.reply(`Aise likho: ${CFG.prefix}lyrics artist | title`);
  const j = await getJson(`https://api.lyrics.ovh/v1/${encodeURIComponent(a)}/${encodeURIComponent(t.join(' '))}`);
  x.reply((j.lyrics || 'Nahi mila').slice(0, 3500));
});

// Media tools
add('tourl', async (x) => {
  const b = await getMedia(x.sock, x.m, ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage']);
  if (!b) return x.reply('Kisi media par reply karke .tourl likho.');
  x.reply('🔗 ' + (await uploadCatbox(b, 'file.' + (b.mediaMsg?.mimetype?.split('/')[1]?.split(';')[0] || 'bin'))));
});
add('tomp3', async (x) => {
  const b = await getMedia(x.sock, x.m, ['audioMessage', 'videoMessage']);
  if (!b) return x.reply('Video/audio par reply karke .tomp3 likho.');
  const out = await ffmpeg(b, ['-vn', '-acodec', 'libmp3lame', '-q:a', '3'], 'mp3');
  x.sock.sendMessage(x.chat, { audio: out, mimetype: 'audio/mpeg' }, { quoted: x.m });
});
add('toptt', async (x) => {
  const b = await getMedia(x.sock, x.m, ['audioMessage', 'videoMessage']);
  if (!b) return x.reply('Video/audio par reply karke .toptt likho.');
  const out = await ffmpeg(b, ['-vn', '-c:a', 'libopus', '-b:a', '48k'], 'ogg');
  x.sock.sendMessage(x.chat, { audio: out, mimetype: 'audio/ogg; codecs=opus', ptt: true }, { quoted: x.m });
});
add(['removebg', 'removebg2'], async (x) => {
  const key = process.env.REMOVEBG_KEY;
  if (!key) return x.reply('Owner ko REMOVEBG_KEY (remove.bg) Render me set karni hogi.');
  const b = await getMedia(x.sock, x.m, ['imageMessage']);
  if (!b) return x.reply('Photo par reply karke .removebg likho.');
  const fd = new FormData();
  fd.append('image_file', new Blob([b]), 'a.jpg');
  fd.append('size', 'auto');
  const r = await fetch('https://api.remove.bg/v1.0/removebg', { method: 'POST', headers: { 'X-Api-Key': key }, body: fd });
  if (!r.ok) throw new Error('removebg fail ' + r.status);
  x.sock.sendMessage(x.chat, { image: Buffer.from(await r.arrayBuffer()), caption: 'Done ✅' }, { quoted: x.m });
});
add('blurface', async (x) => {
  const b = await getMedia(x.sock, x.m, ['imageMessage']);
  if (!b) return x.reply('Photo par reply karo.');
  x.sock.sendMessage(x.chat, { image: await sharp(b).blur(12).toBuffer() }, { quoted: x.m });
});
const ENH = async (x) => {
  const b = await getMedia(x.sock, x.m, ['imageMessage']);
  if (!b) return x.reply('Photo par reply karke command likho.');
  const n = parseInt(x.cmd.replace(/\D/g, '')) || 2;
  const scale = Math.min(Math.max(Math.ceil(n / 4) + 1, 2), 4);
  const meta = await sharp(b).metadata();
  const out = await sharp(b).resize(Math.min(meta.width * scale, 4096)).sharpen().jpeg({ quality: 95 }).toBuffer();
  x.sock.sendMessage(x.chat, { image: out, caption: `Enhanced x${scale} ✅` }, { quoted: x.m });
};
add([...range('upscale', 16), 'enhance1', 'enhance4', 'enhance8', 'enhance16', 'remini', 'unblur'], ENH);

// Groups
const gsend = (x, meta, text) => x.sock.sendMessage(x.chat, { text, mentions: meta.participants.map((p) => p.id) });
add(['mute'], (x) => EXTRA.get('close_')(x));
add(['unmute'], (x) => EXTRA.get('open_')(x));
add('close_', async (x) => { if (!(await x.adminGate())) return; await x.sock.groupSettingUpdate(x.chat, 'announcement'); x.reply('🔇 Group band: sirf admin msg kar sakte hain.'); });
add('open_', async (x) => { if (!(await x.adminGate())) return; await x.sock.groupSettingUpdate(x.chat, 'not_announcement'); x.reply('🔊 Group khul gaya.'); });
add('tag', async (x) => { const meta = await x.adminGate(); if (meta) gsend(x, meta, x.args || '📢'); });
add('kick1', async (x) => { if (!(await x.adminGate())) return; const t = x.targetOf(); if (t) { await x.sock.groupParticipantsUpdate(x.chat, [t], 'remove'); x.reply('Ho gaya ✅'); } });
add('invite', async (x) => { if (!(await x.adminGate())) return; x.reply('https://chat.whatsapp.com/' + (await x.sock.groupInviteCode(x.chat))); });
add('revoke', async (x) => { if (!(await x.adminGate())) return; await x.sock.groupRevokeInvite(x.chat); x.reply('Link reset ✅'); });
add('add', async (x) => {
  if (!(await x.adminGate())) return;
  const n = x.args.replace(/\D/g, '');
  if (!n) return x.reply(`Aise likho: ${CFG.prefix}add 923001234567`);
  await x.sock.groupParticipantsUpdate(x.chat, [n + '@s.whatsapp.net'], 'add');
  x.reply('Add request bhej di ✅');
});
add('kickall', async (x) => {
  const meta = await x.adminGate(); if (!meta) return;
  if (!x.isOwner) return x.reply('Sirf owner.');
  const ids = meta.participants.filter((p) => !p.admin).map((p) => p.id);
  for (let i = 0; i < ids.length; i += 5) { await x.sock.groupParticipantsUpdate(x.chat, ids.slice(i, i + 5), 'remove'); await delay(1500); }
});
add(['out', 'leave'], async (x) => { if (!x.isOwner) return x.reply('Sirf owner.'); await x.sock.groupLeave(x.chat); });
add('end', async (x) => { const meta = await x.adminGate(); if (!meta) return; if (!x.isOwner) return x.reply('Sirf owner.'); await x.sock.groupSettingUpdate(x.chat, 'announcement'); x.reply('Group band kar diya.'); });
add('updategname', async (x) => { if (!(await x.adminGate())) return; await x.sock.groupUpdateSubject(x.chat, x.args); x.reply('✅'); });
add('updategdesc', async (x) => { if (!(await x.adminGate())) return; await x.sock.groupUpdateDescription(x.chat, x.args); x.reply('✅'); });
add('gcpp', async (x) => {
  if (!(await x.adminGate())) return;
  const b = await getMedia(x.sock, x.m, ['imageMessage']);
  if (!b) return x.reply('Photo par reply karke .gcpp likho.');
  await x.sock.updateProfilePicture(x.chat, b); x.reply('DP badal di ✅');
});
add('poll', async (x) => {
  if (!x.isGroup) return x.reply('Sirf group me.');
  const [q, ...o] = x.args.split('|').map((s) => s.trim()).filter(Boolean);
  if (o.length < 2) return x.reply(`Aise likho: ${CFG.prefix}poll Sawal | Option1 | Option2`);
  x.sock.sendMessage(x.chat, { poll: { name: q, values: o, selectableCount: 1 } });
});
add('delete', async (x) => {
  const ci = x.msg.extendedTextMessage?.contextInfo;
  if (!ci?.stanzaId) return x.reply('Jis message ko delete karna hai us par reply karo.');
  if (x.isGroup && !(await x.adminGate())) return;
  await x.sock.sendMessage(x.chat, { delete: { remoteJid: x.chat, fromMe: false, id: ci.stanzaId, participant: ci.participant } });
});
add('join', async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  const code = x.args.split('chat.whatsapp.com/')[1]?.split(/[?\s]/)[0];
  if (!code) return x.reply(`Aise likho: ${CFG.prefix}join group ka link`);
  await x.sock.groupAcceptInvite(code); x.reply('Join ho gaya ✅');
});
add('newgc', async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}newgc naam`);
  const g = await x.sock.groupCreate(x.args, [x.sender]);
  x.reply('Group ban gaya: ' + g.id);
});
add(['requests', 'accept', 'reject', 'acceptall', 'rejectall'], async (x) => {
  if (!(await x.adminGate())) return;
  const list = await x.sock.groupRequestParticipantsList(x.chat);
  if (x.cmd === 'requests') return x.reply(list.length ? list.map((r) => '+' + norm(r.phone_number || r.jid)).join('\n') : 'Koi request nahi.');
  if (!list.length) return x.reply('Koi request nahi.');
  const action = x.cmd.startsWith('accept') ? 'approve' : 'reject';
  const targets = x.cmd.endsWith('all') ? list.map((r) => r.jid) : [list[0].jid];
  await x.sock.groupRequestParticipantsUpdate(x.chat, targets, action);
  x.reply('Ho gaya ✅ (' + targets.length + ')');
});
add('count', async (x) => { const meta = await x.groupOnly(); if (meta) x.reply(`👥 Members: ${meta.participants.length}`); });
add('antibothelp', (x) => x.reply(`🛡️ Guards (admin only):\n${CFG.prefix}antilink on/off\n${CFG.prefix}antimedia on/off\n${CFG.prefix}antispam on/off\n${CFG.prefix}antitagall on/off\n${CFG.prefix}antibot on/off\n\nBot ko group admin banana zaroori hai.`));
for (const g of ['antilink', 'antimedia', 'antispam', 'antitagall', 'antibot', 'antistatus']) add(g, async (x) => {
  if (!(await x.adminGate())) return;
  const set = x.entry.g[g];
  if (x.args === 'on') { set.add(x.chat); return x.reply(`${g} ON ✅`); }
  if (x.args === 'off') { set.delete(x.chat); return x.reply(`${g} OFF`); }
  x.reply(`Aise likho: ${CFG.prefix}${g} on  ya  ${CFG.prefix}${g} off\nAbhi: ${set.has(x.chat) ? 'ON' : 'OFF'}`);
});

// Owner
add(['vv', 'vv2', 'vv3', 'vvaudio', 'vv5'], async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  const b = await getMedia(x.sock, x.m, ['imageMessage', 'videoMessage', 'audioMessage']);
  if (!b) return x.reply('View-once media par reply karke likho.');
  const dest = x.cmd === 'vv' ? x.chat : norm(x.sock.user.id) + '@s.whatsapp.net';
  const c = b.mediaMsg?.caption || '';
  if (b.mediaType === 'imageMessage') return x.sock.sendMessage(dest, { image: b, caption: c });
  if (b.mediaType === 'videoMessage') return x.sock.sendMessage(dest, { video: b, caption: c });
  return x.sock.sendMessage(dest, { audio: b, mimetype: 'audio/mpeg' });
});
add('forward', async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  const ci = x.msg.extendedTextMessage?.contextInfo;
  const to = x.args.replace(/\D/g, '');
  if (!ci?.quotedMessage || !to) return x.reply(`Message par reply karke: ${CFG.prefix}forward 923001234567`);
  await x.sock.sendMessage(to + '@s.whatsapp.net', { forward: { key: { remoteJid: x.chat, id: ci.stanzaId, participant: ci.participant }, message: ci.quotedMessage } });
  x.reply('Forward ✅');
});
add(['block', 'unblock'], async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  const t = x.targetOf() || (x.isGroup ? null : x.chat);
  if (!t) return x.reply('Kisi ko mention/reply karo.');
  await x.sock.updateBlockStatus(t, x.cmd); x.reply('Ho gaya ✅');
});
add('fullpp', async (x) => {
  if (!x.isOwner) return x.reply('Sirf owner.');
  const b = await getMedia(x.sock, x.m, ['imageMessage']);
  if (!b) return x.reply('Photo par reply karo.');
  await x.sock.updateProfilePicture(norm(x.sock.user.id) + '@s.whatsapp.net', b); x.reply('Bot DP badal di ✅');
});
add('getpp', async (x) => {
  try { const u = await x.sock.profilePictureUrl(x.targetOf() || x.sender, 'image'); x.sock.sendMessage(x.chat, { image: { url: u } }, { quoted: x.m }); }
  catch { x.reply('DP nahi mili (private ho sakti hai).'); }
});
add('mee', (x) => x.reply(`👤 ${x.m.pushName || 'User'}\nwa.me/${norm(x.sender)}`));
add('srepo', (x) => x.reply('📂 ' + (process.env.REPO_LINK || 'Repo link set nahi hai (REPO_LINK env).')));
add('afk', (x) => { x.entry.afk = x.entry.afk || new Map(); x.entry.afk.set(norm(x.sender), { reason: x.args || 'AFK', at: Date.now() }); x.reply('😴 AFK ON: ' + (x.args || 'AFK')); });

// Settings
function toggleSetting(x, key, label) {
  if (!x.isOwner) return x.reply('Sirf owner.');
  if (x.args === 'on') x.entry.settings[key] = true;
  else if (x.args === 'off') x.entry.settings[key] = false;
  else return x.reply(`${label}: ${x.entry.settings[key] ? 'ON' : 'OFF'}\nAise likho: ${CFG.prefix}${x.cmd} on/off`);
  x.reply(`${label}: ${x.entry.settings[key] ? 'ON ✅' : 'OFF'}`);
}
for (const [k, l] of Object.entries({ autoread: 'AutoRead', autotyping: 'AutoTyping', recording: 'Recording status', statusview: 'Status view', statuslike: 'Status like', anticall: 'AntiCall', autoreact: 'AutoReact', online: 'Always online' })) add(k, (x) => toggleSetting(x, k, l));
add('prefix', (x) => { if (!x.isOwner) return x.reply('Sirf owner.'); if (!x.args) return x.reply('Prefix: ' + CFG.prefix); CFG.prefix = x.args[0]; x.reply('Prefix ab: ' + CFG.prefix); });
add('botname', (x) => { if (!x.isOwner) return x.reply('Sirf owner.'); if (x.args) CFG.name = x.args; x.reply('Bot name: ' + CFG.name); });
add('ownername', (x) => { if (!x.isOwner) return x.reply('Sirf owner.'); if (x.args) CFG.owner = x.args; x.reply('Owner name: ' + CFG.owner); });
add('settings', (x) => {
  const s = x.entry.settings;
  x.reply(`⚙️ *Settings*\nMode: ${x.entry.mode}\nPrefix: ${CFG.prefix}\n` + ['autoread', 'autotyping', 'recording', 'statusview', 'statuslike', 'anticall', 'autoreact', 'online', 'autochat'].map((k) => `${k}: ${s[k] ? 'ON' : 'OFF'}`).join('\n'));
});
add(/* unban templates */ range('unban', 100, 2).concat('unban'), (x) => x.reply(`Support ko ye message bhejo (support@whatsapp.com):\n\n"Hello WhatsApp Team, my number ${x.args || '+XX XXXXXXXXXX'} was banned by mistake. I use WhatsApp only for personal chats and follow the Terms of Service. Please review and restore my account. Thank you."`));

// Needs external service (jab tak API na ho, saaf message)
const NEEDS_API = { logo: 'Logo generator API', img: 'Image search API', grub: 'Group search API', pinterest: 'Pinterest API', ttsearch: 'TikTok search API', ytstalk: 'YouTube stalk API', boydp: 'DP collection API', girldp: 'DP collection API', coupledp: 'DP collection API', sound: 'Sound effects API', news: 'News API', akinator: 'Akinator API', movie: 'Movie API', apk: 'APK API', editimg: 'Image edit API', photoedit: 'Image edit API', nsfwcheck: 'NSFW checker API', colorize: 'Colorize API' };
function needsApi(x) {
  const key = Object.keys(NEEDS_API).find((k) => x.cmd.startsWith(k)) || 'x';
  const src = LOGO_SET.has(x.cmd) ? 'Logo generator API' : NEEDS_API[key] || 'ek external API';
  return x.reply(`⚠️ *${CFG.prefix}${x.cmd}* ke liye ${src} chahiye.\nOwner ne abhi ise connect nahi kiya.`);
}
const LOGO_SET = new Set(MENU.LOGO);

async function handle(sock, entry, m) {
  if (!m.message) return;
  if (m.key.remoteJid === 'status@broadcast') {
    try {
      if (entry.settings.statusview) await sock.readMessages([m.key]);
      if (entry.settings.statuslike && m.key.participant) await sock.sendMessage('status@broadcast', { react: { text: '💚', key: m.key } }, { statusJidList: [m.key.participant, sock.user.id] });
    } catch {}
    return;
  }
  const chat = m.key.remoteJid;
  const isGroup = chat.endsWith('@g.us');
  const msg = normalizeMessageContent(m.message);
  const text = msg.conversation || msg.extendedTextMessage?.text || msg.imageMessage?.caption || msg.videoMessage?.caption || '';
  const sender = m.key.fromMe ? sock.user.id : m.key.participant || chat;
  const senderIds = [sender, m.key.participantAlt].filter(Boolean);
  const isOwner = m.key.fromMe || senderIds.some((x) => CFG.extraOwners.includes(norm(x)));
  const reply = (t, extra = {}) => sock.sendMessage(chat, { text: t, ...extra }, { quoted: m });
  const S = entry.settings;

  if (!m.key.fromMe) {
    try {
      if (S.autoread) await sock.readMessages([m.key]);
      if (S.autotyping) await sock.sendPresenceUpdate('composing', chat);
      else if (S.recording) await sock.sendPresenceUpdate('recording', chat);
      else if (S.online) await sock.sendPresenceUpdate('available');
      if (S.autoreact) await sock.sendMessage(chat, { react: { text: pick(['❤️', '🔥', '😂', '👍', '✨']), key: m.key } });
    } catch {}
  }

  // AFK
  if (entry.afk?.size && !m.key.fromMe) {
    const me = norm(sender);
    if (entry.afk.has(me) && !text.startsWith(CFG.prefix)) {
      const a = entry.afk.get(me); entry.afk.delete(me);
      await reply(`👋 Wapas aa gaye! ${Math.round((Date.now() - a.at) / 60000)} min AFK rahe.`);
    }
    const ment = msg.extendedTextMessage?.contextInfo?.mentionedJid || [];
    for (const j of ment) if (entry.afk.has(norm(j))) await reply(`😴 @${norm(j)} AFK hai: ${entry.afk.get(norm(j)).reason}`, { mentions: [j] });
  }

  // Group guards
  if (isGroup && !m.key.fromMe) {
    const g = entry.g; const bad = [];
    if (g.antilink.has(chat) && /chat\.whatsapp\.com\//i.test(text)) bad.push('Group link');
    if (g.antimedia.has(chat) && (msg.imageMessage || msg.videoMessage || msg.stickerMessage || msg.audioMessage)) bad.push('Media');
    if (g.antitagall.has(chat) && (msg.extendedTextMessage?.contextInfo?.mentionedJid?.length || 0) >= 5) bad.push('Tagall');
    if (g.antibot.has(chat) && /^BAE5/.test(m.key.id || '')) bad.push('Bot');
    if (g.antispam.has(chat)) {
      const k = chat + norm(sender); const arr = (entry.spam.get(k) || []).filter((t) => Date.now() - t < 5000); arr.push(Date.now()); entry.spam.set(k, arr);
      if (arr.length > 6) bad.push('Spam');
    }
    if (bad.length) {
      try {
        const meta = await sock.groupMetadata(chat);
        if (isAdminIn(meta, [sock.user.id, sock.user.lid]) && !isAdminIn(meta, senderIds)) {
          await sock.sendMessage(chat, { delete: m.key });
          if (bad[0] !== 'Spam') await sock.sendMessage(chat, { text: `${bad[0]} allowed nahi hai.` });
        }
      } catch {}
      return;
    }
  }

  if (!text.startsWith(CFG.prefix)) {
    if (S.autochat && !isGroup && !m.key.fromMe && text) { try { await reply(await aiText(text)); } catch {} }
    return;
  }
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
  const ctx = { sock, entry, m, msg, chat, isGroup, sender, senderIds, isOwner, args, cmd, reply, groupOnly, adminGate, targetOf };

  try {
    switch (cmd) {
      case 'menu': case 'help':
        return sendMenu(sock, chat, m, entry);
      case 'ping': {
        const t0 = Date.now();
        const s = await reply('Pong...');
        return sock.sendMessage(chat, { text: `Pong: ${Date.now() - t0} ms`, edit: s.key });
      }
      case 'ping2': return reply(`⚡ ${Math.max(0, Date.now() - (Number(m.messageTimestamp) * 1000))} ms`);
      case 'alive': return reply(`${CFG.name} zinda hai ✅\nUptime: ${fmtTime((Date.now() - entry.started) / 1000)}`);
      case 'runtime': return reply(`Uptime: ${fmtTime((Date.now() - entry.started) / 1000)}`);
      case 'owner': return reply(`Owner: ${CFG.owner}\nBot number: wa.me/${entry.number || norm(sock.user.id)}`);
      case 'channel': return reply(`Hamara WhatsApp channel:\n${CFG.channel}`);

      case 'sticker': case 's': {
        const buf = await getMedia(sock, m, ['imageMessage']);
        if (!buf) return reply(`Photo bhejo ya kisi photo par reply karke ${CFG.prefix}sticker likho.`);
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
        if (!t) return reply('Kisi ko @mention karo ya uske message par reply karo.');
        await sock.groupParticipantsUpdate(chat, [t], cmd === 'kick' ? 'remove' : cmd);
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
      case 'groupinfo': case 'ginfo': {
        const meta = await groupOnly(); if (!meta) return;
        return reply(`*${meta.subject}*\nMembers: ${meta.participants.length}\nAdmins: ${meta.participants.filter((p) => p.admin).length}\n\n${meta.desc || ''}`);
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
      default: {
        const fx = EXTRA.get(cmd);
        if (fx) return fx(ctx);
        if (ALL_NAMES.has(cmd)) return needsApi(ctx);
        return;
      }
    }
  } catch (e) {
    return reply('Command fail hui: ' + (e?.message || 'unknown error'));
  }
}

restoreAll().catch(() => {});
