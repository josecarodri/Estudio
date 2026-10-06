'use strict';
/* Shorts verticales: la receta 9:16, dónde empieza y acaba cada uno, y sus subtítulos. */
const test = require('node:test');
const assert = require('node:assert');

const SH = require('../shorts.js');

/* Montaje final a 25 fps: jc solo hasta 100, plano doble (jc izquierda, dj derecha) de 100 a 200, rótulo encima. */
function final() {
  return {
    project: { name: 'x', fps: 25, width: 1920, height: 1080 },
    media: [{ id: 'p1_cam_jc', path: 'jc.mp4' }, { id: 'p1_cam_dj', path: 'dj.mp4' }, { id: 'p1_mic_jc', path: 'jc.wav' }, { id: 'rotulo_jc', path: 'r.mov' }],
    tracks: { video: 3, audio: 1 },
    edit: [
      { clip: 'p1_cam_jc', in: 50, at: 0, duration: 100, audio: false },
      { clip: 'p1_cam_jc', in: 150, at: 100, duration: 100, audio: false, zoom: 0.5, pan: -480 },
      { clip: 'p1_cam_dj', in: 200, at: 100, duration: 100, audio: false, zoom: 0.5, pan: 480, track: 2 },
      { clip: 'rotulo_jc', in: 0, at: 20, duration: 100, audio: false, track: 3 },
      { clip: 'p1_mic_jc', in: 7, at: 0, duration: 200, audioTrack: 1 },
    ],
  };
}

test('vertical: la cámara llena el alto (recortada por el centro) y el plano doble pasa a arriba y abajo', () => {
  const v = SH.recetaVertical(final(), 2, 6);   // frames 50-150
  assert.deepStrictEqual(v.project, { name: 'x', fps: 25, width: 1080, height: 1920 });
  const video = v.edit.filter((e) => !e.audioTrack).map((e) => [e.clip, e.at, e.duration, e.in, e.zoom, e.tilt, e.track]);
  assert.deepStrictEqual(video, [
    ['p1_cam_jc', 0, 50, 100, 3.16, undefined, undefined],      // 1920·(16/9)/1080
    ['p1_cam_jc', 50, 50, 150, 1.58, 480, undefined],           // arriba
    ['p1_cam_dj', 50, 50, 200, 1.58, -480, 2],                  // abajo
  ]);
  assert.ok(!v.edit.some((e) => e.clip === 'rotulo_jc'), 'sin rótulos');
  assert.deepStrictEqual(v.media.map((m) => m.id).sort(), ['p1_cam_dj', 'p1_cam_jc', 'p1_mic_jc']);
  assert.deepStrictEqual(v.edit.filter((e) => e.audioTrack).map((e) => [e.at, e.duration, e.in]), [[0, 100, 57]]);
  // Una cámara 4:3 necesita menos zoom para llenar el alto.
  assert.strictEqual(SH.recetaVertical(final(), 0, 2, { aspectos: { p1_cam_jc: 4 / 3 } }).edit[0].zoom, 2.37);
});

/* Palabras del vídeo final: una cada 0,5 s, con frases que acaban en punto. */
const palabras = (texto, desde = 0) => texto.split(' ').map((w, i) => ({ w, ini: desde + i * 0.5, fin: desde + i * 0.5 + 0.4 }));

test('cada short empieza y acaba en una frase (con un respiro), sin pasar del máximo', () => {
  const p = palabras('Uno dos tres. Cuatro cinco seis siete. Ocho nueve diez once doce. Trece catorce quince.');
  // Pedido de 1,2 a 7,2: empieza en «Cuatro» (1,5), con un respiro que no pisa «tres.» (acaba en 1,4), y acaba
  // en «quince.» (7,4) y 0,4 s más.
  assert.deepStrictEqual(SH.ajustarAFrases(p, 1.2, 7.2), { desde: 1.4, hasta: 7.8 });
  // De 1,2 a 5,2 acabaría en «doce.» (5,9), pero un short de menos de 5 s es muy poco: sigue hasta «quince.».
  assert.deepStrictEqual(SH.ajustarAFrases(p, 1.2, 5.2), { desde: 1.4, hasta: 7.8 });
  // Sin pasar del máximo (3 s desde «Cuatro»): acaba en la última frase que cabe, «siete.», sin pisar «Ocho».
  assert.deepStrictEqual(SH.ajustarAFrases(p, 1.2, 5.2, { maximo: 3 }), { desde: 1.4, hasta: 3.5 });
});

test('qué shorts: uno por ★ (dos ★ seguidas, uno), o los del episodio.json, con avisos de lo que no vale', () => {
  const p = palabras(Array.from({ length: 200 }, (_, i) => (i % 8 === 7 ? `p${i}.` : `p${i}`)).join(' '));
  const auto = SH.rangosDeShorts({ momentos: [{ t: 60, nombre: 'DJ' }, { t: 62, nombre: 'JC' }], palabras: p, total: 100 });
  assert.strictEqual(auto.rangos.length, 1);
  assert.ok(auto.rangos[0].desde >= 14 && auto.rangos[0].desde <= 26 && auto.rangos[0].hasta <= 75, JSON.stringify(auto.rangos));
  assert.match(auto.rangos[0].motivo, /★ de DJ en 01:00/);
  const pedidos = SH.rangosDeShorts({
    entradas: [{ desde: '0:10', hasta: '0:40' }, { frase: 'p40 p41', segundos: 20 }, { desde: '1:00', hasta: '0:50' }, { frase: 'no está' }, { titulo: 'x' }],
    momentos: [{ t: 60 }], palabras: p, total: 100,
  });
  assert.deepStrictEqual(pedidos.rangos.map((x) => Math.round(x.desde)), [10, 20]);
  assert.strictEqual(pedidos.avisos.length, 3, pedidos.avisos.join('\n'));
});

test('subtítulos del short: frases cortas desde su principio, en ASS con letra grande y sin llaves', () => {
  const p = palabras('Hola a todos. {Esto} es una prueba de subtítulos para el short.', 10);
  const cues = SH.subtitulosDelShort(p, 10, 15);
  assert.strictEqual(cues[0].ini, 0);
  assert.ok(cues.every((c) => c.lineas.every((l) => l.length <= 22)), JSON.stringify(cues));
  const ass = SH.aAss(cues, { familia: 'DejaVu Sans' });
  assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
  assert.match(ass, /Style: Corto,DejaVu Sans,77,/);
  assert.match(ass, /Dialogue: 0,0:00:00\.00,0:00:0\d\.\d\d,Corto,,0,0,0,,Hola a todos\./);
  assert.doesNotMatch(ass, /[{}]Esto/);
});
