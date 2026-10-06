/*
 * Proceso fijo para un episodio: carpetas, configuración del equipo y acabado.
 *
 *   <raiz>/episodio.json            configuración del equipo, la que se repite cada semana
 *   <raiz>/<AAAA-MM-DD>/episodio.json  cortes y ajustes de ese episodio (se aplican encima)
 *   <raiz>/<AAAA-MM-DD>/originales  lo que sale del Estudio, sin tocar (una subcarpeta por sesión)
 *   <raiz>/<AAAA-MM-DD>/montaje     receta, proyecto de Kdenlive y render en bruto
 *   <raiz>/<AAAA-MM-DD>/entrega     el vídeo final para YouTube
 *
 * El acabado es una segunda pasada con ffmpeg sobre el render de melt: limpia el
 * sonido y lo normaliza a −14 LUFS (lo que YouTube toma como referencia), y deja el
 * vídeo en H.264 con el índice al principio para que empiece a verse sin descargarlo.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SUBCARPETAS = ['originales', 'montaje', 'entrega'];

/*
 * Lo que cambia de un equipo a otro. El retardo de audio va aquí porque es una
 * constante de la cadena de captura de cada persona, no de cada grabación.
 */
const CONFIG_POR_DEFECTO = {
  // Se suma sobre la medida de sincronía. Con el equipo de Jose y Douglas no hace falta ajuste: en el episodio del
  // 2026-10-03 el audio salió bien con «0» (el retardo se eligió a oído y se comprobó que no hay deriva).
  audioOffset: 'dj=0,jc=0',
  // Dónde empieza y termina el montaje, en segundos de la llamada. «auto» lo mide: empieza justo antes de la primera
  // voz tras el pitido de la claqueta y acaba tras la última voz, antes del pitido de cierre (si no hay, no recorta).
  desde: 'auto',
  hasta: 'auto',
  minShot: 2,
  // Silencios largos: se recortan dejando `dejar` segundos de pausa. Se buscan en la llamada y se
  // comprueban en los micros: si en un micro hay voz (la llamada perdió el audio de alguien), no se corta.
  silencios: { activo: true, min: 4, dejar: 1, db: -42, confirmarEnMicros: true },
  // Saltos de imagen: si a los dos lados de un corte se ve a la misma persona, se pone `segundos` la cámara
  // del otro justo después del corte, y no se deja junto a un corte un plano de menos de `minimo` segundos.
  disimularCortes: { activo: true, segundos: 1.5, minimo: 0.6 },
  // Aviso al terminar lo que tarda (render, análisis…): en Windows y, si se pone un tema de ntfy, en el móvil.
  avisos: { activo: true, windows: true, ntfy: '', minimoSegundos: 60 },
  // Tramos a quitar siempre, en segundos del reloj de la llamada: [["2:02", "2:34"]].
  cortes: [],
  // Limpieza de un micro en un tramo: [{ persona: "jc", desde: 640, hasta: 730 }].
  limpiezas: [],
  // Ajustes propios de cada parte, por su número: { "1": { audioOffset, desde, hasta, cortes } }.
  partes: {},
  lufsMicros: -16,
  // Acabado para YouTube.
  lufsEntrega: -14,
  picoVerdadero: -1,
  crf: 18,
  // Codificación del vídeo final. x264 con preset "medium" tarda ~1,7 veces menos que "slow" y el
  // archivo sale apenas un 2 % mayor (YouTube lo vuelve a codificar). "nvenc" usa la tarjeta gráfica:
  // mucho más rápido; si falla, se repite solo con x264.
  codificador: 'x264',
  preset: 'medium',
  limpiarAudio: true,
  quitarRuido: false,
  // Corrección de color de acabado, igual para las dos cámaras (que ya van emparejadas
  // entre sí): muy suave, elegida a ojo por Jose entre varias. Ponla en activo:false para
  // dejar el color como sale de las cámaras.
  color: {
    activo: true,
    // Curva de contraste casi imperceptible (puntos entrada/salida de 0 a 1).
    curvas: "all='0/0 0.25/0.235 0.75/0.765 1/1'",
    saturacion: 1.05,
    gamma: 1.02,
    brillo: 0,
    vibrance: 0.18,
    equilibrio: '',
  },
};

