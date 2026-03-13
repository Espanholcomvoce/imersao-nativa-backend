/**
 * IMERSÃO NATIVA - Rota TTS (Text to Speech)
 * Gera áudio com ElevenLabs usando as vozes do projeto
 *
 * POST /api/tts         → gera áudio a partir de texto
 * GET  /api/tts/voices  → lista vozes disponíveis
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');

// ─────────────────────────────────────────────
// CACHE EM DISCO para vocabulário SRE
// Salva MP3s em /tmp/vocab-audio/ no Railway
// ─────────────────────────────────────────────
const VOCAB_CACHE_DIR = path.join('/tmp', 'vocab-audio');
if (!fs.existsSync(VOCAB_CACHE_DIR)) {
  fs.mkdirSync(VOCAB_CACHE_DIR, { recursive: true });
}

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// ─────────────────────────────────────────────
// VOZES DO PROJETO
// Mapeamento nome → voice_id do ElevenLabs
// ─────────────────────────────────────────────
const VOICES = {
  Valentina: {
    voice_id: 'cgSgspJ2msm6clMCkdW9',
    idioma: 'Español mexicano',
    genero: 'mujer',
    descricao: 'Cálida, natural, perfecta para conversaciones'
  },
  Alejandro: {
    voice_id: 'pqHfZKP75CvOlQylNhV4',
    idioma: 'Español mexicano',
    genero: 'hombre',
    descricao: 'Neutral, profesional, clara dicción'
  },
  Lizy: {
    voice_id: 'XB0fDUnXU5powFXDhCwa',
    idioma: 'Español colombiano',
    genero: 'mujer',
    descricao: 'Profesional, clara, autoridad'
  },
  Mikel: {
    voice_id: 'iP95p4xoKVk53GoZ742B',
    idioma: 'Español (España)',
    genero: 'hombre',
    descricao: 'Maduro, formal, distintivo'
  },
  Lina: {
    voice_id: 'pFZP5JQG7iQjIQuC4Bku',
    idioma: 'Español neutro',
    genero: 'mujer',
    descricao: 'Clara, versátil, agradable'
  },
  Eleguar: {
    voice_id: 'nPczCjzI2devNBz1zQrb',
    idioma: 'Español caribeño',
    genero: 'hombre',
    descricao: 'Expresivo, cálido, natural'
  }
};

// ─────────────────────────────────────────────
// CACHE EM MEMÓRIA
// Evita chamar ElevenLabs para o mesmo texto+voz
// Limite: 200 entradas (as mais antigas saem primeiro)
// ─────────────────────────────────────────────
const audioCache = new Map();
const CACHE_MAX = 200;

function getCacheKey(text, voiceId) {
  return crypto
    .createHash('md5')
    .update(`${voiceId}:${text}`)
    .digest('hex');
}

function getFromCache(key) {
  return audioCache.get(key) || null;
}

function saveToCache(key, buffer) {
  if (audioCache.size >= CACHE_MAX) {
    // Remove a entrada mais antiga
    const oldestKey = audioCache.keys().next().value;
    audioCache.delete(oldestKey);
  }
  audioCache.set(key, buffer);
}

// ─────────────────────────────────────────────
// POST /api/tts
// Body: { text, voice?, voice_id? }
// Retorna: audio/mpeg (binário)
// ─────────────────────────────────────────────
router.post('/', authMiddleware, async (req, res) => {
  const { text, voice = 'Alejandro', voice_id } = req.body;

  // Validações
  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Texto é obrigatório.' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Texto muito longo (máximo 5000 caracteres).' });
  }

  // Resolve qual voice_id usar
  // Prioridade: voice_id explícito → nome da voz → Alejandro como fallback
  let resolvedVoiceId = voice_id;
  if (!resolvedVoiceId) {
    const voiceData = VOICES[voice];
    resolvedVoiceId = voiceData ? voiceData.voice_id : VOICES.Alejandro.voice_id;
  }

  const cleanText = text.trim();
  const cacheKey = getCacheKey(cleanText, resolvedVoiceId);

  // Verifica cache
  const cached = getFromCache(cacheKey);
  if (cached) {
    console.log(`[TTS] Cache HIT — ${cacheKey.substring(0, 8)}...`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', cached.length);
    res.set('X-Cache', 'HIT');
    return res.send(cached);
  }

  // Chama ElevenLabs
  try {
    console.log(`[TTS] Gerando áudio | voz: ${voice} | ${cleanText.substring(0, 50)}...`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${resolvedVoiceId}`,
      {
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = Buffer.from(response.data);
    saveToCache(cacheKey, audioBuffer);

    console.log(`[TTS] ✅ Gerado ${audioBuffer.length} bytes`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[TTS] Erro ElevenLabs (${status}):`, err.message);

    if (status === 401) {
      return res.status(500).json({ error: 'Erro de configuração do serviço de áudio.' });
    }
    if (status === 422) {
      return res.status(400).json({ error: 'Texto inválido para síntese de voz.' });
    }
    if (status === 429) {
      return res.status(429).json({ error: 'Limite de áudio atingido. Tente em alguns minutos.' });
    }

    res.status(500).json({ error: 'Erro ao gerar áudio. Tente novamente.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/tts/vocab?text=...&type=word|example
// TTS para vocabulário SRE — cache em disco
// Voz fixa: Valentina (mexicana, feminina)
// Não precisa de auth pois é recurso estático
// ─────────────────────────────────────────────
const VALENTINA_ID = 'cgSgspJ2msm6clMCkdW9';

router.get('/vocab', authMiddleware, async (req, res) => {
  const { text, type = 'word' } = req.query;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'text é obrigatório.' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Texto muito longo.' });
  }

  const cleanText = text.trim();
  const hash = crypto.createHash('md5').update(`valentina:${cleanText}`).digest('hex');
  const filePath = path.join(VOCAB_CACHE_DIR, `${hash}.mp3`);

  // Serve do cache em disco se já existe
  if (fs.existsSync(filePath)) {
    console.log(`[TTS-VOCAB] Cache disco HIT — ${cleanText.substring(0,30)}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(filePath);
  }

  // Gera com ElevenLabs
  try {
    console.log(`[TTS-VOCAB] Gerando — ${cleanText.substring(0,50)}`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${VALENTINA_ID}`,
      {
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.55,
          similarity_boost: 0.80,
          style: 0.0,
          use_speaker_boost: true
        }
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = Buffer.from(response.data);

    // Salva em disco para cache permanente
    fs.writeFileSync(filePath, audioBuffer);
    console.log(`[TTS-VOCAB] ✅ Salvo ${audioBuffer.length} bytes — ${hash}.mp3`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[TTS-VOCAB] Erro (${status}):`, err.message);
    if (status === 429) {
      return res.status(429).json({ error: 'Limite de áudio atingido. Tente em alguns minutos.' });
    }
    res.status(500).json({ error: 'Erro ao gerar áudio.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/tts/voices
// Lista todas as vozes disponíveis
// ─────────────────────────────────────────────
router.get('/voices', authMiddleware, (req, res) => {
  const voiceList = Object.entries(VOICES).map(([name, data]) => ({
    name,
    voice_id: data.voice_id,
    idioma: data.idioma,
    genero: data.genero,
    descricao: data.descricao
  }));

  res.json({ voices: voiceList });
});

module.exports = router;
