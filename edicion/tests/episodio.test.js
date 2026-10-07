'use strict';
/*
 * Proceso semanal: configuración por episodio, partes (sesiones del Estudio) e importación.
 * Lo que necesita ffmpeg se salta solo si no está.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EP = require('../episodio.js');
const AU = require('../auto.js');
const MC = require('../multicam.js');
const CLI = require('../cli.js');

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'episodio-'));
const escribir = (f, datos) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof datos === 'string' ? datos : JSON.stringify(datos)); };
const leer = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const nombres = (lista) => lista.map((f) => path.basename(f));

// ------------------------------------------------------------------ configuración

test('config: los cortes de un episodio no pasan al siguiente (aprobar escribe en el episodio, no en la raíz)', () => {
  const raiz = tmp();
  EP.escribirConfigSiFalta(raiz);
  const ep1 = path.join(raiz, '2026-10-03');
  EP.crearEstructura(ep1);
  EP.escribirConfigEpisodioSiFalta(ep1);
  escribir(path.join(ep1, 'montaje', 'propuesta.json'), { partes: { 1: { marcas: [{ id: '1.1', desde: 75, hasta: 181, tipos: ['conexion'], texto: 'x' }] } } });
  const r = AU.aprobar(ep1, ['1.1']);
  assert.strictEqual(r.destino, path.join(ep1, 'episodio.json'));
  assert.deepStrictEqual(leer(path.join(ep1, 'episodio.json')).partes[1].cortes, [[75, 181, '1.1 conexion: x']]);
  assert.strictEqual(leer(path.join(raiz, 'episodio.json')).partes, undefined, 'la raíz no se toca');

  const ep2 = path.join(raiz, '2026-10-10');
  EP.crearEstructura(ep2);
  const c = EP.cargarConfig(ep2);
  assert.deepStrictEqual(EP.configDeParte(c.config, '1').cortes, [], 'el episodio nuevo no hereda el corte');
});

test('config: por capas; lo del equipo viene de la raíz, lo del episodio de su carpeta, y los objetos se mezclan campo a campo', () => {
  const raiz = tmp();
  const ep = path.join(raiz, '2026-10-10');
  escribir(path.join(raiz, 'episodio.json'), { audioOffset: 'dj=0,jc=0', crf: 20, color: { saturacion: 1.1 } });
  escribir(path.join(ep, 'episodio.json'), { color: { activo: false }, partes: { 1: { cortes: [[1, 2]] } } });
  const c = EP.cargarConfig(ep);
  assert.strictEqual(c.config.crf, 20);
  assert.strictEqual(c.config.color.saturacion, 1.1, 'de la raíz');
  assert.strictEqual(c.config.color.activo, false, 'del episodio');
  assert.strictEqual(c.config.color.vibrance, EP.CONFIG_POR_DEFECTO.color.vibrance, 'lo que nadie toca, por defecto');
  assert.strictEqual(c.config.silencios.min, 4);
  assert.deepStrictEqual(c.config.partes[1].cortes, [[1, 2]]);
  assert.deepStrictEqual(c.archivos, [path.join(raiz, 'episodio.json'), path.join(ep, 'episodio.json')]);
  assert.deepStrictEqual(c.avisos, []);
  assert.deepStrictEqual(EP.CONFIG_POR_DEFECTO.cortes, [], 'los valores por defecto no se modifican');
});

test('config: lo de un episodio que quedó en la raíz no se aplica, avisa y se puede pasar a su episodio', () => {
  const raiz = tmp();
  const viejo = path.join(raiz, '2026-10-03');
  const nuevo = path.join(raiz, '2026-10-10');
  escribir(path.join(raiz, 'episodio.json'), {
    audioOffset: 'dj=0,jc=0', desde: 'auto', hasta: '58:10', cortes: [],
    partes: { 1: { cortes: [[75, 181]], limpiezas: [{ persona: 'jc', desde: 640, hasta: 730 }] } },
  });
  fs.mkdirSync(path.join(nuevo, 'originales'), { recursive: true });
  const c = EP.cargarConfig(nuevo);
  assert.deepStrictEqual(c.config.partes, {});
  assert.strictEqual(c.config.hasta, 'auto', 'un "hasta" con tiempo es de una grabación concreta');
  assert.match(c.avisos.join(' '), /partes, hasta|hasta, partes/);
  assert.deepStrictEqual(Object.keys(c.ignoradas).sort(), ['hasta', 'partes']);

  const t = EP.tomarDeRaiz(viejo);
  assert.deepStrictEqual(t.movidas.sort(), ['hasta', 'partes']);
  assert.ok(fs.existsSync(t.copia), 'deja una copia de la raíz como estaba');
  const propia = leer(path.join(viejo, 'episodio.json'));
  assert.deepStrictEqual(propia.partes[1].cortes, [[75, 181]]);
  assert.strictEqual(propia.hasta, '58:10');
  const enRaiz = leer(path.join(raiz, 'episodio.json'));
  assert.strictEqual(enRaiz.partes, undefined);
  assert.strictEqual(enRaiz.audioOffset, 'dj=0,jc=0', 'lo del equipo se queda en la raíz');
  assert.deepStrictEqual(EP.cargarConfig(nuevo).avisos, []);
  assert.deepStrictEqual(EP.cargarConfig(viejo).config.partes[1].cortes, [[75, 181]], 'el episodio viejo conserva sus cortes');
  assert.deepStrictEqual(EP.tomarDeRaiz(viejo).movidas, [], 'repetirlo no hace nada');
});

test('config: tomar de la raíz no pisa los cortes que el episodio ya tenga', () => {
  const raiz = tmp();
  const ep = path.join(raiz, '2026-10-03');
  escribir(path.join(raiz, 'episodio.json'), { partes: { 1: { cortes: [[1, 2]] } } });
  escribir(path.join(ep, 'episodio.json'), { partes: { 2: { cortes: [[3, 4]] } } });
  assert.throws(() => EP.tomarDeRaiz(ep), /ya tiene partes/);
  assert.ok(leer(path.join(raiz, 'episodio.json')).partes, 'no se ha tocado nada');
});

test('config: la plantilla de la raíz no lleva claves de episodio y la del episodio sí', () => {
  const raiz = tmp();
  const f = EP.escribirConfigSiFalta(raiz);
  const datos = leer(f);
  for (const k of EP.CLAVES_DEL_EPISODIO) assert.strictEqual(datos[k], undefined, k);
  assert.strictEqual(datos.lufsEntrega, -14);
  const ep = path.join(raiz, '2026-10-10');
  assert.ok(EP.escribirConfigEpisodioSiFalta(ep));
  assert.deepStrictEqual(leer(path.join(ep, 'episodio.json')), { cortes: [], partes: {} });
  assert.strictEqual(EP.escribirConfigEpisodioSiFalta(ep), false, 'no se pisa si ya existe');
});

test('config: un JSON roto se dice con el nombre del archivo, y la marca BOM de Windows no molesta', () => {
  const raiz = tmp();
  const ep = path.join(raiz, 'e');
  escribir(path.join(raiz, 'episodio.json'), '﻿{"crf": 21}');
  assert.strictEqual(EP.cargarConfig(ep).config.crf, 21);
  escribir(path.join(ep, 'episodio.json'), '{ "crf": 21, }');
  assert.throws(() => EP.cargarConfig(ep), /episodio\.json no es un JSON válido/);
});

// ------------------------------------------------------------------ partes

function originales(lista) {
  const dir = path.join(tmp(), 'originales');
  for (const n of lista) escribir(path.join(dir, n), 'x');
  return dir;
}

test('partes: dos sesiones bajadas con Descargas vacía ("" y "(1)") son dos partes, no una', () => {
  const dir = originales(['dj_camara.mp4', 'dj_audio.wav', 'jc_llamada.mp4', 'dj_camara (1).mp4', 'dj_audio (1).wav', 'jc_llamada (1).mp4']);
  const partes = EP.agruparPartes(dir);
  assert.deepStrictEqual(partes.map((p) => p.id), ['1', '2']);
  assert.deepStrictEqual(nombres(partes[0].archivos), ['dj_audio.wav', 'dj_camara.mp4', 'jc_llamada.mp4']);
  assert.deepStrictEqual(nombres(partes[1].archivos), ['dj_audio (1).wav', 'dj_camara (1).mp4', 'jc_llamada (1).mp4']);
  assert.ok(partes.every((p) => p.porNumero));
  for (const p of partes) assert.deepStrictEqual(MC.inferRoles(p.archivos).unknown, [], 'nada se queda fuera');
});

test('partes: una sola sesión en la que el navegador numeró solo algunos archivos sigue siendo una parte', () => {
  // En Descargas ya había un jc_llamada.mp4 de otra semana: solo ese nombre sale con "(1)".
  const dir = originales(['dj_camara.mp4', 'dj_audio.wav', 'jc_camara.mp4', 'jc_audio.wav', 'jc_llamada (1).mp4']);
  const partes = EP.agruparPartes(dir);
  assert.strictEqual(partes.length, 1);
  assert.strictEqual(partes[0].archivos.length, 5);
});

test('partes: "(1)" y "(2)" siguen siendo las partes 1 y 2 (como el episodio del 3 de octubre)', () => {
  const dir = originales(['dj_camara (2).mp4', 'jc_llamada (1).mp4', 'dj_camara (1).mp4', 'jc_llamada (2).mp4']);
  assert.deepStrictEqual(EP.agruparPartes(dir).map((p) => [p.id, nombres(p.archivos).join('|')]),
    [['1', 'dj_camara (1).mp4|jc_llamada (1).mp4'], ['2', 'dj_camara (2).mp4|jc_llamada (2).mp4']]);
});

test('partes: con la fecha de la sesión en el nombre se ordenan por la grabación, no por la descarga', () => {
  const dir = originales([
    '2026-10-10_21-40-00_dj_camara.mp4', '2026-10-10_21-40-00_jc_llamada.mp4',
    '2026-10-10_20-05-00_dj_camara.mp4', '2026-10-10_20-05-00_jc_llamada.mp4']);
  const partes = EP.agruparPartes(dir);
  assert.deepStrictEqual(partes.map((p) => p.sesion), ['2026-10-10_20-05-00', '2026-10-10_21-40-00']);
  const { people, call } = MC.inferRoles(partes[0].archivos);
  assert.deepStrictEqual([...people.keys()], ['dj'], 'la fecha no se confunde con el nombre de la persona');
  assert.match(path.basename(call), /jc_llamada/);
});

test('partes: una subcarpeta por sesión (lo que deja importar), por orden de fecha; lo que no es audio o vídeo no cuenta', () => {
  const dir = originales([
    '2026-10-10_21-40-00/dj_camara.mp4', '2026-10-10_21-40-00/session.json',
    '2026-10-10_20-05-00/dj_camara.mp4', '2026-10-10_20-05-00/jc_audio.wav', '.oculta/x.mp4']);
  fs.mkdirSync(path.join(dir, 'vacia'));
  const partes = EP.agruparPartes(dir);
  assert.deepStrictEqual(partes.map((p) => [p.id, p.sesion, nombres(p.archivos).join('|')]),
    [['1', '2026-10-10_20-05-00', 'dj_camara.mp4|jc_audio.wav'], ['2', '2026-10-10_21-40-00', 'dj_camara.mp4']]);
  assert.strictEqual(partes[0].carpeta, path.join(dir, '2026-10-10_20-05-00'));
});

test('roles: todas las llamadas, ordenadas por tramo (jc antes que jc-2), y los repetidos se dicen', () => {
  const r = MC.inferRoles(['/x/jc-2_llamada.mp4', '/x/jc_llamada.mp4', '/x/dj_camara.mp4', '/x/dj_camara (1).mp4', '/x/jc-2_camara.mp4']);
  assert.deepStrictEqual(nombres(r.calls), ['jc_llamada.mp4', 'jc-2_llamada.mp4']);
  assert.strictEqual(path.basename(r.call), 'jc_llamada.mp4');
  assert.deepStrictEqual(r.llamadas.map((l) => [l.base, l.tramo]), [['jc', 1], ['jc', 2]]);
  assert.deepStrictEqual(nombres(r.unknown), ['dj_camara (1).mp4']);
  assert.deepStrictEqual([...r.people.keys()].sort(), ['dj', 'jc-2']);
});

test('descargas: reconoce los nombres con la fecha de la sesión y los nombres con guion', () => {
  const dir = tmp();
  for (const n of ['2026-10-10_21-40-00_dj_camara.mp4', 'jose-carlos_audio.wav', 'jc-2_llamada (1).mp4', 'foto.jpg', 'dj_camara.txt']) escribir(path.join(dir, n), 'x');
  assert.deepStrictEqual(EP.descubrirDescargas(dir, 1).map((f) => f.nombre).sort(),
    ['2026-10-10_21-40-00_dj_camara.mp4', 'jc-2_llamada (1).mp4', 'jose-carlos_audio.wav']);
});

// ------------------------------------------------------------------ importar desde el Estudio

function estudioFalso() {
  const grab = path.join(tmp(), 'grabaciones');
  const ahora = Date.now();
  const sesion = (id, minutosAtras, pistas, extra) => {
    const dir = path.join(grab, 'dtp', id);
    const tracks = {};
    for (const [nombre, completa] of pistas) {
      escribir(path.join(dir, nombre), `contenido de ${nombre}`);
      tracks[nombre] = { file: nombre, complete: completa };
    }
    escribir(path.join(dir, 'session.json'), { id, room: 'dtp', createdAt: new Date(ahora - minutosAtras * 60000).toISOString(), startAt: 0, stopAt: 3600000, tracks, ...extra });
  };
  sesion('2026-10-10_21-40-00', 30, [['dj_camara.mp4', true], ['jc_llamada.mp4', true]]);
  sesion('2026-10-10_20-05-00', 120, [['dj_camara.mp4', true], ['jc_audio.wav', false]]);
  sesion('2026-10-01_20-00-00', 60 * 24 * 9, [['dj_camara.mp4', true]]);   // de otro episodio
  escribir(path.join(grab, 'dtp', 'sin-sesion', 'dj_camara.mp4'), 'x');
  return grab;
}

test('importar: encuentra las sesiones recientes del Estudio, de la más antigua a la más reciente', () => {
  const grab = estudioFalso();
  const s = EP.descubrirSesionesEstudio(grab, 36);
  assert.deepStrictEqual(s.map((x) => x.id), ['2026-10-10_20-05-00', '2026-10-10_21-40-00']);
  assert.deepStrictEqual(s[0].archivos.map((f) => [f.nombre, f.completa]), [['dj_camara.mp4', true], ['jc_audio.wav', false]]);
  assert.deepStrictEqual(EP.descubrirSesionesEstudio(path.join(grab, 'no-existe'), 36), []);
});

test('importar: copia cada sesión a su subcarpeta con session.json, repetirlo no duplica, y episodio las ve como partes', () => {
  const grab = estudioFalso();
  const ep = path.join(tmp(), '2026-10-10');
  const r = EP.crearEstructura(ep);
  for (const s of EP.descubrirSesionesEstudio(grab, 36)) EP.importarSesion(s, r.originales);
  assert.ok(fs.existsSync(path.join(r.originales, '2026-10-10_20-05-00', 'session.json')));
  assert.ok(fs.existsSync(path.join(grab, 'dtp', '2026-10-10_20-05-00', 'dj_camara.mp4')), 'copiar deja el original en el Estudio');
  const otra = EP.importarSesion(EP.descubrirSesionesEstudio(grab, 36)[0], r.originales);
  assert.ok(otra.hechos.filter((h) => h.nombre !== 'session.json').every((h) => h.accion === 'ya estaba'));
  const partes = EP.agruparPartes(r.originales);
  assert.deepStrictEqual(partes.map((p) => [p.id, p.sesion, nombres(p.archivos).join('|')]),
    [['1', '2026-10-10_20-05-00', 'dj_camara.mp4|jc_audio.wav'], ['2', '2026-10-10_21-40-00', 'dj_camara.mp4|jc_llamada.mp4']]);
});

test('importar: --mover quita los archivos del Estudio pero deja allí su session.json', () => {
  const grab = estudioFalso();
  const r = EP.crearEstructura(path.join(tmp(), 'e'));
  const s = EP.descubrirSesionesEstudio(grab, 36)[1];
  EP.importarSesion(s, r.originales, { mover: true });
  assert.ok(!fs.existsSync(path.join(s.dir, 'dj_camara.mp4')));
  assert.ok(fs.existsSync(path.join(s.dir, 'session.json')));
  assert.strictEqual(fs.readFileSync(path.join(r.originales, s.id, 'dj_camara.mp4'), 'utf8'), 'contenido de dj_camara.mp4');
});

test('importar (comando): sin --copiar solo enseña; con --copiar trae las sesiones; --sesiones elige', () => {
  const grab = estudioFalso();
  const ep = path.join(tmp(), '2026-10-10');
  const r = EP.crearEstructura(ep);
  const log = console.log;
  const salida = [];
  console.log = (...a) => salida.push(a.join(' '));
  try {
    assert.strictEqual(CLI.main(['node', 'cli.js', 'importar', ep, '--estudio', grab]), 0);
    assert.deepStrictEqual(fs.readdirSync(r.originales), [], 'sin --copiar no toca nada');
    assert.match(salida.join('\n'), /SIN TERMINAR DE SUBIR/);
    assert.strictEqual(CLI.main(['node', 'cli.js', 'importar', ep, '--estudio', grab, '--copiar', '--sesiones', '2026-10-10_21-40-00']), 0);
  } finally { console.log = log; }
  assert.deepStrictEqual(fs.readdirSync(r.originales), ['2026-10-10_21-40-00']);
});

// ------------------------------------------------------------------ limpiezas

test('limpiezas: van en el reloj de la llamada, se pasan al de cada micro y cubren el tramo retomado', () => {
  const receta = {
    project: { fps: 25 }, origenReferencia: 2,
    media: [{ id: 'cam_jc', path: 'c' }, { id: 'mic_jc', path: 'a' }, { id: 'mic_jc-2', path: 'b' }, { id: 'mic_dj', path: 'd' }],
    edit: [
      { clip: 'mic_jc', in: 25, at: 0, duration: 500, audioTrack: 1 },      // el archivo empezó 1 s antes del montaje
      { clip: 'mic_jc-2', in: 0, at: 1000, duration: 500, audioTrack: 1 },  // el tramo retomado, 40 s después
      { clip: 'mic_dj', in: 0, at: 0, duration: 1500, audioTrack: 2 },
    ],
  };
  const v = CLI.ventanasDeLimpieza(receta, [{ persona: 'jc', desde: 10, hasta: 50 }, { persona: 'dj', desde: '0:05', hasta: '0:06', ia: false }], '1');
  assert.deepStrictEqual(v.get('mic_jc'), [{ desde: 9, hasta: 49, ia: undefined, puerta: undefined }]);
  assert.deepStrictEqual(v.get('mic_jc-2'), [{ desde: 0, hasta: 8, ia: undefined, puerta: undefined }]);
  assert.deepStrictEqual(v.get('mic_dj'), [{ desde: 3, hasta: 4, ia: false, puerta: undefined }]);
  assert.strictEqual(CLI.ventanasDeLimpieza(receta, [{ persona: 'jc-2', desde: 10, hasta: 50 }], '1').has('mic_jc'), false, '"jc-2" es solo ese tramo');
});

test('limpiezas: varias ventanas en una pasada, y fuera de ellas el audio queda igual', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const wav = path.join(dir, 'micro.wav');
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=r=16000:d=6:a=0.004:c=white', '-c:a', 'pcm_s16le', wav]).status, 0);
  const salida = path.join(dir, 'limpio.wav');
  const l = EP.limpiarMicro(wav, salida, [{ desde: 1, hasta: 2, ia: false }, { desde: 4, hasta: 5, ia: false }], {});
  assert.ok(!l.error, l.error);
  const rms = (f, a) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(a), '-t', '0.6', '-i', f, '-af', 'astats=metadata=1:reset=0,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-', '-f', 'null', '-'], { encoding: 'utf8' });
    const v = (r.stdout || '').trim().split('\n').filter((x) => x.includes('RMS_level')).pop();
    return Number(v.split('=')[1]);
  };
  for (const t of [1.3, 4.3]) assert.ok(rms(salida, t) < rms(wav, t) - 10, `dentro de la ventana (${t} s) baja el ruido`);
  for (const t of [0.2, 2.8, 5.3]) assert.ok(Math.abs(rms(salida, t) - rms(wav, t)) < 0.5, `fuera (${t} s) queda igual`);
});

// ------------------------------------------------------------------ silencios, color, acabado, whisper

/* WAV de 16 kHz: [segundos, amplitud de ruido rosa] por tramo (0 = silencio con un poco de ruido de fondo). */
function wavPorTramos(f, tramos) {
  const entradas = tramos.map(([d, a]) => `anoisesrc=r=16000:d=${d}:a=${a || 0.0005}:c=pink`);
  const args = ['-v', 'error', '-y'];
  for (const e of entradas) args.push('-f', 'lavfi', '-i', e);
  args.push('-filter_complex', `${entradas.map((_, k) => `[${k}:a]`).join('')}concat=n=${entradas.length}:v=0:a=1[o]`, '-map', '[o]', '-c:a', 'pcm_s16le', f);
  assert.strictEqual(spawnSync('ffmpeg', args).status, 0);
  return f;
}

