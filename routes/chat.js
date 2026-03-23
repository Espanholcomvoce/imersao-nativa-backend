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
const { authMiddleware } = require('../middleware/auth');

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
- Las explicaciones pueden ser en portugués si facilitan la comprensión del alumno brasileño`
};

// ─────────────────────────────────────────────
// POST /api/chat
// Body: { message, context?, level?, history? }
// ─────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
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

  const validContexts = ['conversation', 'exam_prep', 'correction', 'vocabulary'];
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
    // Modelo rápido para tareas simples, Sonnet para conversación
    const fastContexts = ['vocabulary', 'correction'];
    const model = fastContexts.includes(selectedContext) ? 'claude-haiku-4-5-20251001' : 'claude-sonnet-4-20250514';

    const response = await anthropic.messages.create({
      model,
      max_tokens: 500,
      system: `${systemPrompt}\n\nNivel del alumno: ${selectedLevel}`,
      messages
    });

    const reply = response.content[0]?.text || '';

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
router.post('/correction', authMiddleware, async (req, res) => {
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
      correction: response.content[0]?.text || ''
    });

  } catch (err) {
    console.error('[CHAT/CORRECTION] Erro:', err.message);
    res.status(500).json({ error: 'Erro ao corrigir texto. Tente novamente.' });
  }
});

module.exports = router;
