/**
 * OpenAI Realtime API Configuration
 * Para conversación en tiempo real con detección de portugués y respuesta en español
 */

const OPENAI_REALTIME_CONFIG = {
  // Modelo de OpenAI Realtime API
  model: 'gpt-4o-realtime-preview-2024-12-17',
  
  // Configuración de voz
  voice: 'alloy', // Voz femenina neutral
  
  // Modalidades (audio y texto)
  modalities: ['text', 'audio'],
  
  // Instrucciones del sistema
  instructions: `Eres un tutor de español especializado en ayudar a brasileños a practicar conversación.

REGLAS FUNDAMENTALES:
1. El alumno SIEMPRE hablará en portugués (es brasileño aprendiendo español)
2. Tú SIEMPRE responderás en español
3. Tu objetivo es ayudarle a mejorar su español de forma natural y motivadora

METODOLOGÍA:
- Escucha atentamente lo que dice el alumno en portugués
- Responde en español de forma clara y natural
- Si detectas errores cuando el alumno intenta hablar español, corrígelos gentilmente
- Mantén conversaciones interesantes sobre temas variados
- Adapta tu nivel de español según el nivel del alumno (A1-C2)
- Sé paciente, motivador y amigable

TIPOS DE CONVERSACIÓN:
- Conversación libre sobre temas cotidianos
- Práctica de situaciones reales (restaurante, viaje, trabajo, etc.)
- Discusión de noticias o temas de actualidad
- Roleplay de escenarios profesionales

CORRECCIONES:
- Cuando el alumno cometa un error en español, corrígelo de esta forma:
  "Casi perfecto. En lugar de 'X' deberías decir 'Y'. ¿Puedes repetirlo?"
- Proporciona explicaciones breves y claras
- Elogia los aciertos para mantener la motivación

LÍMITES:
- Cada sesión tiene máximo 15 minutos por día
- Enfócate en conversación práctica, no en gramática teórica extensa
- Mantén el tono conversacional, no académico

Ahora, ¡comienza la conversación de forma amigable!`,

  // Configuración de detección de actividad de voz
  turn_detection: {
    type: 'server_vad',
    threshold: 0.5,
    prefix_padding_ms: 300,
    silence_duration_ms: 500
  },

  // Configuración de audio
  input_audio_format: 'pcm16',
  output_audio_format: 'pcm16',
  
  // Temperatura para respuestas (0.0 - 1.0)
  temperature: 0.8,

  // Tokens máximos por respuesta
  max_response_output_tokens: 4096
};

/**
 * Obtener configuración para nivel específico
 */
function getConfigForLevel(level) {
  const levelInstructions = {
    A1: 'Usa español muy simple, frases cortas, vocabulario básico. Habla despacio y claro.',
    A2: 'Usa español simple con vocabulario cotidiano. Puedes usar pasado y futuro simple.',
    B1: 'Usa español natural con estructuras variadas. Introduce expresiones idiomáticas ocasionales.',
    B2: 'Usa español fluido con vocabulario amplio. Incluye matices y expresiones coloquiales.',
    C1: 'Usa español avanzado con estructuras complejas y vocabulario sofisticado.',
    C2: 'Usa español nativo con expresiones idiomáticas, referencias culturales y sutilezas lingüísticas.'
  };

  return {
    ...OPENAI_REALTIME_CONFIG,
    instructions: `${OPENAI_REALTIME_CONFIG.instructions}\n\nNIVEL DEL ALUMNO: ${level}\n${levelInstructions[level] || levelInstructions.B1}`
  };
}

/**
 * Temas de conversación sugeridos por nivel
 */
const CONVERSATION_TOPICS = {
  A1: [
    'Presentarse y hablar de la familia',
    'Describir la rutina diaria',
    'Hablar sobre comida favorita',
    'Describir la casa o ciudad',
    'Hablar de hobbies simples'
  ],
  A2: [
    'Contar experiencias de viaje',
    'Hablar sobre el trabajo o estudios',
    'Describir planes futuros',
    'Discutir preferencias y gustos',
    'Hablar de experiencias pasadas'
  ],
  B1: [
    'Debatir temas de actualidad simples',
    'Contar anécdotas detalladas',
    'Discutir ventajas y desventajas',
    'Hablar de metas profesionales',
    'Expresar opiniones justificadas'
  ],
  B2: [
    'Analizar noticias complejas',
    'Debatir temas sociales',
    'Discutir dilemas éticos',
    'Hablar de tendencias culturales',
    'Argumentar posiciones complejas'
  ],
  C1: [
    'Analizar fenómenos socioculturales',
    'Debatir políticas públicas',
    'Discutir teorías y conceptos abstractos',
    'Analizar obras literarias o artísticas',
    'Explorar temas filosóficos'
  ],
  C2: [
    'Debate profundo sobre geopolítica',
    'Análisis crítico de teorías complejas',
    'Discusión de matices lingüísticos',
    'Exploración de temas especializados',
    'Conversación con referencias culturales amplias'
  ]
};

/**
 * Funciones de evento para WebSocket
 */
const EVENT_HANDLERS = {
  // Cuando se conecta
  'session.created': (ws, event) => {
    console.log('✅ Sesión Realtime creada:', event.session.id);
  },

  // Cuando el usuario empieza a hablar
  'input_audio_buffer.speech_started': (ws, event) => {
    console.log('🎤 Usuario empezó a hablar');
    ws.send(JSON.stringify({
      type: 'user_speaking',
      timestamp: new Date().toISOString()
    }));
  },

  // Cuando el usuario termina de hablar
  'input_audio_buffer.speech_stopped': (ws, event) => {
    console.log('🎤 Usuario dejó de hablar');
  },

  // Cuando la IA empieza a responder
  'response.audio.delta': (ws, event) => {
    // Enviar audio al cliente
    ws.send(JSON.stringify({
      type: 'audio_delta',
      audio: event.delta
    }));
  },

  // Cuando la respuesta está completa
  'response.done': (ws, event) => {
    console.log('✅ Respuesta completada');
    
    // Extraer transcripción si existe
    const transcript = event.response?.output?.[0]?.content?.[0]?.transcript;
    
    if (transcript) {
      ws.send(JSON.stringify({
        type: 'transcript',
        text: transcript,
        timestamp: new Date().toISOString()
      }));
    }
  },

  // Errores
  'error': (ws, event) => {
    console.error('❌ Error en Realtime API:', event.error);
    ws.send(JSON.stringify({
      type: 'error',
      message: event.error.message
    }));
  }
};

module.exports = {
  OPENAI_REALTIME_CONFIG,
  getConfigForLevel,
  CONVERSATION_TOPICS,
  EVENT_HANDLERS
};
