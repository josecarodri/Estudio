/*
 * Análisis rápido de una parte del episodio, para no decidir a mano lo que se puede medir:
 *   - dónde empieza y termina la conversación (entre el pitido de la claqueta del inicio y el del final);
 *   - qué momentos parecen charla técnica que se cortaría («lo cortamos», «se perdió la conexión»…);
 *   - citas de texto → tiempos, ajustados al silencio más cercano (la transcripción se desfasa hasta 0,5 s).
 *
 * Todos los tiempos salen en el reloj del archivo que se analiza (normalmente la llamada, que es la referencia).
 */
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const CAL = require('./calibrar.js');

const SR = 16000;
const VENTANA = 0.05;                // 50 ms por ventana de energía

/** Decodifica un tramo del audio a mono de 16 kHz. */
function pcm(file, desde, dur) {
  const res = spawnSync('ffmpeg', ['-v', 'error', '-ss', String(Math.max(0, desde)), '-t', String(dur), '-i', file,
    '-vn', '-ac', '1', '-ar', String(SR), '-f', 's16le', '-'], { maxBuffer: 256 * 1024 * 1024 });
  if (res.status !== 0) return null;
  const n = Math.floor(res.stdout.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = res.stdout.readInt16LE(i * 2) / 32768;
  return x;
}

function duracion(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return Number.parseFloat(r.stdout) || 0;
}

/** Energía en dB por ventanas de 50 ms. */
function energia(x) {
  const n = Math.round(SR * VENTANA);
  const out = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let e = 0;
    for (let k = 0; k < n; k += 1) e += x[i + k] * x[i + k];
    out.push(10 * Math.log10(e / n + 1e-12));
  }
  return out;
}

/** Tramos (en segundos) donde suena el pitido de 1 kHz de la claqueta. */
function pitidos(x, t0) {
  const n = Math.round(SR * 0.02);
  const hits = [];
  for (let w = 0; (w + 1) * n <= x.length; w += 1) {
    let e = 0;
    for (let i = 0; i < n; i += 1) e += x[w * n + i] * x[w * n + i];
    const tono = CAL.goertzel(x, w * n, n, 1000, SR);
    const prop = e > 0 ? tono / ((e * n) / 2) : 0;
    hits.push(prop > 0.6 && Math.sqrt(e / n) > 0.02);
  }
  const tramos = [];
  let ini = -1;
  for (let w = 0; w <= hits.length; w += 1) {
    if (w < hits.length && hits[w]) { if (ini < 0) ini = w; } else if (ini >= 0) {
      if ((w - ini) * 0.02 >= 0.15) tramos.push({ desde: t0 + ini * 0.02, hasta: t0 + w * 0.02 });
      ini = -1;
    }
  }
  return tramos;
}

