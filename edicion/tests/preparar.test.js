'use strict';
/*
 * El arranque del episodio en una orden (`preparar`), la carpeta del episodio por omisión o por su fecha, y el
 * «siguiente paso» de `estado`.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const EP = require('../episodio.js');
const AU = require('../auto.js');
const CLI = path.join(__dirname, '..', 'cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'preparar-'));

/** Una sesión del Estudio de mentira: session.json y archivos pequeños. `min`: lo que duró. */
function sesion(estudio, id, { min = 30, completa = true } = {}) {
  const dir = path.join(estudio, 'dtp', id);
  fs.mkdirSync(dir, { recursive: true });
  const tracks = {};
  for (const f of ['jc_camara.mp4', 'jc_audio.wav', 'jc_llamada.mp4', 'dj_camara.mp4', 'dj_audio.wav']) {
    fs.writeFileSync(path.join(dir, f), 'x');
    tracks[f] = { file: f, complete: completa || !f.startsWith('dj_camara') };
  }
  const startAt = Date.now() - 3600 * 1000;
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ room: 'dtp', id, createdAt: new Date(startAt).toISOString(), startAt, stopAt: startAt + min * 60000, tracks }));
}

const cli = (args, env) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('preparar: crea el episodio con la fecha de la grabación y trae las sesiones, sin más órdenes', () => {
  const estudio = tmp();
  const raiz = tmp();
  sesion(estudio, '2026-11-14_20-00-00');
  sesion(estudio, '2026-11-14_21-10-00');
  const r = cli(['preparar', '--sin-analizar'], { GRABACIONES_DIR: estudio, EPISODIOS_DIR: raiz });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  const ep = path.join(raiz, '2026-11-14');
  assert.ok(fs.existsSync(path.join(ep, 'episodio.json')), 'con su episodio.json');
  assert.ok(fs.existsSync(path.join(raiz, 'episodio.json')), 'y el del equipo');
  for (const id of ['2026-11-14_20-00-00', '2026-11-14_21-10-00']) {
    assert.deepStrictEqual(fs.readdirSync(path.join(ep, 'originales', id)).sort(),
      ['dj_audio.wav', 'dj_camara.mp4', 'jc_audio.wav', 'jc_camara.mp4', 'jc_llamada.mp4', 'session.json']);
  }
  // Repetirlo no duplica ni falla.
  assert.strictEqual(cli(['preparar', '--sin-analizar'], { GRABACIONES_DIR: estudio, EPISODIOS_DIR: raiz }).status, 0);
});

test('preparar: con una prueba corta o pistas a medio subir se para sin copiar y dice cómo seguir', () => {
  const estudio = tmp();
  const raiz = tmp();
  sesion(estudio, '2026-11-14_19-55-00', { min: 0.5 });
  sesion(estudio, '2026-11-14_20-00-00');
  const r = cli(['preparar', '--sin-analizar'], { GRABACIONES_DIR: estudio, EPISODIOS_DIR: raiz });
  assert.strictEqual(r.status, 3);
  assert.match(r.stdout, /No he copiado nada/);
  assert.match(r.stdout, /preparar --sesiones 2026-11-14_20-00-00\n/, 'propone seguir sin la prueba');
  assert.deepStrictEqual(fs.readdirSync(raiz), [], 'no se ha creado nada');
  // Elegir las sesiones es la confirmación.
  const r2 = cli(['preparar', '--sin-analizar', '--sesiones', '2026-11-14_20-00-00'], { GRABACIONES_DIR: estudio, EPISODIOS_DIR: raiz });
  assert.strictEqual(r2.status, 0, r2.stdout + r2.stderr);
  assert.deepStrictEqual(fs.readdirSync(path.join(raiz, '2026-11-14', 'originales')), ['2026-11-14_20-00-00']);

  const estudio2 = tmp();
  sesion(estudio2, '2026-11-15_20-00-00', { completa: false });
  const r3 = cli(['preparar', '--sin-analizar'], { GRABACIONES_DIR: estudio2, EPISODIOS_DIR: tmp() });
  assert.strictEqual(r3.status, 3);
  assert.match(r3.stdout, /1 pista\(s\) sin terminar de subir/);
});

