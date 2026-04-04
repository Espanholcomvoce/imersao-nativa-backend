/**
 * IMERSAO NATIVA - Rota TTS (Text to Speech)
 * Gera audio com ElevenLabs + cache permanente em Cloudflare R2
 *
 * POST /api/tts         -> gera audio a partir de texto
 * GET  /api/tts/vocab   -> TTS para vocabulario SRE (cache R2)
 * GET  /api/tts/voices  -> lista vozes disponiveis
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { authMiddleware } = require('../middleware/auth');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// ─── Cloudflare R2 — cache permanente ───
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET = process.env.R2_BUCKET || 'imersao-nativa-audio';

let r2Client = null;
if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
  r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
}

async function r2Get(key) {
  if (!r2Client) return null;
  try {
    const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of resp.Body) { chunks.push(chunk); }
    return Buffer.concat(chunks);
  } catch { return null; }
}

async function r2Put(key, buffer) {
  if (!r2Client) return false;
  try {
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: buffer, ContentType: 'audio/mpeg',
    }));
    return true;
  } catch (err) {
    console.error('[TTS] Erro R2:', err.message);
    return false;
  }
}

// ─── VOZES ───
const VOICES = {
  Cristina: { voice_id: 'nTkjq09AuYgsNR8E4sDe', idioma: 'Espanol latino', genero: 'mujer', descricao: 'Natural conversacional, Sombreado/SRE' },
  Maya: { voice_id: 'nbcvT3C2tyOd2OsRAtUf', idioma: 'Espanol latino', genero: 'mujer', descricao: 'Dinamica, agente conversacional, Paula' },
  Valentina: { voice_id: 'cgSgspJ2msm6clMCkdW9', idioma: 'Espanol mexicano', genero: 'mujer', descricao: 'Calida, natural, guia cultural' },
  Alejandro: { voice_id: 'pqHfZKP75CvOlQylNhV4', idioma: 'Espanol mexicano', genero: 'hombre', descricao: 'Neutral, profesional, narrador' },
  Lizy: { voice_id: 'XB0fDUnXU5powFXDhCwa', idioma: 'Espanol colombiano', genero: 'mujer', descricao: 'Profesional, clara, guia colombiana' },
  Mikel: { voice_id: 'iP95p4xoKVk53GoZ742B', idioma: 'Espanol (Espana)', genero: 'hombre', descricao: 'Maduro, formal, solo para Espana' },
  Eleguar: { voice_id: 'nPczCjzI2devNBz1zQrb', idioma: 'Espanol caribeno', genero: 'hombre', descricao: 'Expresivo, calido, guia caribeno' }
};

function getCacheKey(text, voiceId) {
  return crypto.createHash('md5').update(`${voiceId}:${text}`).digest('hex');
}

// ─── POST /api/tts ───
router.post('/', authMiddleware, async (req, res) => {
  const { text, voice = 'Maya', voice_id } = req.body;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Texto obrigatorio.' });
  }
  if (text.length > 5000) {
    return res.status(400).json({ error: 'Texto muito longo (max 5000).' });
  }

  let resolvedVoiceId = voice_id;
  if (!resolvedVoiceId) {
    const voiceData = VOICES[voice];
    resolvedVoiceId = voiceData ? voiceData.voice_id : VOICES.Maya.voice_id;
  }

  const cleanText = text.trim();
  const hash = getCacheKey(cleanText, resolvedVoiceId);
  const r2Key = `tts/${hash}.mp3`;

  // 1. Tentar R2
  const cached = await r2Get(r2Key);
  if (cached) {
    console.log(`[TTS] R2 HIT — ${cleanText.substring(0, 30)}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', cached.length);
    res.set('X-Cache', 'HIT');
    return res.send(cached);
  }

  // 2. Gerar com ElevenLabs
  try {
    console.log(`[TTS] Gerando | voz: ${voice} | ${cleanText.substring(0, 50)}...`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${resolvedVoiceId}`,
      {
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
      },
      {
        headers: { 'Accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = Buffer.from(response.data);

    // 3. Salvar en R2 (background)
    r2Put(r2Key, audioBuffer).then(ok => {
      if (ok) console.log(`[TTS] R2 salvo — ${r2Key} (${audioBuffer.length} bytes)`);
    });

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[TTS] Erro ElevenLabs (${status}):`, err.message);
    if (status === 429) return res.status(429).json({ error: 'Limite de audio atingido.' });
    res.status(500).json({ error: 'Erro ao gerar audio.' });
  }
});

// ─── GET /api/tts/vocab ───
const VOCAB_VOICE_ID = 'nTkjq09AuYgsNR8E4sDe'; // Cristina Campos

router.get('/vocab', authMiddleware, async (req, res) => {
  const { text } = req.query;

  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'text obrigatorio.' });
  }
  if (text.length > 500) {
    return res.status(400).json({ error: 'Texto muito longo.' });
  }

  const cleanText = text.trim();
  const hash = crypto.createHash('md5').update(`cristina_v6:${cleanText}`).digest('hex');
  const r2Key = `vocab/${hash}.mp3`;

  // 1. Tentar R2
  const cached = await r2Get(r2Key);
  if (cached) {
    console.log(`[TTS-VOCAB] R2 HIT — ${cleanText.substring(0, 30)}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', cached.length);
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=31536000');
    return res.send(cached);
  }

  // 2. Gerar con ElevenLabs
  try {
    console.log(`[TTS-VOCAB] Gerando — ${cleanText.substring(0, 50)}`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${VOCAB_VOICE_ID}`,
      {
        text: cleanText,
        model_id: 'eleven_multilingual_v2',
        voice_settings: { stability: 0.70, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
      },
      {
        headers: { 'Accept': 'audio/mpeg', 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json' },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );

    const audioBuffer = Buffer.from(response.data);

    // 3. Salvar en R2 (background)
    r2Put(r2Key, audioBuffer).then(ok => {
      if (ok) console.log(`[TTS-VOCAB] R2 salvo — ${r2Key} (${audioBuffer.length} bytes)`);
    });

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[TTS-VOCAB] Erro (${status}):`, err.message);
    if (status === 429) return res.status(429).json({ error: 'Limite de audio atingido.' });
    res.status(500).json({ error: 'Erro ao gerar audio.' });
  }
});

// ─── GET /api/tts/voices ───
router.get('/voices', authMiddleware, (req, res) => {
  const voiceList = Object.entries(VOICES).map(([name, data]) => ({
    name, voice_id: data.voice_id, idioma: data.idioma, genero: data.genero, descricao: data.descricao
  }));
  res.json({ voices: voiceList });
});

module.exports = router;
