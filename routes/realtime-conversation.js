/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → Frontend conecta direto na OpenAI via WebRTC
 *
 * GET  /api/realtime/status  → minutos restantes
 * POST /api/realtime/token   → gera ephemeral token
 * POST /api/realtime/end     → registra fim da sessão
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const DAILY_LIMIT_MINUTES = parseInt(process.env.REALTIME_DAILY_MINUTES || '15');

const usageMap = new Map();

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getUsage(email) {
  const today = getToday();
  let u = usageMap.get(email);
  if (!u || u.date !== today) {
    u = { date: today, seconds: 0, sessionStart: null };
    usageMap.set(email, u);
  }
  return u;
}

function getRemainingSeconds(email) {
  return Math.max(0, DAILY_LIMIT_MINUTES * 60 - getUsage(email).seconds);
}

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token necessário.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido.' }); }
}

// GET /api/realtime/status
router.get('/status', auth, (req, res) => {
  const remaining = getRemainingSeconds(req.user.email);
  const u = getUsage(req.user.email);
  res.json({
    daily_limit_minutes: DAILY_LIMIT_MINUTES,
    used_seconds: u.seconds,
    remaining_seconds: remaining,
    remaining_minutes: Math.floor(remaining / 60),
    limit_reached: remaining === 0
  });
});

// POST /api/realtime/token
router.post('/token', auth, async (req, res) => {
  const email = req.user.email;
  const remaining = getRemainingSeconds(email);
  if (remaining <= 0) return res.status(403).json({ error: 'Limite diário atingido.', limit_reached: true });

  const { level, situation } = req.body || {};

  const sitMap = { café:'num café', hotel:'num hotel', trabajo:'no trabalho', médico:'no médico', viaje:'numa viagem', mercado:'no mercado', amigos:'com amigos', libre:'sobre qualquer assunto' };
  const lvlMap = { beginner:'iniciante (A1-A2) — use vocabulário simples e fale devagar', intermediate:'intermediário (B1-B2)', advanced:'avançado (C1-C2) — use vocabulário rico' };

  const instructions = `Eres Paula, profesora de español para brasileños. Conversación ${sitMap[situation]||'libre'}. Nivel del alumno: ${lvlMap[level]||'intermediário'}.

REGLAS:
- Habla siempre en español, respuestas cortas (2-3 frases máximo)
- Entiende portugués pero responde siempre en español
- Corrige errores suavemente integrados: si dice "eu fui" → tú dices "¡Ah, *yo fui*! ¿Y qué pasó?"
- Siempre termina con una pregunta para mantener la conversación
- Tono cercano y motivador, como una amiga que es profesora
- Empieza presentándote brevemente y haciendo una pregunta sobre la situación`;

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'shimmer',
        instructions,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 700 },
        temperature: 0.85,
        max_response_output_tokens: 200
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[REALTIME] OpenAI error:', err);
      return res.status(502).json({ error: 'Erro ao criar sessão.' });
    }

    const session = await r.json();
    const u = getUsage(email);
    u.sessionStart = Date.now();
    usageMap.set(email, u);

    console.log(`[REALTIME] Token gerado: ${email} | Restam ${Math.floor(remaining/60)}min`);
    res.json({ client_secret: session.client_secret, remaining_seconds: remaining });

  } catch(err) {
    console.error('[REALTIME]', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// POST /api/realtime/end
router.post('/end', auth, (req, res) => {
  const email = req.user.email;
  const u = getUsage(email);
  if (u.sessionStart) {
    u.seconds += Math.floor((Date.now() - u.sessionStart) / 1000);
    u.sessionStart = null;
    usageMap.set(email, u);
    console.log(`[REALTIME] Encerrado: ${email} | Total: ${u.seconds}s`);
  }
  res.json({ ok: true });
});

function setupRealtimeWebSocket(httpServer) {
  console.log('ℹ️  Realtime via ephemeral token (WebRTC direto)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
