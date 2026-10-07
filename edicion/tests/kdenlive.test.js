/*
 * Pruebas del backend de Kdenlive (edicion/).
 *
 * El generador de XML se prueba sin dependencias. Las pruebas que necesitan ffmpeg o
 * melt se saltan solas si no están instalados, pero cuando lo están comprueban lo que
 * de verdad importa: que el proyecto generado se renderiza y que dura lo que debe.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TOOL = path.join(__dirname, '..');
const P = require(path.join(TOOL, 'project.js'));
const R = require(path.join(TOOL, 'recipe.js'));
const CLI = require(path.join(TOOL, 'cli.js'));
const SY = require(path.join(TOOL, 'sync.js'));
const MC = require(path.join(TOOL, 'multicam.js'));
const AN = require(path.join(TOOL, 'analisis.js'));
const CAL = require(path.join(TOOL, 'calibrar.js'));
const SESION = require(path.join(TOOL, 'tests', 'sesion-falsa.js'));
const CUT = require(path.join(TOOL, 'cortes.js'));

function tieneBinario(bin, flag) {
  const res = spawnSync(bin, [flag || '-version'], { encoding: 'utf8', timeout: 15000 });
  return !res.error;
}

const HAY_FFMPEG = tieneBinario('ffmpeg') && tieneBinario('ffprobe');
// Como el programa: en Windows el melt de Kdenlive no está en el PATH.
const HAY_MELT = Boolean(CLI.buscarBinario('melt'));

/* Media ya "leída", para probar el generador sin tocar disco. */
function mediaFalsa(frames) {
  return {
    a: { path: '/v/a.mp4', name: 'a.mp4', frames: frames || 250, fps: 25, width: 1920, height: 1080, hasVideo: true, hasAudio: true, videoIndex: 0, audioIndex: 1 },
    b: { path: '/v/b.mp4', name: 'b.mp4', frames: frames || 250, fps: 25, width: 1920, height: 1080, hasVideo: true, hasAudio: true, videoIndex: 0, audioIndex: 1 },
  };
}

function receta(extra) {
  return {
    project: { name: 'P', fps: 25, width: 1920, height: 1080 },
    media: [{ id: 'a', path: '/v/a.mp4' }, { id: 'b', path: '/v/b.mp4' }],
    timeline: { name: 'T' },
    edit: [{ clip: 'a', in: 0, out: 49 }, { clip: 'b', in: 0, out: 49 }],
    ...extra,
  };
}

function construir(recipe, opts) {
  return P.buildProject(recipe, { media: mediaFalsa(), fps: 25, ...opts });
}

// ------------------------------------------------------------------ tiempo

test('toFrames entiende frames, timecode y segundos', () => {
  assert.equal(P.toFrames(50, 25), 50);
  assert.equal(P.toFrames('50', 25), 50);
  assert.equal(P.toFrames('00:00:02:00', 25), 50);
  assert.equal(P.toFrames('00:01:00:00', 25), 1500);
  assert.equal(P.toFrames('01:00', 25), 1500);
  assert.equal(P.toFrames('2s', 25), 50);
  assert.equal(P.toFrames('1.5s', 30), 45);
  assert.equal(P.toFrames(null, 25), null);
  assert.throws(() => P.toFrames('luego', 25, 'edit[0].in'), /edit\[0\]\.in/);
});

test('framesToTc es el inverso', () => {
  assert.equal(P.framesToTc(50, 25), '00:00:02:00');
  assert.equal(P.framesToTc(0, 25), '00:00:00:00');
  for (const tc of ['00:00:00:00', '00:00:07:13', '00:03:21:05']) {
    assert.equal(P.framesToTc(P.toFrames(tc, 25), 25), tc);
  }
});

test('fpsFraction da la fracción exacta para los fps habituales', () => {
  assert.deepEqual(P.fpsFraction(25), [25, 1]);
  assert.deepEqual(P.fpsFraction(30), [30, 1]);
  assert.deepEqual(P.fpsFraction(29.97), [30000, 1001]);
  assert.deepEqual(P.fpsFraction(23.976), [24000, 1001]);
  assert.deepEqual(P.fpsFraction(59.94), [60000, 1001]);
});

test('displayAspect reduce la proporción', () => {
  assert.deepEqual(P.displayAspect(1920, 1080), [16, 9]);
  assert.deepEqual(P.displayAspect(1080, 1920), [9, 16]);
  assert.deepEqual(P.displayAspect(640, 480), [4, 3]);
});

test('escapeXml protege el XML de rutas y nombres raros', () => {
  assert.equal(P.escapeXml('a & b'), 'a &amp; b');
  assert.equal(P.escapeXml('<x>'), '&lt;x&gt;');
  assert.equal(P.escapeXml('di "hola"'), 'di &quot;hola&quot;');
  assert.equal(P.escapeXml("O'Brien"), 'O&apos;Brien');
});

// --------------------------------------------------------------- disposición

test('los cortes se encadenan uno detrás de otro', () => {
  const { tracks } = P.layout(receta(), mediaFalsa(), 25);
  const items = tracks.get(1).items;
  assert.equal(items.length, 2);
  assert.deepEqual([items[0].start, items[0].end], [0, 49]);
  assert.deepEqual([items[1].start, items[1].end], [50, 99]);
});

test('"at" coloca el corte y deja hueco', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 24 }, { clip: 'b', in: 0, out: 24, at: 100 }] });
  const items = P.layout(r, mediaFalsa(), 25).tracks.get(1).items;
  assert.equal(items[1].start, 100);
  const { xml } = construir(r);
  assert.match(xml, /<blank length="75"\/>/);
});

test('un "at" que pisa el corte anterior se rechaza con una explicación', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 49 }, { clip: 'b', in: 0, out: 49, at: 20 }] });
  assert.throws(() => P.layout(r, mediaFalsa(), 25), /se solapa.*dissolve/s);
});

test('el encadenado solapa los clips y usa la otra sub-lista', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 49 }, { clip: 'b', in: 0, out: 49, dissolve: 25 }] });
  const track = P.layout(r, mediaFalsa(), 25).tracks.get(1);
  const [primero, segundo] = track.items;
  assert.equal(primero.sub, 0);
  assert.equal(segundo.sub, 1, 'el clip que se solapa va a la sub-lista 1');
  assert.equal(segundo.start, 25, 'empieza 25 frames antes de que acabe el anterior');
  assert.equal(track.mixes.length, 1);
  assert.deepEqual([track.mixes[0].in, track.mixes[0].out], [25, 49]);
});

test('varios encadenados seguidos alternan sub-listas', () => {
  const r = receta({
    edit: [
      { clip: 'a', in: 0, out: 49 },
      { clip: 'b', in: 0, out: 49, dissolve: 10 },
      { clip: 'a', in: 0, out: 49, dissolve: 10 },
    ],
  });
  const track = P.layout(r, mediaFalsa(), 25).tracks.get(1);
  assert.deepEqual(track.items.map((i) => i.sub), [0, 1, 0]);
  assert.equal(track.mixes.length, 2);
});

test('un encadenado más largo que los clips se rechaza', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 24 }, { clip: 'b', in: 0, out: 49, dissolve: 30 }] });
  assert.throws(() => P.layout(r, mediaFalsa(), 25), /no cabe/);
});

test('un encadenado sin corte anterior se rechaza', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 49, dissolve: 10 }] });
  assert.throws(() => P.layout(r, mediaFalsa(), 25), /no hay un corte anterior/);
});

test('un "out" que se pasa del final del clip se rechaza con los dos tiempos', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 9999 }] });
  assert.throws(() => P.layout(r, mediaFalsa(250), 25), /pasa del final del clip "a"/);
});

test('con velocidad, el límite del clip se ajusta', () => {
  // 250 frames a 2x caben en 125 de timeline.
  const ok = receta({ edit: [{ clip: 'a', in: 0, out: 124, speed: 2 }] });
  assert.doesNotThrow(() => P.layout(ok, mediaFalsa(250), 25));
  const mal = receta({ edit: [{ clip: 'a', in: 0, out: 200, speed: 2 }] });
  assert.throws(() => P.layout(mal, mediaFalsa(250), 25), /velocidad 2x/);
});

test('un fundido más largo que el corte se rechaza', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 24, fadeIn: 50 }] });
  assert.throws(() => P.layout(r, mediaFalsa(), 25), /fadeIn.*no cabe/);
});

test('las pistas altas se crean solas', () => {
  const r = receta({ edit: [{ clip: 'a', in: 0, out: 24 }, { clip: 'b', in: 0, out: 24, track: 3 }] });
  const { summary } = construir(r);
  assert.equal(summary.videoTracks, 3);
});

// ------------------------------------------------------------ XML generado