/*
 * Ajustes que son de UN episodio: tiempos de su grabación y lo propio de cada parte. Van en el
 * episodio.json de la carpeta del episodio. En el de la raíz (lo que se repite cada semana) se
 * ignoran: si no, los cortes de un episodio se aplicarían también a los siguientes.
 */
const CLAVES_DEL_EPISODIO = ['partes', 'cortes', 'limpiezas', 'mantenerPlano', 'insertar', 'alFinal'];

/* Lo que se escribe al crear un episodio: su episodio.json, de momento sin cortes. */
const PLANTILLA_EPISODIO = { cortes: [], partes: {} };

const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clonar = (v) => JSON.parse(JSON.stringify(v));
const estaVacio = (v) => v === undefined || v === null || (Array.isArray(v) ? !v.length : esObjeto(v) && !Object.keys(v).length);

/* Mezcla `encima` sobre `base`; los objetos (color, silencios…) campo a campo, las listas enteras. */
function fusionar(base, encima) {
  const out = clonar(base);
  for (const [k, v] of Object.entries(encima || {})) {
    out[k] = esObjeto(v) && esObjeto(out[k]) ? fusionar(out[k], v) : clonar(v === undefined ? null : v);
  }
  return out;
}

/*
 * ¿Es un ajuste de un episodio concreto? Los cortes y las partes siempre (si tienen algo). Y
 * `desde`/`hasta` cuando son un tiempo: "auto" vale para todos, pero "2:02" es de una grabación.
 */
function esDelEpisodio(clave, valor) {
  if (CLAVES_DEL_EPISODIO.includes(clave)) return !estaVacio(valor);
  if (clave === 'desde' || clave === 'hasta') return !(valor === 'auto' || valor === true || valor === null || valor === undefined);
  return false;
}

function separarAjustes(datos) {
  const equipo = {};
  const delEpisodio = {};
  for (const [k, v] of Object.entries(datos || {})) {
    if (esDelEpisodio(k, v)) delEpisodio[k] = v;
    else equipo[k] = v;
  }
  return { equipo, delEpisodio };
}

// Sesión del Estudio en el nombre de lo que se descarga: 2026-10-10_21-30-05_dj_camara.mp4
const PREFIJO_SESION = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})_/;
const EXT_MEDIA = /\.(mp4|mov|mkv|webm|wav|m4a|mp3)$/i;

/*
 * Cada parte es una sesión de grabación del Estudio (con reconexiones hay varias). Se
 * reconocen, de más a menos fiable:
 *   1. una subcarpeta por sesión en originales/ (la crea `importar` desde el Estudio, con su
 *      session.json) o el prefijo con la fecha de la sesión que pone el Estudio al descargar.
 *      Se ordenan por esa fecha, que es la de la grabación;
 *   2. el "(1)", "(2)" que añade el navegador al descargar dos veces el mismo nombre. Es frágil:
 *      el navegador numera cada nombre por su cuenta, según lo que ya hubiera en Descargas. Por eso
 *      se cuenta por nombre: de cada nombre, el primero (sin número o con el más bajo) es de la
 *      sesión 1, el siguiente de la 2… Así dos sesiones bajadas con Descargas vacía ("dj_camara"
 *      y "dj_camara (1)") son dos partes, y una sola sesión en la que el navegador numeró solo
 *      algunos archivos sigue siendo una (antes se perdía una sesión entera en el primer caso).
 * Las partes se numeran 1, 2, 3… en ese orden, que es el que usa `partes` en episodio.json.
 */
