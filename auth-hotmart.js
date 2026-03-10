/**
 * Routes: Auth Hotmart (Mejorado)
 * Autenticación y validación de compras de Hotmart
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const HOTMART_HOTTOK = process.env.HOTMART_HOTTOK;
const JWT_EXPIRES_IN = '7d'; // Token expira en 7 días

/**
 * POST /api/auth/login
 * Login con email (validar en Hotmart)
 */
router.post('/login', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email es requerido'
      });
    }

    // Validar formato de email
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({
        success: false,
        error: 'Formato de email inválido'
      });
    }

    // Verificar compra activa en Hotmart
    const isActive = await verifyHotmartPurchase(email);

    if (!isActive) {
      return res.status(403).json({
        success: false,
        error: 'No tienes una compra activa. Adquiere el curso en Hotmart.',
        redirect_url: 'https://pay.hotmart.com/your-product-url' // Cambiar por URL real
      });
    }

    // Generar JWT token
    const token = jwt.sign(
      { 
        email,
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      message: 'Login exitoso',
      data: {
        token,
        email,
        expires_in: JWT_EXPIRES_IN
      }
    });

  } catch (error) {
    console.error('❌ Error en login:', error);
    res.status(500).json({
      success: false,
      error: 'Error en el servidor al procesar login'
    });
  }
});

/**
 * POST /api/auth/validate-hotmart
 * Validar si un email tiene compra activa en Hotmart
 */
router.post('/validate-hotmart', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email es requerido'
      });
    }

    const isActive = await verifyHotmartPurchase(email);

    res.json({
      success: true,
      data: {
        email,
        has_active_purchase: isActive,
        checked_at: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error al validar Hotmart:', error);
    res.status(500).json({
      success: false,
      error: 'Error al verificar compra en Hotmart'
    });
  }
});

/**
 * POST /api/auth/refresh
 * Refrescar token JWT
 */
router.post('/refresh', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({
        success: false,
        error: 'Token es requerido'
      });
    }

    // Verificar token (incluso si está expirado)
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        // Token expirado, extraer email
        decoded = jwt.decode(token);
      } else {
        throw error;
      }
    }

    if (!decoded || !decoded.email) {
      return res.status(401).json({
        success: false,
        error: 'Token inválido'
      });
    }

    // Verificar que la compra sigue activa
    const isActive = await verifyHotmartPurchase(decoded.email);

    if (!isActive) {
      return res.status(403).json({
        success: false,
        error: 'Tu acceso ha expirado. Renueva tu suscripción.',
        redirect_url: 'https://pay.hotmart.com/your-product-url'
      });
    }

    // Generar nuevo token
    const newToken = jwt.sign(
      { 
        email: decoded.email,
        iat: Math.floor(Date.now() / 1000)
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );

    res.json({
      success: true,
      message: 'Token refrescado exitosamente',
      data: {
        token: newToken,
        email: decoded.email,
        expires_in: JWT_EXPIRES_IN
      }
    });

  } catch (error) {
    console.error('❌ Error al refrescar token:', error);
    res.status(500).json({
      success: false,
      error: 'Error al refrescar token'
    });
  }
});

/**
 * GET /api/auth/me
 * Obtener información del usuario autenticado
 */
router.get('/me', verifyTokenMiddleware, async (req, res) => {
  try {
    // Verificar que la compra sigue activa
    const isActive = await verifyHotmartPurchase(req.user.email);

    res.json({
      success: true,
      data: {
        email: req.user.email,
        has_active_purchase: isActive,
        token_expires_at: new Date(req.user.exp * 1000).toISOString()
      }
    });

  } catch (error) {
    console.error('❌ Error al obtener info del usuario:', error);
    res.status(500).json({
      success: false,
      error: 'Error al obtener información del usuario'
    });
  }
});

/**
 * POST /api/auth/webhook/hotmart
 * Webhook para recibir notificaciones de Hotmart
 */
