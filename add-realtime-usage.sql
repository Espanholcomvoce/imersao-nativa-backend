-- Migration: Add Realtime Usage Tracking
-- Fecha: 2026-03-10
-- Descripción: Tabla para trackear uso diario de OpenAI Realtime API (límite 15 min/día)

-- Crear tabla de uso de conversación realtime
CREATE TABLE IF NOT EXISTS realtime_usage (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    date DATE NOT NULL DEFAULT CURRENT_DATE,
    minutes_used DECIMAL(10, 2) DEFAULT 0.00,
    sessions_count INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Índices para búsqueda rápida
    CONSTRAINT unique_user_date UNIQUE (user_email, date)
);

-- Índice para búsquedas por usuario y fecha
CREATE INDEX IF NOT EXISTS idx_realtime_usage_user_date 
ON realtime_usage(user_email, date);

-- Índice para búsquedas por fecha (para estadísticas)
CREATE INDEX IF NOT EXISTS idx_realtime_usage_date 
ON realtime_usage(date);

-- Tabla de sesiones individuales (para tracking detallado)
CREATE TABLE IF NOT EXISTS realtime_sessions (
    id SERIAL PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    session_id VARCHAR(255) UNIQUE NOT NULL,
    level VARCHAR(10) NOT NULL, -- A1, A2, B1, B2, C1, C2
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP,
    duration_seconds INTEGER,
    messages_count INTEGER DEFAULT 0,
    topic VARCHAR(255),
    status VARCHAR(50) DEFAULT 'active', -- active, completed, interrupted, error
    
    -- Metadatos
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Índice para búsqueda de sesiones por usuario
CREATE INDEX IF NOT EXISTS idx_realtime_sessions_user 
ON realtime_sessions(user_email);

-- Índice para búsqueda de sesiones activas
CREATE INDEX IF NOT EXISTS idx_realtime_sessions_status 
ON realtime_sessions(status);

-- Índice para búsqueda por session_id
CREATE INDEX IF NOT EXISTS idx_realtime_sessions_session_id 
ON realtime_sessions(session_id);

-- Función para actualizar updated_at automáticamente
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Trigger para realtime_usage
DROP TRIGGER IF EXISTS update_realtime_usage_updated_at ON realtime_usage;
CREATE TRIGGER update_realtime_usage_updated_at
    BEFORE UPDATE ON realtime_usage
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Trigger para realtime_sessions
DROP TRIGGER IF EXISTS update_realtime_sessions_updated_at ON realtime_sessions;
CREATE TRIGGER update_realtime_sessions_updated_at
    BEFORE UPDATE ON realtime_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Insertar datos de ejemplo (comentar en producción)
-- INSERT INTO realtime_usage (user_email, date, minutes_used, sessions_count) 
-- VALUES 
--     ('test@example.com', CURRENT_DATE, 5.5, 2),
--     ('demo@example.com', CURRENT_DATE, 12.3, 4);

-- Verificar que las tablas se crearon correctamente
SELECT 'realtime_usage' as table_name, COUNT(*) as row_count FROM realtime_usage
UNION ALL
SELECT 'realtime_sessions' as table_name, COUNT(*) as row_count FROM realtime_sessions;

-- Comentarios en las tablas para documentación
COMMENT ON TABLE realtime_usage IS 'Tracking de minutos usados por día por usuario en OpenAI Realtime API';
COMMENT ON TABLE realtime_sessions IS 'Registro detallado de cada sesión de conversación realtime';
COMMENT ON COLUMN realtime_usage.minutes_used IS 'Minutos totales usados en el día (límite: 15 min/día)';
COMMENT ON COLUMN realtime_sessions.duration_seconds IS 'Duración de la sesión en segundos';
COMMENT ON COLUMN realtime_sessions.level IS 'Nivel del alumno: A1, A2, B1, B2, C1, C2';
