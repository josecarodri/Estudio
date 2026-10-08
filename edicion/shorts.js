/*
 * Shorts verticales (9:16) con los subtítulos grabados en la imagen, sacados del montaje final: los
 * buenos momentos marcados con ★ al grabar o los que se pongan en el episodio.json del episodio. Salen
 * con lo ya cortado y disimulado, y en sincronía. Cada cámara se recorta por el centro para llenar el
 * alto, y el plano doble pasa a una persona arriba y otra abajo.
 *
 * Con zoom z, qtblend encaja la imagen (sin deformarla) en un rectángulo de z veces el cuadro: una de
 * 16:9 en un cuadro de 9:16 llena el alto con z = alto·(16/9)/ancho (3,16), y la mitad con la mitad.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CUT = require('./cortes.js');
const P = require('./project.js');
const YT = require('./youtube.js');
const { fuenteGruesa } = require('./rotulos.js');

const existe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/*
 * La receta vertical de [desde, hasta) segundos del vídeo final. `aspectos`: { idClip: ancho/alto } de
 * cada cámara (16/9 si no se sabe). Los rótulos (pensados para el horizontal) no se ponen.
 */
function recetaVertical(final, desde, hasta, { ancho = 1080, alto = 1920, aspectos = {} } = {}) {
  const t = CUT.extraerTramo({ ...final, origenReferencia: 0 }, desde, hasta);
  const llena = (clip, parte) => Math.round(((alto * parte * (aspectos[clip] || 16 / 9)) / ancho) * 1000) / 1000;
  const edit = [];
  for (const e of t.piezas) {
    if (String(e.clip).includes('rotulo_')) continue;
    if (e.audioTrack || e.video === false) { edit.push(e); continue; } // el sonido, tal cual
    const p = { ...e };
    delete p.pan;
    delete p.tilt;
    if (e.track === 2) Object.assign(p, { zoom: llena(e.clip, 0.5), tilt: -alto / 4 });         // plano doble: abajo
    else if (e.zoom === 0.5) Object.assign(p, { zoom: llena(e.clip, 0.5), tilt: alto / 4 });     // plano doble: arriba
    else p.zoom = llena(e.clip, 1);
    edit.push(p);
  }
  const usados = new Set(edit.map((e) => e.clip));
  return {
    ...final,
    project: { ...final.project, width: ancho, height: alto },
    media: final.media.filter((m) => usados.has(m.id)),
    tracks: { ...(final.tracks || {}), video: Math.max(2, ...edit.map((e) => (e.audioTrack ? 1 : e.track || 1))) },
    edit: edit.sort((a, b) => a.at - b.at),
    guides: [],
  };
}

/*
 * Ajusta [a, b] para empezar y acabar en una frase (o en una pausa), sin pasar de `maximo` segundos.
 * `palabras`: las del vídeo final ({ w, ini, fin }).
 */
function ajustarAFrases(palabras, a, b, { maximo = 60, holgura = 6 } = {}) {
  const corte = (i) => i === 0 || /[.?!…]$/.test(palabras[i - 1].w) || palabras[i].ini - palabras[i - 1].fin >= 0.6;
  // Inicio: el principio de frase más cercano a `a`, antes (hasta `holgura`) o poco después (2 s): mejor
  // un poco más de contexto que empezar con la idea a medias.
  let ini = a;
  let mejor = Infinity;
  palabras.forEach((p, i) => {
    if (corte(i) && p.ini >= a - holgura && p.ini <= a + 2 && Math.abs(p.ini - a) < mejor) { mejor = Math.abs(p.ini - a); ini = p.ini; }
  });
  // Final: el fin de frase más cercano a `b`, sin quedarse en menos de 5 s ni pasar del máximo.
  const minimo = Math.min(5, maximo / 2);
  let fin = Math.min(Math.max(b, ini + minimo), ini + maximo);
  mejor = Infinity;
  palabras.forEach((p, i) => {
    const cierra = i === palabras.length - 1 || corte(i + 1);
    if (cierra && p.fin > ini + minimo && p.fin <= ini + maximo && Math.abs(p.fin - b) <= holgura && Math.abs(p.fin - b) < mejor) {
      mejor = Math.abs(p.fin - b);
      fin = p.fin;
    }
  });
  // Un respiro antes y después, sin pisar la palabra anterior ni la siguiente.
  const antes = palabras.filter((p) => p.fin <= ini).pop();
  const despues = palabras.find((p) => p.ini >= fin);
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    desde: r2(Math.max(0, antes ? Math.max(antes.fin, ini - 0.3) : ini - 0.3)),
    hasta: r2(despues ? Math.min(despues.ini, fin + 0.4) : fin + 0.4),
  };
}

