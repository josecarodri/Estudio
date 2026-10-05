'use strict';
/*
 * Reconexión de la sala (periodo de gracia) y registro de lo que ocurre.
 * Situación real que motiva esto: un parpadeo de la conexión de una persona colgaba la llamada de
 * las dos, aunque el vídeo y el audio estuvieran bien.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GRABACIONES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
process.env.GRACIA_MS = '500';
process.env.GRACIA_LIMPIA_MS = '100';
const WebSocket = require('ws');
const { onRequest, attachSignaling } = require('../server');
const { formato, valor } = require('../lib/log');

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

function listen() {
  return new Promise((resolve) => {
    const s = http.createServer(onRequest);
    attachSignaling(s);
    s.listen(0, () => resolve(s));
  });
}

/** Cliente de la sala que acumula eventos y permite cortar la conexión «a lo bruto» (sin cierre limpio). */
function cliente(base, ruta) {
  const events = [];
  const waiters = [];
  const ws = new WebSocket(base.replace('http', 'ws') + ruta);
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    events.push({ event: m.event, data: m.data });
    waiters.splice(0).forEach((w) => w());
  });
  const cerrado = new Promise((r) => ws.on('close', (code) => r(code)));
  const next = async (name, ms = 3000) => {
    const limite = Date.now() + ms;
    for (;;) {
      const idx = events.findIndex((e) => e.event === name);
      if (idx >= 0) return events.splice(idx, 1)[0].data;
      const resto = limite - Date.now();
      if (resto <= 0) throw new Error(`no llegó el evento ${name}`);
      await Promise.race([new Promise((r) => waiters.push(r)), esperar(resto)]);
    }
  };
  const hay = (name) => events.some((e) => e.event === name);
  return { next, hay, cerrado, close: () => ws.close(), caida: () => ws.terminate() };
}

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

async function sala(base, nombre) {
  const a = cliente(base, `/api/rooms/${nombre}/ws?peer=aaa&name=Ana&device=PC`);
  await a.next('welcome');
  const b = cliente(base, `/api/rooms/${nombre}/ws?peer=bbb&name=Beto&device=iPad`);
  await b.next('welcome');
  await a.next('peer-joined');
  return { a, b };
}

