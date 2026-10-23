// Ziddi Power - extras.js
// Commands: movie, news, img, agent (AI agent)
// Keys yahin file me hain. Repo PRIVATE rakho warna keys leak ho jayengi.

process.env.OMDB_KEY ||= '67008013';
process.env.NEWS_KEY ||= 'aee9acf52eb34697b71867141a0e3d69';
process.env.UNSPLASH_KEY ||= 'b0LXSHudv7oBoCiEFfsx1Y9jdIJXFPwGqxmOYPLU7ws';
process.env.REMOVEBG_KEY ||= 'zxum4b3GFR8T8ohDGK9w4hSX';
process.env.RAPIDAPI_KEY ||= 'api_456805f3-e981-49e7-ab13-423cb867c9b0';

const norm = (j) => (j || '').split(':')[0].split('@')[0];

// ---------- AI AGENT ----------
const hist = new Map();   // chat -> [{role, content}]
const lastAt = new Map(); // chat -> time (cooldown)
const DEFAULT_PROMPT =
  'Tum ek dostana WhatsApp AI assistant ho. Jis zuban me user likhe (Roman Urdu, Urdu, Hindi, English) usi me jawab do. ' +
  'Jawab chhota, seedha aur natural rakho, jaise insan chat karta hai. Agar kuch pata na ho to sach bata do, ghalat jawab mat do.';

async function aiChat(messages) {
  try {
    const r = await fetch('https://text.pollinations.ai/openai', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages }),
      signal: AbortSignal.timeout(40000),
    });
    if (r.ok) {
      const j = await r.json();
      const t = j.choices?.[0]?.message?.content?.trim();
      if (t) return t;
    }
  } catch {}
  const prompt = messages.map((m) => `${m.role}: ${m.content}`).join('\n') + '\nassistant:';
  const r = await fetch('https://text.pollinations.ai/' + encodeURIComponent(prompt.slice(-3000)), {
    signal: AbortSignal.timeout(40000),
  });
  if (!r.ok) throw new Error('AI server jawab nahi de raha (' + r.status + ')');
  return (await r.text()).trim();
}

// bot.js har normal (bina prefix) message pe ye call karta hai
globalThis.zpAgent = async ({ sock, entry, m, msg, chat, isGroup, text, reply }) => {
  const S = entry.settings;
  if (!S.agent) return;
  if (!chat.endsWith('@s.whatsapp.net') && !chat.endsWith('@lid') && !isGroup) return;
  text = (text || '').trim();
  if (!text) return;

  // Group me: sirf jab bot ko mention/reply ho (ya .agent all on ho)
  if (isGroup && !S.agentAll) {
    const ci = msg.extendedTextMessage?.contextInfo;
    const me = [sock.user?.id, sock.user?.lid].filter(Boolean).map(norm);
    const mentioned = (ci?.mentionedJid || []).some((j) => me.includes(norm(j)));
    const repliedToMe = ci?.participant && me.includes(norm(ci.participant));
    if (!mentioned && !repliedToMe) return;
  }

  const key = (entry.number || '') + ':' + chat;
  if (Date.now() - (lastAt.get(key) || 0) < 2000) return; // spam se bachao
  lastAt.set(key, Date.now());

  try { await sock.sendPresenceUpdate('composing', chat); } catch {}
  const h = hist.get(key) || [];
  h.push({ role: 'user', content: text.slice(0, 600) });
  while (h.length > 8) h.shift();
  const system = { role: 'system', content: entry.agentPrompt || DEFAULT_PROMPT };
  let out;
  try {
    out = await aiChat([system, ...h]);
  } catch (e) {
    h.pop();
    return; // chup raho, error chat me mat bhejo
  }
  out = out.slice(0, 3000);
  h.push({ role: 'assistant', content: out.slice(0, 600) });
  hist.set(key, h);
  await reply(out);
};

