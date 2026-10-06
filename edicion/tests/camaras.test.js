'use strict';
/*
 * Cámara congelada, en negro o sin imagen: lo que se detecta (camaras.js) y cómo se cubre en el montaje
 * con la otra cámara (cortes.cubrirCamaras).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CAM = require('../camaras.js');
const C = require('../cortes.js');
const RV = require('../revision.js');

const HAY_FFMPEG = spawnSync('ffmpeg', ['-version']).status === 0;

// ------------------------------------------------------------------------------ lo que dice ffmpeg

const congelacion = (a, b) => `[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: ${a}\n`
  + `[freezedetect @ 0x1] lavfi.freezedetect.freeze_duration: ${b - a}\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: ${b}\n`;
const final = (s) => `frame=  999 fps=0.0 q=-0.0 Lsize=N/A time=00:${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(2).padStart(5, '0')} bitrate=N/A speed=90x\n`;

test('detecciones: una congelación partida por una imagen clave cuenta entera; las cortas no cuentan', () => {
  const t = CAM.leerDetecciones(congelacion(3, 4) + congelacion(4.2, 9) + congelacion(20, 22.5) + final(59.8), { duracion: 60 });
  assert.deepStrictEqual(t, [{ tipo: 'congelada', desde: 3, hasta: 9 }]);
});

test('detecciones: lo negro cuenta como negro (no también como congelado) y una congelación hasta el final se cierra', () => {
  const t = CAM.leerDetecciones(`${congelacion(10, 16)}[blackdetect @ 0x2] black_start:10 black_end:13 black_duration:3\n`
    + '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 50\n' + final(59.8), { duracion: 60 });
  assert.deepStrictEqual(t, [
    { tipo: 'en negro', desde: 10, hasta: 13 },
    { tipo: 'congelada', desde: 50, hasta: 60 },
  ], 'lo que queda de la congelación tras quitar lo negro (13-16) dura menos de 4 s');
});

test('detecciones: si el vídeo acaba antes que el archivo, lo que falta es «sin imagen»', () => {
  assert.deepStrictEqual(CAM.leerDetecciones(final(7.8), { duracion: 15 }), [{ tipo: 'sin imagen', desde: 8, hasta: 15 }]);
  assert.deepStrictEqual(CAM.leerDetecciones(final(14.8), { duracion: 15.5 }), [], 'medio segundo de diferencia es normal');
});

// ---------------------------------------------------------------------------- cubrir en el montaje

/* Receta sin cortar a 25 fps: dj y jc se turnan, cada cámara en sincronía (in = at + 100 la de dj, + 50 la de jc). */
function conversacion(planos) {
  const desfase = { cam_dj: 100, cam_jc: 50 };
  const fin = Math.max(...planos.map(([, , b]) => b));
  return {
    project: { name: 'x', fps: 25, width: 1920, height: 1080 },
    media: [{ id: 'cam_dj', path: 'dj.mp4' }, { id: 'cam_jc', path: 'jc.mp4' }, { id: 'mic_dj', path: 'dj.wav' }],
    tracks: { video: 1, audio: 1 },
    edit: [
      ...planos.map(([clip, a, b]) => ({ clip, in: a + desfase[clip], duration: b - a, at: a, audio: false })),
      { clip: 'mic_dj', in: 7, duration: fin, at: 0, audioTrack: 1 },
    ],
  };
}
const TURNOS = [['cam_dj', 0, 250], ['cam_jc', 250, 500], ['cam_dj', 500, 1000], ['cam_jc', 1000, 1250]];
const vistos = (r) => r.edit.filter((e) => !e.audioTrack).sort((a, b) => a.at - b.at).map((e) => [e.clip, e.at, e.at + e.duration, e.in - e.at]);