test('la carpeta del episodio: entera, solo la fecha o ninguna (el más reciente)', () => {
  const raiz = tmp();
  assert.throws(() => EP.resolverCarpeta(undefined, raiz), /no hay episodios/);
  for (const f of ['2026-10-18', '2026-11-01', 'notas']) fs.mkdirSync(path.join(raiz, f));
  assert.strictEqual(EP.resolverCarpeta(undefined, raiz), path.join(raiz, '2026-11-01'));
  assert.strictEqual(EP.resolverCarpeta('2026-10-18', raiz), path.join(raiz, '2026-10-18'));
  assert.strictEqual(EP.resolverCarpeta('2026-12-25', raiz), '2026-12-25', 'una fecha que no está se deja como venía');
  assert.strictEqual(EP.resolverCarpeta('D:/otro/sitio', raiz), 'D:/otro/sitio');
  // En la orden: sin carpeta usa el más reciente y lo dice; `aprobar 1.1` no confunde el número con una carpeta.
  const e = cli(['estado'], { EPISODIOS_DIR: raiz });
  assert.strictEqual(e.status, 0, e.stderr);
  assert.match(e.stdout, /^episodio: .*2026-11-01\n/);
  assert.match(cli(['estado', '2026-10-18'], { EPISODIOS_DIR: raiz }).stdout, /^sin actividad/);
  assert.match(cli(['aprobar', '1.1'], { EPISODIOS_DIR: raiz }).stdout, /^episodio: .*2026-11-01\n/);
});

