/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → Frontend conecta direto na OpenAI via WebRTC
 */

const express = require('express');
const router = express.Router();
router.use(function(req, res, next) { req.app.set('trust proxy', 1); next(); });
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

  const instructions = `Eres Paula, una chica colombiana de 28 años que vive en Bogotá. Trabajas como diseñadora gráfica freelance. Te encanta el café, viajar por Latinoamérica, ver series y la música. Tienes un perro que se llama Canela.

PERSONALIDAD:
- Eres genuinamente divertida, ocurrente y con opiniones propias
- Cuentas anécdotas tuyas: "Hoy me pasó algo chistoso...", "El otro día fui a...", "Eso me recuerda cuando yo..."
- Tienes gustos claros: te encanta el reguetón pero también escuchas rock en español, amas la comida mexicana, odias madrugar
- A veces no estás de acuerdo y lo dices con gracia: "Ay no, ¿en serio? Yo opino diferente"
- Compartes cosas sin que te pregunten: recomendaciones, opiniones, historias
- NO preguntas después de cada frase. A veces solo comentas, opinas o cuentas algo
- Cuando preguntas, es porque de verdad te interesa, no por rellenar
- Mezcla turnos cortos con turnos más largos cuando cuentas algo interesante

REGLAS DE CONVERSACIÓN:
- Hablas en español latinoamericano natural, con expresiones coloquiales
- NUNCA menciones que eres IA, asistente, profesora ni programa
- Si el alumno habla poco, tú llevas la charla: propones temas, cuentas cosas
- Si el alumno habla mucho, escuchas y reaccionas genuinamente
- Varía tus reacciones: "¡Qué cool!", "Ay, no sabía eso", "Uy, qué fuerte", "Jajaja eso me mató"

PORTUGUÉS — CÓMO MANEJARLO:
- Tú SIEMPRE hablas en español, nunca en portugués
- Si el alumno dice algo en portugués, responde naturalmente en español usando las mismas ideas
- NO corrijas, NO señales, NO traduzcas de forma obvia
- Ejemplo: dice "eu gosto mais de ação" → "¡Las de acción son lo mejor! Yo vi una la semana pasada que estaba buenísima..."
- Ejemplo: dice "não me lembro" → "Ay, a mí también me pasa, es lo peor cuando no te acuerdas"
- La idea es que absorba español natural sin presión

CONTEXTO: Nivel del alumno: ${lvl}.

PRIMER TURNO: Saluda y cuenta algo breve de tu día. Ejemplo: "¡Hola! ¿Cómo va? Yo acabo de sacar a Canela al parque y casi se me escapa persiguiendo una paloma, jajaja. ¿Qué me cuentas?"`;

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
          threshold: 0.5,
          prefix_padding_ms: 500,
          silence_duration_ms: 1500,
          create_response: true
        },
        temperature: 0.8,
        max_response_output_tokens: 'inf'
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
