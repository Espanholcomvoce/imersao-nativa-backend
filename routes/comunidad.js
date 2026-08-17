/**
 * IMERSÃO NATIVA — Comunidad (publicaciones, comentarios, reacciones)
 *
 * Hasta ahora la comunidad era sólo diseño: los posts vivían fijos en el HTML.
 * Acá pasan a vivir en Postgres, y Claude cumple dos papeles con reglas claras:
 *
 *   1. Moderación + clasificación silenciosa de cada publicación (Haiku).
 *   2. Matías responde preguntas que nadie respondió, FIRMANDO como Matías.
 *      Nunca un bot haciéndose pasar por alumno.
 *
 * El contenido semilla (alumnos de ejemplo del diseño aprobado) se inserta una
 * sola vez, marcado seed=true, para que el primer alumno real no entre a una
 * comunidad vacía. Son publicaciones estáticas: no responden ni interactúan.
 *
 * Rotas (todas con token; sólo GET/POST por el CORS del servidor):
 *   GET  /api/comunidad/feed        ?categoria=&tag=&limit=
 *   GET  /api/comunidad/post        ?id=
 *   GET  /api/comunidad/actividad
 *   POST /api/comunidad/publicar    { categoria, tag, pais, titulo, texto, formato }
 *   POST /api/comunidad/comentar    { post_id, texto }
 *   POST /api/comunidad/reaccionar  { post_id, tipo: 'like' | 'save' }
 */

const express = require('express');
const router = express.Router();
const Anthropic = require('@anthropic-ai/sdk');
const { authMiddleware } = require('../middleware/auth');
const { pool } = require('../db');

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Mismos modelos que ya usa el resto del backend (routes/chat.js).
const MODELO_RAPIDO = 'claude-haiku-4-5-20251001';   // moderar + clasificar
const MODELO_MATIAS = 'claude-sonnet-4-20250514';    // respuestas visibles

const CATEGORIAS = ['viajes', 'experiencias', 'recomendaciones', 'aprendizaje', 'paises', 'preguntas', 'conquistas'];
const MAX_TITULO = 120;
const MAX_TEXTO = 4000;
const MAX_COMENTARIO = 1500;
const MAX_POSTS_DIA = 20;          // por alumno
const MAX_MATIAS_DIA = 10;         // respuestas automáticas por día, control de costo

