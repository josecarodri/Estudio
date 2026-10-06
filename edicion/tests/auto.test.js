'use strict';
/*
 * Análisis automático del episodio: límites por pitido y voz, marcas de charla técnica, cortes por texto,
 * propuestas aprobables, huella y estado. Lo que necesita ffmpeg se salta solo si no está.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const A = require('../analizar.js');
const AU = require('../auto.js');

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'auto-'));

/** Transcripción de Whisper mínima: [{texto, desde, hasta, palabras: [[w, a, b]...]}] */
function jsonWhisper(dir, nombre, frases) {
  const transcription = frases.map((f) => ({
    offsets: { from: f.desde * 1000, to: f.hasta * 1000 },
    text: ` ${f.texto}`,
    tokens: f.texto.split(' ').map((w, i, a) => ({
      text: `${i === 0 ? ' ' : ' '}${w}`,
      offsets: { from: (f.desde + ((f.hasta - f.desde) * i) / a.length) * 1000, to: (f.desde + ((f.hasta - f.desde) * (i + 1)) / a.length) * 1000 },
    })),
  }));
  const f = path.join(dir, nombre);
  fs.writeFileSync(f, JSON.stringify({ transcription }));
  return f;
}

const seg = (desde, hasta, texto) => ({ desde, hasta, texto });

test('marcas: detecta las frases de charla técnica y no el contenido de la conversación', () => {
  const frases = [
    seg(0, 3, 'Bueno, hoy hablamos de bancos y tarjetas.'),
    seg(3.2, 6, 'Una vez me cobraron 25 dólares y llamé para que me lo quitaran.'),   // «quitar»: contenido
    seg(6.3, 9, 'El proceso era tan lento, tan lento.'),                               // «lento»: contenido
    seg(60, 62, 'Se perdió la conexión, va.'),
    seg(62.3, 64, 'Sí, mano.'),
    seg(64.5, 66, 'Eso lo cortamos.'),
    seg(66.2, 68, 'Bueno, sigamos.'),
    seg(300, 302, 'Espera que te hagas congelado.'),
    seg(302.5, 304, 'Y siguió el tema normal de la conversación.'),
  ];
  const c = A.candidatos(frases);
  assert.strictEqual(c.length, 2, 'dos bloques: la desconexión y el congelado');
  assert.ok(c[0].desde >= 59.9 && c[0].hasta <= 69, 'el bloque abarca la desconexión y su charla');
  assert.deepStrictEqual(c[0].tipos.sort(), ['conexion', 'indicacion-de-corte']);
  assert.strictEqual(c[1].tipos[0], 'conexion');
  assert.ok(c[1].desde >= 299 && c[1].hasta <= 306);
  for (const x of c) assert.ok(x.hasta - x.desde < 20, 'bloques cortos: crecen hasta la pausa, no hasta 90 s');
});

test('marcas: «esto lo vas a cortar de todos modos» y «sí se escucha» se detectan', () => {
  const c = A.candidatos([seg(0, 2, 'Esto lo vas a cortar de todos modos'), seg(500, 502, 'Estoy distraído, está llorando'), seg(502.2, 503, 'Sí se escucha')]);
  assert.deepStrictEqual(c.map((x) => x.tipos[0]), ['indicacion-de-corte', 'prueba-de-sonido']);
});

test('buscarFrase: sin acentos ni mayúsculas, con tiempos por palabra y desambiguación', () => {
  const dir = tmp();
  const json = jsonWhisper(dir, 't.json', [
    seg(10, 14, 'Vale, te voy a hacer una pregunta yo'),
    seg(20, 22, 'Tengo una pregunta'),
    seg(30, 32, 'Tengo una pregunta otra vez'),
  ]);
  const p = A.palabras(json);
  assert.ok(p.length >= 14);
  const a = A.buscarFrase(p, 'VALE te voy a hacer UNA pregunta');
  assert.ok(a && Math.abs(a.desde - 10) < 0.5);
  assert.ok(Math.abs(A.buscarFrase(p, 'tengo una pregunta').desde - 20) < 0.5);
  assert.ok(Math.abs(A.buscarFrase(p, 'tengo una pregunta', { ordinal: 2 }).desde - 30) < 0.5);
  assert.ok(Math.abs(A.buscarFrase(p, 'tengo una pregunta', { despuesDe: 25 }).desde - 30) < 0.5);
  assert.strictEqual(A.buscarFrase(p, 'esto no está'), null);
});

