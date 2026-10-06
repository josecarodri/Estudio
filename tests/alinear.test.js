'use strict';
/*
 * Alineado con ffmpeg (tools/alinear.js) en una sesión con caída: una persona entera, la otra con su página
 * caída a mitad y un tramo retomado que empieza después del pitido. Se salta sola si no hay ffmpeg.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { findBeep } = require('../lib/beep');
const { wavHeader } = require('../lib/core');

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const SR = 48000;

/** WAV de `segundos` con un ruido de fondo suave y un pitido de 1 kHz (0,25 s) en cada instante de `pitidos`. */
function wav(file, segundos, pitidos) {
  const n = Math.round(segundos * SR);
  const datos = Buffer.alloc(n * 2);
  let semilla = 7;
  for (let i = 0; i < n; i += 1) {
    semilla = (semilla * 1103515245 + 12345) & 0x7fffffff;
    let v = ((semilla / 0x7fffffff) - 0.5) * 0.02;
    for (const p of pitidos) if (i >= p * SR && i < (p + 0.25) * SR) v = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / SR);
    datos.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  fs.writeFileSync(file, Buffer.concat([wavHeader(SR, 1, datos.length), datos]));
}

/** Instante (s) del primer pitido a partir de `desde` en un archivo, o null. */
function pitidoEn(file, desde) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(desde), '-t', '10', '-i', file, '-ac', '1', '-ar', '16000', '-f', 's16le', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const x = new Float32Array(Math.floor(r.stdout.length / 2));
  for (let i = 0; i < x.length; i += 1) x[i] = r.stdout.readInt16LE(i * 2) / 32768;
  const t = findBeep(x, 16000);
  return t === null ? null : desde + t;
}

const duracion = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout);

test('alinear: un tramo retomado (sin pitido de inicio) va a su sitio y una pista cortada no recorta a las demás', { skip: !hayFfmpeg }, () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alinear-')), 'sesion');
  fs.mkdirSync(dir);
  wav(path.join(dir, 'dj_audio.wav'), 62, [1, 60]);       // entera: pitido al empezar y al acabar
  wav(path.join(dir, 'jc_audio.wav'), 30, [1]);           // su página murió a los 30 s
  wav(path.join(dir, 'jc-2_audio.wav'), 22, [20]);        // retomó a los 40 s del reloj común: solo el pitido final
  const inicio = 1_000_000;
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    id: 'sesion', room: 'dtp', startAt: inicio, beepAt: inicio + 1000, endBeepAt: inicio + 60000,
    participants: { a: { name: 'DJ', label: 'dj' }, b: { name: 'JC', label: 'jc' }, c: { name: 'JC', label: 'jc-2', retomada: true, retomaDe: 'jc' } },
    tracks: {
      'a-audio': { participant: 'a', kind: 'audio', file: 'dj_audio.wav', format: 'wav', startedAtServer: inicio, beepOffsetSec: 1 },
      'b-audio': { participant: 'b', kind: 'audio', file: 'jc_audio.wav', format: 'wav', startedAtServer: inicio, beepOffsetSec: 1 },
      'c-audio': { participant: 'c', kind: 'audio', file: 'jc-2_audio.wav', format: 'wav', startedAtServer: inicio + 40000, beepOffsetSec: null },
    },
  }));
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'tools', 'alinear.js'), dir, '--mantener-pitido'], { encoding: 'utf8', timeout: 120000 });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);

  const out = (n) => path.join(dir, 'alineados', n);
  // El pitido final de los dos que llegaron al final cae en el mismo instante.
  const finDj = pitidoEn(out('dj_audio.wav'), 55);
  const finJc2 = pitidoEn(out('jc-2_audio.wav'), 55);
  assert.ok(Math.abs(finDj - 60) < 0.01, `pitido final de dj en ${finDj}`);
  assert.ok(Math.abs(finJc2 - finDj) < 0.01, `pitido final del tramo retomado en ${finJc2}, el de dj en ${finDj}`);
  assert.ok(Math.abs(pitidoEn(out('dj_audio.wav'), 0) - 1) < 0.01, 'el pitido de inicio sigue en el segundo 1');
  // La pista cortada no recorta a las demás.
  assert.ok(Math.abs(duracion(out('dj_audio.wav')) - 62) < 0.1);
  assert.ok(Math.abs(duracion(out('jc-2_audio.wav')) - 62) < 0.1);
  assert.ok(Math.abs(duracion(out('jc_audio.wav')) - 30) < 0.1, 'la cortada conserva lo que tiene');
  assert.match(fs.readFileSync(out('LEEME.txt'), 'utf8'), /jc-2_audio\.wav .*empieza 40\.000 s después/);
});
