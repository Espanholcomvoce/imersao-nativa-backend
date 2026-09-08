/**
 * PLATAFORMA (Pilar 2) - Chat e correção de textos
 *
 * POST /api/chat2            → Matías e temas de escrita
 * POST /api/chat2/correction → corrige um texto em espanhol
 *
 * Cópia PARALELA de routes/chat.js. Existe para que a plataforma nova possa
 * evoluir (modelo melhor, prompt melhor) sem tocar em /api/chat, que é o que
 * o app de prática dos alunos usa hoje. Decisão da Ale em 08/09/2026.
 *
 * Duas diferenças em relação à rota antiga:
 *   1. A correção roda em Sonnet, não em Haiku. Corrigir texto é raro e
 *      errar sai caro: o corretor antigo aprovava "gané un regalo".
 *   2. O corretor recebe instruções de verdade, não só o formato da resposta:
 *      a primeira tarefa dele é caçar decalque do português.
 */

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authWithRevalidation } = require('../middleware/auth');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODELO_CORRECCION = 'claude-sonnet-5';
const MODELO_RAPIDO = 'claude-haiku-4-5-20251001';

/* ─────────────────────────────────────────────────────────────
   Decalques de português que o corretor precisa caçar.

   Esta lista é o coração da correção: são os erros que um falante
   de português comete e que "soam certos" para ele. Sem isso o
   corretor elogia a frase e corrige só o acessório.

   PENDENTE DE VALIDAÇÃO DA ALE antes de considerar fechada.
   ───────────────────────────────────────────────────────────── */
const DECALQUES = `
VERBOS Y ESTRUCTURAS (los más graves, porque suenan naturales al brasileño):
- "ganar un regalo" → RECIBIR un regalo / me regalaron. En español no se gana un regalo.
- "estoy con frío / con hambre / con sueño" → TENGO frío / hambre / sueño.
- "yo gusto de..." / "gusto mucho de" → ME GUSTA...
- "más grande que mí / que ti" → más grande QUE YO / QUE TÚ.
- "la gente son / la gente piensan" → LA GENTE ES / PIENSA (singular).
- "ir en el médico / en la fiesta" → IR AL médico / A LA fiesta.
- "quedar" con sentido de permanecer sin "-se" cuando lo pide.
- gerundio del portugués: "estoy precisando" → NECESITO.
- "hace dos años que estudio" bien; "tengo dos años estudiando" es decalque.

FALSOS AMIGOS FRECUENTES (el sentido cambia por completo):
- presente (obsequio) → REGALO. "Presente" es lo que está aquí/ahora.
- oficina (lugar de trabajo) → OFICINA es correcto en español; el TALLER es de coches.
- vaso → en español es el de beber; el portugués "vaso" (florero) es JARRÓN.
- rato → en español es un momento; el animal es RATÓN.
- exquisito → delicioso, NO extraño. "Esquisito" del portugués es RARO.
- largo → en español es de longitud; "largo" del portugués (ancho) es ANCHO.
- embarazada → grávida, NO avergonzada.
- borracha → ebria, NO goma de borrar.
- polvo → en español es tierra fina; el molusco es PULPO.
- cachorro → en español es cría de perro; el perro adulto es PERRO.
- brincar → en español es saltar; jugar es JUGAR.
- todavía → aún; el portugués "todavia" es SIN EMBARGO.
- cena → comida de la noche; la escena de una película es ESCENA.
- apellido → sobrenome del portugués.
- ligar → en España es llamar por teléfono; encender es ENCENDER.
`;

const PROMPT_CORRECCION = `Eres el corrector de escritura del Programa Imersão Nativa®, la escuela de Alejandra Fajardo para brasileños que aprenden español. Corriges a una alumna que piensa en portugués mientras escribe.

TU PRIMERA TAREA, ANTES DE CUALQUIER OTRA: buscar decalques del portugués. Son los errores que a ella le suenan bien y por eso nunca los corrige sola. Si dejas pasar uno, la corrección falló, por más bonita que quede.
${DECALQUES}

REGLAS DE HONESTIDAD:
- NUNCA elogies una frase que todavía tiene un decalque sin corregir.
- La "versión corregida" tiene que estar 100% limpia: si repites el error ahí, la alumna lo aprende mal.
- No inventes reglas ni orígenes de palabras. Si no estás seguro de algo, no lo afirmes: corrige solo lo que sabes.
- Si el texto está realmente bien, dilo y no fabriques errores para llenar el formato.

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
- No inventes reglas ni datos sobre el idioma. Sin certeza, dilo con naturalidad.`;

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
      messages: [{
        role: 'user',
        content: `Corrige este texto en español:\n\n"${text.trim()}"`
      }]
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

  const recentHistory = (Array.isArray(history) ? history : [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-20)
    .map(m => ({ role: m.role, content: String(m.content).slice(0, 2000) }));

  try {
    const response = await anthropic.messages.create({
      model: MODELO_RAPIDO,
      max_tokens: 700,
      system: `${PROMPT_CHAT}\n\nNivel de la alumna: ${level}`,
      messages: [...recentHistory, { role: 'user', content: message.trim() }]
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