function agruparPartes(carpeta) {
  const grupos = new Map();
  const meter = (clave, orden, datos, ruta) => {
    if (!grupos.has(clave)) grupos.set(clave, { orden, archivos: [], ...datos });
    grupos.get(clave).archivos.push(ruta);
  };
  const porNombre = new Map();   // nombre sin "(n)" -> [{ n, ruta }]
  for (const e of fs.readdirSync(carpeta, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const ruta = path.join(carpeta, e.name);
    if (e.isDirectory()) {
      for (const n of fs.readdirSync(ruta).filter((x) => EXT_MEDIA.test(x))) {
        meter(`sesion:${e.name}`, `0 ${e.name}`, { sesion: e.name, carpeta: ruta }, path.join(ruta, n));
      }
      continue;
    }
    if (!e.isFile() || !EXT_MEDIA.test(e.name)) continue;
    const pref = PREFIJO_SESION.exec(e.name);
    if (pref) {
      meter(`sesion:${pref[1]}`, `0 ${pref[1]}`, { sesion: pref[1], carpeta }, ruta);
      continue;
    }
    const m = /\s*\((\d+)\)(?=\.[^.]+$)/.exec(e.name);
    const nombre = m ? e.name.replace(m[0], '') : e.name;
    if (!porNombre.has(nombre)) porNombre.set(nombre, []);
    porNombre.get(nombre).push({ n: m ? Number(m[1]) : 0, ruta });
  }
  for (const lista of porNombre.values()) {
    lista.sort((a, b) => a.n - b.n).forEach((x, k) => {
      meter(`numero:${k}`, `1 ${String(k).padStart(6, '0')}`, { sesion: null, porNumero: true, carpeta }, x.ruta);
    });
  }
  return [...grupos.values()]
    .sort((a, b) => a.orden.localeCompare(b.orden))
    .map((g, i) => ({
      id: String(i + 1),
      sesion: g.sesion,
      porNumero: Boolean(g.porNumero),
      carpeta: g.carpeta,
      archivos: g.archivos.sort(),
    }));
}

/* La configuración de una parte: lo general, con lo propio de esa parte por encima. */
function configDeParte(config, id) {
  const propia = (config.partes || {})[id] || {};
  const cortes = [...(config.cortes || []), ...(propia.cortes || [])];
  return { ...config, ...propia, cortes };
}

/*
 * Carpetas fijas del podcast. Se pueden cambiar con las variables EPISODIOS_DIR y DESCARGAS_DIR.
 * Una carpeta por episodio dentro de EPISODIOS: AAAA-MM-DD/{originales,montaje,entrega}.
 */
const RAIZ_POR_DEFECTO = process.env.EPISODIOS_DIR || 'D:/Datos/Videos/Dos Tipos Promedio Podcast/Episodios';
const DESCARGAS_POR_DEFECTO = process.env.DESCARGAS_DIR || 'D:/Datos/Descargas';
// Las grabaciones del Estudio: la carpeta donde las guarda el servidor (grabaciones/ de este mismo repo,
// o la de GRABACIONES_DIR, la misma variable que usa server.js). De aquí se importa sin pasar por el navegador.
const ESTUDIO_POR_DEFECTO = path.resolve(process.env.GRABACIONES_DIR || path.join(__dirname, '..', 'grabaciones'));

/**
 * Archivos del Estudio recién descargados: dj_camara.mp4, jc_audio (1).wav, jc_llamada.mp4,
 * 2026-10-10_21-30-05_dj_camara.mp4… Solo los de las últimas `horas` (por omisión 36), para no
 * tocar descargas antiguas ni ajenas.
 */
function descubrirDescargas(carpeta, horas) {
  const limite = Date.now() - (horas || 36) * 3600 * 1000;
  const patron = /^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_)?[a-z0-9]+(-[a-z0-9]+)*_(camara|audio|llamada)( \(\d+\))?\.(mp4|mov|webm|wav|m4a)$/i;
  let nombres = [];
  try { nombres = fs.readdirSync(carpeta); } catch { return []; }
  return nombres
    .filter((n) => patron.test(n))
    .map((n) => ({ nombre: n, ruta: path.join(carpeta, n), mtime: fs.statSync(path.join(carpeta, n)).mtimeMs }))
    .filter((f) => f.mtime >= limite)
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
}

/*
 * Sesiones recientes en la carpeta de grabaciones del Estudio: grabaciones/<sala>/<sesión>/ con su
 * session.json. Es mejor fuente que Descargas: el orden sale de la propia sesión, no del "(1)" del
 * navegador; viene session.json (quién es quién, tramos retomados, horas de inicio) y no hace falta
 * bajar unos 10 GB por el navegador. Solo las de las últimas `horas`, de más antigua a más reciente.
 */
