/*
 * Cámara congelada o en negro.
 *
 * Si la webcam de alguien se cuelga (la imagen se queda quieta, o el archivo tiene un hueco sin imagen),
 * se queda en negro (tapada, apagada) o deja de tener imagen antes de que acabe el archivo, el montaje lo
 * enseñaría mientras esa persona habla. Aquí se busca en cada archivo de cámara con ffmpeg (freezedetect
 * y blackdetect, a 5 imágenes por segundo y en pequeño: basta y va rápido, unos 3 min por hora de vídeo)
 * y `cortes.cubrirCamaras` pone en esos tramos la cámara del otro, que va en sincronía. Lo encontrado se
 * guarda (montaje/camaras.json) y no se vuelve a buscar mientras el archivo no cambie.
 *
 * Una imagen repetida tal cual (cámara colgada, hueco en el archivo) da diferencia 0 entre imágenes;
 * alguien quieto escuchando no, por el ruido de la cámara y lo poco que se mueve: por eso la tolerancia
 * es muy baja. Cada imagen clave del archivo (cada pocos segundos) se codifica de nuevo y parte la
 * congelación en dos: los trozos separados por menos de 0,6 s se juntan.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const POR_DEFECTO = { activo: true, congelada: 4, negro: 2, tolerancia: 0.0003 };
const HUECO = 0.6; // lo que se junta entre dos trozos de congelación (una imagen clave en medio)

/* Junta tramos que se tocan o están a menos de `hueco` segundos. */
function juntar(tramos, hueco) {
  const out = [];
  for (const t of [...tramos].sort((a, b) => a.desde - b.desde)) {
    const u = out[out.length - 1];
    if (u && t.desde - u.hasta <= hueco) u.hasta = Math.max(u.hasta, t.hasta);
    else out.push({ desde: t.desde, hasta: t.hasta });
  }
  return out;
}

/* Lo que queda de `tramos` al quitarles los de `quitar`. */
function restar(tramos, quitar) {
  let out = tramos.map((t) => ({ ...t }));
  for (const q of quitar) {
    out = out.flatMap((t) => {
      if (q.hasta <= t.desde || q.desde >= t.hasta) return [t];
      return [{ ...t, hasta: q.desde }, { ...t, desde: q.hasta }].filter((x) => x.hasta > x.desde);
    });
  }
  return out;
}

/*
 * Lee lo que escriben freezedetect y blackdetect (y la última línea de ffmpeg, para saber hasta dónde hay
 * imagen). `duracion`: lo que dura el archivo entero (con su audio). Devuelve [{ tipo, desde, hasta }] en
 * segundos del archivo, de tipo «congelada», «en negro» o «sin imagen».
 */
function leerDetecciones(stderr, opciones) {
  const o = { ...POR_DEFECTO, ...opciones };
  const quietos = [];
  const negros = [];
  let inicio = null;
  let finVideo = null;
  for (const l of String(stderr || '').split(/\r?\n/)) {
    let m = /freeze_start: ([\d.]+)/.exec(l);
    if (m) { inicio = Number(m[1]); continue; }
    m = /freeze_end: ([\d.]+)/.exec(l);
    if (m && inicio !== null) { quietos.push({ desde: inicio, hasta: Number(m[1]) }); inicio = null; continue; }
    m = /black_start: ?([\d.]+) black_end: ?([\d.]+)/.exec(l);
    if (m) { negros.push({ desde: Number(m[1]), hasta: Number(m[2]) }); continue; }
    m = /time=(\d+):(\d+):([\d.]+)/.exec(l);
    if (m) finVideo = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + 0.2; // la última imagen, a 5 por segundo
  }
  // Una congelación que llega al final del archivo no trae freeze_end.
  if (inicio !== null && finVideo !== null && finVideo > inicio) quietos.push({ desde: inicio, hasta: finVideo });

  const enNegro = juntar(negros, HUECO).filter((t) => t.hasta - t.desde >= o.negro);
  // Lo negro también está quieto: cuenta como negro, no dos veces.
  const congelada = restar(juntar(quietos, HUECO), enNegro).filter((t) => t.hasta - t.desde >= o.congelada);
  const out = [
    ...congelada.map((t) => ({ tipo: 'congelada', ...t })),
    ...enNegro.map((t) => ({ tipo: 'en negro', ...t })),
  ];
  // El vídeo acaba antes que el archivo (la cámara dejó de dar imagen y el sonido siguió).
  if (finVideo !== null && o.duracion && o.duracion - finVideo >= 2) out.push({ tipo: 'sin imagen', desde: finVideo, hasta: o.duracion });
  return out.map((t) => ({ ...t, desde: Math.round(t.desde * 100) / 100, hasta: Math.round(t.hasta * 100) / 100 })).sort((a, b) => a.desde - b.desde);
}

