#!/usr/bin/env node
'use strict';
/*
 * Alinea las pistas de una sesión usando la claqueta digital (pitido de 1 kHz) y genera archivos
 * listos para el editor: mismo punto de inicio, vídeo H.264 a fotogramas constantes, audio a 48 kHz.
 *
 *   npm run alinear                                  → todas las sesiones de grabaciones/
 *   npm run alinear -- grabaciones/sala/2026-...     → una sesión
 *   opciones: --fps 30 | --mantener-pitido | --crf 18 | --sin-lado-a-lado
 *
 * Con dos personas genera además lado_a_lado.mp4 (las dos cámaras juntas) para usarlo como tercera
 * «cámara» en un clip multicámara del editor.
 *
 * Requiere ffmpeg y ffprobe en el PATH.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { findBeep } = require('../lib/beep');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const FPS = Number(opt('--fps', 30));
const CRF = Number(opt('--crf', 18));
const KEEP_BEEP = args.includes('--mantener-pitido');
const NO_SIDE_BY_SIDE = args.includes('--sin-lado-a-lado');
const DETECT_RATE = 16000;
const SEARCH_SEC = 20;
const MAX_DRIFT_PPM = 20000;  // más de un 2 % no es deriva de reloj sino un pitido mal detectado

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { maxBuffer: 1024 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function checkFfmpeg() {
  try { run('ffmpeg', ['-version']); run('ffprobe', ['-version']); return true; } catch { return false; }
}

/**
 * Decodifica un tramo a PCM mono (en la línea de tiempo del archivo) y busca el pitido.
 * @param {number} [from] segundo desde el que buscar (para el pitido final)
 */
function detectBeep(file, from = 0) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file, '-vn', '-af',
    `aresample=async=1:first_pts=0,atrim=start=${from.toFixed(3)}:duration=${SEARCH_SEC}`,
    '-ac', '1', '-ar', String(DETECT_RATE), '-f', 's16le', '-']);
  if (r.status !== 0 || !r.stdout.length) return null;
  const buf = r.stdout;
  const x = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(i * 2) / 32768;
  const t = findBeep(x, DETECT_RATE);
  return t == null ? null : from + t;
}

function probe(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file]);
  const types = r.stdout.toString().split(/\s+/).filter(Boolean);
  return { hasVideo: types.includes('video'), hasAudio: types.includes('audio') };
}

