/**
 * IMERSÃO NATIVA - Conversação
 * OpenAI GPT-4o-mini (streaming) + Whisper + OpenAI TTS
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token necessário.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido.' }); }
}

// ─── POST /api/conversa/chat (streaming SSE) ───────────────
router.post('/chat', auth, async (req, res) => {
  const { message, history = [], level, situation, isFirst } = req.body;

  const sitMap = {
    'café':'num café','hotel':'num hotel','trabajo':'no trabalho',
    'médico':'no médico','viaje':'numa viagem','mercado':'no mercado',
    'amigos':'com amigos','libre':'livremente'
  };
  const lvlMap = {
    'beginner':'iniciante A1-A2',
    'intermediate':'intermediário B1-B2',
    'advanced':'avançado C1-C2'
  };

  const sit = sitMap[situation] || 'livremente';
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

CONTEXTO: Nivel: ${lvl}.
${isFirst ? 'PRIMER TURNO: Saluda y cuenta algo breve de tu día. Ejemplo: "¡Hola! ¿Cómo va? Yo acabo de sacar a Canela al parque y casi se me escapa persiguiendo una paloma, jajaja. ¿Qué me cuentas?"' : ''}`;

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
        model: 'gpt-4o-mini',
        messages: messages,
        max_tokens: isFirst ? 50 : 120,
        temperature: 0.8,
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

      const b = 'WBoundary' + Date.now();
      const CRLF = '\r\n';
      const parts = [];
      parts.push(Buffer.from('--' + b + CRLF + 'Content-Disposition: form-data; name="model"' + CRLF + CRLF + 'whisper-1' + CRLF));
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
      res.json({ transcript: data.text || '' });

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
        model: 'tts-1',
        input: text,
        voice: 'nova',
        response_format: 'mp3',
        speed: 1.05
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