test('una caída de la conexión avisa de la ausencia, pero NO cuelga la llamada si la persona vuelve', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'vuelve');
    b.caida();
    const away = await a.next('peer-away');
    assert.strictEqual(away.id, 'bbb');
    assert.strictEqual(away.graciaMs, 500);
    assert.ok(!a.hay('peer-left'), 'no se debe dar por salida al instante');

    // Vuelve dentro del plazo con el mismo identificador (misma página).
    const b2 = cliente(base, '/api/rooms/vuelve/ws?peer=bbb&name=Beto&device=iPad');
    const w = await b2.next('welcome');
    assert.strictEqual(w.peers[0].id, 'aaa');
    assert.strictEqual(w.volvio, true, 'quien vuelve recibe la confirmación de que lo hizo dentro del plazo');
    const j = await a.next('peer-joined');
    assert.strictEqual(j.id, 'bbb');
    assert.strictEqual(j.volvio, true, 'se indica que es una reconexión, no una persona nueva');

    await esperar(800);   // pasa de largo el plazo de gracia
    assert.ok(!a.hay('peer-left'), 'al volver, el temporizador de salida queda anulado');
    a.close(); b2.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('si no vuelve a tiempo, se da por salida', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'noVuelve');
    b.caida();
    await a.next('peer-away');
    const t0 = Date.now();
    const left = await a.next('peer-left');
    assert.strictEqual(left.id, 'bbb');
    assert.ok(Date.now() - t0 >= 400, 'respeta el plazo de gracia');
    a.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('un cierre limpio (a propósito) sigue siendo una salida inmediata, sin periodo de gracia', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'limpio');
    b.close();
    assert.strictEqual((await a.next('peer-left')).id, 'bbb');
    assert.ok(!a.hay('peer-away'));
    a.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('quien recarga la página (otro identificador) no choca con su propio sitio ocupado por la caída', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'recarga');
    b.caida();
    await a.next('peer-away');
    // La sala tiene 2 sitios: el de Beto sigue ocupado por su ausencia. Llega Beto con otra página.
    const b2 = cliente(base, '/api/rooms/recarga/ws?peer=ccc&name=Beto&device=iPad');
    const w = await b2.next('welcome');
    assert.ok(Array.isArray(w.peers), 'entra: no recibe «sala llena»');
    assert.ok(!w.volvio, 'es una página nueva, no una reconexión');
    assert.strictEqual((await a.next('peer-left')).id, 'bbb', 'el sitio de la página anterior se libera');
    const j = await a.next('peer-joined');
    assert.strictEqual(j.id, 'ccc');
    assert.ok(!j.volvio, 'es una página nueva: la llamada hay que montarla de nuevo');
    a.close(); b2.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('una tercera persona distinta sí encuentra la sala llena aunque una esté ausente: se libera solo el sitio ausente', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'tercera');
    b.caida();
    await a.next('peer-away');
    const c = cliente(base, '/api/rooms/tercera/ws?peer=ccc&name=Carla&device=PC');
    await c.next('welcome');           // el sitio del ausente se cede
    assert.strictEqual((await a.next('peer-left')).id, 'bbb');
    // Ahora la sala está completa de verdad (Ana y Carla): un cuarto no entra.
    const d = cliente(base, '/api/rooms/tercera/ws?peer=ddd&name=Dani');
    assert.match((await d.next('room-full')).error, /llena/);
    a.close(); c.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('una señal a una persona ausente no falla: se anota que no se entregó', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'senal');
    b.caida();
    await a.next('peer-away');
    const r = await post(base, '/api/rooms/senal/signal', { from: 'aaa', to: 'bbb', data: { x: 1 } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.entregado, false);
    a.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('el registro anota la caída, la espera y la vuelta, con quién y cuándo', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { a, b } = await sala(base, 'registro');
    b.caida();
    await a.next('peer-away');
    const b2 = cliente(base, '/api/rooms/registro/ws?peer=bbb&name=Beto&device=iPad');
    await b2.next('welcome');
    await a.next('peer-joined');
    const archivos = fs.readdirSync(process.env.LOGS_DIR).filter((f) => /^estudio-\d{4}-\d{2}-\d{2}\.log$/.test(f));
    assert.strictEqual(archivos.length, 1, 'un archivo por día');
    const texto = fs.readFileSync(path.join(process.env.LOGS_DIR, archivos[0]), 'utf8');
    assert.match(texto, /\d{2}:\d{2}:\d{2}\.\d{3} servidor ws-abierto sala=registro peer=bbb nombre=Beto/);
    assert.match(texto, /servidor ws-cerrado sala=registro peer=bbb nombre=Beto codigo=1006/);
    assert.match(texto, /servidor peer-ausente sala=registro peer=bbb nombre=Beto gracia_s=0\.5/);
    assert.match(texto, /servidor ws-reconectado sala=registro peer=bbb nombre=Beto ausente_s=/);
    a.close(); b2.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('las páginas envían su registro (latidos, errores) y queda junto al del servidor', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await post(base, '/api/rooms/clilog/log', {
      peer: 'aaa', nombre: 'JC',
      eventos: [
        { ev: 'latido', hora: '21:36:41', d: { rec: true, memoria_mb: 212, pc: 'connected', 'clave mala!': 'x', objeto: { no: 1 } } },
        { ev: 'error', hora: '21:36:50', d: { mensaje: 'algo falló con espacios' } },
        'basura',
      ],
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.n, 3);
    const texto = fs.readFileSync(fs.readdirSync(process.env.LOGS_DIR).map((f) => path.join(process.env.LOGS_DIR, f)).find((f) => /estudio-/.test(f)), 'utf8');
    assert.match(texto, /cliente:jc latido peer=aaa hora_cliente=21:36:41 rec=si memoria_mb=212 pc=connected\n/);
    assert.match(texto, /cliente:jc error peer=aaa hora_cliente=21:36:50 mensaje="algo falló con espacios"/);
    assert.ok(!/clave mala|objeto/.test(texto), 'se descartan claves raras y valores que no son simples');
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('formato del registro: líneas legibles y sin saltos', () => {
  assert.strictEqual(formato({ a: 1, b: 2.456, c: true, d: 'dos palabras', e: undefined, f: '' }), 'a=1 b=2.5 c=si d="dos palabras"');
  assert.strictEqual(valor('línea\nsiguiente'), '"línea siguiente"');
  assert.strictEqual(valor('x'.repeat(500)).length, 200);
});
