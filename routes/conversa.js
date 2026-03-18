/**
 * IMERSÃO NATIVA - Conversação
 * OpenAI GPT-4o + Whisper + OpenAI TTS
 * Sem dependências externas além do express e node-fetch
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

// ─── POST /api/conversa/chat (streaming) ───────────────
router.post('/chat', auth, async (req, res) => {
  const { message, history = [], level, situation, isFirst, gender = "" } = req.body;

  const sitMap = {
    'café':'num café','hotel':'num hotel','trabajo':'no trabalho',
    'médico':'no médico','viaje':'numa viagem','mercado':'no mercado',
    'amigos':'com amigos','libre':'livremente'
  };
  const lvlMap = {
    'beginner':'iniciante A1-A2 — fala devagar e simples',
    'intermediate':'intermediário B1-B2',
    'advanced':'avançado C1-C2 — ritmo e vocabulário naturais'
  };

  const sit = sitMap[situation] || 'livremente';
  const lvl = lvlMap[level] || 'intermediário B1-B2';

  const system = `Eres Paula.

Personalidad: amiga cercana, espontánea, interesante. Nunca profesora, nunca asistente.

Situación: ${sit}. Nivel: ${lvl}.

CÓMO ERES:
- Tienes opiniones reales. Las expresas.
- Dices cosas inesperadas. No sigues el guión.
- Compartes comentarios personales, aunque sean inventados.
- No eres perfecta. Puedes equivocarte, dudar, cambiar de idea.
- Cambias de tema cuando la conversación se vuelve plana — sin avisar.
- Introduces cosas nuevas: una observación, un recuerdo, una pregunta rara.

FLUIDEZ:
- No siempre haces una pregunta. Algunas respuestas son solo comentarios.
- Máximo 1 pregunta por respuesta.
- Si llevas 2 intercambios en el mismo tema → cambia.
- Patrón PROHIBIDO: validar + preguntar.

CORRECCIÓN:
- Si el usuario mezcla idiomas o dice algo mal → usas la forma correcta en tu respuesta de forma natural, sin señalarlo.
- Ejemplo: dice "quiero un cucina" → respondes con "cocina" en contexto, como si fuera lo normal.

IDIOMA:
- Español neutro. Sin regionalismos marcados.
- Entiendes portugués → respondes siempre en español.

PROHIBIDO:
- "¿alguna novedad?" / "¿qué tal tu día?"
- "¡Genial!" / "¡Qué bueno!" / "¡Increíble!" solos
- Explicar gramática
- Sonar como chatbot

FORMATO:
- Frases cortas. Ritmo natural.
- MÁXIMO 2 frases por turno.
- Si haces pregunta: que sea específica, inesperada, curiosa.

PRIORIDAD MÁXIMA: Ser interesante > ser correcta.
Si la conversación se vuelve aburrida → rómpela.
${isFirst ? "\nARRANQUE: Entra directo. 1 observación sobre la situación (" + sit + ") + 1 pregunta inesperada. Sin saludos genéricos." : ""}`;

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-40),
    { role: 'user', content: isFirst ? 'Inicia.' : message }
  ];

  // Streaming via SSE — cliente recebe texto em tempo real
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o-mini', messages, max_tokens: 80, temperature: 0.95, stream: true })
    });

    if (!r.ok) {
      const e = await r.text();
      console.error('[CONVERSA chat]', e);
      res.write(`data: ${JSON.stringify({ error: 'Erro ao gerar resposta.' })}

`);
      return res.end();
    }

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      const lines = chunk.split('
').filter(l => l.startsWith('data: '));
      for (const line of lines) {
        const data = line.slice(6).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content || '';
          if (delta) {
            fullText += delta;
            res.write(`data: ${JSON.stringify({ delta })}

`);
          }
        } catch {}
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, reply: fullText.trim() })}

`);
    res.end();

  } catch (e) {
    console.error('[CONVERSA chat]', e.message);
    res.write(`data: ${JSON.stringify({ error: 'Erro interno.' })}

`);
    res.end();
  }
});

// ─── POST /api/conversa/whisper ─────────────────────────
// Recebe áudio como multipart/form-data via buffer raw
router.post('/whisper', auth, (req, res) => {
  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const boundary = req.headers['content-type'].split('boundary=')[1];
      if (!boundary) return res.status(400).json({ error: 'Boundary não encontrado.' });

      const body = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from('--' + boundary);

      // Extrair a parte do arquivo de áudio
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
        if (header.includes('audio')) { audioBuffer = fileData; break; }
        pos = nextBoundary;
      }

      if (!audioBuffer) return res.status(400).json({ error: 'Áudio não encontrado.' });

      // Enviar para Whisper via multipart manual
      const b = '----WhisperBoundary' + Date.now();
      const parts = [];
      parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`));
      parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\n`));
      parts.push(audioBuffer);
      parts.push(Buffer.from(`\r\n--${b}--\r\n`));
      const formBody = Buffer.concat(parts);

      const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${b}`
        },
        body: formBody
      });

      if (!r.ok) { const e = await r.text(); console.error('[CONVERSA whisper]', e); return res.status(502).json({ error: 'Erro na transcrição.' }); }
      const data = await r.json();
      res.json({ transcript: data.text || '' });

    } catch (e) {
      console.error('[CONVERSA whisper]', e.message);
      res.status(500).json({ error: 'Erro interno.' });
    }
  });
});

// ─── POST /api/conversa/tts ─────────────────────────────
router.post('/tts', auth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto não recebido.' });

  try {
    const r = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'tts-1', input: text, voice: 'nova', response_format: 'mp3', speed: 1.05 })
    });
    if (!r.ok) { const e = await r.text(); console.error('[CONVERSA tts]', e); return res.status(502).json({ error: 'Erro no TTS.' }); }
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
