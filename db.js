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

    // module_usage: tempo por aluno por módulo por dia (fuso BR)
    // Granularidade: 1 linha por (email, dia, módulo).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS module_usage (
        email TEXT NOT NULL,
        usage_date DATE NOT NULL,
        module TEXT NOT NULL,
        seconds_used INT NOT NULL DEFAULT 0,
        last_update TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (email, usage_date, module)
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_module_usage_date ON module_usage(usage_date);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_module_usage_email ON module_usage(email);`);
    console.log('[DB] Schema garantido (daily_usage, module_usage).');
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

/**
 * MODULE USAGE TRACKING
 * Salva tempo gasto em cada módulo do app (Conversação, SRE, Leitura, etc).
 * Granularidade diária no fuso de Brasília.
 */
async function addModuleUsage(email, module, seconds) {
  if (!DATABASE_URL) return 0;
  // Limita módulo a valores conhecidos (defesa contra injeção/erro do client)
  const valid = ['conversacao','sre','leitura','imersao_cultural','tira_duvidas','producao_escrita'];
  if (!valid.includes(module)) return 0;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) return 0;
  const r = await pool.query(
    `INSERT INTO module_usage (email, usage_date, module, seconds_used, last_update)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (email, usage_date, module)
     DO UPDATE SET seconds_used = module_usage.seconds_used + $4,
                   last_update = NOW()
     RETURNING seconds_used`,
    [email, todayBR(), module, Math.floor(seconds)]
  );
  return r.rows[0].seconds_used;
}

/**
 * Helper interno: SELECT unificado de module_usage + daily_usage.
 * daily_usage (tabela antiga, só Realtime) é exposta com module='realtime'
 * pra manter histórico visível no dashboard.
 */
function _unifiedUsageSubquery() {
  return `(
    SELECT email, usage_date, module, seconds_used FROM module_usage
    UNION ALL
    SELECT email, usage_date, 'realtime' AS module, seconds_used FROM daily_usage
  )`;
}

/**
 * Relatório admin: totais por aluno (período).
 */
async function getModuleReport_byUser(fromDate, toDate, emailFilter) {
  if (!DATABASE_URL) return [];
  const params = [fromDate, toDate];
  let where = 'usage_date BETWEEN $1 AND $2';
  if (emailFilter) { params.push(emailFilter); where += ` AND email = $${params.length}`; }
  const r = await pool.query(
    `SELECT email,
            SUM(seconds_used)::int AS total_seconds,
            ROUND(SUM(seconds_used)/60.0, 1)::float AS total_minutes,
            COUNT(DISTINCT usage_date)::int AS active_days,
            MAX(usage_date) AS last_active
     FROM ${_unifiedUsageSubquery()} u
     WHERE ${where}
     GROUP BY email
     ORDER BY total_seconds DESC`,
    params
  );
  return r.rows;
}

/**
 * Relatório admin: totais por módulo (período).
 */
async function getModuleReport_byModule(fromDate, toDate, emailFilter) {
  if (!DATABASE_URL) return [];
  const params = [fromDate, toDate];
  let where = 'usage_date BETWEEN $1 AND $2';
  if (emailFilter) { params.push(emailFilter); where += ` AND email = $${params.length}`; }
  const r = await pool.query(
    `SELECT module,
            SUM(seconds_used)::int AS total_seconds,
            ROUND(SUM(seconds_used)/60.0, 1)::float AS total_minutes,
            COUNT(DISTINCT email)::int AS unique_users
     FROM ${_unifiedUsageSubquery()} u
     WHERE ${where}
     GROUP BY module
     ORDER BY total_seconds DESC`,
    params
  );
  return r.rows;
}

/**
 * Relatório admin: série temporal (totais por dia).
 */
async function getModuleReport_byDay(fromDate, toDate, emailFilter) {
  if (!DATABASE_URL) return [];
  const params = [fromDate, toDate];
  let where = 'usage_date BETWEEN $1 AND $2';
  if (emailFilter) { params.push(emailFilter); where += ` AND email = $${params.length}`; }
  const r = await pool.query(
    `SELECT usage_date AS date,
            SUM(seconds_used)::int AS total_seconds,
            ROUND(SUM(seconds_used)/60.0, 1)::float AS total_minutes,
            COUNT(DISTINCT email)::int AS active_users
     FROM ${_unifiedUsageSubquery()} u
     WHERE ${where}
     GROUP BY usage_date
     ORDER BY usage_date ASC`,
    params
  );
  return r.rows;
}

/**
 * Relatório admin: detalhe (aluno × módulo × dia).
 */
async function getModuleReport_detail(fromDate, toDate, emailFilter) {
  if (!DATABASE_URL) return [];
  const params = [fromDate, toDate];
  let where = 'usage_date BETWEEN $1 AND $2';
  if (emailFilter) { params.push(emailFilter); where += ` AND email = $${params.length}`; }
  const r = await pool.query(
    `SELECT usage_date AS date,
            email,
            module,
            seconds_used,
            ROUND(seconds_used/60.0, 1)::float AS minutes
     FROM ${_unifiedUsageSubquery()} u
     WHERE ${where}
     ORDER BY usage_date DESC, email ASC, seconds_used DESC
     LIMIT 5000`,
    params
  );
  return r.rows;
}

module.exports = {
  pool,
  init,
  todayBR,
  getSecondsUsedToday,
  addSecondsToToday,
  getUsageReport,
  addModuleUsage,
  getModuleReport_byUser,
  getModuleReport_byModule,
  getModuleReport_byDay,
  getModuleReport_detail
};
