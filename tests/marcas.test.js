'use strict';
/*
 * Marcas en vivo: «✂ cortar» (un tramo que se abre y se cierra) y «★ bueno» (un instante), puestas
 * mientras se graba. Quedan en session.json con la hora del servidor para que el editor las use.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GRABACIONES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
process.env.LOGS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-'));
const WebSocket = require('ws');
const { onRequest, attachSignaling } = require('../server');

function listen() {
  return new Promise((resolve) => {
    const s = http.createServer(onRequest);
    attachSignaling(s);
    s.listen(0, () => resolve(s));
  });
}

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  .then(async (r) => ({ status: r.status, json: await r.json() }));

const abiertas = new Set();
test.after(() => { for (const ws of abiertas) ws.terminate(); });

/** Entra en la sala y devuelve el WebSocket y los eventos que va recibiendo. */
async function entrar(base, sala, peer, nombre) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${sala}/ws?peer=${peer}&name=${nombre}&device=PC`);
  abiertas.add(ws);
  const eventos = [];
  ws.on('message', (m) => eventos.push(JSON.parse(m)));
  await new Promise((r) => ws.on('open', r));
  return { ws, eventos };
}

const leerSesion = (sala, id) => JSON.parse(fs.readFileSync(path.join(process.env.GRABACIONES_DIR, sala, id, 'session.json'), 'utf8'));
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

test('marcas: ★ es un instante; ✂ se abre y se cierra (lo puede cerrar el otro) y queda en session.json', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const jc = await entrar(base, 'm1', 'aaa', 'JC');
    const dj = await entrar(base, 'm1', 'bbb', 'DJ');
    const inicio = await post(base, '/api/rooms/m1/record', { action: 'start', from: 'aaa' });
    const id = inicio.json.id;
    // Al registrar sus pistas, cada persona recibe su etiqueta (jc, dj) para los nombres de archivo.
    for (const [peer, name] of [['aaa', 'JC'], ['bbb', 'DJ']]) {
      await post(base, '/api/tracks', { room: 'm1', session: id, participant: peer, name, kind: 'audio', format: 'wav', mime: 'audio/wav', sampleRate: 48000, channels: 1 });
    }
    // Horas de las marcas: las de ahora mismo (el servidor no acepta horas de más de 5 s en el futuro).
    const t0 = Math.round(Date.now()) - 2000;

    const bueno = await post(base, '/api/rooms/m1/marca', { tipo: 'bueno', from: 'bbb', hora: t0 + 1000 });
    assert.strictEqual(bueno.status, 200);
    assert.deepStrictEqual(bueno.json.marca, { tipo: 'bueno', hora: t0 + 1000, nombre: 'DJ', persona: 'dj' });

    const abre = await post(base, '/api/rooms/m1/marca', { tipo: 'corte', accion: 'abrir', from: 'aaa', hora: t0 + 1500 });
    assert.deepStrictEqual(abre.json.session.corteAbierto, { inicio: t0 + 1500, nombre: 'JC' });
    // Si los dos pulsan «abrir» a la vez no se abre otro (ni se cierra el primero).
    const otraVez = await post(base, '/api/rooms/m1/marca', { tipo: 'corte', accion: 'abrir', from: 'bbb', hora: t0 + 1600 });
    assert.deepStrictEqual(otraVez.json.session.corteAbierto, { inicio: t0 + 1500, nombre: 'JC' });
    // La consulta del estado de la sala lo dice (así lo ve una página que se perdió el aviso).
    const estado = await fetch(`${base}/api/rooms/m1/sesion`).then((r) => r.json());
    assert.strictEqual(estado.session.corteAbierto.nombre, 'JC');

    const cierra = await post(base, '/api/rooms/m1/marca', { tipo: 'corte', accion: 'cerrar', from: 'bbb', hora: t0 + 4000 });
    assert.strictEqual(cierra.json.session.corteAbierto, null);
    assert.deepStrictEqual(cierra.json.marca, { tipo: 'corte', inicio: t0 + 1500, fin: t0 + 4000, nombre: 'JC', persona: 'jc', cierra: 'DJ' });
    // Cerrar lo que ya está cerrado no hace nada.
    const nada = await post(base, '/api/rooms/m1/marca', { tipo: 'corte', accion: 'cerrar', from: 'aaa', hora: t0 + 4500 });
    assert.strictEqual(nada.status, 200);
    assert.strictEqual(nada.json.marca, undefined);

    // Las dos páginas reciben cada marca.
    await esperar(100);
    for (const p of [jc, dj]) {
      const marcas = p.eventos.filter((e) => e.event === 'marca');
      assert.strictEqual(marcas.length, 3, 'bueno, abrir y cerrar');
      assert.strictEqual(marcas[0].data.de, 'bbb');
    }

    // Un tramo que nadie cerró termina con la grabación.
    await post(base, '/api/rooms/m1/marca', { tipo: 'corte', accion: 'abrir', from: 'aaa', hora: t0 + 5000 });
    const fin = await post(base, '/api/rooms/m1/record', { action: 'stop', from: 'aaa' });
    assert.strictEqual(fin.json.corteAbierto, null);
    const s = leerSesion('m1', id);
    assert.strictEqual(s.marcas.length, 3);
    assert.deepStrictEqual(s.marcas[2], { tipo: 'corte', inicio: t0 + 5000, fin: s.stopAt, nombre: 'JC', persona: 'jc', cerradoAlParar: true });

    // Sin grabación en marcha no se marca.
    const tarde = await post(base, '/api/rooms/m1/marca', { tipo: 'bueno', from: 'aaa' });
    assert.strictEqual(tarde.status, 409);
    jc.ws.close(); dj.ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('marcas: una hora imposible (reloj mal sincronizado) se cambia por la del servidor; un tipo raro se rechaza', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const p = await entrar(base, 'm2', 'aaa', 'JC');
    const inicio = await post(base, '/api/rooms/m2/record', { action: 'start', from: 'aaa' });
    const antes = Date.now();
    const r = await post(base, '/api/rooms/m2/marca', { tipo: 'bueno', from: 'aaa', hora: 12345 });
    assert.ok(Math.abs(r.json.marca.hora - antes) < 5000, `hora ${r.json.marca.hora}, ahora ${antes}`);
    assert.strictEqual(r.json.marca.persona, null, 'sin pistas todavía no tiene etiqueta, pero la marca vale');
    const raro = await post(base, '/api/rooms/m2/marca', { tipo: 'otra', from: 'aaa' });
    assert.strictEqual(raro.status, 400);
    assert.strictEqual(leerSesion('m2', inicio.json.id).marcas.length, 1);
    p.ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});
