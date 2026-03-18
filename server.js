require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3001;

// Trust proxy — necessário no Railway para rate limiter funcionar
app.set('trust proxy', 1);

const REQUIRED_VARS = ['JWT_SECRET', 'ANTHROPIC_API_KEY'];
const missing = REQUIRED_VARS.filter(v => !process.env[v]);
if (missing.length > 0) {
  console.warn(`⚠️  Variáveis não configuradas: ${missing.join(', ')}`);
}

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

const allowedOrigins = [
  process.env.FRONTEND_URL,
  'https://imersaonativa.netlify.app',
  'https://imersao-nativa.netlify.app',
  'http://localhost:3000',
  'http://localhost:5500',
  'http://127.0.0.1:5500',
  'http://localhost:8080',
  'https://app.espanholcomvoce.com',
  'https://imersao-nativa.espanholcvfaixapreta.workers.dev',
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    console.warn(`[CORS] Origem bloqueada: ${origin}`);
    callback(new Error(`CORS: origem não permitida: ${origin}`));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas requisições. Tente novamente em 15 minutos.' }
});

const ttsLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 60,
  message: { error: 'Limite de geração de áudio atingido. Tente em 1 hora.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Muitas tentativas de login. Tente em 15 minutos.' }
});

app.use('/api/', apiLimiter);

app.use('/audios', express.static(path.join(__dirname, 'public/audios'), {
  setHeaders: (res) => {
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.set('Cache-Control', 'public, max-age=86400');
  }
}));

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: '2.0.0',
    services: {
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      openai: !!process.env.OPENAI_API_KEY,
      jwt: !!process.env.JWT_SECRET
    }
  });
});

app.get('/', (req, res) => {
  res.json({ app: 'Imersão Nativa API', status: 'online', version: '2.0.0' });
});

app.use('/api/login', loginLimiter, require('./routes/login'));
app.use('/api/chat', require('./routes/chat'));
app.use('/api/tts', ttsLimiter, require('./routes/tts'));
app.use('/api/realtime', require('./routes/realtime-conversation'));
app.use('/api/conversa', require('./routes/conversa'));
app.use('/api/conversa', require('./routes/conversa'));
app.use('/api/exam-audio', require('./routes/exam-audio'));

app.use((err, req, res, next) => {
  console.error(`[ERROR] ${req.method} ${req.path}`, err.message);
  if (err.message?.startsWith('CORS')) return res.status(403).json({ error: err.message });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: process.env.NODE_ENV === 'production' ? 'Erro interno.' : err.message });
});

app.use((req, res) => {
  res.status(404).json({ error: `Rota não encontrada: ${req.method} ${req.path}` });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║      IMERSÃO NATIVA API v2 - ONLINE      ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  Porta:    ${String(PORT).padEnd(30)}║`);
  console.log(`║  OpenAI:   ${process.env.OPENAI_API_KEY ? '✅ configurado' : '❌ FALTANDO'}                  ║`);
  console.log(`║  JWT:      ${process.env.JWT_SECRET ? '✅ configurado' : '❌ FALTANDO'}                  ║`);
  console.log('╚══════════════════════════════════════════╝');
  console.log('');
});

const { setupRealtimeWebSocket } = require('./routes/realtime-conversation');
setupRealtimeWebSocket(server);

process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] Encerrando...');
  server.close(() => { process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
});

process.on('uncaughtException', (err) => { console.error('[FATAL]', err); process.exit(1); });
process.on('unhandledRejection', (reason) => { console.error('[FATAL]', reason); process.exit(1); });

module.exports = app;
