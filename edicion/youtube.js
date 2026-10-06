/*
 * Lo de YouTube: subtítulos, capítulos y descripción, con los tiempos del vídeo FINAL.
 *
 * La transcripción de cada parte está en el reloj de su llamada; el vídeo final es otra cosa (cortes,
 * partes una tras otra, tramos insertados o repetidos al final). El «mapa del montaje» lo traduce
 * comparando la receta sin cortar de cada parte (parte-N/multicam.json: dónde empieza cada micro)
 * con la receta final (episodio.json: dónde quedó cada trozo de ese micro). Así no hay que volver a
 * transcribir el vídeo final, y lo que se quitó no sale.
 *
 * Los capítulos se escriben en el episodio.json del episodio por una FRASE de la transcripción (como
 * los cortes por texto), así siguen bien aunque luego cambien los cortes:
 *   "capitulos": [{ "titulo": "Intro" }, { "titulo": "El viaje", "frase": "bueno, cuéntame del viaje" }]
 * También vale "en": "12:34" (minuto del vídeo final). El primero va siempre en 0:00.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const A = require('./analizar.js');
const { reloj } = require('./transcribir.js');

/* Palabras de una transcripción de Whisper con su puntuación pegada («hola,» «¿qué»), y sus tiempos. */
function palabrasConPuntuacion(jsonFile) {
  const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const out = [];
  for (const s of j.transcription || []) {
    for (const t of s.tokens || []) {
      const txt = String(t.text || '');
      if (!txt.trim() || /^\s*\[_/.test(txt) || /^\s*\[.*\]\s*$/.test(txt)) continue;
      const a = t.offsets.from / 1000;
      const b = t.offsets.to / 1000;
      if (/^\s/.test(txt) || !out.length) out.push({ w: txt.trim(), a, b });
      else { const u = out[out.length - 1]; u.w += txt.trim(); u.b = Math.max(u.b, b); }
    }
  }
  return out.filter((p) => /[\p{L}\p{N}]/u.test(p.w));
}

/*
 * Mapa del montaje. `final`: la receta final; `partes`: [{ indice, receta }] con la receta sin cortar de
 * cada parte (su índice es el de los prefijos p1_, p2_… de la final). Devuelve { fps, tramos } con, para
 * cada trozo de micro de la final, qué frames de la parte sin cortar cubre y dónde quedó.
 */
function mapaDelMontaje(final, partes) {
  const fps = Number(final.project.fps);
  const tramos = [];
  for (const { indice, receta } of partes) {
    const origen = Number(receta.origenReferencia) || 0;
    const desfases = new Map(receta.edit.filter((e) => e.audioTrack).map((e) => [e.clip, (e.in || 0) - e.at]));
    const prefijo = `p${indice}_`;
    for (const e of final.edit) {
      if (!e.audioTrack || !String(e.clip).startsWith(prefijo)) continue;
      const clip = e.clip.slice(prefijo.length);
      if (!desfases.has(clip)) continue;
      const desde = (e.in || 0) - desfases.get(clip);
      tramos.push({ parte: indice, origen, desde, hasta: desde + e.duration, at: e.at });
    }
  }
  return { fps, tramos };
}

/* Un instante (segundos de la llamada de la parte `indice`) en el vídeo final: [segundos…] (puede salir más de una vez). */
function aFinal(mapa, indice, t) {
  const vistos = new Set();
  const out = [];
  for (const tr of mapa.tramos) {
    if (tr.parte !== indice) continue;
    const f = (t - tr.origen) * mapa.fps;
    if (f < tr.desde || f >= tr.hasta) continue;
    const s = Math.round(((tr.at + (f - tr.desde)) / mapa.fps) * 1000) / 1000;
    if (!vistos.has(s)) { vistos.add(s); out.push(s); }
  }
  return out.sort((x, y) => x - y);
}

/* Las palabras de todas las partes, en el tiempo del vídeo final (lo cortado no sale; lo repetido, dos veces). */
function palabrasFinales(mapa, transcripciones) {
  const out = [];
  for (const { indice, palabras } of transcripciones) {
    for (const p of palabras) {
      for (const ini of aFinal(mapa, indice, p.a)) {
        const fin = aFinal(mapa, indice, Math.max(p.a, p.b - 0.01)).find((x) => x >= ini && x - ini < 5);
        out.push({ w: p.w, ini, fin: fin != null ? fin + 0.01 : ini + 0.3, parte: indice, t: p.a });
      }
    }
  }
  return out.sort((x, y) => x.ini - y.ini);
}

/* Subtítulos: frases de hasta 2 líneas de 42 caracteres y 6 s, cortadas en las pausas y al acabar una frase. */
function subtitulos(palabras, opciones) {
  const o = { linea: 42, maximo: 6, pausa: 0.8, ...opciones };
  const cues = [];
  let actual = null;
  for (const p of palabras) {
    const texto = actual ? `${actual.texto} ${p.w}` : p.w;
    const nueva = !actual || p.ini - actual.fin > o.pausa || p.fin - actual.ini > o.maximo || texto.length > 2 * o.linea
      || (/[.?!…]$/.test(actual.texto) && actual.texto.length >= 20);
    if (nueva) {
      actual = { ini: p.ini, fin: p.fin, texto: p.w };
      cues.push(actual);
    } else {
      actual.texto = texto;
      actual.fin = Math.max(actual.fin, p.fin);
    }
  }
  // Cada uno se ve al menos 1 s, sin pisar al siguiente.
  cues.forEach((c, i) => {
    const sig = cues[i + 1];
    c.fin = Math.max(c.fin, c.ini + 1);
    if (sig) c.fin = Math.min(c.fin, sig.ini - 0.05);
  });
  return cues.filter((c) => c.fin > c.ini).map((c) => ({ ...c, lineas: partirEnLineas(c.texto, o.linea) }));
}

/* En dos líneas por el espacio más cercano al medio, mejor tras un punto o una coma si las dos caben. */
function partirEnLineas(texto, max) {
  if (texto.length <= max) return [texto];
  const medio = texto.length / 2;
  let mejor = -1;
  let nota = Infinity;
  for (let i = 0; i < texto.length; i += 1) {
    if (texto[i] !== ' ') continue;
    const caben = i <= max && texto.length - i - 1 <= max;
    const pausa = /[.?!…]/.test(texto[i - 1]) ? 12 : /[,;:]/.test(texto[i - 1]) ? 6 : 0;
    const n = Math.abs(i - medio) - (caben ? pausa : 0) + (caben ? 0 : 1000);
    if (n < nota) { nota = n; mejor = i; }
  }
  return mejor < 0 ? [texto] : [texto.slice(0, mejor), texto.slice(mejor + 1)];
}

const tiempoSrt = (s) => {
  const ms = Math.max(0, Math.round(s * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const x = Math.floor((ms % 60000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')},${String(r).padStart(3, '0')}`;
};

function aSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${tiempoSrt(c.ini)} --> ${tiempoSrt(c.fin)}\n${c.lineas.join('\n')}\n`).join('\n');
}

/* La transcripción del vídeo final, una frase por línea con su minuto (para buscar dónde empieza cada tema). */
function frasesConTiempo(palabras) {
  const lineas = [];
  let actual = null;
  for (const p of palabras) {
    if (!actual || p.ini - actual.fin > 2) {
      actual = { ini: p.ini, fin: p.fin, texto: p.w };
      lineas.push(actual);
    } else {
      actual.texto += ` ${p.w}`;
      actual.fin = p.fin;
    }
    if (/[.?!…]$/.test(p.w) && actual.texto.length > 60) actual = null;
  }
  return lineas.map((l) => `[${reloj(l.ini)}] ${l.texto}`);
}

const VACIAS = new Set(('a al algo algún alguna algunas alguno algunos ante antes aquel aquella aquí así aunque bien bueno cada casi como con '
  + 'contra cosa cosas cual cuando de del desde donde dos el ella ellas ellos en entonces entre era eres es esa esas ese eso esos esta '
  + 'está están estar estas este esto estos estoy fue fuera ha hace hacer hacia han has hasta hay he la las le les lo los mas más me mi '
  + 'mientras mis mismo mucho muy nada ni no nos nosotros o os otra otro para pero poco por porque pues que qué quien se sea ser si sí '
  + 'sido sin sobre son su sus también tan tanto te tener tengo ti tiene tienen todo todos tu tú tus un una uno unos usted ustedes va '
  + 'vamos van vez y ya yo él ok okay o sea digo tipo verdad claro vale mira oye sí no eh este esta ese pues entonces ahí ahora').split(/\s+/));

/* Índice corto: cada `bloque` segundos del vídeo final, cómo empieza y sus palabras más repetidas. */
function indice(palabras, bloque = 120) {
  const out = [];
  const total = palabras.length ? palabras[palabras.length - 1].fin : 0;
  for (let ini = 0; ini < total; ini += bloque) {
    const dentro = palabras.filter((p) => p.ini >= ini && p.ini < ini + bloque);
    if (!dentro.length) continue;
    const cuenta = new Map();
    for (const p of dentro) {
      const w = p.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
      if (w.length < 4 || VACIAS.has(w)) continue;
      cuenta.set(w, (cuenta.get(w) || 0) + 1);
    }
    const claves = [...cuenta.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([w]) => w);
    const inicio = dentro.slice(0, 18).map((p) => p.w).join(' ');
    out.push(`[${reloj(ini)}] «${inicio}…» · ${claves.join(', ')}`);
  }
  return out;
}

/*
 * Capítulos en el tiempo del vídeo final. Cada uno: { titulo, frase?, parte?, despuesDe?, ordinal? } o
 * { titulo, en: "12:34" }. Devuelve { capitulos: [{ t, titulo }], avisos }.
 */
function resolverCapitulos(entradas, ctx) {
  const avisos = [];
  const out = [];
  (entradas || []).forEach((c, i) => {
    const titulo = String((c && c.titulo) || '').trim();
    if (!titulo) { avisos.push(`el capítulo ${i + 1} no tiene título`); return; }
    if (i === 0 && !c.frase && c.en === undefined) { out.push({ t: 0, titulo }); return; }
    if (c.en !== undefined) {
      const t = String(c.en).split(':').map(Number).reduce((s, x) => s * 60 + x, 0);
      if (!Number.isFinite(t)) { avisos.push(`capítulo «${titulo}»: tiempo raro (${c.en})`); return; }
      out.push({ t, titulo });
      return;
    }
    const candidatas = ctx.transcripciones.filter((tr) => c.parte === undefined || String(tr.indice) === String(c.parte));
    let hallado = null;
    for (const tr of candidatas) {
      const despuesDe = c.despuesDe !== undefined ? String(c.despuesDe).split(':').map(Number).reduce((s, x) => s * 60 + x, 0) : 0;
      const m = A.buscarFrase(tr.palabras, String(c.frase), { despuesDe, ordinal: c.ordinal });
      if (!m) continue;
      const enFinal = aFinal(ctx.mapa, tr.indice, m.desde);
      if (!enFinal.length) { avisos.push(`capítulo «${titulo}»: la frase «${c.frase}» cae en un tramo cortado`); hallado = false; break; }
      hallado = { t: enFinal[0], titulo };
      break;
    }
    if (hallado) out.push(hallado);
    else if (hallado === null) avisos.push(`capítulo «${titulo}»: no encuentro «${c.frase}» en la transcripción`);
  });
  out.sort((a, b) => a.t - b.t);
  if (out.length) {
    if (out[0].t > 30) avisos.push(`el primer capítulo empezaba en ${reloj(out[0].t)}: YouTube exige que el primero sea el 0:00, así que se adelanta`);
    out[0].t = 0;
  }
  for (let i = 1; i < out.length; i += 1) {
    if (out[i].t - out[i - 1].t < 10) avisos.push(`«${out[i - 1].titulo}» dura menos de 10 s: YouTube no mostrará los capítulos`);
  }
  if (out.length && out.length < 3) avisos.push('hacen falta al menos 3 capítulos para que YouTube los muestre');
  return { capitulos: out, avisos };
}

/* La descripción para copiar en YouTube: resumen, capítulos y el pie del equipo (enlaces). */
function descripcion({ resumen, capitulos, pie }) {
  const partes = [];
  if (resumen) partes.push(String(resumen).trim());
  // El minuto se redondea hacia abajo: el capítulo no debe empezar después de su frase.
  if (capitulos && capitulos.length) partes.push(['Capítulos:', ...capitulos.map((c) => `${reloj(Math.floor(c.t))} ${c.titulo}`)].join('\n'));
  if (pie) partes.push(String(pie).trim());
  return partes.join('\n\n');
}

module.exports = {
  palabrasConPuntuacion, mapaDelMontaje, aFinal, palabrasFinales, subtitulos, aSrt, tiempoSrt,
  frasesConTiempo, indice, resolverCapitulos, descripcion,
};
