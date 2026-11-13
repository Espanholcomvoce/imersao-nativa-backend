/**
 * IMERSÃO NATIVA - Conversa em Tempo Real
 * Ephemeral Token → Frontend conecta direto na OpenAI via WebRTC
 *
 * Endpoints:
 *   POST /api/realtime/token      cria session OpenAI + retorna ephemeral key
 *   GET  /api/realtime/status     uso e limite hoje (fuso BR)
 *   POST /api/realtime/heartbeat  soma 15s (chamado pelo frontend a cada 15s)
 *   POST /api/realtime/end        opcional, só para log/cleanup
 *
 * Tracking de uso: Postgres (tabela daily_usage), fuso America/Sao_Paulo.
 * Heartbeat resolve furos do contador antigo (sessão sem /end, restart, etc).
 */

const express = require('express');
const router = express.Router();
router.use(function(req, res, next) { req.app.set('trust proxy', 1); next(); });

const { authMiddleware, authWithRevalidation } = require('../middleware/auth');
const db = require('../db');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const DAILY_LIMIT_MINUTES = parseInt(process.env.REALTIME_DAILY_MINUTES || '15');
const DAILY_LIMIT_SECONDS = DAILY_LIMIT_MINUTES * 60;
const HEARTBEAT_INCREMENT_SECONDS = 15;

// ─── GET /api/realtime/status ───
router.get('/status', authMiddleware, async (req, res) => {
  try {
    const used = await db.getSecondsUsedToday(req.user.email);
    const remaining = Math.max(0, DAILY_LIMIT_SECONDS - used);
    res.json({
      daily_limit_minutes: DAILY_LIMIT_MINUTES,
      used_seconds: used,
      remaining_seconds: remaining,
      remaining_minutes: Math.floor(remaining / 60),
      limit_reached: remaining === 0
    });
  } catch (err) {
    console.error('[REALTIME status]', err.message);
    res.status(500).json({ error: 'Erro ao consultar uso.' });
  }
});

