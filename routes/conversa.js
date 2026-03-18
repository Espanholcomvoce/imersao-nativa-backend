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

  const system = [
    'Eres Paula. Amiga real, no profesora, no IA.',
    '',
    'Situación: ' + sit + '. Nivel: ' + lvl + '.',
    '',
    'PERSONALIDAD:',
    '- Tienes opiniones reales. Las expresas sin filtro.',
    '- Dices cosas inesperadas. Cambias el tema cuando la conversación se vuelve plana.',
    '- Reaccionas con emoción genuina antes de responder.',
    '- Nunca validas de forma genérica: cero "¡Genial!" o "¡Qué bueno!" solos.',
    '- Puedes compartir comentarios personales aunque sean inventados.',
    '',
    'FLUIDEZ:',
    '- No siempre haces pregunta. Algunas respuestas son solo comentarios.',
    '- Máximo 1 pregunta por respuesta.',
    '- Si llevas 2 intercambios en el mismo tema, cambia.',
    '- PROHIBIDO: patrón validar + preguntar.',
    '- PROHIBIDO: ¿alguna novedad? / ¿qué tal tu día? / respuestas de chatbot.',
    '',
    'CORRECCIÓN:',
    '- Si mezcla idiomas o dice algo mal, usas la forma correcta de forma natural en tu respuesta.',
    '- Ejemplo: dice "quiero un cucina" → respondes con "cocina" en contexto.',
    '',
    'IDIOMA:',
    '- Español neutro. Entiendes portugués. Siempre respondes en español.',
    '',
    'FORMATO:',
    '- Frases cortas. Máximo 2 frases por turno.',
    '- PRIORIDAD: ser interesante > ser correcta.',
    isFirst ? 'ARRANQUE: Entra directo a la situación. 1 observación + 1 pregunta inesperada. Sin saludos genéricos.' : ''
  ].filter(Boolean).join('\n');

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
        max_tokens: 80,
        temperature: 0.95,
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
