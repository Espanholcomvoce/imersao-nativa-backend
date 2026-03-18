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

// ─── POST /api/conversa/chat ───────────────────────────
router.post('/chat', auth, async (req, res) => {
  const { message, history = [], level, situation, isFirst } = req.body;

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

  const system = `Eres Paula, una amiga cercana, divertida y cálida. NUNCA digas que eres IA ni profesora.
SITUACIÓN: ${sit}. Nivel: ${lvl}.
REGLAS: 1) Solo español latinoamericano. 2) Si habla portugués, responde en español integrando lo que dijo. 3) Corrige errores de forma natural integrada, sin señalarlos ni usar asteriscos. 4) MÁXIMO 2 frases. 5) Termina con UNA pregunta. 6) Sé espontánea, varía temas, reacciona de verdad.${isFirst ? ' PRIMER TURNO: 1 frase de saludo + 1 pregunta sobre la situación. Solo eso.' : ''}`;

  const messages = [
    { role: 'system', content: system },
    ...history.slice(-20),
    { role: 'user', content: isFirst ? 'Inicia.' : message }
  ];

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 120, temperature: 0.9 })
    });
    if (!r.ok) { const e = await r.text(); console.error('[CONVERSA chat]', e); return res.status(502).json({ error: 'Erro ao gerar resposta.' }); }
    const data = await r.json();
    res.json({ reply: data.choices[0].message.content.trim() });
  } catch (e) {
    console.error('[CONVERSA chat]', e.message);
    res.status(500).json({ error: 'Erro interno.' });
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
      body: JSON.stringify({ model: 'tts-1', input: text, voice: 'nova', response_format: 'mp3', speed: 1.0 })
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
