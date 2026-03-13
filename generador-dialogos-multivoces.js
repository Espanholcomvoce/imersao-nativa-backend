#!/usr/bin/env node
/**
 * Imersão Nativa — Gerador de Áudios MP3
 * ----------------------------------------
 * Converte os JSON de exercícios em arquivos MP3 usando ElevenLabs.
 * Cada linha de diálogo é gerada separadamente e depois concatenada em ffmpeg.
 *
 * USO:
 *   node generador-dialogos-multivoces.js                     # tudo
 *   node generador-dialogos-multivoces.js --nivel B2          # só B2
 *   node generador-dialogos-multivoces.js --examen DELE       # só DELE
 *   node generador-dialogos-multivoces.js --id DELE_B2_01     # exercício específico
 *   node generador-dialogos-multivoces.js --nivel C1 --dry-run  # simula sem gastar API
 *
 * PRÉ-REQUISITOS:
 *   npm install axios dotenv
 *   ffmpeg instalado no sistema (brew install ffmpeg / apt install ffmpeg)
 *   ELEVENLABS_API_KEY no .env ou variável de ambiente
 *
 * SAÍDA: public/audios/<ID>.mp3
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config();

// ─── Config ───────────────────────────────────────────────────────────
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const MODEL_ID     = 'eleven_multilingual_v2';
const OUTPUT_DIR   = path.join(__dirname, 'public', 'audios');
const DATA_FILE    = path.join(__dirname, 'data', 'contenido-100-ejercicios-A2-C2.json');
const TMP_DIR      = path.join(__dirname, '.tmp_audio');
const DELAY_MS     = 1200;  // pausa entre chamadas à API (rate limit)
const MAX_RETRIES  = 3;

// Configuração de voz por nível (stability / similarity)
const VOICE_SETTINGS = {
  A2: { stability: 0.60, similarity_boost: 0.80, style: 0.10, use_speaker_boost: true },
  B1: { stability: 0.60, similarity_boost: 0.80, style: 0.10, use_speaker_boost: true },
  B2: { stability: 0.55, similarity_boost: 0.78, style: 0.15, use_speaker_boost: true },
  C1: { stability: 0.50, similarity_boost: 0.75, style: 0.20, use_speaker_boost: true },
  C2: { stability: 0.48, similarity_boost: 0.75, style: 0.22, use_speaker_boost: true },
};

// ─── Argumentos CLI ────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

const filterNivel  = getArg('--nivel');
const filterExamen = getArg('--examen');
const filterId     = getArg('--id');
const isDryRun     = hasFlag('--dry-run');
const forceRegen   = hasFlag('--force');

// ─── Helpers ────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function log(level, msg) {
  const icons = { info: '→', ok: '✅', warn: '⚠️ ', error: '❌', skip: '⏭️ ' };
  console.log(`  ${icons[level] || '·'} ${msg}`);
}

// ─── ElevenLabs TTS ─────────────────────────────────────────────────────
async function generateLineAudio(text, voiceId, settings, outputPath, attempt = 1) {
  if (isDryRun) {
    log('info', `[DRY RUN] Geraria: ${path.basename(outputPath)}`);
    return true;
  }

  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        text,
        model_id: MODEL_ID,
        voice_settings: settings,
      },
      {
        headers: {
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 30000,
      }
    );

    fs.writeFileSync(outputPath, Buffer.from(response.data));
    return true;

  } catch (err) {
    const status = err.response?.status;
    const msg    = err.response?.data?.toString() || err.message;

    if (status === 429 && attempt <= MAX_RETRIES) {
      const wait = DELAY_MS * attempt * 2;
      log('warn', `Rate limit — aguardando ${wait}ms (tentativa ${attempt}/${MAX_RETRIES})`);
      await sleep(wait);
      return generateLineAudio(text, voiceId, settings, outputPath, attempt + 1);
    }

    if (attempt <= MAX_RETRIES) {
      log('warn', `Erro ${status || 'desconhecido'} — tentativa ${attempt}/${MAX_RETRIES}`);
      await sleep(DELAY_MS * attempt);
      return generateLineAudio(text, voiceId, settings, outputPath, attempt + 1);
    }

    log('error', `Falhou após ${MAX_RETRIES} tentativas: ${msg}`);
    return false;
  }
}

// ─── ffmpeg concat ──────────────────────────────────────────────────────
function concatAudios(filePaths, outputPath) {
  return new Promise((resolve, reject) => {
    const { execSync } = require('child_process');

    // Verifica se ffmpeg está disponível
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
    } catch {
      reject(new Error('ffmpeg não encontrado. Instale com: brew install ffmpeg ou apt install ffmpeg'));
      return;
    }

    // Cria lista de arquivos para o concat
    const listFile = path.join(TMP_DIR, `_list_${Date.now()}.txt`);
    const content = filePaths
      .map(f => `file '${f.replace(/'/g, "'\\''")}'`)
      .join('\n');
    fs.writeFileSync(listFile, content);

    try {
      execSync(
        `ffmpeg -y -f concat -safe 0 -i "${listFile}" -acodec libmp3lame -q:a 4 "${outputPath}"`,
        { stdio: 'pipe' }
      );
      fs.unlinkSync(listFile);
      resolve(true);
    } catch (e) {
      fs.unlinkSync(listFile);
      reject(new Error(`ffmpeg falhou: ${e.message}`));
    }
  });
}

// ─── Gera silêncio como arquivo de áudio ────────────────────────────────
function generateSilence(durationMs, outputPath) {
  if (isDryRun) return true;
  const { execSync } = require('child_process');
  const duration = durationMs / 1000;
  try {
    execSync(
      `ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${duration} -acodec libmp3lame -q:a 4 "${outputPath}"`,
      { stdio: 'pipe' }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Processa um exercício ──────────────────────────────────────────────
async function processExercise(exercicio) {
  const { id, nivel, lineas, personajes } = exercicio;
  const outputFile = path.join(OUTPUT_DIR, `${id}.mp3`);

  // Pula se já existe e não é force
  if (!forceRegen && fs.existsSync(outputFile)) {
    log('skip', `${id} — já existe (use --force para regenerar)`);
    return { id, status: 'skipped' };
  }

  log('info', `Gerando ${id} — ${lineas.length} linhas`);

  const settings = VOICE_SETTINGS[nivel] || VOICE_SETTINGS['B1'];
  const tmpFiles = [];
  let success = true;

  for (let i = 0; i < lineas.length; i++) {
    const linha = lineas[i];
    const personagem = personajes.find(p => p.id === linha.personaje);

    if (!personagem) {
      log('warn', `Personagem ${linha.personaje} não encontrado em ${id}`);
      continue;
    }

    const tmpFile = path.join(TMP_DIR, `${id}_line_${i}.mp3`);
    log('info', `  [${i+1}/${lineas.length}] ${personagem.nombre}: "${linha.texto.substring(0, 50)}..."`);

    const ok = await generateLineAudio(
      linha.texto,
      personagem.voice_id,
      settings,
      tmpFile
    );

    if (!ok) {
      success = false;
      break;
    }

    tmpFiles.push(tmpFile);

    // Pausa entre linhas
    if (linha.pausa_despues > 0 && i < lineas.length - 1) {
      const silenceDuration = Math.round(linha.pausa_despues * 1000);
      const silenceFile = path.join(TMP_DIR, `${id}_silence_${i}.mp3`);
      generateSilence(silenceDuration, silenceFile);
      tmpFiles.push(silenceFile);
    }

    // Delay entre chamadas à API
    if (!isDryRun && i < lineas.length - 1) {
      await sleep(DELAY_MS);
    }
  }

  if (!success) {
    // Limpa temporários
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
    return { id, status: 'error' };
  }

  // Concat de todos os segmentos
  if (!isDryRun) {
    try {
      await concatAudios(tmpFiles, outputFile);
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      const size = Math.round(fs.statSync(outputFile).size / 1024);
      log('ok', `${id}.mp3 gerado (${size} KB)`);
      return { id, status: 'ok', size_kb: size };
    } catch (err) {
      log('error', `${id} — erro ao concatenar: ${err.message}`);
      tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
      return { id, status: 'error', error: err.message };
    }
  } else {
    log('ok', `${id} — dry-run completo`);
    return { id, status: 'dry-run' };
  }
}

// ─── Main ───────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎙️  Imersão Nativa — Gerador de Áudios Multi-Vozes');
  console.log('══════════════════════════════════════════════════\n');

  // Validação
  if (!isDryRun && !ELEVENLABS_API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY não encontrada. Configure no .env ou como variável de ambiente.\n');
    process.exit(1);
  }

  // Verifica ffmpeg
  if (!isDryRun) {
    try {
      require('child_process').execSync('ffmpeg -version', { stdio: 'ignore' });
    } catch {
      console.error('❌ ffmpeg não encontrado.\n   macOS: brew install ffmpeg\n   Ubuntu: sudo apt install ffmpeg\n');
      process.exit(1);
    }
  }

  // Lê exercícios
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`❌ Arquivo não encontrado: ${DATA_FILE}`);
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  let exercises = Object.values(data.ejercicios).flat();

  // Filtros
  if (filterId) {
    exercises = exercises.filter(e => e.id === filterId);
  } else {
    if (filterNivel)  exercises = exercises.filter(e => e.nivel  === filterNivel.toUpperCase());
    if (filterExamen) exercises = exercises.filter(e => e.examen === filterExamen.toUpperCase());
  }

  if (exercises.length === 0) {
    console.log('⚠️  Nenhum exercício encontrado com os filtros especificados.\n');
    process.exit(0);
  }

  // Setup dirs
  ensureDir(OUTPUT_DIR);
  ensureDir(TMP_DIR);

  console.log(`📋 Exercícios a processar: ${exercises.length}`);
  if (isDryRun) console.log('🔍 Modo DRY RUN — nenhuma chamada à API será feita');
  if (forceRegen) console.log('♻️  FORCE — regenera mesmo se já existe');
  console.log('');

  // Estimativa de custo ElevenLabs
  if (!isDryRun) {
    const totalChars = exercises.reduce((sum, ex) =>
      sum + ex.lineas.reduce((s, l) => s + l.texto.length, 0), 0);
    console.log(`💰 Estimativa: ~${totalChars.toLocaleString()} caracteres`);
    console.log(`   ElevenLabs cobra por caractere — verifique sua cota antes de continuar.\n`);
  }

  // Processa cada exercício
  const results = { ok: [], skipped: [], error: [] };
  const startTime = Date.now();

  for (const exercicio of exercises) {
    const result = await processExercise(exercicio);
    results[result.status === 'dry-run' ? 'ok' : result.status]?.push(result.id);
    console.log(''); // linha em branco entre exercícios
  }

  // ─── Relatório final ──────────────────────────────────────────────────
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('\n══════════════════════════════════════════════════');
  console.log('📊 RELATÓRIO FINAL');
  console.log(`   ✅ Gerados:  ${results.ok.length}`);
  console.log(`   ⏭️  Pulados:  ${results.skipped.length}`);
  console.log(`   ❌ Erros:    ${results.error.length}`);
  console.log(`   ⏱️  Tempo:    ${elapsed}s`);

  if (results.error.length > 0) {
    console.log('\n❌ IDs com erro:');
    results.error.forEach(id => console.log(`   - ${id}`));
  }

  // Limpa dir temporário
  try {
    const tmpFiles = fs.readdirSync(TMP_DIR);
    if (tmpFiles.length === 0) fs.rmdirSync(TMP_DIR);
  } catch {}

  console.log('\n✅ Concluído!\n');
  console.log('   Os arquivos MP3 foram salvos em: public/audios/');
  console.log('   Para usar no backend, mova a pasta public/ para a raiz do servidor.\n');
}

main().catch(err => {
  console.error('\n❌ Erro fatal:', err.message);
  process.exit(1);
});