test('palabras: los trozos de una palabra que Whisper parte se vuelven a unir', () => {
  const dir = tmp();
  const f = path.join(dir, 'p.json');
  fs.writeFileSync(f, JSON.stringify({ transcription: [{ offsets: { from: 0, to: 2000 }, text: ' Bienvenidos', tokens: [
    { text: ' Bien', offsets: { from: 0, to: 500 } }, { text: 'venidos', offsets: { from: 500, to: 1200 } }, { text: '.', offsets: { from: 1200, to: 1250 } }] }] }));
  const p = A.palabras(f);
  assert.deepStrictEqual(p.map((x) => x.w), ['Bienvenidos']);
  assert.strictEqual(p[0].a, 0);
  assert.strictEqual(p[0].b, 1.2);
});

test('cortes por texto: de la primera frase hasta el principio de la segunda, que se conserva', () => {
  const dir = tmp();
  const montaje = path.join(dir, 'montaje');
  fs.mkdirSync(montaje);
  jsonWhisper(montaje, 'transcripcion-parte-1.json', [
    seg(10, 14, 'Vale, te voy a hacer una pregunta yo'), seg(20, 22, 'Tengo una pregunta'),
  ]);
  const parte = { id: '1', archivos: [] };   // sin llamada: no se ajusta al silencio
  const r = AU.resolverCortesTexto([['0:05', '0:07'], { desde: 'Vale, te voy a hacer una pregunta', hasta: 'Tengo una pregunta' }], parte, montaje);
  assert.deepStrictEqual(r[0].tramo, ['0:05', '0:07']);
  assert.ok(Math.abs(r[1].tramo[0] - 10) < 0.5 && Math.abs(r[1].tramo[1] - 20) < 0.5);
  assert.match(r[1].texto, /Vale/);
  const incl = AU.resolverCortesTexto([{ desde: 'Vale, te voy a hacer una pregunta', hasta: 'Tengo una pregunta', incluirHasta: true }], parte, montaje);
  assert.ok(incl[0].tramo[1] > 21, 'con incluirHasta también se quita la segunda frase');
  assert.throws(() => AU.resolverCortesTexto([{ desde: 'frase inexistente', hasta: 'Tengo una pregunta' }], parte, montaje), /no encuentro/);
  assert.throws(() => AU.resolverCortesTexto([{ desde: 'Vale, te voy a hacer una pregunta', hasta: 'x' }], parte, path.join(dir, 'otra')), /falta la transcripción/);
});

