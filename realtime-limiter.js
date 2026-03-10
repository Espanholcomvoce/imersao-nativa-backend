/**
 * Middleware: Realtime Usage Limiter
 * Verifica que el usuario no exceda 15 minutos diarios de conversación
 */

const db = require('../config/database'); // Asume conexión a PostgreSQL

// Límite diario en minutos
const DAILY_LIMIT_MINUTES = 15;

/**
 * Middleware para verificar límite diario
 */
async function checkDailyLimit(req, res, next) {
  try {
    const userEmail = req.user?.email; // Asume que JWT ya validó el usuario
    
    if (!userEmail) {
      return res.status(401).json({
        success: false,
        error: 'Usuario no autenticado'
      });
    }

    // Obtener uso del día actual
    const today = new Date().toISOString().split('T')[0];
    
    const result = await db.query(
      `SELECT minutes_used, sessions_count 
       FROM realtime_usage 
       WHERE user_email = $1 AND date = $2`,
      [userEmail, today]
    );

    let minutesUsed = 0;
    let sessionsCount = 0;

    if (result.rows.length > 0) {
      minutesUsed = parseFloat(result.rows[0].minutes_used);
      sessionsCount = parseInt(result.rows[0].sessions_count);
    }

    const minutesRemaining = DAILY_LIMIT_MINUTES - minutesUsed;

    // Verificar si ya excedió el límite
    if (minutesRemaining <= 0) {
      return res.status(429).json({
        success: false,
        error: 'Límite diario excedido',
        message: 'Has usado tus 15 minutos de conversación por hoy. Vuelve mañana.',
        data: {
          limit: DAILY_LIMIT_MINUTES,
          used: minutesUsed,
          remaining: 0,
          sessions_today: sessionsCount,
          reset_at: getNextResetTime()
        }
      });
    }

    // Agregar información al request para uso posterior
    req.realtimeUsage = {
      email: userEmail,
      minutesUsed,
      minutesRemaining,
      sessionsCount,
      limit: DAILY_LIMIT_MINUTES
    };

    next();
  } catch (error) {
    console.error('❌ Error en checkDailyLimit:', error);
    res.status(500).json({
      success: false,
      error: 'Error al verificar límite de uso'
    });
  }
}

/**
 * Registrar uso de minutos
 */
async function recordUsage(userEmail, durationSeconds) {
  try {
    const today = new Date().toISOString().split('T')[0];
    const minutesUsed = (durationSeconds / 60).toFixed(2);

    // Insertar o actualizar registro
    await db.query(
      `INSERT INTO realtime_usage (user_email, date, minutes_used, sessions_count)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (user_email, date)
       DO UPDATE SET 
         minutes_used = realtime_usage.minutes_used + $3,
         sessions_count = realtime_usage.sessions_count + 1,
         updated_at = CURRENT_TIMESTAMP`,
      [userEmail, today, minutesUsed]
    );

    console.log(`✅ Registrado uso: ${userEmail} - ${minutesUsed} min`);
    return true;
  } catch (error) {
    console.error('❌ Error al registrar uso:', error);
    return false;
  }
}

/**
 * Obtener estadísticas de uso del usuario
 */
async function getUserStats(userEmail) {
  try {
    const today = new Date().toISOString().split('T')[0];
    
    // Uso de hoy
    const todayResult = await db.query(
      `SELECT minutes_used, sessions_count 
       FROM realtime_usage 
       WHERE user_email = $1 AND date = $2`,
      [userEmail, today]
    );

    const todayStats = todayResult.rows.length > 0 
      ? todayResult.rows[0] 
      : { minutes_used: 0, sessions_count: 0 };

    // Uso total histórico
    const totalResult = await db.query(
      `SELECT 
         SUM(minutes_used) as total_minutes,
         SUM(sessions_count) as total_sessions,
         COUNT(DISTINCT date) as days_active
       FROM realtime_usage 
       WHERE user_email = $1`,
      [userEmail]
    );

    const totalStats = totalResult.rows[0];

    // Últimas 7 días
    const weekResult = await db.query(
      `SELECT date, minutes_used, sessions_count
       FROM realtime_usage 
       WHERE user_email = $1 
         AND date >= CURRENT_DATE - INTERVAL '7 days'
       ORDER BY date DESC`,
      [userEmail]
    );

    return {
      today: {
        minutes_used: parseFloat(todayStats.minutes_used),
        minutes_remaining: DAILY_LIMIT_MINUTES - parseFloat(todayStats.minutes_used),
        sessions_count: parseInt(todayStats.sessions_count),
        limit: DAILY_LIMIT_MINUTES
      },
      total: {
        minutes: parseFloat(totalStats.total_minutes) || 0,
        sessions: parseInt(totalStats.total_sessions) || 0,
        days_active: parseInt(totalStats.days_active) || 0
      },
      last_7_days: weekResult.rows.map(row => ({
        date: row.date,
        minutes: parseFloat(row.minutes_used),
        sessions: parseInt(row.sessions_count)
      }))
    };
  } catch (error) {
    console.error('❌ Error al obtener estadísticas:', error);
    throw error;
  }
}

/**
 * Crear registro de sesión
 */
async function createSession(userEmail, sessionId, level, topic = null) {
  try {
    await db.query(
      `INSERT INTO realtime_sessions 
       (user_email, session_id, level, topic, status)
       VALUES ($1, $2, $3, $4, 'active')`,
      [userEmail, sessionId, level, topic]
    );
    
    console.log(`✅ Sesión creada: ${sessionId} - Usuario: ${userEmail}`);
    return true;
  } catch (error) {
    console.error('❌ Error al crear sesión:', error);
    return false;
  }
}

/**
 * Finalizar sesión y registrar duración
 */
async function endSession(sessionId, messagesCount = 0, status = 'completed') {
  try {
    const result = await db.query(
      `UPDATE realtime_sessions 
       SET ended_at = CURRENT_TIMESTAMP,
           duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - started_at)),
           messages_count = $2,
           status = $3,
           updated_at = CURRENT_TIMESTAMP
       WHERE session_id = $1
       RETURNING user_email, duration_seconds`,
      [sessionId, messagesCount, status]
    );

    if (result.rows.length > 0) {
      const { user_email, duration_seconds } = result.rows[0];
      
      // Registrar minutos usados
      await recordUsage(user_email, duration_seconds);
      
      console.log(`✅ Sesión finalizada: ${sessionId} - ${duration_seconds}s`);
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Error al finalizar sesión:', error);
    return false;
  }
}

/**
 * Obtener hora de reset (medianoche)
 */
function getNextResetTime() {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);
  return tomorrow.toISOString();
}

module.exports = {
  checkDailyLimit,
  recordUsage,
  getUserStats,
  createSession,
  endSession,
  DAILY_LIMIT_MINUTES
};
