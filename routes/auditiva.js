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
  voice_id: 'l1zE9xgNpUTaQCZzpNJa', // Alberto Rodríguez — serio, narrativo, latino
  settings: { stability: 0.65, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true }
};

// Guias locais — mapeados às vozes ElevenLabs disponíveis
// Prioridade: sotaque regional > gênero > naturalidade
// Todas as guias são latinas — NUNCA sotaque de España (exceto episódio España)
// style: 0.0 em todas para evitar tom estranho
// Valentina = mexicana, Lizy = colombiana, Eleguar = caribeño
const SAFE_SETTINGS = { stability: 0.65, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true };
const CARIB_SETTINGS = { stability: 0.60, similarity_boost: 0.80, style: 0.0, use_speaker_boost: true };

const GUIDE_VOICES = {
  argentina:   { voice_id: '1WXz8v08ntDcSTeVXMN2', settings: SAFE_SETTINGS },  // Malena Tango — rioplatense, storyteller
  bolivia:     { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy — colombiana (latina, não espanhola)
  chile:       { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy
  colombia:    { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy — colombiana nativa
  costarica:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina
  cuba:        { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB_SETTINGS }, // Eleguar — caribeño
  ecuador:     { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy
  elsalvador:  { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina
  espana:      { voice_id: 'iP95p4xoKVk53GoZ742B', settings: SAFE_SETTINGS },  // Mikel — España (único caso com sotaque espanhol)
  guatemala:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina
  honduras:    { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina
  mexico:      { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina — mexicana nativa
  nicaragua:   { voice_id: 'cgSgspJ2msm6clMCkdW9', settings: SAFE_SETTINGS },  // Valentina
  panama:      { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB_SETTINGS }, // Eleguar — caribeño
  paraguay:    { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy
  peru:        { voice_id: 'XB0fDUnXU5powFXDhCwa', settings: SAFE_SETTINGS },  // Lizy
  puertorico:  { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB_SETTINGS }, // Eleguar — caribeño
  dominicana:  { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB_SETTINGS }, // Eleguar — caribeño
  uruguay:     { voice_id: '1WXz8v08ntDcSTeVXMN2', settings: SAFE_SETTINGS },  // Malena Tango — rioplatense
  venezuela:   { voice_id: 'nPczCjzI2devNBz1zQrb', settings: CARIB_SETTINGS }, // Eleguar — caribeño
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
