'use strict';
/*
 * Robustez de las grabaciones en el servidor: que un trozo no se guarde dos veces, que los archivos
 * valgan aunque la página muera, y lo que necesita el editor para ordenar y situar las pistas.
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

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

// Las conexiones a la sala se cierran al final pase lo que pase: si una prueba falla a medias, una
// conexión abierta mantendría vivo el proceso y colgaría el resto.
const abiertas = new Set();
test.after(() => { for (const ws of abiertas) ws.terminate(); });

/** Sala con una persona dentro y una grabación en marcha. Devuelve la sesión. */
async function grabando(base, sala) {
  const ws = new WebSocket(`${base.replace('http', 'ws')}/api/rooms/${sala}/ws?peer=aaa&name=DJ&device=iPad`);
  abiertas.add(ws);
  await new Promise((r) => ws.on('open', r));
  const start = await post(base, `/api/rooms/${sala}/record`, { action: 'start', from: 'aaa' });
  return { sesion: start.json.id, ws };
}

const wav = (base, sala, sesion, extra = {}) => post(base, '/api/tracks', { room: sala, session: sesion, participant: 'aaa', name: 'DJ', kind: 'audio', format: 'wav', mime: 'audio/wav', sampleRate: 48000, channels: 1, ...extra });

/** Envía un trozo poco a poco: empieza a llegar y termina de llegar `ms` después. */
function envioLento(port, sala, sesion, seq, cuerpo, ms) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/upload?room=${sala}&session=${sesion}&track=aaa-audio&seq=${seq}`, headers: { 'Content-Length': cuerpo.length } },
      (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) })); });
    req.write(cuerpo.subarray(0, 1000));
    setTimeout(() => req.end(cuerpo.subarray(1000)), ms);
  });
}

test('el mismo trozo enviado dos veces a la vez se guarda una sola vez', async () => {
  const server = await listen();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { sesion, ws } = await grabando(base, 'doble');
    const reg = await wav(base, 'doble', sesion);
    const trozo = Buffer.alloc(96000, 7);
    const [x, y] = await Promise.all([envioLento(port, 'doble', sesion, 0, trozo, 300), envioLento(port, 'doble', sesion, 0, trozo, 300)]);
    assert.deepStrictEqual([x.status, y.status], [200, 200]);
    assert.ok(x.json.duplicate || y.json.duplicate, 'uno de los dos se reconoce como repetido');
    const archivo = path.join(process.env.GRABACIONES_DIR, 'doble', sesion, reg.json.file);
    assert.strictEqual(fs.statSync(archivo).size, 44 + trozo.length);
    // Y el siguiente sigue en su sitio.
    const r = await envioLento(port, 'doble', sesion, 1, Buffer.alloc(96000, 9), 10);
    assert.strictEqual(r.json.nextSeq, 2);
    assert.strictEqual(fs.statSync(archivo).size, 44 + 2 * trozo.length);
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('el WAV vale desde el primer trozo, aunque la página muera antes de cerrarlo', async () => {
  const server = await listen();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { sesion, ws } = await grabando(base, 'wav');
    const reg = await wav(base, 'wav', sesion);
    await envioLento(port, 'wav', sesion, 0, Buffer.alloc(9600, 1), 1);
    await envioLento(port, 'wav', sesion, 1, Buffer.alloc(9600, 1), 1);
    const cab = fs.readFileSync(path.join(process.env.GRABACIONES_DIR, 'wav', sesion, reg.json.file)).subarray(0, 44);
    assert.strictEqual(cab.readUInt32LE(40), 19200, 'tamaño de datos al día sin haber llamado a finish');
    assert.strictEqual(cab.readUInt32LE(4), 36 + 19200);
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('la hora de inicio de una pista queda guardada en cuanto se sabe, sin esperar a cerrarla', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { sesion, ws } = await grabando(base, 'inicio');
    await wav(base, 'inicio', sesion);
    assert.strictEqual((await post(base, '/api/tracks/start', { room: 'inicio', session: sesion, track: 'aaa-audio', startedAtServer: 1234.5 })).status, 200);
    const leer = () => JSON.parse(fs.readFileSync(path.join(process.env.GRABACIONES_DIR, 'inicio', sesion, 'session.json'), 'utf8'));
    assert.strictEqual(leer().tracks['aaa-audio'].startedAtServer, 1234.5);
    // Al cerrar se conserva si la página no la manda otra vez.
    await post(base, '/api/tracks/finish', { room: 'inicio', session: sesion, track: 'aaa-audio', chunks: 0 });
    assert.strictEqual(leer().tracks['aaa-audio'].startedAtServer, 1234.5);
    assert.strictEqual((await post(base, '/api/tracks/start', { room: 'inicio', session: sesion, track: 'nada', startedAtServer: 1 })).status, 404);
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('una pista que empieza tarde (sin la orden de grabar) se anota en session.json', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { sesion, ws } = await grabando(base, 'tarde');
    assert.strictEqual((await wav(base, 'tarde', sesion, { tarde: true })).status, 200);
    const s = JSON.parse(fs.readFileSync(path.join(process.env.GRABACIONES_DIR, 'tarde', sesion, 'session.json'), 'utf8'));
    assert.strictEqual(s.participants.aaa.tarde, true);
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('el estado de la grabación de la sala se puede consultar (para quien se perdió la orden)', async () => {
  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const nada = await fetch(`${base}/api/rooms/estado/sesion`).then((r) => r.json());
    assert.strictEqual(nada.session, null);
    const { sesion, ws } = await grabando(base, 'estado');
    const en = await fetch(`${base}/api/rooms/estado/sesion`).then((r) => r.json());
    assert.strictEqual(en.session.id, sesion);
    assert.strictEqual(en.session.recording, true);
    assert.ok(Math.abs(en.now - Date.now()) < 1000);
    await post(base, '/api/rooms/estado/record', { action: 'stop', from: 'aaa' });
    const fin = await fetch(`${base}/api/rooms/estado/sesion`).then((r) => r.json());
    assert.strictEqual(fin.session.recording, false);
    assert.ok(Number.isFinite(fin.session.stopAt));
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

test('al descargar, el nombre lleva la sesión (para no confundir sesiones en Descargas)', async () => {
  const server = await listen();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  try {
    const { sesion, ws } = await grabando(base, 'baja');
    const reg = await wav(base, 'baja', sesion);
    const r = await fetch(`${base}/grabaciones/baja/${sesion}/${reg.json.file}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.headers.get('content-disposition'), `attachment; filename="${sesion}_${reg.json.file}"`);
    ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
});

