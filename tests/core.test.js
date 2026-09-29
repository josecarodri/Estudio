'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slug, wavHeader, fixWavHeader, chunkDecision, extFromMime, sessionIdFromDate } = require('../lib/core');
const { findBeep } = require('../lib/beep');
const { computeOffset } = require('../public/js/clock');

test('slug limpia nombres y evita rutas', () => {
  assert.strictEqual(slug('José Ñandú'), 'jose-nandu');
  assert.strictEqual(slug('../../etc'), 'etc');
  assert.strictEqual(slug(''), 'x');
});

test('id de sesión ordenable', () => {
  assert.strictEqual(sessionIdFromDate(new Date(2026, 8, 29, 7, 5, 3)), '2026-09-29_07-05-03');
});

test('cabecera WAV y corrección de tamaños', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wav-')), 'a.wav');
  fs.writeFileSync(f, wavHeader(48000, 1, 0));
  fs.appendFileSync(f, Buffer.alloc(9600));
  fixWavHeader(f);
  const b = fs.readFileSync(f);
  assert.strictEqual(b.toString('ascii', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(4), 36 + 9600);
  assert.strictEqual(b.readUInt32LE(24), 48000);
  assert.strictEqual(b.readUInt32LE(40), 9600);
});

test('orden de trozos', () => {
  assert.strictEqual(chunkDecision(3, 3), 'append');
  assert.strictEqual(chunkDecision(3, 1), 'duplicate');
  assert.strictEqual(chunkDecision(3, 5), 'gap');
  assert.strictEqual(chunkDecision(3, -1), 'invalid');
});

test('extensión según MIME', () => {
  assert.strictEqual(extFromMime('video/mp4;codecs=avc1'), 'mp4');
  assert.strictEqual(extFromMime('video/webm;codecs=vp9,opus'), 'webm');
  assert.strictEqual(extFromMime('audio/mp4'), 'm4a');
});

test('desfase de reloj usa la muestra con menor ida y vuelta', () => {
  const r = computeOffset([
    { t0: 0, server: 1100, t1: 100 },   // rtt 100
    { t0: 200, server: 1210, t1: 220 }, // rtt 20 → offset = 1210 - 210 = 1000
  ]);
  assert.strictEqual(r.offset, 1000);
  assert.strictEqual(r.rtt, 20);
});

function synth(sr, beepAt, noise = 0.05) {
  const x = new Float32Array(sr * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / sr;
    // "voz": mezcla de tonos graves + ruido
    x[i] = 0.2 * Math.sin(2 * Math.PI * 180 * t) + 0.1 * Math.sin(2 * Math.PI * 420 * t) + noise * rnd();
    if (t >= beepAt && t < beepAt + 0.25) x[i] += 0.5 * Math.sin(2 * Math.PI * 1000 * (t - beepAt));
  }
  return x;
}

test('detecta el pitido con precisión de milisegundos', () => {
  for (const at of [1.0, 0.437, 2.2]) {
    const found = findBeep(synth(16000, at), 16000);
    assert.ok(found != null, `no encontrado en ${at}`);
    assert.ok(Math.abs(found - at) < 0.003, `esperado ${at}, obtenido ${found}`);
  }
});

test('no confunde voz sin pitido', () => {
  const x = synth(16000, 99);
  assert.strictEqual(findBeep(x, 16000), null);
});
