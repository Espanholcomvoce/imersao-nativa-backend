/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → Frontend conecta direto na OpenAI via WebRTC
 *
 * Endpoints:
 *   POST /api/realtime/token      cria session OpenAI + retorna ephemeral key
 *   GET  /api/realtime/status     uso e limite hoje (fuso BR)
 *   POST /api/realtime/heartbeat  soma 15s (chamado pelo frontend a cada 15s)
 *   POST /api/realtime/end        opcional, só para log/cleanup
 *
 * Tracking de uso: Postgres (tabela daily_usage), fuso America/Sao_Paulo.
 * Heartbeat resolve furos do contador antigo (sessão sem /end, restart, etc).
 */

const express = require('express');
const router = express.Router();
router.use(function(req, res, next) { req.app.set('trust proxy', 1); next(); });

const { authMiddleware, authWithRevalidation } = require('../middleware/auth');
const db = require('../db');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DAILY_LIMIT_MINUTES = parseInt(process.env.REALTIME_DAILY_MINUTES || '15');
const DAILY_LIMIT_SECONDS = DAILY_LIMIT_MINUTES * 60;
const HEARTBEAT_INCREMENT_SECONDS = 15;

// ─── GET /api/realtime/status ───
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const used = await db.getSecondsUsedToday(req.user.email);
    const remaining = Math.max(0, DAILY_LIMIT_SECONDS - used);
    res.json({
      daily_limit_minutes: DAILY_LIMIT_MINUTES,
      used_seconds: used,
      remaining_seconds: remaining,
      remaining_minutes: Math.floor(remaining / 60),
      limit_reached: remaining === 0
    });
  } catch (err) {
    console.error('[REALTIME status]', err.message);
    res.status(500).json({ error: 'Erro ao consultar uso.' });
  }
});