test('cubrir: donde la cámara de dj está congelada se ve a jc, en sincronía; el audio no se toca', () => {
  // dj congelada en los segundos 26-30 de su archivo: frames 650-750 del archivo, 550-650 del montaje.
  const r = C.cubrirCamaras(conversacion(TURNOS), [{ clip: 'cam_dj', tipo: 'congelada', desde: 26, hasta: 30 }]);
  assert.deepStrictEqual(vistos(r.receta), [
    ['cam_dj', 0, 250, 100], ['cam_jc', 250, 500, 50], ['cam_dj', 500, 550, 100],
    ['cam_jc', 550, 650, 50], ['cam_dj', 650, 1000, 100], ['cam_jc', 1000, 1250, 50],
  ]);
  assert.deepStrictEqual(r.vetos, { cam_dj: [[550, 650]] });
  assert.deepStrictEqual(r.cubiertos, [{ clip: 'cam_dj', tipo: 'congelada', desde: 550, hasta: 650, visto: true, con: 'cam_jc', quedan: 0 }]);
  assert.deepStrictEqual(r.receta.edit.filter((e) => e.audioTrack), conversacion(TURNOS).edit.filter((e) => e.audioTrack));
});

test('cubrir: un resto de plano de un instante junto al tramo también se cubre (no queda un destello)', () => {
  // Del frame 510 al 650: antes quedarían 10 frames de dj (500-510), menos de 0,6 s.
  const r = C.cubrirCamaras(conversacion(TURNOS), [{ clip: 'cam_dj', tipo: 'en negro', desde: 24.4, hasta: 30 }]);
  assert.deepStrictEqual(vistos(r.receta).slice(1, 3), [['cam_jc', 250, 650, 50], ['cam_dj', 650, 1000, 100]]);
});

test('cubrir: si la otra cámara tampoco tiene imagen en parte del tramo, se cubre lo que se puede y se dice cuánto queda', () => {
  const r = C.cubrirCamaras(conversacion(TURNOS), [
    { clip: 'cam_dj', tipo: 'congelada', desde: 26, hasta: 30 },  // montaje 550-650
    { clip: 'cam_jc', tipo: 'en negro', desde: 26, hasta: 30 },   // montaje 600-700
  ]);
  assert.deepStrictEqual(vistos(r.receta).slice(2, 5), [['cam_dj', 500, 550, 100], ['cam_jc', 550, 600, 50], ['cam_dj', 600, 1000, 100]]);
  const dj = r.cubiertos.find((c) => c.clip === 'cam_dj');
  assert.deepStrictEqual([dj.con, dj.quedan], ['cam_jc', 50]);
  assert.strictEqual(CAM.textoDeCamara(dj, 25), 'cámara de dj congelada (4 s): se ve a jc; 2 s sin otra cámara');
  // La de jc no se veía en ese momento: no hay nada que cubrir.
  const jc = r.cubiertos.find((c) => c.clip === 'cam_jc');
  assert.deepStrictEqual([jc.visto, CAM.textoDeCamara(jc, 25)], [false, 'cámara de jc en negro (4 s): no salía en el montaje']);
});

test('cubrir: los saltos disimulados no vuelven a poner una cámara vetada', () => {
  const corte = [{ desde: 600 / 25, hasta: 700 / 25 }];
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), corte).disimulados, 1);
  assert.strictEqual(C.disimularSaltos(conversacion(TURNOS), corte, { vetos: { cam_jc: [[690, 760]] } }).disimulados, 0);
});

test('guías ⚠: una por tramo cubierto que se veía, salvo si cae entero en un corte; si empieza dentro, tras el corte', () => {
  const c = { clip: 'cam_dj', tipo: 'congelada', desde: 550, hasta: 650, visto: true, con: 'cam_jc', quedan: 0 };
  assert.deepStrictEqual(CAM.guiasDeCamaras([c, { ...c, visto: false }], 25, []),
    [{ at: 550, name: '⚠ cámara de dj congelada (4 s): se ve a jc', color: 'Orange' }]);
  assert.deepStrictEqual(CAM.guiasDeCamaras([c], 25, [{ desde: 500, hasta: 700 }]), []);
  assert.deepStrictEqual(CAM.guiasDeCamaras([c], 25, [{ desde: 500, hasta: 600 }]).map((g) => g.at), [600]);
});

