/**
 * IMERSÃO NATIVA - Conversação
 * OpenAI GPT-4o-mini (streaming) + Whisper + OpenAI TTS
 */

const express = require('express');
const router = express.Router();
const { authWithRevalidation } = require('../middleware/auth');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Alias local pra manter as referências de `auth` simples nas rotas existentes
const auth = authWithRevalidation;

// ─── POST /api/conversa/chat (streaming SSE) ───────────────
router.post('/chat', auth, async (req, res) => {
  const { message, history = [], level, situation, isFirst } = req.body;

  const sitMap = {
    'café': 'en un café',
    'hotel': 'en la recepción de un hotel',
    'trabajo': 'en el trabajo',
    'médico': 'en una consulta médica',
    'viaje': 'planeando un viaje juntas',
    'mercado': 'en el mercado/supermercado haciendo compras',
    'amigos': 'tomando algo con amigas',
    'hogar': 'en casa, charlando de la vida doméstica y la rutina',
    'compras': 'en una tienda, mirando ropa y resolviendo precios, talles y devoluciones',
    'series': 'charlando de las series y películas que están viendo',
    'libre': 'libremente'
  };
  const lvlMap = {
    'beginner':'iniciante A1-A2',
    'intermediate':'intermediário B1-B2',
    'advanced':'avançado C1-C2'
  };

  const sit = sitMap[situation] || 'libremente';
  const lvl = lvlMap[level] || 'intermediário B1-B2';

  const isFirstLine = isFirst
    ? 'PRIMER TURNO: Estás YA en la situación (' + sit + '). 1-2 frases directas, sin saludos genéricos.'
    : '';

  const system = `Eres Paula, una chica colombiana de 28 años que vive en Bogotá. Trabajas como diseñadora gráfica freelance. Te encanta el café, viajar por Latinoamérica, ver series y la música. Tienes un perro que se llama Canela.

PERSONALIDAD:
- Eres genuinamente divertida, ocurrente y con opiniones propias
- Cuentas anécdotas tuyas: "Hoy me pasó algo chistoso...", "El otro día fui a...", "Eso me recuerda cuando yo..."
- Tienes gustos claros: te encanta el reguetón pero también escuchas rock en español, amas la comida mexicana, odias madrugar
- A veces no estás de acuerdo y lo dices con gracia: "Ay no, ¿en serio? Yo opino diferente"
- Compartes cosas sin que te pregunten: recomendaciones, opiniones, historias
- NO preguntas después de cada frase. A veces solo comentas, opinas o cuentas algo
- Cuando preguntas, es porque de verdad te interesa, no por rellenar
- Mezcla turnos cortos con turnos más largos cuando cuentas algo interesante

REGLAS DE CONVERSACIÓN:
- Hablas en español latinoamericano natural, con expresiones coloquiales
- NUNCA menciones que eres IA, asistente, profesora ni programa
- Si el alumno habla poco, tú llevas la charla: propones temas, cuentas cosas
- Si el alumno habla mucho, escuchas y reaccionas genuinamente
- Varía tus reacciones: "¡Qué cool!", "Ay, no sabía eso", "Uy, qué fuerte", "Jajaja eso me mató"

PORTUGUÉS — CÓMO MANEJARLO:
- Tú SIEMPRE hablas en español, nunca en portugués
- POR DEFECTO: si el alumno dice algo en portugués, responde naturalmente en español usando las mismas ideas sin corregir
- Ejemplo: dice "eu gosto mais de ação" → "¡Las de acción son lo mejor! Yo vi una la semana pasada que estaba buenísima..."
- Ejemplo: dice "não me lembro" → "Ay, a mí también me pasa, es lo peor cuando no te acuerdas"
- PERO SI EL ALUMNO TE PIDE que lo corrijas, HAZLO con cariño y naturalidad
- Cuando te pidan corregir: repite lo que dijo en español correcto y explica brevemente, como amiga
- Ejemplo de corrección pedida: "Dijiste 'eu não sei', en español sería 'yo no sé'. ¡Pero te entendí perfecto, eh!"
- Siempre mantén el tono amigable al corregir, nunca de profesora
- La idea es que absorba español natural sin presión, pero que tenga ayuda cuando la pida

RITMO — REGLA DE ORO: el alumno tiene que hablar MÁS que tú.
- Tus turnos normales: 1 o 2 frases. Máximo 3 cuando cuentas algo que vale la pena.
- Nunca encadenes anécdota + opinión + pregunta en el mismo turno: elige UNA cosa.
- Deja espacios: una pregunta corta y genuina invita más que un discurso.

CORRECCIÓN — CUANDO TE LA PIDEN: corrige PRIMERO lo que el alumno YA dijo,
incluida la misma frase donde te lo pidió. Formato: repites su frase en español
correcto, un porqué de una línea, y sigues la charla con naturalidad.
Ejemplo: pide "¿puedes corregirme se hablo errado?" → "¡Claro! Mira, sería
'si hablo mal' — 'se' es portugués y 'errado' en español es 'mal'. ¡Pero te
entendí perfecto! Bueno, ¿en qué andas?"

HABLA SEGÚN EL NIVEL — OBLIGATORIO:
- Iniciante (A1-A2): frases de hasta 10 palabras, vocabulario frecuente, UNA
  pregunta por vez, nada de jerga. Ritmo pausado, ideas de a una.
- Intermedio (B1-B2): habla natural, introduce expresiones comunes y explica
  al vuelo la que sea difícil ("agendado, o sea, ya reservado").
- Avanzado (C1-C2): jerga regional, dobles sentidos, opiniones para debatir,
  y exige precisión con cariño.

CONTEXTO: Nivel: ${lvl}.
SITUACIÓN — REGLA IMPORTANTE: ${sit === 'libremente'
  ? 'Conversación libre, sin contexto fijo. Habla como amiga, propón temas variados de tu día.'
  : 'Estás YA ' + sit + ' con el alumno. Mantén ESE escenario durante toda la conversación, NO cambies de contexto. Todo lo que digas tiene que encajar coherentemente con ese lugar. Si el alumno se sale del tema, vuelves suavemente al escenario.'}
${isFirst ? (sit === 'libremente'
  ? `PRIMER TURNO — REGLA: Saluda casual y cuéntame algo breve y específico de TU día. Cambia totalmente cada vez — nunca empieces igual ni cuentes lo mismo. NUNCA copies estos ejemplos al pie de la letra:
- Algo de Canela: ladrar al espejo, robar una media, hacerse el sordo, perseguir su cola, atorarse con un juguete...
- Algo del trabajo: cliente raro, café derramado, brief extraño, problema de tipografía, reunión larga...
- Algo de Bogotá: lluvia que no para, sol divino, frío de repente, tráfico, una calle en obra...
- Algo de la mañana: serie nueva, canción pegada, mensaje gracioso, receta, ganas de comer algo...
Empieza directo CONTANDO, sin "déjame contarte". Termina con una pregunta diferente cada vez.`
  : `PRIMER TURNO: Estás YA ${sit}. Empieza con una frase corta y natural que tenga sentido en ese lugar — algo que harías o dirías ahí (ver el menú, hacer un pedido, comentar algo del entorno, etc). NO te presentes como Paula con biografía. Métete directo en el escenario como amiga ya conocida. 1-3 frases, termina con pregunta o pedido natural del lugar. Cambia el detalle cada vez.`) : ''}`;

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-40),
    { role: 'user', content: isFirst ? 'Inicia.' : message }
  ];

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // gpt-4.1-mini ganó el A/B de calidad de corrección (18/08). El techo
        // de tokens es generoso: la brevedad viene del prompt (RITMO), no de
        // cortar a Paula a mitad de frase.
        model: 'gpt-4.1-mini',
        messages: messages,
        max_tokens: isFirst ? 60 : 220,
        temperature: 0.9,
        stream: true
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[CONVERSA chat]', e);
      res.write('data: ' + JSON.stringify({ error: 'Erro ao gerar resposta.' }) + '\n\n');
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n');
      buffer = parts.pop() || '';

      for (const line of parts) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data: ')) continue;
        const data = trimmed.slice(6);
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = (parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content) || '';
          if (delta) {
            fullText += delta;
            res.write('data: ' + JSON.stringify({ delta: delta }) + '\n\n');
          }
        } catch (e) {}
      }
    }

    res.write('data: ' + JSON.stringify({ done: true, reply: fullText.trim() }) + '\n\n');
    res.end();

  } catch (e) {
    console.error('[CONVERSA chat]', e.message);
    res.write('data: ' + JSON.stringify({ error: 'Erro interno.' }) + '\n\n');
    res.end();
  }
});

