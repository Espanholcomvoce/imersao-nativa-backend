/**
 * ESPANHOL ESSENCIAL PARA VIAGENS — Rota de acesso por produto
 *
 * ⚠️ Esta rota é NOVA e ISOLADA. Ela não altera nem importa nada de
 * routes/login.js. O caminho que a Imersão Nativa usa hoje
 * (POST /api/login) continua exatamente como está.
 *
 * A diferença para o login antigo: aqui o token carrega a LISTA de
 * produtos que aquele e-mail comprou, não só o e-mail. É isso que
 * permite que cada produto tenha o seu próprio cadeado e que comprar
 * um nunca libere outro.
 *
 *   POST /api/viagens/login         → login do app de Viagens
 *   GET  /api/viagens/login/verify  → revalida a cada abertura do app
 *
 * Quando existir a plataforma mãe, é ela que passa a emitir o token
 * com esse mesmo formato. Os apps não mudam.
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

/**
 * Catálogo de produtos. A chave é o nome usado pelos apps; o valor é o
 * product_id da Hotmart. Produto sem variável configurada simplesmente
 * não é consultado e sai como false, então dá para ligar um de cada vez.
 */
const PRODUTOS = {
  imersao:   process.env.HOTMART_PRODUCT_ID,
  viagens:   process.env.HOTMART_PRODUCT_ID_VIAGENS,
  negocios:  process.env.HOTMART_PRODUCT_ID_NEGOCIOS,
  deleSiele: process.env.HOTMART_PRODUCT_ID_DELE,
  pronuncia: process.env.HOTMART_PRODUCT_ID_PRONUNCIA
};

/** Produto que esta rota exige para deixar entrar. */
const PRODUTO_DESTA_ROTA = 'viagens';

// ─────────────────────────────────────────────
// Cache próprio, separado do cache do login antigo
// ─────────────────────────────────────────────
const cacheAcessos = new Map();
const TTL_LOGIN = 10 * 60 * 1000;
const TTL_VERIFY = 2 * 60 * 1000;
const MAX_CACHE = 5000;   // trava de memória: o cache antigo cresce sem limite

function lerCache(email, ttl) {
  const item = cacheAcessos.get(email);
  if (!item) return null;
  if (Date.now() - item.ts > ttl) {
    cacheAcessos.delete(email);
    return null;
  }
  return item.acessos;
}

function gravarCache(email, acessos) {
  if (cacheAcessos.size >= MAX_CACHE) {
    cacheAcessos.delete(cacheAcessos.keys().next().value);   // descarta o mais antigo
  }
  cacheAcessos.set(email, { acessos, ts: Date.now() });
}

// ─────────────────────────────────────────────
// Token OAuth da Hotmart
// Duplicado de propósito: importar de routes/login.js criaria
// dependência entre a rota nova e a que já está em produção.
// ─────────────────────────────────────────────
let tokenHotmart = null;

