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
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY; // NUEVO

// ── Hotmart OAuth token cache ──────────────────────────────────────────────
let hotmartToken = null;
let hotmartTokenExpiry = 0;

async function getHotmartToken() {
  if (hotmartToken && Date.now() < hotmartTokenExpiry) return hotmartToken;
  const basic = Buffer.from(HOTMART_CLIENT_ID + ':' + HOTMART_CLIENT_SECRET).toString('base64');
  const res = await fetch('https://api-sec-vlc.hotmart.com/security/oauth/token?grant_type=client_credentials', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + basic
    }
  });
  const text = await res.text();
  console.log('Hotmart token response:', res.status, text.slice(0, 200));
  const data = JSON.parse(text);
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

// ═══════════════════════════════════════════════════════════════════════════
// NUEVO: OPENAI REALTIME API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════

// In-memory storage for realtime usage (en producción usarías PostgreSQL)
const realtimeUsage = new Map(); // Map<email, { date: string, minutes: number, sessions: number }>
const realtimeSessions = new Map(); // Map<sessionId, { email, level, startTime }>

// ── /api/realtime/usage-today ──────────────────────────────────────────────
app.get('/api/realtime/usage-today', requireAuth, (req, res) => {
  const email = req.user.email;
  const today = new Date().toISOString().split('T')[0];
  
  const usage = realtimeUsage.get(email);
  
  if (!usage || usage.date !== today) {
    return res.json({ minutesUsed: 0, sessionsToday: 0 });
  }
  
  res.json({ minutesUsed: usage.minutes, sessionsToday: usage.sessions });
});

// ── /api/realtime/start-session ────────────────────────────────────────────
app.post('/api/realtime/start-session', requireAuth, async (req, res) => {
  const email = req.user.email;
  const { level } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  // Verificar límite diario
  const usage = realtimeUsage.get(email);
  const minutesUsed = (usage && usage.date === today) ? usage.minutes : 0;
  
  if (minutesUsed >= 15) {
    return res.status(429).json({ 
      error: 'Você já usou seus 15 minutos de hoje. Tente novamente amanhã.' 
    });
  }
  
  try {
    // Obtener ephemeral token de OpenAI
    const openaiRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'alloy'
      })
    });
    
    if (!openaiRes.ok) {
      const errorText = await openaiRes.text();
      console.error('OpenAI Realtime error:', openaiRes.status, errorText);
      throw new Error('Erro ao criar sessão OpenAI');
    }
    
    const data = await openaiRes.json();
    const sessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Guardar sesión
    realtimeSessions.set(sessionId, {
      email,
      level: level || 'B1',
      startTime: Date.now()
    });
    
    res.json({
      sessionId,
      ephemeralToken: data.client_secret.value,
      expiresAt: data.client_secret.expires_at
    });
    
  } catch (e) {
    console.error('Start session error:', e.message);
    res.status(500).json({ error: 'Erro ao iniciar sessão. Tente novamente.' });
  }
});

// ── /api/realtime/end-session ──────────────────────────────────────────────
app.post('/api/realtime/end-session', requireAuth, (req, res) => {
  const email = req.user.email;
  const { sessionId, durationMinutes } = req.body;
  const today = new Date().toISOString().split('T')[0];
  
  // Verificar que la sesión existe y pertenece al usuario
  const session = realtimeSessions.get(sessionId);
  if (!session || session.email !== email) {
    return res.status(404).json({ error: 'Sessão não encontrada.' });
  }
  
  // Actualizar uso diario
  const currentUsage = realtimeUsage.get(email);
  
  if (!currentUsage || currentUsage.date !== today) {
    realtimeUsage.set(email, {
      date: today,
      minutes: durationMinutes,
      sessions: 1
    });
  } else {
    currentUsage.minutes += durationMinutes;
    currentUsage.sessions += 1;
  }
  
  // Remover sesión
  realtimeSessions.delete(sessionId);
  
  console.log(`Session ended: ${email} - ${durationMinutes} min`);
  
  res.json({ ok: true, totalMinutesToday: realtimeUsage.get(email).minutes });
});

// ═══════════════════════════════════════════════════════════════════════════

// ── Health check ───────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'Imersão Nativa backend ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Imersão Nativa backend rodando na porta ${PORT}`));
