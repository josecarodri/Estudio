#!/usr/bin/env node
'use strict';
/*
 * Alinea las pistas de una sesión usando la claqueta digital (pitido de 1 kHz) y genera archivos
 * listos para el editor: mismo punto de inicio, vídeo H.264 a fotogramas constantes, audio a 48 kHz.
 *
 *   npm run alinear                                  → todas las sesiones de grabaciones/
 *   npm run alinear -- grabaciones/sala/2026-...     → una sesión
 *   opciones: --fps 30 | --mantener-pitido | --crf 18
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
const DETECT_RATE = 16000;
const SEARCH_SEC = 20;

function run(cmd, cmdArgs, opts = {}) {
  const r = spawnSync(cmd, cmdArgs, { maxBuffer: 1024 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}

function checkFfmpeg() {
  try { run('ffmpeg', ['-version']); run('ffprobe', ['-version']); return true; } catch { return false; }
}

/** Decodifica los primeros segundos a PCM mono (en la línea de tiempo del archivo) y busca el pitido. */
function detectBeep(file) {
  const r = run('ffmpeg', ['-v', 'error', '-i', file, '-t', String(SEARCH_SEC), '-vn', '-af', 'aresample=async=1:first_pts=0', '-ac', '1', '-ar', String(DETECT_RATE), '-f', 's16le', '-']);
  if (r.status !== 0 || !r.stdout.length) return null;
  const buf = r.stdout;
  const x = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < x.length; i++) x[i] = buf.readInt16LE(i * 2) / 32768;
  return findBeep(x, DETECT_RATE);
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

function alignSession(dir) {
  const metaFile = path.join(dir, 'session.json');
  if (!fs.existsSync(metaFile)) return;
  const s = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  console.log(`\n▶ Sesión ${s.id} (sala ${s.room})`);

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
    console.log(`  · ${t.file}: pitido en ${beep.toFixed(3)} s — ${source}${drift}`);
    const dur = duration(file);
    items.push({ id, t, file, beep, person, dur, ...probe(file) });
  }
  if (!items.length) { console.log('  Nada que alinear.'); return; }

  // Todas las salidas empiezan LEAD segundos antes del pitido (lo máximo que permiten todas las pistas).
  const lead = Math.max(0, Math.min(1, ...items.map((i) => i.beep)));
  const durations = items.map((i) => (i.dur != null ? i.dur - (i.beep - lead) : null)).filter((d) => d != null && d > 0);
  const common = durations.length === items.length ? Math.min(...durations) : null;
  const outDir = path.join(dir, 'alineados');
  fs.mkdirSync(outDir, { recursive: true });

  const report = [
    `Sesión ${s.id} · sala ${s.room}`,
    `Todas las pistas empiezan en el mismo instante. El pitido de sincronía está en ${lead.toFixed(3)} s${KEEP_BEEP ? '' : ' (silenciado)'}.`,
    common ? `Duración común: ${common.toFixed(2)} s` : 'Duración: la de cada pista',
    '',
  ];

  for (const it of items) {
    const trim = it.beep - lead;
    const base = path.basename(it.t.file, path.extname(it.t.file));
    const isWav = it.t.format === 'wav' || !it.hasVideo;
    const out = path.join(outDir, `${base}.${isWav ? 'wav' : 'mp4'}`);
    const a = ['-y', '-v', 'error', '-stats', '-fflags', '+genpts', '-i', it.file, '-ss', trim.toFixed(4)];
    if (common) a.push('-t', common.toFixed(4));
    const afilters = ['aresample=48000:async=1:first_pts=0'];
    if (!KEEP_BEEP) afilters.push(`volume=enable='between(t,${(lead - 0.02).toFixed(3)},${(lead + 0.3).toFixed(3)})':volume=0`);
    if (isWav) {
      a.push('-vn', '-af', afilters.join(','), '-c:a', 'pcm_s24le', out);
    } else {
      a.push('-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF), '-movflags', '+faststart');
      if (it.hasAudio) a.push('-af', afilters.join(','), '-c:a', 'aac', '-b:a', '320k', '-ar', '48000');
      a.push(out);
    }
    console.log(`    → ${path.relative(process.cwd(), out)}`);
    const r = run('ffmpeg', a, { stdio: ['ignore', 'inherit', 'inherit'] });
    if (r.status !== 0) { console.log(`    ✗ ffmpeg falló con ${it.t.file}`); continue; }
    report.push(`${path.basename(out)}  ←  ${it.t.file}  (${it.person}, recortado ${trim.toFixed(3)} s al inicio)`);
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
