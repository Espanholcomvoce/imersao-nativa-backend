/**
 * IMERSÃO NATIVA - Servidor Principal
 * Express + WebSocket production-ready para Railway
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// ─────────────────────────────────────────────
// VALIDAÇÃO DE VARIÁVEIS CRÍTICAS
// ─────────────────────────────────────────────
const REQUIRED_VARS = ['JWT_SECRET', 'ANTHROPIC_API_KEY', 'ELEVENLABS_API_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.warn(`⚠️  Variáveis não configuradas: ${missing.join(', ')}`);
  console.warn('   Algumas funcionalidades podem não funcionar corretamente.');
}

// ─────────────────────────────────────────────
// SEGURANÇA
// ─────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// ─────────────────────────────────────────────
// CORS
// Permite o frontend Netlify + localhost para dev
// ─────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://imersaonativa.netlify.app',
  'https://imersao-nativa.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'https://app.espanholcomvoce.com',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Permite requests sem origin (apps mobile, Postman, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    callback(new Error(`CORS: origem não permitida: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// ─────────────────────────────────────────────
// PARSING E LOGGING
// ─────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ─────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────

// Limite geral da API
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' }
});

// Limite mais restrito para TTS (caro por chamada)
const ttsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hora
  max: 60,
  message: { error: 'Limite de geração de áudio atingido. Tente em 1 hora.' }
});

// Limite para login (evita brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Tente em 15 minutos.' }
});

app.use('/api/', apiLimiter);

// ─────────────────────────────────────────────
// ARQUIVOS ESTÁTICOS (MP3 dos exercícios)
// ─────────────────────────────────────────────
app.use('/audios', express.static(path.join(__dirname, 'public/audios'), {
  setHeaders: (res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=86400');
  }
}));

// ─────────────────────────────────────────────
// HEALTH CHECK
// Railway usa esse endpoint para saber se o app está vivo
// ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    services: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      hotmart: !!process.env.HOTMART_HOTTOK,
      jwt: !!process.env.JWT_SECRET
    }
  });
});

app.get('/', (req, res) => {
  res.json({
    app: 'Imersão Nativa API',
    status: 'online',
    version: '1.0.0',
    health: '/health',
    docs: 'https://github.com/Espanholcomvoce/imersao-nativa-backend'
  });
});

// ─────────────────────────────────────────────
// ROTAS DA API
// ─────────────────────────────────────────────
app.use('/api/login', loginLimiter, require('./routes/login'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/tts', ttsLimiter, require('./routes/tts'));
app.use('/api/realtime', require('./routes/realtime-conversation'));
app.use('/api/exam-audio', require('./routes/exam-audio'));

// ─────────────────────────────────────────────
// HANDLER DE ERROS GLOBAL
// ─────────────────────────────────────────────
app.use((err, req, res, next) => {
  // Log detalhado no servidor
  console.error(`[ERROR] ${req.method} ${req.path}`, {
    message: err.message,
    status: err.status || 500
  });

  // Erro de CORS
  if (err.message?.startsWith('CORS')) {
    return res.status(403).json({ error: err.message });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Erro interno do servidor.'
      : err.message
  });
});

// 404 para rotas não encontradas
app.use((req, res) => {
  res.status(404).json({
    error: `Rota não encontrada: ${req.method} ${req.path}`
  });
});

// ─────────────────────────────────────────────
// INICIALIZAÇÃO DO SERVIDOR
// ─────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      IMERSÃO NATIVA API - ONLINE         ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Porta:      ${String(PORT).padEnd(28)}║`);
  console.log(`║  Ambiente:   ${String(process.env.NODE_ENV || 'development').padEnd(28)}║`);
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Anthropic:  ${process.env.ANTHROPIC_API_KEY  ? '✅ configurado' : '❌ FALTANDO    '}              ║`);
  console.log(`║  ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? '✅ configurado' : '❌ FALTANDO    '}              ║`);
  console.log(`║  OpenAI:     ${process.env.OPENAI_API_KEY     ? '✅ configurado' : '❌ FALTANDO    '}              ║`);
  console.log(`║  Hotmart:    ${process.env.HOTMART_HOTTOK     ? '✅ configurado' : '❌ FALTANDO    '}              ║`);
  console.log(`║  JWT:        ${process.env.JWT_SECRET         ? '✅ configurado' : '❌ FALTANDO    '}              ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

// ─────────────────────────────────────────────
// WEBSOCKET REALTIME
// Anexa ao mesmo servidor HTTP
// ─────────────────────────────────────────────
const { setupRealtimeWebSocket } = require('./routes/realtime-conversation');
setupRealtimeWebSocket(server);

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// Railway envia SIGTERM antes de parar o container
// ─────────────────────────────────────────────
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM recebido — encerrando servidor...');
  server.close(() => {
    console.log('[SHUTDOWN] Servidor encerrado com sucesso.');
    process.exit(0);
  });
  // Força encerramento após 10s se não fechar antes
  setTimeout(() => process.exit(1), 10000);
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Exceção não capturada:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Promise não tratada:', reason);
  process.exit(1);
});

module.exports = app;