test('revisión: los avisos ⚠ también salen en el vídeo de revisión', () => {
  const receta = { ...conversacion(TURNOS), guides: [{ at: 550, name: '⚠ cámara de dj congelada (4 s): se ve a jc', color: 'Orange' }] };
  const { trozos } = RV.trozosDeRevision(receta, {});
  const t = trozos.find((x) => x.empalmes.includes(550));
  assert.ok(t, JSON.stringify(trozos));
  assert.deepStrictEqual(t.textos, ['cámara de dj congelada (4 s): se ve a jc']);
  assert.doesNotMatch(RV.etiqueta(t, 25), /⚠/);
});

// ------------------------------------------------------------------------ con vídeo de verdad

/*
 * Un vídeo de prueba de 12 s a 320x180, a 300 kb/s: lo mismo por píxel que los 10 Mb/s a los que graba el
 * Estudio en 1080p. Con mucha menos calidad el compresor se come el ruido de una imagen quieta y deja
 * imágenes idénticas, que no se distinguen de una cámara colgada.
 */
function clip(dir, nombre, filtro, entrada = 'testsrc2=size=320x180:rate=25:duration=12', extra = []) {
  const f = path.join(dir, nombre);
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', entrada, '-filter_complex', filtro, ...extra,
    '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '300k', '-g', '50', '-pix_fmt', 'yuv420p', f], { encoding: 'utf8' });
  assert.strictEqual(res.status, 0, res.stderr);
  return f;
}

test('con vídeo: encuentra la imagen congelada y la negra, y no confunde una imagen quieta con ruido de cámara',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camaras-'));
    // La cámara se cuelga y a la página no le llega imagen: en el archivo hay un hueco sin imágenes (5-10 s).
    const hueco = clip(dir, 'hueco.mp4', "[0:v]setpts='if(gte(N,125),PTS+5/TB,PTS)'", 'testsrc2=size=320x180:rate=25:duration=10',
      ['-fps_mode', 'passthrough']);
    assert.deepStrictEqual(CAM.analizarCamara(hueco).tramos, [{ tipo: 'congelada', desde: 5, hasta: 10 }]);
    // La cámara manda la misma imagen una y otra vez (2-8 s): al principio el compresor aún la va afinando
    // (cambia muy poco), así que se pilla casi toda.
    const congelada = clip(dir, 'congelada.mp4', '[0:v]split[a][b];[a][b]freezeframes=first=50:last=200:replace=50');
    const [t] = CAM.analizarCamara(congelada).tramos;
    assert.ok(t && t.tipo === 'congelada' && t.desde >= 2 && t.desde <= 4.2 && Math.abs(t.hasta - 8) <= 0.4, JSON.stringify(t));
    const negra = clip(dir, 'negra.mp4', "[0:v]drawbox=c=black:t=fill:enable='between(t,6,9)'");
    assert.deepStrictEqual(CAM.analizarCamara(negra).tramos, [{ tipo: 'en negro', desde: 6, hasta: 9 }]);
    // Una imagen quieta pero viva (con el ruido de una cámara) no está congelada.
    const quieta = clip(dir, 'quieta.mp4', "[0:v]geq=lum='128+40*sin(X/20)*cos(Y/15)':cb=128:cr=128,noise=alls=4:allf=t",
      'color=c=gray:size=320x180:rate=25:duration=12');
    assert.deepStrictEqual(CAM.analizarCamara(quieta).tramos, []);

    // Lo analizado se guarda: la segunda vez no se vuelve a mirar el archivo.
    const receta = { media: [{ id: 'cam_dj', path: hueco }, { id: 'mic_dj', path: hueco }] };
    const cache = path.join(dir, 'camaras.json');
    const mirados = [];
    const uno = CAM.problemasDeCamaras(receta, { cache, log: (x) => mirados.push(x) });
    assert.deepStrictEqual(uno.problemas, [{ clip: 'cam_dj', tipo: 'congelada', desde: 5, hasta: 10 }]);
    const dos = CAM.problemasDeCamaras(receta, { cache, log: (x) => mirados.push(x) });
    assert.deepStrictEqual(dos.problemas, uno.problemas);
    assert.strictEqual(mirados.length, 1, mirados.join('\n'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