test('aprobar: pasa las propuestas elegidas al episodio.json del episodio sin duplicarlas ni tocar lo demás', () => {
  const raiz = tmp();
  const ep = path.join(raiz, '2026-10-03');
  fs.mkdirSync(path.join(ep, 'originales'), { recursive: true });
  fs.mkdirSync(path.join(ep, 'montaje'));
  fs.writeFileSync(path.join(raiz, 'episodio.json'), JSON.stringify({ lufsEntrega: -14 }));
  fs.writeFileSync(path.join(ep, 'episodio.json'), JSON.stringify({ partes: { 1: { hasta: 3000 } } }));
  fs.writeFileSync(path.join(ep, 'montaje', 'propuesta.json'), JSON.stringify({ partes: {
    1: { marcas: [{ id: '1.1', desde: 133.2, hasta: 186.4, tipos: ['conexion'], texto: 'x' }, { id: '1.2', desde: 781.1, hasta: 785.4, tipos: ['conexion'], texto: 'y' }] },
    2: { marcas: [{ id: '2.1', desde: 1, hasta: 16, tipos: ['tecnica'], texto: 'z' }] } } }));
  const r = AU.aprobar(ep, ['1.1', '2.1']);
  assert.strictEqual(r.hechos.length, 2);
  assert.strictEqual(r.destino, path.join(ep, 'episodio.json'));
  const j = JSON.parse(fs.readFileSync(path.join(ep, 'episodio.json'), 'utf8'));
  assert.deepStrictEqual(j.partes[1].cortes, [[133.2, 186.4, '1.1 conexion: x']], 'con una nota de dónde sale');
  assert.deepStrictEqual(j.partes[2].cortes, [[1, 16, '2.1 tecnica: z']]);
  assert.strictEqual(j.partes[1].hasta, 3000, 'lo que ya había se conserva');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(raiz, 'episodio.json'), 'utf8')), { lufsEntrega: -14 }, 'la raíz no se toca');
  AU.aprobar(ep, ['1.1']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(ep, 'episodio.json'), 'utf8')).partes[1].cortes.length, 1, 'no se duplica');
  assert.throws(() => AU.aprobar(ep, ['9.9']), /no existe la propuesta/);
});

test('aprobar: si el episodio aún no tiene su episodio.json, lo crea', () => {
  const raiz = tmp();
  const ep = path.join(raiz, '2026-10-10');
  fs.mkdirSync(path.join(ep, 'montaje'), { recursive: true });
  fs.writeFileSync(path.join(ep, 'montaje', 'propuesta.json'), JSON.stringify({ partes: { 1: { marcas: [{ id: '1.1', desde: 5, hasta: 9, tipos: ['tecnica'], texto: 'x' }] } } }));
  AU.aprobar(ep, ['1.1']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(ep, 'episodio.json'), 'utf8')), { cortes: [], partes: { 1: { cortes: [[5, 9, '1.1 tecnica: x']] } } });
  assert.ok(!fs.existsSync(path.join(raiz, 'episodio.json')));
});

test('huella: igual si nada cambió, distinta si cambia un archivo o un ajuste', () => {
  const dir = tmp();
  const f = path.join(dir, 'jc_llamada (1).mp4');
  fs.writeFileSync(f, 'abc');
  const parte = { id: '1', archivos: [f] };
  const cfg = { desde: 2.4, hasta: null, audioOffset: 'dj=0,jc=0', minShot: 2, lufsMicros: -16 };
  const h = AU.huellaDeParte(parte, cfg);
  assert.strictEqual(AU.huellaDeParte(parte, { ...cfg }), h);
  assert.notStrictEqual(AU.huellaDeParte(parte, { ...cfg, desde: 3 }), h);
  assert.notStrictEqual(AU.huellaDeParte(parte, { ...cfg, audioOffset: 'jc=-60' }), h);
  assert.strictEqual(AU.huellaDeParte(parte, { ...cfg, cortes: [[1, 2]], limpiezas: [{}] }), h, 'los cortes no obligan a rehacer el análisis');
  fs.writeFileSync(f, 'abcd');
  assert.notStrictEqual(AU.huellaDeParte(parte, cfg), h);
});

test('estado: una línea con la fase y avisa si el proceso ya no está', () => {
  const raiz = tmp();
  const ep = path.join(raiz, 'e');
  fs.mkdirSync(path.join(ep, 'montaje'), { recursive: true });
  assert.match(AU.estado(ep).texto, /sin actividad/);
  const r = { montaje: path.join(ep, 'montaje') };
  AU.marcarFase(r, 'renderizando', '90 min de vídeo');
  const e = AU.estado(ep);
  assert.match(e.texto, /renderizando · 90 min de vídeo · hace 0 min/);
  assert.strictEqual(e.vivo, true, 'el proceso de la prueba sigue vivo');
  const f = path.join(r.montaje, 'estado.json');
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...j, pid: 99999999 }));
  assert.match(AU.estado(ep).texto, /se interrumpió/);
});

