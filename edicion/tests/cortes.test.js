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

// ------------------------------------------------------------------ saltos de imagen en los cortes

/*
 * Receta sin cortar a 25 fps: dj y jc se turnan; cada cámara va en sincronía (in = at + su desfase:
 * 100 la de dj, 50 la de jc) y los micros son continuos.
 */
function conversacion(planos) {
  const desfase = { cam_dj: 100, cam_jc: 50, 'cam_jc-2': -400 };
  const fin = Math.max(...planos.map(([, , b]) => b));
  return {
    project: { name: 'x', fps: 25, width: 1920, height: 1080 },
    media: [{ id: 'cam_dj', path: 'dj.mp4' }, { id: 'cam_jc', path: 'jc.mp4' }, { id: 'mic_dj', path: 'dj.wav' }, { id: 'mic_jc', path: 'jc.wav' }],
    tracks: { video: 1, audio: 2 },
    edit: [
      ...planos.map(([clip, a, b]) => ({ clip, in: a + desfase[clip], duration: b - a, at: a, audio: false, rgb: { r: 1.1 } })),
      { clip: 'mic_dj', in: 7, duration: fin, at: 0, audioTrack: 1 },
      { clip: 'mic_jc', in: 9, duration: fin, at: 0, audioTrack: 2 },
    ],
  };
}
const TURNOS = [['cam_dj', 0, 250], ['cam_jc', 250, 500], ['cam_dj', 500, 1000], ['cam_jc', 1000, 1250]];
const vistos = (r) => r.edit.filter((e) => !e.audioTrack).sort((a, b) => a.at - b.at).map((e) => [e.clip, e.at, e.at + e.duration, e.in - e.at]);
const seg = (f) => f / 25;

test('saltos: si a los dos lados de un corte se ve a la misma persona, se pone al otro 1,5 s justo después', () => {
  const r = C.disimularSaltos(conversacion(TURNOS), [{ desde: seg(600), hasta: seg(700) }]);
  assert.strictEqual(r.disimulados, 1);
  assert.deepStrictEqual(vistos(r.receta), [
    ['cam_dj', 0, 250, 100], ['cam_jc', 250, 500, 50], ['cam_dj', 500, 700, 100],
    ['cam_jc', 700, 738, 50],                       // jc escuchando, en sincronía
    ['cam_dj', 738, 1000, 100], ['cam_jc', 1000, 1250, 50],
  ]);
  // El audio no se toca y el plano del otro conserva su color.
  assert.deepStrictEqual(r.receta.edit.filter((e) => e.audioTrack), conversacion(TURNOS).edit.filter((e) => e.audioTrack));
  assert.deepStrictEqual(r.receta.edit.find((e) => e.at === 700).rgb, { r: 1.1 });
  // Y tras cortar, a un lado del empalme se ve a dj y al otro a jc.
  const cortada = C.aplicarCortes(r.receta, [{ desde: seg(600), hasta: seg(700) }]);
  assert.deepStrictEqual(vistos(cortada).filter((v) => v[1] <= 600 && v[2] >= 600).map((v) => v[0]), ['cam_dj', 'cam_jc']);
});

test('saltos: un corte que ya cambia de persona no se toca', () => {
  const r = C.disimularSaltos(conversacion(TURNOS), [{ desde: seg(450), hasta: seg(550) }]);
  assert.strictEqual(r.disimulados + r.absorbidos, 0);
  assert.deepStrictEqual(vistos(r.receta), vistos(conversacion(TURNOS)));
});

test('saltos: un plano que tras el corte quedaría en un destello se absorbe en el de al lado', () => {
  // Antes del corte solo quedarían 5 frames de dj (500-505): se los queda jc, que va justo antes.
  const cola = C.disimularSaltos(conversacion(TURNOS), [{ desde: seg(505), hasta: seg(600) }]);
  assert.deepStrictEqual([cola.absorbidos, cola.disimulados], [1, 0]);
  assert.deepStrictEqual(vistos(cola.receta).slice(1, 3), [['cam_jc', 250, 505, 50], ['cam_dj', 505, 1000, 100]]);
  // Después del corte quedarían 5 frames de dj (245-250): se los queda jc, que va justo después.
  const cabeza = C.disimularSaltos(conversacion(TURNOS), [{ desde: seg(100), hasta: seg(245) }]);
  assert.deepStrictEqual([cabeza.absorbidos, cabeza.disimulados], [1, 0]);
  assert.deepStrictEqual(vistos(cabeza.receta).slice(0, 2), [['cam_dj', 0, 245, 100], ['cam_jc', 245, 500, 50]]);
});

