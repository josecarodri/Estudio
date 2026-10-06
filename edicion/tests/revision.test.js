'use strict';
/*
 * Vídeo de revisión: qué trozos salen (principio, empalmes, uniones de partes y final), cómo se
 * juntan los que se tocan y que los silencios solo salen si se piden.
 */
const test = require('node:test');
const assert = require('node:assert');
const RV = require('../revision.js');

const FPS = 25;
const s = (seg) => seg * FPS;
/** Montaje de 10 min con guías de cortes («✂ motivo (−N s)»), de quién habla y de marcas, y una parte 2. */
function montaje() {
  return {
    project: { fps: FPS },
    edit: [
      { clip: 'p1_cam_dj', at: 0, duration: s(300) },
      { clip: 'p2_cam_dj', at: s(300), duration: s(300) },
      { clip: 'p1_mic_dj', at: 0, duration: s(300), audioTrack: 1 },
      { clip: 'p2_mic_dj', at: s(300), duration: s(300), audioTrack: 1 },
    ],
    guides: [
      { at: s(5), name: 'dj', color: 'Blue' },
      { at: s(60), name: '✂ silencio (−4,2 s)', color: 'Purple' },
      { at: s(120), name: '✂ texto «lo cortamos» → «bueno» (−12 s)', color: 'Purple' },
      { at: s(125), name: '✂ 1.2 ✂ en vivo: marcado por JC (−30 s)', color: 'Purple' },
      { at: s(200), name: '★ DJ', color: 'Green' },
      { at: s(590), name: '✂ silencio (−5 s)', color: 'Purple' },
    ],
  };
}

test('revisión: principio, empalmes (sin silencios), unión de partes y final; los que se tocan van juntos', () => {
  const plan = RV.trozosDeRevision(montaje());
  assert.deepStrictEqual(plan.trozos.map((t) => [t.n, t.desde / FPS, t.hasta / FPS, t.textos]), [
    [1, 0, 10, ['principio del episodio']],
    [2, 116, 129, ['corte: texto «lo cortamos» → «bueno» (−12 s)', 'corte: 1.2 ✂ en vivo: marcado por JC (−30 s)']],
    [3, 296, 304, ['empieza la parte 2']],
    [4, 588, 600, ['final del episodio']],
  ]);
  assert.deepStrictEqual(plan.trozos[1].empalmes, [s(120), s(125)]);
  assert.deepStrictEqual([plan.silenciosFuera, plan.segundosFuera], [2, 9.2]);
});

test('revisión: con --silencios salen también los silencios (el del final se junta con el final)', () => {
  const plan = RV.trozosDeRevision(montaje(), { silencios: true });
  assert.strictEqual(plan.silenciosFuera, 0);
  assert.deepStrictEqual(plan.trozos.map((t) => t.textos.join(' + ')), [
    'principio del episodio',
    'corte: silencio (−4,2 s)',
    'corte: texto «lo cortamos» → «bueno» (−12 s) + corte: 1.2 ✂ en vivo: marcado por JC (−30 s)',
    'empieza la parte 2',
    'corte: silencio (−5 s) + final del episodio',
  ]);
});

test('revisión: el rótulo lleva número, minuto del empalme y motivo, sin símbolos que la fuente quizá no tenga', () => {
  const plan = RV.trozosDeRevision(montaje());
  assert.strictEqual(RV.etiqueta(plan.trozos[1], FPS), '2 · 2:00 · corte: texto «lo cortamos» → «bueno» (−12 s) + corte: 1.2 en vivo: marcado por JC (−30 s)'.slice(0, 89) + '…');
  assert.strictEqual(RV.etiqueta(plan.trozos[0], FPS), '1 · 0:00 · principio del episodio');
});

test('revisión: un montaje corto es un solo trozo, de principio a fin', () => {
  const corto = { project: { fps: FPS }, edit: [{ clip: 'cam_dj', at: 0, duration: s(15) }], guides: [] };
  assert.deepStrictEqual(RV.trozosDeRevision(corto).trozos.map((t) => [t.desde, t.hasta, t.textos]), [[0, s(15), ['principio del episodio', 'final del episodio']]]);
});