test('estado: cuánto tardó cada fase la última vez (no cuenta lo de un proceso anterior ni el «ya está»)', () => {
  const ep = path.join(tmp(), 'e');
  const r = { montaje: path.join(ep, 'montaje') };
  const f = path.join(r.montaje, 'estado.json');
  // Hace como si la fase en curso hubiera empezado hace `s` segundos.
  const atras = (s) => {
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.writeFileSync(f, JSON.stringify({ ...j, inicioFase: new Date(Date.now() - s * 1000).toISOString() }));
  };
  AU.marcarFase(r, 'montando-parte-1');
  atras(200);
  AU.marcarFase(r, 'renderizando');
  atras(42 * 60);
  AU.marcarFase(r, 'acabado');
  atras(30);
  AU.marcarFase(r, 'listo');
  atras(3600);
  AU.marcarFase(r, 'listo');   // el «ya está» no cuenta como trabajo
  assert.match(AU.estado(ep).texto, /\ntiempos de la última vez: montando-parte-1 3 min · renderizando 42 min · acabado 30 s \(total 46 min\)$/);
  // Otro proceso empieza de cero: la fase que dejó a medias el anterior no se cuenta.
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...j, fase: 'renderizando', pid: 99999999 }));
  AU.marcarFase(r, 'renderizando');
  atras(65);
  AU.marcarFase(r, 'listo');
  assert.match(AU.estado(ep).texto, /tiempos de la última vez: renderizando 65 s$/);
});

test('coincidencia: proporción de palabras esperadas que se oyen', () => {
  assert.strictEqual(AU.coincidencia(['Gracias', 'por', 'escucharnos'], 'gracias por escucharnos gracias'), 1);
  assert.strictEqual(AU.coincidencia(['uno', 'dos', 'tres', 'cuatro'], 'uno dos'), 0.5);
  assert.strictEqual(AU.coincidencia([], 'lo que sea'), 1);
});

test('límites por voz: empieza tras el pitido inicial y acaba antes del de cierre (audio sintético)', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const wav = path.join(dir, 'llamada.wav');
  // 1 s silencio · pitido 1 kHz 0,25 s · 1,25 s silencio · voz (ruido) 12,5 s · 2 s silencio · pitido de cierre · 2 s silencio
  const inputs = ['anullsrc=r=16000:cl=mono:d=1', 'sine=f=1000:r=16000:d=0.25', 'anullsrc=r=16000:cl=mono:d=1.25',
    'anoisesrc=r=16000:d=12.5:a=0.2:c=pink', 'anullsrc=r=16000:cl=mono:d=2', 'sine=f=1000:r=16000:d=0.25', 'anullsrc=r=16000:cl=mono:d=2'];
  const args = ['-v', 'error', '-y'];
  for (const i of inputs) args.push('-f', 'lavfi', '-i', i);
  args.push('-filter_complex', `${inputs.map((_, k) => `[${k}:a]`).join('')}concat=n=${inputs.length}:v=0:a=1[o]`, '-map', '[o]', wav);
  assert.strictEqual(spawnSync('ffmpeg', args).status, 0);
  const r = A.limitesDeVoz(wav);
  assert.ok(r.pitidoInicio && Math.abs(r.pitidoInicio.desde - 1.0) < 0.1, `pitido inicial ${JSON.stringify(r.pitidoInicio)}`);
  assert.ok(r.inicio > 2.0 && r.inicio < 2.6, `inicio ${r.inicio}`);
  assert.ok(r.pitidoFin && Math.abs(r.pitidoFin.desde - 17.0) < 0.15, `pitido de cierre ${JSON.stringify(r.pitidoFin)}`);
  assert.ok(r.fin > 14.8 && r.fin < 15.5, `fin ${r.fin}`);
});

