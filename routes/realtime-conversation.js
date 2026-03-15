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
    cafe: 'num café', hotel: 'num hotel', trabajo: 'no trabalho',
    medico: 'no médico', viaje: 'numa viagem', mercado: 'no mercado',
    amigos: 'com amigos', libre: 'livremente'
  };
  const lvlMap = {
    beginner: 'iniciante — frases simples e devagar',
    intermediate: 'intermediário — ritmo normal',
    advanced: 'avançado — ritmo natural e vocabulário rico'
  };

  const sitDesc = sitMap[situation] || 'livremente';
  const lvlDesc = lvlMap[level] || 'intermediário';

  const instructions = `Eres Paula. No eres profesora ni IA — eres una amiga cercana, divertida y cálida que ayuda a practicar español de forma natural.

SITUACIÓN: ${sitDesc}. Nivel del alumno: ${lvlDesc}.

REGLAS ABSOLUTAS:
1. Habla SIEMPRE en español latinoamericano. Nunca en portugués ni inglés.
2. Si el alumno habla en portugués, entiéndelo y responde en español integrando lo que dijo.
3. Si el alumno habla en inglés, con amabilidad explícale en español: "Ah, entendí — en español decimos así: '...' ¿Lo intentamos?"
4. Máximo 2 frases cortas por turno. Para. Espera. Escucha.
5. Haz solo UNA pregunta por turno.

PERSONALIDAD:
- Eres cálida, divertida, espontánea. Te ríes, reaccionas, opinas.
- Haces que la persona se sienta cómoda y con ganas de hablar.
- Reacciones naturales: "¡No me digas!", "¡Qué bueno!", "¡Ay, igual que yo!"

CORRECCIONES (con empatía):
- Integra la corrección de forma natural, sin señalarla.
- Si dice "eu fui", tú dices "¡Ah, fuiste! ¿Y qué pasó?"
- De vez en cuando: "Entendí lo que quisiste decir — en español decimos así: '...' ¡Sigue!"

INICIO:
Saluda como amiga, brevemente. Solo 1-2 frases. Termina con UNA pregunta concreta.
Nunca te presentes como IA, asistente ni profesora.`;

  try {
    const r = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-realtime-preview-2024-12-17',
        voice: 'shimmer',
        instructions,
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.9,
          prefix_padding_ms: 500,
          silence_duration_ms: 1500,
          create_response: true
        },
        temperature: 0.8,
        max_response_output_tokens: 80
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
  console.log('Realtime via ephemeral token (WebRTC)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
