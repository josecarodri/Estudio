/*
 * Quitar tramos de un montaje ya repartido, y unir varias partes en una sola receta.
 *
 * Los cortes se aplican sobre la receta, no sobre el vídeo renderizado: así el proyecto
 * de Kdenlive sale ya cortado, y quien lo abra para retocar parte de lo bueno.
 *
 * Los tiempos de los cortes son segundos del RELOJ DE LA REFERENCIA (la llamada), que es
 * el que se ve al reproducir ese archivo. La receta guarda en `origenReferencia` en qué
 * punto de ese reloj empieza su línea de tiempo.
 */
'use strict';

const { spawnSync } = require('node:child_process');

/*
 * Silencios largos de un archivo, ya convertidos en tramos a quitar. Se deja `dejar`
 * segundos de silencio (mitad a cada lado) para que la pausa siga sonando a pausa.
 */
function detectarSilencios(file, options) {
  const o = options || {};
  const minimo = o.min !== undefined ? o.min : 4;
  const dejar = o.dejar !== undefined ? o.dejar : 1;
  const db = o.db !== undefined ? o.db : -42;

  const res = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file, '-vn',
    '-af', `silencedetect=n=${db}dB:d=${minimo}`, '-f', 'null', '-',
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return { error: (res.stderr || '').split('\n').slice(-4).join('\n') };

  const silencios = [];
  let inicio = null;
  for (const linea of (res.stderr || '').split('\n')) {
    let m = /silence_start: (-?[\d.]+)/.exec(linea);
    if (m) inicio = Number(m[1]);
    m = /silence_end: ([\d.]+) \| silence_duration: ([\d.]+)/.exec(linea);
    if (m && inicio !== null) {
      silencios.push({ inicio: Math.max(0, inicio), fin: Number(m[1]) });
      inicio = null;
    }
  }
  // Un silencio que llega hasta el final del archivo no trae "silence_end".
  const tramos = silencios
    .filter((s) => s.fin - s.inicio >= minimo)
    .map((s) => ({ desde: s.inicio + dejar / 2, hasta: s.fin - dejar / 2 }))
    .filter((t) => t.hasta > t.desde);
  return { tramos, total: silencios.length };
}

/* Une tramos que se tocan o se solapan y los deja ordenados. */
function unirTramos(tramos) {
  const orden = tramos.filter((t) => t.hasta > t.desde).sort((a, b) => a.desde - b.desde);
  const out = [];
  for (const t of orden) {
    const ultimo = out[out.length - 1];
    if (ultimo && t.desde <= ultimo.hasta) ultimo.hasta = Math.max(ultimo.hasta, t.hasta);
    else out.push({ desde: t.desde, hasta: t.hasta });
  }
  return out;
}

/*
 * Quita tramos de la línea de tiempo. `tramos` en frames de la timeline, sin solapes.
 * Parte los clips que los cruzan y corre lo que viene después. Devuelve una receta nueva.
 * En los clips de audio deja un fundido de un frame en cada corte para que no suene a clic.
 */
function aplicarCortesFrames(recipe, tramos) {
  const out = JSON.parse(JSON.stringify(recipe));
  const cortes = unirTramos(tramos.map((t) => ({ desde: t.desde, hasta: t.hasta })));
  if (!cortes.length) return out;

  // Cuánto se ha quitado antes del instante t.
  const quitadoAntes = (t) => {
    let q = 0;
    for (const c of cortes) {
      if (t >= c.hasta) q += c.hasta - c.desde;
      else if (t > c.desde) q += t - c.desde;
    }
    return q;
  };

  const nuevos = [];
  for (const e of recipe.edit) {
    const ini = e.at;
    const fin = e.at + e.duration;
    // Trozos que sobreviven: el clip menos los tramos cortados.
    let cursor = ini;
    const trozos = [];
    for (const c of cortes) {
      if (c.hasta <= cursor || c.desde >= fin) continue;
      if (c.desde > cursor) trozos.push([cursor, c.desde]);
      cursor = Math.max(cursor, c.hasta);
    }
    if (cursor < fin) trozos.push([cursor, fin]);

    trozos.forEach(([a, b], i) => {
      const trozo = JSON.parse(JSON.stringify(e));
      trozo.in = (e.in || 0) + (a - ini);
      trozo.duration = b - a;
      trozo.at = a - quitadoAntes(a);
      if (e.audioTrack) {
        const cortadoAntes = a > ini;
        const cortadoDespues = b < fin;
        if (cortadoAntes) trozo.fadeIn = 1;
        if (cortadoDespues) trozo.fadeOut = 1;
        void i;
      }
      nuevos.push(trozo);
    });
  }
  out.edit = nuevos.sort((x, y) => x.at - y.at);

  if (recipe.guides) {
    out.guides = recipe.guides.map((g) => {
      const t = typeof g.at === 'number' ? g.at : null;
      return t === null ? g : { ...g, at: t - quitadoAntes(t) };
    });
  }
  return out;
}

