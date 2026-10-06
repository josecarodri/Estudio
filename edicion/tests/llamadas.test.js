'use strict';
/*
 * La llamada partida (llamadas.js): cuándo se une, con qué se sitúa cada tramo y qué pasa si no
 * se puede medir. Lo que necesita ffmpeg se salta solo si no está.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LL = require('../llamadas.js');
const M = require('../media.js');

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'llamadas-'));

function ruido(f, segundos) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `anoisesrc=r=16000:d=${segundos}:a=0.2:c=pink`, '-c:a', 'pcm_s16le', f]);
  assert.strictEqual(r.status, 0);
  return f;
}

test('una sola llamada se usa tal cual, sin escribir nada', () => {
  const dir = tmp();
  const r = LL.llamadaParaReloj(['/x/dj_camara.mp4', '/x/jc_llamada.mp4'], dir);
  assert.strictEqual(path.basename(r.archivo), 'jc_llamada.mp4');
  assert.strictEqual(r.unida, false);
  assert.deepStrictEqual(fs.readdirSync(dir), []);
  assert.strictEqual(LL.llamadaParaReloj(['/x/dj_camara.mp4'], dir).archivo, null, 'sin llamada');
});

test('si las dos personas grabaron la llamada, se usa la que está entera y la otra se ignora', () => {
  const t = LL.tramosDeLlamada(['/x/jc_llamada.mp4', '/x/jc-2_llamada.mp4', '/x/dj_llamada.mp4']);
  assert.deepStrictEqual(t.tramos.map((f) => path.basename(f)), ['dj_llamada.mp4']);
  assert.deepStrictEqual(t.ignoradas.map((f) => path.basename(f)).sort(), ['jc-2_llamada.mp4', 'jc_llamada.mp4']);
  const solo = LL.tramosDeLlamada(['/x/jc-2_llamada.mp4', '/x/jc_llamada.mp4']);
  assert.deepStrictEqual(solo.tramos.map((f) => path.basename(f)), ['jc_llamada.mp4', 'jc-2_llamada.mp4']);
});

test('sin grabación de la otra persona, cada tramo se sitúa con la hora de inicio del session.json', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const a = ruido(path.join(dir, 'jc_llamada.wav'), 3);
  const b = ruido(path.join(dir, 'jc-2_llamada.wav'), 2);
  const sesion = path.join(dir, 'session.json');
  fs.writeFileSync(sesion, JSON.stringify({ tracks: { x: { file: 'jc_llamada.wav', startedAtServer: 1000 }, y: { file: 'jc-2_llamada.wav', startedAtServer: 9000 } } }));
  const salida = path.join(dir, 'montaje');
  const r = LL.llamadaParaReloj([a, b], salida, { sesion });
  assert.ok(!r.error, r.error);
  assert.strictEqual(r.unida, true);
  assert.match(r.fuente, /session\.json/);
  assert.deepStrictEqual(r.tramos.map((t) => t.desde), [0, 8]);
  const dur = M.probe(r.archivo, null).seconds;
  assert.ok(Math.abs(dur - 10) < 0.1, `dura ${dur} s: 8 s hasta el segundo tramo más sus 2 s`);

  const otra = LL.llamadaParaReloj([a, b], salida, { sesion });
  assert.strictEqual(otra.reutilizada, true, 'la segunda vez se reutiliza');
});

test('si no se puede situar cada tramo, lo dice y explica qué hacer (en vez de montar mal)', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const a = ruido(path.join(dir, 'jc_llamada.wav'), 2);
  const b = ruido(path.join(dir, 'jc-2_llamada.wav'), 2);
  const r = LL.llamadaParaReloj([a, b], path.join(dir, 'montaje'));
  assert.match(r.error, /partida/);
  assert.match(r.error, /importar/);
});
