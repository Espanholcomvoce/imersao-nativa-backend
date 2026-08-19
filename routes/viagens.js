/**
 * ESPANHOL ESSENCIAL PARA VIAGENS — Rota de acesso por produto
 *
 * ⚠️ Esta rota é NOVA e ISOLADA. Não altera nem importa nada de
 * routes/login.js. O caminho da Imersão Nativa (POST /api/login)
 * continua exatamente como está.
 *
 * O que ela faz além do login antigo:
 *  1. o token carrega a LISTA de produtos comprados (cadeado por
 *     produto: comprar um nunca libera outro);
 *  2. exige SENHA, criada pela própria aluna no primeiro acesso
 *     (a Hotmart confirma a compra; a senha é nossa);
 *  3. limita QUANTOS APARELHOS usam a mesma conta (por padrão 1,
 *     configurável em VIAGENS_MAX_DISPOSITIVOS).
 *
 *   POST /api/viagens/login          → entrar (email + senha + aparelho)
 *   POST /api/viagens/senha          → primeiro acesso: criar a senha
 *   GET  /api/viagens/login/verify   → revalida compra e aparelho
 *   POST /api/viagens/admin/reset    → suporte: limpar senha ou aparelhos
 *
 * Sem DATABASE_URL o Postgres não existe; nesse caso senha e limite
 * de aparelhos ficam desligados e o login volta a ser só por e-mail,
 * com aviso no log (o app continua de pé em vez de cair).
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const axios = require('axios');
const crypto = require('crypto');
const { authMiddleware } = require('../middleware/auth');
const { pool } = require('../db');

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30m';
const HOTMART_CLIENT_ID = process.env.HOTMART_CLIENT_ID;
const HOTMART_CLIENT_SECRET = process.env.HOTMART_CLIENT_SECRET;
const HOTMART_BASIC = process.env.HOTMART_BASIC;
const MAX_DISPOSITIVOS = parseInt(process.env.VIAGENS_MAX_DISPOSITIVOS || '1', 10);

/**
 * Catálogo de produtos. A chave é o nome usado pelos apps; o valor é
 * o product_id da Hotmart. Produto sem variável configurada sai como
 * false e nem é consultado: dá para ligar um de cada vez.
 */
const PRODUTOS = {
  imersao:   process.env.HOTMART_PRODUCT_ID,
  viagens:   process.env.HOTMART_PRODUCT_ID_VIAGENS,
  negocios:  process.env.HOTMART_PRODUCT_ID_NEGOCIOS,
  deleSiele: process.env.HOTMART_PRODUCT_ID_DELE,
  pronuncia: process.env.HOTMART_PRODUCT_ID_PRONUNCIA
};

const PRODUTO_DESTA_ROTA = 'viagens';