// ── Tablas + semilla ──────────────────────────────────────────────────────
let tablasListas = false;
async function garantirTablas() {
  if (tablasListas || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id                SERIAL PRIMARY KEY,
      email             TEXT NOT NULL,
      nombre            TEXT NOT NULL,
      pais              TEXT DEFAULT '',
      categoria         TEXT NOT NULL,
      tag               TEXT DEFAULT '',
      titulo            TEXT DEFAULT '',
      texto             TEXT NOT NULL,
      formato           TEXT DEFAULT 'texto',
      avatar            TEXT DEFAULT '',
      img               TEXT DEFAULT '',
      likes_base        INT DEFAULT 0,
      seed              BOOLEAN DEFAULT FALSE,
      matias_respondido BOOLEAN DEFAULT FALSE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id         SERIAL PRIMARY KEY,
      post_id    INT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      nombre     TEXT NOT NULL,
      texto      TEXT NOT NULL,
      matias     BOOLEAN DEFAULT FALSE,
      seed       BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_reactions (
      post_id    INT NOT NULL REFERENCES community_posts(id) ON DELETE CASCADE,
      email      TEXT NOT NULL,
      tipo       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (post_id, email, tipo)
    );`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_cposts_cat ON community_posts(categoria, created_at DESC);`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_ccomments_post ON community_comments(post_id);`);
  await sembrar();
  tablasListas = true;
}

// El contenido del diseño aprobado, como historia previa de la comunidad.
const SEMILLA = [
  { d: 20, n: 'Lucía', p: 'Chile', c: 'viajes', t: 'experiencias', ti: '5 días en Cartagena: mi experiencia 🌴',
    tx: 'Cartagena me enamoró desde el primer día. La ciudad amurallada es hermosa, la gente súper amable y la comida… ¡deliciosa!',
    av: 'av-lucia2.jpg', img: 'vj-cartagena.jpg', lk: 34,
    com: [['Marina', 'Argentina', '¡Qué lindo! ¿Fuiste en temporada alta? Quiero ir este año.'],
          ['Diego', 'España', 'La comida de la costa colombiana es otro nivel 😍']] },
  { d: 18, n: 'Carlos', p: 'España', c: 'viajes', t: 'consejos', ti: 'Consejos para moverse en Madrid 🚇',
    tx: 'Si vas a Madrid, te recomiendo sacar la tarjeta Multi. Te ahorras dinero y es súper fácil de usar en metro y bus.',
    av: 'av-carlos.jpg', img: 'vj-madrid.jpg', lk: 28,
    com: [['Lucía', 'Chile', 'Confirmo, la usé el mes pasado y funciona perfecto.']] },
  { d: 16, n: 'Marina', p: 'Argentina', c: 'viajes', t: 'restaurantes', ti: 'Un restaurante imperdible en Buenos Aires 😊',
    tx: 'Probé este lugar increíble en Palermo. La comida, la atención y el ambiente 10/10. ¡Súper recomendado!',
    av: 'av-marina.jpg', img: 'vj-resto.jpg', lk: 21, com: [] },
  { d: 15, n: 'Diego', p: 'España', c: 'experiencias', t: 'reuniones', ti: '3 errores que cometía en reuniones (y cómo los corregí) 💡',
    tx: 'Al principio hablaba demasiado rápido y no dejaba que los demás participaran. Después de practicar estas 3 cosas, todo cambió.',
    av: 'av-diego.jpg', img: 'ex-reunion.jpg', lk: 29,
    com: [['Carolina', 'Argentina', '¿Puedes contar cuáles son las 3 cosas? Me pasa igual 🙈']] },
  { d: 13, n: 'Lucía', p: 'Chile', c: 'experiencias', t: 'correos', ti: 'Frases que uso en correos y me hicieron la vida más fácil 📧',
    tx: 'Te comparto expresiones que uso en mi día a día y que suenan profesionales y naturales.',
    av: 'av-lucia2.jpg', img: 'ex-correos.jpg', lk: 24, com: [] },
  { d: 12, n: 'Carlos', p: 'México', c: 'experiencias', t: 'entrevistas', ti: 'Cómo preparé mi entrevista en español (y conseguí el trabajo) 🎉',
    tx: 'Practiqué estas preguntas y respuestas clave. Si tienes una entrevista, ¡dale un vistazo!',
    av: 'av-carlos.jpg', img: 'ex-entrevista.jpg', lk: 36,
    com: [['Marina', 'Argentina', '¡Felicitaciones! 🎉'], ['Diego', 'España', 'Gracias por compartir, tengo una entrevista pronto.']] },
  { d: 11, n: 'Lucía', p: 'España', c: 'recomendaciones', t: 'series', ti: 'La serie que me ayudó a entender el español real 🎬',
    tx: '"Élite" me enseñó muchísimo vocabulario coloquial y expresiones que no salen en los libros. ¡Súper recomiendo!',
    av: 'av-lucia2.jpg', img: '', lk: 32, com: [] },
  { d: 10, n: 'Diego', p: 'Colombia', c: 'recomendaciones', t: 'podcasts', ti: 'Podcast para aprender escuchando 🎧',
    tx: '"Entiende tu mente" tiene episodios increíbles y en español neutro. Ideal para escuchar en cualquier momento.',
    av: 'av-diego.jpg', img: '', lk: 28, com: [] },
  { d: 9, n: 'Marina', p: 'Argentina', c: 'recomendaciones', t: 'libros', ti: 'Un libro que no pude soltar 📚',
    tx: '"Como agua para chocolate" es hermoso y el español es precioso. Me hizo amar aún más la lengua.',
    av: 'av-marina.jpg', img: '', lk: 41, com: [] },
  { d: 8, n: 'Lucía', p: 'Chile', c: 'aprendizaje', t: 'rutinas', ti: 'Mi rutina de 30 minutos que realmente funciona ⏰',
    tx: 'Te comparto cómo organizo mis 30 minutos diarios para avanzar sin sentir que estudio demasiado. ¡Constancia > Motivación! 💪',
    av: 'av-lucia2.jpg', img: 'ap-rutina.jpg', lk: 42,
    com: [['Marcos', 'México', '¿A qué hora estudias? Yo sólo logro de noche.']] },
  { d: 7, n: 'Diego', p: 'España', c: 'aprendizaje', t: 'metodos', ti: 'Así uso la técnica Pomodoro para estudiar español 🍅',
    tx: '25 minutos de enfoque + 5 de pausa. Te explico cómo la adapto con Paula y lecturas para mantenerme concentrado.',
    av: 'av-diego.jpg', img: 'ap-pomodoro.jpg', lk: 31, com: [] },
  { d: 6, n: 'Marina', p: 'Argentina', c: 'aprendizaje', t: 'obstaculos', ti: 'Cuando me estanco, hago esto 👇',
    tx: 'Todos pasamos por eso. Estas 3 cosas me ayudan a recuperar el foco y seguir avanzando sin frustrarme.',
    av: 'av-marina.jpg', img: 'ap-montana.jpg', lk: 38, com: [] },
  { d: 6, n: 'Lucía', p: 'Colombia', c: 'paises', t: 'colombia', ti: 'Expresiones que solo entenderás en Colombia 🇨🇴',
    tx: 'Les comparto algunas palabras y expresiones que escucho todos los días aquí y que al principio me confundían mucho. ¡Espero que les sirva!',
    av: 'av-lucia2.jpg', img: 'pa-colombia.jpg', lk: 36, com: [] },
  { d: 5, n: 'Diego', p: 'México', c: 'paises', t: 'mexico', ti: '10 cosas que me sorprendieron de México 🇲🇽',
    tx: 'Después de 2 meses viviendo en México, estas son algunas costumbres y cosas que me llamaron mucho la atención.',
    av: 'av-diego.jpg', img: 'pa-mexico.jpg', lk: 29, com: [] },
  { d: 4, n: 'Marina', p: 'España', c: 'paises', t: 'espana', ti: 'Diferencias de vocabulario entre España y América 💡',
    tx: 'Palabras que significan cosas distintas según el país. ¡Cuidado con estos falsos amigos!',
    av: 'av-marina.jpg', img: 'pa-espana.jpg', lk: 41, com: [] },
  { d: 3, n: 'Carolina', p: 'Argentina', c: 'preguntas', t: 'gramatica', ti: '¿Cuándo usar "ser" y cuándo "estar"?',
    tx: 'Siempre me confundo entre "soy cansada" y "estoy cansada". ¿Alguien tiene algún truco fácil para diferenciarlas? 🙏',
    av: 'av-carolina.jpg', img: '', lk: 28,
    com: [['Diego', 'España', 'Lo que a mí me sirvió: ser = qué eres, estar = cómo estás. "Soy alto" no cambia, "estoy cansado" sí.'],
          ['Marina', 'Argentina', 'Y ojo con "estar cansada" vs "ser cansadora" jaja, son cosas muy distintas.']] },
  { d: 2, n: 'Diego', p: 'Colombia', c: 'preguntas', t: 'vocabulario', ti: '¿Cómo decir "mejorar" sin repetir siempre "mejorar"?',
    tx: 'Quiero variar mi vocabulario. ¿Qué otras palabras o expresiones puedo usar en diferentes contextos? ¡Gracias!',
    av: 'av-diego.jpg', img: '', lk: 21,
    com: [['Lucía', 'España', 'Avanzar, progresar, perfeccionar, pulir… depende del contexto.']] },
  { d: 2, n: 'Lucía', p: 'España', c: 'preguntas', t: 'pronunciacion', ti: 'No entiendo la "r" fuerte 😩',
    tx: 'Hago los ejercicios pero todavía no me sale natural. ¿Algún consejo que les haya funcionado?',
    av: 'av-lucia2.jpg', img: '', lk: 17, com: [] },
  { d: 1, n: 'Marcos', p: 'México', c: 'preguntas', t: 'cultura', ti: '¿Es correcto decir "ordenador" en todos los países?',
    tx: 'Vi que en algunos países dicen "computadora". ¿Hay otras diferencias de palabras que deba tener en cuenta? 🌎',
    av: 'av-marcos.jpg', img: '', lk: 35,
    com: [['Carlos', 'España', 'En España decimos ordenador, en América casi siempre computadora. Las dos se entienden.']] },
  { d: 1, n: 'Marina', p: 'Argentina', c: 'conquistas', t: '', ti: '¡Alcancé 60 días de constancia!',
    tx: 'No fue fácil todos los días, pero acá estoy. ¡Vamos por más!',
    av: 'av-marina.jpg', img: '', lk: 32,
    com: [['Lucía', 'Chile', '¡Grande Marina! 👏👏']] },
  { d: 0.5, n: 'Julián', p: 'Colombia', c: 'viajes', t: 'lugares', ti: 'Mejores planes en Medellín',
    tx: 'Lugares, cafés, museos y experiencias que no te puedes perder.',
    av: 'av-julian.jpg', img: 'feed-medellin.jpg', lk: 21, com: [] }
];

async function sembrar() {
  const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM community_posts');
  if (rows[0].n > 0) return;
  console.log('[COMUNIDAD] Base vacía: insertando contenido semilla…');
  for (const s of SEMILLA) {
    const r = await pool.query(
      `INSERT INTO community_posts (email, nombre, pais, categoria, tag, titulo, texto, formato, avatar, img, likes_base, seed, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'texto',$8,$9,$10,TRUE, NOW() - ($11 || ' days')::interval)
       RETURNING id, created_at`,
      [`seed+${s.n.toLowerCase()}@comunidad.interna`, s.n, s.p, s.c, s.t, s.ti, s.tx, s.av, s.img, s.lk, String(s.d)]
    );
    for (let i = 0; i < s.com.length; i++) {
      const [cn, cp, ct] = s.com[i];
      await pool.query(
        `INSERT INTO community_comments (post_id, email, nombre, texto, seed, created_at)
         VALUES ($1,$2,$3,$4,TRUE, $5::timestamptz + ($6 || ' hours')::interval)`,
        [r.rows[0].id, `seed+${cn.toLowerCase()}@comunidad.interna`, `${cn} · ${cp}`, ct, r.rows[0].created_at, String(2 + i * 5)]
      );
    }
  }
  console.log(`[COMUNIDAD] Semilla lista: ${SEMILLA.length} publicaciones.`);
}

// ── Utilidades ────────────────────────────────────────────────────────────
function nombreDe(req) {
  const n = (req.body?.nombre || '').toString().trim().slice(0, 60);
  if (n) return n;
  const email = (req.user?.email || '');
  const usuario = email.split('@')[0];
  const base = usuario.split(/[._\-+0-9]/)[0];
  const largoMax = /[._\-+]/.test(usuario) ? 14 : 10;
  if (!base || base.length < 3 || base.length > largoMax) return 'Alumno';
  return base.charAt(0).toUpperCase() + base.slice(1).toLowerCase();
}

const CAMPOS_POST = `
  p.id, p.nombre, p.pais, p.categoria, p.tag, p.titulo, p.texto, p.formato,
  p.avatar, p.img, p.seed, p.created_at,
  p.likes_base + (SELECT COUNT(*)::int FROM community_reactions r WHERE r.post_id = p.id AND r.tipo = 'like') AS likes,
  (SELECT COUNT(*)::int FROM community_comments c WHERE c.post_id = p.id) AS comentarios,
  EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.tipo = 'like' AND r.email = $1) AS mi_like,
  EXISTS(SELECT 1 FROM community_reactions r WHERE r.post_id = p.id AND r.tipo = 'save' AND r.email = $1) AS mi_guardado`;

// ── Moderación + clasificación (silenciosa, falla abierta) ───────────────
async function moderarYClasificar(titulo, texto, categoria) {
  if (!anthropic) return { ok: true, categoria };
  try {
    const r = await anthropic.messages.create({
      model: MODELO_RAPIDO,
      max_tokens: 200,
      system:
        'Eres el moderador de una comunidad de brasileños que aprenden español. ' +
        'Responde SOLO un JSON: {"permitido":bool,"motivo":str,"categoria":str,"pais":str}. ' +
        'Rechaza (permitido=false) únicamente: spam comercial, enlaces sospechosos, ofensas, ' +
        'acoso, contenido sexual, o datos personales sensibles (teléfono, dirección, documento). ' +
        'Errores de idioma NUNCA son motivo de rechazo. ' +
        '"categoria" debe ser una de: viajes (viajes y lugares), experiencias (trabajo, estudio y vida diaria), ' +
        'recomendaciones (series, música, libros, podcasts), aprendizaje (métodos y rutinas de estudio), ' +
        'paises (costumbres y expresiones de un país), preguntas (CUALQUIER duda dirigida a la comunidad, ' +
        'aunque el tema sea otro), conquistas (logros personales del alumno). ' +
        'Si el texto pide ayuda o termina en pregunta, la categoría es "preguntas". ' +
        '"pais" es el país hispano del que trata el texto, o "" si no aplica.',
      messages: [{ role: 'user', content: `Título: ${titulo}\n\nTexto: ${texto}\n\nCategoría elegida por el alumno: ${categoria}` }]
    });
    const m = r.content[0].text.match(/\{[\s\S]*\}/);
    if (!m) return { ok: true, categoria };
    const j = JSON.parse(m[0]);
    return {
      ok: j.permitido !== false,
      motivo: j.motivo || '',
      categoria: CATEGORIAS.includes(j.categoria) ? j.categoria : categoria,
      pais: (j.pais || '').slice(0, 40)
    };
  } catch (err) {
    // Si Claude no responde, el alumno no puede quedar bloqueado.
    console.warn('[COMUNIDAD] Moderación indisponible:', err.message);
    return { ok: true, categoria };
  }
}

// ── Matías responde preguntas huérfanas (firmando como Matías) ───────────
async function matiasResponde() {
  if (!anthropic || !pool) return { paso: 'sin anthropic o sin pool' };
  try {
    const hoy = await pool.query(
      `SELECT COUNT(*)::int AS n FROM community_comments WHERE matias AND created_at > NOW() - interval '1 day'`);
    if (hoy.rows[0].n >= MAX_MATIAS_DIA) return { paso: 'tope diario' };

    // Toma UNA pregunta sin respuesta con más de 3 horas, y la marca ya
    // (así dos peticiones simultáneas no generan doble respuesta).
    const { rows } = await pool.query(
      `UPDATE community_posts SET matias_respondido = TRUE
       WHERE id = (
         SELECT p.id FROM community_posts p
         WHERE NOT p.matias_respondido AND NOT p.seed
           AND (p.categoria = 'preguntas' OR p.titulo LIKE '%?%' OR p.texto LIKE '%?%')
           AND p.created_at < NOW() - interval '1 minute'
           AND NOT EXISTS (SELECT 1 FROM community_comments c WHERE c.post_id = p.id)
         ORDER BY p.created_at ASC LIMIT 1)
       RETURNING id, titulo, texto`);
    if (!rows.length) return { paso: 'sin huerfanas' };
    const post = rows[0];

    const r = await anthropic.messages.create({
      model: MODELO_MATIAS,
      max_tokens: 400,
      system:
        'Eres Matías, el asistente del Programa Imersão Nativa. Un alumno brasileño publicó una ' +
        'pregunta en la comunidad y nadie la respondió todavía. Respóndele en español claro y ' +
        'cercano, en menos de 120 palabras, con ejemplos concretos. No te presentes ni firmes: ' +
        'la interfaz ya muestra que eres Matías. Termina invitando a otros alumnos a sumar su experiencia.',
      messages: [{ role: 'user', content: `${post.titulo}\n\n${post.texto}` }]
    });
    const texto = r.content.map(b => b.text || '').join('').trim().slice(0, MAX_COMENTARIO);
    if (!texto) return { paso: 'respuesta vacia', post: post.id };
    await pool.query(
      `INSERT INTO community_comments (post_id, email, nombre, texto, matias)
       VALUES ($1, 'matias@imersao.interna', 'Matías · Asistente del programa', $2, TRUE)`,
      [post.id, texto]);
    console.log(`[COMUNIDAD] Matías respondió el post ${post.id}`);
    return { paso: 'respondido', post: post.id };
  } catch (err) {
    console.warn('[COMUNIDAD] Matías no pudo responder:', err.message);
    return { paso: 'ERROR', error: err.message };
  }
}

// ── Depuración temporal (se quita tras verificar en producción) ──────────
router.get('/matias-debug', authMiddleware, async (req, res) => {
  if (req.query.rearmar === '1') {
    await pool.query('UPDATE community_posts SET matias_respondido = FALSE WHERE NOT seed');
  }
  const r = await matiasResponde();
  res.json({ success: true, resultado: r });
});

// ── Feed ──────────────────────────────────────────────────────────────────
router.get('/feed', authMiddleware, async (req, res) => {
  if (!pool) return res.json({ success: true, posts: [], sinBase: true });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const categoria = CATEGORIAS.includes(req.query.categoria) ? req.query.categoria : null;
    const tag = (req.query.tag || '').slice(0, 40);
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);

    const cond = ['TRUE'];
    const args = [email];
    if (categoria) { args.push(categoria); cond.push(`p.categoria = $${args.length}`); }
    if (tag) { args.push(tag); cond.push(`p.tag = $${args.length}`); }
    args.push(limit);

    const { rows } = await pool.query(
      `SELECT ${CAMPOS_POST} FROM community_posts p
       WHERE ${cond.join(' AND ')}
       ORDER BY p.created_at DESC LIMIT $${args.length}`, args);

    res.json({ success: true, posts: rows });
    setImmediate(matiasResponde);   // aprovecha el tráfico para atender huérfanas
  } catch (err) {
    console.error('[COMUNIDAD] feed:', err.message);
    res.status(500).json({ error: 'Error al leer el feed.' });
  }
});

// ── Detalle de un post con comentarios ───────────────────────────────────
router.get('/post', authMiddleware, async (req, res) => {
  if (!pool) return res.status(404).json({ error: 'Sin base de datos.' });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const id = parseInt(req.query.id, 10);
    if (!id) return res.status(400).json({ error: 'Falta id.' });
    const { rows } = await pool.query(
      `SELECT ${CAMPOS_POST} FROM community_posts p WHERE p.id = $2`, [email, id]);
    if (!rows.length) return res.status(404).json({ error: 'Publicación no encontrada.' });
    const com = await pool.query(
      `SELECT id, nombre, texto, matias, created_at FROM community_comments
       WHERE post_id = $1 ORDER BY created_at ASC LIMIT 100`, [id]);
    res.json({ success: true, post: rows[0], comentarios: com.rows });
  } catch (err) {
    console.error('[COMUNIDAD] post:', err.message);
    res.status(500).json({ error: 'Error al leer la publicación.' });
  }
});

// ── Publicar ──────────────────────────────────────────────────────────────
router.post('/publicar', authMiddleware, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sin base de datos.' });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const titulo = (req.body?.titulo || '').toString().trim().slice(0, MAX_TITULO);
    const texto = (req.body?.texto || '').toString().trim().slice(0, MAX_TEXTO);
    let categoria = (req.body?.categoria || '').toString();
    const tag = (req.body?.tag || '').toString().trim().slice(0, 40);
    let pais = (req.body?.pais || '').toString().trim().slice(0, 40);
    const formato = ['texto', 'audio', 'video'].includes(req.body?.formato) ? req.body.formato : 'texto';

    if (texto.length < 3) return res.status(400).json({ error: 'Escribe tu mensaje antes de publicar.' });
    if (!CATEGORIAS.includes(categoria)) categoria = 'experiencias';

    const dia = await pool.query(
      `SELECT COUNT(*)::int AS n FROM community_posts WHERE email = $1 AND created_at > NOW() - interval '1 day'`, [email]);
    if (dia.rows[0].n >= MAX_POSTS_DIA) {
      return res.status(429).json({ error: 'Llegaste al límite de publicaciones de hoy. ¡Vuelve mañana!' });
    }

    const mod = await moderarYClasificar(titulo, texto, categoria);
    if (!mod.ok) {
      return res.status(422).json({
        error: 'Tu publicación no cumple las normas de la comunidad.',
        motivo: mod.motivo || 'Revisa el contenido e intenta de nuevo.'
      });
    }
    categoria = mod.categoria || categoria;
    if (!pais && mod.pais) pais = mod.pais;

    const nombre = nombreDe(req);
    const ins = await pool.query(
      `INSERT INTO community_posts (email, nombre, pais, categoria, tag, titulo, texto, formato)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
      [email, nombre, pais, categoria, tag, titulo, texto, formato]);

    res.json({ success: true, id: ins.rows[0].id, categoria, pais, created_at: ins.rows[0].created_at });
  } catch (err) {
    console.error('[COMUNIDAD] publicar:', err.message);
    res.status(500).json({ error: 'Error al publicar.' });
  }
});

