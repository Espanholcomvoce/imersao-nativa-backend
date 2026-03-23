/**
 * IMERSÃO NATIVA - Rota de Login
 * Valida email via OAuth Hotmart (compra + assinatura ativa)
 *
 * FILTRO 1: Compra realizada (Sales API)
 * FILTRO 2: Assinatura ativa na área de membros (Subscriptions API)
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
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '7d';
const HOTMART_CLIENT_ID = process.env.HOTMART_CLIENT_ID;
const HOTMART_CLIENT_SECRET = process.env.HOTMART_CLIENT_SECRET;
const HOTMART_BASIC = process.env.HOTMART_BASIC;
const HOTMART_PRODUCT_ID = process.env.HOTMART_PRODUCT_ID;

// ─────────────────────────────────────────────
// Cache em memória — evita chamar Hotmart toda vez
// ─────────────────────────────────────────────
const accessCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutos

function getCached(email) {
  const entry = accessCache.get(email);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) {
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

// ─────────────────────────────────────────────
// Valida se email tem compra aprovada no Hotmart
// ─────────────────────────────────────────────
async function validateHotmart(email) {
  // 1. Verifica cache
  const cached = getCached(email);
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

  // 3. Consulta API Hotmart
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
    // Loga TUDO para ver a estrutura completa
    items.forEach((item, i) => {
      console.log(`[LOGIN] Item ${i}:`, JSON.stringify(item));
    });

    // Verifica se tem registro com BUYER no array users e transação válida
    // FILTRO 1: Verificar compra
    const hasPurchase = items.some(item => {
      const hasBuyer = (item.users || []).some(u =>
        (u.role || '').toUpperCase() === 'BUYER' &&
        (u.user?.email || '').toLowerCase() === email.toLowerCase()
      );
      console.log(`[LOGIN] transaction: "${item.transaction || 'N/A'}", hasBuyer: ${hasBuyer}`);
      return hasBuyer && !!item.transaction;
    });

    if (!hasPurchase) {
      setCache(email, false);
      console.log(`[LOGIN] ❌ Sem compra válida para ${email}`);
      return false;
    }

    // FILTRO 2: Verificar assinatura ativa na área de membros
    const isActive = await checkSubscriptionActive(token, email);

    setCache(email, isActive);
    console.log(`[LOGIN] Hotmart para ${email}: ${isActive ? '✅ compra + assinatura ativa' : '❌ compra OK mas assinatura inativa'}`);
    return isActive;

  } catch (err) {
    const status = err.response?.status;
    console.error(`[LOGIN] Erro Hotmart (${status}):`, err.message);

    // Credenciais inválidas — não deixa passar
    if (status === 401 || status === 403) {
      throw new Error('Erro de configuração do sistema. Contate o suporte.');
    }

    // Hotmart fora do ar — nega acesso por segurança, com mensagem amigável
    console.warn(`[LOGIN] Hotmart indisponível — negando acesso por segurança para ${email}`);
    throw new Error('Sistema temporariamente indisponível. Tente novamente em alguns minutos.');
  }
}

// ─────────────────────────────────────────────
// Verifica se email tem assinatura ATIVA
// (Subscriptions API — área de membros Hotmart)
// ─────────────────────────────────────────────
async function checkSubscriptionActive(hotmartToken, email) {
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
    const hasActiveSub = subs.length > 0;
    console.log(`[LOGIN] Assinaturas ativas para ${email}: ${subs.length}`);
    return hasActiveSub;

  } catch (err) {
    // Se a API de subscriptions falhar mas a compra foi confirmada,
    // pode ser produto de compra única (não recorrente) — permitir acesso
    const status = err.response?.status;
    if (status === 404 || status === 400) {
      // Produto pode ser compra única sem subscription — compra já validada acima
      console.log(`[LOGIN] Produto sem modelo de assinatura para ${email} — acesso via compra única`);
      return true;
    }
    console.error(`[LOGIN] Erro ao verificar assinatura (${status}):`, err.message);
    // Em caso de erro na API de subscriptions, confiar na compra já validada
    return true;
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
// ─────────────────────────────────────────────
router.get('/verify', authMiddleware, (req, res) => {
  res.json({
    valid: true,
    email: req.user.email,
    expires_at: new Date(req.user.exp * 1000).toISOString()
  });
});

module.exports = router;