export default function installExtras({ add, getJson, CFG }) {
  // .agent on/off/all/status/prompt/clear  (sirf owner)
  add('agent', async (x) => {
    if (!x.isOwner) return x.reply('Sirf owner.');
    const S = x.entry.settings;
    const [sub, ...rest] = (x.args || '').trim().split(/\s+/);
    const val = rest.join(' ');
    const p = CFG.prefix;
    if (sub === 'on') { S.agent = true; return x.reply('🤖 AI Agent ON ✅\nPrivate chats me har message ka jawab dunga.\nGroup me jab mujhe mention/reply karoge.\n(Group ke har message ke liye: ' + p + 'agent all on)'); }
    if (sub === 'off') { S.agent = false; return x.reply('🤖 AI Agent OFF'); }
    if (sub === 'all') {
      S.agentAll = val === 'on';
      return x.reply('Group ke har message pe jawab: ' + (S.agentAll ? 'ON ✅ (spam ho sakta hai)' : 'OFF'));
    }
    if (sub === 'prompt') {
      if (!val) return x.reply(`Aise likho: ${p}agent prompt tum ek cloth shop ke assistant ho...\nReset ke liye: ${p}agent prompt reset`);
      x.entry.agentPrompt = val === 'reset' ? null : val;
      return x.reply('Agent ki shakhsiyat badal di ✅');
    }
    if (sub === 'clear') { hist.clear(); return x.reply('Agent ki yaadasht saaf ✅'); }
    return x.reply(
      `🤖 *AI Agent*: ${S.agent ? 'ON' : 'OFF'}\nGroup all: ${S.agentAll ? 'ON' : 'OFF'}\n\n` +
      `${p}agent on / off\n${p}agent all on / off\n${p}agent prompt <hidayat>\n${p}agent clear`
    );
  });

  // .agenton / .agentoff (seedhe on-off commands)
  add('agenton', (x) => {
    if (!x.isOwner) return x.reply('Sirf owner.');
    x.entry.settings.agent = true;
    x.reply('🤖 AI Agent ON ✅\nPrivate chats me har message ka jawab dunga.\nGroup me jab mujhe mention/reply karoge.');
  });
  add('agentoff', (x) => {
    if (!x.isOwner) return x.reply('Sirf owner.');
    x.entry.settings.agent = false;
    x.reply('🤖 AI Agent OFF');
  });

  // .movie <naam>
  add('movie', async (x) => {
    if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}movie movie ka naam`);
    const key = process.env.OMDB_KEY;
    const j = await getJson(`https://www.omdbapi.com/?apikey=${key}&plot=short&t=${encodeURIComponent(x.args)}`);
    if (j.Response === 'False') return x.reply('Movie nahi mili. Naam check karo.');
    const caption =
      `🎬 *${j.Title}* (${j.Year})\n` +
      `⭐ IMDb: ${j.imdbRating}\n🎭 ${j.Genre}\n⏱️ ${j.Runtime}\n🎥 ${j.Director}\n👥 ${j.Actors}\n\n📝 ${j.Plot}`;
    if (j.Poster && j.Poster !== 'N/A') {
      return x.sock.sendMessage(x.chat, { image: { url: j.Poster }, caption }, { quoted: x.m });
    }
    return x.reply(caption);
  });

  // .news [topic]
  add(['news', 'kemkesnews'], async (x) => {
    const key = process.env.NEWS_KEY;
    const q = x.args || 'Pakistan';
    const j = await getJson(
      `https://newsapi.org/v2/everything?q=${encodeURIComponent(q)}&sortBy=publishedAt&pageSize=5&language=en&apiKey=${key}`
    );
    if (!j.articles?.length) return x.reply('Koi khabar nahi mili.');
    const t = j.articles
      .map((a, i) => `${i + 1}. *${a.title}*\n${a.source?.name || ''}\n${a.url}`)
      .join('\n\n');
    return x.reply(`📰 *News: ${q}*\n\n${t}`);
  });

  // .img <text>
  add(['img', 'pinterest'], async (x) => {
    if (!x.args) return x.reply(`Aise likho: ${CFG.prefix}img sunset`);
    const key = process.env.UNSPLASH_KEY;
    const j = await getJson(
      `https://api.unsplash.com/search/photos?per_page=3&query=${encodeURIComponent(x.args)}`,
      { headers: { Authorization: 'Client-ID ' + key } }
    );
    if (!j.results?.length) return x.reply('Koi tasveer nahi mili.');
    for (const p of j.results) {
      await x.sock.sendMessage(
        x.chat,
        { image: { url: p.urls.regular }, caption: `📷 ${x.args}\n_Photo: ${p.user?.name || 'Unsplash'}_` },
        { quoted: x.m }
      );
    }
  });
}