test('el proyecto tiene la estructura que espera Kdenlive', () => {
  const { xml } = construir(receta());
  assert.match(xml, /^<\?xml version='1\.0' encoding='utf-8'\?>/);
  assert.match(xml, /<mlt[^>]*producer="main_bin"/);
  assert.match(xml, /<profile[^>]*frame_rate_num="25"[^>]*frame_rate_den="1"/);
  assert.match(xml, /<playlist id="main_bin">/);
  assert.match(xml, /kdenlive:docproperties\.version">1\.1</);
  assert.match(xml, /<producer id="black_track"/);
  assert.match(xml, /kdenlive:projectTractor">1</);
  // El envoltorio del proyecto es lo último, como en los proyectos reales.
  assert.ok(xml.lastIndexOf('kdenlive:projectTractor') > xml.lastIndexOf('kdenlive:uuid'));
});

test('cada pista son dos sub-listas y un tractor', () => {
  const { xml, summary } = construir(receta({ tracks: { video: 2, audio: 2 } }));
  const playlists = xml.match(/<playlist id="playlist\d+"/g) || [];
  assert.equal(playlists.length, (summary.videoTracks + summary.audioTracks) * 2);
  const tractores = xml.match(/<tractor id="tractor\d+"/g) || [];
  assert.equal(tractores.length, summary.videoTracks + summary.audioTracks + 1);
});

test('el montaje lleva fondo negro, mezcla en audio y composición en vídeo', () => {
  const { xml } = construir(receta());
  assert.match(xml, /<track producer="black_track"\/>/);
  assert.equal((xml.match(/mlt_service">mix</g) || []).length, 2, 'una mezcla por pista de audio');
  assert.equal((xml.match(/mlt_service">qtblend</g) || []).length, 2, 'una composición por pista de vídeo');
});

test('se puede cambiar el servicio de composición', () => {
  const { xml } = construir(receta(), { compositing: 'frei0r.cairoblend' });
  assert.match(xml, /mlt_service">frei0r\.cairoblend</);
  assert.doesNotMatch(xml, /mlt_service">qtblend</);
});

test('el audio del clip se duplica en la pista de audio', () => {
  const { xml } = construir(receta({ edit: [{ clip: 'a', in: 10, out: 59 }] }));
  const entradas = xml.match(/<entry producer="chain0" in="10" out="59">/g) || [];
  assert.equal(entradas.length, 2, 'una entrada en vídeo y otra en audio');
});

test('audio:false deja el corte solo en vídeo', () => {
  const { xml } = construir(receta({ edit: [{ clip: 'a', in: 10, out: 59, audio: false }] }));
  const entradas = xml.match(/<entry producer="chain0" in="10" out="59">/g) || [];
  assert.equal(entradas.length, 1);
});

test('los fundidos salen como filtros de brillo y de volumen', () => {
  const { xml } = construir(receta({ edit: [{ clip: 'a', in: 0, out: 49, fadeIn: 12, fadeOut: 12 }] }));
  assert.match(xml, /kdenlive_id">fade_from_black</);
  assert.match(xml, /kdenlive_id">fade_to_black</);
  assert.match(xml, /kdenlive_id">fadein</);
  assert.match(xml, /kdenlive_id">fadeout</);
  // El volumen se anima en dB: gain/end están obsoletos y MLT los ignora si hay level.
  assert.match(xml, /name="level">0=-60;-1=0</);
  assert.match(xml, /name="level">0=0;-1=-60</);
});

test('el reencuadre sale como rectángulo de qtblend centrado', () => {
  const { xml } = construir(receta({
    project: { fps: 25, width: 1080, height: 1920 },
    edit: [{ clip: 'a', in: 0, out: 49, zoom: 2 }],
  }));
  // zoom 2 en 1080x1920 => 2160x3840 centrado => origen en -540,-960
  assert.match(xml, /name="rect">0=-540 -960 2160 3840 1</);
});

test('la opacidad se escribe en el rectángulo', () => {
  const { xml } = construir(receta({ edit: [{ clip: 'a', in: 0, out: 49, opacity: 50 }] }));
  assert.match(xml, /name="rect">0=0 0 1920 1080 0\.5</);
});

test('transform[] (reencuadre por número de corte) también funciona', () => {
  const { xml } = construir(receta({
    edit: [{ clip: 'a', in: 0, out: 49 }],
    transform: [{ index: 1, zoom: 2 }],
  }));
  assert.match(xml, /mlt_service">qtblend</);
  assert.match(xml, /name="rect">0=-960 -540 3840 2160 1</);
});

test('la velocidad usa un producer timewarp', () => {
  const { xml } = construir(receta({ edit: [{ clip: 'a', in: 0, out: 49, speed: 2 }] }));
  assert.match(xml, /mlt_service">timewarp</);
  assert.match(xml, /name="resource">2:\/v\/a\.mp4</);
  assert.match(xml, /name="warp_speed">2</);
});

test('las marcas se escriben como guías de la secuencia', () => {
  const { xml } = construir(receta({ guides: [{ at: 50, name: 'aquí', color: 'Red' }] }));
  assert.match(xml, /sequenceproperties\.guides/);
  const json = JSON.parse(xml.match(/guides">([^<]+)</)[1].replace(/&quot;/g, '"'));
  assert.deepEqual(json, [{ comment: 'aquí', pos: 50, type: 1 }]);
});

test('markers[] vale como guides', () => {
  const { xml } = construir(receta({ markers: [{ at: '00:00:02:00', name: 'x' }] }));
  const json = JSON.parse(xml.match(/guides">([^<]+)</)[1].replace(/&quot;/g, '"'));
  assert.equal(json[0].pos, 50);
});

test('el resumen cuenta lo que hay', () => {
  const { summary } = construir(receta({
    edit: [
      { clip: 'a', in: 0, out: 49, fadeIn: 10 },
      { clip: 'b', in: 0, out: 49, dissolve: 10 },
    ],
  }));
  assert.equal(summary.cuts, 2);
  assert.equal(summary.mixes, 1);
  assert.equal(summary.fades, 1);
  assert.equal(summary.frames, 90, '50 + 50 - 10 de solape');
  assert.equal(summary.duration, '00:00:03:15');
});

test('una ruta con & o comillas no rompe el XML', () => {
  const media = mediaFalsa();
  media.a.path = '/v/A & B "raro".mp4';
  const { xml } = P.buildProject(receta({ edit: [{ clip: 'a', in: 0, out: 10 }] }), { media, fps: 25 });
  assert.match(xml, /name="resource">\/v\/A &amp; B &quot;raro&quot;\.mp4</);
  assert.doesNotMatch(xml, /resource">[^<]*[^;]"[^<]*</);
});

// ------------------------------------------------- clips de solo audio

function mediaMulti() {
  const cam = (p) => ({ path: p, name: p, frames: 750, fps: 25, width: 1920, height: 1080, hasVideo: true, hasAudio: true, videoIndex: 0, audioIndex: 1 });
  const mic = (p) => ({ path: p, name: p, frames: 750, hasVideo: false, hasAudio: true, audioIndex: 0 });
  return { cam_dj: cam('/v/dj.mp4'), cam_jc: cam('/v/jc.mp4'), mic_dj: mic('/v/dj.wav'), mic_jc: mic('/v/jc.wav') };
}

test('un archivo sin vídeo no ocupa pista de vídeo', () => {
  const media = mediaMulti();
  const r = {
    project: { fps: 25 },
    media: Object.keys(media).map((id) => ({ id, path: media[id].path })),
    edit: [
      { clip: 'cam_dj', in: 0, duration: 100, audio: false },
      { clip: 'mic_dj', in: 0, duration: 500, at: 0 },
    ],
  };
  const { summary } = P.buildProject(r, { media, fps: 25 });
  // Si el .wav se hubiera puesto en la pista de vídeo, la duración sería 600.
  assert.equal(summary.frames, 500);
});

test('audioTrack elige la pista de audio', () => {
  const media = mediaMulti();
  const r = {
    project: { fps: 25 },
    media: Object.keys(media).map((id) => ({ id, path: media[id].path })),
    edit: [
      { clip: 'mic_dj', in: 0, duration: 100, at: 0, audioTrack: 1 },
      { clip: 'mic_jc', in: 0, duration: 100, at: 0, audioTrack: 2 },
    ],
  };
  const { xml, summary } = P.buildProject(r, { media, fps: 25 });
  assert.equal(summary.audioTracks, 2);
  // Cada micro en su pista: se comprueba por el orden de emisión (A2 antes que A1).
  const cuerpo = xml.slice(xml.indexOf('</playlist>', xml.indexOf('main_bin')));
  const a2 = cuerpo.indexOf('chain1');
  const a1 = cuerpo.indexOf('chain0');
  assert.ok(a2 < a1, 'A2 (el segundo micro) se emite antes que A1');
});

test('video:false manda un clip con imagen solo a la pista de audio', () => {
  const media = mediaMulti();
  const r = {
    project: { fps: 25 },
    media: [{ id: 'cam_dj', path: '/v/dj.mp4' }],
    edit: [{ clip: 'cam_dj', in: 0, duration: 100, video: false }],
  };
  const { summary } = P.buildProject(r, { media, fps: 25 });
  assert.equal(summary.cuts, 1);
  const cuerpo = r.edit[0];
  assert.equal(cuerpo.video, false);
});

test('audioTrack y video son claves válidas, no desconocidas', () => {
  const { errors, warnings } = R.validate({
    media: [{ id: 'a', path: '/a.wav' }],
    edit: [{ clip: 'a', in: 0, out: 10, audioTrack: 2, video: false }],
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings.filter((w) => /desconocida/.test(w)), []);
});

test('audioTrack tiene que ser un entero >= 1', () => {
  const malos = [0, -1, 1.5];
  for (const v of malos) {
    const { errors } = R.validate({
      media: [{ id: 'a', path: '/a.wav' }],
      edit: [{ clip: 'a', in: 0, out: 10, audioTrack: v }],
    });
    assert.ok(errors.some((e) => /audioTrack/.test(e)), `debería rechazar ${v}`);
  }
});

// ------------------------------------------------------ sincronía de audio

test('la FFT y su inversa devuelven la señal original', () => {
  const n = 16;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i += 1) re[i] = Math.sin(i) + i * 0.1;
  const original = Array.from(re);
  SY.fft(re, im, false);
  SY.fft(re, im, true);
  for (let i = 0; i < n; i += 1) {
    assert.ok(Math.abs(re[i] - original[i]) < 1e-9, `muestra ${i}`);
  }
});

test('nextPow2', () => {
  assert.equal(SY.nextPow2(1), 1);
  assert.equal(SY.nextPow2(5), 8);
  assert.equal(SY.nextPow2(1024), 1024);
  assert.equal(SY.nextPow2(1025), 2048);
});

test('normalize centra y escala la envolvente', () => {
  const env = new Float64Array([1, 2, 3, 4, 5]);
  const out = SY.normalize(env);
  const media = Array.from(out).reduce((a, b) => a + b, 0) / out.length;
  assert.ok(Math.abs(media) < 1e-12, 'media cero');
  const sd = Math.sqrt(Array.from(out).reduce((a, b) => a + b * b, 0) / out.length);
  assert.ok(Math.abs(sd - 1) < 1e-12, 'desviación uno');
});

/* Envolvente con forma reconocible: ráfagas de amplitud irregular, como el habla. */
function envolventeFalsa(bins, semilla) {
  const rnd = SESION.aleatorio(semilla || 3);
  const out = new Float64Array(bins);
  let i = 0;
  while (i < bins) {
    const largo = 5 + Math.floor(rnd() * 25);
    const amp = 0.1 + rnd() * 0.9;
    for (let k = 0; k < largo && i < bins; k += 1, i += 1) out[i] = amp;
    i += 3 + Math.floor(rnd() * 20);
  }
  return out;
}

test('offsetBetween recupera el desfase, con el signo correcto', () => {
  const base = envolventeFalsa(3000, 11);
  for (const desfase of [0, 37, 150, 400]) {
    // "other" empieza más tarde: le falta el principio.
    const other = base.slice(desfase);
    const r = SY.offsetBetween(base, other);
    assert.equal(r.lagBins, desfase, `desfase de ${desfase} bins`);
    assert.ok(r.confidence > 5, `confianza ${r.confidence.toFixed(1)} para ${desfase}`);
  }
});

test('offsetBetween también con desfase negativo (empezó antes)', () => {
  const base = envolventeFalsa(3000, 13);
  const relleno = new Float64Array(200);
  const other = new Float64Array(200 + base.length);
  other.set(relleno, 0);
  other.set(base, 200);
  const r = SY.offsetBetween(base, other);
  assert.equal(r.lagBins, -200, 'empezó 200 bins antes');
});

test('la confianza baja cuando el audio no tiene forma reconocible', () => {
  // Un tono constante no tiene envolvente distintiva: la correlación sale plana y
  // el desfase no es fiable. Importa que lo diga en lugar de inventarse un número.
  const plano = new Float64Array(3000).fill(0.5);
  for (let i = 0; i < 3000; i += 1) plano[i] = 0.5 + 0.01 * Math.sin(i / 7);
  const r = SY.offsetBetween(plano, plano.slice(100));
  assert.ok(r.confidence < 5, `confianza ${r.confidence.toFixed(1)} debería ser baja`);
});

// ------------------------------------------------------------- multicámara

test('inferRoles reconoce el material por el nombre, en Windows y en Linux', () => {
  const windows = [
    'D:\\Datos\\Descargas\\dj_audio.wav',
    'D:\\Datos\\Descargas\\dj_camara.mp4',
    'D:\\Datos\\Descargas\\jc_audio (1).wav',
    'D:\\Datos\\Descargas\\jc_camara (1).mp4',
    'D:\\Datos\\Descargas\\jc_llamada (1).mp4',
  ];
  const unix = windows.map((f) => `/home/j/${f.split('\\').pop()}`);

  for (const lista of [windows, unix]) {
    const { people, call, unknown } = MC.inferRoles(lista);
    assert.deepEqual([...people.keys()].sort(), ['dj', 'jc']);
    assert.match(people.get('dj').cam, /dj_camara/);
    assert.match(people.get('dj').mic, /dj_audio/);
    assert.match(people.get('jc').cam, /jc_camara/);
    assert.match(people.get('jc').mic, /jc_audio/);
    assert.match(call, /llamada/);
    assert.deepEqual(unknown, []);
  }
});

test('nombreBase parte por los dos separadores', () => {
  assert.equal(MC.nombreBase('D:\\x\\dj_camara.mp4'), 'dj_camara');
  assert.equal(MC.nombreBase('/home/j/dj_camara.mp4'), 'dj_camara');
  assert.equal(MC.nombreBase('dj_camara.mp4'), 'dj_camara');
});

test('inferRoles deja aparte lo que no reconoce', () => {
  const { unknown, people } = MC.inferRoles(['/x/dj_camara.mp4', '/x/musica.mp3']);
  assert.equal(people.size, 1);
  assert.deepEqual(unknown.map(MC.nombreBase), ['musica']);
});

test('detectTurns sigue los turnos de palabra', () => {
  const binHz = 100;
  const bins = 30 * binHz;
  // dj habla 0-7 y 14-20 · jc habla 7-14 y 20-30
  const hace = (tramos) => {
    const env = new Float64Array(bins).fill(0.001);
    for (const [a, b] of tramos) {
      for (let i = a * binHz; i < b * binHz; i += 1) env[i] = 0.4;
    }
    return env;
  };
  const turnos = MC.detectTurns([
    { id: 'dj', envelope: hace([[0, 7], [14, 20]]), offsetBins: 0 },
    { id: 'jc', envelope: hace([[7, 14], [20, 30]]), offsetBins: 0 },
  ], { binHz, fromBin: 0, toBin: bins, minShot: 2, confirm: 0.5 });

  assert.equal(turnos.length, 4, 'cuatro planos');
  assert.deepEqual(turnos.map((t) => t.id), ['dj', 'jc', 'dj', 'jc']);
  const bordes = turnos.map((t) => Math.round(t.startBin / binHz));
  assert.deepEqual(bordes, [0, 7, 14, 20]);
});

test('detectTurns con un micro bajo y otro ruidoso: cada uno se compara con su propia voz, no en absoluto', () => {
  // dj habla bajo (unos −40 dB) con un micro limpio y oye un poco a jc; jc habla fuerte pero su micro tiene el
  // ruido de fondo a −30 dB, por encima de la voz de dj. Comparando en absoluto, dj no salía nunca.
  const binHz = 100;
  const bins = 30 * binHz;
  const hace = (tramos, voz, ruido, eco = []) => {
    const env = new Float64Array(bins).fill(ruido);
    for (const [[a, b], nivel] of [...tramos.map((t) => [t, voz]), ...eco]) {
      for (let i = a * binHz; i < b * binHz; i += 1) env[i] = Math.max(env[i], nivel * (0.5 + 0.5 * Math.abs(Math.sin(i / 7))));
    }
    return env;
  };
  const turnos = MC.detectTurns([
    { id: 'dj', envelope: hace([[0, 7], [14, 20]], 0.01, 0.0005, [[[7, 14], 0.002], [[20, 30], 0.002]]), offsetBins: 0 },
    { id: 'jc', envelope: hace([[7, 14], [20, 30]], 0.4, 0.03), offsetBins: 0 },
  ], { binHz, fromBin: 0, toBin: bins, minShot: 2, confirm: 0.5 });
  assert.deepEqual(turnos.map((t) => t.id), ['dj', 'jc', 'dj', 'jc']);
  assert.deepEqual(turnos.map((t) => Math.round(t.startBin / binHz)), [0, 7, 14, 20]);
});

test('detectTurns respeta la duración mínima de plano', () => {
  const binHz = 100;
  const bins = 20 * binHz;
  // jc interrumpe medio segundo en el segundo 3: no debe provocar un corte.
  const dj = new Float64Array(bins).fill(0.4);
  const jc = new Float64Array(bins).fill(0.001);
  for (let i = 3 * binHz; i < 3.5 * binHz; i += 1) {
    jc[i] = 0.6;
    dj[i] = 0.001;
  }
  const turnos = MC.detectTurns([
    { id: 'dj', envelope: dj, offsetBins: 0 },
    { id: 'jc', envelope: jc, offsetBins: 0 },
  ], { binHz, fromBin: 0, toBin: bins, minShot: 2, confirm: 0.5 });
  assert.equal(turnos.length, 1, 'un solo plano: la interrupción es demasiado corta');
  assert.equal(turnos[0].id, 'dj');
});

test('detectTurns funciona cuando uno habla casi todo el rato', () => {
  // Un monólogo: el invitado habla el 95% del tiempo. Si el suelo de ruido se
  // estimara solo con un percentil bajo, caería dentro de su propia voz y no se
  // detectaría hablando nunca.
  const binHz = 100;
  const bins = 60 * binHz;
  const invitado = new Float64Array(bins).fill(0.4);
  const anfitrion = new Float64Array(bins).fill(0.0005);
  for (let i = 30 * binHz; i < 33 * binHz; i += 1) {
    anfitrion[i] = 0.5;
    invitado[i] = 0.0005;
  }
  const turnos = MC.detectTurns([
    { id: 'invitado', envelope: invitado, offsetBins: 0 },
    { id: 'anfitrion', envelope: anfitrion, offsetBins: 0 },
  ], { binHz, fromBin: 0, toBin: bins, minShot: 2, confirm: 0.5 });

  assert.ok(turnos.length >= 1);
  assert.equal(turnos[0].id, 'invitado', 'el primer plano es de quien habla');
  const tiempo = {};
  for (const t of turnos) tiempo[t.id] = (tiempo[t.id] || 0) + (t.endBin - t.startBin) / binHz;
  assert.ok(tiempo.invitado > 40, `el invitado debería salir la mayor parte (salió ${tiempo.invitado}s)`);
});

test('sueloDeRuido no se mete dentro de la voz en un monólogo', () => {
  const casi = new Float64Array(1000).fill(-10);
  casi[0] = -70;  // un solo instante de silencio
  const suelo = MC.sueloDeRuido(casi);
  assert.ok(suelo <= -35, `el suelo (${suelo}) debe quedar bien por debajo de la voz (-10)`);
});

test('detectTurns tiene en cuenta el desfase de cada micro', () => {
  const binHz = 100;
  const bins = 20 * binHz;
  const env = new Float64Array(bins).fill(0.001);
  for (let i = 0; i < 5 * binHz; i += 1) env[i] = 0.4;  // habla sus primeros 5 s
  const turnos = MC.detectTurns([
    // El archivo empezó 10 s tarde: en tiempo de la referencia habla de 10 a 15.
    { id: 'dj', envelope: env, offsetBins: 10 * binHz },
  ], { binHz, fromBin: 0, toBin: bins, minShot: 2, confirm: 0.5 });
  assert.equal(turnos.length, 1);
  assert.equal(Math.round(turnos[0].startBin / binHz), 10);
});

test('buildRecipe corta a quien habla y deja el audio continuo', () => {
  const binHz = 100;
  const recipe = MC.buildRecipe({
    people: [
      { id: 'dj', cam: '/v/dj_camara.mp4', mic: '/v/dj_audio.wav' },
      { id: 'jc', cam: '/v/jc_camara.mp4', mic: '/v/jc_audio.wav' },
    ],
    offsets: { '/v/dj_camara.mp4': 4, '/v/dj_audio.wav': 3, '/v/jc_camara.mp4': 0.6, '/v/jc_audio.wav': 1.2 },
    probes: { '/v/dj_camara.mp4': { width: 1920, height: 1080 } },
    turns: [
      { startBin: 4 * binHz, endBin: 10 * binHz, id: 'dj' },
      { startBin: 10 * binHz, endBin: 16 * binHz, id: 'jc' },
    ],
    fps: 25,
    binHz,
    fromBin: 4 * binHz,
    toBin: 16 * binHz,
  });

  const { errors } = R.validate(recipe);
  assert.deepEqual(errors, []);

  const video = recipe.edit.filter((c) => c.audio === false);
  assert.equal(video.length, 2, 'un corte de vídeo por turno');
  // El primer turno empieza en el segundo 4 de la referencia; la cámara de dj
  // arrancó en el 4, así que dentro del clip es el frame 0.
  assert.equal(video[0].in, 0);
  assert.equal(video[0].at, 0);
  // El segundo turno (segundo 10) en la cámara de jc, que arrancó en el 0,6.
  assert.equal(video[1].in, Math.round((10 - 0.6) * 25));
  assert.equal(video[1].at, Math.round((10 - 4) * 25));

  const audio = recipe.edit.filter((c) => c.audioTrack);
  assert.equal(audio.length, 2, 'los dos micros');
  assert.deepEqual(audio.map((c) => c.audioTrack), [1, 2]);
  for (const a of audio) {
    assert.equal(a.at, 0, 'el audio arranca al principio');
    assert.equal(a.duration, Math.round(12 * 25), 'y cubre todo el montaje');
  }
  assert.equal(recipe.tracks.audio, 2);
});

test('buildRecipe: si de alguien falta el micro, va el sonido de su cámara (entero, solo el audio)', () => {
  const binHz = 100;
  const sesion = (probeDj) => MC.buildRecipe({
    people: [{ id: 'dj', cam: '/v/dj_camara.mp4' }, { id: 'jc', cam: '/v/jc_camara.mp4', mic: '/v/jc_audio.wav' }],
    offsets: { '/v/dj_camara.mp4': 4, '/v/jc_camara.mp4': 0.6, '/v/jc_audio.wav': 1.2 },
    probes: { '/v/dj_camara.mp4': { width: 1920, height: 1080, ...probeDj } },
    turns: [{ startBin: 4 * binHz, endBin: 10 * binHz, id: 'dj' }, { startBin: 10 * binHz, endBin: 16 * binHz, id: 'jc' }],
    fps: 25, binHz, fromBin: 4 * binHz, toBin: 16 * binHz,
    ganancias: { '/v/dj_camara.mp4': 6 },
  });
  const r = sesion({ hasAudio: true });
  assert.deepEqual(R.validate(r).errors, []);
  const audio = r.edit.filter((c) => c.audioTrack);
  assert.deepEqual(audio.map((c) => [c.clip, c.video, c.at, c.duration, c.gain]), [
    ['mic_jc', undefined, 0, 12 * 25, undefined],
    ['cam_dj', false, 0, 12 * 25, 6],          // el sonido de la cámara de dj, todo el montaje, igualado
  ]);
  assert.equal(r.tracks.audio, 2);
  // Una cámara sin sonido no sirve: esa persona no tiene voz que poner (y no se inventa nada).
  assert.deepEqual(sesion({ hasAudio: false }).edit.filter((c) => c.audioTrack).map((c) => c.clip), ['mic_jc']);
});

test('los planos nunca se pisan, caigan donde caigan los turnos', () => {
  // Las fronteras entre turnos caen en cualquier punto, no en segundos exactos. Si la
  // duración se redondeara aparte de la posición, un plano acabaría un frame más allá
  // de donde empieza el siguiente y Kdenlive no podría montarlo.
  const binHz = 100;
  const rnd = SESION.aleatorio(99);
  for (const fps of [25, 30, 60]) {
    for (let intento = 0; intento < 40; intento += 1) {
      const turns = [];
      let bin = 0;
      for (let k = 0; k < 10; k += 1) {
        const largo = 150 + Math.floor(rnd() * 600);
        turns.push({ startBin: bin, endBin: bin + largo, id: k % 2 ? 'a' : 'b' });
        bin += largo;
      }
      const recipe = MC.buildRecipe({
        people: [{ id: 'a', cam: '/v/a.mp4' }, { id: 'b', cam: '/v/b.mp4' }],
        offsets: { '/v/a.mp4': 0, '/v/b.mp4': 0 },
        probes: {},
        turns,
        fps,
        binHz,
        fromBin: 0,
        toBin: bin,
      });

      const video = recipe.edit.filter((c) => c.audio === false);
      for (let i = 1; i < video.length; i += 1) {
        const finAnterior = video[i - 1].at + video[i - 1].duration;
        assert.ok(video[i].at >= finAnterior,
          `a ${fps} fps, el plano ${i} empieza en ${video[i].at} y el anterior acaba en ${finAnterior}`);
        assert.equal(video[i].at, finAnterior, 'y tampoco debe quedar hueco');
      }
    }
  }
});

test('buildRecipe pone una guía por plano', () => {
  const binHz = 100;
  const recipe = MC.buildRecipe({
    people: [{ id: 'dj', cam: '/v/dj_camara.mp4' }],
    offsets: { '/v/dj_camara.mp4': 0 },
    probes: {},
    turns: [{ startBin: 0, endBin: 500, id: 'dj' }],
    fps: 25, binHz, fromBin: 0, toBin: 500,
  });
  assert.equal(recipe.guides.length, 1);
  assert.equal(recipe.guides[0].name, 'dj');
});

// -------------------------------------------------- sonido y color medidos

test('gananciaHacia lleva al objetivo y se acota en los casos extremos', () => {
  assert.equal(AN.gananciaHacia(-20, -16).db, 4);
  assert.equal(AN.gananciaHacia(-12, -16).db, -4);
  assert.equal(AN.gananciaHacia(-16, -16).db, 0);
  // Un micro a -60 LUFS pide +44 dB: eso ya no es nivel, es otro problema.
  const extremo = AN.gananciaHacia(-60, -16);
  assert.equal(extremo.db, AN.GANANCIA_MAXIMA_DB);
  assert.equal(extremo.recortada, true);
  assert.equal(AN.gananciaHacia(-20, -16).recortada, false);
});

test('gananciasHacia empareja dos colores y no se desboca', () => {
  const g = AN.gananciasHacia({ r: 100, g: 100, b: 100 }, { r: 120, g: 100, b: 80 });
  assert.equal(g.r, 1.2);
  assert.equal(g.g, 1);
  assert.equal(g.b, 0.8);

  // Una cámara casi negra no se multiplica por 20.
  const extremo = AN.gananciasHacia({ r: 5, g: 5, b: 5 }, { r: 200, g: 200, b: 200 });
  for (const c of ['r', 'g', 'b']) assert.ok(extremo[c] <= 1.6, `${c} acotada`);

  // Un canal a cero no se toca en lugar de dar infinito.
  assert.equal(AN.gananciasHacia({ r: 0, g: 100, b: 100 }, { r: 100, g: 100, b: 100 }).r, 1);
});

test('cambioApreciable distingue una corrección real del ruido de medida', () => {
  assert.equal(AN.cambioApreciable({ r: 1, g: 1, b: 1 }), false);
  assert.equal(AN.cambioApreciable({ r: 1.005, g: 0.998, b: 1.001 }), false);
  assert.equal(AN.cambioApreciable({ r: 1.2, g: 1, b: 1 }), true);
});

test('la ganancia de audio sale como filtro volume en dB', () => {
  const media = mediaMulti();
  const { xml } = P.buildProject({
    project: { fps: 25 },
    media: [{ id: 'mic_dj', path: '/v/dj.wav' }],
    edit: [{ clip: 'mic_dj', in: 0, duration: 100, at: 0, gain: 3.5 }],
  }, { media, fps: 25 });
  assert.match(xml, /mlt_service">volume</);
  assert.match(xml, /name="level">3\.5</);
});

test('sin gain no se añade ningún filtro de volumen', () => {
  const media = mediaMulti();
  const { xml } = P.buildProject({
    project: { fps: 25 },
    media: [{ id: 'mic_dj', path: '/v/dj.wav' }],
    edit: [{ clip: 'mic_dj', in: 0, duration: 100, at: 0 }],
  }, { media, fps: 25 });
  assert.doesNotMatch(xml, /mlt_service">volume</);
});

test('la corrección de color sale como lift_gamma_gain y avfilter.eq', () => {
  const media = mediaMulti();
  const { xml } = P.buildProject({
    project: { fps: 25 },
    media: [{ id: 'cam_dj', path: '/v/dj.mp4' }],
    edit: [{
      clip: 'cam_dj', in: 0, duration: 100, audio: false,
      rgb: { r: 0.92, g: 0.88, b: 0.83 }, contrast: 1.05, saturation: 1.1, gamma: 0.95,
    }],
  }, { media, fps: 25 });
  assert.match(xml, /mlt_service">lift_gamma_gain</);
  assert.match(xml, /name="gain_r">0\.92</);
  assert.match(xml, /name="gain_b">0\.83</);
  assert.match(xml, /name="gamma_g">0\.95</);
  assert.match(xml, /mlt_service">avfilter\.eq</);
  assert.match(xml, /name="av\.contrast">1\.05</);
  assert.match(xml, /name="av\.saturation">1\.1</);
});

test('un canal que no se indica queda neutro, no a cero', () => {
  const media = mediaMulti();
  const { xml } = P.buildProject({
    project: { fps: 25 },
    media: [{ id: 'cam_dj', path: '/v/dj.mp4' }],
    edit: [{ clip: 'cam_dj', in: 0, duration: 100, audio: false, rgb: { r: 1.2 } }],
  }, { media, fps: 25 });
  assert.match(xml, /name="gain_g">1</);
  assert.match(xml, /name="gain_b">1</);
});

test('valida gain, rgb, contraste y saturación', () => {
  const base = (cut) => R.validate({
    media: [{ id: 'a', path: '/a.mp4' }],
    edit: [{ clip: 'a', in: 0, out: 10, ...cut }],
  });
  assert.deepEqual(base({ gain: -3.5, rgb: { r: 1.2, g: 1, b: 0.9 }, contrast: 1.1, saturation: 1 }).errors, []);
  assert.ok(base({ gain: 'mucho' }).errors.some((e) => /gain/.test(e)));
  assert.ok(base({ gain: 60 }).warnings.some((w) => /enorme/.test(w)));
  assert.ok(base({ rgb: 1.2 }).errors.some((e) => /rgb debe ser un objeto/.test(e)));
  assert.ok(base({ rgb: { r: 0 } }).errors.some((e) => /rgb\.r/.test(e)));
  assert.ok(base({ rgb: { x: 1 } }).warnings.some((w) => /clave desconocida/.test(w)));
  assert.ok(base({ saturation: -1 }).errors.some((e) => /saturation/.test(e)));
});

test('buildRecipe aplica la ganancia al micro y el color a la cámara', () => {
  const binHz = 100;
  const recipe = MC.buildRecipe({
    people: [{ id: 'dj', cam: '/v/dj.mp4', mic: '/v/dj.wav' }],
    offsets: { '/v/dj.mp4': 0, '/v/dj.wav': 0 },
    probes: {},
    turns: [{ startBin: 0, endBin: 500, id: 'dj' }],
    fps: 25, binHz, fromBin: 0, toBin: 500,
    ganancias: { '/v/dj.wav': 3.5 },
    colores: { '/v/dj.mp4': { rgb: { r: 0.9, g: 1, b: 1.1 }, saturation: 1.1 } },
  });
  assert.deepEqual(R.validate(recipe).errors, []);
  const audio = recipe.edit.find((c) => c.audioTrack);
  assert.equal(audio.gain, 3.5);
  const video = recipe.edit.find((c) => c.audio === false);
  assert.deepEqual(video.rgb, { r: 0.9, g: 1, b: 1.1 });
  assert.equal(video.saturation, 1.1);
});

test('tiempoASegundos entiende las formas de la línea de comandos', () => {
  // Ojo: aquí un número suelto son SEGUNDOS, al revés que en la receta.
  assert.equal(CLI.tiempoASegundos('6', '--desde'), 6);
  assert.equal(CLI.tiempoASegundos('6.5', '--desde'), 6.5);
  assert.equal(CLI.tiempoASegundos('6s', '--desde'), 6);
  assert.equal(CLI.tiempoASegundos('1:30', '--desde'), 90);
  assert.equal(CLI.tiempoASegundos('00:01:30', '--desde'), 90);
  assert.throws(() => CLI.tiempoASegundos('mañana', '--desde'), /no entiendo/);
  assert.throws(() => CLI.tiempoASegundos('', '--desde'), /falta el valor/);
});

test('el refinamiento da precisión por debajo del bin', () => {
  const base = envolventeFalsa(4000, 5);
  const desplazar = (a, d) => {
    const entero = Math.floor(d);
    const frac = d - entero;
    const out = new Float64Array(a.length);
    for (let i = 0; i < a.length; i += 1) {
      const j = i + entero;
      out[i] = (a[j] || 0) * (1 - frac) + (a[j + 1] || 0) * frac;
    }
    return out;
  };
  for (const real of [20.3, 37.4, 55.7]) {
    const r = SY.offsetBetween(base, desplazar(base, real));
    const bins = r.seconds * SY.BIN_HZ;
    assert.ok(Math.abs(bins - real) < 0.2,
      `desfase ${real}: detectado ${bins.toFixed(2)}`);
  }
});

test('media.probe mide el desfase interno entre las pistas del archivo',
  { skip: HAY_FFMPEG ? false : 'hace falta ffprobe' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-skew-'));
    const limpio = path.join(dir, 'limpio.mp4');
    const torcido = path.join(dir, 'torcido.mp4');
    let res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', limpio],
      { encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, res.stderr);

    res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', limpio,
      '-itsoffset', '0.2', '-i', limpio, '-map', '0:v', '-map', '1:a',
      '-c:v', 'copy', '-c:a', 'aac', torcido], { encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, res.stderr);

    const a = require(path.join(TOOL, 'media.js')).probe(limpio, 25);
    const b = require(path.join(TOOL, 'media.js')).probe(torcido, 25);
    assert.ok(Math.abs(a.skew) < 0.02, `el limpio debería estar a cero, dio ${a.skew}`);
    assert.ok(b.skew > 0.1, `el torcido debería acusar el desfase, dio ${b.skew}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('ajustar-audio mueve el audio en el sentido documentado y respeta el material',
  { skip: HAY_FFMPEG ? false : 'hace falta ffprobe' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-ajuste-'));
    clipsDePrueba(dir);

    // Receta con una pista de audio continua, como la que genera multicam.
    const receta = {
      project: { name: 'X', fps: 25, width: 320, height: 180 },
      media: [{ id: 'cam', path: path.join(dir, 'a.mp4') }, { id: 'mic', path: path.join(dir, 'b.mp4') }],
      edit: [
        { clip: 'cam', in: 0, duration: 25, audio: false },
        // video:false lo manda solo a la pista de audio, como un .wav de micrófono.
        { clip: 'mic', in: 10, duration: 25, at: 0, audioTrack: 1, video: false },
      ],
    };
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify(receta));

    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'ajustar-audio', file,
      '--probar', '-40,0,40'], { encoding: 'utf8', timeout: 300000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const leer = (ms) => JSON.parse(fs.readFileSync(
      path.join(dir, `r-audio${ms >= 0 ? '+' : ''}${ms}ms.json`), 'utf8'));

    // Adelantar el audio (negativo) significa entrar más adentro del clip, así que
    // el punto de entrada sube; atrasarlo lo baja.
    const adelantado = leer(-40).edit.find((c) => c.audioTrack);
    const igual = leer(0).edit.find((c) => c.audioTrack);
    const atrasado = leer(40).edit.find((c) => c.audioTrack);
    assert.equal(igual.in, 10);
    assert.equal(adelantado.in, 11, '-40 ms a 25 fps = un frame más adentro');
    assert.equal(atrasado.in, 9);

    // El corte de vídeo no se toca.
    assert.equal(leer(-40).edit.find((c) => c.audio === false).in, 0);

    fs.rmSync(dir, { recursive: true, force: true });
  });

test('ajustesPorPersona acepta un valor para todos o uno por persona', () => {
  const todos = CLI.ajustesPorPersona('-140', '--audio-offset');
  assert.equal(todos('jc'), -140);
  assert.equal(todos('dj'), -140);

  // Lo importante: cada uno grabó con lo suyo, así que el retardo no tiene por qué
  // ser el mismo, y corregir a los dos por igual arregla a uno y estropea al otro.
  const porPersona = CLI.ajustesPorPersona('jc=-140,dj=0', '--audio-offset');
  assert.equal(porPersona('jc'), -140);
  assert.equal(porPersona('dj'), 0);
  assert.equal(porPersona('JC'), -140, 'no distingue mayúsculas');
  assert.equal(porPersona('nadie'), 0, 'quien no se nombra no se toca');

  assert.equal(CLI.ajustesPorPersona(undefined, '--audio-offset')('jc'), 0);
  assert.throws(() => CLI.ajustesPorPersona('jc=mucho', '--audio-offset'), /no entiendo/);
  assert.throws(() => CLI.ajustesPorPersona('bastante', '--audio-offset'), /no es un número/);
});

test('ajustar-audio --persona mueve solo a esa persona',
  { skip: HAY_FFMPEG ? false : 'hace falta ffprobe' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-persona-'));
    clipsDePrueba(dir);
    const receta = {
      project: { name: 'X', fps: 25, width: 320, height: 180 },
      media: [
        { id: 'cam_jc', path: path.join(dir, 'a.mp4') },
        { id: 'mic_jc', path: path.join(dir, 'a.mp4') },
        { id: 'mic_dj', path: path.join(dir, 'b.mp4') },
      ],
      edit: [
        { clip: 'cam_jc', in: 0, duration: 25, audio: false },
        { clip: 'mic_jc', in: 10, duration: 25, at: 0, audioTrack: 1, video: false },
        { clip: 'mic_dj', in: 10, duration: 25, at: 0, audioTrack: 2, video: false },
      ],
    };
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify(receta));

    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'ajustar-audio', file,
      '--ms', '-40', '--persona', 'jc'], { encoding: 'utf8', timeout: 300000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const salida = JSON.parse(fs.readFileSync(path.join(dir, 'r-audio-jc-40ms.json'), 'utf8'));
    assert.equal(salida.edit.find((c) => c.clip === 'mic_jc').in, 11, 'jc se mueve');
    assert.equal(salida.edit.find((c) => c.clip === 'mic_dj').in, 10, 'dj no se toca');
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('ajustar-audio avisa si la persona pedida no está',
  { skip: HAY_FFMPEG ? false : 'hace falta ffprobe' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-persona-'));
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(file, JSON.stringify({
      project: { fps: 25 },
      media: [{ id: 'mic_jc', path: '/v/a.wav' }],
      edit: [{ clip: 'mic_jc', in: 0, duration: 10, at: 0, audioTrack: 1 }],
    }));
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'ajustar-audio', file,
      '--ms', '-40', '--persona', 'nadie'], { encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /no hay ninguna pista de audio suya/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('ajustar-audio avisa si la receta no tiene pistas de audio propias', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-ajuste-'));
  const file = path.join(dir, 'r.json');
  fs.writeFileSync(file, JSON.stringify({
    project: { fps: 25 },
    media: [{ id: 'a', path: '/v/a.mp4' }],
    edit: [{ clip: 'a', in: 0, duration: 10 }],
  }));
  const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'ajustar-audio', file, '--ms', '-40'],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /no tiene pistas de audio/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// --------------------------------- retardo entre imagen y sonido (calibrar)

test('pico encuentra el máximo y dice cuánto destaca', () => {
  const llano = new Float64Array([1, 1, 1, 1, 1, 1, 1, 1]);
  assert.ok(pico(llano).destaque < 1, 'sin un pico claro, poco destaque');
  const conPico = new Float64Array([1, 1, 1, 20, 1, 1, 1, 1]);
  const r = pico(conPico);
  assert.equal(r.indice, 3);
  assert.ok(r.destaque > 2, `destaque ${r.destaque}`);

  function pico(v) { return CAL.pico(v); }
});

test('golpe detecta el ataque, no el nivel más alto', () => {
  // Una nota que sube despacio y se mantiene alta: el ataque está al principio,
  // aunque el valor máximo esté mucho después.
  const env = new Float64Array(100);
  for (let i = 0; i < 100; i += 1) env[i] = 0.01;
  for (let i = 30; i < 100; i += 1) env[i] = 0.8;
  const r = CAL.golpe(env);
  assert.equal(r.indice, 30, 'el ataque, no la meseta');
});

test('centroRafaga cae en el centro de la ráfaga, no en uno de sus bordes', () => {
  // Un destello da dos picos (cuando entra y cuando sale): el suceso está en medio.
  const v = new Float64Array(60).fill(1);
  v[20] = 50;
  v[24] = 50;
  const centro = CAL.centroRafaga(v, 20, 10);
  assert.ok(Math.abs(centro - 22) < 0.6, `centro ${centro}, esperado ~22`);
});

test('centroRafaga aguanta que no haya nada que destacar', () => {
  const llano = new Float64Array(20).fill(3);
  assert.equal(CAL.centroRafaga(llano, 7, 5), 7, 'devuelve el índice de partida');
});

test('expandirArchivos acepta carpetas y archivos sueltos', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-exp-'));
  fs.writeFileSync(path.join(dir, 'a_camara.mp4'), 'x');
  fs.writeFileSync(path.join(dir, 'a_audio.wav'), 'x');
  fs.writeFileSync(path.join(dir, 'notas.txt'), 'x');
  fs.mkdirSync(path.join(dir, 'alineados'));

  const lista = CLI.expandirArchivos([dir]);
  assert.equal(lista.length, 2, 'solo audio y vídeo, nada de .txt');
  assert.ok(lista.every((f) => path.isAbsolute(f)));

  const suelto = path.join(dir, 'a_camara.mp4');
  assert.deepEqual(CLI.expandirArchivos([suelto]), [suelto]);

  assert.throws(() => CLI.expandirArchivos([path.join(dir, 'no-existe')]), /no existe/);
  const vacia = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-vacia-'));
  assert.throws(() => CLI.expandirArchivos([vacia]), /no hay archivos/);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(vacia, { recursive: true, force: true });
});

test('hay un límite de lo que es creíble como latencia de captura', () => {
  // Sin este límite, en material hablado el modo de respaldo encuentra picos que no
  // tienen relación y suelta un número con aire de seguro, que es lo peor posible.
  assert.ok(CAL.RETARDO_MAXIMO_CREIBLE_MS > 200, 'tiene que admitir latencias reales');
  assert.ok(CAL.RETARDO_MAXIMO_CREIBLE_MS < 2000, 'y rechazar lo absurdo');
});

test('calibrar se niega a dar un número cuando no hay marca',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-sinmarca-'));
    // Vídeo con movimiento y audio con habla, pero sin claqueta ni golpe común.
    const file = path.join(dir, 'x_camara.mp4');
    const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25:duration=6',
      '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file],
      { encoding: 'utf8', timeout: 180000 });
    assert.equal(res.status, 0, res.stderr);

    const salida = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'calibrar', file,
      '--ventana', '6'], { encoding: 'utf8', timeout: 300000 });
    assert.equal(salida.status, 0, 'no es un error del programa, es una medida que no vale');
    // No debe recomendar ningún ajuste a partir de material sin marca.
    assert.doesNotMatch(salida.stdout, /-> --audio-offset/,
      `no debería recomendar nada:\n${salida.stdout}`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('buscarPitido encuentra el tono de 1 kHz y no se confunde con ruido', () => {
  const SR = 16000;
  const n = SR * 3;
  const x = new Float32Array(n);
  // Ruido de fondo y un pitido de 1 kHz de 250 ms a partir del segundo 1.
  for (let i = 0; i < n; i += 1) {
    const t = i / SR;
    x[i] = 0.02 * Math.sin(2 * Math.PI * 180 * t);
    if (t >= 1 && t < 1.25) x[i] += 0.5 * Math.sin(2 * Math.PI * 1000 * t);
  }
  const t = CAL.buscarPitido(x, SR);
  assert.ok(t !== null, 'debería encontrarlo');
  assert.ok(Math.abs(t - 1) < 0.01, `lo sitúa en ${t}, esperado 1.000`);

  // Voz y golpes, sin tono puro: no hay claqueta.
  const sinTono = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    const t2 = i / SR;
    sinTono[i] = 0.3 * Math.sin(2 * Math.PI * 200 * t2) * Math.sin(2 * Math.PI * 3 * t2);
  }
  assert.equal(CAL.buscarPitido(sinTono, SR), null, 'un sonido con armónicos no es la claqueta');
});

test('buscarDestello marca la subida, no el centro del destello', () => {
  // El destello del Estudio arranca a tope y se apaga: su instante es la subida.
  const fps = 30;
  const v = new Float64Array(300).fill(70);
  const largo = Math.round(CAL.DESTELLO_SEG * fps);
  for (let i = 0; i < largo; i += 1) v[90 + i] = 70 + 150 * (1 - i / largo);
  const d = CAL.buscarDestello(v, fps, 3.0, 1.0);
  assert.ok(Math.abs(d.indice - 89.5) < 0.6, `lo sitúa en ${d.indice}, esperado ~89.5`);
});

test('buscarDestello no se deja engañar por la autoexposición ni por un cambio de luz', () => {
  /*
   * Es el caso que falló con material real: el ajuste automático de exposición al
   * empezar a grabar y un cambio de luz a mitad dan subidas MAYORES que el destello.
   * Lo que lo distingue es su forma (golpe y caída de 350 ms) y que cae donde el pitido.
   */
  const fps = 30;
  const n = 30 * fps;
  const v = new Float64Array(n);
  const largo = Math.round(CAL.DESTELLO_SEG * fps);
  for (let i = 0; i < n; i += 1) {
    const t = i / fps;
    let b = 60;
    if (t < 0.8) b = 20 + 50 * (t / 0.8);          // autoexposición
    if (t >= 14 && t < 22) b = 110;                 // se enciende una luz
    v[i] = b + 0.4 * Math.sin(t * 7);
  }
  for (let k = 0; k < largo; k += 1) v[90 + k] += 35 * (1 - k / largo);  // el destello

  const cerca = CAL.buscarDestello(v, fps, 3.14, 1.0);
  assert.ok(cerca.indice !== null, 'tiene que encontrarlo');
  assert.ok(Math.abs(cerca.indice / fps - 3.0) < 0.05,
    `lo sitúa en ${(cerca.indice / fps).toFixed(3)}s, esperado 3.000s`);

  // Sin la ventana alrededor del pitido se iría al cambio de luz: por eso existe.
  const lejos = CAL.buscarDestello(v, fps, null, 99);
  assert.ok(Math.abs(lejos.indice / fps - 3.0) > 1, 'buscar en todo el archivo falla');
});

test('buscarDestello aguanta la autoexposición del arranque', () => {
  /*
   * El caso que falló con material real: al empezar a grabar, el ajuste automático de
   * exposición sube y baja el brillo con una forma parecida a la de un destello, y más
   * grande. La defensa es doble: no mirar donde el destello no puede estar (±300 ms del
   * pitido) y medir el fondo con un percentil bajo, no con la media, para que la caída
   * del artefacto no tape la subida que se busca.
   */
  const fps = 30;
  const n = 25 * fps;
  const largo = Math.round(CAL.DESTELLO_SEG * fps);
  const pitido = 0.938;

  const escena = (posArtefacto, alturaArtefacto, posDestello, alturaDestello) => {
    const v = new Float64Array(n);
    for (let i = 0; i < n; i += 1) v[i] = 60 + 0.3 * Math.sin(i / 9);
    if (posArtefacto !== null) {
      for (let k = 0; k < largo; k += 1) {
        const i = Math.round(posArtefacto * fps) + k;
        if (i < n) v[i] += alturaArtefacto * (1 - k / largo);
      }
    }
    for (let k = 0; k < largo; k += 1) {
      const i = Math.round(posDestello * fps) + k;
      if (i < n) v[i] += alturaDestello * (1 - k / largo);
    }
    return v;
  };

  const casos = [
    ['autoexposición al arrancar', 0.425, 60, 0.80, 25],
    ['artefacto algo más tarde', 0.45, 60, 0.80, 25],
    ['sin artefacto', null, 0, 0.80, 25],
    ['destello justo en el pitido', 0.40, 70, 0.938, 30],
  ];

  for (const [etiqueta, pa, ha, pd, hd] of casos) {
    const d = CAL.buscarDestello(escena(pa, ha, pd, hd), fps, pitido);
    assert.ok(d.indice !== null, `${etiqueta}: no encontró nada`);
    const t = d.indice / fps;
    assert.ok(Math.abs(t - pd) < 0.06,
      `${etiqueta}: lo sitúa en ${t.toFixed(3)}s, esperado ${pd.toFixed(3)}s`);
  }
});

test('buscarDestello avisa cuando no hay nada parecido a un destello', () => {
  const fps = 30;
  const plano = new Float64Array(300).fill(70);
  const d = CAL.buscarDestello(plano, fps, 3.0, 1.0);
  assert.equal(d.indice, null, 'sin destello, no se inventa uno');
});

test('calibrar mide el retardo real entre imagen y sonido',
  { skip: (HAY_FFMPEG && typeof SESION.escribirWav === 'function') ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-calibrar-'));
    const SR = 48000;
    const FPS = 30;
    const DUR = 8;
    const RETARDO = 0.14;   // el audio va 140 ms por detrás de la imagen
    const GOLPE = 3.0;

    // Vídeo: fondo tranquilo y un fotograma muy distinto en el momento del golpe.
    const W = 48;
    const frames = DUR * FPS;
    const buf = Buffer.alloc(W * W * frames);
    for (let f = 0; f < frames; f += 1) {
      const t = f / FPS;
      let v = 90 + Math.round(5 * Math.sin(t * 1.3));
      if (Math.abs(t - GOLPE) < 0.5 / FPS) v = 235;
      buf.fill(v, f * W * W, (f + 1) * W * W);
    }
    const raw = path.join(dir, 'v.raw');
    fs.writeFileSync(raw, buf);

    // Audio: ruido bajo y un golpe seco, retrasado a propósito.
    const n = SR * DUR;
    const a = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const t = i / SR;
      a[i] = 0.02 * Math.sin(2 * Math.PI * 200 * t) * (0.5 + 0.5 * Math.sin(t * 3));
      const dt = t - (GOLPE + RETARDO);
      if (dt >= 0 && dt < 0.05) a[i] += 0.9 * Math.exp(-dt * 80) * Math.sin(2 * Math.PI * 1200 * t);
    }
    const wav = path.join(dir, 'a.wav');
    SESION.escribirWav(wav, a);

    const cam = path.join(dir, 'camara.mp4');
    const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${W}x${W}`, '-r', String(FPS), '-i', raw,
      '-i', wav, '-map', '0:v', '-map', '1:a',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '12', '-c:a', 'aac', '-shortest', cam],
      { encoding: 'utf8', timeout: 180000 });
    assert.equal(res.status, 0, res.stderr);

    const r = CAL.calibrarCamara(cam, { fps: FPS, ventana: DUR });
    assert.ok(!r.error, r.error);
    assert.ok(Math.abs(r.retardoMs - RETARDO * 1000) <= 20,
      `retardo medido ${r.retardoMs} ms, real ${RETARDO * 1000} ms`);
    assert.equal(r.offsetRecomendado, -r.retardoMs, 'el ajuste es el retardo cambiado de signo');
    assert.ok(r.confianzaVideo > 4 && r.confianzaAudio > 4, 'el golpe tiene que destacar');

    fs.rmSync(dir, { recursive: true, force: true });
  });

// ------------------------------------------------- generaciones de formato

test('generationFor elige el formato según la versión de Kdenlive', () => {
  // El formato 1.1 llegó con Kdenlive 23.04; antes de eso no se puede abrir.
  assert.equal(P.generationFor([20, 8]), '1.04');
  assert.equal(P.generationFor([21, 12]), '1.04');
  assert.equal(P.generationFor([22, 12]), '1.04');
  assert.equal(P.generationFor([23, 4]), '1.1');
  assert.equal(P.generationFor([23, 8]), '1.1');
  assert.equal(P.generationFor([26, 4]), '1.1');
  assert.equal(P.generationFor(null), '1.1', 'sin dato, el formato actual');
});

test('el formato 1.1 lleva secuencia con uuid y envoltorio', () => {
  const { xml, summary } = construir(receta(), { docVersion: '1.1' });
  assert.equal(summary.docVersion, '1.1');
  assert.match(xml, /kdenlive:docproperties\.version">1\.1</);
  assert.match(xml, /<property name="kdenlive:uuid">/);
  assert.match(xml, /kdenlive:projectTractor/);
  assert.match(xml, /kdenlive:docproperties\.opensequences/);
  assert.match(xml, /<chain id="chain0"/, 'los clips van como <chain>');
});

test('el formato 1.04 no lleva secuencias ni envoltorio', () => {
  const { xml, summary } = construir(receta(), { docVersion: '1.04' });
  assert.equal(summary.docVersion, '1.04');
  assert.match(xml, /kdenlive:docproperties\.version">1\.04</);
  assert.doesNotMatch(xml, /kdenlive:uuid/);
  assert.doesNotMatch(xml, /kdenlive:projectTractor/);
  assert.doesNotMatch(xml, /opensequences|activetimeline/);
  assert.match(xml, /<producer id="chain0"/, 'los clips van como <producer>');
  // El montaje es el último tractor, que es lo que lo identifica en este formato.
  const tractores = xml.match(/<tractor id="[^"]+"/g);
  assert.match(tractores[tractores.length - 1], /tractor\d+/);
});

test('en 1.04 el estado de la timeline y las guías van en el documento', () => {
  const { xml } = construir(receta({ guides: [{ at: 25, name: 'x' }] }), { docVersion: '1.04' });
  assert.match(xml, /kdenlive:docproperties\.guides/);
  assert.doesNotMatch(xml, /sequenceproperties\.guides/);
  assert.match(xml, /kdenlive:docproperties\.activeTrack/);
  assert.match(xml, /kdenlive:docproperties\.zoneout/);
});

test('las dos generaciones montan exactamente lo mismo', () => {
  const r = receta({
    edit: [
      { clip: 'a', in: 0, out: 49, fadeIn: 10 },
      { clip: 'b', in: 0, out: 49, dissolve: 10, fadeOut: 10 },
    ],
  });
  const nuevo = construir(r, { docVersion: '1.1' });
  const viejo = construir(r, { docVersion: '1.04' });
  assert.equal(nuevo.summary.frames, viejo.summary.frames);
  assert.equal(nuevo.summary.cuts, viejo.summary.cuts);
  assert.equal(nuevo.summary.mixes, viejo.summary.mixes);
  // Las entradas de la timeline (lo que define el montaje) son idénticas. Se deja
  // fuera la entrada de la bandeja que apunta a la secuencia, que solo existe en 1.1.
  const entradas = (xml) => (xml.match(/<(entry|blank)[^>]*>/g) || [])
    .filter((e) => !/producer="\{/.test(e))
    .join('\n')
    .replace(/chain/g, 'X');
  assert.equal(entradas(nuevo.xml), entradas(viejo.xml));
});

test('elegirFormato respeta --doc-version y rechaza lo que no existe', () => {
  assert.equal(CLI.elegirFormato('1.04').docVersion, '1.04');
  assert.equal(CLI.elegirFormato('1.1').docVersion, '1.1');
  assert.throws(() => CLI.elegirFormato('2.0'), /no existe/);
});

test('kdenliveVersion devuelve null o un par de números', () => {
  const v = CLI.kdenliveVersion();
  if (v !== null) {
    assert.equal(v.length, 2);
    assert.ok(Number.isInteger(v[0]) && Number.isInteger(v[1]));
  }
});

// -------------------------------------------------------------- validación

test('una receta correcta no da errores', () => {
  const { errors } = R.validate(receta({
    edit: [{ clip: 'a', in: 0, out: 49, fadeIn: 10 }, { clip: 'b', in: 0, out: 49, dissolve: 10, speed: 2 }],
  }));
  assert.deepEqual(errors, []);
});

test('las claves propias de Kdenlive no se avisan como desconocidas', () => {
  const { warnings } = R.validate(receta({
    tracks: { video: 2, audio: 2 },
    guides: [{ at: 0, name: 'x' }],
    edit: [{ clip: 'a', in: 0, out: 49, fadeIn: 5, fadeOut: 5, dissolve: undefined, speed: 1, audio: true, zoom: 1.5 }],
  }));
  assert.deepEqual(warnings.filter((w) => /desconocida/.test(w)), []);
});

test('dissolve en el primer corte es un error', () => {
  const { errors } = R.validate(receta({ edit: [{ clip: 'a', in: 0, out: 49, dissolve: 10 }] }));
  assert.ok(errors.some((e) => e.includes('no tiene nada antes')));
});

test('speed tiene que ser positivo', () => {
  assert.ok(R.validate(receta({ edit: [{ clip: 'a', speed: 0 }] })).errors.some((e) => /speed/.test(e)));
  assert.ok(R.validate(receta({ edit: [{ clip: 'a', speed: -1 }] })).errors.some((e) => /speed/.test(e)));
  assert.ok(R.validate(receta({ edit: [{ clip: 'a', speed: 50 }] })).warnings.some((w) => /muy alto/.test(w)));
});

test('tracks tiene que ser un entero razonable', () => {
  assert.ok(R.validate(receta({ tracks: { video: 0 } })).errors.some((e) => /tracks\.video/.test(e)));
  assert.ok(R.validate(receta({ tracks: { audio: 99 } })).errors.some((e) => /tracks\.audio/.test(e)));
});

test('las recetas de ejemplo son válidas', () => {
  const dir = path.join(TOOL, 'recipes');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 2);
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.deepEqual(R.validate(r).errors, [], `${f} debería ser válida`);
  }
});

// --------------------------------------------------------------------- CLI

test('carpetasDeKdenlive propone las rutas de instalación de cada sistema', () => {
  const win = CLI.carpetasDeKdenlive('win32');
  assert.ok(win.length >= 3);
  assert.ok(win.every((d) => /kdenlive/i.test(d) && /bin$/i.test(d)));

  const mac = CLI.carpetasDeKdenlive('darwin');
  assert.ok(mac.some((d) => d.includes('kdenlive.app')));

  const linux = CLI.carpetasDeKdenlive('linux');
  assert.ok(linux.length >= 1);
});

test('buscarBinario encuentra lo que está en el PATH y no inventa lo que no está', () => {
  // ffmpeg puede no estar; la aserción se adapta a lo que haya.
  const ffmpeg = CLI.buscarBinario('ffmpeg');
  if (HAY_FFMPEG) assert.equal(ffmpeg, 'ffmpeg');
  assert.equal(CLI.buscarBinario('binario-que-no-existe-123'), null);
});

test('parseArgs entiende las banderas', () => {
  const a = CLI.parseArgs(['build', 'r.json', '--out', 'x.kdenlive', '--compositing=composite']);
  assert.deepEqual(a._, ['build', 'r.json']);
  assert.equal(a.flags.out, 'x.kdenlive');
  assert.equal(a.flags.compositing, 'composite');
});

test('explainRenderLog traduce los fallos de MLT', () => {
  const lineas = [];
  const real = console.log;
  console.log = (m) => lineas.push(String(m));
  try {
    CLI.explainRenderLog('[producer_xml] failed to load filter "qtblend"\n[producer_xml] failed to load transition "qtblend"\n');
  } finally {
    console.log = real;
  }
  const texto = lineas.join('\n');
  assert.match(texto, /no carga el filtro qtblend/);
  assert.match(texto, /En Kdenlive sí se aplican/);
  assert.match(texto, /no carga la transición qtblend/);
});

test('build falla y no escribe nada si falta un archivo de vídeo', { skip: HAY_FFMPEG ? false : 'hace falta ffprobe' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-'));
  const rec = path.join(tmp, 'r.json');
  const out = path.join(tmp, 'no-debe-existir.kdenlive');
  fs.writeFileSync(rec, JSON.stringify(receta()));
  const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'build', rec, '--out', out],
    { encoding: 'utf8', timeout: 60000 });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /no existe el archivo/);
  assert.equal(fs.existsSync(out), false);
});

// ------------------------------------------------- integración: render real

function clipsDePrueba(dir) {
  for (const [name, patron, hz] of [['a.mp4', 'testsrc', 440], ['b.mp4', 'smptebars', 880]]) {
    const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
      '-f', 'lavfi', '-i', `${patron}=size=320x180:rate=25:duration=2`,
      '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=2`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
      path.join(dir, name)], { encoding: 'utf8', timeout: 120000 });
    assert.equal(res.status, 0, res.stderr);
  }
}

for (const docVersion of ['1.1', '1.04']) {
  test(`el proyecto en formato ${docVersion} se renderiza y dura exactamente lo pedido`,
    { skip: (HAY_FFMPEG && HAY_MELT) ? false : 'hacen falta ffmpeg y melt' }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-'));
      clipsDePrueba(dir);

      const recipe = {
        project: { name: 'Integración', fps: 25, width: 320, height: 180 },
        media: [{ id: 'a', path: path.join(dir, 'a.mp4') }, { id: 'b', path: path.join(dir, 'b.mp4') }],
        edit: [
          { clip: 'a', in: 0, duration: 25, fadeIn: 10 },
          { clip: 'b', in: 0, duration: 25, dissolve: 10, fadeOut: 10 },
        ],
      };
      const rec = path.join(dir, 'r.json');
      fs.writeFileSync(rec, JSON.stringify(recipe));

      const salida = path.join(dir, 'out.mp4');
      const res = spawnSync(process.execPath,
        [path.join(TOOL, 'cli.js'), 'render', rec, '--out', salida, '--doc-version', docVersion],
        { encoding: 'utf8', timeout: 300000 });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      assert.ok(fs.existsSync(salida));

      // 25 + 25 - 10 de solape = 40 frames = 1,6 s
      const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
        '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', salida],
        { encoding: 'utf8', timeout: 120000 });
      assert.equal(parseInt(probe.stdout.trim(), 10), 40, 'duración exacta con el encadenado descontado');

      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('selftest deja un proyecto de prueba listo para abrir',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-'));
    clipsDePrueba(dir);
    const salida = path.join(dir, 'prueba');

    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'selftest',
      '--dir', salida, '--media', `${path.join(dir, 'a.mp4')},${path.join(dir, 'b.mp4')}`],
      { encoding: 'utf8', timeout: 300000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.ok(fs.existsSync(path.join(salida, 'prueba.kdenlive')));
    assert.ok(fs.existsSync(path.join(salida, 'prueba.json')));
    assert.match(res.stdout, /comprueba estas cinco cosas/);
    // La receta guardada tiene que seguir siendo válida.
    const r = JSON.parse(fs.readFileSync(path.join(salida, 'prueba.json'), 'utf8'));
    assert.deepEqual(R.validate(r).errors, []);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('el .kdenlive generado es XML bien formado',
  { skip: tieneBinario('xmllint', '--version') ? false : 'hace falta xmllint' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-'));
    const file = path.join(dir, 'p.kdenlive');
    const { xml } = construir(receta({
      edit: [
        { clip: 'a', in: 0, out: 49, fadeIn: 10, zoom: 1.5 },
        { clip: 'b', in: 0, out: 49, dissolve: 10, speed: 2 },
      ],
      guides: [{ at: 25, name: 'con & y "comillas"' }],
    }));
    fs.writeFileSync(file, xml);
    const res = spawnSync('xmllint', ['--noout', file], { encoding: 'utf8', timeout: 60000 });
    assert.equal(res.status, 0, res.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('multicam sincroniza una sesión real y monta siguiendo los turnos',
  { skip: (HAY_FFMPEG && HAY_MELT) ? false : 'hacen falta ffmpeg y melt' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-multicam-'));
    // Sesión con desfases y turnos conocidos, para comprobar contra ellos.
    const sesion = SESION.generar(dir, {
      duracion: 16,
      turnos: { dj: [[0, 6], [11, 16]], jc: [[6, 11]] },
      desfases: {
        'dj_camara.mp4': 2.0,
        'dj_audio.wav': 1.0,
        'jc_camara (1).mp4': 0.5,
        'jc_audio (1).wav': 1.5,
        'jc_llamada (1).mp4': 0,
      },
    });

    const salida = path.join(dir, 'salida');
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'multicam',
      ...Object.values(sesion.rutas), '--out', salida], { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    /*
     * Los desfases detectados tienen que coincidir con los reales, pero cada uno con
     * su referencia: las cámaras van contra la referencia de sincronía, y los micros
     * contra SU cámara, que es lo que mantiene el labial limpio.
     */
    const detectado = (nombre) => {
      const base = MC.nombreBase(nombre);
      const linea = res.stdout.split('\n').find((l) => l.trim().startsWith(base) && /[+-]\d/.test(l));
      assert.ok(linea, `falta el desfase de ${base} en la salida`);
      return parseFloat(linea.match(/([+-]\d+\.\d+)s/)[1]);
    };

    const esperado = {
      'dj_camara.mp4': sesion.desfases['dj_camara.mp4'],
      'jc_camara (1).mp4': sesion.desfases['jc_camara (1).mp4'],
      // micro respecto a su cámara = diferencia entre los dos desfases reales
      'dj_audio.wav': sesion.desfases['dj_audio.wav'] - sesion.desfases['dj_camara.mp4'],
      'jc_audio (1).wav': sesion.desfases['jc_audio (1).wav'] - sesion.desfases['jc_camara (1).mp4'],
    };

    for (const [nombre, real] of Object.entries(esperado)) {
      const valor = detectado(nombre);
      assert.ok(Math.abs(valor - real) <= 0.05,
        `${MC.nombreBase(nombre)}: detectado ${valor}s, esperado ${real}s`);
    }

    // El proyecto existe y es válido.
    const proyecto = path.join(salida, 'multicam.kdenlive');
    assert.ok(fs.existsSync(proyecto));
    const receta = JSON.parse(fs.readFileSync(path.join(salida, 'multicam.json'), 'utf8'));
    assert.deepEqual(R.validate(receta).errors, []);

    // Dos micros continuos y varios cortes de vídeo alternando cámara.
    const audio = receta.edit.filter((c) => c.audioTrack);
    assert.equal(audio.length, 2);
    const video = receta.edit.filter((c) => c.audio === false);
    assert.ok(video.length >= 2, `esperaba al menos 2 planos, hubo ${video.length}`);
    const camaras = [...new Set(video.map((c) => c.clip))];
    assert.equal(camaras.length, 2, 'usa las dos cámaras');

    fs.rmSync(dir, { recursive: true, force: true });
  });

test('multicam junta el tramo retomado (jc-2) con jc: el hueco no recorta y sus micros comparten pista',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-retomado-'));
    const sesion = SESION.retomar(SESION.generar(dir, { duracion: 30 }), { caida: 16, vuelta: 19 });
    const salida = path.join(dir, 'salida');
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'multicam',
      ...Object.values(sesion.rutas), '--out', salida], { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);

    const receta = JSON.parse(fs.readFileSync(path.join(salida, 'multicam.json'), 'utf8'));
    assert.deepEqual(R.validate(receta).errors, []);

    // jc-2 se sincroniza con la llamada en su sitio (0,6 s de jc + 19 s de retomada).
    const linea = res.stdout.split('\n').find((l) => l.trim().startsWith('jc-2_camara') && /[+-]\d+\.\d+s/.test(l));
    assert.ok(linea, 'falta el desfase de jc-2_camara');
    assert.ok(Math.abs(parseFloat(linea.match(/([+-]\d+\.\d+)s/)[1]) - 19.6) <= 0.1, linea);

    // La imagen usa las dos cámaras de jc, y el audio de jc y jc-2 va en la misma pista, jc antes.
    const camaras = new Set(receta.edit.filter((c) => c.audio === false).map((c) => c.clip));
    assert.ok(camaras.has('cam_jc') && camaras.has('cam_jc-2'), [...camaras].join(','));
    const mics = receta.edit.filter((c) => c.audioTrack);
    const jc = mics.find((c) => c.clip === 'mic_jc');
    const jc2 = mics.find((c) => c.clip === 'mic_jc-2');
    assert.ok(jc && jc2, 'entran los dos tramos de micro');
    assert.equal(jc.audioTrack, jc2.audioTrack);
    assert.ok(jc2.at >= jc.at + jc.duration, 'sin solaparse');
    assert.equal(new Set(mics.map((c) => c.audioTrack)).size, 2, 'dos personas, dos pistas');

    fs.rmSync(dir, { recursive: true, force: true });
  });

// Una conversación de un minuto: los tramos de la llamada partida tienen voz de los dos para situarse.
const TURNOS_LARGOS = { dj: [[0, 7], [14, 20], [26, 33], [40, 47], [54, 60]], jc: [[7, 14], [20, 26], [33, 40], [47, 54]] };

/* Desfase que imprime multicam para un archivo (cámara respecto a la referencia). */
const desfaseImpreso = (salida, nombre) => {
  const l = salida.split('\n').find((x) => x.trim().startsWith(nombre) && /[+-]\d+\.\d+s · confianza/.test(x));
  return l ? parseFloat(l.match(/([+-]\d+\.\d+)s/)[1]) : null;
};

test('multicam con la llamada partida (se cae la página del anfitrión): une los tramos y monta toda la sesión',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-anfitrion-'));
    const sesion = SESION.retomar(SESION.generar(dir, { duracion: 60, turnos: TURNOS_LARGOS }), { caida: 25, vuelta: 32, llamada: true });
    assert.ok(sesion.rutas['jc-2_llamada.mp4'], 'la llamada también queda partida');
    const salida = path.join(dir, 'salida');
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'multicam',
      ...Object.values(sesion.rutas), '--out', salida], { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /llamada está partida en 2 tramos/);
    assert.match(res.stdout, /referencia de sincronía: llamada-unida/);

    // Cada cámara en su sitio respecto al reloj de la llamada (el del primer tramo).
    for (const [nombre, verdad] of [['jc_camara (1)', 0.6], ['jc-2_camara', 32.6], ['dj_camara', 4.4]]) {
      const d = desfaseImpreso(res.stdout, nombre);
      assert.ok(d !== null && Math.abs(d - verdad) <= 0.1, `${nombre}: ${d} (debería ser ${verdad})`);
    }
    const receta = JSON.parse(fs.readFileSync(path.join(salida, 'multicam.json'), 'utf8'));
    assert.deepEqual(R.validate(receta).errors, []);
    const total = Math.max(...receta.edit.map((e) => e.at + e.duration)) / receta.project.fps;
    assert.ok(total > 54, `el montaje cubre toda la sesión, no solo un tramo (${total.toFixed(1)} s)`);
    const camaras = new Set(receta.edit.filter((c) => c.audio === false).map((c) => c.clip));
    assert.ok(camaras.has('cam_jc') && camaras.has('cam_jc-2') && camaras.has('cam_dj'), [...camaras].join(','));

    fs.rmSync(dir, { recursive: true, force: true });
  });

test('multicam sin el WAV de alguien: su voz sale del sonido de su cámara y se oye en el montaje',
  { skip: HAY_FFMPEG && HAY_MELT ? false : 'hace falta ffmpeg y melt' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-sinwav-'));
    const sesion = SESION.generar(dir, { duracion: 30 });
    fs.rmSync(sesion.rutas['dj_audio.wav']);
    const archivos = Object.entries(sesion.rutas).filter(([n]) => n !== 'dj_audio.wav').map(([, ruta]) => ruta);
    const salida = path.join(dir, 'salida');
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'multicam', ...archivos, '--out', salida], { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /micro \(falta, se usa el de la cámara\)/);
    const receta = JSON.parse(fs.readFileSync(path.join(salida, 'multicam.json'), 'utf8'));
    assert.deepEqual(R.validate(receta).errors, []);
    assert.ok(receta.edit.some((e) => e.audioTrack && e.clip === 'cam_dj' && e.video === false), JSON.stringify(receta.edit.filter((e) => e.audioTrack)));
    // Renderizado, en un turno de dj (del 14 al 20 de la sesión; el montaje empieza cuando arranca la cámara
    // de dj, a los 4,4 s) se le oye. Antes ahí solo estaba el micro de jc, que calla: silencio.
    const video = path.join(dir, 'montaje.mp4');
    const rr = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'render', path.join(salida, 'multicam.json'), '--out', video], { encoding: 'utf8', timeout: 600000 });
    assert.equal(rr.status, 0, rr.stdout + rr.stderr);
    const nivel = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', '10.5', '-t', '4', '-i', video, '-vn', '-af', 'volumedetect', '-f', 'null', '-'],
      { encoding: 'utf8' }).stderr.match(/mean_volume: (-?[\d.]+) dB/);
    assert.ok(nivel && Number(nivel[1]) > -40, `nivel medio en el turno de dj: ${nivel && nivel[1]} dB`);
    fs.rmSync(dir, { recursive: true, force: true });
  });

test('analizar propone cortar el hueco en que la página del anfitrión estuvo caída',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-analizar-'));
    const ep = path.join(raiz, '2026-10-10');
    SESION.retomar(SESION.generar(path.join(ep, 'originales'), { duracion: 60, turnos: TURNOS_LARGOS }), { caida: 25, vuelta: 32, llamada: true });
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'analizar', ep, '--sin-transcribir'],
      { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const propuesta = JSON.parse(fs.readFileSync(path.join(ep, 'montaje', 'propuesta.json'), 'utf8'));
    const caida = propuesta.partes['1'].marcas.find((m) => m.tipos.includes('caida'));
    assert.ok(caida, JSON.stringify(propuesta.partes['1'].marcas));
    // La llamada se cortó a los 25,6 s de la sesión y siguió a los 32,6 s.
    assert.ok(Math.abs(caida.desde - 25.6) < 0.2 && Math.abs(caida.hasta - 32.6) < 0.2, JSON.stringify(caida));
    assert.match(fs.readFileSync(path.join(ep, 'montaje', 'propuesta.md'), 'utf8'), /hueco: se cayó la página/);
    fs.rmSync(raiz, { recursive: true, force: true });
  });

/*
 * session.json como lo deja el Estudio: la hora del servidor a la que empezó cada tramo de la llamada
 * (el primero a la hora S; el retomado, 32,6 s después) y las marcas puestas con los botones.
 */
function sesionConMarcas(originales, marcas) {
  const S = 1_000_000;
  fs.writeFileSync(path.join(originales, 'session.json'), JSON.stringify({
    startAt: S,
    tracks: {
      a: { file: 'jc_llamada (1).mp4', kind: 'llamada', startedAtServer: S },
      b: { file: 'jc-2_llamada.mp4', kind: 'llamada', startedAtServer: S + 32_600 },
    },
    marcas: marcas.map((m) => ({ ...m, ...(m.hora != null ? { hora: S + m.hora * 1000 } : { inicio: S + m.inicio * 1000, fin: S + m.fin * 1000 }) })),
  }));
}

test('analizar: las marcas puestas en vivo (✂ y ★) salen en la propuesta, en el reloj de la llamada partida, y se aprueban',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-marcas-'));
    const ep = path.join(raiz, '2026-10-10');
    const originales = path.join(ep, 'originales');
    SESION.retomar(SESION.generar(originales, { duracion: 60, turnos: TURNOS_LARGOS }), { caida: 25, vuelta: 32, llamada: true });
    sesionConMarcas(originales, [
      { tipo: 'corte', inicio: 10, fin: 18, nombre: 'JC', persona: 'jc' },
      { tipo: 'bueno', hora: 45, nombre: 'DJ', persona: 'dj' },          // durante el tramo retomado
      { tipo: 'corte', inicio: 50, fin: 50.8, nombre: 'DJ', persona: 'dj' }, // dos pulsaciones seguidas
    ]);
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'analizar', ep, '--sin-transcribir'], { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const p = JSON.parse(fs.readFileSync(path.join(ep, 'montaje', 'propuesta.json'), 'utf8')).partes['1'];
    const vivo = p.marcas.find((m) => m.tipos.includes('✂ en vivo'));
    assert.ok(vivo, JSON.stringify(p.marcas));
    // Empieza 1 s antes de la pulsación (lo que se quiere quitar ya había empezado) y los extremos van al silencio.
    assert.ok(Math.abs(vivo.desde - 9) < 0.8 && Math.abs(vivo.hasta - 18) < 0.8, JSON.stringify(vivo));
    assert.strictEqual(p.momentos.length, 1);
    assert.ok(Math.abs(p.momentos[0].t - 45) < 0.4, `★ a los ${p.momentos[0].t} s de la llamada unida`);
    assert.strictEqual(p.paraRevisar.length, 1);
    assert.ok(Math.abs(p.paraRevisar[0].t - 50) < 0.4);
    const md = fs.readFileSync(path.join(ep, 'montaje', 'propuesta.md'), 'utf8');
    assert.match(md, /✂ en vivo · «marcado por JC»/);
    assert.match(md, /★ Momentos buenos/);
    assert.match(md, /sin tramo/);
    const ok = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'aprobar', ep, vivo.id], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);
    const corte = JSON.parse(fs.readFileSync(path.join(ep, 'episodio.json'), 'utf8')).partes['1'].cortes[0];
    assert.deepStrictEqual(corte.slice(0, 2), [vivo.desde, vivo.hasta]);
    assert.match(corte[2], /✂ en vivo: marcado por JC/);
    fs.rmSync(raiz, { recursive: true, force: true });
  });

/* Una frase como la deja Whisper: un token por palabra (con su espacio delante), repartidos en el tramo. */
function fraseWhisper(desde, hasta, texto) {
  const palabras = texto.split(' ');
  const paso = (hasta - desde) / palabras.length;
  return {
    offsets: { from: desde * 1000, to: hasta * 1000 },
    text: ` ${texto}`,
    tokens: palabras.map((w, i) => ({ text: ` ${w}`, offsets: { from: (desde + i * paso) * 1000, to: (desde + (i + 0.9) * paso) * 1000 } })),
  };
}

const segundosSrt = (x) => x.replace(',', '.').split(':').map(Number).reduce((s, v) => s * 60 + v, 0);

test('episodio monta una sesión con caída del anfitrión hasta el proyecto (sin renderizar)',
  { skip: HAY_FFMPEG ? false : 'hace falta ffmpeg' }, () => {
    const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-episodio-'));
    const ep = path.join(raiz, '2026-10-10');
    const originales = path.join(ep, 'originales');
    SESION.retomar(SESION.generar(originales, { duracion: 60, turnos: TURNOS_LARGOS }), { caida: 25, vuelta: 32, llamada: true });
    // Marcas puestas en vivo (un ✂ que no se aprueba y un ★) y un corte a mano en mitad de un turno de dj.
    sesionConMarcas(originales, [{ tipo: 'corte', inicio: 10, fin: 18, nombre: 'JC' }, { tipo: 'bueno', hora: 50, nombre: 'DJ' }]);
    fs.writeFileSync(path.join(ep, 'episodio.json'), JSON.stringify({
      partes: { 1: { cortes: [[42, 45, 'prueba']] } },
      titulo: 'Episodio de prueba',
      resumen: 'Hablamos de Japón.',
      capitulos: [{ titulo: 'Intro' }, { titulo: 'Japón', frase: 'hablemos ahora de japon' }, { titulo: 'Despedida', frase: 'y para terminar' }],
      rotulos: { nombres: { jc: 'JC', dj: 'Douglas' } },
    }));
    const res = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'episodio', ep, '--solo-montaje'],
      { encoding: 'utf8', timeout: 600000 });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /partes encontradas: 1/);
    assert.match(res.stdout, /llamada en 2 tramos/);
    assert.ok(fs.existsSync(path.join(ep, 'montaje', 'parte-1', 'llamada-unida.wav')));
    assert.ok(fs.existsSync(path.join(ep, 'montaje', 'episodio.kdenlive')));
    const receta = JSON.parse(fs.readFileSync(path.join(ep, 'montaje', 'episodio.json'), 'utf8'));
    const total = Math.max(...receta.edit.map((e) => e.at + e.duration)) / receta.project.fps;
    // 60 s menos los 3 s del corte a mano: si el hueco de la caída se recortara como silencio, quedarían unos 46.
    assert.ok(total > 51, `el hueco de la caída no se recorta como silencio: DJ siguió hablando (${total.toFixed(1)} s)`);
    assert.match(res.stdout, /no se corta .* en el micro de dj hay [\d.]+ s de voz/);
    // Rótulos con el nombre de cada uno, en V3, sobre un plano suyo.
    assert.match(res.stdout, /rótulos: .*JC en .*Douglas en|rótulos: .*Douglas en .*JC en/);
    for (const [persona, clip] of [['jc', 'rotulo_jc'], ['dj', 'rotulo_dj']]) {
      const ro = receta.edit.find((e) => e.clip === clip);
      assert.ok(ro && ro.track === 3, clip);
      const debajo = receta.edit.find((e) => !e.audioTrack && !(e.track > 1) && e.at <= ro.at && ro.at + ro.duration <= e.at + e.duration);
      assert.strictEqual(CUT.personaDeClip(debajo && debajo.clip), persona);
    }
    // Las cámaras se revisan (congelada, en negro): estas se mueven todo el rato y no salta nada.
    assert.match(res.stdout, /buscando imagen congelada o en negro en dj_camara\.mp4/);
    assert.doesNotMatch(res.stdout, /⚠ .*cámara de/);
    assert.ok(fs.existsSync(path.join(ep, 'montaje', 'camaras.json')));

    // El corte a mano cae en mitad de un turno de dj: tras el empalme se ve un momento a jc, no un salto en dj.
    assert.match(res.stdout, /saltos de imagen: 1 disimulado/);
    const video = receta.edit.filter((e) => !e.audioTrack);
    const quien = (f) => CUT.personaDeClip((video.find((e) => e.at <= f && f < e.at + e.duration) || {}).clip);
    const empalme = receta.guides.find((g) => (CUT.leerGuiaDeCorte(g) || {}).motivo === 'prueba');
    assert.ok(empalme, JSON.stringify(receta.guides.filter((g) => g.name.startsWith('✂'))));
    assert.deepStrictEqual([quien(empalme.at - 1), quien(empalme.at)], ['dj', 'jc']);
    assert.equal(quien(empalme.at + Math.round(1.5 * receta.project.fps)), 'dj', 'y vuelve a quien habla');
    // Las marcas en vivo quedan como guías: ★ en verde y el ✂ sin aprobar en rojo, con su aviso.
    assert.ok(receta.guides.some((g) => g.name === '★ DJ' && g.color === 'Green'));
    assert.ok(receta.guides.some((g) => g.name.startsWith('✂ JC (marcado en vivo') && g.color === 'Red'));
    assert.match(res.stdout, /1 tramo\(s\) ✂ marcados en vivo NO se cortan/);

    // Vídeo de revisión para el móvil (hace falta melt): un trozo por empalme, numerado, en 480p.
    if (HAY_MELT) {
      const rev = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'revision', ep], { encoding: 'utf8', timeout: 600000 });
      assert.equal(rev.status, 0, rev.stdout + rev.stderr);
      const ancho = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width', '-of', 'csv=p=0',
        path.join(ep, 'montaje', 'revision.mp4')], { encoding: 'utf8' }).stdout.trim();
      assert.equal(ancho, '854');
      assert.match(fs.readFileSync(path.join(ep, 'montaje', 'revision.md'), 'utf8'), /\| \d+ \| [\d:]+ \| corte: prueba \(−3 s\)/);
      const otraVez = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'revision', ep], { encoding: 'utf8', timeout: 600000 });
      assert.match(otraVez.stdout, /reutilizados/, 'si no cambia nada, no se renderiza otra vez');
    }

    // YouTube, con una transcripción conocida: subtítulos y capítulos en el tiempo del vídeo final (lo de
    // después del corte a mano se adelanta 3 s y lo cortado no sale).
    fs.writeFileSync(path.join(ep, 'montaje', 'transcripcion-parte-1.json'), JSON.stringify({ transcription: [
      fraseWhisper(8, 11, 'Hola a todos, bienvenidos al podcast.'),
      fraseWhisper(20, 23, 'Hablemos ahora de Japón.'),
      fraseWhisper(42.5, 44.5, 'Esto se quitó.'),
      fraseWhisper(50, 53, 'Y para terminar, muchas gracias.'),
    ] }));
    const yt = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'youtube', ep], { encoding: 'utf8', timeout: 600000 });
    assert.equal(yt.status, 0, yt.stdout + yt.stderr);
    const origen = Number(JSON.parse(fs.readFileSync(path.join(ep, 'montaje', 'parte-1', 'multicam.json'), 'utf8')).origenReferencia) || 0;
    const srt = fs.readFileSync(path.join(ep, 'entrega', '2026-10-10.srt'), 'utf8');
    const cue = (texto) => segundosSrt(srt.split('\n\n').find((b) => b.includes(texto)).split('\n')[1].split(' --> ')[0]);
    assert.ok(Math.abs(cue('Hablemos ahora') - (20 - origen)) < 0.05, `${origen}\n${srt}`);
    assert.ok(Math.abs(cue('Y para terminar') - (50 - 3 - origen)) < 0.1, `${origen}\n${srt}`);
    assert.doesNotMatch(srt, /Esto se quitó/);
    const desc = fs.readFileSync(path.join(ep, 'entrega', '2026-10-10.descripcion.txt'), 'utf8');
    const reloj = (s) => `0:${String(Math.floor(s)).padStart(2, '0')}`;
    assert.strictEqual(desc, `Hablamos de Japón.\n\nCapítulos:\n0:00 Intro\n${reloj(20 - origen)} Japón\n${reloj(47 - origen)} Despedida\n`);
    const md = fs.readFileSync(path.join(ep, 'entrega', 'youtube.md'), 'utf8');
    assert.match(md, /## Título\nEpisodio de prueba/);
    assert.match(md, /Falta el pie con los enlaces/);
    assert.match(fs.readFileSync(path.join(ep, 'entrega', 'transcripcion.txt'), 'utf8'), /Hablemos ahora de Japón\./);

    // Un short vertical de la ★ que marcó DJ a los 50 s (corto, para que la prueba no tarde), con subtítulos.
    if (HAY_MELT) {
      const sh = spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'shorts', ep, '--antes', '6', '--despues', '3'], { encoding: 'utf8', timeout: 600000 });
      assert.equal(sh.status, 0, sh.stdout + sh.stderr);
      const corto = path.join(ep, 'entrega', 'shorts', '2026-10-10-short-1.mp4');
      const [w, h, segundos] = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=width,height:format=duration',
        '-of', 'csv=p=0', corto], { encoding: 'utf8' }).stdout.trim().split(/[,\n]/).map(Number);
      assert.deepStrictEqual([w, h], [1080, 1920]);
      assert.ok(segundos > 4 && segundos < 12, `dura ${segundos} s`);
      assert.match(fs.readFileSync(path.join(ep, 'entrega', 'shorts', 'shorts.md'), 'utf8'), /★ de DJ .*«.*para terminar/);
    }

    // Repetirlo no rehace el análisis ni la llamada unida.
    const cli = (...extra) => spawnSync(process.execPath, [path.join(TOOL, 'cli.js'), 'episodio', ep, '--solo-montaje', ...extra],
      { encoding: 'utf8', timeout: 600000 });
    const otra = cli();
    assert.equal(otra.status, 0, otra.stdout + otra.stderr);
    assert.match(otra.stdout, /reutilizando el reparto de cámaras/);
    assert.doesNotMatch(otra.stdout, /se unen/);

    // Un proyecto guardado en Kdenlive después de generarlo no se pisa sin decirlo.
    const proyecto = path.join(ep, 'montaje', 'episodio.kdenlive');
    fs.appendFileSync(proyecto, '<!-- retocado a mano en Kdenlive -->\n');
    const pisar = cli();
    assert.equal(pisar.status, 4, pisar.stdout + pisar.stderr);
    assert.match(pisar.stderr, /tiene cambios hechos en Kdenlive/);
    assert.match(fs.readFileSync(proyecto, 'utf8'), /retocado a mano/, 'el proyecto retocado sigue igual');
    const descartar = cli('--descartar-cambios');
    assert.equal(descartar.status, 0, descartar.stdout + descartar.stderr);
    assert.doesNotMatch(fs.readFileSync(proyecto, 'utf8'), /retocado a mano/);
    assert.ok(fs.readdirSync(path.join(ep, 'montaje')).some((f) => f.startsWith('episodio.kdenlive.editado-')), 'guarda una copia del retocado');

    fs.rmSync(raiz, { recursive: true, force: true });
  });
