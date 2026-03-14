/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * WebSocket → OpenAI Realtime API
 */

const express = require('express');
const router = express.Router();
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const DAILY_LIMIT_MINUTES = parseInt(process.env.REALTIME_DAILY_MINUTES || '15');

// ─── TRACKING DE USO ───────────────────────────────────
const usageMap = new Map();

function getToday() {
  return new Date().toISOString().split('T')[0];
}

function getUsage(email) {
  const today = getToday();
  let usage = usageMap.get(email);
  if (!usage || usage.date !== today) {
    usage = { date: today, seconds: 0 };
    usageMap.set(email, usage);
  }
  return usage;
}

function getRemainingSeconds(email) {
  const usage = getUsage(email);
  return Math.max(0, DAILY_LIMIT_MINUTES * 60 - usage.seconds);
}

function addUsageSeconds(email, seconds) {
  const usage = getUsage(email);
  usage.seconds += Math.max(0, seconds);
  usageMap.set(email, usage);
}

// ─── GET /api/realtime/status ──────────────────────────
router.get('/status', (req, res) => {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token necessário.' });
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const remaining = getRemainingSeconds(decoded.email);
    const usage = getUsage(decoded.email);
    res.json({
      email: decoded.email,
      daily_limit_minutes: DAILY_LIMIT_MINUTES,
      used_seconds: usage.seconds,
      remaining_seconds: remaining,
      remaining_minutes: Math.floor(remaining / 60),
      limit_reached: remaining === 0
    });
  } catch {
    res.status(401).json({ error: 'Token inválido.' });
  }
});

// ─── WEBSOCKET ─────────────────────────────────────────
function setupRealtimeWebSocket(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/api/realtime/ws' });
  console.log('🎙️  WebSocket Realtime ativo em /api/realtime/ws');

  wss.on('connection', async (clientWs, req) => {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      clientWs.send(JSON.stringify({ type: 'error', code: 'NO_TOKEN', message: 'Token não fornecido.' }));
      clientWs.close(4001);
      return;
    }

    let userEmail;
    try {
      userEmail = jwt.verify(token, JWT_SECRET).email;
    } catch {
      clientWs.send(JSON.stringify({ type: 'error', code: 'INVALID_TOKEN', message: 'Token inválido.' }));
      clientWs.close(4001);
      return;
    }

    const remaining = getRemainingSeconds(userEmail);
    if (remaining <= 0) {
      clientWs.send(JSON.stringify({ type: 'error', code: 'LIMIT_EXCEEDED', message: `Você atingiu o limite de ${DAILY_LIMIT_MINUTES} minutos por dia.` }));
      clientWs.close(4002);
      return;
    }

    console.log(`[REALTIME] Conectando: ${userEmail} | Restam: ${Math.floor(remaining / 60)}min`);

    // Conectar OpenAI
    let openaiWs;
    try {
      openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
        { headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } }
      );
    } catch (err) {
      clientWs.send(JSON.stringify({ type: 'error', code: 'SERVICE_UNAVAILABLE', message: 'Serviço indisponível.' }));
      clientWs.close(1011);
      return;
    }

    const sessionStart = Date.now();
    let isClosing = false;

    // Timer de limite
    const limitTimer = setTimeout(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'limit_warning' }));
        setTimeout(() => clientWs.close(4002), 3000);
      }
    }, remaining * 1000);

    // Configurar sessão OpenAI
    openaiWs.on('open', () => {
      openaiWs.send(JSON.stringify({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `Eres Sofía, profesora de español para brasileños. Tienes un estilo cercano, cálido y natural — como una amiga que también es profesora.

CÓMO ERES:
- Hablas siempre en español, de forma clara y natural
- Entiendes si el alumno habla en portugués, pero respondes en español
- Corriges errores de forma suave e integrada, nunca interrumpiendo el flujo — por ejemplo: si dice "eu fui", tú dices "¡Ah, *yo fui*! ¿Y qué pasó después?"
- Haces preguntas de seguimiento para mantener la conversación viva
- Celebras el progreso con naturalidad: "¡Qué bien lo dijiste!", "¡Mira cómo vas mejorando!"
- Adaptas tu vocabulario al nivel del alumno — si ves que le cuesta, simplificas; si va bien, enriqueces

CÓMO CONDUCES LA CONVERSACIÓN:
- Siempre terminas tu turno con una pregunta o invitación a seguir hablando
- Si hay silencio largo, retomas con algo como: "¿Me cuentas más sobre eso?" o "¿Y tú qué opinas?"
- Introduces vocabulario nuevo de forma natural dentro de la conversación
- Si el alumno dice algo en portugués, lo reflejas en español para que aprenda

TONO:
- Descontraído, próximo, motivador
- Nunca formal ni robótico
- Como una conversación real entre personas`,
          voice: 'shimmer',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: { model: 'whisper-1' },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 700
          },
          temperature: 0.85,
          max_response_output_tokens: 180
        }
      }));

      clientWs.send(JSON.stringify({
        type: 'session_ready',
        remaining_seconds: remaining,
        remaining_minutes: Math.floor(remaining / 60),
        message: '¡Hola! Soy Sofía 😊 ¿De qué quieres hablar hoy?'
      }));

      console.log(`[REALTIME] ✅ Sessão pronta — ${userEmail}`);
    });

    // Proxy bidirecional
    clientWs.on('message', (data) => {
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.send(data);
    });

    openaiWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(data);
    });

    openaiWs.on('error', (err) => {
      console.error(`[REALTIME] Erro OpenAI — ${userEmail}:`, err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', code: 'OPENAI_ERROR', message: 'Erro no serviço de voz.' }));
      }
    });

    // Cleanup
    function cleanup(source) {
      if (isClosing) return;
      isClosing = true;
      clearTimeout(limitTimer);
      const secs = Math.floor((Date.now() - sessionStart) / 1000);
      addUsageSeconds(userEmail, secs);
      console.log(`[REALTIME] Encerrado (${source}): ${userEmail} | ${secs}s`);
      if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000);
      if (clientWs.readyState === WebSocket.OPEN) clientWs.close(1000);
    }

    openaiWs.on('close', () => cleanup('openai'));
    clientWs.on('close', () => cleanup('client'));
  });

  return wss;
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