test('silencios: si la llamada calla pero un micro tiene voz, ese silencio no se corta', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  // dj habla de 0 a 30 s salvo de 10 a 16 s; jc calla de 10 a 16 y de 20 a 26 s, pero dj habla en ese segundo tramo.
  const dj = wavPorTramos(path.join(dir, 'dj_audio.wav'), [[10, 0.2], [6, 0], [14, 0.2]]);
  const jc = wavPorTramos(path.join(dir, 'jc_audio.wav'), [[10, 0.2], [6, 0], [4, 0.2], [6, 0], [4, 0.2]]);
  const receta = {
    project: { fps: 25 }, origenReferencia: 1,
    media: [{ id: 'mic_dj', path: dj }, { id: 'mic_jc', path: jc }],
    // El micro de dj empezó 1 s antes que el montaje (in = 25 frames); el de jc, a la vez.
    edit: [{ clip: 'mic_dj', in: 25, at: 0, duration: 725, audioTrack: 1 }, { clip: 'mic_jc', in: 0, at: 0, duration: 725, audioTrack: 2 }],
  };
  // Silencios de la llamada (reloj de la llamada = reloj del micro de dj): 10,5-15,5 s (de verdad) y 20,5-25,5 s (no: dj habla).
  const r = AU.confirmarSilencios(receta, [{ desde: 10.5, hasta: 15.5 }, { desde: 20.5, hasta: 25.5 }]);
  assert.deepStrictEqual(r.quedan, [{ desde: 10.5, hasta: 15.5 }]);
  assert.strictEqual(r.descartados.length, 1);
  assert.strictEqual(r.descartados[0].micro, 'dj');
  assert.ok(r.descartados[0].segundos > 4);
});

