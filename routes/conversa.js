/**
 * IMERSÃO NATIVA - Conversação
 * OpenAI GPT-4o (chat) + Whisper (transcrição) + OpenAI TTS (voz)
 * 
 * POST /api/conversa/chat     → resposta da Paula em texto
 * POST /api/conversa/whisper  → transcreve áudio do aluno
 * POST /api/conversa/tts      → áudio da resposta da Paula
 */

const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  if (!token) return res.status(401).json({ error: 'Token necessário.' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Token inválido.' }); }
}

// ─── POST /api/conversa/chat ───────────────────────────
// Recebe mensagem do aluno, retorna resposta da Paula
router.post('/chat', auth, async (req, res) => {
  const { message, history = [], level, situation, isFirst } = req.body;

  const sitMap = {
    'café': 'num café', 'hotel': 'num hotel', 'trabajo': 'no trabalho',
    'médico': 'no médico', 'viaje': 'numa viagem', 'mercado': 'no mercado',
    'amigos': 'com amigos', 'libre': 'livremente'
  };
  const lvlMap = {
    'beginner': 'iniciante A1-A2 — fala devagar, frases simples, vocabulário básico',
    'intermediate': 'intermediário B1-B2 — ritmo normal',
    'advanced': 'avançado C1-C2 — ritmo natural, vocabulário rico'
  };

  const sit = sitMap[situation] || 'livremente';
  const lvl = lvlMap[level] || 'intermediário B1-B2';

  const systemPrompt = `Eres Paula, una amiga cercana, divertida y cálida. NUNCA digas que eres IA ni profesora.

SITUACIÓN: ${sit}. Nivel del alumno: ${lvl}.

REGLAS ABSOLUTAS:
1. Habla SIEMPRE en español latinoamericano. Nunca en portugués ni inglés.
2. Si el alumno habla en portugués, entiéndelo y responde en español integrando lo que dijo.
3. Si comete un error, usa la forma correcta en tu respuesta de forma natural — sin señalarlo, sin asteriscos, sin explicaciones.
4. MÁXIMO 2 frases por turno. Para. Escucha.
5. Termina SIEMPRE con UNA pregunta concreta.
6. Sé espontánea: reacciona, opina, ríete, cuenta algo tuyo. No seas una máquina de preguntas.
7. Varía los temas — introduce situaciones nuevas, propone algo inesperado.
${isFirst ? '\nPRIMER TURNO: Saluda en 1 frase cálida y haz UNA pregunta sobre la situación. Solo eso.' : ''}`;

  // Montar mensagens — limitar histórico
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-20),
    { role: 'user', content: isFirst ? 'Inicia la conversación.' : message }
  ];

  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages,
        max_tokens: 120,
        temperature: 0.9
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[CONVERSA] OpenAI chat error:', err.slice(0, 200));
      return res.status(502).json({ error: 'Erro ao gerar resposta.' });
    }

    const data = await response.json();
    const reply = data.choices[0].message.content.trim();
    res.json({ reply });

  } catch (err) {
    console.error('[CONVERSA] chat error:', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ─── POST /api/conversa/whisper ─────────────────────────
// Recebe áudio gravado pelo aluno, retorna transcrição
router.post('/whisper', auth, upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Áudio não recebido.' });

  try {
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: 'audio.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    form.append('model', 'whisper-1');
    form.append('language', 'es'); // espanhol — mas Whisper detecta pt também

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        ...form.getHeaders()
      },
      body: form
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[CONVERSA] Whisper error:', err.slice(0, 200));
      return res.status(502).json({ error: 'Erro na transcrição.' });
    }

    const data = await response.json();
    res.json({ transcript: data.text });

  } catch (err) {
    console.error('[CONVERSA] whisper error:', err.message);
    res.status(500).json({ error: 'Erro na transcrição.' });
  }
});

// ─── POST /api/conversa/tts ─────────────────────────────
// Recebe texto, retorna áudio mp3 da Paula
router.post('/tts', auth, async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Texto não recebido.' });

  try {
    const response = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'tts-1',
        input: text,
        voice: 'nova',   // nova = feminina, natural, latinoamericana
        response_format: 'mp3',
        speed: 1.0
      })
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[CONVERSA] TTS error:', err.slice(0, 200));
      return res.status(502).json({ error: 'Erro no TTS.' });
    }

    const buffer = await response.arrayBuffer();
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'no-cache');
    res.send(Buffer.from(buffer));

  } catch (err) {
    console.error('[CONVERSA] tts error:', err.message);
    res.status(500).json({ error: 'Erro no TTS.' });
  }
});

module.exports = router;
