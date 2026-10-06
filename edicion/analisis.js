/*
 * Medidas sobre el material, con ffmpeg: volumen percibido y color medio.
 *
 * La idea es no aplicar correcciones a ojo. Se mide cada archivo y de ahí salen los
 * números concretos: cuántos dB le faltan a cada micro para quedar al mismo nivel, y
 * cuánto hay que mover cada canal para que las dos cámaras se parezcan. Así la
 * corrección se adapta al material en lugar de ser un preajuste genérico.
 */
'use strict';

const { spawnSync } = require('node:child_process');

/* Nivel de referencia del montaje, en LUFS. -16 es lo habitual para web y pódcast. */
const OBJETIVO_LUFS = -16;

/* Hasta cuánto se deja subir o bajar un micro. Más que esto suele ser otro problema. */
const GANANCIA_MAXIMA_DB = 18;

/*
 * Volumen percibido integrado (EBU R128), en LUFS. Devuelve { lufs } o { error }.
 * No es lo mismo que el pico ni que el RMS: es lo que se oye más alto o más bajo.
 */
function volumen(file) {
  const res = spawnSync('ffmpeg', [
    '-nostats', '-hide_banner',
    '-i', file,
    '-af', 'ebur128=framelog=quiet',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });

  if (res.error) return { error: `ffmpeg no se pudo ejecutar: ${res.error.message}` };
  const salida = `${res.stdout || ''}${res.stderr || ''}`;
  const m = salida.match(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
  if (!m) return { error: 'ffmpeg no devolvió el volumen integrado' };

  const lufs = parseFloat(m[1]);
  if (!Number.isFinite(lufs)) return { error: 'volumen ilegible' };
  return { lufs };
}

/*
 * Ganancia en dB para llevar una pista al nivel objetivo, acotada.
 * Devuelve { db, recortada } — recortada avisa de que hacía falta más de lo permitido.
 */
function gananciaHacia(lufs, objetivo) {
  const meta = objetivo !== undefined ? objetivo : OBJETIVO_LUFS;
  const bruta = meta - lufs;
  const db = Math.max(-GANANCIA_MAXIMA_DB, Math.min(GANANCIA_MAXIMA_DB, bruta));
  return { db: Math.round(db * 10) / 10, recortada: Math.abs(bruta - db) > 0.05, bruta };
}

/*
 * Color medio del vídeo, como { r, g, b } de 0 a 255.
 *
 * Se consigue reduciendo cada fotograma muestreado a un solo píxel: ese píxel ES la
 * media de la imagen, y lo calcula ffmpeg, que es mucho más rápido que leer los
 * fotogramas enteros.
 */
function colorMedio(file, options) {
  const opts = options || {};
  const porSegundo = opts.porSegundo || 2;
  const segundos = opts.segundos;

  const limite = Number.isFinite(segundos) ? ['-t', String(segundos)] : [];
  // Desde dónde mirar: el arranque de una grabación es lo menos representativo (la exposición se ajusta).
  const desde = Number(opts.desde) > 0 ? ['-ss', String(opts.desde)] : [];
  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    ...desde,
    ...limite,
    '-i', file,
    '-an',
    '-vf', `fps=${porSegundo},scale=1:1:flags=area,format=rgb24`,
    '-f', 'rawvideo', '-',
  ], { encoding: 'buffer', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });

  if (res.error) return { error: `ffmpeg no se pudo ejecutar: ${res.error.message}` };
  if (res.status !== 0) {
    return { error: (res.stderr ? res.stderr.toString().trim().split('\n')[0] : 'ffmpeg falló') };
  }

  const datos = res.stdout;
  const muestras = Math.floor(datos.length / 3);
  if (muestras === 0) return { error: 'no se pudo leer ningún fotograma' };

  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < muestras; i += 1) {
    r += datos[i * 3];
    g += datos[i * 3 + 1];
    b += datos[i * 3 + 2];
  }
  return { r: r / muestras, g: g / muestras, b: b / muestras, muestras };
}

/*
 * Ganancias por canal para que un color medio se parezca a otro.
 *
 * Es el modelo más simple que funciona para emparejar dos cámaras: multiplicar cada
 * canal por una constante. No arregla una diferencia de contraste ni una dominante
 * que solo esté en las sombras, pero sí el caso habitual, que es que una cámara tire
 * más fría o más apagada que la otra.
 */
function gananciasHacia(color, objetivo, limite) {
  const tope = limite || 1.6;
  const ganancia = (origen, destino) => {
    if (!(origen > 1)) return 1;
    const g = destino / origen;
    return Math.max(1 / tope, Math.min(tope, g));
  };
  return {
    r: Math.round(ganancia(color.r, objetivo.r) * 1000) / 1000,
    g: Math.round(ganancia(color.g, objetivo.g) * 1000) / 1000,
    b: Math.round(ganancia(color.b, objetivo.b) * 1000) / 1000,
  };
}

/* ¿Merece la pena aplicar estas ganancias, o son ruido? */
function cambioApreciable(ganancias, umbral) {
  const minimo = umbral || 0.02;
  return ['r', 'g', 'b'].some((c) => Math.abs(ganancias[c] - 1) > minimo);
}

module.exports = {
  OBJETIVO_LUFS,
  GANANCIA_MAXIMA_DB,
  volumen,
  gananciaHacia,
  colorMedio,
  gananciasHacia,
  cambioApreciable,
};
