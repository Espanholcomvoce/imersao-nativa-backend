/**
 * Routes: Realtime Conversation (WebSocket)
 * Endpoint para conversación en tiempo real con OpenAI Realtime API
 */

const express = require('express');
const router = express.Router();
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');

const { 
  getConfigForLevel, 
  CONVERSATION_TOPICS,
  EVENT_HANDLERS 
} = require('../utils/openai-realtime-config');

const {
  checkDailyLimit,
  getUserStats,
  createSession,
  endSession
} = require('../middleware/realtime-limiter');

const { verifyToken } = require('../middleware/auth');

// Map para almacenar sesiones activas
const activeSessions = new Map();

/**
 * GET /api/realtime/status
 * Obtener estado y estadísticas del usuario
 */
router.get('/status', verifyToken, async (req, res) => {
  try {
    const stats = await getUserStats(req.user.email);
    
    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    console.error('❌ Error al obtener status:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener estadísticas'
    });
  }
});

/**
 * GET /api/realtime/topics/:level
 * Obtener temas de conversación sugeridos por nivel
 */
router.get('/topics/:level', verifyToken, (req, res) => {
  const { level } = req.params;
  const topics = CONVERSATION_TOPICS[level.toUpperCase()] || CONVERSATION_TOPICS.B1;
  
  res.json({
    success: true,
    data: {
      level: level.toUpperCase(),
      topics: topics
    }
  });
});

/**
 * POST /api/realtime/session/start
 * Iniciar nueva sesión de conversación
 */
