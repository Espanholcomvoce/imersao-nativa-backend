/**
 * IMERSÃO NATIVA — Endpoints administrativos
 *
 * Todos protegidos por header X-Admin-Token (env var ADMIN_TOKEN).
 * Não usa o JWT dos alunos — esse endpoint é só pra Ale consultar.
 *
 * Endpoints:
 *   GET /api/admin/usage-report?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   GET /api/admin/today
 */

const express = require('express');
const router = express.Router();
const db = require('../db');

const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.warn('⚠️  ADMIN_TOKEN não configurado — endpoints admin vão recusar todos os requests.');
}

function adminAuth(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: 'Admin endpoints desabilitados (ADMIN_TOKEN não configurado).' });
  }
  const provided = req.headers['x-admin-token'];
  if (!provided || provided !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Token admin inválido ou ausente.' });
  }
  next();
}

// GET /api/admin/usage-report?from=YYYY-MM-DD&to=YYYY-MM-DD
// Lista quem usou Realtime no período, ordenado por minutos totais.
router.get('/usage-report', adminAuth, async (req, res) => {
  try {
    const { from, to } = req.query;
    if (!from || !to) {
      return res.status(400).json({ error: 'Parâmetros from e to (YYYY-MM-DD) são obrigatórios.' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return res.status(400).json({ error: 'Formato de data inválido. Use YYYY-MM-DD.' });
    }

    const rows = await db.getUsageReport(from, to);
    const total = rows.reduce((sum, r) => sum + r.total_seconds, 0);

    res.json({
      from,
      to,
      total_users: rows.length,
      total_minutes: Math.round(total / 60),
      total_estimated_cost_usd: +(total / 60 * 0.30).toFixed(2), // ~$0.30/min Realtime GA estimado
      users: rows.map(r => ({
        email: r.email,
        total_seconds: r.total_seconds,
        total_minutes: Math.round(r.total_seconds / 60 * 10) / 10,
        active_days: r.active_days,
        last_active: r.last_active,
        avg_minutes_per_active_day: r.active_days > 0
          ? Math.round(r.total_seconds / r.active_days / 60 * 10) / 10
          : 0
      }))
    });
  } catch (err) {
    console.error('[ADMIN report]', err.message);
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});

// GET /api/admin/today
// Atalho: relatório do dia (fuso BR).
router.get('/today', adminAuth, async (req, res) => {
  try {
    const today = db.todayBR();
    const rows = await db.getUsageReport(today, today);
    const total = rows.reduce((sum, r) => sum + r.total_seconds, 0);
    res.json({
      date: today,
      timezone: 'America/Sao_Paulo',
      total_users: rows.length,
      total_minutes: Math.round(total / 60),
      users: rows
    });
  } catch (err) {
    console.error('[ADMIN today]', err.message);
    res.status(500).json({ error: 'Erro ao gerar relatório.' });
  }
});

module.exports = router;