/*
 * Qué Shorts hacer. `entradas` (las del episodio.json): { desde, hasta } (minutos del vídeo final) o
 * { frase, segundos } (empieza en esa frase). Si no hay ninguna, uno por cada ★ (`momentos`: segundos
 * del vídeo final), con lo de antes de la marca (lo bueno ya había pasado al pulsar). Devuelve { rangos, avisos }.
 */
function rangosDeShorts({ entradas, momentos, palabras, total, antes = 40, despues = 8, maximo = 60 }) {
  const reloj = (x) => String(x).split(':').map(Number).reduce((s, v) => s * 60 + v, 0);
  const avisos = [];
  const rangos = [];
  if (Array.isArray(entradas) && entradas.length) {
    entradas.forEach((e, i) => {
      if (e.desde !== undefined && e.hasta !== undefined) {
        const [a, b] = [reloj(e.desde), reloj(e.hasta)];
        if (!(b > a) || b - a > maximo) { avisos.push(`short ${i + 1}: ${e.desde}–${e.hasta} no vale (más de ${maximo} s o al revés)`); return; }
        rangos.push({ desde: a, hasta: Math.min(b, total), motivo: e.titulo || `${e.desde}–${e.hasta}` });
      } else if (e.frase) {
        const m = buscar(palabras, String(e.frase));
        if (m === null) { avisos.push(`short ${i + 1}: no encuentro «${e.frase}» en el vídeo final`); return; }
        rangos.push({ ...ajustarAFrases(palabras, m, m + Number(e.segundos || 45), { maximo }), motivo: e.titulo || `«${e.frase}»` });
      } else {
        avisos.push(`short ${i + 1}: hace falta «desde» y «hasta», o «frase»`);
      }
    });
    return { rangos, avisos };
  }
  for (const m of momentos || []) {
    const r = ajustarAFrases(palabras, Math.max(0, m.t - antes), Math.min(total, m.t + despues), { maximo });
    if (rangos.some((x) => x.desde < r.hasta && r.desde < x.hasta)) continue; // dos ★ seguidas: un solo short
    rangos.push({ ...r, motivo: `★ de ${m.nombre || 'alguien'} en ${YT.tiempoSrt(m.t).slice(3, 8)}` });
  }
  return { rangos, avisos };
}

/* Dónde empieza una frase en las palabras del vídeo final (sin tildes ni puntuación), o null. */
function buscar(palabras, frase) {
  const limpia = (x) => x.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
  const buscadas = frase.split(/\s+/).map(limpia).filter(Boolean);
  for (let i = 0; i + buscadas.length <= palabras.length; i += 1) {
    if (buscadas.every((w, k) => limpia(palabras[i + k].w) === w)) return palabras[i].ini;
  }
  return null;
}

/* Subtítulos del short: frases cortas (2 líneas de 22 caracteres como mucho), con tiempos desde su principio. */
function subtitulosDelShort(palabras, desde, hasta) {
  const dentro = palabras.filter((p) => p.ini >= desde && p.fin <= hasta + 0.2).map((p) => ({ ...p, ini: p.ini - desde, fin: Math.min(p.fin, hasta) - desde }));
  return YT.subtitulos(dentro, { linea: 22, maximo: 3.5, pausa: 0.6 });
}