test('estado dice el siguiente paso según lo que ya hay en el episodio', () => {
  const ep = path.join(tmp(), '2026-11-14');
  const r = EP.crearEstructura(ep);
  const poner = (ruta, texto = 'x', haceS = 0) => {
    fs.mkdirSync(path.dirname(ruta), { recursive: true });
    fs.writeFileSync(ruta, texto);
    const t = new Date(Date.now() - haceS * 1000);
    fs.utimesSync(ruta, t, t);
  };
  assert.match(AU.siguientePaso(r), /node cli\.js preparar$/);
  poner(path.join(r.originales, '2026-11-14_20-00-00', 'jc_camara.mp4'));
  assert.match(AU.siguientePaso(r), /node cli\.js analizar$/);
  poner(path.join(r.montaje, 'propuesta.md'));
  assert.match(AU.siguientePaso(r), /episodio --solo-montaje$/);
  poner(path.join(ep, 'episodio.json'), '{}', 500);
  poner(path.join(r.montaje, 'episodio.kdenlive'), 'x', 400);
  assert.match(AU.siguientePaso(r), /node cli\.js revision$/);
  poner(path.join(r.montaje, 'revision.mp4'), 'x', 300);
  assert.match(AU.siguientePaso(r), /visto bueno.*episodio --reanudar$/);
  // Un corte nuevo después de montar: toca montar otra vez antes de nada. Escribir el título, no.
  poner(path.join(r.montaje, 'config.huella'), AU.huellaDeMontaje(ep));
  poner(path.join(ep, 'episodio.json'), JSON.stringify({ titulo: 'Uno', capitulos: [{ titulo: 'Intro' }] }));
  assert.match(AU.siguientePaso(r), /visto bueno.*episodio --reanudar$/);
  poner(path.join(ep, 'episodio.json'), JSON.stringify({ titulo: 'Uno', cortes: [['1:00', '1:30']] }));
  assert.match(AU.siguientePaso(r), /cambiaron después del último montaje/);
  poner(path.join(r.montaje, 'config.huella'), AU.huellaDeMontaje(ep));
  poner(path.join(r.entrega, '2026-11-14.mp4'), 'x', 100);
  assert.match(AU.siguientePaso(r), /node cli\.js youtube$/);
  poner(path.join(r.entrega, 'youtube.md'), '# x\n\n## Pendiente\n- Falta el título\n');
  assert.match(AU.siguientePaso(r), /falta algo de YouTube/);
  poner(path.join(r.entrega, 'youtube.md'), '# x\n');
  assert.match(AU.siguientePaso(r), /vídeo final listo/);
  assert.match(AU.estado(ep).texto, /sin actividad registrada.*\nsiguiente: vídeo final listo/);
});

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('los vídeos WebM del PC llegan a originales/ ya en MP4, sin recodificar, y no se repite si no cambian', { skip: !hayFfmpeg }, () => {
  const estudio = tmp();
  const dir = path.join(estudio, 'dtp', '2026-11-20_20-00-00');
  fs.mkdirSync(dir, { recursive: true });
  const webm = path.join(dir, 'jc_camara.webm');
  const hecho = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-f', 'matroska', webm], { encoding: 'utf8' });
  assert.strictEqual(hecho.status, 0, hecho.stderr);
  fs.writeFileSync(path.join(dir, 'jc_audio.wav'), 'x');
  const startAt = Date.now() - 3600 * 1000;
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({
    room: 'dtp', id: '2026-11-20_20-00-00', createdAt: new Date(startAt).toISOString(), startAt, stopAt: startAt + 1800000,
    tracks: { 'a-camara': { file: 'jc_camara.webm', complete: true, startedAtServer: startAt + 5 }, 'a-audio': { file: 'jc_audio.wav', complete: true } },
  }));
  const [sesion] = EP.descubrirSesionesEstudio(estudio, 36);
  const originales = path.join(tmp(), 'originales');
  const r = EP.importarSesion(sesion, originales, {});
  assert.deepStrictEqual(r.hechos.map((h) => `${h.nombre}: ${h.accion}`).sort(), ['jc_audio.wav: copiado', 'jc_camara.mp4: convertido a mp4', 'session.json: copiado']);
  const mp4 = path.join(r.destino, 'jc_camara.mp4');
  assert.ok(!fs.existsSync(path.join(r.destino, 'jc_camara.webm')), 'el WebM no se copia');
  const info = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name', '-of', 'json', mp4], { encoding: 'utf8' }).stdout);
  assert.deepStrictEqual(info.streams.map((s) => s.codec_name).sort(), ['h264', 'opus'], 'mismos códecs: no se recodifica');
  assert.ok(Math.abs(Number(info.format.duration) - 2) < 0.2, 'y ahora dice cuánto dura');
  // El editor busca cada pista por su nombre en session.json: debe decir el del MP4.
  const s = JSON.parse(fs.readFileSync(path.join(r.destino, 'session.json'), 'utf8'));
  assert.strictEqual(s.tracks['a-camara'].file, 'jc_camara.mp4');
  assert.strictEqual(s.tracks['a-camara'].archivoOriginal, 'jc_camara.webm');
  assert.strictEqual(s.tracks['a-camara'].startedAtServer, startAt + 5);
  // Repetir no vuelve a convertir; si el WebM crece (terminó de subir después), sí.
  const antes = fs.statSync(mp4).mtimeMs;
  assert.ok(EP.importarSesion(sesion, originales, {}).hechos.some((h) => h.nombre === 'jc_camara.mp4' && h.accion === 'ya estaba'));
  assert.strictEqual(fs.statSync(mp4).mtimeMs, antes);
  assert.ok(EP.importarSesion({ ...sesion, archivos: sesion.archivos.map((f) => ({ ...f, bytes: f.bytes + 1 })) }, originales, {}).hechos
    .some((h) => h.nombre === 'jc_camara.mp4' && h.accion === 'convertido a mp4'));
});

test('un WebM de vídeo que quedó suelto en originales/ se convierte ahí y se aparta', { skip: !hayFfmpeg }, () => {
  const originales = path.join(tmp(), 'originales');
  const dir = path.join(originales, '2026-11-20_20-00-00');
  fs.mkdirSync(dir, { recursive: true });
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'matroska', path.join(dir, 'jc_llamada.webm')]);
  fs.writeFileSync(path.join(dir, 'jc_camara.resto-123.webm'), 'x');
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ tracks: { a: { file: 'jc_llamada.webm' } } }));
  assert.deepStrictEqual(EP.convertirWebmSueltos(originales), ['jc_llamada.webm']);
  assert.deepStrictEqual(fs.readdirSync(dir).sort(), ['.webm', 'jc_camara.resto-123.webm', 'jc_llamada.mp4', 'session.json'], 'la copia de rescate no se toca');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, '.webm')), ['jc_llamada.webm']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')).tracks.a.file, 'jc_llamada.mp4');
  assert.deepStrictEqual(EP.convertirWebmSueltos(originales), [], 'la segunda vez no hay nada que hacer');
});
