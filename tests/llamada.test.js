'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../public/js/llamada.js');

test('la llamada se considera viva salvo que haya fallado o se haya cerrado', () => {
  for (const e of ['new', 'connecting', 'connected', 'disconnected']) assert.strictEqual(L.viva(e), true, e);
  for (const e of ['failed', 'closed', undefined, null]) assert.strictEqual(L.viva(e), false, String(e));
});

test('quien se quedó: si la misma página reconecta y la llamada sigue viva, se mantiene (sin congelar la imagen)', () => {
  assert.strictEqual(L.alEntrarOtro({ volvio: true, mismoRemoto: true, estadoPc: 'connected' }), 'mantener');
  assert.strictEqual(L.alEntrarOtro({ volvio: true, mismoRemoto: true, estadoPc: 'disconnected' }), 'mantener');
});

test('quien se quedó: se rehace si la llamada murió, si es una página nueva o si no era la misma persona', () => {
  assert.strictEqual(L.alEntrarOtro({ volvio: true, mismoRemoto: true, estadoPc: 'failed' }), 'rehacer-respondiendo');
  assert.strictEqual(L.alEntrarOtro({ volvio: false, mismoRemoto: false, estadoPc: 'connected' }), 'rehacer-respondiendo', 'página nueva (recargó)');
  assert.strictEqual(L.alEntrarOtro({ volvio: true, mismoRemoto: false, estadoPc: 'connected' }), 'rehacer-respondiendo');
  assert.strictEqual(L.alEntrarOtro({ volvio: true, mismoRemoto: true, estadoPc: undefined }), 'rehacer-respondiendo');
});

test('quien se cayó y vuelve: mantiene su llamada solo si volvió DENTRO del plazo y sigue viva; si no, la ofrece de nuevo', () => {
  assert.strictEqual(L.alVolver({ volvio: true, mismoRemoto: true, estadoPc: 'connected' }), 'mantener');
  assert.strictEqual(L.alVolver({ volvio: true, mismoRemoto: true, estadoPc: 'failed' }), 'rehacer-ofreciendo');
  assert.strictEqual(L.alVolver({ volvio: true, mismoRemoto: false, estadoPc: 'connected' }), 'rehacer-ofreciendo');
  assert.strictEqual(L.alVolver({ volvio: false, mismoRemoto: true, estadoPc: 'connected' }), 'rehacer-ofreciendo',
    'pasó el plazo: la otra persona ya colgó, aunque mi conexión parezca viva');
  assert.strictEqual(L.alVolver({ volvio: false, mismoRemoto: false, estadoPc: undefined }), 'rehacer-ofreciendo', 'primera vez que entra');
});

test('una oferta de otra conexión se reconoce; los mensajes sueltos de una llamada anterior se ignoran', () => {
  assert.strictEqual(L.ofertaNueva({ cidActual: 'a1', cidMensaje: 'b2' }), true);
  assert.strictEqual(L.ofertaNueva({ cidActual: 'a1', cidMensaje: 'a1' }), false, 'renegociación de la misma llamada');
  assert.strictEqual(L.ofertaNueva({ cidActual: null, cidMensaje: 'b2' }), false, 'primera oferta');
  assert.strictEqual(L.ofertaNueva({ cidActual: 'a1', cidMensaje: undefined }), false, 'cliente antiguo sin identificador');
  assert.strictEqual(L.esDeLlamadaAnterior({ cidActual: 'b2', cidMensaje: 'a1', esOferta: false }), true);
  assert.strictEqual(L.esDeLlamadaAnterior({ cidActual: 'b2', cidMensaje: 'a1', esOferta: true }), false);
  assert.strictEqual(L.esDeLlamadaAnterior({ cidActual: 'b2', cidMensaje: undefined, esOferta: false }), false);
});

test('si las dos llamadas están muertas, ofrece solo una persona (la de identificador mayor): sin choques', () => {
  assert.strictEqual(L.ofreceYo('bbb', 'aaa'), true);
  assert.strictEqual(L.ofreceYo('aaa', 'bbb'), false);
  assert.strictEqual(L.alPedirReinicio({ yoTambienRehago: false, miId: 'aaa', otroId: 'bbb' }), 'ofrecer');
  assert.strictEqual(L.alPedirReinicio({ yoTambienRehago: true, miId: 'bbb', otroId: 'aaa' }), 'ofrecer');
  assert.strictEqual(L.alPedirReinicio({ yoTambienRehago: true, miId: 'aaa', otroId: 'bbb' }), 'esperar');
  // Exactamente una de las dos ofrece
  const a = L.alPedirReinicio({ yoTambienRehago: true, miId: 'aaa', otroId: 'bbb' });
  const b = L.alPedirReinicio({ yoTambienRehago: true, miId: 'bbb', otroId: 'aaa' });
  assert.deepStrictEqual([a, b].sort(), ['esperar', 'ofrecer']);
});

test('recuperación: la marca solo vale si es de una grabación en curso, completa y reciente', () => {
  const ahora = 1_000_000;
  const ok = { grabando: true, sala: 'dtp', nombre: 'JC', ts: ahora - 20_000 };
  assert.deepStrictEqual(L.recuperacionVigente(ok, ahora, 900_000), { ...ok, segundos: 20 });
  assert.strictEqual(L.recuperacionVigente(null, ahora, 900_000), null);
  assert.strictEqual(L.recuperacionVigente({ ...ok, grabando: false }, ahora, 900_000), null, 'paró a propósito');
  assert.strictEqual(L.recuperacionVigente({ ...ok, ts: ahora - 901_000 }, ahora, 900_000), null, 'demasiado antigua');
  assert.strictEqual(L.recuperacionVigente({ ...ok, ts: ahora + 5000 }, ahora, 900_000), null, 'hora imposible');
  assert.strictEqual(L.recuperacionVigente({ ...ok, sala: '' }, ahora, 900_000), null, 'marca incompleta');
});

test('al entrar con una grabación en curso: solo se retoma si venimos de una caída', () => {
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabandoYa: false, sesionEnCurso: true }), 'retomar');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: false, grabandoYa: false, sesionEnCurso: true }), 'avisar',
    'quien entra normal no empieza a grabar sin que se lo pidan');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabandoYa: false, sesionEnCurso: false }), 'terminada');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: false, grabandoYa: false, sesionEnCurso: false }), 'nada');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabandoYa: true, sesionEnCurso: true }), 'nada',
    'una segunda bienvenida (reconexión de la sala) no debe arrancar una segunda grabación');
});
