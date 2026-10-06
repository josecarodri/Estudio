'use strict';
/*
 * Lo de YouTube: el mapa del montaje (reloj de la llamada de cada parte → vídeo final), subtítulos,
 * capítulos por frase y descripción.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const YT = require('../youtube.js');

/** Transcripción de Whisper con un token por palabra (con su espacio delante) y la puntuación aparte. */
function whisper(frases) {
  const transcription = frases.map(([desde, hasta, texto]) => {
    const trozos = texto.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
    const palabras = texto.split(' ');
    const paso = (hasta - desde) / palabras.length;
    let i = 0;
    const tokens = [];
    for (const t of trozos) {
      const esPalabra = /[\p{L}\p{N}]/u.test(t);
      const a = desde + paso * Math.min(i, palabras.length - 1);
      tokens.push({ text: esPalabra && !/^[¿¡]/.test(tokens[tokens.length - 1]?.text || '') ? ` ${t}` : t, offsets: { from: a * 1000, to: (a + paso * 0.9) * 1000 } });
      if (esPalabra) i += 1;
    }
    return { offsets: { from: desde * 1000, to: hasta * 1000 }, text: ` ${texto}`, tokens };
  });
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yt-')), 't.json');
  fs.writeFileSync(f, JSON.stringify({ transcription }));
  return f;
}

/*
 * Dos partes a 25 fps. Parte 1: su llamada empieza a contar en el segundo 2 (origen) y el micro de dj va en
 * sincronía (in = at + 100); se cortó del frame 250 al 350 (segundos 12 a 16 de la llamada). Parte 2: va
 * detrás, y su tramo de los segundos 1 a 3 se repitió al final del episodio.
 */
function montaje() {
  const parte1 = { origenReferencia: 2, edit: [{ clip: 'cam_dj', in: 0, at: 0, duration: 1000 }, { clip: 'mic_dj', in: 100, at: 0, duration: 1000, audioTrack: 1 }] };
  const parte2 = { origenReferencia: 0, edit: [{ clip: 'mic_dj', in: 0, at: 0, duration: 500, audioTrack: 1 }] };
  const final = {
    project: { fps: 25 },
    edit: [
      { clip: 'p1_mic_dj', in: 100, at: 0, duration: 250, audioTrack: 1 },
      { clip: 'p1_mic_dj', in: 450, at: 250, duration: 650, audioTrack: 1 },
      { clip: 'p2_mic_dj', in: 0, at: 900, duration: 500, audioTrack: 1 },
      { clip: 'p2_mic_dj', in: 25, at: 1400, duration: 50, audioTrack: 1 },   // lo repetido al final
    ],
  };
  return { final, partes: [{ indice: 1, receta: parte1 }, { indice: 2, receta: parte2 }] };
}

test('mapa del montaje: lo de antes del corte no se mueve, lo cortado no sale, lo de después se adelanta', () => {
  const { final, partes } = montaje();
  const mapa = YT.mapaDelMontaje(final, partes);
  assert.deepStrictEqual(YT.aFinal(mapa, 1, 7), [5]);           // 5 s después del origen (2)
  assert.deepStrictEqual(YT.aFinal(mapa, 1, 14), [], 'cae en lo cortado');
  assert.deepStrictEqual(YT.aFinal(mapa, 1, 18), [12]);         // 16 s → frame 400 → al 250 + 50
  assert.deepStrictEqual(YT.aFinal(mapa, 1, 1), [], 'antes del principio del montaje');
});

test('mapa del montaje: la parte 2 va detrás, y lo repetido al final sale dos veces', () => {
  const { final, partes } = montaje();
  const mapa = YT.mapaDelMontaje(final, partes);
  assert.deepStrictEqual(YT.aFinal(mapa, 2, 0.5), [36.5]);
  assert.deepStrictEqual(YT.aFinal(mapa, 2, 1.5), [37.5, 56.5]);
});

test('palabras: la puntuación se queda pegada a su palabra y las marcas de Whisper se quitan', () => {
  const f = whisper([[10, 13, '¿Qué tal, Douglas? Bien.']]);
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  j.transcription[0].tokens.push({ text: '[_TT_150]', offsets: { from: 13000, to: 13000 } });
  fs.writeFileSync(f, JSON.stringify(j));
  assert.deepStrictEqual(YT.palabrasConPuntuacion(f).map((p) => p.w), ['¿Qué', 'tal,', 'Douglas?', 'Bien.']);
});

test('palabras finales: las de un tramo cortado no salen y las repetidas salen en los dos sitios', () => {
  const { final, partes } = montaje();
  const mapa = YT.mapaDelMontaje(final, partes);
  const p1 = [{ w: 'hola', a: 7, b: 7.4 }, { w: 'cortada', a: 13, b: 13.5 }, { w: 'después', a: 18, b: 18.5 }];
  const p2 = [{ w: 'repetida', a: 1.5, b: 1.9 }];
  const out = YT.palabrasFinales(mapa, [{ indice: 1, palabras: p1 }, { indice: 2, palabras: p2 }]);
  assert.deepStrictEqual(out.map((p) => [p.w, p.ini]), [['hola', 5], ['después', 12], ['repetida', 37.5], ['repetida', 56.5]]);
  assert.ok(Math.abs(out[0].fin - 5.41) < 0.02);
});

