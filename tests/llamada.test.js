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

test('al entrar con una grabación en curso: se retoma si venimos de una caída, y si no, se une igualmente', () => {
  const enCurso = { id: 's1', recording: true };
  const parada = { id: 's1', recording: false };
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabando: false, sesion: enCurso }), 'retomar');
  // Antes esto era «empezará con la próxima» y esa persona no grababa nada en toda la sesión. En un estudio
  // de dos, quien entra con la grabación en marcha es uno de los dos: perder sus pistas es lo peor que puede pasar.
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: false, grabando: false, sesion: enCurso }), 'unirse');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabando: false, sesion: parada }), 'terminada');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: false, grabando: false, sesion: parada }), 'nada');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: false, grabando: false, sesion: null }), 'nada');
  assert.strictEqual(L.alRecibirGrabacion({ recuperando: true, grabando: true, miSesion: 's1', sesion: enCurso }), 'nada',
    'una segunda bienvenida (reconexión de la sala) no debe arrancar una segunda grabación');
});

test('quien sigue grabando una sesión que ya se paró, para; si hay otra nueva en marcha, se pasa a ella', () => {
  assert.strictEqual(L.alRecibirGrabacion({ grabando: true, miSesion: 's1', sesion: { id: 's1', recording: false } }), 'parar');
  assert.strictEqual(L.alRecibirGrabacion({ grabando: true, miSesion: 's1', sesion: { id: 's2', recording: true } }), 'cambiar');
  assert.strictEqual(L.alRecibirGrabacion({ grabando: true, miSesion: 's1', sesion: { id: 's2', recording: false } }), 'parar');
  assert.strictEqual(L.alRecibirGrabacion({ grabando: true, miSesion: 's1', sesion: null }), 'nada',
    'si el servidor no sabe de ninguna grabación (se reinició), se sigue grabando: lo grabado está a salvo en el dispositivo');
});

test('la comprobación periódica deja tiempo a la orden normal (con su cuenta atrás y su pitido)', () => {
  const sesion = { id: 's1', recording: true, startAt: 10_000, stopAt: 50_000 };
  assert.strictEqual(L.esPronto({ accion: 'unirse', sesion, ahora: 9_000 }), true, 'aún no ha empezado');
  assert.strictEqual(L.esPronto({ accion: 'unirse', sesion, ahora: 11_000 }), true, 'la orden puede ir de camino');
  assert.strictEqual(L.esPronto({ accion: 'unirse', sesion, ahora: 12_500 }), false);
  assert.strictEqual(L.esPronto({ accion: 'parar', sesion, ahora: 51_000 }), true);
  assert.strictEqual(L.esPronto({ accion: 'parar', sesion, ahora: 52_500 }), false);
});

test('indicador de la otra persona: graba, o NO graba pasados unos segundos (no durante la cuenta atrás)', () => {
  assert.strictEqual(L.estadoDelOtro({ hayOtro: true, yoGrabo: true, otroGraba: true, msGrabando: 100 }), 'graba');
  assert.strictEqual(L.estadoDelOtro({ hayOtro: true, yoGrabo: true, otroGraba: false, msGrabando: 1000 }), null);
  assert.strictEqual(L.estadoDelOtro({ hayOtro: true, yoGrabo: true, otroGraba: false, msGrabando: 6000 }), 'no-graba');
  assert.strictEqual(L.estadoDelOtro({ hayOtro: true, yoGrabo: false, otroGraba: false, msGrabando: 0 }), null);
  assert.strictEqual(L.estadoDelOtro({ hayOtro: false, yoGrabo: true, otroGraba: false, msGrabando: 9000 }), null);
  assert.strictEqual(L.estadoDelOtro({ hayOtro: true, yoGrabo: true, otroGraba: undefined, msGrabando: 9000 }), null,
    'sin noticias de la otra página (versión antigua) no se avisa');
});

test('marcas en vivo: avisos de ★ y de ✂ (abierto por mí o por el otro, cerrado con su duración)', () => {
  assert.deepStrictEqual(L.avisoDeMarca({ tipo: 'bueno', nombre: 'DJ' }, { propia: true }), { texto: '★ Buen momento marcado', tipo: '' });
  assert.strictEqual(L.avisoDeMarca({ tipo: 'bueno', nombre: 'DJ' }, { propia: false }).texto, '★ DJ marcó un buen momento');
  const abierto = { tipo: 'corte', nombre: 'JC', inicio: 1000, fin: null };
  assert.strictEqual(L.avisoDeMarca(abierto, { propia: true }).texto, '✂ Tramo para cortar: pulsa ✂ cuando acabe');
  assert.strictEqual(L.avisoDeMarca(abierto, { propia: false }).texto, '✂ JC abrió un tramo para cortar: pulsa ✂ cuando acabe');
  assert.strictEqual(L.avisoDeMarca(abierto, { propia: false }).tipo, 'warn');
  assert.strictEqual(L.avisoDeMarca({ ...abierto, fin: 36400 }, { propia: false }).texto, '✂ Tramo para cortar cerrado (35 s)');
  assert.strictEqual(L.avisoDeMarca(null), null);
  assert.strictEqual(L.avisoDeMarca({ tipo: 'otra' }), null);
});

test('marcas en vivo: el botón ✂ dice si hay un tramo abierto y cuánto lleva', () => {
  assert.strictEqual(L.textoBotonCorte(null, 5000), '✂ Cortar');
  assert.strictEqual(L.textoBotonCorte({ inicio: 10_000, nombre: 'JC' }, 75_500), '✂ Cerrar corte 1:05');
  assert.strictEqual(L.textoBotonCorte({ inicio: 10_000, nombre: 'JC' }, 9_000), '✂ Cerrar corte 0:00', 'un reloj algo adelantado no da negativos');
});
