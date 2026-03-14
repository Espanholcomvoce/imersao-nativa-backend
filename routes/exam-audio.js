/**
 * IMERSÃO NATIVA - Áudios dos Exames DELE/SIELE
 * Gera diálogos com ElevenLabs on-demand e cacheia em disco
 *
 * GET /api/exam-audio/list        → lista exercícios
 * GET /api/exam-audio/:id         → metadados do exercício
 * GET /api/exam-audio/:id/audio   → gera/serve MP3 do diálogo completo
 * GET /api/exam-audio/:id/line/:n → gera/serve MP3 de uma linha
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { authMiddleware } = require('../middleware/auth');

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// Cache em disco
const EXAM_CACHE_DIR = path.join('/tmp', 'exam-audio');
if (!fs.existsSync(EXAM_CACHE_DIR)) {
  fs.mkdirSync(EXAM_CACHE_DIR, { recursive: true });
}

// ─────────────────────────────────────────────
// VOZES — sem voice_settings para soar natural
// igual ao player do ElevenLabs
// ─────────────────────────────────────────────
const VOICES = {
  Valentina: 'j7e3J6ksqsziQcIGyAWI',
  Mario:     'tomkxGQGz4b1kE0EM722',
  Alberto:   'l1zE9xgNpUTaQCZzpNJa',
  Sandra:    'rEVYTKPqwSMhytFPayIb',
  Carolina:  'cIBxLwfshLYhRB9lCXEg',
  // fallbacks pelos nomes originais do JSON
  Alejandro: 'l1zE9xgNpUTaQCZzpNJa',
  Lizy:      'rEVYTKPqwSMhytFPayIb',
  Lina:      'j7e3J6ksqsziQcIGyAWI',
  Mikel:     'tomkxGQGz4b1kE0EM722',
  Eleguar:   'tomkxGQGz4b1kE0EM722',
};

// Resolve voice_id — usa o do JSON se for válido, senão mapeia pelo nome
function resolveVoice(personaje) {
  if (personaje.voice_id && Object.values(VOICES).includes(personaje.voice_id)) {
    return personaje.voice_id;
  }
  return VOICES[personaje.nombre] || VOICES.Valentina;
}

// ─────────────────────────────────────────────
// CARGA DOS EXERCÍCIOS
// ─────────────────────────────────────────────
let exercisesCache = null;

function loadExercises() {
  if (exercisesCache) return exercisesCache;
  const dataDir = path.join(__dirname, '../data');
  const files = [
    'contenido-20-ejercicios-A1.json',
    'contenido-100-ejercicios-A2-C2.json'
  ];
  const merged = {};
  for (const filename of files) {
    const filepath = path.join(dataDir, filename);
    if (!fs.existsSync(filepath)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if (data.ejercicios) Object.assign(merged, data.ejercicios);
    } catch (err) {
      console.error(`[EXAM-AUDIO] Erro ao carregar ${filename}:`, err.message);
    }
  }
  exercisesCache = merged;
  return merged;
}

function getAllExercises() {
  const data = loadExercises();
  const all = [];
  for (const exercises of Object.values(data)) {
    if (Array.isArray(exercises)) all.push(...exercises);
  }
  return all;
}

function findExercise(id) {
  return getAllExercises().find(e => e.id === id.replace(/[^a-zA-Z0-9_-]/g, ''));
}

// ─────────────────────────────────────────────
// GERAÇÃO DE ÁUDIO com ElevenLabs
// Sem voice_settings = usa configurações nativas da voz
// ─────────────────────────────────────────────
async function generateAudio(text, voiceId) {
  const response = await axios.post(
    `${ELEVENLABS_BASE}/text-to-speech/${voiceId}`,
    {
      text,
      model_id: 'eleven_multilingual_v2'
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
  return Buffer.from(response.data);
}

// Concatena buffers MP3 simples (sem silêncio entre linhas por ora)
function concatBuffers(buffers) {
  return Buffer.concat(buffers);
}

// ─────────────────────────────────────────────
// GET /api/exam-audio/list
// ─────────────────────────────────────────────
router.get('/list', authMiddleware, (req, res) => {
  const { level, exam } = req.query;
  let exercises = getAllExercises().map(ex => ({
    id: ex.id,
    titulo: ex.titulo,
    nivel: ex.nivel,
    examen: ex.examen,
    num_personajes: ex.personajes?.length || 0,
    num_lineas: ex.lineas?.length || 0,
  }));
  if (level) exercises = exercises.filter(e => e.nivel.toUpperCase() === level.toUpperCase());
  if (exam) exercises = exercises.filter(e => e.examen.toUpperCase() === exam.toUpperCase());
  res.json({ total: exercises.length, exercises });
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/:id
// ─────────────────────────────────────────────
router.get('/:id', authMiddleware, (req, res) => {
  const exercise = findExercise(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'Exercício não encontrado.' });

  // Verifica se o áudio completo já está em cache
  const cacheFile = path.join(EXAM_CACHE_DIR, `${exercise.id}_full.mp3`);
  res.json({
    ...exercise,
    audio_cached: fs.existsSync(cacheFile),
    audio_url: `/api/exam-audio/${exercise.id}/audio`
  });
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/:id/audio
// Gera diálogo completo — cacheia em disco
// ─────────────────────────────────────────────
router.get('/:id/audio', authMiddleware, async (req, res) => {
  const exercise = findExercise(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'Exercício não encontrado.' });

  const cacheFile = path.join(EXAM_CACHE_DIR, `${exercise.id}_full.mp3`);

  // Serve do cache se existir
  if (fs.existsSync(cacheFile)) {
    console.log(`[EXAM-AUDIO] Cache HIT — ${exercise.id}`);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cacheFile);
  }

  // Gera linha por linha e concatena
  try {
    console.log(`[EXAM-AUDIO] Gerando diálogo — ${exercise.id} (${exercise.lineas?.length || 0} linhas)`);

    const personajesMap = {};
    (exercise.personajes || []).forEach(p => {
      personajesMap[p.nombre] = resolveVoice(p);
    });

    const buffers = [];
    for (const linea of (exercise.lineas || [])) {
      const voiceId = personajesMap[linea.personaje] || VOICES.Valentina;
      const text = linea.texto;
      console.log(`[EXAM-AUDIO]   ${linea.personaje}: "${text.substring(0,40)}..."`);
      const buf = await generateAudio(text, voiceId);
      buffers.push(buf);
      // Pequena pausa entre falas (250ms de silêncio aproximado)
      await new Promise(r => setTimeout(r, 200));
    }

    const fullAudio = concatBuffers(buffers);
    fs.writeFileSync(cacheFile, fullAudio);
    console.log(`[EXAM-AUDIO] ✅ Salvo ${fullAudio.length} bytes — ${exercise.id}_full.mp3`);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', fullAudio.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(fullAudio);

  } catch (err) {
    const status = err.response?.status;
    console.error(`[EXAM-AUDIO] Erro (${status}):`, err.message);
    if (status === 429) return res.status(429).json({ error: 'Limite de áudio atingido.' });
    res.status(500).json({ error: 'Erro ao gerar áudio do diálogo.' });
  }
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/:id/line/:n
// Gera áudio de uma linha específica (0-indexed)
// ─────────────────────────────────────────────
router.get('/:id/line/:n', authMiddleware, async (req, res) => {
  const exercise = findExercise(req.params.id);
  if (!exercise) return res.status(404).json({ error: 'Exercício não encontrado.' });

  const n = parseInt(req.params.n);
  const linea = exercise.lineas?.[n];
  if (!linea) return res.status(404).json({ error: 'Linha não encontrada.' });

  const cacheFile = path.join(EXAM_CACHE_DIR, `${exercise.id}_line${n}.mp3`);

  if (fs.existsSync(cacheFile)) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.sendFile(cacheFile);
  }

  try {
    const personajesMap = {};
    (exercise.personajes || []).forEach(p => {
      personajesMap[p.nombre] = resolveVoice(p);
    });

    const voiceId = personajesMap[linea.personaje] || VOICES.Valentina;
    const buf = await generateAudio(linea.texto, voiceId);
    fs.writeFileSync(cacheFile, buf);

    res.set('Content-Type', 'audio/mpeg');
    res.set('Content-Length', buf.length);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);

  } catch (err) {
    res.status(500).json({ error: 'Erro ao gerar áudio da linha.' });
  }
});

module.exports = router;
