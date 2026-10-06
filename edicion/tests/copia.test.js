'use strict';
/*
 * Copias de rescate del Estudio («…_camara.resto-123456.mp4»: lo que no llegó al servidor, con la cabecera del
 * vídeo): se juntan exactas con lo que sí llegó, y el montaje no las toma por otra cámara.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EP = require('../episodio.js');
const MC = require('../multicam.js');
const { wavHeader } = require('../../lib/core');

const CLI = path.join(__dirname, '..', 'cli.js');
const caja = (tipo, relleno) => {
  const b = Buffer.alloc(8 + relleno.length);
  b.writeUInt32BE(b.length, 0);
  b.write(tipo, 4, 'latin1');
  Buffer.from(relleno).copy(b, 8);
  return b;
};
const CABECERA = Buffer.concat([caja('ftyp', 'isom0000'), caja('moov', 'pistas-y-codecs')]);
const fragmento = (n) => Buffer.concat([caja('moof', `f${n}`), caja('mdat', `imagen-${n}`.repeat(3))]);
const TROZOS = [Buffer.concat([CABECERA, fragmento(0)]), fragmento(1), fragmento(2), fragmento(3), fragmento(4)];
const junto = (a, b) => Buffer.concat(TROZOS.slice(a, b));

function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'copia-')); }

test('juntar copia (vídeo): el resto va detrás sin su cabecera; si el servidor ya tenía parte, no se repite; con un hueco, no', () => {
  const d = dir();
  const servidor = path.join(d, 'jc_camara.mp4');
  const enServidor = junto(0, 3).length;
  const copia = path.join(d, `s_JC_camara.resto-${enServidor}.mp4`);
  fs.writeFileSync(copia, Buffer.concat([CABECERA, TROZOS[3], TROZOS[4]]));
  const salida = path.join(d, 'junto.mp4');

  fs.writeFileSync(servidor, junto(0, 3));
  assert.deepStrictEqual(EP.juntarCopia(servidor, copia, salida), { bytes: junto(3, 5).length });
  assert.deepStrictEqual(fs.readFileSync(salida), junto(0, 5), 'el archivo original, byte a byte');

  fs.writeFileSync(servidor, junto(0, 4));          // el servidor llegó a recibir otro trozo después de la copia
  EP.juntarCopia(servidor, copia, salida);
  assert.deepStrictEqual(fs.readFileSync(salida), junto(0, 5));

  fs.writeFileSync(servidor, junto(0, 2));          // le falta un trozo de antes de la copia
  assert.match(EP.juntarCopia(servidor, copia, salida).error, /faltan \d+ bytes .*hueco/);
  assert.match(EP.juntarCopia(servidor, path.join(d, 'otra.mp4'), salida).error, /no es una copia de rescate/);
});

test('juntar copia (WAV): el audio seguido y la cabecera con el tamaño del total', () => {
  const d = dir();
  const pcm = [0, 1, 2, 3].map((n) => Buffer.alloc(960, n + 1));
  const servidor = path.join(d, 'dj_audio.wav');
  fs.writeFileSync(servidor, Buffer.concat([wavHeader(48000, 1, 1920), pcm[0], pcm[1]]));
  const copia = path.join(d, 's_DJ_audio.resto-1920.wav');
  fs.writeFileSync(copia, Buffer.concat([wavHeader(48000, 1, 1920), pcm[2], pcm[3]]));
  const salida = path.join(d, 'junto.wav');
  assert.deepStrictEqual(EP.juntarCopia(servidor, copia, salida), { bytes: 1920 });
  assert.deepStrictEqual(fs.readFileSync(salida), Buffer.concat([wavHeader(48000, 1, 3840), ...pcm]));
});

test('juntar-copia (orden): deja el resultado en su sitio y guarda el de antes', () => {
  const d = dir();
  const servidor = path.join(d, 'jc_camara.mp4');
  fs.writeFileSync(servidor, junto(0, 3));
  const copia = path.join(d, `s_JC_camara.resto-${junto(0, 3).length}.mp4`);
  fs.writeFileSync(copia, Buffer.concat([CABECERA, TROZOS[3], TROZOS[4]]));
  const r = spawnSync(process.execPath, [CLI, 'juntar-copia', servidor, copia], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.deepStrictEqual(fs.readFileSync(servidor), junto(0, 5));
  assert.deepStrictEqual(fs.readFileSync(path.join(d, 'jc_camara.sin-resto.mp4')), junto(0, 3));
});

test('la cabecera de un WebM acaba donde empieza el primer Cluster', () => {
  const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x84, 1, 2, 3, 4]), Buffer.from('segmento+pistas'), Buffer.from([0x1f, 0x43, 0xb6, 0x75, 9, 9])]);
  assert.strictEqual(EP.finDeCabecera(webm), webm.length - 6);
  assert.strictEqual(EP.finDeCabecera(Buffer.concat([CABECERA, fragmento(1)])), CABECERA.length);
});

test('el montaje no toma una copia de rescate por otra cámara', () => {
  const r = MC.inferRoles(['/o/jc_camara.mp4', '/o/jc_audio.wav', '/o/2026-10-10_21-30-05_JC_camara.resto-123456.mp4']);
  assert.deepStrictEqual([...r.people.keys()], ['jc']);
  assert.deepStrictEqual(r.restos, ['/o/2026-10-10_21-30-05_JC_camara.resto-123456.mp4']);
});
