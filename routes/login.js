/**
 * IMERSÃO NATIVA - Rota de Login
 * Valida email no Hotmart e gera JWT
 * 
 * POST /api/login        → faz login
 * GET  /api/login/verify → verifica se o token ainda é válido
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';

// ─────────────────────────────────────────────
// Cache em memória para não chamar Hotmart toda vez
// Evita lentidão e rate limiting da API deles
// ─────────────────────────────────────────────
const subscriptionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos

function getCached(email) {
  const entry = subscriptionCache.get(email);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
    subscriptionCache.delete(email);
    return null;
  }
  return entry.hasAccess;
}

function setCache(email, hasAccess) {
  subscriptionCache.set(email, { hasAccess, timestamp: Date.now() });
}

// ─────────────────────────────────────────────
// Validação no Hotmart
// ─────────────────────────────────────────────
async function validateHotmart(email) {
  // 1. Verifica cache primeiro
  const cached = getCached(email);
  if (cached !== null) {
    console.log(`[LOGIN] Cache hit para ${email}: ${cached}`);
    return cached;
  }

  // 2. Verifica emails de demo (útil para testes)
  if (process.env.DEMO_EMAILS) {
    const demos = process.env.DEMO_EMAILS.split(',').map(e => e.trim().toLowerCase());
    if (demos.includes(email)) {
      console.log(`[LOGIN] Email demo: ${email}`);
      setCache(email, true);
      return true;
    }
  }

  // 3. Chama API do Hotmart
  try {
    const response = await axios.get(
      'https://developers.hotmart.com/payments/api/v1/subscriptions',
      {
        headers: {
          'Authorization': `Bearer ${HOTMART_HOTTOK}`,
          'Content-Type': 'application/json'
        },
        params: {
          subscriber_email: email,
          status: 'ACTIVE'
        },
        timeout: 10000
      }
    );

    const hasAccess = (response.data?.items?.length ?? 0) > 0;
    setCache(email, hasAccess);
    console.log(`[LOGIN] Hotmart para ${email}: ${hasAccess ? '✅ ativo' : '❌ sem acesso'}`);
    return hasAccess;

  } catch (err) {
    const status = err.response?.status;
    console.error(`[LOGIN] Erro Hotmart (${status}):`, err.message);

    // Se Hotmart retornar 401/403, a chave está errada — não deixa passar
    if (status === 401 || status === 403) {
      throw new Error('Erro de configuração do sistema de pagamentos.');
    }

    // Para outros erros (timeout, 5xx), deixa passar temporariamente
    // para não bloquear usuários por falha da Hotmart
    console.warn(`[LOGIN] Hotmart indisponível — permitindo acesso temporário para ${email}`);
    return true;
  }
}

// ─────────────────────────────────────────────
// POST /api/login
// Body: { email: "usuario@email.com" }
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { email } = req.body;

  // Validações básicas
  if (!email) {
    return res.status(400).json({ error: 'Email é obrigatório.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Formato de email inválido.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  try {
    const hasAccess = await validateHotmart(normalizedEmail);

    if (!hasAccess) {
      return res.status(403).json({
        error: 'Acesso não encontrado. Verifique se você tem uma assinatura ativa.',
        action: 'Acesse o Hotmart para verificar sua assinatura ou entre em contato com o suporte.'
      });
    }

    // Gera o token JWT
    const token = jwt.sign(
      { email: normalizedEmail },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN, algorithm: 'HS256' }
    );

    console.log(`[LOGIN] ✅ Login bem-sucedido: ${normalizedEmail}`);

    res.json({
      success: true,
      token,
      email: normalizedEmail,
      expires_in: JWT_EXPIRES_IN
    });

  } catch (err) {
    console.error('[LOGIN] Erro interno:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar login. Tente novamente.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/login/verify
// Verifica se o token atual ainda é válido
// Header: Authorization: Bearer <token>
// ─────────────────────────────────────────────
router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    valid: true,
    email: req.user.email,
    expires_at: new Date(req.user.exp * 1000).toISOString()
  });
});

module.exports = router;