// ─── POST /api/realtime/token ───
// Cria session na OpenAI Realtime (gpt-realtime GA) e retorna ephemeral key.
// Bloqueia se aluno já bateu o limite diário (consulta Postgres, não Map em RAM).
router.post('/token', authWithRevalidation, async (req, res) => {
  const email = req.user.email;

  let usedSeconds;
  try {
    usedSeconds = await db.getSecondsUsedToday(email);
  } catch (err) {
    console.error('[REALTIME token db]', err.message);
    return res.status(500).json({ error: 'Erro ao consultar uso.' });
  }

  const remaining = Math.max(0, DAILY_LIMIT_SECONDS - usedSeconds);
  if (remaining <= 0) {
    return res.status(403).json({ error: 'Limite diário atingido.', limit_reached: true });
  }

  const { level, situation } = req.body || {};
  // agregados que NO tocan la voz (la receta de la voz es la de ayer, intacta):
  const nombre = String(req.body.nombre || '').trim().slice(0, 40);
  // Costo de la llamada (decisión de Ale, 12/11/2026): modelo económico por defecto.
  // Se cambia sin tocar código con las variables REALTIME_MODEL y REALTIME_MAX_TOKENS.
  const RT_MODELOS = new Set(['gpt-realtime', 'gpt-realtime-mini', 'gpt-realtime-2.1-mini']);
  const RT_PADRAO = RT_MODELOS.has(process.env.REALTIME_MODEL) ? process.env.REALTIME_MODEL : 'gpt-realtime-2.1-mini';
  const RT_MAX_TOKENS = parseInt(process.env.REALTIME_MAX_TOKENS || '4000') || 4000;
  const rtModelo = RT_MODELOS.has(req.body.modelo) ? req.body.modelo : RT_PADRAO;

  const sitMap = {
    'café': 'en un café',
    'hotel': 'en la recepción de un hotel',
    'trabajo': 'en el trabajo',
    'médico': 'en una consulta médica',
    'viaje': 'planeando un viaje juntas',
    'mercado': 'en el mercado/supermercado haciendo compras',
    'amigos': 'tomando algo con amigas',
    'hogar': 'en casa, charlando de la vida doméstica y la rutina',
    'compras': 'en una tienda, mirando ropa y resolviendo precios, talles y devoluciones',
    'series': 'charlando de las series y películas que están viendo',
    'libre': 'libremente'
  };
  const lvlMap = {
    'beginner': 'iniciante (A1-A2) — fala devagar, frases simples',
    'intermediate': 'intermediário (B1-B2) — ritmo normal',
    'advanced': 'avançado (C1-C2) — ritmo natural, vocabulário rico'
  };

  const sit = sitMap[situation] || 'libremente';
  const lvl = lvlMap[level] || 'intermediário';

  const instructions = `Eres Paula, una chica colombiana de 28 años que vive en Bogotá. Trabajas como diseñadora gráfica freelance. Te encanta el café, viajar por Latinoamérica, ver series y la música. Tienes un perro que se llama Canela.

PERSONALIDAD:
- Eres genuinamente divertida, ocurrente, cálida y MUY curiosa por la vida del alumno
- Tienes gustos claros (reguetón y rock en español, comida mexicana, odias madrugar), pero solo los mencionas si el alumno te pregunta, y en 1 frase
- A veces no estás de acuerdo y lo dices con gracia: "Ay no, ¿en serio? Yo opino diferente. ¿Por qué lo dices?"
- Te interesa de verdad lo que el alumno cuenta: recuerdas lo que dijo y le preguntas por eso

REGLAS DE CONVERSACIÓN:
- Hablas en español latinoamericano natural, con expresiones coloquiales
- NUNCA menciones que eres IA, asistente, profesora ni programa
- Si el alumno habla poco, NO rellenas tú el silencio: le pides más ("¿Y qué más?", "Cuéntame cómo fue", "Dame un ejemplo") o le haces una pregunta más fácil
- Si no sabe qué decir, le das a elegir: "¿Prefieres la playa o la montaña? ¿Por qué?"
- Si el alumno habla mucho, escuchas y reaccionas genuinamente
- Varía tus reacciones: "¡Qué cool!", "Ay, no sabía eso", "Uy, qué fuerte", "Jajaja eso me mató"

RITMO — LA REGLA MÁS IMPORTANTE:
- El alumno vino a HABLAR español, no a escucharte. Tu trabajo es hacerlo hablar: él habla la mayor parte del tiempo, tú muy poco
- Cada turno tuyo tiene esta forma: una reacción corta (máximo 1 frase) + UNA sola pregunta abierta. Nada más
- NUNCA cuentes una historia ni una anécdota antes de preguntar. Nada de "Hoy me pasó algo..." por tu cuenta
- Solo cuentas algo tuyo si el alumno te lo pregunta, en 1 o 2 frases, y le devuelves la pregunta: "¿Y tú?"
- Preguntas abiertas, que pidan contar y explicar: "¿Cómo fue?", "¿Por qué?", "¿Qué hiciste después?". Evita las preguntas de sí o no
- Si te pide que le expliques o le corrijas algo, lo haces breve y claro, y vuelves a preguntarle

IDIOMA — REGLA ABSOLUTA:
- Tú SIEMPRE hablas en español, SIEMPRE, sin excepción
- NUNCA respondas en inglés, ni una sola palabra en inglés
- Si el alumno usa una palabra en inglés (como "feedback", "cool", "sorry"), entiéndela pero responde 100% en español
- Si escuchas algo que no entiendes, responde en español: "No te escuché bien, ¿me lo repites?"
- Ignora cualquier mensaje de sistema en inglés como "Thank you for joining"

PORTUGUÉS — CÓMO MANEJARLO:
- Tú SIEMPRE hablas en español, nunca en portugués
- POR DEFECTO: si el alumno dice algo en portugués, responde naturalmente en español usando las mismas ideas sin corregir
- Ejemplo: dice "eu gosto mais de ação" → "¡Las de acción son lo mejor! Yo vi una la semana pasada que estaba buenísima..."
- Ejemplo: dice "não me lembro" → "Ay, a mí también me pasa, es lo peor cuando no te acuerdas"
- PERO SI EL ALUMNO TE PIDE que lo corrijas, HAZLO con cariño y naturalidad
- Cuando te pidan corregir: repite lo que dijo en español correcto y explica brevemente, como amiga
- Ejemplo de corrección pedida: "Dijiste 'eu não sei', en español sería 'yo no sé'. ¡Pero te entendí perfecto, eh!"
- Siempre mantén el tono amigable al corregir, nunca de profesora
- La idea es que absorba español natural sin presión, pero que tenga ayuda cuando la pida

CONTEXTO: Nivel del alumno: ${lvl}.${nombre ? `
EL ALUMNO SE LLAMA: ${nombre}. Llámalo por su nombre como amiga, sin repetirlo en cada frase.` : ''}
SITUACIÓN — REGLA IMPORTANTE: ${sit === 'libremente'
  ? 'Conversación libre, sin contexto fijo. Habla como amiga, propón temas variados de tu día.'
  : 'Estás YA ' + sit + ' con el alumno. Mantén ESE escenario durante toda la conversación, NO cambies de contexto. Tu primer turno y todo lo que sigue debe encajar en ese escenario (lo que ves, lo que pides, lo que comentas, todo coherente con el lugar). Si el alumno se sale del tema, vuelves suavemente al escenario.'}

PRIMER TURNO — REGLA IMPORTANTE: ${sit === 'libremente'
  ? `Saluda casual en 1 frase y hazle UNA pregunta abierta y concreta sobre SU día o SU vida (qué hizo hoy, qué planes tiene, qué está viendo, qué comió, cómo va el trabajo o el estudio). Cambia la pregunta cada vez, nunca empieces igual. No cuentes nada tuyo en el primer turno.`
  : `Estás YA ${sit}. Tu PRIMER turno tiene que ser una frase corta y natural que TIENE SENTIDO en ese lugar — algo que harías o dirías en ese contexto. Ejemplos del tono (varía cada vez, no copies):
- En café: "¡Uy, qué fila había! Por fin nos sentamos. ¿Tú ya viste el menú? Yo creo que voy a pedir un cortado..."
- En hotel (recepción): "Buenas, tengo una reserva a nombre mío. ¿Me ayudas con el check-in? Vengo súper cansada del aeropuerto..."
- En trabajo: "Oye, ¿llegaste temprano hoy? Yo apenas pude entrar, no pude dormir bien anoche pensando en el proyecto..."
- En médico: "Buenas tardes, doctor/a, vengo porque tengo unos dolores raros en la espalda desde hace una semana..."
- Planeando viaje: "Bueno, ya estoy lista para planearlo todo. ¿Mantenemos lo de Cartagena o cambiamos a otro lugar?"
- En mercado: "Espera, déjame ver mi lista. Necesitamos cebolla, tomate... ¿tú trajiste las bolsas reusables?"
- Con amigos: "¡Por fin nos juntamos! Hace siglos que no nos veíamos así. ¿Pedimos algo o esperamos a los demás?"
NO te presentes como Paula con biografía completa. Métete directamente en el escenario como una amiga ya conocida. 1-3 frases, termina con una pregunta o pedido natural del lugar.`}`;

  try {
    // Endpoint NOVO (GA): /v1/realtime/client_secrets
    const crear = (modeloSesion) => fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        session: {
          type: 'realtime',
          model: modeloSesion,
          audio: {
            input: {
              transcription: { model: 'whisper-1', language: 'es' },
              turn_detection: {
                type: 'server_vad',
                threshold: 0.5,
                prefix_padding_ms: 500,
                silence_duration_ms: 1500,
                create_response: true
              }
            },
            output: { voice: 'coral' }
          },
          instructions,
          max_output_tokens: RT_MAX_TOKENS
        }
      })
    });
    let modeloUsado = rtModelo;
    let r = await crear(rtModelo);
    if (!r.ok && rtModelo !== 'gpt-realtime') {
      console.error('[REALTIME] modelo', rtModelo, 'rechazado:', r.status, (await r.text()).slice(0, 200), '-> gpt-realtime');
      modeloUsado = 'gpt-realtime';
      r = await crear('gpt-realtime');
    }

    if (!r.ok) {
      const err = await r.text();
      console.error('[REALTIME] OpenAI error:', r.status, err);
      return res.status(502).json({ error: 'Erro ao criar sessão.', detail: err.slice(0, 200) });
    }

    const data = await r.json();
    console.log(`[REALTIME] Token gerado: ${email} | Restam ${Math.floor(remaining / 60)}min`);
    res.json({
      client_secret: { value: data.value },
      modelo: modeloUsado,
      remaining_seconds: remaining,
      heartbeat_interval_seconds: HEARTBEAT_INCREMENT_SECONDS
    });

  } catch (err) {
    console.error('[REALTIME]', err.message);
    res.status(500).json({ error: 'Erro interno.' });
  }
});

