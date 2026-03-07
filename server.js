require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const jwt = require('jsonwebtoken');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({
  origin: [
    /\.espanholcomvoce\.com$/,
    'https://espanholcomvoce.com',
    'https://app.espanholcomvoce.com',
    /\.netlify\.app$/,
    'http://localhost:3000',
    'http://127.0.0.1:5500'
  ],
  credentials: true
}));

// ── Env vars (set these in Railway) ───────────────────────────────────────
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'pqHfZKP75CvOlQylNhV4';
const JWT_SECRET          = process.env.JWT_SECRET || 'imersao-nativa-secret-2024';
const HOTMART_CLIENT_ID   = process.env.HOTMART_CLIENT_ID;
const HOTMART_CLIENT_SECRET = process.env.HOTMART_CLIENT_SECRET;
const HOTMART_PRODUCT_ID  = process.env.HOTMART_PRODUCT_ID;

// ── Hotmart OAuth token cache ──────────────────────────────────────────────
let hotmartToken = null;
let hotmartTokenExpiry = 0;

async function getHotmartToken() {
  if (hotmartToken && Date.now() < hotmartTokenExpiry) return hotmartToken;
  const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: HOTMART_CLIENT_ID,
      client_secret: HOTMART_CLIENT_SECRET
    })
  });
  const data = await res.json();
  hotmartToken = data.access_token;
  hotmartTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return hotmartToken;
}

async function checkHotmartSubscriber(email) {
  if (!HOTMART_CLIENT_ID || !HOTMART_CLIENT_SECRET) {
    console.log('test mode - allowing all');
    return true;
  }
  try {
    const token = await getHotmartToken();
    const emailLow = email.toLowerCase();
    const VALID_STATUSES = ['APPROVED', 'COMPLETE', 'ACTIVE'];

    // 1) Sales history - APPROVED ou COMPLETE
    const salesRes = await fetch(
      'https://developers.hotmart.com/payments/api/v1/sales/history?buyer_email=' + encodeURIComponent(email) + '&product_id=' + HOTMART_PRODUCT_ID,
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const salesData = await salesRes.json();
    console.log('Sales API status:', salesRes.status, JSON.stringify(salesData).slice(0,200));
    if (salesData.items && salesData.items.some(i => i.purchase && VALID_STATUSES.includes(i.purchase.status))) {
      console.log('Access granted via sales:', emailLow);
      return true;
    }

    // 2) Subscriptions - ACTIVE
    const subRes = await fetch(
      'https://developers.hotmart.com/payments/api/v1/subscriptions?subscriber_email=' + encodeURIComponent(email) + '&product_id=' + HOTMART_PRODUCT_ID + '&status=ACTIVE',
      { headers: { 'Authorization': 'Bearer ' + token } }
    );
    const subData = await subRes.json();
    console.log('Sub API status:', subRes.status, JSON.stringify(subData).slice(0,200));
    if (subData.items && subData.items.length > 0) {
      console.log('Access granted via subscription:', emailLow);
      return true;
    }

    console.log('Access denied for:', emailLow);
    return false;
  } catch (e) {
    console.error('Hotmart error:', e.message);
    return false;
  }
}

// ── /api/login ─────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { email } = req.body;
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email inválido.' });
  }
  const isActive = await checkHotmartSubscriber(email.toLowerCase().trim());
  if (!isActive) {
    return res.status(403).json({
      error: 'Acesso não encontrado. Verifique se seu email está ativo na Hotmart ou entre em contato.'
    });
  }
  const token = jwt.sign(
    { email: email.toLowerCase().trim(), ts: Date.now() },
    JWT_SECRET,
    { expiresIn: '1d' }
  );
  res.json({ token, email });
});

// ── Auth middleware ────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Sessão expirada. Faça login novamente.' });
  }
}

// ── /api/chat — Anthropic proxy ────────────────────────────────────────────
app.post('/api/chat', requireAuth, async (req, res) => {
  const { model, max_tokens, system, messages, stream } = req.body;
  try {
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model, max_tokens, system, messages, stream: stream || false })
    });

    if (stream) {
      // Forward streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      anthropicRes.body.pipe(res);
    } else {
      const data = await anthropicRes.json();
      res.json(data);
    }
  } catch (e) {
    console.error('Anthropic error:', e.message);
    res.status(500).json({ error: 'Erro na IA. Tente novamente.' });
  }
});

// ── /api/tts — ElevenLabs proxy ────────────────────────────────────────────
app.post('/api/tts', requireAuth, async (req, res) => {
  const { text, model_id, voice_settings } = req.body;
  const cleanText = (text || '').replace(/\[.*?\]/g, '').substring(0, 2500).trim();
  if (!cleanText) return res.status(400).json({ error: 'Texto vazio.' });

  try {
    const elRes = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'xi-api-key': ELEVENLABS_API_KEY },
        body: JSON.stringify({
          text: cleanText,
          model_id: model_id || 'eleven_flash_v2_5',
          voice_settings: voice_settings || { stability: 0.5, similarity_boost: 0.75, style: 0.2, use_speaker_boost: false }
        })
      }
    );
    if (!elRes.ok) throw new Error('ElevenLabs error ' + elRes.status);
    res.setHeader('Content-Type', 'audio/mpeg');
    elRes.body.pipe(res);
  } catch (e) {
    console.error('ElevenLabs error:', e.message);
    res.status(500).json({ error: 'Erro no áudio.' });
  }
});

// ── /api/verify — re-check subscription (called on app open) ──────────────
app.post('/api/verify', requireAuth, async (req, res) => {
  const isActive = await checkHotmartSubscriber(req.user.email);
  if (!isActive) return res.status(403).json({ error: 'Assinatura inativa.' });
  res.json({ ok: true, email: req.user.email });
});

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Imersão Nativa backend ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Imersão Nativa backend rodando na porta ${PORT}`));