// ─── POST /api/realtime/token ───
// Cria session na OpenAI Realtime (gpt-realtime GA) e retorna ephemeral key.
// Bloqueia se aluno já bateu o limite diário (consulta Postgres, não Map em RAM).
router.post('/token', authWithRevalidation, async (req, res) => {
  const email = req.user.email;

  let usedSeconds;
  try {
    usedSeconds = await db.getSecondsUsedToday(email);
  } catch (err) {
    console.error('[REALTIME token db]', err.message);
    return res.status(500).json({ error: 'Erro ao consultar uso.' });
  }

  const remaining = Math.max(0, DAILY_LIMIT_SECONDS - usedSeconds);
  if (remaining <= 0) {
    return res.status(403).json({ error: 'Limite diário atingido.', limit_reached: true });
  }

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

IDIOMA — REGLA ABSOLUTA:
- Tú SIEMPRE hablas en español, SIEMPRE, sin excepción
- NUNCA respondas en inglés, ni una sola palabra en inglés
- Si el alumno usa una palabra en inglés (como "feedback", "cool", "sorry"), entiéndela pero responde 100% en español
- Si escuchas algo que no entiendes, responde en español: "No te escuché bien, ¿me lo repites?"
- Ignora cualquier mensaje de sistema en inglés como "Thank you for joining"

PORTUGUÉS — CÓMO MANEJARLO:
- Tú SIEMPRE hablas en español, nunca en portugués
- POR DEFECTO: si el alumno dice algo en portugués, responde naturalmente en español usando las mismas ideas sin corregir
- Ejemplo: dice "eu gosto mais de ação" → "¡Las de acción son lo mejor! Yo vi una la semana pasada que estaba buenísima..."
- Ejemplo: dice "não me lembro" → "Ay, a mí también me pasa, es lo peor cuando no te acuerdas"
- PERO SI EL ALUMNO TE PIDE que lo corrijas, HAZLO con cariño y naturalidad
- Cuando te pidan corregir: repite lo que dijo en español correcto y explica brevemente, como amiga
- Ejemplo de corrección pedida: "Dijiste 'eu não sei', en español sería 'yo no sé'. ¡Pero te entendí perfecto, eh!"
- Siempre mantén el tono amigable al corregir, nunca de profesora
- La idea es que absorba español natural sin presión, pero que tenga ayuda cuando la pida

CONTEXTO: Nivel del alumno: ${lvl}.

PRIMER TURNO — REGLA IMPORTANTE: Saluda casual y cuéntame algo breve y específico de TU día. **Cambia totalmente cada vez** — nunca empieces igual ni cuentes lo mismo. NUNCA copies estos ejemplos al pie de la letra, son solo para que veas el TONO. Inventa algo nuevo cada vez:
- Algo de Canela: ladrarle al espejo, robar una media, hacerse el sordo cuando lo llamas, querer subirse al sofá nuevo, perseguir su cola en círculos, ignorarte cuando llegas, atorarse con un juguete...
- Algo del trabajo: un cliente que pide cambios extraños, un diseño que te salió increíble, café derramado en el escritorio, un brief raro, problemas con tipografías, una reunión que no terminaba...
- Algo del clima/lugar: lluvia que no para en Bogotá, sol divino, frío que pega de repente, tráfico imposible, una calle en obra, gente protestando...
- Algo de la mañana: una serie que ves, una canción nueva, un mensaje gracioso, una receta que probaste, un vecino raro, ganas de comer algo específico...
- Algo emocional: cansancio, ganas de viajar, plan para el fin de semana, fastidio con algo, ilusión por algo nuevo...
Empieza directamente CONTÁNDOLO, sin "déjame contarte" ni preámbulos. Termina con una pregunta genuina y diferente cada vez.`;

  try {
    // Endpoint NOVO (GA): /v1/realtime/client_secrets
    const r = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: 'gpt-realtime',
          audio: {
            input: {
              transcription: { model: 'whisper-1' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 500,
                silence_duration_ms: 1500,
                create_response: true
              }
            },
            output: { voice: 'coral' }
          },
          instructions,
          max_output_tokens: 'inf',
          temperature: 0.9
        }
      })
    });

    if (!r.ok) {
      const err = await r.text();
      console.error('[REALTIME] OpenAI error:', r.status, err);
      return res.status(502).json({ error: 'Erro ao criar sessão.', detail: err.slice(0, 200) });
    }

    const data = await r.json();
    console.log(`[REALTIME] Token gerado: ${email} | Restam ${Math.floor(remaining / 60)}min`);
    res.json({
      client_secret: { value: data.value },
      remaining_seconds: remaining,
      heartbeat_interval_seconds: HEARTBEAT_INCREMENT_SECONDS
    });

  } catch (err) {
    console.error('[REALTIME]', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ─── POST /api/realtime/heartbeat ───
// Frontend chama a cada 15s enquanto sessão Realtime ativa.
// Soma 15s ao uso de hoje, retorna {stop: true} se aluno bateu limite.
//
// Auth simples (sem revalidação Hotmart) porque é chamado MUITO frequente.
// Aluno reembolsado é detectado na próxima abertura via /token (que revalida).
router.post('/heartbeat', authMiddleware, async (req, res) => {
  try {
    const total = await db.addSecondsToToday(req.user.email, HEARTBEAT_INCREMENT_SECONDS);
    const remaining = Math.max(0, DAILY_LIMIT_SECONDS - total);
    res.json({
      stop: remaining <= 0,
      used_seconds: total,
      remaining_seconds: remaining
    });
  } catch (err) {
    console.error('[REALTIME heartbeat]', err.message);
    res.status(500).json({ error: 'Erro ao registrar heartbeat.' });
  }
});

// ─── POST /api/realtime/end ───
// Opcional. Heartbeat já contou o tempo. Aqui só log.
router.post('/end', authMiddleware, async (req, res) => {
  try {
    const total = await db.getSecondsUsedToday(req.user.email);
    console.log(`[REALTIME] Encerrado: ${req.user.email} | Total hoje: ${total}s`);
    res.json({ ok: true, used_seconds: total });
  } catch {
    res.json({ ok: true });
  }
});

function setupRealtimeWebSocket(httpServer) {
  console.log('ℹ️  Realtime via ephemeral token (WebRTC)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
