/**
 * IMERSAO CULTURAL E AUDITIVA - Audio on-demand + cache R2
 *
 * GET  /api/auditiva/audio/:episodeId/:sectionIndex
 *
 * Audio gerado na primeira vez via ElevenLabs, salvo em Cloudflare R2 (permanente).
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { authMiddleware } = require('../middleware/auth');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// ─── Cloudflare R2 (S3-compatible) — cache permanente ───
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
  console.log('[AUDITIVA] R2 configurado — cache permanente ativo');
} else {
  console.warn('[AUDITIVA] R2 nao configurado — audio nao sera salvo permanentemente');
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
    console.error('[AUDITIVA] Erro ao salvar no R2:', err.message);
    return false;
  }
}

// ─── VOZES POR PAIS ───
const NARRATOR_VOICE = {
  voice_id: 'l1zE9xgNpUTaQCZzpNJa',
  settings: { stability: 0.70, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true }
};

const SAFE = { stability: 0.65, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };
const CARIB = { stability: 0.60, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true };

const GUIDE_VOICES = {
  argentina:  { voice_id: '1WXz8v08ntDcSTeVXMN2', settings: SAFE },
  bolivia:    { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE },
  chile:      { voice_id: 'Fd38GRHtJllY0CuguAy9', settings: SAFE },
  colombia:   { voice_id: 'MqSrMUk8EHh32HBKytrG', settings: SAFE },
  costarica:  { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE },
  cuba:       { voice_id: '1hB7zCGWj11SeMuBseeI', settings: CARIB },
  ecuador:    { voice_id: 'DZksvRcjbVkbnIwYVMEQ', settings: SAFE },
  elsalvador: { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE },
  espana:     { voice_id: 'iP95p4xoKVk53GoZ742B', settings: SAFE },
  guatemala:  { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE },
  honduras:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE },
  mexico:     { voice_id: 'P951amuWPNCJ0L15rFyC', settings: SAFE },
  nicaragua:  { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE },
  panama:     { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB },
  paraguay:   { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE },
  peru:       { voice_id: 'WrKMouCyVAmTemNLZkOw', settings: SAFE },
  puertorico: { voice_id: 'ISTw2UT8hNs80bzKPenA', settings: CARIB },
  dominicana: { voice_id: '2vyVHGyPYK7eCnfdVvk9', settings: CARIB },
  uruguay:    { voice_id: '1WXz8v08ntDcSTeVXMN2', settings: SAFE },
  venezuela:  { voice_id: 'Aoh8oiCIlPke1wFxeNuK', settings: CARIB },
};

// ─── GET /api/auditiva/audio/:episodeId/:sectionIndex ───
router.get('/audio/:episodeId/:sectionIndex', authMiddleware, async (req, res) => {
  const { episodeId, sectionIndex } = req.params;
  const idx = parseInt(sectionIndex);

  if (!episodeId || isNaN(idx) || idx < 0 || idx > 20) {
    return res.status(400).json({ error: 'Parametros invalidos.' });
  }

  const cacheKey = `${episodeId}_sec${idx}.mp3`;

  // 1. Servir do R2 se existe (cache permanente)
  const cached = await r2Get(cacheKey);
  if (cached) {
    console.log(`[AUDITIVA] R2 HIT — ${cacheKey}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', cached.length);
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=31536000');
    return res.send(cached);
  }

  // 2. Precisa gerar — requer text, speaker, countryCode
  const { text, speaker, countryCode } = req.query;
  if (!text || !speaker || !countryCode) {
    return res.status(400).json({ error: 'Parametros text, speaker e countryCode obrigatorios na primeira geracao.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Texto muito longo.' });
  }

  const isNarrator = speaker === 'narrator';
  const voiceConfig = isNarrator ? NARRATOR_VOICE : (GUIDE_VOICES[countryCode] || GUIDE_VOICES.mexico);

  try {
    console.log(`[AUDITIVA] Gerando | ${cacheKey} | ${isNarrator ? 'narrador' : 'guia ' + countryCode}`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceConfig.voice_id}`,
      {
        text: text.trim(),
        model_id: 'eleven_flash_v2_5',
        voice_settings: voiceConfig.settings
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 90000
      }
    );

    const audioBuffer = Buffer.from(response.data);

    // 3. Salvar no R2 em background (nao bloqueia resposta)
    r2Put(cacheKey, audioBuffer).then(ok => {
      if (ok) console.log(`[AUDITIVA] R2 salvo — ${cacheKey} (${audioBuffer.length} bytes)`);
    });

    // 4. Responder com audio
    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=31536000');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[AUDITIVA] Erro ElevenLabs (${status}):`, err.message);
    if (status === 429) {
      return res.status(429).json({ error: 'Limite de audio atingido. Tente em alguns minutos.' });
    }
    res.status(500).json({ error: 'Erro ao gerar audio.' });
  }
});

module.exports = router;