// ── Comentar ──────────────────────────────────────────────────────────────
router.post('/comentar', authMiddleware, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sin base de datos.' });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const postId = parseInt(req.body?.post_id, 10);
    const texto = (req.body?.texto || '').toString().trim().slice(0, MAX_COMENTARIO);
    if (!postId || texto.length < 1) return res.status(400).json({ error: 'Faltan datos.' });

    const existe = await pool.query('SELECT 1 FROM community_posts WHERE id = $1', [postId]);
    if (!existe.rows.length) return res.status(404).json({ error: 'Publicación no encontrada.' });

    const nombre = nombreDe(req);
    const ins = await pool.query(
      `INSERT INTO community_comments (post_id, email, nombre, texto)
       VALUES ($1,$2,$3,$4) RETURNING id, created_at`, [postId, email, nombre, texto]);
    res.json({ success: true, id: ins.rows[0].id, nombre, created_at: ins.rows[0].created_at });
  } catch (err) {
    console.error('[COMUNIDAD] comentar:', err.message);
    res.status(500).json({ error: 'Error al comentar.' });
  }
});

// ── Reaccionar (like / save, alterna) ────────────────────────────────────
router.post('/reaccionar', authMiddleware, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sin base de datos.' });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const postId = parseInt(req.body?.post_id, 10);
    const tipo = req.body?.tipo === 'save' ? 'save' : 'like';
    if (!postId) return res.status(400).json({ error: 'Falta post_id.' });

    const del = await pool.query(
      'DELETE FROM community_reactions WHERE post_id = $1 AND email = $2 AND tipo = $3', [postId, email, tipo]);
    let activo = false;
    if (del.rowCount === 0) {
      await pool.query(
        'INSERT INTO community_reactions (post_id, email, tipo) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
        [postId, email, tipo]);
      activo = true;
    }
    const { rows } = await pool.query(
      `SELECT likes_base + (SELECT COUNT(*)::int FROM community_reactions WHERE post_id = $1 AND tipo = 'like') AS likes
       FROM community_posts WHERE id = $1`, [postId]);
    res.json({ success: true, activo, likes: rows.length ? rows[0].likes : 0 });
  } catch (err) {
    console.error('[COMUNIDAD] reaccionar:', err.message);
    res.status(500).json({ error: 'Error al reaccionar.' });
  }
});

