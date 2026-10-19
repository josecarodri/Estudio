'use strict';
/*
 * Registro de las páginas (public/js/registro.js): llega al servidor aunque el navegador rechace los envíos
 * «keepalive» (lo que pasó el 2026-10-18 en el PC de JC: 70 minutos sin registro) y un envío colgado no para
 * a los siguientes. Se carga el archivo tal cual, con un navegador y un servidor de mentira y el reloj simulado.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CODIGO = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'registro.js'), 'utf8');

/**
 * `servidor.modo`: 'bien' contesta; 'colgado' no contesta nunca (solo se entera si le cortan).
 * Como Edge aquel día, rechaza al momento toda petición con keepalive.
 */
function cargar() {
  const servidor = { modo: 'bien', recibidos: [], peticiones: [], balizas: [] };
  const fetch = (url, opts) => {
    servidor.peticiones.push(opts);
    if (opts.keepalive) return Promise.reject(new TypeError('Failed to fetch'));
    if (servidor.modo === 'colgado') {
      return new Promise((_, rechazar) => opts.signal?.addEventListener('abort', () => rechazar(new Error('AbortError'))));
    }
    servidor.recibidos.push(...JSON.parse(opts.body).eventos);
    return Promise.resolve({ ok: true, status: 200 });
  };
  const oyentes = {};
  const oir = (donde) => (tipo, fn) => { (oyentes[`${donde}:${tipo}`] ||= []).push(fn); };
  const window = { addEventListener: oir('window') };
  const document = { hidden: false, addEventListener: oir('document') };
  const navigator = {
    userAgent: 'prueba', hardwareConcurrency: 8,
    sendBeacon: (url, blob) => { servidor.balizas.push(blob); return true; },
  };
  vm.runInNewContext(CODIGO, {
    window, document, navigator, fetch, Blob, AbortController, console,
    screen: { width: 1920, height: 1080 }, performance: {},
    // Se llaman en el momento: así usan el reloj simulado de cada prueba.
    setTimeout: (...a) => setTimeout(...a), clearTimeout: (t) => clearTimeout(t), setInterval: (...a) => setInterval(...a),
  });
  const disparar = (clave, e = {}) => (oyentes[clave] || []).forEach((fn) => fn(e));
  return { Registro: window.Registro, servidor, disparar, document };
}

const respirar = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };
async function pasar(t, ms) {
  for (let hecho = 0; hecho < ms; hecho += 1000) { t.mock.timers.tick(1000); await respirar(); }
}
const tipos = (eventos) => eventos.map((e) => e.ev);

test('el registro llega aunque el navegador rechace los envíos keepalive (Edge, 2026-10-18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Registro, servidor } = cargar();
  Registro.iniciar({ room: 'dtp', peer: 'd4cf', nombre: 'JC', latido: () => ({ grabando: 'si', subidas_pendientes: 3 }) });
  await pasar(t, 65000);
  assert.deepStrictEqual(tipos(servidor.recibidos), ['pagina', 'latido', 'latido'], 'cada latido llega en su envío');
  assert.ok(servidor.peticiones.every((o) => !o.keepalive), 'los envíos normales no usan keepalive');
  assert.strictEqual(servidor.recibidos[1].d.registro_cola, 0, 'el latido dice cuánto registro espera para salir');
});

test('un envío colgado se corta y no bloquea los siguientes; queda anotado cuánto duró', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Registro, servidor } = cargar();
  Registro.iniciar({ room: 'dtp', peer: 'd4cf', nombre: 'JC' });
  servidor.modo = 'colgado';
  Registro.anotar('micro', { estado: 'bajo' });
  await pasar(t, 14000);
  assert.strictEqual(servidor.peticiones.length, 1, 'mientras uno espera respuesta no se amontonan más');
  Registro.anotar('ice', { estado: 'connected' });
  await pasar(t, 25000);                                       // a los 15 s se corta; luego otro intento, también colgado
  assert.strictEqual(servidor.peticiones.length, 2);
  servidor.modo = 'bien';
  await pasar(t, 30000);
  const r = servidor.recibidos;
  assert.deepStrictEqual(tipos(r).slice(0, 4), ['pagina', 'micro', 'ice', 'latido'], 'llega todo, en orden y sin repetir');
  const atasco = r.find((e) => e.ev === 'registro-atasco');
  assert.ok(atasco, 'al volver se anota el atasco');
  assert.strictEqual(atasco.d.fallos, 2);
  assert.strictEqual(atasco.d.error, 'sin respuesta en 15 s');
  assert.strictEqual(tipos(r).filter((e) => e === 'micro').length, 1);
});

test('al cerrar la página: una baliza de menos de 64 KiB con lo más antiguo, también lo que estaba en camino', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Registro, servidor, disparar } = cargar();
  Registro.iniciar({ room: 'dtp', peer: 'd4cf', nombre: 'JC' });
  servidor.modo = 'colgado';
  for (let i = 0; i < 400; i += 1) Registro.anotar('latido', { n: i, relleno: 'x'.repeat(150) });
  await pasar(t, 5000);                                        // un envío normal en camino, sin respuesta
  assert.strictEqual(servidor.peticiones.length, 1);
  const enCamino = JSON.parse(servidor.peticiones[0].body).eventos;
  assert.ok(enCamino.length < 200 && enCamino.length > 50, 'los envíos se parten por tamaño');

  disparar('window:pagehide', { persisted: false });
  assert.strictEqual(servidor.balizas.length, 1);
  const baliza = servidor.balizas[0];
  assert.ok(baliza.size < 64 * 1024, `la baliza cabe en lo que admite el navegador (${baliza.size} bytes)`);
  const eventos = JSON.parse(await baliza.text()).eventos;
  assert.deepStrictEqual(eventos[0], enCamino[0], 'empieza por lo que iba en el envío que se pierde al cerrar');
  assert.ok(servidor.peticiones.every((o) => !o.keepalive));
});

test('al ocultarse la pestaña se manda lo pendiente con una baliza, sin repetirlo después', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { Registro, servidor, disparar, document } = cargar();
  Registro.iniciar({ room: 'dtp', peer: 'd4cf', nombre: 'JC' });
  document.hidden = true;
  disparar('document:visibilitychange');
  assert.strictEqual(servidor.balizas.length, 1);
  assert.deepStrictEqual(tipos(JSON.parse(await servidor.balizas[0].text()).eventos), ['pagina', 'visibilidad']);
  await pasar(t, 10000);
  assert.deepStrictEqual(servidor.recibidos, [], 'lo que salió por la baliza no se vuelve a mandar');
});