test('saltos: si al plano del otro le seguiría un destello de quien habla, el del otro llega hasta su siguiente plano', () => {
  const planos = [['cam_dj', 0, 250], ['cam_jc', 250, 500], ['cam_dj', 500, 750], ['cam_jc', 750, 1250]];
  const r = C.disimularSaltos(conversacion(planos), [{ desde: seg(600), hasta: seg(700) }]);
  assert.strictEqual(r.disimulados, 1);
  assert.deepStrictEqual(vistos(r.receta).slice(2), [['cam_dj', 500, 700, 100], ['cam_jc', 700, 1250, 50]]);
});

test('saltos: el principio de una parte es una unión con la anterior (también si empieza con un corte)', () => {
  const r = C.disimularSaltos(conversacion(TURNOS), [], { personaAntes: 'dj' });
  assert.deepStrictEqual(vistos(r.receta).slice(0, 2), [['cam_jc', 0, 38, 50], ['cam_dj', 38, 250, 100]]);
  const conCorte = C.disimularSaltos(conversacion(TURNOS), [{ desde: 0, hasta: seg(100) }], { personaAntes: 'dj' });
  assert.deepStrictEqual(vistos(conCorte.receta).slice(0, 3), [['cam_dj', 0, 100, 100], ['cam_jc', 100, 138, 50], ['cam_dj', 138, 250, 100]]);
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), [], { personaAntes: 'jc' }).disimulados, 0);
});

test('saltos: no se toca un plano fijado a mano ni se usa una cámara sin imagen en ese momento', () => {
  const corte = [{ desde: seg(600), hasta: seg(700) }];
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), corte, { fijos: [[20, 30]] }).disimulados, 0);
  // La cámara de jc solo tiene 600 frames: a la altura del corte (frame 750 de su archivo) ya no hay imagen.
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), corte, { fotogramas: { cam_jc: 600 } }).disimulados, 0);
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), corte, { fotogramas: { cam_jc: 5000 } }).disimulados, 1);
});

test('saltos: jc y su tramo retomado (jc-2) son la misma persona', () => {
  const planos = [['cam_jc', 0, 500], ['cam_dj', 500, 600], ['cam_jc-2', 600, 1000]];
  const r = C.disimularSaltos(conversacion(planos), [{ desde: seg(400), hasta: seg(650) }], { fotogramas: { cam_dj: 5000 } });
  assert.strictEqual(r.disimulados, 1);
  // Lo de 600 a 650 cae dentro del corte; tras él (650) se ve a dj 1,5 s y vuelve jc-2.
  assert.deepStrictEqual(vistos(r.receta).slice(1), [['cam_dj', 500, 600, 100], ['cam_jc-2', 600, 650, -400], ['cam_dj', 650, 688, 100], ['cam_jc-2', 688, 1000, -400]]);
  assert.strictEqual(C.personaDeClip('p2_cam_jc-2'), 'jc');
  assert.strictEqual(C.personaAlFinal(r.receta), 'jc');
});

test('guías de los cortes: una por empalme, con su motivo y lo que se quita; se mueven a su sitio al cortar', () => {
  const r = conversacion(TURNOS);
  const guias = C.guiasDeCortes(r, [
    { desde: seg(600), hasta: seg(700), motivo: 'silencio' },
    { desde: seg(650), hasta: seg(800), motivo: '1.2 ✂ en vivo: marcado por JC' },
    { desde: seg(100), hasta: seg(130), motivo: 'silencio' },
  ]);
  assert.deepStrictEqual(guias, [
    { at: 100, name: '✂ silencio (−1,2 s)', color: 'Purple' },
    { at: 600, name: '✂ silencio + 1.2 ✂ en vivo: marcado por JC (−8 s)', color: 'Purple' },
  ]);
  assert.deepStrictEqual(C.leerGuiaDeCorte(guias[1]), { motivo: 'silencio + 1.2 ✂ en vivo: marcado por JC', segundos: 8 });
  assert.strictEqual(C.leerGuiaDeCorte({ name: '★ DJ' }), null);
  const cortada = C.aplicarCortes({ ...r, guides: guias }, [{ desde: seg(100), hasta: seg(130) }, { desde: seg(600), hasta: seg(800) }]);
  assert.deepStrictEqual(cortada.guides.map((g) => g.at), [100, 570], 'cada guía queda en su empalme');
});
