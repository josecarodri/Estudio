/*
 * Clips horizontales de unos minutos (como los de los podcasts grandes: un tema del episodio, con su título),
 * sacados del vídeo final ya acabado: el color y el sonido son los del episodio, así que solo se recorta y se
 * vuelve a codificar, con un fundido corto al principio y al final. Cada uno con sus subtítulos (.srt) y su
 * descripción, que enlaza al episodio completo.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SH = require('./shorts.js');
const YT = require('./youtube.js');

const reloj = (x) => String(x).split(':').map(Number).reduce((s, v) => s * 60 + v, 0);
const esTiempo = (x) => typeof x === 'number' || /^\d+(:\d{1,2}(\.\d+)?){0,2}$/.test(String(x).trim());

/*
 * Qué clips hacer. `entradas` (las del episodio.json): { titulo, desde, hasta, resumen? }, donde desde y hasta
 * son minutos del vídeo final ("26:20") o frases: «desde» empieza en esa frase y «hasta» acaba justo antes de
 * ella (como los cortes por texto). Se ajustan a frases completas. Devuelve { clips, avisos }.
 */
function rangosDeClips({ entradas, palabras, total, minimo = 60, maximo = 20 * 60 }) {
  const avisos = [];
  const clips = [];
  (Array.isArray(entradas) ? entradas : []).forEach((e, i) => {
    const n = `clip ${i + 1}`;
    if (e.desde === undefined || e.hasta === undefined) { avisos.push(`${n}: hacen falta «desde» y «hasta» (minuto o frase)`); return; }
    const punto = (v) => (esTiempo(v) ? reloj(v) : SH.buscar(palabras, String(v)));
    const a = punto(e.desde);
    if (a === null) { avisos.push(`${n}: no encuentro «${e.desde}» en el vídeo final`); return; }
    // «hasta» por frase: la que esté después de «desde» (la misma frase puede salir antes).
    const b = esTiempo(e.hasta) ? reloj(e.hasta) : SH.buscar(palabras.filter((p) => p.ini > a), String(e.hasta));
    if (b === null) { avisos.push(`${n}: no encuentro «${e.hasta}» después de «${e.desde}»`); return; }
    const fin = Math.min(b, total);
    if (!(fin - a >= minimo) || fin - a > maximo) {
      avisos.push(`${n}: ${e.desde} → ${e.hasta} dura ${Math.round(fin - a)} s (entre ${minimo} s y ${maximo / 60} min)`);
      return;
    }
    const r = SH.ajustarAFrases(palabras, a, fin, { maximo: fin - a + 10, holgura: 8 });
    if (!esTiempo(e.hasta)) {
      // Acaba justo antes de esa frase, nunca dentro: con un respiro tras la última palabra de antes.
      const previa = palabras.filter((p) => p.fin <= b).pop();
      r.hasta = Math.round(Math.min(b, previa ? previa.fin + 0.4 : b) * 100) / 100;
    }
    clips.push({ ...r, hasta: Math.min(r.hasta, total), titulo: e.titulo ? String(e.titulo) : `Clip ${i + 1}`, resumen: e.resumen });
  });
  return { clips, avisos };
}

/* La descripción del clip: su resumen, el enlace al episodio completo y el pie del equipo. */
function descripcionDelClip({ resumen, tituloEpisodio, enlace, pie }) {
  const partes = [];
  if (resumen) partes.push(String(resumen).trim());
  const del = tituloEpisodio ? ` («${tituloEpisodio}»)` : '';
  partes.push(`▶ Episodio completo${del}: ${enlace || '(falta el enlace: «enlace» en el episodio.json del episodio)'}`);
  if (pie) partes.push(String(pie).trim());
  return partes.join('\n\n');
}

/* Subtítulos del clip, con tiempos desde su principio (las mismas reglas que los del episodio). */
function subtitulosDelClip(palabras, desde, hasta) {
  const dentro = palabras.filter((p) => p.ini >= desde && p.fin <= hasta + 0.2).map((p) => ({ ...p, ini: p.ini - desde, fin: Math.min(p.fin, hasta) - desde }));
  return YT.subtitulos(dentro);
}

/*
 * Recorta [desde, hasta) del vídeo final con un fundido de 0,3 s al entrar y 0,5 s al salir (imagen y sonido) y
 * deja una imagen del tercio del clip para la miniatura. h: { entrada, salida, desde, hasta, argumentosVideo
 * (codificador) => [...], codificador, etiquetasColor }. Devuelve { segundos, codificador } o { error }.
 */
function hacerClip(h) {
  fs.mkdirSync(path.dirname(h.salida), { recursive: true });
  const dur = Math.round((h.hasta - h.desde) * 1000) / 1000;
  const vf = `fade=t=in:d=0.3,fade=t=out:st=${(dur - 0.5).toFixed(3)}:d=0.5`;
  const af = `afade=t=in:d=0.3,afade=t=out:st=${(dur - 0.5).toFixed(3)}:d=0.5`;
  const codificar = (codificador) => spawnSync('ffmpeg', [
    '-v', 'error', '-y', '-ss', h.desde.toFixed(3), '-i', h.entrada, '-t', dur.toFixed(3),
    '-vf', vf, ...h.argumentosVideo(codificador), ...(h.etiquetasColor || []),
    '-af', af, '-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-movflags', '+faststart', h.salida,
  ], { encoding: 'utf8', timeout: 60 * 60000 });
  let codificador = h.codificador === 'nvenc' ? 'nvenc' : 'x264';
  let res = codificar(codificador);
  if (res.status !== 0 && codificador === 'nvenc') { codificador = 'x264'; res = codificar(codificador); }
  if (res.status !== 0) return { error: (res.stderr || 'ffmpeg falló').trim().split('\n').slice(-2).join(' · ') };
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', (dur / 3).toFixed(3), '-i', h.salida, '-frames:v', '1', '-q:v', '2',
    h.salida.replace(/\.mp4$/i, '.jpg')], { encoding: 'utf8' });
  return { segundos: dur, codificador };
}

module.exports = { rangosDeClips, descripcionDelClip, subtitulosDelClip, hacerClip };
