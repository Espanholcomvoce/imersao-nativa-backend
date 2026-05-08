/**
 * IMERSÃO NATIVA - Middleware de Autenticação JWT
 * Verifica o token em todas as rotas protegidas
 *
 * Exporta:
 * - authMiddleware: valida só JWT (use em rotas leves)
 * - authWithRevalidation: valida JWT + revalida Hotmart com cache 5min (use em endpoints caros)
 * - optionalAuth: popula req.user se houver token válido, sem bloquear
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️  AVISO: JWT_SECRET não configurado nas variáveis de ambiente!');
}

function extractToken(req) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return null;
  return authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();
}

function verifyJwt(token) {
  if (!token) {
    return { status: 401, error: 'Token não fornecido. Faça login primeiro.' };
  }
  try {
    return { user: jwt.verify(token, JWT_SECRET) };
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return { status: 401, error: 'Sessão expirada. Faça login novamente.', code: 'TOKEN_EXPIRED' };
    }
    if (err.name === 'JsonWebTokenError') {
      return { status: 401, error: 'Token inválido.', code: 'TOKEN_INVALID' };
    }
    return { status: 401, error: 'Erro de autenticação.' };
  }
}

/**
 * authMiddleware
 * Uso: router.get('/rota', authMiddleware, (req, res) => { ... })
 * Após passar, req.user contém { email, iat, exp }
 *
 * Valida só JWT (rápido). Não revalida Hotmart — usar authWithRevalidation
 * em endpoints que disparam custo OpenAI ou expõem conteúdo pago.
 */
function authMiddleware(req, res, next) {
  const result = verifyJwt(extractToken(req));
  if (result.error) {
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  req.user = result.user;
  next();
}

/**
 * optionalAuth
 * Usa em rotas que funcionam com ou sem login.
 * Se tiver token válido, popula req.user. Se não, continua normalmente.
 */
function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  const result = verifyJwt(token);
  if (result.user) req.user = result.user;
  next();
}

// Lazy require para evitar dependência circular com routes/login.js
let _validateHotmart = null;
function getValidateHotmart() {
  if (!_validateHotmart) {
    _validateHotmart = require('../routes/login').validateHotmart;
  }
  return _validateHotmart;
}

const REVALIDATE_CACHE_TTL = 5 * 60 * 1000; // 5 min — equilíbrio entre segurança e custo Hotmart API

/**
 * authWithRevalidation
 * Use em endpoints CAROS (que disparam custo OpenAI ou expõem conteúdo pago):
 *   - /api/conversa/chat, /api/conversa/whisper, /api/conversa/tts
 *   - /api/realtime/token
 *   - /api/chat/* (Tira Dúvidas)
 *
 * Valida JWT + revalida acesso no Hotmart com cache de 5min.
 * Se aluno pediu reembolso/cancelamento, é bloqueado em ≤5min nessas chamadas.
 *
 * Em caso de Hotmart fora do ar, bloqueia (política conservadora).
 * O cache de 5min cobre outages curtos automaticamente.
 */
async function authWithRevalidation(req, res, next) {
  const result = verifyJwt(extractToken(req));
  if (result.error) {
    return res.status(result.status).json({ error: result.error, code: result.code });
  }
  req.user = result.user;

  try {
    const validateHotmart = getValidateHotmart();
    const hasAccess = await validateHotmart(req.user.email, REVALIDATE_CACHE_TTL);
    if (!hasAccess) {
      console.log(`[AUTH] ❌ Acesso revogado para ${req.user.email} em endpoint protegido`);
      return res.status(403).json({
        error: 'Seu acesso foi encerrado. Verifique o status da sua compra na Hotmart.',
        code: 'ACCESS_REVOKED'
      });
    }
    next();
  } catch (err) {
    console.warn(`[AUTH] Hotmart indisponível para ${req.user.email} — negando acesso por segurança`);
    return res.status(503).json({
      error: 'Sistema temporariamente indisponível. Tente novamente em alguns minutos.',
      code: 'HOTMART_UNAVAILABLE'
    });
  }
}

module.exports = { authMiddleware, authWithRevalidation, optionalAuth };