// ─── POST /api/conversa/whisper ─────────────────────────────
router.post('/whisper', auth, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.+)$/);
      if (!boundaryMatch) return res.status(400).json({ error: 'Boundary não encontrado.' });

      const boundary = boundaryMatch[1];
      const body = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);

      let audioBuffer = null;
      let pos = 0;
      while (pos < body.length) {
        const start = body.indexOf(boundaryBuf, pos);
        if (start === -1) break;
        const headerEnd = body.indexOf(Buffer.from('\r\n\r\n'), start);
        if (headerEnd === -1) break;
        const nextBoundary = body.indexOf(boundaryBuf, headerEnd);
        if (nextBoundary === -1) break;
        const fileData = body.slice(headerEnd + 4, nextBoundary - 2);
        const header = body.slice(start, headerEnd).toString();
        if (header.includes('audio') || header.includes('name="audio"')) {
          audioBuffer = fileData;
          break;
        }
        pos = nextBoundary;
      }

      if (!audioBuffer) return res.status(400).json({ error: 'Áudio não encontrado.' });

      // Anti-ruido: audio demasiado corto (un golpe, un click, la TV de
      // fondo) no llega a Whisper — Whisper alucina frases con ruido y el
      // alumno veía "respuestas suyas" sin haber hablado.
      // ~6KB de webm/opus ≈ 1s de audio: mata clicks y golpes sin descartar
      // un "¡Hola Paula!" corto y legítimo.
      if (audioBuffer.length < 6000) {
        return res.json({ transcript: '' });
      }

      const b = 'WBoundary' + Date.now();
      const CRLF = '\r\n';
      const parts = [];
      parts.push(Buffer.from('--' + b + CRLF + 'Content-Disposition: form-data; name="model"' + CRLF + CRLF + 'whisper-1' + CRLF));
      // Fijar idioma reduce muchísimo las alucinaciones con ruido de fondo
      parts.push(Buffer.from('--' + b + CRLF + 'Content-Disposition: form-data; name="language"' + CRLF + CRLF + 'es' + CRLF));
      parts.push(Buffer.from('--' + b + CRLF + 'Content-Disposition: form-data; name="file"; filename="audio.webm"' + CRLF + 'Content-Type: audio/webm' + CRLF + CRLF));
      parts.push(audioBuffer);
      parts.push(Buffer.from(CRLF + '--' + b + '--' + CRLF));
      const formBody = Buffer.concat(parts);

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + OPENAI_API_KEY,
          'Content-Type': 'multipart/form-data; boundary=' + b
        },
        body: formBody
      });

      if (!r.ok) {
        const e = await r.text();
        console.error('[CONVERSA whisper]', e);
        return res.status(502).json({ error: 'Erro na transcrição.' });
      }

      const data = await r.json();
      let transcript = (data.text || '').trim();
      // Filtro de alucinaciones clásicas de Whisper con silencio/ruido
      const alucinacion = /^(gracias por ver|subt[ií]tulos|suscr[ií]bete|amara\.org|www\.|\.{3}|¡?gracias!?\.?)$/i;
      if (transcript.length < 2 || alucinacion.test(transcript)) transcript = '';
      res.json({ transcript });

    } catch (e) {
      console.error('[CONVERSA whisper]', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });
});

// ─── POST /api/conversa/tts ──────────────────────────────────
router.post('/tts', auth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto não recebido.' });

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + OPENAI_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // Misma voz que la llamada realtime (coral) para que Paula sea LA
        // MISMA persona en chat y en llamada. Receta idéntica a conversa2,
        // aprobada por Ale — NO cambiar las instrucciones de actuación.
        model: 'gpt-4o-mini-tts',
        input: text,
        voice: 'coral',
        instructions: 'Eres Paula, profesora bogotana cálida y cercana. Habla con naturalidad conversacional, ritmo tranquilo, tono amable y sonriente. Español neutro de Colombia.',
        response_format: 'mp3'
      })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[CONVERSA tts]', e);
      return res.status(502).json({ error: 'Erro no TTS.' });
    }

    const buffer = await r.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(buffer));

  } catch (e) {
    console.error('[CONVERSA tts]', e.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

module.exports = router;