test('subtítulos: se parten en las pausas, al acabar una frase y por largo; duran al menos 1 s sin pisarse', () => {
  const p = (w, ini, fin) => ({ w, ini, fin });
  const cues = YT.subtitulos([
    p('Hola', 0, 0.3), p('a', 0.35, 0.4), p('todos.', 0.45, 0.8),            // corta: no llega a 20 caracteres
    p('Bienvenidos', 0.9, 1.4), p('a', 1.45, 1.5), p('otro', 1.55, 1.8), p('episodio', 1.85, 2.1), p('más.', 2.1, 2.3),
    p('Hoy', 4, 4.2),                                                          // tras una pausa de 1,7 s
    ...'esta es una frase muy larga que no cabe en dos líneas de cuarenta y dos caracteres seguro que no'.split(' ')
      .map((w, i) => p(w, 4.3 + i * 0.2, 4.45 + i * 0.2)),
  ]);
  assert.strictEqual(cues[0].texto, 'Hola a todos. Bienvenidos a otro episodio más.');
  assert.deepStrictEqual(cues[0].lineas, ['Hola a todos.', 'Bienvenidos a otro episodio más.'], 'mejor tras el punto que justo en el medio');
  assert.strictEqual(cues[1].ini, 4);
  assert.ok(cues.every((c) => c.lineas.every((l) => l.length <= 42) && c.lineas.length <= 2), JSON.stringify(cues));
  for (let i = 1; i < cues.length; i += 1) assert.ok(cues[i - 1].fin < cues[i].ini, 'no se pisan');
  const srt = YT.aSrt(cues);
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:02,300\nHola a todos\.\nBienvenidos a otro episodio más\.\n\n2\n00:00:04,000 --> /);
});

test('capítulos: por frase (en el vídeo final), por minuto, el primero en 0:00 y avisos de YouTube', () => {
  const { final, partes } = montaje();
  const mapa = YT.mapaDelMontaje(final, partes);
  const transcripciones = [
    { indice: 1, palabras: [{ w: 'Hola,', a: 7, b: 7.4 }, { w: 'bienvenidos.', a: 7.5, b: 8 }, { w: 'Hablemos', a: 18, b: 18.4 }, { w: 'de', a: 18.5, b: 18.6 }, { w: 'Japón.', a: 18.7, b: 19 }, { w: 'Cortado', a: 13, b: 13.4 }] },
    { indice: 2, palabras: [{ w: 'Y', a: 0.2, b: 0.3 }, { w: 'para', a: 0.4, b: 0.6 }, { w: 'terminar', a: 0.7, b: 1 }] },
  ];
  const r = YT.resolverCapitulos([
    { titulo: 'Intro' },
    { titulo: 'Japón', frase: 'hablemos de japon' },
    { titulo: 'Despedida', frase: 'y para terminar' },
    { titulo: 'Final', en: '0:55' },
    { titulo: 'Fantasma', frase: 'esto no se dijo' },
    { titulo: 'Quitado', frase: 'cortado' },
  ], { mapa, transcripciones });
  assert.deepStrictEqual(r.capitulos.map((c) => [Math.round(c.t * 10) / 10, c.titulo]), [[0, 'Intro'], [12, 'Japón'], [36.2, 'Despedida'], [55, 'Final']]);
  assert.ok(r.avisos.some((a) => /no encuentro «esto no se dijo»/.test(a)));
  assert.ok(r.avisos.some((a) => /«cortado» cae en un tramo cortado/.test(a)));
  // Pocos capítulos o muy juntos: YouTube no los muestra.
  const pocos = YT.resolverCapitulos([{ titulo: 'Intro' }, { titulo: 'Japón', frase: 'hablemos de japon' }], { mapa, transcripciones });
  assert.ok(pocos.avisos.some((a) => /al menos 3 capítulos/.test(a)));
  const tarde = YT.resolverCapitulos([{ titulo: 'Japón', frase: 'y para terminar' }, { titulo: 'b', en: '0:40' }, { titulo: 'c', en: '0:45' }], { mapa, transcripciones });
  assert.strictEqual(tarde.capitulos[0].t, 0);
  assert.ok(tarde.avisos.some((a) => /primero sea el 0:00/.test(a)));
  assert.ok(tarde.avisos.some((a) => /menos de 10 s/.test(a)));
});

test('descripción: resumen, capítulos (minuto hacia abajo) y el pie del equipo', () => {
  const d = YT.descripcion({ resumen: 'Hablamos de Japón.', capitulos: [{ t: 0, titulo: 'Intro' }, { t: 72.9, titulo: 'Japón' }], pie: 'Síguenos en Spotify: https://x' });
  assert.strictEqual(d, 'Hablamos de Japón.\n\nCapítulos:\n0:00 Intro\n1:12 Japón\n\nSíguenos en Spotify: https://x');
  assert.strictEqual(YT.descripcion({}), '');
});

test('índice: cada tramo con cómo empieza y sus palabras más repetidas (sin las vacías)', () => {
  const pal = 'bueno pues hoy hablamos de Japón porque Japón es increíble y el viaje a Japón fue largo viaje'.split(' ')
    .map((w, i) => ({ w, ini: i, fin: i + 0.5 }));
  const [linea] = YT.indice(pal, 120);
  assert.match(linea, /^\[0:00\] «bueno pues hoy hablamos de Japón/);
  assert.match(linea, /· japón, viaje, fue|· japón, viaje/);
  assert.doesNotMatch(linea.split('·').pop(), /\bpues\b|\bporque\b/);
});
