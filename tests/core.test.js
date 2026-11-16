'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { slug, wavHeader, fixWavHeader, chunkDecision, extFromMime, sessionIdFromDate } = require('../lib/core');
const Clock = require('../public/js/clock');
const { computeOffset } = Clock;
const { parseEnv } = require('../lib/env');

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
test('el reloj acumula muestras y usa la más rápida', () => {
  const t = Clock.localNow();
  Clock.addSample({ t0: t - 300, server: t + 5000 - 250, t1: t - 200 });   // rtt 100
  Clock.addSample({ t0: t - 100, server: t + 5000 - 95, t1: t - 90 });     // rtt 10 → desfase 5000
  const e = Clock.estimate();
  assert.strictEqual(e.rtt, 10);
  assert.strictEqual(e.offset, 5000);
});

test('lee el archivo .env', () => {
  const env = parseEnv('# comentario\nA=1\nB = "dos tres"\n\nMAL\nC=x=y');
  assert.deepStrictEqual(env, { A: '1', B: 'dos tres', C: 'x=y' });
});
