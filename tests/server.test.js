'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.GRABACIONES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
const { onRequest } = require('../server');

function listen() {
  return new Promise((resolve) => { const s = http.createServer(onRequest).listen(0, () => resolve(s)); });
}

/** Cliente SSE mínimo que acumula eventos. */
function sse(base, pathQ) {
  const events = [];
  const waiters = [];
  const req = http.get(base + pathQ, (res) => {
    let buf = '';
    res.on('data', (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /event: (.*)/.exec(block); const data = /data: (.*)/.exec(block);
        if (ev && data) {
          const e = { event: ev[1], data: JSON.parse(data[1]) };
          events.push(e);
          waiters.splice(0).forEach((w) => w());
        }
      }
    });
  });
  const next = async (name) => {
    for (;;) {
      const idx = events.findIndex((e) => e.event === name);
      if (idx >= 0) return events.splice(idx, 1)[0].data;
      await new Promise((r) => waiters.push(r));
    }
  };
  return { next, close: () => req.destroy() };
}

const post = (base, p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));

test('flujo completo: sala, señal, grabación y subida por trozos', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = sse(base, '/api/rooms/prueba/events?peer=aaa&name=Ana&device=PC');
    const wa = await a.next('welcome');
    assert.deepStrictEqual(wa.peers, []);
    const b = sse(base, '/api/rooms/prueba/events?peer=bbb&name=Beto&device=iPad');
    const wb = await b.next('welcome');
    assert.strictEqual(wb.peers[0].name, 'Ana');
    assert.strictEqual((await a.next('peer-joined')).id, 'bbb');

    // Tercera persona: sala llena
    const full = await fetch(`${base}/api/rooms/prueba/events?peer=ccc&name=X`);
    assert.strictEqual(full.status, 409);

    // Señalización
    assert.strictEqual((await post(base, '/api/rooms/prueba/signal', { from: 'bbb', to: 'aaa', data: { hola: 1 } })).status, 200);
    assert.deepStrictEqual((await a.next('signal')).data, { hola: 1 });

    // Reloj
    const t = await fetch(`${base}/api/time`).then((r) => r.json());
    assert.ok(Math.abs(t.now - Date.now()) < 1000);

    // Grabar
    const start = await post(base, '/api/rooms/prueba/record', { action: 'start', from: 'aaa' });
    assert.strictEqual(start.status, 200);
    const ev = await b.next('record-start');
    assert.strictEqual(ev.id, start.json.id);
    assert.strictEqual(ev.beepAt - ev.startAt, 1000);

    // Pista WAV de Beto
    const reg = await post(base, '/api/tracks', { room: 'prueba', session: ev.id, participant: 'bbb', name: 'Beto', kind: 'audio', format: 'wav', mime: 'audio/wav', sampleRate: 48000, channels: 1 });
    assert.strictEqual(reg.status, 200);
    assert.strictEqual(reg.json.file, 'beto_audio.wav');
    const up = (seq, bytes) => fetch(`${base}/api/upload?room=prueba&session=${ev.id}&track=bbb-audio&seq=${seq}`, { method: 'PUT', body: Buffer.alloc(bytes, seq + 1) });
    assert.strictEqual((await up(0, 100)).status, 200);
    assert.strictEqual((await up(2, 100)).status, 409);       // hueco
    assert.strictEqual((await up(1, 50)).status, 200);
    assert.strictEqual((await up(1, 50)).status, 200);        // repetido: se ignora
    const fin = await post(base, '/api/tracks/finish', { room: 'prueba', session: ev.id, track: 'bbb-audio', chunks: 2, startedAtServer: ev.startAt + 3, endedAtServer: ev.startAt + 5000, beepOffsetSec: 0.997 });
    assert.strictEqual(fin.status, 200);
    const file = path.join(process.env.GRABACIONES_DIR, 'prueba', ev.id, 'beto_audio.wav');
    const buf = fs.readFileSync(file);
    assert.strictEqual(buf.length, 44 + 150);
    assert.strictEqual(buf.readUInt32LE(40), 150);
    assert.strictEqual(buf[44], 1); assert.strictEqual(buf[44 + 100], 2);

    // Faltan trozos al cerrar
    await post(base, '/api/tracks', { room: 'prueba', session: ev.id, participant: 'aaa', name: 'Ana', kind: 'camara', mime: 'video/webm;codecs=vp9,opus' });
    const bad = await post(base, '/api/tracks/finish', { room: 'prueba', session: ev.id, track: 'aaa-camara', chunks: 3 });
    assert.strictEqual(bad.status, 409);
    assert.strictEqual(bad.json.expected, 0);

    // Parar
    assert.strictEqual((await post(base, '/api/rooms/prueba/record', { action: 'stop' })).status, 200);
    await a.next('record-stop');

    // Listado y descarga
    const list = await fetch(`${base}/api/sessions`).then((r) => r.json());
    assert.strictEqual(list[0].tracks['bbb-audio'].complete, true);
    assert.ok(!list[0].files.some((f) => f.name.startsWith('.')));
    const dl = await fetch(base + list[0].files.find((f) => f.name === 'beto_audio.wav').url);
    assert.strictEqual(dl.status, 200);
    assert.strictEqual((await dl.arrayBuffer()).byteLength, 194);

    // Rutas fuera de la carpeta
    assert.notStrictEqual((await fetch(`${base}/grabaciones/..%2F..%2Fetc%2Fpasswd`)).status, 200);
    a.close(); b.close();
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
