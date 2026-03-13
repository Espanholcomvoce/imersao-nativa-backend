/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * WebSocket → OpenAI Realtime API
 *
 * Usuário fala (português ou espanhol)
 * → Claude/GPT responde em espanhol
 * → Limite: 15 min/dia por usuário
 *
 * GET /api/realtime/status  → minutos restantes do dia
 * WS  /api/realtime/ws      → conexão WebSocket
 */

const express = require('express');
const router = express.Router();
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const DAILY_LIMIT_MINUTES = parseInt(process.env.REALTIME_DAILY_MINUTES || '15');

// ─────────────────────────────────────────────
// TRACKING DE USO EM MEMÓRIA
// Reseta automaticamente a cada novo dia
// Estrutura: email → { date: 'YYYY-MM-DD', seconds: N }
// ─────────────────────────────────────────────
const usageMap = new Map();

function getToday() {
  return new Date().toISOString().split('T')[0]; // 'YYYY-MM-DD'
}

function getUsage(email) {
  const today = getToday();
  let usage = usageMap.get(email);

  // Se não existe ou é de outro dia, reseta
  if (!usage || usage.date !== today) {
    usage = { date: today, seconds: 0 };
    usageMap.set(email, usage);
  }
  return usage;
}

function getRemainingSeconds(email) {
  const usage = getUsage(email);
  const limitSeconds = DAILY_LIMIT_MINUTES * 60;
  return Math.max(0, limitSeconds - usage.seconds);
}

function addUsageSeconds(email, seconds) {
  const usage = getUsage(email);
  usage.seconds += Math.max(0, seconds);
  usageMap.set(email, usage);
}

// ─────────────────────────────────────────────
// GET /api/realtime/status
// Retorna quanto tempo o usuário ainda tem hoje
// Header: Authorization: Bearer <token>
// ─────────────────────────────────────────────
router.get('/status', (req, res) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(401).json({ error: 'Token necessário.' });
  }

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const remaining = getRemainingSeconds(decoded.email);
    const usage = getUsage(decoded.email);

    res.json({
      email: decoded.email,
      daily_limit_minutes: DAILY_LIMIT_MINUTES,
      used_seconds: usage.seconds,
      used_minutes: Math.floor(usage.seconds / 60),
      remaining_seconds: remaining,
      remaining_minutes: Math.floor(remaining / 60),
      limit_reached: remaining === 0
    });
  } catch {
    res.status(401).json({ error: 'Token inválido.' });
  }
});