router.post('/session/start', verifyToken, checkDailyLimit, async (req, res) => {
  try {
    const { level, topic } = req.body;
    
    if (!level || !['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(level.toUpperCase())) {
      return res.status(400).json({
        success: false,
        error: 'Nivel inválido. Debe ser: A1, A2, B1, B2, C1 o C2'
      });
    }

    // Generar session ID único
    const sessionId = uuidv4();
    
    // Crear registro en base de datos
    await createSession(req.user.email, sessionId, level.toUpperCase(), topic);
    
    res.json({
      success: true,
      data: {
        session_id: sessionId,
        level: level.toUpperCase(),
        topic: topic || null,
        minutes_remaining: req.realtimeUsage.minutesRemaining,
        websocket_url: `/api/realtime/ws?session_id=${sessionId}`
      }
    });
  } catch (error) {
    console.error('❌ Error al iniciar sesión:', error);
    res.status(500).json({
      success: false,
      error: 'Error al iniciar sesión de conversación'
    });
  }
});

/**
 * POST /api/realtime/session/end
 * Finalizar sesión manualmente
 */
router.post('/session/end', verifyToken, async (req, res) => {
  try {
    const { session_id, messages_count } = req.body;
    
    if (!session_id) {
      return res.status(400).json({
        success: false,
        error: 'session_id es requerido'
      });
    }

    // Cerrar conexión WebSocket si existe
    if (activeSessions.has(session_id)) {
      const sessionData = activeSessions.get(session_id);
      if (sessionData.openaiWs && sessionData.openaiWs.readyState === WebSocket.OPEN) {
        sessionData.openaiWs.close();
      }
      activeSessions.delete(session_id);
    }

    // Finalizar en base de datos
    await endSession(session_id, messages_count || 0, 'completed');
    
    // Obtener estadísticas actualizadas
    const stats = await getUserStats(req.user.email);
    
    res.json({
      success: true,
      message: 'Sesión finalizada correctamente',
      data: stats.today
    });
  } catch (error) {
    console.error('❌ Error al finalizar sesión:', error);
    res.status(500).json({
      success: false,
      error: 'Error al finalizar sesión'
    });
  }
});

/**
 * Configurar WebSocket Server
 * Debe ser llamado desde server.js con el servidor HTTP
 */
function setupWebSocketServer(server) {
  const wss = new WebSocket.Server({ 
    server,
    path: '/api/realtime/ws'
  });

  wss.on('connection', async (clientWs, request) => {
    console.log('🔌 Nueva conexión WebSocket');

    // Extraer session_id de query params
    const url = new URL(request.url, `http://${request.headers.host}`);
    const sessionId = url.searchParams.get('session_id');

    if (!sessionId) {
      clientWs.close(4000, 'session_id requerido');
      return;
    }

    // Verificar que la sesión existe
    // En producción, verificar también el token JWT aquí
    
    let openaiWs = null;
    let messageCount = 0;

    try {
      // Conectar a OpenAI Realtime API
      const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
      
      if (!OPENAI_API_KEY) {
        throw new Error('OPENAI_API_KEY no configurada');
      }

      openaiWs = new WebSocket(
        'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-12-17',
        {
          headers: {
            'Authorization': `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'realtime=v1'
          }
        }
      );

      // Almacenar sesión activa
      activeSessions.set(sessionId, {
        clientWs,
        openaiWs,
        sessionId,
        startTime: Date.now(),
        messageCount: 0
      });

      // ==========================================
      // EVENTOS DE OPENAI WEBSOCKET
      // ==========================================

      openaiWs.on('open', () => {
        console.log('✅ Conectado a OpenAI Realtime API');
        
        // Configurar sesión con nivel específico
        // En producción, obtener nivel desde la base de datos según sessionId
        const config = getConfigForLevel('B1'); // Por defecto B1
        
        openaiWs.send(JSON.stringify({
          type: 'session.update',
          session: config
        }));

        // Notificar al cliente que está listo
        clientWs.send(JSON.stringify({
          type: 'connected',
          session_id: sessionId,
          timestamp: new Date().toISOString()
        }));
      });

      openaiWs.on('message', (data) => {
        try {
          const event = JSON.parse(data.toString());
          
          // Manejar eventos específicos
          const handler = EVENT_HANDLERS[event.type];
          if (handler) {
            handler(clientWs, event);
          }

          // Reenviar todos los eventos al cliente
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(data);
          }

          // Contar mensajes
          if (event.type === 'response.done') {
            messageCount++;
            activeSessions.get(sessionId).messageCount = messageCount;
          }

        } catch (error) {
          console.error('❌ Error procesando mensaje de OpenAI:', error);
        }
      });

      openaiWs.on('error', (error) => {
        console.error('❌ Error en WebSocket de OpenAI:', error);
        
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.send(JSON.stringify({
            type: 'error',
            error: 'Error en conexión con OpenAI',
            timestamp: new Date().toISOString()
          }));
        }
      });

      openaiWs.on('close', () => {
        console.log('🔌 Desconectado de OpenAI Realtime API');
        
        // Finalizar sesión
        endSession(sessionId, messageCount, 'completed');
        activeSessions.delete(sessionId);
        
        if (clientWs.readyState === WebSocket.OPEN) {
          clientWs.close();
        }
      });

      // ==========================================
      // EVENTOS DE CLIENT WEBSOCKET
      // ==========================================

      clientWs.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          
          // Reenviar mensaje a OpenAI
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(message));
          }
        } catch (error) {
          console.error('❌ Error procesando mensaje del cliente:', error);
        }
      });

      clientWs.on('close', () => {
        console.log('🔌 Cliente desconectado');
        
        // Cerrar conexión con OpenAI
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
        
        // Finalizar sesión
        endSession(sessionId, messageCount, 'interrupted');
        activeSessions.delete(sessionId);
      });

      clientWs.on('error', (error) => {
        console.error('❌ Error en WebSocket del cliente:', error);
      });

    } catch (error) {
      console.error('❌ Error al establecer conexión:', error);
      
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'error',
          error: error.message,
          timestamp: new Date().toISOString()
        }));
        clientWs.close();
      }
      
      // Finalizar sesión con error
      endSession(sessionId, 0, 'error');
    }
  });

  console.log('✅ WebSocket Server configurado en /api/realtime/ws');
  
  return wss;
}

/**
 * Limpiar sesiones inactivas (llamar periódicamente)
 */
function cleanupInactiveSessions() {
  const now = Date.now();
  const MAX_SESSION_TIME = 15 * 60 * 1000; // 15 minutos

  for (const [sessionId, session] of activeSessions.entries()) {
    if (now - session.startTime > MAX_SESSION_TIME) {
      console.log(`⚠️ Cerrando sesión inactiva: ${sessionId}`);
      
      if (session.openaiWs && session.openaiWs.readyState === WebSocket.OPEN) {
        session.openaiWs.close();
      }
      
      if (session.clientWs && session.clientWs.readyState === WebSocket.OPEN) {
        session.clientWs.send(JSON.stringify({
          type: 'session_timeout',
          message: 'Sesión finalizada por tiempo máximo (15 min)'
        }));
        session.clientWs.close();
      }
      
      endSession(sessionId, session.messageCount, 'timeout');
      activeSessions.delete(sessionId);
    }
  }
}

// Ejecutar limpieza cada 1 minuto
setInterval(cleanupInactiveSessions, 60000);

module.exports = {
  router,
  setupWebSocketServer
};