function percentil(valores, p) {
  const s = [...valores].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

/** Ventanas con voz: por encima del suelo de ruido más un margen, y fuera de los pitidos. */
function conVoz(env, t0, pit, margenDb) {
  const suelo = percentil(env, 0.05);   // robusto con una voz casi continua (un monólogo)
  const umbral = Math.max(suelo + margenDb, -55);
  return env.map((db, i) => {
    const t = t0 + i * VENTANA;
    if (pit.some((p) => t >= p.desde - 0.05 && t <= p.hasta + 0.05)) return false;
    return db > umbral;
  });
}

/**
 * Dónde empieza y termina la conversación en este archivo.
 * inicio: primera voz sostenida después del pitido inicial (con 0,25 s de margen).
 * fin: última voz sostenida antes del pitido final (con 0,25 s de margen); null si no hay pitido final
 * (por ejemplo, si la grabación se cortó por una caída).
 */
function limitesDeVoz(file, opciones) {
  const o = opciones || {};
  const margen = o.margen !== undefined ? o.margen : 0.25;
  const dur = duracion(file);
  const res = { duracion: dur, pitidoInicio: null, pitidoFin: null, inicio: null, fin: null };
  if (!dur) return { ...res, error: 'no se pudo leer la duración' };

  const cabeza = pcm(file, 0, Math.min(25, dur));
  if (cabeza) {
    const pit = pitidos(cabeza, 0);
    res.pitidoInicio = pit[0] || null;
    const voz = conVoz(energia(cabeza), 0, pit, 14);
    const desde = res.pitidoInicio ? Math.ceil((res.pitidoInicio.hasta + 0.05) / VENTANA) : 0;
    for (let i = desde; i < voz.length - 6; i += 1) {
      if (voz.slice(i, i + 6).filter(Boolean).length >= 5) {
        const t = i * VENTANA;
        res.inicio = Math.max(res.pitidoInicio ? res.pitidoInicio.hasta + 0.05 : 0, t - margen);
        break;
      }
    }
  }

  const ventanaCola = Math.min(40, dur);
  const t0 = dur - ventanaCola;
  const cola = pcm(file, t0, ventanaCola);
  if (cola) {
    const pit = pitidos(cola, t0).filter((p) => p.desde > t0 + 1);
    res.pitidoFin = pit[pit.length - 1] || null;
    if (res.pitidoFin) {
      const voz = conVoz(energia(cola), t0, pit, 14);
      const tope = Math.floor((res.pitidoFin.desde - 0.1 - t0) / VENTANA);
      for (let i = tope; i >= 6; i -= 1) {
        if (voz.slice(i - 6, i).filter(Boolean).length >= 4) {
          res.fin = Math.min(res.pitidoFin.desde - 0.05, t0 + i * VENTANA + margen);
          break;
        }
      }
    }
  }
  return res;
}

// ------------------------------------------------------------------ marcas en la transcripción

const sinAcentos = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/*
 * Frases que casi siempre son charla técnica o una indicación de corte. Cada una lleva su tipo.
 * Se buscan sobre el texto sin acentos ni mayúsculas.
 */
const MARCAS = [
  // «Esto lo cortamos», «esto lo vas a cortar de todos modos». No vale «quitar»: es de la conversación («me lo quitaron»).
  { tipo: 'indicacion-de-corte', re: /\b(lo|eso|esto)\b( \w+){0,3} (cortamos|cortar|cortas|cortes|cortaremos|editamos|editar|editas|borramos|borrar)\b/ },
  { tipo: 'conexion', re: /\b(se perdio la (conexion|llamada)|perdi la (conexion|llamada)|perdimos la (conexion|llamada)|se cayo la (llamada|conexion)|se corto la (llamada|conexion)|me sali de la llamada|me saco de la llamada|te saco de la llamada|se desconecto|me desconecte|reconect(ando|ar|ado)|sin conexion)\b/ },
  { tipo: 'conexion', re: /\b(se congelo|te congelaste|estas congelado|esta congelado|te hagas congelado|se trabo|quedo trabad[ao]|estas trabad[ao]|se freezeo)\b/ },
  { tipo: 'prueba-de-sonido', re: /\b(se escucha|me escuchas|me oyes|se oye|me escuchan|me oyen|probando|prueba de (audio|sonido))\b/ },
  { tipo: 'tecnica', re: /\b(empezamos de nuevo|empecemos de nuevo|volvamos a empezar|vamos otra vez|otra vez desde el principio|no tengo luz|sin luz|mi luz|pon(go|er|es) la luz|enciende la luz|ya (puse|prendi|encendi) la luz)\b/ },
];

/** Normaliza una palabra o frase para compararla. */
const norm = (s) => sinAcentos(s).replace(/[^a-z0-9ñ ]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Candidatos a cortar: las marcas de charla técnica agrupadas en bloques. Las marcas separadas menos de `junto` s se
 * unen en un bloque; cada bloque se amplía hasta la pausa más cercana (de `pausa` s o más, y como mucho `maximoExtra`
 * s a cada lado), para que el tramo propuesto empiece y acabe en un silencio y no a mitad de frase.
 */
function candidatos(segmentos, opciones) {
  const o = opciones || {};
  const junto = o.junto || 30;
  const pausa = o.pausa || 1.0;
  const maximoExtra = o.maximoExtra || 8;
  const marcas = [];
  segmentos.forEach((s, i) => {
    const t = norm(s.texto);
    const m = MARCAS.find((x) => x.re.test(t));
    if (m) marcas.push({ i, tipo: m.tipo, texto: s.texto });
  });
  const bloques = [];
  for (const m of marcas) {
    const u = bloques[bloques.length - 1];
    if (u && segmentos[m.i].desde - segmentos[u.ultima].hasta <= junto) {
      u.ultima = m.i;
      u.tipos = [...new Set([...u.tipos, m.tipo])];
      u.marcas.push(m.texto);
    } else bloques.push({ primera: m.i, ultima: m.i, tipos: [m.tipo], marcas: [m.texto] });
  }
  return bloques.map((b) => {
    let a = b.primera;
    let z = b.ultima;
    while (a > 0 && segmentos[a].desde - segmentos[a - 1].hasta < pausa && segmentos[b.primera].desde - segmentos[a - 1].desde < maximoExtra) a -= 1;
    while (z < segmentos.length - 1 && segmentos[z + 1].desde - segmentos[z].hasta < pausa && segmentos[z + 1].hasta - segmentos[b.ultima].hasta < maximoExtra) z += 1;
    return {
      tipos: b.tipos,
      marcas: b.marcas,
      desde: segmentos[a].desde,
      hasta: segmentos[z].hasta,
      contexto: segmentos.slice(a, z + 1).map((x) => x.texto).join(' ').slice(0, 200),
    };
  });
}

// ------------------------------------------------------------------ citas de texto → tiempos

/** Palabras con tiempo de una transcripción de Whisper (JSON completo). */
function palabras(jsonFile) {
  const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const out = [];
  for (const s of j.transcription || []) {
    for (const t of s.tokens || []) {
      const w = String(t.text || '').trim();
      if (!w || /^\[_/.test(w) || /^[.,;:¿?¡!…]+$/.test(w)) continue;
      out.push({ w, a: t.offsets.from / 1000, b: t.offsets.to / 1000 });
    }
  }
  // Whisper parte las palabras en trozos (tokens): se unen los que no empiezan con espacio.
  const crudo = [];
  for (const s of j.transcription || []) {
    for (const t of s.tokens || []) {
      const txt = String(t.text || '');
      if (!txt.trim() || /^\s*\[_/.test(txt) || /^[\s.,;:¿?¡!…]+$/.test(txt)) continue;
      const nueva = /^\s/.test(txt) || crudo.length === 0;
      if (nueva) crudo.push({ w: txt.trim(), a: t.offsets.from / 1000, b: t.offsets.to / 1000 });
      else { const u = crudo[crudo.length - 1]; u.w += txt.trim(); u.b = t.offsets.to / 1000; }
    }
  }
  return crudo.length ? crudo : out;
}

/**
 * Busca una frase en la transcripción (sin acentos ni mayúsculas). Devuelve { desde, hasta } del primer
 * resultado a partir de `despuesDe` (s), o null. Con `ordinal` se elige la 2.ª, 3.ª… coincidencia.
 */
function buscarFrase(palabrasLista, frase, opciones) {
  const o = opciones || {};
  const buscadas = norm(frase).split(' ').filter(Boolean);
  if (!buscadas.length) return null;
  const lista = palabrasLista.map((p) => ({ ...p, n: norm(p.w) })).filter((p) => p.n);
  let visto = 0;
  const ordinal = o.ordinal || 1;
  for (let i = 0; i + buscadas.length <= lista.length; i += 1) {
    if (lista[i].a < (o.despuesDe || 0)) continue;
    let ok = true;
    for (let k = 0; k < buscadas.length; k += 1) {
      if (lista[i + k].n !== buscadas[k]) { ok = false; break; }
    }
    if (ok) {
      visto += 1;
      if (visto === ordinal) return { desde: lista[i].a, hasta: lista[i + buscadas.length - 1].b };
    }
  }
  return null;
}

/**
 * Lleva un instante al silencio más cercano (el punto de menor energía) dentro de ±`ventana` s.
 * Los cortes caen así en una pausa y no en mitad de una palabra aunque la transcripción vaya desfasada.
 */
function ajustarASilencio(file, t, ventana) {
  const w = ventana || 0.6;
  const x = pcm(file, Math.max(0, t - w), 2 * w);
  if (!x) return t;
  const env = energia(x);
  let mejor = 0;
  let valor = Infinity;
  // Se prefiere el centro de una pausa: promedio de 3 ventanas, y el más próximo al instante pedido.
  for (let i = 1; i < env.length - 1; i += 1) {
    const v = (env[i - 1] + env[i] + env[i + 1]) / 3 + Math.abs(i * VENTANA - w) * 4;
    if (v < valor) { valor = v; mejor = i; }
  }
  return Math.max(0, t - w) + mejor * VENTANA + VENTANA / 2;
}

/**
 * Saltos de brillo en los primeros segundos de una cámara (p. ej. alguien enciende una luz y la exposición cambia).
 * Devuelve el instante del salto mayor si pasa de `umbral` niveles de brillo (0-255), o null.
 */
function saltoDeBrilloInicial(file, segundos, umbral) {
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-t', String(segundos || 45), '-i', file, '-vf',
    'fps=2,scale=64:36,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-an', '-f', 'null', '-'],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const v = (res.stdout || '').split('\n').filter((l) => l.includes('YAVG=')).map((l) => Number(l.split('=')[1]));
  if (v.length < 12) return null;
  let mejor = null;
  const m = 10; // 5 s a cada lado: un cambio que se mantiene, no un parpadeo
  for (let i = m; i < v.length - m; i += 1) {
    const antes = v.slice(i - m, i).reduce((a, b) => a + b, 0) / m;
    const despues = v.slice(i, i + m).reduce((a, b) => a + b, 0) / m;
    const salto = Math.abs(despues - antes);
    if (salto >= (umbral || 8) && (!mejor || salto > mejor.salto)) mejor = { t: i / 2, salto: Math.round(salto), de: Math.round(antes), a: Math.round(despues) };
  }
  return mejor;
}

module.exports = {
  pcm, duracion, energia, pitidos, limitesDeVoz, candidatos, palabras, buscarFrase, ajustarASilencio,
  saltoDeBrilloInicial, norm, MARCAS,
};

/** Frases (segmentos) de una transcripción de Whisper: [{desde, hasta, texto}]. */
function segmentos(jsonFile) {
  const j = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  return (j.transcription || [])
    .map((s) => ({ desde: s.offsets.from / 1000, hasta: s.offsets.to / 1000, texto: String(s.text || '').trim() }))
    .filter((s) => s.texto);
}
module.exports.segmentos = segmentos;