test('color medio: se puede medir una muestra en vez del vídeo entero', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const v = path.join(dir, 'cam.mp4');
  // 4 s rojos y 4 s azules: la muestra desde el segundo 5 solo ve azul.
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=64x36:d=4', '-f', 'lavfi', '-i', 'color=c=blue:s=64x36:d=4',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[o]', '-map', '[o]', '-pix_fmt', 'yuv420p', v]).status, 0);
  const AN = require('../analisis.js');
  const todo = AN.colorMedio(v, {});
  const muestra = AN.colorMedio(v, { desde: 5, segundos: 2 });
  assert.ok(todo.r > 80 && todo.b > 80, 'el vídeo entero mezcla los dos');
  assert.ok(muestra.b > 200 && muestra.r < 30, `la muestra solo ve azul (${JSON.stringify(muestra)})`);
});

test('acabado: x264 con el preset de la configuración; NVENC solo si se pide', () => {
  const x = EP.argumentosVideo({ crf: 18, preset: 'medium' }, 'x264');
  assert.deepStrictEqual(x.slice(0, 6), ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18']);
  assert.strictEqual(EP.CONFIG_POR_DEFECTO.preset, 'medium');
  assert.strictEqual(EP.CONFIG_POR_DEFECTO.codificador, 'x264');
  const n = EP.argumentosVideo({ crf: 18 }, 'nvenc');
  assert.strictEqual(n[1], 'h264_nvenc');
  assert.strictEqual(n[n.indexOf('-cq') + 1], '22', 'crf + 4: mismo tamaño y calidad que x264 (medido)');
});

test('acabado: si NVENC no puede (sin tarjeta), repite con x264 y el vídeo sale igual', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const bruto = path.join(dir, 'bruto.mp4');
  assert.strictEqual(spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25:d=3', '-f', 'lavfi', '-i', 'sine=d=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', bruto]).status, 0);
  const final = path.join(dir, 'final.mp4');
  const log = console.log;
  console.log = () => {};
  let a;
  try {
    a = EP.acabado(bruto, final, { ...EP.CONFIG_POR_DEFECTO, codificador: 'nvenc', color: { activo: false } });
  } finally { console.log = log; }
  assert.ok(!a.error, a.error);
  const tieneNvenc = /h264_nvenc/.test(spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' }).stdout || '');
  if (!tieneNvenc || a.codificador === 'x264') assert.strictEqual(a.codificador, 'x264');
  assert.ok(fs.statSync(final).size > 1000);
});

test('whisper: los argumentos de más de la configuración se añaden', () => {
  const TR = require('../transcribir.js');
  assert.deepStrictEqual(TR.ajustes({}).extra, []);
  assert.deepStrictEqual(TR.ajustes({ whisper: { extra: ['--vad'] } }).extra, ['--vad']);
  assert.strictEqual(TR.ajustes({ whisper: { extra: ['--vad'] } }).idioma, 'es', 'lo demás sigue por defecto');
});
