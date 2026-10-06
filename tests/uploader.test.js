'use strict';
/*
 * «Descargar copia» sin IndexedDB (los trozos van en memoria y se sueltan al subirse): la copia nunca sale vacía
 * ni con huecos sin decirlo. Se carga public/js/uploader.js tal cual, con un servidor de mentira.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* El uploader en un contexto sin IndexedDB, con un servidor que confirma hasta que se «cae». */
function cargar() {
  const servidor = { caido: false, subidos: [] };
  const responder = (cuerpo) => ({ ok: true, status: 200, json: async () => cuerpo });
  const fetch = async (url, opts) => {
    if (servidor.caido) return new Promise(() => {});          // la red no contesta: la subida se queda esperando
    if (url === '/api/tracks') return responder({ ok: true, nextSeq: 0 });
    if (url.startsWith('/api/upload')) { servidor.subidos.push(Number(new URLSearchParams(url.split('?')[1]).get('seq'))); return responder({}); }
    return responder({ ok: true });
  };
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'uploader.js'), 'utf8'),
    { window, fetch, Blob, URLSearchParams, setTimeout, console });
  return { TrackUploader: window.TrackUploader, servidor };
}

const caja = (tipo, relleno) => {
  const b = Buffer.alloc(8 + relleno.length);
  b.writeUInt32BE(b.length, 0);
  b.write(tipo, 4, 'latin1');
  Buffer.from(relleno).copy(b, 8);
  return b;
};
// Un MP4 fragmentado como el de MediaRecorder: el primer trozo lleva la cabecera (ftyp + moov) y un fragmento.
const CABECERA = Buffer.concat([caja('ftyp', 'isom0000'), caja('moov', 'pistas-y-codecs')]);
const fragmento = (n) => Buffer.concat([caja('moof', `f${n}`), caja('mdat', `imagen-${n}`.repeat(3))]);
const TROZOS = [Buffer.concat([CABECERA, fragmento(0)]), fragmento(1), fragmento(2), fragmento(3), fragmento(4)];

const hasta = async (cond) => { for (let i = 0; i < 1000 && !cond(); i += 1) await new Promise((r) => setImmediate(r)); };
const bytes = async (blob) => Buffer.from(await blob.arrayBuffer());

test('copia sin IndexedDB, con lo primero ya subido: el resto con su cabecera, y dice desde qué minuto', async () => {
  const { TrackUploader, servidor } = cargar();
  const u = new TrackUploader({ room: 'dtp', session: '2026-10-10_21-30-05', participant: 'p1', name: 'JC', kind: 'camara', mime: 'video/mp4' });
  for (const t of TROZOS.slice(0, 3)) await u.push(new Blob([t]));
  await hasta(() => u.acked === 3);
  assert.deepStrictEqual(servidor.subidos, [0, 1, 2]);
  assert.deepStrictEqual([...u.memory.keys()], [0], 'lo subido se suelta, salvo el primer trozo (la cabecera)');
  servidor.caido = true;
  for (const t of TROZOS.slice(3)) await u.push(new Blob([t]));

  const c = await u.copia();
  const enServidor = TROZOS.slice(0, 3).reduce((n, t) => n + t.length, 0);
  assert.strictEqual(c.nombre, `2026-10-10_21-30-05_JC_camara.resto-${enServidor}.mp4`);
  assert.deepStrictEqual(await bytes(c.blob), Buffer.concat([CABECERA, TROZOS[3], TROZOS[4]]));
  assert.match(c.aviso, /Hasta el minuto 0:03 ya está en el servidor: esta copia lleva el resto/);
  assert.strictEqual(await bytes(await TrackUploader.cabecera(new Blob([TROZOS[0]]))).then((b) => b.length), CABECERA.length);
});

test('copia sin IndexedDB con todo subido: lo dice y no da un archivo vacío', async () => {
  const { TrackUploader } = cargar();
  const u = new TrackUploader({ room: 'dtp', session: 's', participant: 'p1', name: 'JC', kind: 'camara', mime: 'video/mp4' });
  for (const t of TROZOS.slice(0, 2)) await u.push(new Blob([t]));
  await hasta(() => u.acked === 2);
  const c = await u.copia();
  assert.strictEqual(c.blob, undefined);
  assert.strictEqual(c.aviso, 'Ya está todo en el servidor: no hace falta copia.');
});

test('copia de un WAV sin IndexedDB: el resto es un WAV que se puede abrir, con su cabecera del tamaño justo', async () => {
  const { TrackUploader, servidor } = cargar();
  const u = new TrackUploader({ room: 'dtp', session: 's', participant: 'p1', name: 'DJ', kind: 'audio', format: 'wav', sampleRate: 48000, channels: 1 });
  const pcm = [0, 1, 2, 3].map((n) => Buffer.alloc(960, n + 1));
  for (const t of pcm.slice(0, 2)) await u.push(new Blob([t]));
  await hasta(() => u.acked === 2);
  servidor.caido = true;
  for (const t of pcm.slice(2)) await u.push(new Blob([t]));
  const c = await u.copia();
  assert.strictEqual(c.nombre, 's_DJ_audio.resto-1920.wav');
  const b = await bytes(c.blob);
  assert.strictEqual(b.toString('latin1', 0, 4), 'RIFF');
  assert.strictEqual(b.readUInt32LE(40), 1920, 'la cabecera dice cuánto audio lleva: los dos trozos sin subir');
  assert.deepStrictEqual(b.subarray(44), Buffer.concat(pcm.slice(2)), 'sin el primer trozo (en un WAV no hace falta)');
});

test('copia con todo en el dispositivo: el archivo entero, como siempre', async () => {
  const { TrackUploader, servidor } = cargar();
  servidor.caido = true;
  const u = new TrackUploader({ room: 'dtp', session: 's', participant: 'p1', name: 'JC', kind: 'camara', mime: 'video/mp4' });
  for (const t of TROZOS) await u.push(new Blob([t]));
  const c = await u.copia();
  assert.strictEqual(c.nombre, 's_JC_camara.mp4');
  assert.strictEqual(c.aviso, undefined);
  assert.deepStrictEqual(await bytes(c.blob), Buffer.concat(TROZOS));
});
