/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → Frontend conecta direto na OpenAI via WebRTC
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

router.post('/token', auth, async (req, res) => {
  const email = req.user.email;
  const remaining = getRemainingSeconds(email);
  if (remaining <= 0) return res.status(403).json({ error: 'Limite diário atingido.', limit_reached: true });

  const { level, situation } = req.body || {};

  const sitMap = {
    'café': 'num café', 'hotel': 'num hotel', 'trabajo': 'no trabalho',
    'médico': 'no médico', 'viaje': 'numa viagem', 'mercado': 'no mercado',
    'amigos': 'com amigos', 'libre': 'livremente'
  };
  const lvlMap = {
    'beginner': 'iniciante (A1-A2) — fala devagar, frases simples',
    'intermediate': 'intermediário (B1-B2) — ritmo normal',
    'advanced': 'avançado (C1-C2) — ritmo natural, vocabulário rico'
  };

  const sit = sitMap[situation] || 'livremente';
  const lvl = lvlMap[level] || 'intermediário';

  const instructions = `Eres Paula, una amiga cercana, divertida y cálida. NUNCA digas que eres IA ni profesora.

SITUACIÓN: ${sit}. Nivel del alumno: ${lvl}.

REGLAS:
- Habla SIEMPRE en español latinoamericano
- Si el alumno habla en portugués, responde en español integrando lo que dijo naturalmente
- Si el alumno comete un error, usa la forma correcta en tu respuesta de forma natural — sin señalarlo, sin asteriscos
- MÁXIMO 2 frases por turno. Para. Escucha. 
- Termina SIEMPRE con UNA pregunta concreta
- Sé espontánea: reacciona, opina, ríete, cuenta algo tuyo
- Varía los temas — no seas una máquina de preguntas sobre lo mismo
- Si hay silencio, retoma la conversación con algo inesperado o divertido

INICIO: Saluda en 1 frase cálida y haz UNA pregunta sobre la situación. Solo eso.`;

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'coral',
        instructions,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 400,
          silence_duration_ms: 1000,
          create_response: true
        },
        temperature: 0.9,
        max_response_output_tokens: 120
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[REALTIME] OpenAI error:', r.status, err);
      return res.status(502).json({ error: 'Erro ao criar sessão.', detail: err.slice(0, 200) });
    }

    const session = await r.json();
    const u = getUsage(email);
    u.sessionStart = Date.now();
    usageMap.set(email, u);

    console.log(`[REALTIME] Token gerado: ${email} | Restam ${Math.floor(remaining / 60)}min`);
    res.json({ client_secret: session.client_secret, remaining_seconds: remaining });

  } catch (err) {
    console.error('[REALTIME]', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

router.post('/end', auth, (req, res) => {
  const email = req.user.email;
  const u = getUsage(email);
  if (u.sessionStart) {
    u.seconds += Math.floor((Date.now() - u.sessionStart) / 1000);
    u.sessionStart = null;
    usageMap.set(email, u);
    console.log(`[REALTIME] Encerrado: ${email} | Total hoje: ${u.seconds}s`);
  }
  res.json({ ok: true });
});

function setupRealtimeWebSocket(httpServer) {
  console.log('ℹ️  Realtime via ephemeral token (WebRTC)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