/* Lo mismo, con los tramos en segundos del reloj de la referencia. */
function aplicarCortes(recipe, tramosSeg) {
  const fps = Number((recipe.project || {}).fps) || 25;
  const origen = Number(recipe.origenReferencia) || 0;
  const frames = tramosSeg.map((t) => ({
    desde: Math.max(0, Math.round((t.desde - origen) * fps)),
    hasta: Math.max(0, Math.round((t.hasta - origen) * fps)),
  }));
  return aplicarCortesFrames(recipe, frames);
}

/* Fin de la línea de tiempo, en frames. */
function duracionFrames(recipe) {
  return recipe.edit.reduce((m, e) => Math.max(m, e.at + e.duration), 0);
}

/*
 * Une varias recetas (una por parte) en una: los clips de cada parte se prefijan para
 * no chocar y se colocan a continuación de la anterior. Todas deben ir al mismo fps.
 */
function unirRecetas(partes, nombre) {
  if (!partes.length) throw new Error('no hay partes que unir.');
  const fps = Number(partes[0].project.fps);
  for (const p of partes) {
    if (Number(p.project.fps) !== fps) {
      throw new Error(`las partes van a distinto ritmo (${fps} y ${p.project.fps} fps); `
        + 'no se pueden unir sin remuestrear.');
    }
  }
  const unida = JSON.parse(JSON.stringify(partes[0]));
  unida.media = [];
  unida.edit = [];
  unida.guides = [];
  if (nombre) {
    unida.project.name = nombre;
    unida.timeline = { ...(unida.timeline || {}), name: nombre };
  }
  delete unida.origenReferencia;

  let desplazamiento = 0;
  partes.forEach((p, i) => {
    const pre = `p${i + 1}_`;
    for (const m of p.media) unida.media.push({ ...m, id: pre + m.id });
    for (const e of p.edit) unida.edit.push({ ...e, clip: pre + e.clip, at: e.at + desplazamiento });
    for (const g of p.guides || []) unida.guides.push({ ...g, at: g.at + desplazamiento });
    desplazamiento += duracionFrames(p);
  });

  const pistas = (n) => Math.max(...partes.map((p) => ((p.tracks || {})[n]) || 1));
  unida.tracks = { video: pistas('video'), audio: pistas('audio') };
  return unida;
}

/*
 * Copia un tramo de una receta (segundos del reloj de la referencia) para ponerlo en otro
 * sitio. Devuelve los clips recortados con `at` relativo al inicio del tramo. En el audio
 * deja un fundido de un frame en los extremos para que no suene a clic.
 */
function extraerTramo(recipe, desdeSeg, hastaSeg) {
  const fps = Number((recipe.project || {}).fps) || 25;
  const origen = Number(recipe.origenReferencia) || 0;
  const a = Math.round((desdeSeg - origen) * fps);
  const b = Math.round((hastaSeg - origen) * fps);
  const piezas = [];
  for (const e of recipe.edit) {
    const ini = Math.max(e.at, a);
    const fin = Math.min(e.at + e.duration, b);
    if (fin <= ini) continue;
    const p = JSON.parse(JSON.stringify(e));
    p.in = (e.in || 0) + (ini - e.at);
    p.duration = fin - ini;
    p.at = ini - a;
    if (e.audioTrack) {
      p.fadeIn = 1;
      p.fadeOut = 1;
    }
    piezas.push(p);
  }
  return { piezas, frames: Math.max(0, b - a) };
}

/* Pone tramos extraídos al final de una receta, uno tras otro. `prefijo` es el de la unión. */
function agregarAlFinal(recipe, tramos, prefijo) {
  const out = JSON.parse(JSON.stringify(recipe));
  let cursor = duracionFrames(out);
  for (const t of tramos) {
    for (const p of t.piezas) out.edit.push({ ...p, clip: prefijo + p.clip, at: p.at + cursor });
    cursor += t.frames;
  }
  out.edit.sort((x, y) => x.at - y.at);
  return out;
}