/** Arranca el servidor en otro proceso (estado limpio, como tras reiniciarlo) y devuelve su dirección. */
function otroServidor() {
  const codigo = `const http = require('http'); const { onRequest, attachSignaling } = require(${JSON.stringify(path.join(__dirname, '..', 'server.js'))});
    const s = http.createServer(onRequest); attachSignaling(s); s.listen(0, () => console.log('PUERTO', s.address().port));`;
  const hijo = spawn(process.execPath, ['-e', codigo], { env: process.env, stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve) => {
    hijo.stdout.on('data', (d) => {
      const m = /PUERTO (\d+)/.exec(d.toString());
      if (m) resolve({ base: `http://127.0.0.1:${m[1]}`, port: Number(m[1]), parar: () => hijo.kill() });
    });
  });
}

test('si el servidor se cayó entre guardar un trozo y apuntarlo, al reanudar no queda duplicado', async () => {
  const a = await otroServidor();
  let sesion;
  let archivo;
  try {
    const g = await grabando(a.base, 'reinicio');
    sesion = g.sesion;
    const reg = await wav(a.base, 'reinicio', sesion);
    archivo = path.join(process.env.GRABACIONES_DIR, 'reinicio', sesion, reg.json.file);
    await envioLento(a.port, 'reinicio', sesion, 0, Buffer.alloc(9600, 1), 1);
    g.ws.close();
  } finally { a.parar(); }
  // Simula la caída: el trozo 1 llegó al archivo pero no al registro de progreso.
  fs.appendFileSync(archivo, Buffer.alloc(9600, 2));
  const b = await otroServidor();
  try {
    const reg = await wav(b.base, 'reinicio', sesion);
    assert.strictEqual(reg.json.nextSeq, 1, 'continúa donde lo apuntó');
    assert.strictEqual(fs.statSync(archivo).size, 44 + 9600, 'el trozo que sobraba se quita');
    await envioLento(b.port, 'reinicio', sesion, 1, Buffer.alloc(9600, 2), 1);
    assert.strictEqual(fs.statSync(archivo).size, 44 + 2 * 9600);
  } finally { b.parar(); }
});

test('un trozo que no se pudo apuntar no se confirma: el reintento lo guarda y sobrevive a un reinicio', async () => {
  const server = await listen();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  let sesion;
  let archivo;
  try {
    const g = await grabando(base, 'apuntar');
    sesion = g.sesion;
    const reg = await wav(base, 'apuntar', sesion);
    archivo = path.join(process.env.GRABACIONES_DIR, 'apuntar', sesion, reg.json.file);
    const progreso = path.join(path.dirname(archivo), `.${reg.json.file}.seq`);
    assert.strictEqual((await envioLento(port, 'apuntar', sesion, 0, Buffer.alloc(9600, 1), 1)).status, 200);
    // El registro de progreso no se puede escribir (disco lleno, antivirus…): en su sitio hay una carpeta.
    const bueno = fs.readFileSync(progreso);
    fs.rmSync(progreso);
    fs.mkdirSync(progreso);
    fs.writeFileSync(path.join(progreso, 'x'), '');
    const fallo = await envioLento(port, 'apuntar', sesion, 1, Buffer.alloc(9600, 2), 1);
    assert.notStrictEqual(fallo.status, 200, 'sin apuntarlo no se confirma');
    assert.strictEqual(fs.statSync(archivo).size, 44 + 9600, 'lo escrito de ese trozo se quita');
    assert.strictEqual(fs.readFileSync(archivo).readUInt32LE(40), 9600, 'la cabecera del WAV vuelve a su tamaño');
    // Se arregla y la página reintenta: se guarda de verdad, no se toma por repetido.
    fs.rmSync(progreso, { recursive: true });
    fs.writeFileSync(progreso, bueno);
    const otra = await envioLento(port, 'apuntar', sesion, 1, Buffer.alloc(9600, 2), 1);
    assert.strictEqual(otra.status, 200);
    assert.ok(!otra.json.duplicate, 'el reintento se guarda');
    assert.strictEqual(otra.json.nextSeq, 2);
    g.ws.close();
  } finally {
    server.closeAllConnections(); server.close();
  }
  // Tras reiniciar el servidor, los dos trozos siguen ahí.
  const b = await otroServidor();
  try {
    const reg = await wav(b.base, 'apuntar', sesion);
    assert.strictEqual(reg.json.nextSeq, 2);
    const datos = fs.readFileSync(archivo);
    assert.strictEqual(datos.length, 44 + 2 * 9600);
    assert.strictEqual(datos[44 + 9600], 2);
  } finally { b.parar(); }
});