// ─────────────────────────────────────────────
// SETUP WEBSOCKET SERVER
// Chamado em server.js após criar o servidor HTTP
// ─────────────────────────────────────────────
function setupRealtimeWebSocket(httpServer) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: '/api/realtime/ws'
  });

  console.log('🎙️  WebSocket Realtime ativo em /api/realtime/ws');

  wss.on('connection', async (clientWs, req) => {
    // ── 1. AUTENTICAÇÃO via query param ──────────────
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');

    if (!token) {
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'NO_TOKEN',
        message: 'Token não fornecido.'
      }));
      clientWs.close(4001, 'Token não fornecido');
      return;
    }

    let userEmail;
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      userEmail = decoded.email;
    } catch {
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'INVALID_TOKEN',
        message: 'Token inválido ou expirado.'
      }));
      clientWs.close(4001, 'Token inválido');
      return;
    }

    // ── 2. VERIFICA LIMITE DIÁRIO ─────────────────────
    const remaining = getRemainingSeconds(userEmail);

    if (remaining <= 0) {
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'LIMIT_EXCEEDED',
        message: `Você atingiu o limite de ${DAILY_LIMIT_MINUTES} minutos por dia. Volte amanhã!`
      }));
      clientWs.close(4002, 'Limite diário atingido');
      return;
    }

    console.log(`[REALTIME] Conectando: ${userEmail} | Restam: ${Math.floor(remaining / 60)}min ${remaining % 60}s`);

    // ── 3. CONECTA AO OPENAI REALTIME ────────────────
    let openaiWs;
    try {
      openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01',
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );
    } catch (err) {
      console.error('[REALTIME] Erro ao conectar OpenAI:', err.message);
      clientWs.send(JSON.stringify({
        type: 'error',
        code: 'SERVICE_UNAVAILABLE',
        message: 'Serviço de voz temporariamente indisponível.'
      }));
      clientWs.close(1011, 'Erro interno');
      return;
    }

    // ── 4. TRACKING DE TEMPO DA SESSÃO ───────────────
    const sessionStart = Date.now();
    let limitTimer = null;
    let isClosing = false;

    // Timer que encerra a sessão quando o limite for atingido
    limitTimer = setTimeout(() => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'limit_warning',
          message: 'Seus minutos diários acabaram. A conversa será encerrada automaticamente.'
        }));
        setTimeout(() => {
          clientWs.close(4002, 'Limite de tempo atingido');
        }, 2000);
      }
    }, remaining * 1000);

    // ── 5. CONFIGURA A SESSÃO OPENAI ─────────────────
    openaiWs.on('open', () => {
      const sessionConfig = {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions: `Você é um professor de espanhol para brasileiros chamado Sofía.

SUAS REGRAS:
1. O usuário pode falar em PORTUGUÊS ou ESPANHOL
2. Você deve responder SEMPRE em ESPANHOL claro e natural
3. Se o usuário falar em português, entenda e responda em espanhol
4. Se o usuário cometer erros em espanhol, corrija gentilmente na sua resposta
5. Tom: amigável, paciente, encorajador
6. Respostas: curtas e naturais (como conversa real)
7. Vocabulário: adequado ao nível intermediário

Exemplos:
- Usuário diz "Hoje está bonito" → Você responde "¡Sí, hoy hace muy buen tiempo! ¿Te gusta el clima de tu ciudad?"
- Usuário diz "Yo fue al mercado" → Você responde "¡Qué bien! Yo *fui* al mercado también. ¿Qué compraste?"`,
          voice: 'shimmer',
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          input_audio_transcription: {
            model: 'whisper-1'
          },
          turn_detection: {
            type: 'server_vad',
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 800
          },
          temperature: 0.8,
          max_response_output_tokens: 200
        }
      };

      openaiWs.send(JSON.stringify(sessionConfig));

      // Avisa o cliente que está pronto
      clientWs.send(JSON.stringify({
        type: 'session_ready',
        remaining_seconds: remaining,
        remaining_minutes: Math.floor(remaining / 60),
        message: '¡Hola! Soy Sofía, tu profesora de español. Puedes hablarme en portugués o en español. ¿De qué quieres hablar hoy?'
      }));

      console.log(`[REALTIME] ✅ Sessão pronta para ${userEmail}`);
    });

    // ── 6. PROXY BIDIRECIONAL ─────────────────────────
    // Cliente → OpenAI
    clientWs.on('message', (data) => {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(data);
      }
    });

    // OpenAI → Cliente
    openaiWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data);
      }
    });

    // ── 7. HANDLER DE ERROS ───────────────────────────
    openaiWs.on('error', (err) => {
      console.error(`[REALTIME] Erro OpenAI para ${userEmail}:`, err.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          code: 'OPENAI_ERROR',
          message: 'Erro no serviço de voz. Tente reconectar.'
        }));
      }
    });

    // ── 8. CLEANUP AO FECHAR ──────────────────────────
    function cleanup(source) {
      if (isClosing) return;
      isClosing = true;

      clearTimeout(limitTimer);

      const sessionSeconds = Math.floor((Date.now() - sessionStart) / 1000);
      addUsageSeconds(userEmail, sessionSeconds);

      console.log(`[REALTIME] Sessão encerrada (${source}): ${userEmail} | Duração: ${sessionSeconds}s | Total hoje: ${getUsage(userEmail).seconds}s`);

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close(1000, 'Sessão encerrada');
      }
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1000, 'Sessão encerrada');
      }
    }

    openaiWs.on('close', () => cleanup('openai'));
    clientWs.on('close', () => cleanup('client'));
  });

  return wss;
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