/** Duración real. Los archivos de MediaRecorder no la llevan en la cabecera: se decodifica el audio. */
function duration(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = parseFloat(r.stdout.toString());
  if (Number.isFinite(d) && d > 0) return d;
  const dec = run('ffmpeg', ['-v', 'info', '-i', file, '-map', '0:a:0?', '-map', '0:v:0?', '-f', 'null', '-']);
  const m = [...dec.stderr.toString().matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

/**
 * Vista «lado a lado» 1920×1080: cada cámara recortada al centro para llenar su mitad, con una línea fina entre ambas.
 * Sin audio (en el editor se usan los WAV). Funciona también si alguien grabó en vertical.
 */
function sideBySide(left, right, out) {
  const half = 'scale=960:1080:force_original_aspect_ratio=increase,crop=960:1080,setsar=1';
  const r = run('ffmpeg', ['-y', '-v', 'error', '-stats', '-i', left, '-i', right,
    '-filter_complex', `[0:v]${half}[l];[1:v]${half}[r];[l][r]hstack=inputs=2:shortest=1,drawbox=x=957:y=0:w=6:h=1080:color=0x111318:t=fill,fps=${FPS},format=yuv420p[v]`,
    '-map', '[v]', '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF), '-movflags', '+faststart', out],
  { stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) { console.log('    ✗ ffmpeg falló al crear la vista lado a lado'); return false; }
  return true;
}

function alignSession(dir) {
  const metaFile = path.join(dir, 'session.json');
  if (!fs.existsSync(metaFile)) return;
  const s = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  console.log(`\n▶ Sesión ${s.id} (sala ${s.room})`);
  const nominal = s.beepAt && s.endBeepAt ? (s.endBeepAt - s.beepAt) / 1000 : null;

  const items = [];
  for (const [id, t] of Object.entries(s.tracks || {})) {
    const file = path.join(dir, t.file);
    if (!fs.existsSync(file) || fs.statSync(file).size < 1000) { console.log(`  · ${t.file}: vacío, se omite`); continue; }
    let beep = detectBeep(file);
    let source = 'pitido detectado';
    if (beep == null && t.beepOffsetSec != null) { beep = t.beepOffsetSec; source = 'metadatos (no se encontró el pitido)'; }
    if (beep == null && t.startedAtServer != null && s.beepAt) { beep = (s.beepAt - t.startedAtServer) / 1000; source = 'metadatos'; }
    if (beep == null) { console.log(`  · ${t.file}: sin referencia de sincronía, se omite`); continue; }
    const person = s.participants[t.participant]?.name || t.participant;
    const expected = t.beepOffsetSec;
    const drift = expected != null ? ` (metadatos: ${expected.toFixed(3)} s)` : '';
    const tarde = beep < 0 ? ' · empezó después del pitido (tramo retomado o que se unió tarde)' : '';
    console.log(`  · ${t.file}: pitido en ${beep.toFixed(3)} s — ${source}${drift}${tarde}`);
    const dur = duration(file);

    // Deriva: cada dispositivo tiene su propio reloj de audio/vídeo y en una hora pueden separarse decenas de ms.
    // Con el pitido final se mide cuánto dura en este archivo el intervalo que en el reloj común dura `nominal`
    // y se estira o encoge la pista en esa proporción.
    let ratio = 1;
    let endBeep = null;
    if (nominal && dur) {
      const expectedEnd = beep + nominal;
      endBeep = detectBeep(file, Math.max(0, expectedEnd - 3));
      if (endBeep != null) {
        const r = nominal / (endBeep - beep);
        const ppm = (r - 1) * 1e6;
        if (Math.abs(ppm) < MAX_DRIFT_PPM) {
          ratio = r;
          console.log(`      deriva ${ppm >= 0 ? '+' : ''}${ppm.toFixed(0)} ppm (${((endBeep - beep - nominal) * 1000).toFixed(1)} ms en ${nominal.toFixed(0)} s) → se corrige`);
        } else {
          console.log(`      pitido final incoherente (${ppm.toFixed(0)} ppm), no se corrige la deriva`);
        }
      } else {
        console.log('      sin pitido final: no se corrige la deriva');
      }
    }
    items.push({ id, t, file, beep, endBeep, ratio, person, dur, ...probe(file) });
  }
  if (!items.length) { console.log('  Nada que alinear.'); return; }

  // Una pista que empezó después del pitido (un tramo retomado tras la caída de la página, o una página que se
  // unió tarde) no se recorta: se desplaza a su sitio con silencio (y negro) delante. Por eso no cuenta para LEAD.
  const conPitido = items.filter((i) => i.beep >= 0);
  // Todas las salidas empiezan LEAD segundos antes del pitido (lo máximo que permiten las pistas que lo tienen).
  const lead = conPitido.length ? Math.max(0, Math.min(1, ...conPitido.map((i) => i.beep * i.ratio))) : 0;
  // La duración común la marcan las pistas que llegaron al final (con su pitido de cierre): una que se cortó
  // porque su página murió es más corta, y no debe recortar a las demás.
  const fin = (i) => (i.dur != null ? (i.dur - (i.beep - lead / i.ratio)) * i.ratio : null);
  const completas = items.filter((i) => i.endBeep != null).map(fin).filter((d) => d != null && d > 0);
  const todas = items.map(fin).filter((d) => d != null && d > 0);
  const common = completas.length ? Math.min(...completas)
    : (!nominal && todas.length === items.length ? Math.min(...todas) : null);
  const outDir = path.join(dir, 'alineados');
  fs.mkdirSync(outDir, { recursive: true });

  const report = [
    `Sesión ${s.id} · sala ${s.room}`,
    `Todas las pistas empiezan en el mismo instante. El pitido de sincronía está en ${lead.toFixed(3)} s${KEEP_BEEP ? '' : ' (silenciado)'}.`,
    nominal ? `Pitido final en ${(lead + nominal).toFixed(3)} s: se usa para corregir la deriva entre dispositivos.` : '',
    common ? `Duración común: ${common.toFixed(2)} s` : 'Duración: la de cada pista',
    '',
  ];

  const cams = [];
  for (const it of items) {
    const R = it.ratio;
    const trim = it.beep - lead / R;          // segundo del archivo original que pasa a ser el 0
    // Si es negativo, la pista empezó después del 0 común: va desplazada esos segundos (de la salida).
    const retraso = trim < 0 ? -trim * R : 0;
    const base = path.basename(it.t.file, path.extname(it.t.file));
    const isWav = it.t.format === 'wav' || !it.hasVideo;
    const out = path.join(outDir, `${base}.${isWav ? 'wav' : 'mp4'}`);
    const a = ['-y', '-v', 'error', '-stats', '-fflags', '+genpts', '-i', it.file];
    if (common) a.push('-t', common.toFixed(4));
    const afilters = [
      'aresample=48000:async=1:first_pts=0',
      ...(retraso ? [] : [`atrim=start=${trim.toFixed(6)}`]),
      `asetpts=(PTS-STARTPTS)*${R.toFixed(9)}`,
      // Estira/encoge el audio con remuestreo suave para que coincida con las marcas de tiempo corregidas.
      ...(R !== 1 ? ['aresample=48000:async=4800'] : []),
      ...(retraso ? [`adelay=${Math.round(retraso * 1000)}:all=1`] : []),
    ];
    if (!KEEP_BEEP) {
      const mute = (at) => `volume=enable='between(t,${(at - 0.02).toFixed(3)},${(at + 0.3).toFixed(3)})':volume=0`;
      afilters.push(mute(lead));
      if (it.endBeep != null && nominal) afilters.push(mute(lead + nominal));
    }
    if (isWav) {
      a.push('-vn', '-af', afilters.join(','), '-c:a', 'pcm_s24le', out);
    } else {
      const vfilters = [
        ...(retraso ? [] : [`trim=start=${trim.toFixed(6)}`]),
        `setpts=(PTS-STARTPTS)*${R.toFixed(9)}`,
        ...(retraso ? [`tpad=start_duration=${retraso.toFixed(6)}:color=black`] : []),
        `fps=${FPS}`, 'format=yuv420p',
      ];
      a.push('-vf', vfilters.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF), '-movflags', '+faststart');
      if (it.hasAudio) a.push('-af', afilters.join(','), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
      a.push(out);
    }
    console.log(`    → ${path.relative(process.cwd(), out)}`);
    const r = run('ffmpeg', a, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) { console.log(`    ✗ ffmpeg falló con ${it.t.file}`); continue; }
    const driftTxt = R !== 1 ? `, deriva corregida ${((R - 1) * 1e6).toFixed(0)} ppm` : '';
    const inicio = retraso ? `empieza ${retraso.toFixed(3)} s después (tramo sin pitido de inicio)` : `recortado ${trim.toFixed(3)} s al inicio`;
    report.push(`${path.basename(out)}  ←  ${it.t.file}  (${it.person}, ${inicio}${driftTxt}${it.endBeep == null && nominal ? ', sin pitido final: se cortó antes' : ''})`);
    if (it.t.kind === 'camara') cams.push({ out, participant: it.t.participant, person: it.person });
  }
  if (cams.length === 2 && !NO_SIDE_BY_SIDE) {
    const order = Object.keys(s.participants || {});
    cams.sort((x, y) => order.indexOf(x.participant) - order.indexOf(y.participant));
    const out = path.join(outDir, 'lado_a_lado.mp4');
    console.log(`    → ${path.relative(process.cwd(), out)}  (${cams[0].person} | ${cams[1].person})`);
    if (sideBySide(cams[0].out, cams[1].out, out)) {
      report.push(`lado_a_lado.mp4  ←  ${cams[0].person} (izquierda) y ${cams[1].person} (derecha), sin audio: usa los WAV`);
    }
  }
  fs.writeFileSync(path.join(outDir, 'LEEME.txt'), report.join('\n') + '\n');
  console.log(`  ✓ Listo: ${path.relative(process.cwd(), outDir)}`);
}

function main() {
  if (!checkFfmpeg()) {
    console.error('No se encontró ffmpeg. Instálalo (https://ffmpeg.org/download.html; en Windows: winget install ffmpeg; en Mac: brew install ffmpeg).');
    process.exit(1);
  }
  const target = args.find((a) => !a.startsWith('--') && !['--fps', '--crf'].includes(args[args.indexOf(a) - 1]));
  const root = path.resolve(target || path.join(__dirname, '..', 'grabaciones'));
  if (fs.existsSync(path.join(root, 'session.json'))) return alignSession(root);
  if (!fs.existsSync(root)) { console.error(`No existe ${root}`); process.exit(1); }
  for (const room of fs.readdirSync(root)) {
    const rd = path.join(root, room);
    if (!fs.statSync(rd).isDirectory()) continue;
    for (const id of fs.readdirSync(rd)) {
      const sd = path.join(rd, id);
      if (fs.statSync(sd).isDirectory()) alignSession(sd);
    }
  }
}

main();
