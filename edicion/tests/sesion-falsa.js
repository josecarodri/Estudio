/*
 * Genera una sesión de conversación falsa para probar el multicámara.
 *
 * Imita el material de una entrevista a distancia: la cámara y el micro de cada
 * persona, más la captura de la llamada, cada archivo empezando en un momento
 * distinto. Y, sobre todo, imita la *forma* del audio: sílabas de duración y volumen
 * irregulares. Eso importa porque la sincronización se basa en reconocer la
 * envolvente de energía, y un tono constante no tiene nada reconocible.
 *
 * Devuelve las rutas y la verdad conocida (desfases y turnos de palabra), para poder
 * comprobar contra ella en lugar de a ojo.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SR = 48000;

/* Generador pseudoaleatorio propio, para que la sesión salga igual en cada ejecución. */
function aleatorio(semilla) {
  let estado = semilla;
  return () => {
    estado = (estado * 1103515245 + 12345) & 0x7fffffff;
    return estado / 0x7fffffff;
  };
}

function escribirWav(ruta, muestras) {
  const datos = Buffer.alloc(muestras.length * 2);
  for (let i = 0; i < muestras.length; i += 1) {
    const v = Math.max(-1, Math.min(1, muestras[i]));
    datos.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const cabecera = Buffer.alloc(44);
  cabecera.write('RIFF', 0);
  cabecera.writeUInt32LE(36 + datos.length, 4);
  cabecera.write('WAVE', 8);
  cabecera.write('fmt ', 12);
  cabecera.writeUInt32LE(16, 16);
  cabecera.writeUInt16LE(1, 20);
  cabecera.writeUInt16LE(1, 22);
  cabecera.writeUInt32LE(SR, 24);
  cabecera.writeUInt32LE(SR * 2, 28);
  cabecera.writeUInt16LE(2, 32);
  cabecera.writeUInt16LE(16, 34);
  cabecera.write('data', 36);
  cabecera.writeUInt32LE(datos.length, 40);
  fs.writeFileSync(ruta, Buffer.concat([cabecera, datos]));
}

/* Sílabas irregulares dentro de los tramos en que la persona habla. */
function silabas(turnos, rnd) {
  const lista = [];
  for (const [desde, hasta] of turnos) {
    let t = desde;
    while (t < hasta) {
      const dur = 0.09 + rnd() * 0.23;
      lista.push({ desde: t, hasta: Math.min(t + dur, hasta), amp: 0.25 + rnd() * 0.75 });
      t += dur + 0.04 + rnd() * 0.22;
    }
  }
  return lista;
}

function pista(duracion, lista, tono) {
  const n = Math.round(duracion * SR);
  const out = new Float64Array(n);
  for (const s of lista) {
    const desde = Math.round(s.desde * SR);
    const hasta = Math.min(n, Math.round(s.hasta * SR));
    const largo = hasta - desde;
    for (let i = desde; i < hasta; i += 1) {
      const t = i / SR;
      const sobre = Math.sin((Math.PI * (i - desde)) / largo); // ataque y caída suaves
      out[i] += s.amp * sobre * Math.sin(2 * Math.PI * tono * t);
    }
  }
  return out;
}

function mezclar(pistas, ganancias) {
  const n = Math.max(...pistas.map((p) => p.length));
  const out = new Float64Array(n);
  pistas.forEach((p, i) => {
    for (let j = 0; j < p.length; j += 1) out[j] += p[j] * ganancias[i];
  });
  return out;
}

function ffmpeg(args) {
  const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args],
    { encoding: 'utf8', timeout: 300000 });
  if (res.status !== 0) throw new Error(`ffmpeg falló: ${res.stderr}`);
}

/*
 * Crea la sesión en `dir`. Opciones: duracion (s), fps, tamaño y los desfases.
 * Los nombres imitan los de un caso real (dj_camara.mp4, jc_audio (1).wav...).
 */