function descubrirSesionesEstudio(carpeta, horas) {
  const limite = Date.now() - (horas || 36) * 3600 * 1000;
  const sesiones = [];
  let salas = [];
  try { salas = fs.readdirSync(carpeta, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return []; }
  for (const sala of salas) {
    const dirSala = path.join(carpeta, sala.name);
    for (const e of fs.readdirSync(dirSala, { withFileTypes: true })) {
      const dir = path.join(dirSala, e.name);
      const meta = path.join(dir, 'session.json');
      if (!e.isDirectory() || !fs.existsSync(meta)) continue;
      let s;
      try { s = JSON.parse(fs.readFileSync(meta, 'utf8')); } catch { continue; }
      const creada = Date.parse(s.createdAt) || fs.statSync(meta).mtimeMs;
      if (creada < limite) continue;
      const archivos = Object.values(s.tracks || {})
        .filter((t) => t && t.file && fs.existsSync(path.join(dir, t.file)))
        .map((t) => ({
          nombre: t.file,
          ruta: path.join(dir, t.file),
          bytes: fs.statSync(path.join(dir, t.file)).size,
          completa: t.complete !== false,
        }))
        .sort((a, b) => a.nombre.localeCompare(b.nombre));
      if (archivos.length) sesiones.push({ id: e.name, sala: sala.name, dir, meta, creada, archivos });
    }
  }
  return sesiones.sort((a, b) => a.creada - b.creada || a.id.localeCompare(b.id));
}

/*
 * Copia (o mueve) una sesión del Estudio a originales/<sesión>/, con su session.json. Lo que ya está
 * con el mismo tamaño se salta, así que se puede repetir sin miedo (por ejemplo, si el invitado
 * terminó de subir después).
 */
function importarSesion(sesion, originales, opciones) {
  const o = opciones || {};
  const destino = path.join(originales, sesion.id);
  fs.mkdirSync(destino, { recursive: true });
  const hechos = [];
  for (const f of [...sesion.archivos, { nombre: 'session.json', ruta: sesion.meta, bytes: fs.statSync(sesion.meta).size }]) {
    const a = path.join(destino, f.nombre);
    if (fs.existsSync(a) && fs.statSync(a).size === f.bytes && f.nombre !== 'session.json') {
      hechos.push({ nombre: f.nombre, accion: 'ya estaba' });
      continue;
    }
    if (o.mover && f.nombre !== 'session.json') {
      try { fs.renameSync(f.ruta, a); } catch (e) {
        if (e.code !== 'EXDEV') throw e;
        fs.copyFileSync(f.ruta, a);
        fs.unlinkSync(f.ruta);
      }
      hechos.push({ nombre: f.nombre, accion: 'movido' });
    } else {
      fs.copyFileSync(f.ruta, a);
      hechos.push({ nombre: f.nombre, accion: 'copiado' });
    }
  }
  return { destino, hechos };
}

function fechaHoy() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function rutas(carpeta) {
  const base = path.resolve(carpeta);
  return {
    base,
    originales: path.join(base, 'originales'),
    montaje: path.join(base, 'montaje'),
    entrega: path.join(base, 'entrega'),
  };
}

function crearEstructura(carpeta) {
  const r = rutas(carpeta);
  for (const s of SUBCARPETAS) fs.mkdirSync(r[s], { recursive: true });
  return r;
}

function leerConfig(f) {
  if (!fs.existsSync(f)) return null;
  try {
    // Los editores de Windows (Bloc de notas, PowerShell) pueden guardar con una marca BOM al principio.
    return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${f} no es un JSON válido: ${e.message}`);
  }
}

const archivoDelEpisodio = (carpetaEpisodio) => path.join(path.resolve(carpetaEpisodio), 'episodio.json');
const archivoDeLaRaiz = (carpetaEpisodio) => path.join(path.dirname(path.resolve(carpetaEpisodio)), 'episodio.json');

/*
 * La configuración de un episodio, por capas: los valores por defecto; encima, el episodio.json
 * de la raíz (lo del equipo, igual cada semana); y encima, el de la carpeta del episodio (sus
 * cortes, limpiezas y partes). Lo que en la raíz es de un episodio concreto no se aplica: se
 * devuelve aparte, en `ignoradas`, con un aviso para moverlo a su sitio.
 */
function cargarConfig(carpetaEpisodio) {
  const archivoRaiz = archivoDeLaRaiz(carpetaEpisodio);
  const archivoEpisodio = archivoDelEpisodio(carpetaEpisodio);
  const raiz = leerConfig(archivoRaiz);
  const propia = leerConfig(archivoEpisodio);
  const avisos = [];
  let config = clonar(CONFIG_POR_DEFECTO);
  let ignoradas = {};
  if (raiz) {
    const { equipo, delEpisodio } = separarAjustes(raiz);
    config = fusionar(config, equipo);
    ignoradas = delEpisodio;
    if (Object.keys(delEpisodio).length) {
      avisos.push(`el episodio.json de la raíz tiene ajustes de un episodio concreto (${Object.keys(delEpisodio).join(', ')}) `
        + 'y no se aplican aquí. Pásalos a la carpeta de su episodio con: node cli.js config <carpeta-de-ese-episodio> --tomar-de-raiz');
    }
  }
  if (propia) config = fusionar(config, propia);
  const archivos = [raiz && archivoRaiz, propia && archivoEpisodio].filter(Boolean);
  return { config, archivo: archivos[archivos.length - 1] || null, archivos, archivoEpisodio, archivoRaiz, avisos, ignoradas };
}

/* El episodio.json de la raíz: solo lo del equipo (los cortes van en cada episodio). */
function escribirConfigSiFalta(raiz) {
  const f = path.join(path.resolve(raiz), 'episodio.json');
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const equipo = clonar(CONFIG_POR_DEFECTO);
  for (const k of CLAVES_DEL_EPISODIO) delete equipo[k];
  fs.writeFileSync(f, `${JSON.stringify(equipo, null, 2)}\n`, 'utf8');
  return f;
}

/* El episodio.json de un episodio, donde van sus cortes. */
function escribirConfigEpisodioSiFalta(carpetaEpisodio) {
  const f = archivoDelEpisodio(carpetaEpisodio);
  if (fs.existsSync(f)) return false;
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, `${JSON.stringify(PLANTILLA_EPISODIO, null, 2)}\n`, 'utf8');
  return f;
}

/*
 * Pasa a un episodio los ajustes de episodio (cortes, partes…) que quedaron en el episodio.json de
 * la raíz, y deja en la raíz solo lo del equipo. Antes guarda una copia de la raíz tal como estaba.
 */
function tomarDeRaiz(carpetaEpisodio) {
  const archivoRaiz = archivoDeLaRaiz(carpetaEpisodio);
  const archivoEpisodio = archivoDelEpisodio(carpetaEpisodio);
  const raiz = leerConfig(archivoRaiz);
  if (!raiz) return { movidas: [], motivo: `no hay ${archivoRaiz}` };
  const { equipo, delEpisodio } = separarAjustes(raiz);
  const claves = Object.keys(delEpisodio);
  if (!claves.length) return { movidas: [], motivo: 'el episodio.json de la raíz ya no tiene ajustes de episodio' };
  const propia = leerConfig(archivoEpisodio) || clonar(PLANTILLA_EPISODIO);
  const choques = claves.filter((k) => esDelEpisodio(k, propia[k]));
  if (choques.length) {
    throw new Error(`${archivoEpisodio} ya tiene ${choques.join(', ')}: júntalos a mano para no perder nada.`);
  }
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const copia = `${archivoRaiz}.copia-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  fs.copyFileSync(archivoRaiz, copia);
  fs.mkdirSync(path.dirname(archivoEpisodio), { recursive: true });
  fs.writeFileSync(archivoEpisodio, `${JSON.stringify({ ...propia, ...delEpisodio }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(archivoRaiz, `${JSON.stringify(equipo, null, 2)}\n`, 'utf8');
  return { movidas: claves, copia, archivoEpisodio, archivoRaiz };
}

/* Cadena de filtros de sonido. Conservadora: suena igual pero más limpio y parejo. */
function filtrosAudio(config) {
  const f = [];
  if (config.limpiarAudio) {
    f.push('highpass=f=80');
    if (config.quitarRuido) f.push('afftdn=nr=12:nf=-40');
    f.push('acompressor=threshold=-21dB:ratio=2.5:attack=20:release=250:makeup=1');
  }
  return f;
}

const MODELO_RNNOISE = 'D:/Datos/Herramientas/rnnoise/sh.rnnn';

/*
 * Limpia un micro solo dentro de unas ventanas (por ejemplo, un llanto de fondo que se
 * oye bajo la voz): reducción de ruido con IA (RNNoise) y una puerta que baja el micro
 * en los silencios. Fuera de las ventanas el audio queda idéntico. No cambia la duración,
 * así que no desplaza nada en el montaje. Deja un WAV nuevo y no toca el original.
 * `ventanas`: [{ desde, hasta, ia, puerta }] en segundos del propio archivo (o una sola).
 */
function limpiarMicro(entrada, salida, ventanas, config) {
  const lista = Array.isArray(ventanas) ? ventanas : [ventanas];
  const modelo = (config && config.rnnoise) || MODELO_RNNOISE;
  // Una sola instancia de cada filtro, activa en cualquiera de sus ventanas.
  const activo = (vs) => `enable='${vs.map((v) => `between(t,${Number(v.desde)},${Number(v.hasta)})`).join('+')}'`;
  const conIa = lista.filter((v) => v.ia !== false);
  const conPuerta = lista.filter((v) => v.puerta !== false);
  const filtros = [];
  if (conIa.length) {
    if (!fs.existsSync(modelo)) return { error: `falta el modelo de RNNoise: ${modelo}` };
    // El modelo va por nombre y se ejecuta desde su carpeta: la ruta con "C:" rompe el filtro.
    filtros.push(`arnndn=m=${path.basename(modelo)}:${activo(conIa)}`);
  }
  if (conPuerta.length) filtros.push(`agate=threshold=0.01:ratio=4:range=0.06:attack=15:release=300:${activo(conPuerta)}`);
  if (!filtros.length) return { error: 'la limpieza no tiene ningún filtro activo' };

  fs.mkdirSync(path.dirname(salida), { recursive: true });
  // Solo hace falta ejecutarlo desde la carpeta del modelo si se usa RNNoise; con la puerta sola,
  // esa carpeta puede ni existir.
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', path.resolve(entrada), '-af', filtros.join(','),
    '-c:a', 'pcm_s16le', path.resolve(salida)],
  { ...(conIa.length ? { cwd: path.dirname(modelo) } : {}), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return { error: `ffmpeg falló: ${(res.stderr || (res.error && res.error.message) || '').trim().split('\n').slice(-3).join(' ')}` };
  return { salida };
}

/* Cadena de filtros de color del acabado; vacía si está desactivado. */
function filtrosVideo(config) {
  const c = config.color;
  if (!c || c.activo === false) return [];
  const f = [];
  if (c.curvas) f.push(`curves=${c.curvas}`);
  else if (c.contraste) f.push(`curves=preset=${c.contraste}`);
  f.push(`eq=saturation=${c.saturacion}:gamma=${c.gamma}:brightness=${c.brillo}`);
  if (c.vibrance) f.push(`vibrance=intensity=${c.vibrance}`);
  if (c.equilibrio) f.push(`colorbalance=${c.equilibrio}`);
  return f;
}

/* Primera pasada de loudnorm: mide, sin escribir nada. */
function medirVolumen(entrada, filtros, config) {
  const cadena = [...filtros, `loudnorm=I=${config.lufsEntrega}:TP=${config.picoVerdadero}:LRA=11:print_format=json`];
  const res = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', entrada, '-vn', '-af', cadena.join(','), '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return { error: (res.stderr || '').split('\n').slice(-6).join('\n') };
  const m = /\{[\s\S]*?"target_offset"[\s\S]*?\}/.exec(res.stderr || '');
  if (!m) return { error: 'no se pudo leer la medida de volumen' };
  try {
    const j = JSON.parse(m[0]);
    return {
      i: j.input_i, tp: j.input_tp, lra: j.input_lra, thresh: j.input_thresh, offset: j.target_offset,
    };
  } catch (e) {
    return { error: `medida ilegible: ${e.message}` };
  }
}

/*
 * Segunda pasada: aplica los filtros y el normalizado con los valores medidos, que es
 * lo que lo hace exacto en lugar de aproximado.
 */
function acabado(entrada, salida, config) {
  const filtros = filtrosAudio(config);
  console.log('midiendo el volumen del montaje...');
  const medida = medirVolumen(entrada, filtros, config);
  if (medida.error) return { error: medida.error };
  console.log(`  antes: ${medida.i} LUFS · pico ${medida.tp} dBTP`);

  const ln = `loudnorm=I=${config.lufsEntrega}:TP=${config.picoVerdadero}:LRA=11`
    + `:measured_I=${medida.i}:measured_TP=${medida.tp}:measured_LRA=${medida.lra}`
    + `:measured_thresh=${medida.thresh}:offset=${medida.offset}:linear=true`;
  const af = [...filtros, ln].join(',');

  fs.mkdirSync(path.dirname(salida), { recursive: true });
  const codificar = (codificador) => {
    console.log(`codificando para YouTube (${codificador}) → ${salida}`);
    return spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error', '-stats',
      '-i', entrada,
      ...(filtrosVideo(config).length ? ['-vf', filtrosVideo(config).join(',')] : []),
      ...argumentosVideo(config, codificador),
      '-af', af, '-ar', '48000', '-c:a', 'aac', '-b:a', '256k',
      '-movflags', '+faststart',
      salida,
    ], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  };
  let codificador = config.codificador === 'nvenc' ? 'nvenc' : 'x264';
  let res = codificar(codificador);
  if (res.status !== 0 && codificador === 'nvenc') {
    console.log(`  aviso   la tarjeta gráfica (NVENC) no pudo codificar: ${(res.stderr || '').trim().split('\n').pop()}`);
    console.log('          se repite con x264');
    codificador = 'x264';
    res = codificar(codificador);
  }
  if (res.status !== 0) return { error: (res.stderr || 'ffmpeg falló').split('\n').slice(-6).join('\n') };
  return { medida, codificador };
}

/*
 * Parámetros de vídeo del acabado. x264 es la referencia de calidad; NVENC (la tarjeta gráfica)
 * tarda una fracción. A YouTube le llega igual de bien: lo vuelve a codificar.
 */
function argumentosVideo(config, codificador) {
  if (codificador === 'nvenc') {
    return ['-c:v', 'h264_nvenc', '-preset', 'p6', '-tune', 'hq', '-rc', 'vbr', '-cq', String(Number(config.crf) + 1),
      '-b:v', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
  }
  return ['-c:v', 'libx264', '-preset', String(config.preset || 'medium'), '-crf', String(config.crf), '-pix_fmt', 'yuv420p'];
}

module.exports = {
  SUBCARPETAS,
  CONFIG_POR_DEFECTO,
  CLAVES_DEL_EPISODIO,
  PLANTILLA_EPISODIO,
  RAIZ_POR_DEFECTO,
  DESCARGAS_POR_DEFECTO,
  ESTUDIO_POR_DEFECTO,
  PREFIJO_SESION,
  descubrirDescargas,
  descubrirSesionesEstudio,
  importarSesion,
  fechaHoy,
  agruparPartes,
  configDeParte,
  rutas,
  crearEstructura,
  fusionar,
  esDelEpisodio,
  separarAjustes,
  leerConfig,
  archivoDelEpisodio,
  cargarConfig,
  escribirConfigSiFalta,
  escribirConfigEpisodioSiFalta,
  tomarDeRaiz,
  filtrosAudio,
  filtrosVideo,
  argumentosVideo,
  limpiarMicro,
  medirVolumen,
  acabado,
};