// ── Borrar una publicación propia ────────────────────────────────────────
// (POST y no DELETE por el CORS del servidor; los comentarios y reacciones
//  caen solos por el ON DELETE CASCADE.)
router.post('/borrar', authMiddleware, async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Sin base de datos.' });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const postId = parseInt(req.body?.post_id, 10);
    if (!postId) return res.status(400).json({ error: 'Falta post_id.' });
    const del = await pool.query(
      'DELETE FROM community_posts WHERE id = $1 AND email = $2 AND NOT seed', [postId, email]);
    if (!del.rowCount) return res.status(404).json({ error: 'Sólo puedes borrar tus propias publicaciones.' });
    res.json({ success: true });
  } catch (err) {
    console.error('[COMUNIDAD] borrar:', err.message);
    res.status(500).json({ error: 'Error al borrar.' });
  }
});

// ── Mi actividad ──────────────────────────────────────────────────────────
router.get('/actividad', authMiddleware, async (req, res) => {
  if (!pool) return res.json({ success: true, posts: [], comentarios: [], guardados: [], sinBase: true });
  try {
    await garantirTablas();
    const email = (req.user.email || '').toLowerCase();
    const posts = await pool.query(
      `SELECT ${CAMPOS_POST} FROM community_posts p WHERE p.email = $1 ORDER BY p.created_at DESC LIMIT 50`, [email]);
    const comentarios = await pool.query(
      `SELECT c.id, c.texto, c.created_at, c.post_id, p.titulo AS post_titulo, p.nombre AS post_autor, p.categoria
       FROM community_comments c JOIN community_posts p ON p.id = c.post_id
       WHERE c.email = $1 ORDER BY c.created_at DESC LIMIT 50`, [email]);
    const guardados = await pool.query(
      `SELECT ${CAMPOS_POST}, r.created_at AS guardado_en
       FROM community_reactions r JOIN community_posts p ON p.id = r.post_id
       WHERE r.email = $1 AND r.tipo = 'save' ORDER BY r.created_at DESC LIMIT 50`, [email]);
    res.json({ success: true, posts: posts.rows, comentarios: comentarios.rows, guardados: guardados.rows });
  } catch (err) {
    console.error('[COMUNIDAD] actividad:', err.message);
    res.status(500).json({ error: 'Error al leer tu actividad.' });
  }
});

module.exports = router;
