/**
 * IMERSÃO NATIVA - Rota de Áudios dos Exames
 * Serve metadados e arquivos MP3 dos exercícios DELE/SIELE
 *
 * GET /api/exam-audio/list          → lista todos os exercícios
 * GET /api/exam-audio/stats         → estatísticas gerais
 * GET /api/exam-audio/:id           → metadados de um exercício
 * GET /api/exam-audio/:id/audio     → serve o arquivo MP3
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');

// ─────────────────────────────────────────────
// CARGA DOS EXERCÍCIOS
// Lê os JSONs de dados ao iniciar e faz cache
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
    if (!fs.existsSync(filepath)) {
      console.warn(`[EXAM-AUDIO] Arquivo não encontrado: ${filename}`);
      continue;
    }
    try {
      const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
      if (data.ejercicios) {
        Object.assign(merged, data.ejercicios);
        console.log(`[EXAM-AUDIO] ✅ Carregado: ${filename}`);
      }
    } catch (err) {
      console.error(`[EXAM-AUDIO] Erro ao carregar ${filename}:`, err.message);
    }
  }

  exercisesCache = merged;
  return exercisesCache;
}

// Converte o mapa de exercícios num array plano
function getAllExercises() {
  const data = loadExercises();
  const all = [];
  for (const exercises of Object.values(data)) {
    if (Array.isArray(exercises)) {
      all.push(...exercises);
    }
  }
  return all;
}

// Verifica se o MP3 existe para um exercício
function hasAudio(exerciseId) {
  const safeId = exerciseId.replace(/[^a-zA-Z0-9_-]/g, '');
  const audioPath = path.join(__dirname, `../public/audios/${safeId}.mp3`);
  return fs.existsSync(audioPath);
}

// ─────────────────────────────────────────────
// GET /api/exam-audio/list
// Query params: level, exam, has_audio
// ─────────────────────────────────────────────
router.get('/list', (req, res) => {
  const { level, exam, has_audio } = req.query;

  let exercises = getAllExercises().map(ex => ({
    id: ex.id,
    titulo: ex.titulo,
    nivel: ex.nivel,
    examen: ex.examen,
    tipo: ex.tipo,
    duracion_segundos: ex.duracion_segundos,
    num_personajes: ex.personajes?.length || 0,
    num_lineas: ex.lineas?.length || 0,
    has_audio: hasAudio(ex.id)
  }));

  // Filtros opcionais
  if (level) {
    exercises = exercises.filter(e =>
      e.nivel.toUpperCase() === level.toUpperCase()
    );
  }
  if (exam) {
    exercises = exercises.filter(e =>
      e.examen.toUpperCase() === exam.toUpperCase()
    );
  }
  if (has_audio === 'true') {
    exercises = exercises.filter(e => e.has_audio);
  }
  if (has_audio === 'false') {
    exercises = exercises.filter(e => !e.has_audio);
  }

  res.json({
    total: exercises.length,
    exercises
  });
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/stats
// Resumo por nível e exame
// ─────────────────────────────────────────────
router.get('/stats', (req, res) => {
  const exercises = getAllExercises();
  const stats = {};

  for (const ex of exercises) {
    const key = `${ex.examen}_${ex.nivel}`;
    if (!stats[key]) {
      stats[key] = {
        examen: ex.examen,
        nivel: ex.nivel,
        total: 0,
        with_audio: 0,
        without_audio: 0
      };
    }
    stats[key].total++;
    if (hasAudio(ex.id)) {
      stats[key].with_audio++;
    } else {
      stats[key].without_audio++;
    }
  }

  const summary = Object.values(stats).sort((a, b) => {
    const levelOrder = { A1: 1, A2: 2, B1: 3, B2: 4, C1: 5, C2: 6 };
    return (levelOrder[a.nivel] || 0) - (levelOrder[b.nivel] || 0);
  });

  res.json({
    total_exercises: exercises.length,
    total_with_audio: exercises.filter(e => hasAudio(e.id)).length,
    by_level: summary
  });
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/:id
// Retorna metadados completos de um exercício
// ─────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const { id } = req.params;

  // Sanitiza o ID para segurança
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const exercise = getAllExercises().find(e => e.id === safeId);

  if (!exercise) {
    return res.status(404).json({
      error: `Exercício '${safeId}' não encontrado.`
    });
  }

  const audioExists = hasAudio(safeId);

  res.json({
    ...exercise,
    audio_available: audioExists,
    audio_url: audioExists ? `/audios/${safeId}.mp3` : null
  });
});

// ─────────────────────────────────────────────
// GET /api/exam-audio/:id/audio
// Serve o arquivo MP3 diretamente
// ─────────────────────────────────────────────
router.get('/:id/audio', (req, res) => {
  const { id } = req.params;

  // Sanitiza para evitar path traversal
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const audioPath = path.join(__dirname, `../public/audios/${safeId}.mp3`);

  if (!fs.existsSync(audioPath)) {
    return res.status(404).json({
      error: `Áudio para '${safeId}' não encontrado. Execute o gerador de diálogos primeiro.`
    });
  }

  res.set('Content-Type', 'audio/mpeg');
  res.set('Cache-Control', 'public, max-age=86400'); // cache 24h no browser
  res.sendFile(audioPath);
});

// Invalida o cache de exercícios (útil ao adicionar novos JSONs)
router.post('/reload', (req, res) => {
  exercisesCache = null;
  const count = getAllExercises().length;
  res.json({
    success: true,
    message: `Cache recarregado. ${count} exercícios disponíveis.`
  });
});

module.exports = router;