const tiempoAss = (s) => {
  const cs = Math.max(0, Math.round(s * 100));
  return `${Math.floor(cs / 360000)}:${String(Math.floor(cs / 6000) % 60).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
};

/* Los subtítulos en ASS: letra grande y gruesa, blanca con borde negro, a dos tercios del alto (encima de los botones de YouTube). */
function aAss(cues, { ancho = 1080, alto = 1920, familia = 'Arial' } = {}) {
  const limpio = (t) => String(t).replace(/[{}\\]/g, '');
  return [
    '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${ancho}`, `PlayResY: ${alto}`, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Corto,${familia},${Math.round(alto * 0.04)},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,${Math.round(alto * 0.0028)},${Math.round(alto * 0.001)},2,${Math.round(ancho * 0.06)},${Math.round(ancho * 0.06)},${Math.round(alto * 0.3)},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...cues.map((c) => `Dialogue: 0,${tiempoAss(c.ini)},${tiempoAss(c.fin)},Corto,,0,0,0,,${c.lineas.map(limpio).join('\\N')}`),
    '',
  ].join('\n');
}

/*
 * Hace un short: la receta vertical con melt y, encima, el color y el sonido del episodio, los subtítulos y el
 * volumen para el móvil (−14 LUFS) con ffmpeg. h: { final, media (byId), desde, hasta, palabras, dir, salida,
 * melt (comando), compositing, docVersion, filtrosVideo, filtrosAudio, etiquetasColor }. Devuelve
 * { segundos, subtitulos } o { error }.
 */
function hacerShort(h) {
  fs.mkdirSync(h.dir, { recursive: true });
  fs.mkdirSync(path.dirname(h.salida), { recursive: true });
  const aspectos = {};
  for (const [id, m] of Object.entries(h.media || {})) if (m && m.width && m.height) aspectos[id] = m.width / m.height;
  const receta = recetaVertical(h.final, h.desde, h.hasta, { aspectos });
  const fps = Number(receta.project.fps);
  const huella = crypto.createHash('sha1').update(JSON.stringify({ edit: receta.edit, media: receta.media, d: [h.desde, h.hasta] })).digest('hex').slice(0, 12);
  const vertical = path.join(h.dir, `vertical-${huella}.mp4`);
  if (!existe(vertical)) {
    const built = P.buildProject(receta, { media: h.media, fps, compositing: h.compositing, docVersion: h.docVersion });
    const proyecto = path.join(h.dir, `vertical-${huella}.kdenlive`);
    fs.writeFileSync(proyecto, built.xml, 'utf8');
    const tmp = path.join(h.dir, `vertical-${huella}.tmp.mp4`);
    const [cmd, ...previos] = [].concat(h.melt);
    const res = spawnSync(cmd, [...previos, proyecto, '-consumer', `avformat:${tmp}`, 'vcodec=libx264', 'crf=16', 'preset=veryfast', 'acodec=pcm_s16le'],
      { stdio: 'ignore', timeout: 60 * 60000 });
    fs.rmSync(proyecto, { force: true });
    if (res.status !== 0 || !existe(tmp)) { fs.rmSync(tmp, { force: true }); return { error: `melt falló${res.error ? `: ${res.error.message}` : ''}` }; }
    fs.renameSync(tmp, vertical);
  }
  const cues = subtitulosDelShort(h.palabras || [], h.desde, h.hasta);
  const fuente = fuenteGruesa();
  if (fuente) fs.copyFileSync(fuente.archivo, path.join(h.dir, path.basename(fuente.archivo)));
  fs.writeFileSync(path.join(h.dir, 'short.ass'), aAss(cues, { familia: fuente ? fuente.familia : 'Arial' }), 'utf8');
  // El color y el sonido del episodio (h.filtrosVideo, h.filtrosAudio: los del acabado), y los subtítulos encima.
  const vf = [...(h.filtrosVideo || []), ...(cues.length ? ['subtitles=short.ass:fontsdir=.'] : [])];
  const af = [...(h.filtrosAudio || []), 'loudnorm=I=-14:TP=-1.5:LRA=11'].join(',');
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', vertical, ...(vf.length ? ['-vf', vf.join(',')] : []), '-af', af,
    '-c:v', 'libx264', '-crf', '19', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...(h.etiquetasColor || []),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', path.resolve(h.salida)], { cwd: h.dir, encoding: 'utf8', timeout: 60 * 60000 });
  if (res.status !== 0) return { error: (res.stderr || 'ffmpeg falló').trim().split('\n').slice(-2).join(' · ') };
  return { segundos: Math.round((h.hasta - h.desde) * 10) / 10, subtitulos: cues.length };
}

module.exports = { recetaVertical, ajustarAFrases, rangosDeShorts, subtitulosDelShort, aAss, hacerShort, buscar };