/* Lo que dura el archivo entero (el contenedor, con su audio), o null. */
function duracionArchivo(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8', timeout: 30000 });
  const d = parseFloat(r.stdout);
  return Number.isFinite(d) && d > 0 ? d : null;
}

/* Busca los tramos congelados, en negro o sin imagen de un archivo de cámara. Devuelve { tramos } o { error }. */
function analizarCamara(file, opciones) {
  const o = { ...POR_DEFECTO, ...opciones };
  const filtro = `fps=5,scale=160:-2,freezedetect=n=${o.tolerancia}:d=1,blackdetect=d=${Math.min(1, o.negro)}:pix_th=0.10`;
  const res = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-skip_loop_filter', 'all', '-i', file,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-vf', filtro, '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) return { error: (res.stderr || (res.error && res.error.message) || 'ffmpeg falló').trim().split('\n').slice(-3).join(' · ') };
  return { tramos: leerDetecciones(res.stderr, { ...o, duracion: duracionArchivo(file) }) };
}

/*
 * Los problemas de todas las cámaras de una receta, en segundos de cada archivo: [{ clip, tipo, desde, hasta }].
 * Lo ya analizado se guarda en `cache` (un JSON) con el tamaño y la fecha del archivo y los ajustes.
 * Devuelve { problemas, errores }.
 */
function problemasDeCamaras(receta, { cache, opciones, log } = {}) {
  const o = { ...POR_DEFECTO, ...opciones };
  let guardado = {};
  try { guardado = JSON.parse(fs.readFileSync(cache, 'utf8')); } catch { guardado = {}; }
  const problemas = [];
  const errores = [];
  let cambiado = false;
  for (const m of receta.media || []) {
    if (!String(m.id).startsWith('cam_') || !fs.existsSync(m.path)) continue;
    const st = fs.statSync(m.path);
    const firma = `${st.size}-${Math.round(st.mtimeMs)}-${o.congelada}-${o.negro}-${o.tolerancia}`;
    const clave = path.resolve(m.path);
    let tramos = guardado[clave] && guardado[clave].firma === firma ? guardado[clave].tramos : null;
    if (!tramos) {
      if (log) log(`buscando imagen congelada o en negro en ${path.basename(m.path)} (≈3 min por hora de vídeo)...`);
      const r = analizarCamara(m.path, o);
      if (r.error) { errores.push(`${path.basename(m.path)}: ${r.error}`); continue; }
      tramos = r.tramos;
      guardado[clave] = { firma, tramos };
      cambiado = true;
    }
    for (const t of tramos) problemas.push({ clip: m.id, ...t });
  }
  if (cambiado && cache) fs.writeFileSync(cache, `${JSON.stringify(guardado, null, 2)}\n`, 'utf8');
  return { problemas, errores };
}

const persona = (clip) => String(clip || '').replace(/^p\d+_/, '').replace(/^cam_/, '').replace(/-\d+$/, '');

/* «cámara de dj congelada (6 s): se ve a jc», para la consola, las guías y la revisión. */
function textoDeCamara(c, fps) {
  const s = (frames) => Math.round(frames / fps);
  const que = !c.visto ? 'no salía en el montaje'
    : !c.con ? 'no hay otra cámara con imagen'
      : `se ve a ${persona(c.con)}${c.quedan ? `; ${s(c.quedan)} s sin otra cámara` : ''}`;
  return `cámara de ${persona(c.clip)} ${c.tipo} (${s(c.hasta - c.desde)} s): ${que}`;
}

/*
 * Guías «⚠» de los tramos cubiertos (los de cortes.cubrirCamaras que se veían en el montaje), para verlos
 * en Kdenlive y en el vídeo de revisión. No se pone guía si el tramo entero cae en lo que se corta
 * (`cortesFrames`: [{ desde, hasta }] en frames de la receta sin cortar).
 */
function guiasDeCamaras(cubiertos, fps, cortesFrames) {
  return cubiertos
    .filter((c) => c.visto && !(cortesFrames || []).some((x) => x.desde <= c.desde && c.hasta <= x.hasta))
    .map((c) => {
      // Si empieza dentro de un corte, la guía va donde vuelve a verse.
      const corte = (cortesFrames || []).find((x) => x.desde <= c.desde && c.desde < x.hasta);
      return { at: corte ? corte.hasta : c.desde, name: `⚠ ${textoDeCamara(c, fps)}`, color: 'Orange' };
    });
}

module.exports = { POR_DEFECTO, leerDetecciones, analizarCamara, problemasDeCamaras, guiasDeCamaras, textoDeCamara, juntar, restar };