function generar(dir, options) {
  const opts = options || {};
  const duracion = opts.duracion || 30;
  const fps = opts.fps || 25;
  const tamano = opts.tamano || '320x180';

  const desfases = Object.assign({
    'dj_camara.mp4': 4.4,
    'dj_audio.wav': 3.0,
    'jc_camara (1).mp4': 0.6,
    'jc_audio (1).wav': 1.2,
    'jc_llamada (1).mp4': 0,
  }, opts.desfases || {});

  // Quién habla y cuándo: la verdad contra la que se comprueba.
  const turnos = opts.turnos || {
    dj: [[0, 7], [14, 20], [26, duracion]],
    jc: [[7, 14], [20, 26]],
  };

  fs.mkdirSync(dir, { recursive: true });
  const rnd = aleatorio(opts.semilla || 7);
  const voces = {
    dj: pista(duracion, silabas(turnos.dj, rnd), 220),
    jc: pista(duracion, silabas(turnos.jc, rnd), 420),
  };

  // Archivos completos (sin desfase todavía).
  const completos = {};
  for (const quien of ['dj', 'jc']) {
    completos[quien] = path.join(dir, `_${quien}_full.wav`);
    escribirWav(completos[quien], mezclar([voces[quien]], [0.5]));
    // La cámara oye además al otro por los altavoces, bastante más bajo: es lo que
    // pasa de verdad, y conviene que la prueba lo tenga.
    const otro = quien === 'dj' ? 'jc' : 'dj';
    completos[`${quien}_cam`] = path.join(dir, `_${quien}_cam_full.wav`);
    escribirWav(completos[`${quien}_cam`], mezclar([voces[quien], voces[otro]], [0.5, 0.1]));
  }
  completos.llamada = path.join(dir, '_llamada_full.wav');
  escribirWav(completos.llamada, mezclar([voces.dj, voces.jc], [0.5, 0.5]));

  const rutas = {};
  const recortar = (origen, destino, desde) => {
    ffmpeg(['-ss', String(desde), '-i', origen, destino]);
  };
  const conVideo = (origen, destino, desde, patron) => {
    const resto = Math.max(1, duracion - desde);
    ffmpeg(['-ss', String(desde), '-i', origen,
      '-f', 'lavfi', '-i', `${patron}=size=${tamano}:rate=${fps}:duration=${resto}`,
      '-map', '1:v', '-map', '0:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', destino]);
  };

  rutas['dj_audio.wav'] = path.join(dir, 'dj_audio.wav');
  recortar(completos.dj, rutas['dj_audio.wav'], desfases['dj_audio.wav']);

  rutas['jc_audio (1).wav'] = path.join(dir, 'jc_audio (1).wav');
  recortar(completos.jc, rutas['jc_audio (1).wav'], desfases['jc_audio (1).wav']);

  rutas['dj_camara.mp4'] = path.join(dir, 'dj_camara.mp4');
  conVideo(completos.dj_cam, rutas['dj_camara.mp4'], desfases['dj_camara.mp4'], 'testsrc');

  rutas['jc_camara (1).mp4'] = path.join(dir, 'jc_camara (1).mp4');
  conVideo(completos.jc_cam, rutas['jc_camara (1).mp4'], desfases['jc_camara (1).mp4'], 'smptebars');

  rutas['jc_llamada (1).mp4'] = path.join(dir, 'jc_llamada (1).mp4');
  conVideo(completos.llamada, rutas['jc_llamada (1).mp4'], desfases['jc_llamada (1).mp4'], 'rgbtestsrc');

  for (const f of Object.values(completos)) fs.rmSync(f, { force: true });

  return { dir, rutas, desfases, turnos, duracion, fps };
}

/*
 * Simula que la página de jc se cayó: su cámara y su micro se cortan en `caida` (segundos de su archivo) y
 * vuelve en `vuelta` con archivos propios (jc-2_camara.mp4, jc-2_audio.wav), como hace el Estudio al retomar.
 *
 * Con `llamada: true` la caída es la del anfitrión, que es quien graba la llamada (lo que pasó de verdad):
 * la llamada también se corta y sigue en jc-2_llamada.mp4, en el mismo instante de la sesión.
 */
function retomar(sesion, options) {
  const { caida, vuelta } = options;
  const enSuReloj = (nombre, t) => t + sesion.desfases['jc_camara (1).mp4'] - sesion.desfases[nombre];
  const cortar = (nombre, base, ext, reencode) => {
    const original = sesion.rutas[nombre];
    const tmp = path.join(sesion.dir, `_corte.${ext}`);
    ffmpeg(['-i', original, '-t', String(enSuReloj(nombre, caida)), ...(ext === 'mp4' ? ['-c', 'copy'] : []), tmp]);
    const nuevo = path.join(sesion.dir, `jc-2_${base}.${ext}`);
    ffmpeg(['-ss', String(enSuReloj(nombre, vuelta)), '-i', original, ...reencode, nuevo]);
    fs.renameSync(tmp, original);
    sesion.rutas[`jc-2_${base}.${ext}`] = nuevo;
  };
  const mp4 = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
  cortar('jc_camara (1).mp4', 'camara', 'mp4', mp4);
  cortar('jc_audio (1).wav', 'audio', 'wav', []);
  if (options.llamada) cortar('jc_llamada (1).mp4', 'llamada', 'mp4', mp4);
  return sesion;
}

module.exports = { generar, retomar, escribirWav, aleatorio, SR };
