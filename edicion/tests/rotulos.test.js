'use strict';
/* Rótulos con el nombre: dónde se ponen y el vídeo con transparencia que se hace con ffmpeg. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RO = require('../rotulos.js');

const HAY_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

/* Receta final a 25 fps (ya unida: clips con p1_), con un plano doble de 300 a 400 (dj a la derecha en V2). */
function receta() {
  const plano = (clip, a, b, extra) => ({ clip, in: a + 100, at: a, duration: b - a, audio: false, ...extra });
  return {
    project: { name: 'x', fps: 25, width: 1920, height: 1080 },
    media: [{ id: 'p1_cam_dj', path: 'dj.mp4' }, { id: 'p1_cam_jc', path: 'jc.mp4' }, { id: 'p1_mic_dj', path: 'dj.wav' }],
    tracks: { video: 2, audio: 1 },
    edit: [
      plano('p1_cam_dj', 0, 100), plano('p1_cam_jc', 100, 300),
      plano('p1_cam_jc', 300, 400, { zoom: 0.5, pan: -480 }), plano('p1_cam_dj', 300, 400, { zoom: 0.5, pan: 480, track: 2 }),
      plano('p1_cam_dj', 400, 700), plano('p1_cam_jc', 700, 900),
      { clip: 'p1_mic_dj', in: 0, at: 0, duration: 900, audioTrack: 1 },
    ],
  };
}

test('rótulos: en el primer plano de cada uno solo en que quepa (no en el plano doble ni antes del segundo 3)', () => {
  const r = RO.colocarRotulos(receta(), [{ persona: 'dj', archivo: 'dj.mov' }, { persona: 'jc', archivo: 'jc.mov' }], { segundos: 4, desde: 3 });
  // dj: su primer plano (0-100) acaba antes de que quepan 4 s desde el segundo 3; el siguiente solo es el de 400.
  assert.deepStrictEqual(r.puestos, [{ persona: 'dj', at: 413 }, { persona: 'jc', at: 113 }]);  // medio segundo: 13 frames
  // En la pista V3 y en orden de tiempo (si no, la pista los tomaría por solapados).
  const v3 = r.receta.edit.filter((e) => e.track === 3);
  assert.deepStrictEqual(v3, [
    { clip: 'rotulo_jc', in: 0, at: 113, duration: 100, track: 3, audio: false },
    { clip: 'rotulo_dj', in: 0, at: 413, duration: 100, track: 3, audio: false },
  ]);
  assert.deepStrictEqual(r.receta.media.slice(-2), [{ id: 'rotulo_dj', path: 'dj.mov' }, { id: 'rotulo_jc', path: 'jc.mov' }]);
  assert.strictEqual(r.receta.tracks.video, 3);
  // Si no hay sitio, se dice.
  const largo = RO.colocarRotulos(receta(), [{ persona: 'dj', archivo: 'dj.mov' }], { segundos: 20 });
  assert.deepStrictEqual([largo.puestos, largo.sinSitio], [[], ['dj']]);
});

test('rótulo: un vídeo con transparencia, con fundidos, que se reutiliza si no cambia',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotulos-'));
    const a = RO.hacerRotulo('José «JC» Rodríguez: 100%', { dir, ancho: 320, alto: 180, fps: 25, segundos: 2 });
    assert.ok(a.archivo && fs.existsSync(a.archivo), JSON.stringify(a));
    const info = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-count_frames', '-show_entries', 'stream=codec_name,pix_fmt,width,nb_read_frames',
      '-of', 'csv=p=0', a.archivo], { encoding: 'utf8' }).stdout.trim();
    assert.strictEqual(info, 'qtrle,320,argb,50');
    // Transparente fuera de la caja; en mitad del rótulo, la caja se ve; al principio, aún no (fundido).
    const alfa = (t) => Number(spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(t), '-i', a.archivo, '-frames:v', '1', '-vf',
      'alphaextract,crop=40:12:16:146,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
      .match(/YAVG=([\d.]+)/)[1]);
    assert.ok(alfa(1) > 150, `caja a la mitad: ${alfa(1)}`);
    assert.ok(alfa(0) < 30, `al principio: ${alfa(0)}`);
    const esquina = Number(spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', '1', '-i', a.archivo, '-frames:v', '1', '-vf',
      'alphaextract,crop=40:40:270:0,signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' }).stderr
      .match(/YAVG=([\d.]+)/)[1]);
    assert.strictEqual(esquina, 0, 'arriba a la derecha no hay nada');
    const mtime = fs.statSync(a.archivo).mtimeMs;
    const b = RO.hacerRotulo('José «JC» Rodríguez: 100%', { dir, ancho: 320, alto: 180, fps: 25, segundos: 2 });
    assert.deepStrictEqual([b.archivo, fs.statSync(b.archivo).mtimeMs], [a.archivo, mtime]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