test('límites por voz: sin pitido de cierre (grabación cortada) no inventa un final', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const wav = path.join(dir, 'corte.wav');
  const inputs = ['anullsrc=r=16000:cl=mono:d=1', 'sine=f=1000:r=16000:d=0.25', 'anullsrc=r=16000:cl=mono:d=1', 'anoisesrc=r=16000:d=10:a=0.2:c=pink'];
  const args = ['-v', 'error', '-y'];
  for (const i of inputs) args.push('-f', 'lavfi', '-i', i);
  args.push('-filter_complex', `${inputs.map((_, k) => `[${k}:a]`).join('')}concat=n=${inputs.length}:v=0:a=1[o]`, '-map', '[o]', wav);
  assert.strictEqual(spawnSync('ffmpeg', args).status, 0);
  const r = A.limitesDeVoz(wav);
  assert.strictEqual(r.fin, null);
  assert.strictEqual(r.pitidoFin, null);
  assert.ok(r.inicio > 1.7 && r.inicio < 2.5);
});

test('ajustar al silencio: un corte que cae en mitad de una palabra se lleva a la pausa más cercana', { skip: !hayFfmpeg }, () => {
  const dir = tmp();
  const wav = path.join(dir, 'pausa.wav');
  const inputs = ['anoisesrc=r=16000:d=5:a=0.2:c=pink', 'anullsrc=r=16000:cl=mono:d=1', 'anoisesrc=r=16000:d=5:a=0.2:c=pink'];
  const args = ['-v', 'error', '-y'];
  for (const i of inputs) args.push('-f', 'lavfi', '-i', i);
  args.push('-filter_complex', `${inputs.map((_, k) => `[${k}:a]`).join('')}concat=n=${inputs.length}:v=0:a=1[o]`, '-map', '[o]', wav);
  assert.strictEqual(spawnSync('ffmpeg', args).status, 0);
  const t = A.ajustarASilencio(wav, 5.3, 0.6);       // la pausa va de 5,0 a 6,0
  assert.ok(t > 5.05 && t < 5.95, `quedó en ${t}`);
});

// ------------------------------------------------------------------ marcas en vivo (botones ✂ y ★ del Estudio)

/** Parte con su session.json: la llamada empezó a la hora S del servidor (y, si está partida, el tramo 2 a S2). */
function parteConMarcas(marcas, { partida } = {}) {
  const dir = tmp();
  const S = 1_000_000;
  const tracks = { a: { file: 'jc_llamada.mp4', kind: 'llamada', startedAtServer: S } };
  if (partida) tracks.b = { file: 'jc-2_llamada.mp4', kind: 'llamada', startedAtServer: S + 40_000 };
  fs.writeFileSync(path.join(dir, 'session.json'), JSON.stringify({ startAt: S, tracks, marcas }));
  const archivos = ['dj_camara.mp4', 'dj_audio.wav', 'jc_camara.mp4', 'jc_audio.wav', 'jc_llamada.mp4', ...(partida ? ['jc-2_llamada.mp4'] : [])]
    .map((n) => path.join(dir, n));
  const montaje = path.join(dir, 'montaje');
  if (partida) {
    // Donde la unión colocó cada tramo: el segundo 2,5 s más tarde de lo que dicen las horas (cuenta la unión).
    fs.mkdirSync(path.join(montaje, 'parte-1'), { recursive: true });
    fs.writeFileSync(path.join(montaje, 'parte-1', 'llamada-unida.json'), JSON.stringify({
      tramos: [{ archivo: archivos[4], desde: 0 }, { archivo: archivos[5], desde: 42.5 }],
    }));
  }
  return { parte: { id: '1', carpeta: dir, archivos }, montaje };
}

