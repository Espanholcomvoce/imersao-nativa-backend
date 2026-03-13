/**
 * IMERSÃO NATIVA - Middleware de Autenticação JWT
 * Verifica o token em todas as rotas protegidas
 */

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET) {
  console.warn('⚠️  AVISO: JWT_SECRET não configurado nas variáveis de ambiente!');
}

/**
 * authMiddleware
 * Uso: router.get('/rota', authMiddleware, (req, res) => { ... })
 * Após passar, req.user contém { email, iat, exp }
 */
function authMiddleware(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader) {
    return res.status(401).json({
      error: 'Token não fornecido. Faça login primeiro.'
    });
  }

  // Aceita formato "Bearer <token>" ou apenas "<token>"
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  if (!token) {
    return res.status(401).json({ error: 'Token inválido' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // { email, iat, exp }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Sessão expirada. Faça login novamente.',
        code: 'TOKEN_EXPIRED'
      });
    }
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Token inválido.',
        code: 'TOKEN_INVALID'
      });
    }
    return res.status(401).json({ error: 'Erro de autenticação.' });
  }
}

/**
 * optionalAuth
 * Usa em rotas que funcionam com ou sem login
 * Se tiver token válido, popula req.user. Se não, continua normalmente.
 */
function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return next();

  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7).trim()
    : authHeader.trim();

  try {
    req.user = jwt.verify(token, JWT_SECRET);
  } catch {
    // Token inválido ou ausente — continua sem usuário
  }
  next();
}

module.exports = { authMiddleware, optionalAuth };
