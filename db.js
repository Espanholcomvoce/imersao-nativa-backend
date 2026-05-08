/**
 * IMERSÃO NATIVA — Postgres pool + schema bootstrap
 *
 * Único arquivo que toca o Postgres. Importado por rotas que precisam
 * persistir uso (Realtime daily limit por enquanto, futuro:
 * relatórios, eventos de aluno, etc).
 *
 * Fuso fixo America/Sao_Paulo nas operações por dia (RealTime tracking).
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn('⚠️  DATABASE_URL não configurada — operações com Postgres vão falhar.');
}

// Railway Postgres usa SSL com cert auto-assinado
const sslConfig = process.env.NODE_ENV === 'production'
  ? { rejectUnauthorized: false }
  : false;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslConfig,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

pool.on('error', (err) => {
  console.error('[DB] Erro no pool Postgres:', err.message);
});

/**
 * Cria/garante tabelas. Idempotente — pode rodar a cada start.
 */
async function init() {
  if (!DATABASE_URL) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS daily_usage (
        email TEXT NOT NULL,
        usage_date DATE NOT NULL,
        seconds_used INT NOT NULL DEFAULT 0,
        last_heartbeat TIMESTAMPTZ,
        PRIMARY KEY (email, usage_date)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_daily_usage_date ON daily_usage(usage_date);`);
    console.log('[DB] Schema garantido (daily_usage).');
  } catch (err) {
    console.error('[DB] Falha ao inicializar schema:', err.message);
  }
}

/**
 * Retorna a data de hoje no fuso de Brasília (YYYY-MM-DD).
 * Resolve furo do contador antigo que usava UTC: aluno noturno tinha 30 min/noite.
 */
function todayBR() {
  const now = new Date();
  // toLocaleDateString com timeZone retorna no fuso correto
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${d}`;
}

/**
 * Retorna segundos usados hoje pelo aluno (fuso BR).
 * Se não existe row, retorna 0.
 */
async function getSecondsUsedToday(email) {
  if (!DATABASE_URL) return 0;
  const r = await pool.query(
    'SELECT seconds_used FROM daily_usage WHERE email = $1 AND usage_date = $2',
    [email, todayBR()]
  );
  return r.rows.length > 0 ? r.rows[0].seconds_used : 0;
}

/**
 * Soma segundos ao uso de hoje (atomic upsert).
 * Retorna o total acumulado APÓS o incremento.
 */
async function addSecondsToToday(email, seconds) {
  if (!DATABASE_URL) return 0;
  const r = await pool.query(
    `INSERT INTO daily_usage (email, usage_date, seconds_used, last_heartbeat)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (email, usage_date)
     DO UPDATE SET seconds_used = daily_usage.seconds_used + $3,
                   last_heartbeat = NOW()
     RETURNING seconds_used`,
    [email, todayBR(), seconds]
  );
  return r.rows[0].seconds_used;
}

/**
 * Para o relatório admin: lista de alunos com total no período.
 */
async function getUsageReport(fromDate, toDate) {
  if (!DATABASE_URL) return [];
  const r = await pool.query(
    `SELECT email,
            SUM(seconds_used)::int AS total_seconds,
            COUNT(DISTINCT usage_date)::int AS active_days,
            MAX(usage_date) AS last_active
     FROM daily_usage
     WHERE usage_date BETWEEN $1 AND $2
     GROUP BY email
     ORDER BY total_seconds DESC`,
    [fromDate, toDate]
  );
  return r.rows;
}

module.exports = {
  pool,
  init,
  todayBR,
  getSecondsUsedToday,
  addSecondsToToday,
  getUsageReport
};
