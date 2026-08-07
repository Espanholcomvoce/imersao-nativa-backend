/**
 * IMERSÃO NATIVA — Progresso do aluno (memória entre sessões e dispositivos)
 *
 * Resolve a queixa dos alunos: o app "esquecia" tudo porque o progresso vivia
 * só no localStorage do navegador. Aqui ele passa a viver no Postgres, ligado
 * ao e-mail do aluno, então ele continua de onde parou em qualquer aparelho.
 *
 * Rotas (todas exigem token):
 *   GET  /api/progreso        -> devolve todas as chaves do aluno
 *   PUT  /api/progreso        -> grava várias chaves de uma vez (merge)
 *
 * Formato: { chave: <valor JSON> }. Cada tela decide quais chaves usa
 * (sre_cards, lec_done_B1, in_prod_stats, ...), então adicionar uma tela nova
 * não exige mexer aqui.
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { pool } = require('../db');

// Limites de segurança: evita que um bug do front encha o banco.
const MAX_CHAVES = 60;
const MAX_BYTES_POR_CHAVE = 400 * 1024; // 400 KB

let tablaLista = false;
async function garantirTabela() {
  if (tablaLista || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS student_progress (
      email      TEXT NOT NULL,
      key        TEXT NOT NULL,
      data       JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (email, key)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_student_progress_email ON student_progress(email);`);
  tablaLista = true;
}

// ── Ler tudo ──────────────────────────────────────────────────────────────
router.get('/', authMiddleware, async (req, res) => {
  if (!pool) return res.json({ success: true, progreso: {}, sinBase: true });
  try {
    await garantirTabela();
    const email = (req.user?.email || '').toLowerCase();
    const { rows } = await pool.query(
      'SELECT key, data, updated_at FROM student_progress WHERE email = $1',
      [email]
    );
    const progreso = {};
    const actualizado = {};
    rows.forEach(r => {
      progreso[r.key] = r.data;
      actualizado[r.key] = r.updated_at;
    });
    res.json({ success: true, progreso, actualizado });
  } catch (err) {
    console.error('[PROGRESO] Erro ao ler:', err.message);
    res.status(500).json({ error: 'Erro ao ler progresso.' });
  }
});

// ── Gravar (merge) ────────────────────────────────────────────────────────
router.put('/', authMiddleware, async (req, res) => {
  if (!pool) return res.json({ success: true, guardadas: 0, sinBase: true });
  try {
    await garantirTabela();
    const email = (req.user?.email || '').toLowerCase();
    const cambios = req.body?.progreso;

    if (!cambios || typeof cambios !== 'object' || Array.isArray(cambios)) {
      return res.status(400).json({ error: 'Formato inválido: esperado { progreso: {...} }' });
    }
    const claves = Object.keys(cambios);
    if (claves.length === 0) return res.json({ success: true, guardadas: 0 });
    if (claves.length > MAX_CHAVES) {
      return res.status(400).json({ error: `Máximo ${MAX_CHAVES} chaves por requisição.` });
    }

    let guardadas = 0;
    for (const key of claves) {
      const valor = cambios[key];
      if (valor === undefined) continue;
      const texto = JSON.stringify(valor);
      if (texto.length > MAX_BYTES_POR_CHAVE) {
        console.warn(`[PROGRESO] Chave ignorada por tamanho: ${key} (${texto.length} bytes)`);
        continue;
      }
      await pool.query(
        `INSERT INTO student_progress (email, key, data, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (email, key)
         DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()`,
        [email, key, texto]
      );
      guardadas++;
    }

    res.json({ success: true, guardadas });
  } catch (err) {
    console.error('[PROGRESO] Erro ao gravar:', err.message);
    res.status(500).json({ error: 'Erro ao gravar progresso.' });
  }
});

module.exports = router;
