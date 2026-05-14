/**
 * IMERSÃO NATIVA — Endpoint genérico de tracking
 *
 * POST /api/track/module
 * Body: { module: 'sre' | 'conversacao' | ..., duration_seconds: number }
 * Auth: JWT do aluno (authMiddleware — não revalida Hotmart pra ser leve)
 *
 * Persiste em Postgres (tabela module_usage). Granularidade diária por aluno/módulo.
 * Chamado pelo frontend a cada vez que o aluno sai de um módulo (mesma hora
 * que dispara `module_used` no PostHog).
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const db = require('../db');

router.post('/module', authMiddleware, async (req, res) => {
  try {
    const { module, duration_seconds } = req.body || {};
    if (typeof module !== 'string' || !module) {
      return res.status(400).json({ error: 'module obrigatório.' });
    }
    const secs = Number(duration_seconds);
    if (!Number.isFinite(secs) || secs <= 0) {
      return res.status(400).json({ error: 'duration_seconds inválido.' });
    }
    const total = await db.addModuleUsage(req.user.email, module, secs);
    res.json({ ok: true, module, total_seconds_today: total });
  } catch (err) {
    console.error('[TRACK module]', err.message);
    res.status(500).json({ error: 'Erro ao registrar uso.' });
  }
});

module.exports = router;
