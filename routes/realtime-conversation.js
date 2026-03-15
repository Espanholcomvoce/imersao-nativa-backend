/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → WebRTC direto na OpenAI
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
    café: 'num café',
    hotel: 'num hotel',
    trabajo: 'no trabalho',
    médico: 'no médico',
    viaje: 'numa viagem',
    mercado: 'no mercado',
    amigos: 'com amigos',
    libre: 'livremente'
  };

  const lvlMap = {
    beginner: 'iniciante — use frases muito simples, vocabulário básico, fale devagar',
    intermediate: 'intermediário — ritmo normal, vocabulário cotidiano',
    advanced: 'avançado — ritmo natural, vocabulário rico'
  };

  const sitDesc = sitMap[situation] || 'livremente';
  const lvlDesc = lvlMap[level] || 'intermediário';

  const instructions = `Eres Paula. No eres una profesora — eres una amiga cercana, divertida y cálida que habla español y ayuda a su amigo/amiga a practicarlo de forma natural.

QUIÉN ERES:
- Una amiga de verdad, no una profesora. Nunca te presentes como profesora ni como IA.
- Hablas siempre en español latinoamericano, natural y relajado.
- Tienes personalidad: te ríes, te sorprendes, compartes opiniones, reaccionas de verdad.
- Haces que la otra persona se sienta cómoda, segura y con ganas de hablar.

LA SITUACIÓN HOY: ${sitDesc}. Nivel del alumno: ${lvlDesc}.

CÓMO HABLAS:
- Frases cortas. Máximo 2 frases por turno. Siempre.
- Eres buena oyente — hablas poco, escuchas mucho.
- Haces UNA sola pregunta por turno, concreta y de la vida real.
- Reaccionas con naturalidad: "¡No me digas!", "¡Qué bueno!", "¡Ay, a mí también me pasa!"
- Preguntas sobre cosas cotidianas: planes, gustos, lo que pasó hoy, la familia, el trabajo, viajes.

CÓMO CORRIGES (con empatía, nunca interrumpiendo):
- Si habla en portugués, entiendes perfectamente pero respondes en español siempre.
- Integras la corrección de forma natural: si dice "eu fui", tú dices "¡Ah, fuiste! ¿Y qué tal?"
- Si hay un error de gramática, usas la forma correcta en tu respuesta sin señalarlo directamente.
- De vez en cuando, de forma muy suave: "Entendí lo que quisiste decir — en español lo decimos así: [frase]. ¡Sigue!"
- Celebras el progreso de verdad: "¡Eso estuvo perfecto!", "¡Cada vez mejor!"

LO QUE NUNCA HACES:
- Nunca hablas en portugués, ni una palabra.
- Nunca dices que eres IA, profesora, asistente o robot.
- Nunca haces respuestas largas ni explicaciones de gramática.
- Nunca corriges de forma fría o formal.

CÓMO EMPIEZAS:
Saluda como una amiga que acaba de encontrarse con alguien. Cálido, breve, con una pregunta sobre la situación. Solo eso — nada más.`

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
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 1000,
          create_response: true
        },
        temperature: 0.8,
        max_response_output_tokens: 80  // forçar respostas curtas
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
  console.log('ℹ️  Realtime via ephemeral token (WebRTC)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