// ─────────────────────────────────────────────
// Tabelas próprias do Viagens (criadas na primeira necessidade,
// mesmo padrão do routes/progreso.js)
// ─────────────────────────────────────────────
let tabelasProntas = false;
async function garantirTabelas() {
  if (tabelasProntas || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viagens_alunos (
      email      TEXT PRIMARY KEY,
      senha_hash TEXT NOT NULL,
      criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS viagens_dispositivos (
      email     TEXT NOT NULL,
      device_id TEXT NOT NULL,
      nome      TEXT,
      visto_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (email, device_id)
    );
  `);
  tabelasProntas = true;
}

// ─────────────────────────────────────────────
// Senha: scrypt do Node, sem dependência nova
// ─────────────────────────────────────────────
function hashSenha(senha) {
  const sal = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(senha, sal, 64).toString('hex');
  return sal + ':' + h;
}

function confereSenha(senha, guardado) {
  try {
    const [sal, h] = String(guardado).split(':');
    const t = crypto.scryptSync(senha, sal, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(t, 'hex'));
  } catch (e) { return false; }
}

// ─────────────────────────────────────────────
// Aparelhos: cada navegador gera um id fixo; aqui controlamos
// quantos ids distintos uma conta pode ter.
// Devolve { ok } ou { ok:false, motivo }.
// ─────────────────────────────────────────────
async function registrarDispositivo(email, disp) {
  if (!pool || !disp || !disp.id) return { ok: true };  // sem banco ou sem id: não trava
  await garantirTabelas();

  const id = String(disp.id).slice(0, 80);
  const nome = String(disp.nome || '').slice(0, 120);

  const ja = await pool.query(
    'SELECT device_id FROM viagens_dispositivos WHERE email = $1 AND device_id = $2', [email, id]);
  if (ja.rows.length) {
    await pool.query(
      'UPDATE viagens_dispositivos SET visto_em = NOW(), nome = COALESCE(NULLIF($3, \'\'), nome) WHERE email = $1 AND device_id = $2',
      [email, id, nome]);
    return { ok: true };
  }

  const todos = await pool.query(
    'SELECT COUNT(*)::int AS n FROM viagens_dispositivos WHERE email = $1', [email]);
  if (todos.rows[0].n >= MAX_DISPOSITIVOS) {
    console.log(`[VIAGENS] ❌ Limite de aparelhos para ${email} (${todos.rows[0].n}/${MAX_DISPOSITIVOS})`);
    return { ok: false, motivo: 'DISPOSITIVO_LIMITE' };
  }

  await pool.query(
    'INSERT INTO viagens_dispositivos (email, device_id, nome) VALUES ($1, $2, $3)',
    [email, id, nome]);
  console.log(`[VIAGENS] Aparelho novo registrado para ${email} (${todos.rows[0].n + 1}/${MAX_DISPOSITIVOS})`);
  return { ok: true };
}

// ─────────────────────────────────────────────
// Cache dos acessos Hotmart (separado do cache do login antigo)
// ─────────────────────────────────────────────
const cacheAcessos = new Map();
const TTL_LOGIN = 10 * 60 * 1000;
const TTL_VERIFY = 2 * 60 * 1000;
const MAX_CACHE = 5000;

function lerCache(email, ttl) {
  const item = cacheAcessos.get(email);
  if (!item) return null;
  if (Date.now() - item.ts > ttl) { cacheAcessos.delete(email); return null; }
  return item.acessos;
}

function gravarCache(email, acessos) {
  if (cacheAcessos.size >= MAX_CACHE) {
    cacheAcessos.delete(cacheAcessos.keys().next().value);
  }
  cacheAcessos.set(email, { acessos, ts: Date.now() });
}

// ─────────────────────────────────────────────
// Token OAuth da Hotmart (duplicado de propósito: importar do
// login.js criaria dependência com o que está em produção)
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

const STATUS_VALIDOS = ['APPROVED', 'COMPLETE', 'COMPLETED'];
const STATUS_BLOQUEADOS = ['REFUNDED', 'CANCELLED', 'CHARGEBACK', 'EXPIRED', 'DELAYED'];

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
    return ehComprador && !!item.transaction &&
           STATUS_VALIDOS.includes(status) && !STATUS_BLOQUEADOS.includes(status);
  });
}

async function acessosDe(email, ttl = TTL_LOGIN) {
  const emCache = lerCache(email, ttl);
  if (emCache) return emCache;

  const acessos = {};
  Object.keys(PRODUTOS).forEach(nome => { acessos[nome] = false; });

  const demos = (process.env.DEMO_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
  if (demos.includes(email)) {
    Object.keys(PRODUTOS).forEach(nome => { if (PRODUTOS[nome]) acessos[nome] = true; });
    acessos.viagens = true;
    gravarCache(email, acessos);
    return acessos;
  }

  try {
    const token = await pegarTokenHotmart();
    for (const nome of Object.keys(PRODUTOS)) {
      if (!PRODUTOS[nome]) continue;
      acessos[nome] = await comprou(token, email, PRODUTOS[nome]);
    }
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

function emitirToken(email, acessos, dispId) {
  return jwt.sign({ email, acessos, disp: dispId || null }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    algorithm: 'HS256'
  });
}

function emailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '');
}

// ─────────────────────────────────────────────
// POST /api/viagens/login
// Body: { email, senha, dispositivo: { id, nome } }
// ─────────────────────────────────────────────
router.post('/login', async (req, res) => {
  const { email, senha, dispositivo } = req.body || {};
  if (!emailValido(email)) return res.status(400).json({ error: 'Email inválido.' });

  const normalizado = email.toLowerCase().trim();

  try {
    const acessos = await acessosDe(normalizado);
    if (!acessos[PRODUTO_DESTA_ROTA]) {
      return res.status(403).json({
        error: 'Não encontramos a sua compra do Espanhol Essencial para Viagens com este e-mail.',
        action: 'Use o mesmo e-mail da compra. Se você acabou de comprar, aguarde alguns minutos.',
        code: 'SEM_ACESSO'
      });
    }

    // Senha: só quando há banco. Sem banco, funciona como antes.
    if (pool) {
      await garantirTabelas();
      const r = await pool.query('SELECT senha_hash FROM viagens_alunos WHERE email = $1', [normalizado]);
      if (!r.rows.length) {
        return res.status(409).json({
          error: 'Primeiro acesso: crie a sua senha.',
          code: 'PRIMEIRO_ACESSO'
        });
      }
      if (!senha || !confereSenha(senha, r.rows[0].senha_hash)) {
        console.log(`[VIAGENS] ❌ Senha incorreta: ${normalizado}`);
        return res.status(401).json({ error: 'Senha incorreta.', code: 'SENHA_INCORRETA' });
      }
    } else {
      console.warn('[VIAGENS] Sem DATABASE_URL: login funcionando sem senha e sem limite de aparelhos');
    }

    const disp = await registrarDispositivo(normalizado, dispositivo);
    if (!disp.ok) {
      return res.status(403).json({
        error: 'Esta conta já está em uso em outro aparelho.',
        action: 'O acesso é individual. Se você trocou de celular ou computador, fale com o suporte para liberar o aparelho novo.',
        code: 'DISPOSITIVO_LIMITE'
      });
    }

    console.log(`[VIAGENS] ✅ Login: ${normalizado}`);
    res.json({
      success: true,
      token: emitirToken(normalizado, acessos, dispositivo && dispositivo.id),
      email: normalizado,
      acessos,
      expires_in: JWT_EXPIRES_IN
    });
  } catch (err) {
    console.error('[VIAGENS] Erro no login:', err.message);
    res.status(500).json({ error: err.message || 'Erro ao processar login.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/viagens/senha  (primeiro acesso)
// Body: { email, senha, dispositivo }
// Só cria se a compra existe e ainda não há senha.
// ─────────────────────────────────────────────
router.post('/senha', async (req, res) => {
  const { email, senha, dispositivo } = req.body || {};
  if (!emailValido(email)) return res.status(400).json({ error: 'Email inválido.' });
  if (!senha || String(senha).length < 8) {
    return res.status(400).json({ error: 'A senha precisa ter pelo menos 8 caracteres.' });
  }
  if (!pool) return res.status(503).json({ error: 'Cadastro indisponível no momento.' });

  const normalizado = email.toLowerCase().trim();

  try {
    const acessos = await acessosDe(normalizado);
    if (!acessos[PRODUTO_DESTA_ROTA]) {
      return res.status(403).json({
        error: 'Não encontramos a sua compra com este e-mail.',
        code: 'SEM_ACESSO'
      });
    }

    await garantirTabelas();
    const ja = await pool.query('SELECT 1 FROM viagens_alunos WHERE email = $1', [normalizado]);
    if (ja.rows.length) {
      return res.status(409).json({
        error: 'Esta conta já tem senha. Se você a esqueceu, fale com o suporte.',
        code: 'JA_TEM_SENHA'
      });
    }

    await pool.query(
      'INSERT INTO viagens_alunos (email, senha_hash) VALUES ($1, $2)',
      [normalizado, hashSenha(String(senha))]);

    const disp = await registrarDispositivo(normalizado, dispositivo);
    if (!disp.ok) {
      return res.status(403).json({ error: 'Esta conta já está em uso em outro aparelho.', code: 'DISPOSITIVO_LIMITE' });
    }

    console.log(`[VIAGENS] ✅ Senha criada: ${normalizado}`);
    res.json({
      success: true,
      token: emitirToken(normalizado, acessos, dispositivo && dispositivo.id),
      email: normalizado,
      acessos,
      expires_in: JWT_EXPIRES_IN
    });
  } catch (err) {
    console.error('[VIAGENS] Erro ao criar senha:', err.message);
    res.status(500).json({ error: 'Erro ao criar a senha. Tente novamente.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/viagens/login/verify
// Headers: Authorization: Bearer <token>, X-Dispositivo: <id>
// ─────────────────────────────────────────────
router.get('/login/verify', authMiddleware, async (req, res) => {
  const email = req.user.email;
  const dispId = req.headers['x-dispositivo'] || req.user.disp;

  try {
    const acessos = await acessosDe(email, TTL_VERIFY);
    if (!acessos[PRODUTO_DESTA_ROTA]) {
      return res.status(403).json({
        valid: false,
        error: 'Seu acesso foi encerrado. Verifique o status da sua compra na Hotmart.',
        code: 'ACCESS_REVOKED'
      });
    }

    const disp = await registrarDispositivo(email, dispId ? { id: dispId } : null);
    if (!disp.ok) {
      return res.status(403).json({
        valid: false,
        error: 'Esta conta já está em uso em outro aparelho.',
        code: 'DISPOSITIVO_LIMITE'
      });
    }

    res.json({ valid: true, email, acessos, expires_at: new Date(req.user.exp * 1000).toISOString() });
  } catch (err) {
    res.status(503).json({
      valid: false,
      error: 'Sistema temporariamente indisponível. Tente novamente em alguns minutos.',
      code: 'HOTMART_UNAVAILABLE'
    });
  }
});

// ─────────────────────────────────────────────
// POST /api/viagens/admin/reset   (suporte)
// Header: X-Admin-Token
// Body: { email, alvo: 'senha' | 'dispositivos' }
// Aluna esqueceu a senha → reset 'senha' e ela cria de novo.
// Aluna trocou de celular → reset 'dispositivos'.
// ─────────────────────────────────────────────
router.post('/admin/reset', async (req, res) => {
  if (!process.env.ADMIN_TOKEN || req.headers['x-admin-token'] !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Não autorizado.' });
  }
  const { email, alvo } = req.body || {};
  if (!emailValido(email) || !['senha', 'dispositivos'].includes(alvo)) {
    return res.status(400).json({ error: 'Informe email e alvo (senha ou dispositivos).' });
  }
  if (!pool) return res.status(503).json({ error: 'Sem banco de dados.' });

  const normalizado = email.toLowerCase().trim();
  try {
    await garantirTabelas();
    const tabela = alvo === 'senha' ? 'viagens_alunos' : 'viagens_dispositivos';
    const r = await pool.query(`DELETE FROM ${tabela} WHERE email = $1`, [normalizado]);
    console.log(`[VIAGENS] Reset ${alvo} de ${normalizado} (${r.rowCount} linha/s)`);
    res.json({ success: true, apagadas: r.rowCount });
  } catch (err) {
    console.error('[VIAGENS] Erro no reset:', err.message);
    res.status(500).json({ error: 'Erro ao executar o reset.' });
  }
});

module.exports = router;
module.exports.acessosDe = acessosDe;
