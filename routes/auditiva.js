/**
 * IMERSÃO CULTURAL E AUDITIVA - Áudio on-demand + cache
 *
 * GET  /api/auditiva/audio/:episodeId/:sectionIndex  → Gera/serve áudio de uma seção
 * GET  /api/auditiva/episodes/:countryCode            → Lista episódios de um país
 * GET  /api/auditiva/countries                         → Lista países disponíveis
 *
 * Áudio gerado na primeira vez via ElevenLabs, salvo em disco para reproduções futuras.
 * Cada país tem voz local + narrador neutro latinoamericano.
 */

const express = require('express');
const router = express.Router();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { authMiddleware } = require('../middleware/auth');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// Cache em disco — persiste entre deploys no Railway (/tmp)
const AUDITIVA_CACHE_DIR = path.join('/tmp', 'auditiva-audio');
if (!fs.existsSync(AUDITIVA_CACHE_DIR)) {
  fs.mkdirSync(AUDITIVA_CACHE_DIR, { recursive: true });
}

// ─────────────────────────────────────────────
// VOZES POR PAÍS — narrador neutro + guia local
// Objetivo: cada país soa autêntico com sotaque regional
// ─────────────────────────────────────────────
const NARRATOR_VOICE = {
  voice_id: 'pqHfZKP75CvOlQylNhV4', // Alejandro — neutro latinoamericano
  settings: { stability: 0.55, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
};

// Guias locais — mapeados às vozes ElevenLabs disponíveis
// Prioridade: sotaque regional > gênero > naturalidade
const GUIDE_VOICES = {
  argentina:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.30, use_speaker_boost: true } }, // Valentina — mexicana/neutra (ideal: clonar voz rioplatense)
  bolivia:     { voice_id: 'pFZP5JQG7iQjIQuC4Bku', settings: { stability: 0.50, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true } }, // Lina — neutra
  chile:       { voice_id: 'pFZP5JQG7iQjIQuC4Bku', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true } }, // Lina
  colombia:    { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: { stability: 0.45, similarity_boost: 0.85, style: 0.20, use_speaker_boost: true } }, // Lizy — colombiana
  costarica:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true } }, // Valentina
  cuba:        { voice_id: 'nPczCjzI2devNBz1zQrb', settings: { stability: 0.40, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true } }, // Eleguar — caribeño (cambiar a voz femenina cuando disponible)
  ecuador:     { voice_id: 'pFZP5JQG7iQjIQuC4Bku', settings: { stability: 0.50, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true } }, // Lina
  elsalvador:  { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Valentina
  espana:      { voice_id: 'iP95p4xoKVk53GoZ742B', settings: { stability: 0.50, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Mikel — España (cambiar a voz femenina)
  guatemala:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Valentina
  honduras:    { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Valentina
  mexico:      { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.85, style: 0.30, use_speaker_boost: true } }, // Valentina — mexicana nativa
  nicaragua:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Valentina
  panama:      { voice_id: 'nPczCjzI2devNBz1zQrb', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true } }, // Eleguar — caribeño
  paraguay:    { voice_id: 'pFZP5JQG7iQjIQuC4Bku', settings: { stability: 0.50, similarity_boost: 0.80, style: 0.15, use_speaker_boost: true } }, // Lina
  peru:        { voice_id: 'pFZP5JQG7iQjIQuC4Bku', settings: { stability: 0.50, similarity_boost: 0.80, style: 0.20, use_speaker_boost: true } }, // Lina
  puertorico:  { voice_id: 'nPczCjzI2devNBz1zQrb', settings: { stability: 0.40, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true } }, // Eleguar — caribeño
  dominicana:  { voice_id: 'nPczCjzI2devNBz1zQrb', settings: { stability: 0.40, similarity_boost: 0.85, style: 0.35, use_speaker_boost: true } }, // Eleguar — caribeño
  uruguay:     { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: { stability: 0.45, similarity_boost: 0.80, style: 0.25, use_speaker_boost: true } }, // Valentina — rioplatense
  venezuela:   { voice_id: 'nPczCjzI2devNBz1zQrb', settings: { stability: 0.42, similarity_boost: 0.85, style: 0.30, use_speaker_boost: true } }, // Eleguar — caribeño
};

// ─────────────────────────────────────────────
// GET /api/auditiva/audio/:episodeId/:sectionIndex
// Gera áudio on-demand e faz cache em disco
// ─────────────────────────────────────────────
router.get('/audio/:episodeId/:sectionIndex', authMiddleware, async (req, res) => {
  const { episodeId, sectionIndex } = req.params;
  const idx = parseInt(sectionIndex);

  if (!episodeId || isNaN(idx) || idx < 0 || idx > 20) {
    return res.status(400).json({ error: 'Parâmetros inválidos.' });
  }

  // Hash único para esta seção
  const cacheKey = `${episodeId}_sec${idx}`;
  const filePath = path.join(AUDITIVA_CACHE_DIR, `${cacheKey}.mp3`);

  // 1. Serve do cache se já existe
  if (fs.existsSync(filePath)) {
    console.log(`[AUDITIVA] Cache HIT — ${cacheKey}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('X-Cache', 'HIT');
    res.set('Cache-Control', 'public, max-age=604800'); // 7 dias
    return res.sendFile(filePath);
  }

  // 2. Precisa dos dados da seção para gerar
  const { text, speaker, countryCode } = req.query;
  if (!text || !speaker || !countryCode) {
    return res.status(400).json({ error: 'Parâmetros text, speaker e countryCode são obrigatórios na primeira geração.' });
  }

  if (text.length > 2000) {
    return res.status(400).json({ error: 'Texto muito longo.' });
  }

  // 3. Resolver voz: narrador ou guia local
  const isNarrator = speaker === 'narrator';
  const voiceConfig = isNarrator ? NARRATOR_VOICE : (GUIDE_VOICES[countryCode] || GUIDE_VOICES.mexico);

  try {
    console.log(`[AUDITIVA] Gerando áudio | ${cacheKey} | ${isNarrator ? 'narrador' : 'guia ' + countryCode} | ${text.substring(0, 50)}...`);

    const response = await axios.post(
      `${ELEVENLABS_BASE}/text-to-speech/${voiceConfig.voice_id}`,
      {
        text: text.trim(),
        model_id: 'eleven_multilingual_v2',
        voice_settings: voiceConfig.settings
      },
      {
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        responseType: 'arraybuffer',
        timeout: 60000 // 60s para textos longos
      }
    );

    const audioBuffer = Buffer.from(response.data);

    // Salvar em disco — cache permanente
    fs.writeFileSync(filePath, audioBuffer);
    console.log(`[AUDITIVA] ✅ Salvo ${audioBuffer.length} bytes — ${cacheKey}.mp3`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', audioBuffer.length);
    res.set('X-Cache', 'MISS');
    res.set('Cache-Control', 'public, max-age=604800');
    res.send(audioBuffer);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[AUDITIVA] Erro ElevenLabs (${status}):`, err.message);
    if (status === 429) {
      return res.status(429).json({ error: 'Limite de áudio atingido. Tente em alguns minutos.' });
    }
    res.status(500).json({ error: 'Erro ao gerar áudio.' });
  }
});

module.exports = router;
