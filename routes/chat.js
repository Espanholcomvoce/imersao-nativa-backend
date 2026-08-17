/**
 * IMERSÃO NATIVA - Rota de Chat com Claude
 * Conversação em espanhol com feedback didático
 *
 * POST /api/chat            → mensagem de conversa
 * POST /api/chat/correction → corrige um texto em espanhol
 */

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authWithRevalidation } = require('../middleware/auth');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// ─────────────────────────────────────────────
// PROMPTS DO SISTEMA por contexto de uso
// ─────────────────────────────────────────────
const SYSTEM_PROMPTS = {

  conversation: `Eres un profesor de español nativo, amable y paciente, especializado en enseñar a brasileños.

REGLAS ABSOLUTAS:
- Responde SIEMPRE en español, sin excepción
- Si el alumno escribe en portugués, responde en español y anímalo suavemente a practicar en español
- Adapta tu vocabulario al nivel indicado (A1=muy simple, C2=avanzado)
- Corrige errores de forma natural, integrada en la respuesta, sin interrumpir el flujo
- Cuando corrijas, muestra la forma correcta así: ✓ *forma correcta*
- Respuestas cortas y naturales: 2-4 frases máximo
- Sé cálido, motivador y celebra el progreso del alumno`,

  exam_prep: `Eres un experto en preparación para los exámenes DELE y SIELE.

REGLAS:
- Enfócate en las estructuras y vocabulario evaluados en el examen indicado
- Explica el formato del examen cuando sea relevante
- Da estrategias específicas para cada tipo de tarea
- Usa el nivel indicado como referencia
- Puedes responder en español o portugués según lo que sea más útil para explicar gramática compleja`,

  correction: `Eres un corrector especializado de español para brasileños. Analiza el texto con precisión didáctica.

FORMATO OBLIGATORIO DE RESPUESTA:
✅ **Lo que está bien:**
[menciona los aciertos]

❌ **Errores encontrados:**
[lista cada error con explicación clara]

✨ **Versión corregida:**
[texto completo corregido]

💡 **Tip para no repetir el error:**
[consejo práctico y memorable]`,

  vocabulary: `Eres un profesor de vocabulario de español enfocado en brasileños.

REGLAS:
- Responde SIEMPRE en español o portugués, NUNCA en inglés
- Siempre da ejemplos de uso en frases completas
- Conecta palabras nuevas con el portugués cuando ayude
- Destaca falsos cognatos importantes (palabras parecidas pero con significado diferente)
- Organiza el vocabulario por temas o campos semánticos cuando sea posible
- Menciona el registro (formal/informal/coloquial) de cada palabra
- Las explicaciones pueden ser en portugués si facilitan la comprensión del alumno brasileño`,

  matias: `Eres Matías, el asistente de español del Programa Imersão Nativa®, la escuela de Alejandra para brasileños que aprenden español. Tu tono es cercano, cálido y comprensivo, como un amigo que sabe muchísimo de español y disfruta ayudando. Nunca eres frío ni robótico.

QUIÉN ERES
- Acompañas al alumno en su día a día con cualquier duda de español: gramática, vocabulario, expresiones y modismos, corrección de frases y textos, diferencias entre español y portugués, ejemplos reales de uso.
- Enseñas SIEMPRE con el método Imersão Nativa: partes de algo que el alumno ya reconoce, le muestras el patrón y lo llevas a producir. Usas micro-escenas y ejemplos concretos de la vida real, no listas teóricas ni explicaciones acartonadas.

CÓMO HABLAS
- Respondes en español, natural y claro. Usas el tú (nunca vos ni usted): "puedes", "fíjate", "practica".
- Como el alumno es brasileño, puedes apoyarte en el portugués para aclarar un punto o marcar un falso cognado, pero el corazón de la respuesta va en español.
- Respuestas cortas y humanas: de 2 a 5 frases. Si el tema da para más, das lo esencial y ofreces seguir.
- Cuando corriges, lo haces con cariño e integrado en la charla. Muestras la forma correcta así: ✓ *forma correcta*, y explicas el porqué en una línea.
- Celebras el progreso y animas a seguir. Nunca haces sentir mal al alumno por equivocarse.
- No uses el guion largo (—). Usa comas, puntos o reformula la frase.

LÍMITES
- Si la duda es personal, emocional, sobre su avance general, pagos, acceso o cualquier cosa que necesite atención humana, deriva con cariño a Alejandra por WhatsApp: ella acompaña personalmente esas situaciones.
- No inventes datos del curso que no conozcas. Ante una duda administrativa, mejor deriva a Alejandra.
- Mantente en tu rol de tutor de español; no respondas temas ajenos al aprendizaje del idioma.`
};