test('marcas en vivo: pasan de la hora del servidor al reloj de la llamada', () => {
  const S = 1_000_000;
  const { parte, montaje } = parteConMarcas([
    { tipo: 'bueno', hora: S + 12_340, nombre: 'DJ', persona: 'dj' },
    { tipo: 'corte', inicio: S + 20_000, fin: S + 35_500, nombre: 'JC', persona: 'jc' },
    { tipo: 'corte', inicio: S + 50_000, fin: S + 59_000, nombre: 'JC', persona: 'jc', cerradoAlParar: true },
    { tipo: 'rara', hora: S },
  ]);
  assert.deepStrictEqual(AU.marcasEnVivo(parte, montaje), [
    { tipo: 'bueno', desde: 12.34, hasta: 12.34, nombre: 'DJ', persona: 'dj' },
    { tipo: 'corte', desde: 20, hasta: 35.5, nombre: 'JC', persona: 'jc', cerradoAlParar: false },
    { tipo: 'corte', desde: 50, hasta: 59, nombre: 'JC', persona: 'jc', cerradoAlParar: true },
  ]);
});

test('marcas en vivo: con la llamada partida, cada marca va con el tramo que grababa entonces', () => {
  const { parte, montaje } = parteConMarcas([
    { tipo: 'bueno', hora: 1_000_000 + 10_000, nombre: 'DJ' },
    { tipo: 'bueno', hora: 1_000_000 + 50_000, nombre: 'DJ' },
  ], { partida: true });
  const m = AU.marcasEnVivo(parte, montaje);
  assert.deepStrictEqual(m.map((x) => x.desde), [10, 52.5], 'la segunda va 10 s después del inicio del tramo 2, que está en el 42,5');
});

test('marcas en vivo: sin session.json, sin marcas o sin hora de la llamada, no hay ninguna', () => {
  const sin = { id: '1', carpeta: tmp(), archivos: ['x/jc_llamada.mp4'] };
  assert.deepStrictEqual(AU.marcasEnVivo(sin, null), []);
  const { parte } = parteConMarcas([]);
  assert.deepStrictEqual(AU.marcasEnVivo(parte, null), []);
  const otra = parteConMarcas([{ tipo: 'bueno', hora: 1_000_000 }]);
  const s = JSON.parse(fs.readFileSync(path.join(otra.parte.carpeta, 'session.json'), 'utf8'));
  delete s.tracks.a.startedAtServer;
  fs.writeFileSync(path.join(otra.parte.carpeta, 'session.json'), JSON.stringify(s));
  assert.deepStrictEqual(AU.marcasEnVivo(otra.parte, null), []);
});

test('marcas en vivo: guías en el proyecto (★ en verde, ✂ sin cortar en rojo) y nada dentro de un corte', () => {
  const receta = { project: { fps: 25 }, origenReferencia: 2, edit: [{ clip: 'cam_dj', at: 0, in: 0, duration: 25 * 100 }] };
  const marcas = [
    { tipo: 'bueno', desde: 12.34, hasta: 12.34, nombre: 'DJ' },
    { tipo: 'bueno', desde: 41, hasta: 41, nombre: 'JC' },                 // cae dentro de un corte
    { tipo: 'corte', desde: 20, hasta: 35.5, nombre: 'JC' },               // no se corta
    { tipo: 'corte', desde: 40, hasta: 50, nombre: 'JC' },                 // ya se corta (aprobado)
    { tipo: 'corte', desde: 60, hasta: 61, nombre: 'DJ' },                 // sin tramo: no lleva guía
    { tipo: 'bueno', desde: 1, hasta: 1, nombre: 'DJ' },                   // antes del inicio del montaje
  ];
  const g = AU.guiasDeMarcas(receta, marcas, [{ desde: 39.8, hasta: 50.2 }]);
  assert.deepStrictEqual(g.guias, [
    { at: 259, name: '★ DJ', color: 'Green' },
    { at: 450, name: '✂ JC (marcado en vivo, 16 s, sin cortar)', color: 'Red' },
  ]);
  assert.strictEqual(g.sinCortar, 1);
});
