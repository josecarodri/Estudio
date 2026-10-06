'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../cortes.js');

function receta() {
  return {
    project: { name: 'x', fps: 30, width: 1920, height: 1080 },
    media: [{ id: 'cam', path: 'a.mp4' }, { id: 'mic', path: 'a.wav' }],
    tracks: { video: 1, audio: 1 },
    edit: [
      { clip: 'cam', in: 100, duration: 300, at: 0, audio: false },
      { clip: 'cam', in: 900, duration: 300, at: 300, audio: false },
      { clip: 'mic', in: 50, duration: 600, at: 0, audioTrack: 1, gain: 2 },
    ],
    guides: [{ at: 0, name: 'a' }, { at: 300, name: 'b' }, { at: 450, name: 'c' }],
  };
}

test('un corte dentro de un clip lo parte y corre lo que viene después', () => {
  const r = C.aplicarCortesFrames(receta(), [{ desde: 100, hasta: 160 }]);
  const cams = r.edit.filter((e) => e.clip === 'cam');
  assert.deepStrictEqual(cams.map((e) => [e.in, e.duration, e.at]),
    [[100, 100, 0], [260, 140, 100], [900, 300, 240]]);
  assert.strictEqual(C.duracionFrames(r), 540);
});

test('un corte que cruza dos clips recorta el final de uno y el principio del otro', () => {
  const r = C.aplicarCortesFrames(receta(), [{ desde: 280, hasta: 330 }]);
  const cams = r.edit.filter((e) => e.clip === 'cam');
  assert.deepStrictEqual(cams.map((e) => [e.in, e.duration, e.at]),
    [[100, 280, 0], [930, 270, 280]]);
});

test('el audio se parte igual, conserva la ganancia y suaviza los cortes', () => {
  const r = C.aplicarCortesFrames(receta(), [{ desde: 100, hasta: 160 }]);
  const mic = r.edit.filter((e) => e.clip === 'mic');
  assert.strictEqual(mic.length, 2);
  assert.deepStrictEqual(mic.map((e) => [e.in, e.duration, e.at]), [[50, 100, 0], [210, 440, 100]]);
  assert.ok(mic.every((e) => e.gain === 2 && e.audioTrack === 1));
  assert.strictEqual(mic[0].fadeOut, 1);
  assert.strictEqual(mic[1].fadeIn, 1);
});

test('el vídeo no recibe fundidos en los cortes', () => {
  const r = C.aplicarCortesFrames(receta(), [{ desde: 100, hasta: 160 }]);
  assert.ok(r.edit.filter((e) => e.clip === 'cam').every((e) => !e.fadeIn && !e.fadeOut));
});

test('las guías se corren con el montaje', () => {
  const r = C.aplicarCortesFrames(receta(), [{ desde: 100, hasta: 160 }]);
  assert.deepStrictEqual(r.guides.map((g) => g.at), [0, 240, 390]);
});

test('la duración total baja exactamente lo que se quita', () => {
  const antes = C.duracionFrames(receta());
  const r = C.aplicarCortesFrames(receta(), [{ desde: 10, hasta: 40 }, { desde: 200, hasta: 260 }, { desde: 500, hasta: 520 }]);
  assert.strictEqual(C.duracionFrames(r), antes - 30 - 60 - 20);
});

test('tramos solapados se unen y un tramo vacío no hace nada', () => {
  assert.deepStrictEqual(C.unirTramos([{ desde: 5, hasta: 10 }, { desde: 8, hasta: 20 }, { desde: 30, hasta: 30 }]),
    [{ desde: 5, hasta: 20 }]);
  const r = C.aplicarCortesFrames(receta(), []);
  assert.deepStrictEqual(r.edit, receta().edit);
});

test('en segundos usa el origen de la receta', () => {
  const base = receta();
  base.origenReferencia = 100;
  const r = C.aplicarCortes(base, [{ desde: 110, hasta: 112 }]); // t=10 s..12 s → frames 300..360
  const cams = r.edit.filter((e) => e.clip === 'cam');
  assert.deepStrictEqual(cams.map((e) => [e.in, e.duration, e.at]),
    [[100, 300, 0], [960, 240, 300]]);
});

test('unir partes prefija los clips y coloca la segunda a continuación', () => {
  const u = C.unirRecetas([receta(), receta()], 'Episodio');
  assert.deepStrictEqual(u.media.map((m) => m.id), ['p1_cam', 'p1_mic', 'p2_cam', 'p2_mic']);
  const p2 = u.edit.filter((e) => e.clip.startsWith('p2_'));
  assert.deepStrictEqual(p2.map((e) => e.at).sort((a, b) => a - b), [600, 600, 900]);
  assert.strictEqual(u.guides.length, 6);
  assert.strictEqual(u.project.name, 'Episodio');
});

test('unir partes a distinto ritmo da error en vez de desalinear', () => {
  const b = receta();
  b.project.fps = 60;
  assert.throws(() => C.unirRecetas([receta(), b]), /distinto ritmo/);
});

test('mantener plano: la cámara activa sigue y se comen los planos cortos del tramo', () => {
  const r = {
    project: { fps: 30 },
    edit: [
      { clip: 'cam_a', in: 0, duration: 300, at: 0, audio: false },
      { clip: 'cam_b', in: 1000, duration: 50, at: 300, audio: false },
      { clip: 'cam_a', in: 300, duration: 60, at: 350, audio: false },
      { clip: 'cam_b', in: 1110, duration: 200, at: 410, audio: false },
      { clip: 'mic_a', in: 0, duration: 610, at: 0, audioTrack: 1 },
    ],
  };
  const out = C.mantenerPlano(r, 5, 12.5); // frames 150..375
  const video = out.edit.filter((e) => !e.audioTrack);
  assert.deepStrictEqual(video.map((e) => [e.clip, e.in, e.duration, e.at]),
    [['cam_a', 0, 375, 0], ['cam_a', 325, 35, 375], ['cam_b', 1110, 200, 410]]);
  assert.ok(out.edit.some((e) => e.audioTrack === 1 && e.duration === 610), 'el audio no se toca');
});