router.post('/webhook/hotmart', async (req, res) => {
  try {
    const event = req.body;

    // Validar firma de Hotmart (si está configurada)
    const isValid = validateHotmartSignature(req);
    
    if (!isValid) {
      console.warn('⚠️ Firma de webhook inválida');
      return res.status(401).json({
        success: false,
        error: 'Firma inválida'
      });
    }

    console.log('📥 Webhook Hotmart recibido:', event.event);

    // Procesar diferentes tipos de eventos
    switch (event.event) {
      case 'PURCHASE_COMPLETE':
        await handlePurchaseComplete(event.data);
        break;
      
      case 'PURCHASE_REFUNDED':
        await handlePurchaseRefunded(event.data);
        break;
      
      case 'PURCHASE_CANCELED':
        await handlePurchaseCanceled(event.data);
        break;
      
      case 'SUBSCRIPTION_CANCELED':
        await handleSubscriptionCanceled(event.data);
        break;
      
      default:
        console.log('ℹ️ Evento no manejado:', event.event);
    }

    res.json({ success: true });

  } catch (error) {
    console.error('❌ Error procesando webhook:', error);
    res.status(500).json({
      success: false,
      error: 'Error procesando webhook'
    });
  }
});

// ==========================================
// FUNCIONES AUXILIARES
// ==========================================

/**
 * Verificar compra activa en Hotmart
 */
async function verifyHotmartPurchase(email) {
  try {
    if (!HOTMART_HOTTOK) {
      console.warn('⚠️ HOTMART_HOTTOK no configurado - modo desarrollo');
      return true; // En desarrollo, permitir acceso
    }

    // Llamar a API de Hotmart para verificar suscripción
    const response = await axios.get('https://api-sec-vlc.hotmart.com/payments/api/v1/subscriptions', {
      headers: {
        'Authorization': `Bearer ${HOTMART_HOTTOK}`,
        'Content-Type': 'application/json'
      },
      params: {
        subscriber_email: email,
        status: 'ACTIVE'
      }
    });

    // Verificar si hay suscripciones activas
    return response.data.items && response.data.items.length > 0;

  } catch (error) {
    console.error('❌ Error al verificar compra en Hotmart:', error.message);
    
    // En caso de error de API, permitir acceso (evitar bloquear usuarios por errores técnicos)
    if (error.response?.status >= 500) {
      console.warn('⚠️ Error de Hotmart API - permitiendo acceso temporalmente');
      return true;
    }
    
    return false;
  }
}

/**
 * Validar firma de webhook de Hotmart
 */
function validateHotmartSignature(req) {
  const signature = req.headers['x-hotmart-hottok'];
  
  if (!signature || !HOTMART_HOTTOK) {
    return false;
  }

  // Comparar firma
  return signature === HOTMART_HOTTOK;
}

/**
 * Manejar compra completada
 */
async function handlePurchaseComplete(data) {
  console.log('✅ Compra completada:', data.buyer?.email);
  
  // Aquí podrías:
  // - Enviar email de bienvenida
  // - Crear usuario en base de datos
  // - Activar acceso
}

/**
 * Manejar reembolso
 */
async function handlePurchaseRefunded(data) {
  console.log('💰 Reembolso procesado:', data.buyer?.email);
  
  // Aquí podrías:
  // - Desactivar acceso del usuario
  // - Enviar email de confirmación
}

/**
 * Manejar cancelación de compra
 */
async function handlePurchaseCanceled(data) {
  console.log('❌ Compra cancelada:', data.buyer?.email);
  
  // Similar a reembolso
}

/**
 * Manejar cancelación de suscripción
 */
async function handleSubscriptionCanceled(data) {
  console.log('🔴 Suscripción cancelada:', data.subscriber?.email);
  
  // Aquí podrías:
  // - Marcar fecha de fin de acceso
  // - Enviar email de despedida
}

/**
 * Middleware para verificar token JWT
 */
function verifyTokenMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Token no proporcionado'
      });
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET);

    req.user = decoded;
    next();

  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token expirado',
        code: 'TOKEN_EXPIRED'
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Token inválido'
    });
  }
}

module.exports = {
  router,
  verifyToken: verifyTokenMiddleware
};