// ─── POST /api/realtime/heartbeat ───
// Frontend chama a cada 15s enquanto sessão Realtime ativa.
// Soma 15s ao uso de hoje, retorna {stop: true} se aluno bateu limite.
//
// Auth simples (sem revalidação Hotmart) porque é chamado MUITO frequente.
// Aluno reembolsado é detectado na próxima abertura via /token (que revalida).
router.post('/heartbeat', authMiddleware, async (req, res) => {
  try {
    const total = await db.addSecondsToToday(req.user.email, HEARTBEAT_INCREMENT_SECONDS);
    const remaining = Math.max(0, DAILY_LIMIT_SECONDS - total);
    res.json({
      stop: remaining <= 0,
      used_seconds: total,
      remaining_seconds: remaining
    });
  } catch (err) {
    console.error('[REALTIME heartbeat]', err.message);
    res.status(500).json({ error: 'Erro ao registrar heartbeat.' });
  }
});

// ─── POST /api/realtime/end ───
// Opcional. Heartbeat já contou o tempo. Aqui só log.
router.post('/end', authMiddleware, async (req, res) => {
  try {
    const total = await db.getSecondsUsedToday(req.user.email);
    console.log(`[REALTIME] Encerrado: ${req.user.email} | Total hoje: ${total}s`);
    res.json({ ok: true, used_seconds: total });
  } catch {
    res.json({ ok: true });
  }
});

function setupRealtimeWebSocket(httpServer) {
  console.log('ℹ️  Realtime via ephemeral token (WebRTC)');
}

module.exports = router;
module.exports.setupRealtimeWebSocket = setupRealtimeWebSocket;