async function pegarTokenHotmart() {
  if (tokenHotmart && tokenHotmart.expiraEm > Date.now() + 5 * 60 * 1000) {
    return tokenHotmart.token;
  }
  const r = await axios.post(
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
  tokenHotmart = {
    token: r.data.access_token,
    expiraEm: Date.now() + (r.data.expires_in * 1000)
  };
  return tokenHotmart.token;
}

/* Mesmos critérios do login antigo, para os dois concordarem sobre
   quem tem acesso. */
const STATUS_VALIDOS = ['APPROVED', 'COMPLETE', 'COMPLETED'];
const STATUS_BLOQUEADOS = ['REFUNDED', 'CANCELLED', 'CHARGEBACK', 'EXPIRED', 'DELAYED'];

// ─────────────────────────────────────────────
// Consulta a Hotmart para UM produto
// ─────────────────────────────────────────────
async function comprou(token, email, productId) {
  const r = await axios.get(
    'https://developers.hotmart.com/payments/api/v1/sales/users',
    {
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      params: { buyer_email: email, product_id: productId },
      timeout: 10000
    }
  );

  const itens = r.data?.items || [];
  return itens.some(item => {
    const ehComprador = (item.users || []).some(u =>
      (u.role || '').toUpperCase() === 'BUYER' &&
      (u.user?.email || '').toLowerCase() === email.toLowerCase()
    );
    const status = (item.purchase?.status || '').toUpperCase();
    const bloqueado = STATUS_BLOQUEADOS.includes(status);
    const valido = STATUS_VALIDOS.includes(status);
    return ehComprador && !!item.transaction && valido && !bloqueado;
  });
}

/**
 * Descobre tudo o que este e-mail comprou.
 * Devolve { imersao: bool, viagens: bool, ... } com uma entrada por
 * produto configurado.
 *
 * Se a Hotmart estiver fora do ar, joga erro em vez de liberar:
 * mesma política conservadora do login antigo.
 */
async function acessosDe(email, ttl = TTL_LOGIN) {
  const emCache = lerCache(email, ttl);
  if (emCache) return emCache;

  const acessos = {};
  Object.keys(PRODUTOS).forEach(nome => { acessos[nome] = false; });

  /* Emails de teste: liberam tudo o que está configurado. Serve para
     você testar o app antes do produto existir na Hotmart. */
  const demos = (process.env.DEMO_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (demos.includes(email)) {
    Object.keys(PRODUTOS).forEach(nome => { if (PRODUTOS[nome]) acessos[nome] = true; });
    acessos.viagens = true;   // o Viagens pode ainda não ter product_id
    console.log(`[VIAGENS] Email demo: ${email}`);
    gravarCache(email, acessos);
    return acessos;
  }

  try {
    const token = await pegarTokenHotmart();

    for (const nome of Object.keys(PRODUTOS)) {
      const id = PRODUTOS[nome];
      if (!id) continue;                 // produto ainda não configurado
      acessos[nome] = await comprou(token, email, id);
    }

    const comprados = Object.keys(acessos).filter(k => acessos[k]);
    console.log(`[VIAGENS] ${email} → ${comprados.length ? comprados.join(', ') : 'nenhum produto'}`);

    gravarCache(email, acessos);
    return acessos;

  } catch (err) {
    const status = err.response?.status;
    console.error(`[VIAGENS] Erro Hotmart (${status}):`, err.message);
    if (status === 401 || status === 403) {
      throw new Error('Erro de configuração do sistema. Contate o suporte.');
    }
    throw new Error('Sistema temporariamente indisponível. Tente novamente em alguns minutos.');
  }
}

// ─────────────────────────────────────────────
// POST /api/viagens/login
// Body: { email }
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email é obrigatório.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Formato de email inválido.' });
  }

  const normalizado = email.toLowerCase().trim();

  try {
    const acessos = await acessosDe(normalizado);

    if (!acessos[PRODUTO_DESTA_ROTA]) {
      return res.status(403).json({
        error: 'Não encontramos a sua compra do Espanhol Essencial para Viagens com este e-mail.',
        action: 'Use o mesmo e-mail da compra. Se você acabou de comprar, aguarde alguns minutos e tente de novo.',
        code: 'SEM_ACESSO'
      });
    }

    const token = jwt.sign({ email: normalizado, acessos }, JWT_SECRET, {
      expiresIn: JWT_EXPIRES_IN,
      algorithm: 'HS256'
    });

    console.log(`[VIAGENS] ✅ Login: ${normalizado}`);
    res.json({ success: true, token, email: normalizado, acessos, expires_in: JWT_EXPIRES_IN });

  } catch (err) {
    console.error('[VIAGENS] Erro no login:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar login. Tente novamente.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/viagens/login/verify
// Revalida na Hotmart a cada abertura do app.
// Reembolso ou cancelamento derruba o acesso em até 2 minutos.
// ─────────────────────────────────────────────
router.get('/login/verify', authMiddleware, async (req, res) => {
  const email = req.user.email;

  try {
    const acessos = await acessosDe(email, TTL_VERIFY);

    if (!acessos[PRODUTO_DESTA_ROTA]) {
      console.log(`[VIAGENS] ❌ Acesso revogado: ${email}`);
      return res.status(403).json({
        valid: false,
        error: 'Seu acesso foi encerrado. Verifique o status da sua compra na Hotmart.',
        code: 'ACCESS_REVOKED'
      });
    }

    res.json({
      valid: true,
      email,
      acessos,
      expires_at: new Date(req.user.exp * 1000).toISOString()
    });

  } catch (err) {
    console.warn(`[VIAGENS] Hotmart indisponível para ${email}`);
    res.status(503).json({
      valid: false,
      error: 'Sistema temporariamente indisponível. Tente novamente em alguns minutos.',
      code: 'HOTMART_UNAVAILABLE'
    });
  }
});

module.exports = router;
module.exports.acessosDe = acessosDe;
