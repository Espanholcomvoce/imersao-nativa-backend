/**
 * IMERSÃO NATIVA - Rota de Login
 * Valida email via OAuth Hotmart (dupla verificação)
 *
 * FILTRO 1: Compra aprovada (Sales API) — status APPROVED/COMPLETE
 *           Bloqueia se REFUNDED/CANCELLED/CHARGEBACK
 * FILTRO 2: Membro ATIVO na área de membros (Subscriptions API)
 *           Bloqueia se inativo/cancelado
 *
 * POST /api/login        → faz login (valida ambos filtros)
 * GET  /api/login/verify → RE-VALIDA ambos filtros a cada abertura do app
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30m';
const HOTMART_CLIENT_ID = process.env.HOTMART_CLIENT_ID;
const HOTMART_CLIENT_SECRET = process.env.HOTMART_CLIENT_SECRET;
const HOTMART_BASIC = process.env.HOTMART_BASIC;
const HOTMART_PRODUCT_ID = process.env.HOTMART_PRODUCT_ID;

// ─────────────────────────────────────────────
// Cache em memória — evita chamar Hotmart toda vez
// TTL curto para verify (2 min) e normal para login (10 min)
// ─────────────────────────────────────────────
const accessCache = new Map();
const knownLoggedInEmails = new Set(); // emails que ja logaram pelo menos 1x (primeiro login pula Filtro 2)
const CACHE_TTL_LOGIN = 10 * 60 * 1000;  // 10 minutos (login)
const CACHE_TTL_VERIFY = 2 * 60 * 1000;  // 2 minutos (verify — checa mais frequente)

function getCached(email, ttl = CACHE_TTL_LOGIN) {
  const entry = accessCache.get(email);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) {
    accessCache.delete(email);
    return null;
  }
  return entry.hasAccess;
}

function setCache(email, hasAccess) {
  accessCache.set(email, { hasAccess, timestamp: Date.now() });
}

// ─────────────────────────────────────────────
// Gera token OAuth do Hotmart
// ─────────────────────────────────────────────
let hotmartTokenCache = null;

async function getHotmartToken() {
  // Reutiliza token se ainda válido (expira em 1h, renova com 5min de margem)
  if (hotmartTokenCache && hotmartTokenCache.expiresAt > Date.now() + 5 * 60 * 1000) {
    return hotmartTokenCache.token;
  }

  const response = await axios.post(
    'https://api-sec-vlc.hotmart.com/security/oauth/token',
    `grant_type=client_credentials&client_id=${HOTMART_CLIENT_ID}&client_secret=${HOTMART_CLIENT_SECRET}`,
    {
      headers: {
        'Authorization': `Basic ${HOTMART_BASIC}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      timeout: 10000
    }
  );

  hotmartTokenCache = {
    token: response.data.access_token,
    expiresAt: Date.now() + (response.data.expires_in * 1000)
  };

  console.log('[LOGIN] Token Hotmart gerado com sucesso');
  return hotmartTokenCache.token;
}

// Status Hotmart que indicam acesso válido (compra única)
const VALID_PURCHASE_STATUSES = ['APPROVED', 'COMPLETE', 'COMPLETED'];
// Status que indicam reembolso/cancelamento
const BLOCKED_STATUSES = ['REFUNDED', 'CANCELLED', 'CHARGEBACK', 'EXPIRED', 'DELAYED'];

// ─────────────────────────────────────────────
// Valida se email tem compra aprovada no Hotmart
// cacheTTL permite usar cache mais curto no verify
// ─────────────────────────────────────────────
async function validateHotmart(email, cacheTTL = CACHE_TTL_LOGIN) {
  // 1. Verifica cache
  const cached = getCached(email, cacheTTL);
  if (cached !== null) {
    console.log(`[LOGIN] Cache hit para ${email}: ${cached}`);
    return cached;
  }

  // 2. Emails de demo (para testes)
  if (process.env.DEMO_EMAILS) {
    const demos = process.env.DEMO_EMAILS.split(',').map(e => e.trim().toLowerCase());
    if (demos.includes(email)) {
      console.log(`[LOGIN] Email demo: ${email}`);
      setCache(email, true);
      return true;
    }
  }

  // 3. Consulta API Hotmart — Sales
  try {
    const token = await getHotmartToken();

    const response = await axios.get(
      'https://developers.hotmart.com/payments/api/v1/sales/users',
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        params: {
          buyer_email: email,
          product_id: HOTMART_PRODUCT_ID
        },
        timeout: 10000
      }
    );

    const items = response.data?.items || [];
    console.log(`[LOGIN] Total registros para ${email}: ${items.length}`);

    // Verifica se tem compra APROVADA (não reembolsada)
    const hasValidPurchase = items.some(item => {
      const hasBuyer = (item.users || []).some(u =>
        (u.role || '').toUpperCase() === 'BUYER' &&
        (u.user?.email || '').toLowerCase() === email.toLowerCase()
      );

      // Verificar status da compra (purchase.status)
      const purchaseStatus = (item.purchase?.status || '').toUpperCase();
      const isValid = VALID_PURCHASE_STATUSES.includes(purchaseStatus);
      const isBlocked = BLOCKED_STATUSES.includes(purchaseStatus);

      console.log(`[LOGIN] transaction: "${item.transaction || 'N/A'}", status: "${purchaseStatus}", hasBuyer: ${hasBuyer}, valid: ${isValid}, blocked: ${isBlocked}`);

      return hasBuyer && !!item.transaction && isValid && !isBlocked;
    });

    // Verificar se alguma compra foi reembolsada (para log)
    const hasRefund = items.some(item => {
      const status = (item.purchase?.status || '').toUpperCase();
      return BLOCKED_STATUSES.includes(status);
    });

    if (hasRefund && !hasValidPurchase) {
      console.log(`[LOGIN] ❌ Compra REEMBOLSADA/CANCELADA para ${email}`);
    }

    if (!hasValidPurchase) {
      setCache(email, false);
      console.log(`[LOGIN] ❌ Sem compra válida para ${email}`);
      return false;
    }

    // FILTRO 2: Verificar se está ATIVO na área de membros Hotmart
    const isActive = await checkMemberActive(token, email);

    const finalAccess = hasValidPurchase && isActive;
    setCache(email, finalAccess);
    console.log(`[LOGIN] Hotmart para ${email}: ${finalAccess ? '✅ compra válida + membro ativo' : '❌ compra OK mas membro INATIVO'}`);
    return finalAccess;

  } catch (err) {
    const status = err.response?.status;
    console.error(`[LOGIN] Erro Hotmart (${status}):`, err.message);

    if (status === 401 || status === 403) {
      throw new Error('Erro de configuração do sistema. Contate o suporte.');
    }

    console.warn(`[LOGIN] Hotmart indisponível — negando acesso por segurança para ${email}`);
    throw new Error('Sistema temporariamente indisponível. Tente novamente em alguns minutos.');
  }
}

// ─────────────────────────────────────────────
// FILTRO 2: Verifica se membro está ATIVO na Hotmart
// Retorna false se inativo/cancelado (NÃO mais "return true" como fallback)
// ─────────────────────────────────────────────
async function checkMemberActive(hotmartToken, email) {
  // Se e a primeira vez que este email loga, pula Filtro 2 (permite aluna nova
  // entrar antes da Hotmart propagar status de membro). A partir do 2o login,
  // Filtro 2 e aplicado normalmente para detectar revogacao manual de acesso.
  if (!knownLoggedInEmails.has(email)) {
    console.log(`[LOGIN] Primeiro login detectado — Filtro 2 pulado para ${email}`);
    knownLoggedInEmails.add(email); // marca que este email ja logou uma vez — proximo login aplica Filtro 2
    return true;
  }

  try {
    const response = await axios.get(
      'https://developers.hotmart.com/payments/api/v1/subscriptions',
      {
        headers: {
          'Authorization': `Bearer ${hotmartToken}`,
          'Content-Type': 'application/json'
        },
        params: {
          subscriber_email: email,
          product_id: HOTMART_PRODUCT_ID,
          status: 'ACTIVE'
        },
        timeout: 10000
      }
    );

    const subs = response.data?.items || [];
    console.log(`[LOGIN] Membros ativos para ${email}: ${subs.length}`);

    if (subs.length > 0) {
      return true; // Membro ativo
    }

    // Sem membro ativo — bloquear acesso
    console.log(`[LOGIN] ❌ Membro INATIVO para ${email} — acesso bloqueado`);
    return false;

  } catch (err) {
    const status = err.response?.status;

    // 404 = produto sem modelo de assinatura (improvável, mas possível)
    if (status === 404) {
      console.log(`[LOGIN] Produto sem modelo de membros para ${email} — permitindo via compra`);
      return true;
    }

    // Qualquer outro erro — negar por segurança
    console.error(`[LOGIN] Erro ao verificar membro ativo (${status}):`, err.message);
    throw new Error('Erro ao verificar status de membro. Tente novamente.');
  }
}

// ─────────────────────────────────────────────
// POST /api/login
// Body: { email: "usuario@email.com" }
// ─────────────────────────────────────────────
router.post('/', async (req, res) => {
  const { email } = req.body;

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
        error: 'Acesso não autorizado. Verifique se você adquiriu o Programa Imersão Nativa e se sua assinatura está ativa.',
        action: 'Acesse a área de membros da Hotmart para verificar seu status ou entre em contato com o suporte.'
      });
    }

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
// Header: Authorization: Bearer <token>
// RE-VALIDA acesso no Hotmart a cada abertura do app
// Se aluno pediu reembolso, bloqueia imediatamente
// ─────────────────────────────────────────────
router.get('/verify', authMiddleware, async (req, res) => {
  const email = req.user.email;

  try {
    // Re-validar no Hotmart (cache curto de 2 min)
    const hasAccess = await validateHotmart(email, CACHE_TTL_VERIFY);

    if (!hasAccess) {
      console.log(`[VERIFY] ❌ Acesso revogado para ${email} — compra reembolsada/cancelada`);
      return res.status(403).json({
        valid: false,
        error: 'Seu acesso foi encerrado. Verifique o status da sua compra na Hotmart.',
        code: 'ACCESS_REVOKED'
      });
    }

    console.log(`[VERIFY] ✅ Acesso confirmado para ${email}`);
    res.json({
      valid: true,
      email,
      expires_at: new Date(req.user.exp * 1000).toISOString()
    });

  } catch (err) {
    // Hotmart indisponível — NÃO permitir acesso, forçar re-login
    console.warn(`[VERIFY] Hotmart indisponível para ${email} — negando acesso por segurança`);
    res.status(503).json({
      valid: false,
      error: 'Sistema temporariamente indisponível. Tente novamente em alguns minutos.',
      code: 'HOTMART_UNAVAILABLE'
    });
  }
});

module.exports = router;
