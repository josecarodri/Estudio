'use strict';
/* Limpiar el disco: qué se borra (y qué nunca), las copias del Estudio y que sin --confirmar no se toca nada. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LI = require('../limpieza.js');
const EP = require('../episodio.js');
const AU = require('../auto.js');

const CLI = path.join(__dirname, '..', 'cli.js');

/* Un episodio terminado, con lo que deja el proceso, y el Estudio con dos sesiones (una copiada entera, otra no). */
function episodio() {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'limpiar-'));
  const ep = path.join(raiz, '2026-10-10');
  const estudio = path.join(raiz, 'grabaciones');
  const poner = (ruta, bytes) => { fs.mkdirSync(path.dirname(ruta), { recursive: true }); fs.writeFileSync(ruta, Buffer.alloc(bytes)); };
  poner(path.join(ep, 'montaje', 'episodio-bruto.mp4'), 5000);
  poner(path.join(ep, 'montaje', 'revision', 'trozo-abc.mp4'), 300);
  poner(path.join(ep, 'montaje', 'revision.mp4'), 200);
  poner(path.join(ep, 'montaje', 'shorts', 'vertical-1.mp4'), 400);
  poner(path.join(ep, 'montaje', 'audio', 'parte-1-dj_audio.limpio-1a2b3c4d.wav'), 100);
  poner(path.join(ep, 'montaje', 'parte-1', 'llamada-unida.wav'), 150);
  poner(path.join(ep, 'montaje', 'parte-1', 'multicam.json'), 10);
  poner(path.join(ep, 'montaje', 'episodio.kdenlive'), 10);
  poner(path.join(ep, 'montaje', 'episodio.kdenlive.editado-123'), 10);
  poner(path.join(ep, 'entrega', '2026-10-10.mp4'), 3000);
  for (const [sesion, tamanos] of [['2026-10-10_21-30-05', [700, 800]], ['2026-10-10_22-40-00', [600, 900]]]) {
    poner(path.join(ep, 'originales', sesion, 'dj_camara.mp4'), tamanos[0]);
    poner(path.join(ep, 'originales', sesion, 'dj_audio.wav'), tamanos[1]);
    poner(path.join(estudio, 'dtp', sesion, 'session.json'), 5);
    poner(path.join(estudio, 'dtp', sesion, 'dj_camara.mp4'), tamanos[0]);
  }
  // En la segunda sesión, el audio del Estudio no coincide con el de originales/ (copia a medias): se queda.
  poner(path.join(estudio, 'dtp', '2026-10-10_22-40-00', 'dj_audio.wav'), 950);
  poner(path.join(estudio, 'dtp', '2026-10-10_21-30-05', 'dj_audio.wav'), 800);
  return { raiz, ep, estudio };
}

test('limpiar: lo que se puede rehacer, y del Estudio solo lo que ya está copiado igual en originales/', () => {
  const { ep, estudio } = episodio();
  const r = EP.rutas(ep);
  const cosas = LI.queBorrar(r, { estudio });
  const rel = (c) => path.relative(path.dirname(ep), c.ruta).split(path.sep).join('/');
  assert.deepStrictEqual(cosas.map(rel).sort(), [
    '2026-10-10/montaje/audio/parte-1-dj_audio.limpio-1a2b3c4d.wav',
    '2026-10-10/montaje/episodio-bruto.mp4',
    '2026-10-10/montaje/parte-1/llamada-unida.wav',
    '2026-10-10/montaje/revision',
    '2026-10-10/montaje/revision.mp4',
    '2026-10-10/montaje/shorts',
    'grabaciones/dtp/2026-10-10_21-30-05',                 // copiada entera: la carpeta
    'grabaciones/dtp/2026-10-10_22-40-00/dj_camara.mp4',   // de esta, solo lo que coincide
  ]);
  assert.strictEqual(cosas.find((c) => rel(c).endsWith('/revision')).bytes, 300);
  const b = LI.borrar(cosas);
  assert.strictEqual(b.errores.length, 0);
  for (const queda of ['montaje/episodio.kdenlive', 'montaje/episodio.kdenlive.editado-123', 'montaje/parte-1/multicam.json', 'entrega/2026-10-10.mp4',
    'originales/2026-10-10_21-30-05/dj_audio.wav']) assert.ok(fs.existsSync(path.join(ep, queda)), queda);
  assert.ok(fs.existsSync(path.join(estudio, 'dtp', '2026-10-10_22-40-00', 'dj_audio.wav')), 'lo que no coincide se queda');
  assert.deepStrictEqual(LI.queBorrar(r, { estudio }), [], 'nada más que limpiar');
});

test('limpiar (orden): sin el episodio listo no hace nada; sin --confirmar solo lo enseña', () => {
  const { ep, estudio } = episodio();
  const cli = (...a) => spawnSync(process.execPath, [CLI, 'limpiar', ep, ...a], { encoding: 'utf8' });
  assert.strictEqual(cli().status, 3);
  AU.marcarFase(EP.rutas(ep), 'listo');
  const ver = cli('--estudio', estudio);
  assert.strictEqual(ver.status, 0, ver.stderr);
  assert.match(ver.stdout, /se liberarían 0\.00 GB\. No he borrado nada/);
  assert.ok(fs.existsSync(path.join(ep, 'montaje', 'episodio-bruto.mp4')));
  const si = cli('--estudio', estudio, '--confirmar');
  assert.strictEqual(si.status, 0, si.stderr);
  assert.match(si.stdout, /liberados/);
  assert.ok(!fs.existsSync(path.join(ep, 'montaje', 'episodio-bruto.mp4')));
  assert.ok(!fs.existsSync(path.join(estudio, 'dtp', '2026-10-10_21-30-05')));
});