/*
 * Mantiene la cámara que está en pantalla en `desdeSeg` hasta `hastaSeg`, en lugar de
 * cambiar de plano dentro del tramo. Evita las ráfagas de cambios rápidos (p. ej. al
 * despedirse). Se aplica sobre la receta SIN cortar, donde los planos son contiguos.
 */
function mantenerPlano(recipe, desdeSeg, hastaSeg) {
  const out = JSON.parse(JSON.stringify(recipe));
  const fps = Number((out.project || {}).fps) || 25;
  const origen = Number(out.origenReferencia) || 0;
  const a = Math.round((desdeSeg - origen) * fps);
  const b = Math.round((hastaSeg - origen) * fps);
  const esVideo = (e) => !e.audioTrack;
  const planos = out.edit.filter(esVideo).sort((x, y) => x.at - y.at);
  const activo = planos.find((e) => e.at <= a && a < e.at + e.duration);
  if (!activo) return out;
  const finOriginal = activo.at + activo.duration;
  if (finOriginal >= b) return out;

  // Un resto de menos de 4 frames sería un parpadeo: se absorbe en el plano que se mantiene.
  const RESTO_MINIMO = 4;
  const quitar = new Set();
  let fin = b;
  for (const e of planos) {
    if (e === activo || e.at < finOriginal) continue;
    const finE = e.at + e.duration;
    if (finE <= b + RESTO_MINIMO && e.at < b) {
      quitar.add(e);
      fin = Math.max(fin, finE);
    } else if (e.at < b) {
      const delta = b - e.at;
      e.in = (e.in || 0) + delta;
      e.at = b;
      e.duration -= delta;
    }
  }
  activo.duration = fin - activo.at;
  out.edit = out.edit.filter((e) => !quitar.has(e));
  return out;
}

/* En qué frame de la timeline queda un instante (segundos de la referencia) tras los cortes. */
function posicionTrasCortes(recipe, tramosSeg, seg) {
  const fps = Number((recipe.project || {}).fps) || 25;
  const origen = Number(recipe.origenReferencia) || 0;
  const cortes = unirTramos(tramosSeg.map((t) => ({
    desde: Math.max(0, Math.round((t.desde - origen) * fps)),
    hasta: Math.max(0, Math.round((t.hasta - origen) * fps)),
  })));
  const frame = Math.round((seg - origen) * fps);
  let quitado = 0;
  for (const c of cortes) {
    if (frame >= c.hasta) quitado += c.hasta - c.desde;
    else if (frame > c.desde) quitado += frame - c.desde;
  }
  return frame - quitado;
}

/*
 * Mete un tramo extraído en mitad de la timeline, en el frame `pos`: parte lo que lo cruza
 * y corre lo que viene después. `prefijo` es el de la parte de la que sale el tramo.
 */
function insertarTramo(recipe, tramo, pos, prefijo) {
  const out = JSON.parse(JSON.stringify(recipe));
  const nuevos = [];
  for (const e of out.edit) {
    const fin = e.at + e.duration;
    if (fin <= pos) {
      nuevos.push(e);
    } else if (e.at >= pos) {
      nuevos.push({ ...e, at: e.at + tramo.frames });
    } else {
      const antes = { ...e, duration: pos - e.at };
      const despues = { ...e, in: (e.in || 0) + (pos - e.at), duration: fin - pos, at: pos + tramo.frames };
      if (e.audioTrack) {
        antes.fadeOut = 1;
        despues.fadeIn = 1;
      }
      nuevos.push(antes, despues);
    }
  }
  for (const p of tramo.piezas) nuevos.push({ ...p, clip: prefijo + p.clip, at: p.at + pos });
  out.edit = nuevos.sort((x, y) => x.at - y.at);
  if (out.guides) out.guides = out.guides.map((g) => (g.at >= pos ? { ...g, at: g.at + tramo.frames } : g));
  return out;
}

module.exports = {
  mantenerPlano,
  posicionTrasCortes,
  insertarTramo,
  extraerTramo,
  agregarAlFinal,
  detectarSilencios,
  unirTramos,
  aplicarCortesFrames,
  aplicarCortes,
  duracionFrames,
  unirRecetas,
};
