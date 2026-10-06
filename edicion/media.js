/*
 * Lee los archivos de vídeo con ffprobe.
 *
 * Así se mira el material antes de montar: se sabe la duración real, los fps y si
 * tiene audio, y se puede avisar de un "out" que se pasa del final del clip antes de
 * abrir el programa.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function hasFfprobe() {
  const res = spawnSync('ffprobe', ['-version'], { encoding: 'utf8', timeout: 15000 });
  return !res.error;
}

function parseRate(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d+)\/(\d+)$/);
  if (m) {
    const den = parseInt(m[2], 10);
    if (den === 0) return null;
    return parseInt(m[1], 10) / den;
  }
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/*
 * Devuelve { path, name, frames, fps, width, height, hasVideo, hasAudio, ... } o
 * { path, missing: true } / { probeFailed: ... } si no se pudo leer. Nunca lanza:
 * quien llama decide si un clip ilegible es un error o solo un aviso.
 */
function probe(file, timelineFps) {
  const info = { path: file, name: path.basename(file) };

  if (!fs.existsSync(file)) {
    info.missing = true;
    return info;
  }

  const res = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,duration,start_time',
    '-show_entries', 'format=duration,start_time',
    '-of', 'json', file,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30000 });

  if (res.error || res.status !== 0) {
    info.probeFailed = (res.stderr || (res.error && res.error.message) || 'ffprobe falló').trim();
    return info;
  }

  let data;
  try {
    data = JSON.parse(res.stdout);
  } catch (e) {
    info.probeFailed = `respuesta de ffprobe ilegible: ${e.message}`;
    return info;
  }

  const streams = data.streams || [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');

  info.hasVideo = Boolean(video);
  info.hasAudio = Boolean(audio);
  if (video) {
    info.width = Number(video.width) || null;
    info.height = Number(video.height) || null;
    info.fps = parseRate(video.r_frame_rate);
    info.videoIndex = Number(video.index);
    info.codec = video.codec_name;
  }
  if (audio) {
    info.audioIndex = Number(audio.index);
    info.audioCodec = audio.codec_name;
  }

  /*
   * Desfase entre las dos pistas DENTRO del archivo.
   *
   * Un .mp4 puede tener la pista de audio empezando en un instante distinto que la de
   * vídeo (pasa a menudo con capturas de webcam y de programas de grabación). Importa
   * porque el análisis del audio se hace desde su primera muestra, mientras que el
   * montaje coloca el clip por su vídeo: si las dos no arrancan juntas, esa diferencia
   * acaba en el labial.
   */
  const inicio = (s) => {
    const v = parseFloat(s && s.start_time);
    return Number.isFinite(v) ? v : null;
  };
  info.videoStart = video ? inicio(video) : null;
  info.audioStart = audio ? inicio(audio) : null;
  info.skew = (info.videoStart !== null && info.audioStart !== null)
    ? info.audioStart - info.videoStart
    : null;

  const seconds = parseFloat(
    (video && video.duration) || (data.format && data.format.duration) || (audio && audio.duration) || '0',
  );
  info.seconds = Number.isFinite(seconds) && seconds > 0 ? seconds : null;

  // La duración en frames se cuenta en el ritmo del proyecto, que es el espacio en
  // el que MLT interpreta el in/out de cada entrada de la timeline.
  const fps = Number(timelineFps) || info.fps || 25;
  if (info.seconds) {
    info.frames = Math.max(1, Math.floor(info.seconds * fps));
  } else if (video && Number(video.nb_frames) > 0 && info.fps) {
    info.frames = Math.max(1, Math.floor((Number(video.nb_frames) / info.fps) * fps));
  } else {
    info.frames = null;
  }

  return info;
}

/* Lee todos los media de una receta. Devuelve { byId, problems }. */
function probeRecipe(recipe, timelineFps) {
  const byId = {};
  const problems = [];

  for (const entry of recipe.media || []) {
    const info = probe(entry.path, timelineFps);
    if (info.missing) {
      problems.push(`media "${entry.id}": no existe el archivo ${entry.path}`);
    } else if (info.probeFailed) {
      problems.push(`media "${entry.id}": no se pudo leer (${info.probeFailed})`);
    } else if (!info.hasVideo && !info.hasAudio) {
      problems.push(`media "${entry.id}": el archivo no tiene vídeo ni audio`);
    }
    byId[entry.id] = info;
  }

  return { byId, problems };
}

module.exports = { hasFfprobe, probe, probeRecipe, parseRate };
