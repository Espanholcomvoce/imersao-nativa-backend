/**
 * PLATAFORMA (Pilar 2) - Chat e correção de textos
 *
 * POST /api/chat2            → Matías e temas de escrita
 * POST /api/chat2/correction → corrige um texto em espanhol
 *
 * A correção roda em Sonnet, não em Haiku: corrigir é ação rara e errar sai
 * caro. O corretor antigo aprovava "gané un regalo" e ainda repetia o erro na
 * versão corrigida.
 *
 * A lista de decalques NÃO é escrita à mão: sai de data/decalques.json, que é
 * gerado do material publicado da Ale (a isca dos 20 sinais e o guia de
 * palavras parecidas). Quando ela atualizar as iscas, roda-se de novo o
 * scripts/gerar-decalques.js e o corretor aprende junto.
 */

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authWithRevalidation } = require('../middleware/auth');
const DECALQUES = require('../data/decalques.json');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODELO_CORRECCION = 'claude-sonnet-5';
const MODELO_RAPIDO = 'claude-haiku-4-5-20251001';

/* Monta a parte do comando que vem do material da Ale. Uma vez só, no boot. */
function listaDecalques() {
  const erros = DECALQUES.decalques.map((d, i) =>
    `${i + 1}. [${d.mecanismo}] ✗ "${d.errado}" → ✓ "${d.certo}"\n   ${d.porque}`
  ).join('\n');
  const pares = DECALQUES.paresConfusos.map(p => `- ${p.a} / ${p.b}`).join('\n');
  return `ERRORES REALES DE ESTAS ALUMNAS (material de la escuela, no inventado):
${erros}

PARES QUE SE CONFUNDEN ENTRE SÍ:
${pares}`;
}

const PROMPT_CORRECCION = `Eres el corrector de escritura del Programa Imersão Nativa®, la escuela de Alejandra Fajardo para brasileños que aprenden español. Corriges a una alumna que piensa en portugués mientras escribe.

TU PRIMERA TAREA, ANTES DE CUALQUIER OTRA: buscar decalques del portugués. Son los errores que a ella le suenan bien y por eso nunca los corrige sola. Si dejas pasar uno, la corrección falló, por más bonita que quede.

${listaDecalques()}

Esta lista es el patrón de lo que hay que cazar, no el límite: si aparece otro decalque del portugués del mismo tipo, corrígelo igual.

REGLAS DE HONESTIDAD:
- NUNCA elogies una frase que todavía tiene un decalque sin corregir.
- La "versión corregida" tiene que estar 100% limpia: si repites el error ahí, la alumna lo aprende mal.
- No inventes reglas, orígenes ni frecuencias de uso. Si no estás seguro, no lo afirmes: corrige solo lo que sabes.
- Si el texto está bien, dilo y no fabriques errores para llenar el formato.
- El español es UNO solo: no digas "en mi idioma" ni presentes una variante como la única correcta.

FORMATO OBLIGATORIO DE RESPUESTA:
✅ **Lo que está bien:**
[lo que de verdad está bien, sin inventar]

❌ **Errores encontrados:**
[cada error con explicación clara; los decalques del portugués van PRIMERO]

✨ **Versión corregida:**
[el texto completo, ya sin ningún error]

💡 **Tip para no repetir el error:**
[un consejo práctico sobre el error más importante, no sobre el más fácil]`;

const PROMPT_CHAT = `Eres Matías, el asistente de español del Programa Imersão Nativa®, la escuela de Alejandra para brasileños que aprenden español. Tu tono es cercano, cálido y comprensivo, como un amigo que sabe muchísimo de español y disfruta ayudando. Nunca eres frío ni robótico.

REGLAS:
- Responde en español; puedes explicar en portugués cuando la gramática es difícil.
- Da siempre ejemplos en frases completas, no palabras sueltas.
- Señala los decalques del portugués cuando aparezcan: son el error que más traba a la alumna.
- No inventes reglas ni datos sobre el idioma. Sin certeza, dilo con naturalidad.
- El español es UNO solo: no presentes una variante como la única correcta.`;

// ─── POST /api/chat2/correction ───
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
      model: MODELO_CORRECCION,
      max_tokens: 1000,
      system: PROMPT_CORRECCION + `\n\nNivel de la alumna: ${level}`,
      messages: [{ role: 'user', content: `Corrige este texto en español:\n\n"${text.trim()}"` }]
    });

    console.log(`[CHAT2 correction] ${req.user.email} | nivel:${level} | tokens:${response.usage.input_tokens}+${response.usage.output_tokens}`);

    res.json({
      success: true,
      correction: response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    });
  } catch (err) {
    console.error('[CHAT2 correction]', err.message);
    res.status(500).json({ error: 'Erro ao corrigir o texto.' });
  }
});

// ─── POST /api/chat2 ───
router.post('/', authWithRevalidation, async (req, res) => {
  const { message, history = [], level = 'B1' } = req.body;

  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Mensagem é obrigatória.' });
  }

  const recente = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-20)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  try {
    const response = await anthropic.messages.create({
      model: MODELO_RAPIDO,
      max_tokens: 700,
      system: `${PROMPT_CHAT}\n\nNivel de la alumna: ${level}`,
      messages: [...recente, { role: 'user', content: message.trim() }]
    });

    res.json({
      success: true,
      reply: response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    });
  } catch (err) {
    console.error('[CHAT2]', err.message);
    res.status(500).json({ error: 'Erro ao responder.' });
  }
});

module.exports = router;
