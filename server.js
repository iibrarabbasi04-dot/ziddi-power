// Ziddi Power - website + pairing + bot, sab ek server me
import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { delay } from '@whiskeysockets/baileys';
import { startBot, stopBot, bots, CFG } from './bot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SESS = path.join(__dirname, 'sessions');
const MAX_BOTS = Number(process.env.MAX_BOTS || 20);
const PREFIX = 'ZIDDI:~';
fs.mkdirSync(SESS, { recursive: true });

const jobs = new Map();
const lastHit = new Map();
const app = express();
app.set('trust proxy', 1);
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/stats', (req, res) => res.json({ bots: [...bots.values()].filter((b) => b.number).length }));

app.get('/api/pair', async (req, res) => {
  const number = String(req.query.number || '').replace(/\D/g, '');
  if (number.length < 8 || number.length > 15) return res.status(400).json({ error: 'Sahi number likho, country code ke saath (jaise 923001234567).' });
  if (Date.now() - (lastHit.get(req.ip) || 0) < 20_000) return res.status(429).json({ error: '20 second ruk kar dobara try karo.' });
  lastHit.set(req.ip, Date.now());
  if (bots.has(number)) return res.status(409).json({ error: 'Ye number pehle se linked hai. WhatsApp me .alive likh kar dekho.' });
  if (bots.size >= MAX_BOTS) return res.status(503).json({ error: 'Server full hai, baad me try karo.' });

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(SESS, number);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const job = { status: 'waiting' };
  jobs.set(id, job);
  setTimeout(() => {
    if (job.status === 'waiting') { job.status = 'expired'; stopBot(number, dir); }
    setTimeout(() => jobs.delete(id), 60_000);
  }, 3 * 60_000);

  let answered = false;
  const reply = (obj, code = 200) => { if (!answered) { answered = true; res.status(code).json(obj); } };
  try {
    await startBot(number, dir, {
      number,
      onCode: (code) => reply({ id, code }),
      onEnd: () => { if (job.status !== 'sent') job.status = 'error'; },
      onLinked: async (sock) => {
        job.status = 'linked';
        await delay(4000);
        try {
          const creds = fs.readFileSync(path.join(dir, 'creds.json'));
          const me = sock.user.id.split(':')[0] + '@s.whatsapp.net';
          await sock.sendMessage(me, { text: PREFIX + Buffer.from(creds).toString('base64') });
          await sock.sendMessage(me, { text: `${CFG.name} chalu ho gaya ✅\nUpar wali SESSION_ID sambhal kar rakho (kisi ko mat do). Bot ab isi number par chal raha hai, .menu likh kar dekho.` });
        } catch {}
        try { const meta = await sock.newsletterMetadata('invite', CFG.channel.split('/channel/')[1]); await sock.newsletterFollow(meta.id); } catch {}
        job.status = 'sent';
      },
    });
  } catch {
    stopBot(number, dir);
    job.status = 'error';
    reply({ error: 'Code nahi ban saka. Number check karo aur dobara try karo.' }, 500);
  }
  setTimeout(() => reply({ error: 'Time out. Dobara try karo.' }, 504), 30_000);
});

app.get('/api/status', (req, res) => res.json({ status: jobs.get(String(req.query.id || ''))?.status || 'expired' }));

// Server restart par purani sessions wapas chalao
async function restore() {
  const env = process.env.SESSION_ID;
  if (env && env.includes(':~')) {
    try {
      const dir = path.join(SESS, 'env');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'creds.json'), Buffer.from(env.split(':~')[1], 'base64'));
    } catch (e) { console.log('SESSION_ID galat hai'); }
  }
  for (const name of fs.readdirSync(SESS)) {
    const dir = path.join(SESS, name);
    if (!fs.existsSync(path.join(dir, 'creds.json'))) continue;
    try {
      if (!JSON.parse(fs.readFileSync(path.join(dir, 'creds.json'), 'utf8')).registered) continue;
      await startBot(name, dir);
      console.log('Bot wapas chala:', name);
    } catch (e) { console.log('Bot start nahi hua:', name); }
    await delay(2000);
  }
}
app.listen(PORT, () => { console.log('Ziddi Power chal raha hai, port ' + PORT); restore(); });
