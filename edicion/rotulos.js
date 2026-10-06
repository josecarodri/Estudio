/*
 * Rótulos con el nombre: la primera vez que se ve a cada persona sola en pantalla, su nombre abajo a la
 * izquierda unos segundos, con un fundido. Cada rótulo es un vídeo corto con transparencia (QuickTime
 * Animation) que hace ffmpeg y va en la pista V3, encima de todo: en Kdenlive se mueve o se quita como
 * cualquier otro clip. Los nombres van en el episodio.json del equipo:
 *   "rotulos": { "nombres": { "jc": "José Carlos", "dj": "Douglas" } }
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const { personaDeClip } = require('./cortes.js');

const existe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

// Una letra gruesa que se lea bien (con el nombre de su familia, que es como la piden los subtítulos ASS).
const FUENTES = [
  ['C:/Windows/Fonts/segoeuib.ttf', 'Segoe UI'], ['C:/Windows/Fonts/arialbd.ttf', 'Arial'],
  ['/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'], ['/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', 'DejaVu Sans'],
  ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', 'Arial'], ['/Library/Fonts/Arial Bold.ttf', 'Arial'],
];

/* { archivo, familia } de la primera letra gruesa que haya en este equipo, o null (se usa la de ffmpeg). */
function fuenteGruesa() {
  const f = FUENTES.find(([archivo]) => existe(archivo));
  return f ? { archivo: f[0], familia: f[1] } : null;
}

/*
 * Hace el vídeo de un rótulo (o lo reutiliza si ya está hecho igual): `texto` en blanco sobre una caja
 * oscura medio transparente, con fundido de entrada y de salida. Devuelve { archivo } o { error }.
 */
function hacerRotulo(texto, { dir, ancho, alto, fps, segundos }) {
  const huella = crypto.createHash('sha1').update(JSON.stringify({ texto, ancho, alto, fps, segundos, v: 1 })).digest('hex').slice(0, 12);
  const archivo = path.join(dir, `rotulo-${huella}.mov`);
  if (existe(archivo)) return { archivo };
  fs.mkdirSync(dir, { recursive: true });
  const fuente = fuenteGruesa();
  // La fuente y el texto se dejan al lado y se nombran sin ruta: así no hay que lidiar con «C:» ni con comillas.
  if (fuente) fs.copyFileSync(fuente.archivo, path.join(dir, 'fuente-rotulo.ttf'));
  fs.writeFileSync(path.join(dir, `rotulo-${huella}.txt`), String(texto), 'utf8');
  const letra = Math.round(alto * 0.05);
  const fundido = Math.min(0.4, segundos / 4);
  const filtro = `drawtext=${fuente ? 'fontfile=fuente-rotulo.ttf' : 'font=Sans'}:textfile=rotulo-${huella}.txt:expansion=none`
    + `:fontsize=${letra}:fontcolor=white:box=1:boxcolor=0x111111@0.78:boxborderw=${Math.round(letra * 0.45)}`
    + `:x=${Math.round(ancho * 0.045)}:y=h-${Math.round(alto * 0.13)}-th`
    + `,fade=t=in:st=0:d=${fundido}:alpha=1,fade=t=out:st=${segundos - fundido}:d=${fundido}:alpha=1`;
  const tmp = `rotulo-${huella}.tmp.mov`;
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black@0.0:s=${ancho}x${alto}:r=${fps}:d=${segundos},format=rgba`,
    '-vf', filtro, '-c:v', 'qtrle', '-pix_fmt', 'argb', tmp], { cwd: dir, encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0) {
    fs.rmSync(path.join(dir, tmp), { force: true });
    return { error: (res.stderr || (res.error && res.error.message) || 'ffmpeg falló').trim().split('\n').slice(-2).join(' · ') };
  }
  fs.renameSync(path.join(dir, tmp), archivo);
  return { archivo };
}

/*
 * Pone los rótulos en la receta final. `rotulos`: [{ persona, archivo }]. Cada uno va en el primer plano
 * de esa persona sola (no en un plano doble) en el que quepa entero a partir del segundo `desde`, medio
 * segundo después de empezar el plano. Devuelve { receta, puestos: [{ persona, at }], sinSitio: [persona] }.
 */
function colocarRotulos(receta, rotulos, { segundos = 4, desde = 3 } = {}) {
  const out = JSON.parse(JSON.stringify(receta));
  const fps = Number(out.project.fps);
  const largo = Math.round(segundos * fps);
  const margen = Math.round(0.5 * fps);
  const encima = out.edit.filter((e) => !e.audioTrack && e.track > 1);
  const planos = out.edit.filter((e) => !e.audioTrack && String(e.clip).includes('cam_') && !(e.track > 1)).sort((a, b) => a.at - b.at);
  const puestos = [];
  const sinSitio = [];
  for (const r of rotulos) {
    let at = null;
    for (const p of planos) {
      if (personaDeClip(p.clip) !== r.persona) continue;
      const ini = Math.max(p.at, Math.round(desde * fps)) + margen;
      if (ini + largo > p.at + p.duration) continue;
      if (encima.some((e) => e.at < ini + largo && ini < e.at + e.duration)) continue;
      at = ini;
      break;
    }
    if (at === null) { sinSitio.push(r.persona); continue; }
    const id = `rotulo_${r.persona}`;
    out.media = [...out.media.filter((m) => m.id !== id), { id, path: r.archivo }];
    out.edit.push({ clip: id, in: 0, at, duration: largo, track: 3, audio: false });
    puestos.push({ persona: r.persona, at });
  }
  if (puestos.length) out.tracks = { ...(out.tracks || {}), video: Math.max(3, Number((out.tracks || {}).video) || 1) };
  out.edit.sort((x, y) => x.at - y.at); // cada pista, en orden: si no, Kdenlive (y el montaje) lo toman por solapes
  return { receta: out, puestos, sinSitio };
}

module.exports = { hacerRotulo, colocarRotulos, fuenteGruesa };