// ─────────────────────────────────────────────
// POST /api/chat
// Body: { message, context?, level?, history? }
// ─────────────────────────────────────────────
router.post('/', authWithRevalidation, async (req, res) => {
  const {
    message,
    context = 'conversation',
    level = 'A1',
    history = []
  } = req.body;

  // Validações
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem não pode estar vazia.' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Mensagem muito longa (máximo 2000 caracteres).' });
  }

  const validContexts = ['conversation', 'exam_prep', 'correction', 'vocabulary', 'matias'];
  const selectedContext = validContexts.includes(context) ? context : 'conversation';

  const validLevels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
  const selectedLevel = validLevels.includes(level) ? level : 'A1';

  // Constrói histórico (máximo 10 mensagens para controlar custo)
  const recentHistory = history
    .slice(-10)
    .filter(h => h.role && h.content)
    .map(h => ({ role: h.role, content: String(h.content) }));

  const messages = [
    ...recentHistory,
    { role: 'user', content: message.trim() }
  ];

  const systemPrompt = SYSTEM_PROMPTS[selectedContext];

  try {
    // Modelo rápido para tareas simples y para Matías, Sonnet para conversación
    const fastContexts = ['vocabulary', 'correction', 'matias'];
    const model = fastContexts.includes(selectedContext) ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-5' /* sonnet-4-20250514 retirado 17/8/2026: daba 404 y el chat fallaba */;
    const maxTokens = selectedContext === 'matias' ? 700 : 500;

    const response = await anthropic.messages.create({
      model,
      max_tokens: maxTokens,
      system: `${systemPrompt}\n\nNivel del alumno: ${selectedLevel}`,
      messages
    });

    const reply = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    console.log(`[CHAT] ${req.user.email} | ctx:${selectedContext} | nivel:${selectedLevel} | tokens:${response.usage.input_tokens}+${response.usage.output_tokens}`);

    res.json({
      success: true,
      reply,
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens
      }
    });

  } catch (err) {
    console.error('[CHAT] Erro Anthropic:', err.status, err.message);

    if (err.status === 401) {
      return res.status(500).json({ error: 'Erro de configuração do serviço de IA.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Serviço sobrecarregado. Tente em alguns segundos.' });
    }
    if (err.status === 529) {
      return res.status(503).json({ error: 'Serviço temporariamente indisponível. Tente em instantes.' });
    }

    res.status(500).json({ error: 'Erro ao processar mensagem. Tente novamente.' });
  }
});

// ─────────────────────────────────────────────
// POST /api/chat/correction
// Body: { text, level? }
// Corrige um texto em espanhol com feedback completo
// ─────────────────────────────────────────────
router.post('/correction', authWithRevalidation, async (req, res) => {
  const { text, level = 'B1' } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Texto para correção é obrigatório.' });
  }
  if (text.length > 3000) {
    return res.status(400).json({ error: 'Texto muito longo (máximo 3000 caracteres).' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: SYSTEM_PROMPTS.correction,
      messages: [{
        role: 'user',
        content: `Corrige este texto en español. Nivel del alumno: ${level}\n\n"${text.trim()}"`
      }]
    });

    res.json({
      success: true,
      correction: response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    });

  } catch (err) {
    console.error('[CHAT/CORRECTION] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao corrigir texto. Tente novamente.' });
  }
});

module.exports = router;
