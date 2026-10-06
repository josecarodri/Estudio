/*
 * Montaje automático de una conversación grabada a varias cámaras.
 *
 * El material típico de una entrevista a distancia son: la cámara de cada persona, el
 * audio limpio de su micro, y la captura de la llamada. Montarlo a mano es
 * sincronizar todo y luego ir cortando a quien habla. Esto hace las dos cosas:
 *
 *   1. sincroniza cada archivo contra una referencia (sync.js);
 *   2. decide quién habla en cada momento comparando la energía de los micros;
 *   3. escribe una receta que corta de cámara a cámara siguiendo esos turnos,
 *      con el audio de los micros continuo en sus pistas.
 *
 * El audio no se corta nunca: cortar vídeo y dejar el audio seguido es lo que hace
 * que un montaje de conversación no suene a saltos.
 */
'use strict';

const ROLES = {
  cam: ['camara', 'camera', 'cam', 'video', 'webcam'],
  mic: ['audio', 'mic', 'micro', 'microfono', 'voz', 'voice'],
  call: ['llamada', 'call', 'zoom', 'meet', 'reunion', 'meeting', 'teams'],
};

function sinAcentos(texto) {
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/*
 * Nombre del archivo sin carpetas ni extensión, partiendo tanto por / como por \.
 * No vale path.basename: en Linux la barra invertida de una ruta de Windows es un
 * carácter normal, y las rutas pueden venir de cualquiera de los dos sistemas.
 */
function nombreBase(ruta) {
  const ultimo = String(ruta).split(/[\\/]/).pop() || '';
  return ultimo.replace(/\.[^.]*$/, '');
}

/*
 * De quién es un archivo y para qué sirve, a partir del nombre: "dj_camara.mp4" es la cámara
 * de dj, "jc-2_audio (1).wav" el micro de jc-2 y "2026-10-10_21-30-05_jc_llamada.mp4" la
 * llamada de jc. Devuelve { rol, quien } (rol null si no se reconoce).
 */
function analizarNombre(file) {
  const base = sinAcentos(nombreBase(file));
  // Se quitan la fecha de la sesión que pone el Estudio al descargar y los sufijos que añaden
  // los navegadores: "(1)", "-2".
  const limpio = base.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}_/, '')
    .replace(/[\s_-]*\(\d+\)\s*$/, '').replace(/[\s_-]+\d+$/, '');
  const trozos = limpio.split(/[\s_.-]+/).filter(Boolean);
  for (const [rol, palabras] of Object.entries(ROLES)) {
    if (trozos.some((t) => palabras.includes(t))) {
      // La persona es lo que queda al quitar la palabra del rol.
      return { rol, quien: trozos.filter((t) => !palabras.includes(t)).join('-') || 'sin-nombre' };
    }
  }
  return { rol: null, quien: null };
}

/* «jc-2» es el tramo 2 de jc (la página se cayó y se retomó); «jc» es el 1. */
const tramoDe = (quien) => Number((/-(\d+)$/.exec(String(quien)) || [])[1] || 1);

/*
 * Deduce a quién pertenece cada archivo y para qué sirve, a partir del nombre.
 * Con "dj_camara.mp4" y "jc_audio (1).wav" acierta; si no, se corrige a mano.
 *
 * Las llamadas se devuelven todas, ordenadas por persona y tramo: si la página que graba la
 * llamada se cae y se retoma, hay dos (jc_llamada y jc-2_llamada) y hacen falta las dos.
 */
function inferRoles(files) {
  const people = new Map();
  const unknown = [];
  const llamadas = [];

  for (const file of files) {
    const { rol, quien } = analizarNombre(file);
    if (rol === 'call') {
      llamadas.push({ file, quien, base: personaBase(quien), tramo: tramoDe(quien) });
      continue;
    }
    if (!rol) {
      unknown.push(file);
      continue;
    }
    if (!people.has(quien)) people.set(quien, { id: quien });
    const entrada = people.get(quien);
    if (!entrada[rol]) entrada[rol] = file;
    else unknown.push(file);
  }

  llamadas.sort((a, b) => a.base.localeCompare(b.base) || a.tramo - b.tramo);
  return { people, call: llamadas.length ? llamadas[0].file : null, calls: llamadas.map((l) => l.file), llamadas, unknown };
}

/* Convierte una envolvente lineal a dB, con suelo para no tener -Infinity. */
function aDb(env) {
  const out = new Float64Array(env.length);
  for (let i = 0; i < env.length; i += 1) {
    out[i] = 20 * Math.log10(Math.max(env[i], 1e-6));
  }
  return out;
}

function suavizar(valores, ventana) {
  const n = valores.length;
  const out = new Float64Array(n);
  const mitad = Math.max(1, Math.floor(ventana / 2));
  let suma = 0;
  let cuenta = 0;
  for (let i = 0; i < n; i += 1) {
    suma += valores[i];
    cuenta += 1;
    if (i - mitad * 2 >= 0) {
      suma -= valores[i - mitad * 2];
      cuenta -= 1;
    }
    out[Math.max(0, i - mitad)] = suma / cuenta;
  }
  for (let i = n - mitad; i < n; i += 1) out[i] = out[Math.max(0, n - mitad - 1)];
  return out;
}

function percentil(valores, p) {
  const copia = Array.from(valores).sort((a, b) => a - b);
  return copia[Math.min(copia.length - 1, Math.max(0, Math.floor(copia.length * p)))];
}

// Cuánto por debajo del nivel más alto puede quedar el suelo de ruido, como mucho.
const RANGO_MAXIMO_DB = 25;

/*
 * Suelo de ruido de una pista, en dB.
 *
 * El percentil bajo funciona cuando la persona calla parte del tiempo. Pero en un
 * monólogo (alguien que habla el 90% de la grabación) ese percentil cae *dentro* de
 * su propia voz, y entonces no se la detectaría hablando nunca. De ahí el segundo
 * término: el suelo nunca queda a menos de 25 dB del nivel más alto.
 */
function sueloDeRuido(suave) {
  const p20 = percentil(suave, 0.2);
  let maximo = -Infinity;
  for (let i = 0; i < suave.length; i += 1) {
    if (suave[i] > maximo) maximo = suave[i];
  }
  return Math.min(p20, maximo - RANGO_MAXIMO_DB);
}

/*
 * Quién habla en cada momento.
 *
 * pistas: [{ id, envelope, offsetBins }] — la envolvente de cada micro y cuántos bins
 * después empezó su archivo respecto a la referencia.
 *
 * Devuelve [{ startBin, endBin, id }] en tiempo de la referencia.
 *
 * Reglas, y el motivo de cada una:
 *  - gana quien tiene más energía, pero hace falta una ventaja clara (margenDb) para
 *    que la respiración o el eco del otro micro no provoquen un corte;
 *  - un plano dura un mínimo (minShotBins): cortar cada vez que alguien asiente marea;
 *  - en los silencios no se corta: se mantiene a quien estuviera.
 */
function detectTurns(pistas, options) {
  const opts = options || {};
  const binHz = opts.binHz || 100;
  const minShotBins = Math.round((opts.minShot || 2) * binHz);
  const confirmarBins = Math.round((opts.confirm || 0.5) * binHz);
  const margenDb = opts.margenDb !== undefined ? opts.margenDb : 4;
  const sobreSueloDb = opts.sobreSueloDb !== undefined ? opts.sobreSueloDb : 8;
  const desde = opts.fromBin || 0;
  const hasta = opts.toBin;

  const preparadas = pistas.map((p) => {
    const db = aDb(p.envelope);
    const suave = suavizar(db, Math.round(0.25 * binHz));
    return { id: p.id, suave, offsetBins: p.offsetBins, suelo: sueloDeRuido(suave) };
  });

  const valorEn = (pista, bin) => {
    // bin está en tiempo de la referencia; dentro del archivo es bin - offset.
    const local = bin - pista.offsetBins;
    if (local < 0 || local >= pista.suave.length) return null;
    return pista.suave[local];
  };

  const turnos = [];
  let actual = null;
  let inicio = desde;
  let candidato = null;
  let candidatoDesde = 0;

  for (let bin = desde; bin < hasta; bin += 1) {
    let mejor = null;
    let mejorValor = -Infinity;
    let segundoValor = -Infinity;

    for (const pista of preparadas) {
      const v = valorEn(pista, bin);
      if (v === null) continue;
      if (v > mejorValor) {
        segundoValor = mejorValor;
        mejorValor = v;
        mejor = pista;
      } else if (v > segundoValor) {
        segundoValor = v;
      }
    }

    // Nadie habla, o nadie destaca: se mantiene el plano actual.
    const hayVoz = mejor && mejorValor > mejor.suelo + sobreSueloDb;
    const destaca = segundoValor === -Infinity || mejorValor > segundoValor + margenDb;
    const ganador = hayVoz && destaca ? mejor.id : null;

    if (actual === null) {
      if (ganador) {
        actual = ganador;
        inicio = bin;
      }
      continue;
    }

    if (!ganador || ganador === actual) {
      candidato = null;
      continue;
    }

    // Otro quiere el plano: tiene que sostenerlo, y el plano actual durar lo mínimo.
    if (candidato !== ganador) {
      candidato = ganador;
      candidatoDesde = bin;
    }
    const sostenido = bin - candidatoDesde >= confirmarBins;
    const planoSuficiente = bin - inicio >= minShotBins;
    if (sostenido && planoSuficiente) {
      turnos.push({ startBin: inicio, endBin: candidatoDesde, id: actual });
      actual = ganador;
      inicio = candidatoDesde;
      candidato = null;
    }
  }

  if (actual !== null && hasta > inicio) {
    turnos.push({ startBin: inicio, endBin: hasta, id: actual });
  }

  return turnos;
}

/*
 * Receta de Kdenlive a partir de los turnos.
 *
 * sesion: {
 *   people: [{ id, cam, mic }],         archivos de cada persona
 *   offsets: { ruta: segundos },        cuánto después empezó cada archivo
 *   probes: { ruta: info de ffprobe },
 *   turns: [{ startBin, endBin, id }],  en tiempo de la referencia
 *   fps, width, height, binHz, fromBin
 * }
 */
function buildRecipe(sesion) {
  const { people, offsets, probes, turns, fps } = sesion;
  const binHz = sesion.binHz || 100;
  const aFrames = (bin) => Math.round((bin / binHz) * fps);

  const media = [];
  const idPorArchivo = new Map();
  const registrar = (archivo, id) => {
    if (idPorArchivo.has(archivo)) return idPorArchivo.get(archivo);
    idPorArchivo.set(archivo, id);
    media.push({ id, path: archivo });
    return id;
  };

  for (const persona of people) {
    if (persona.cam) registrar(persona.cam, `cam_${persona.id}`);
    if (persona.mic) registrar(persona.mic, `mic_${persona.id}`);
  }

  // Ajustes medidos sobre el material: ganancia por micro y color por cámara.
  const ganancias = sesion.ganancias || {};
  const colores = sesion.colores || {};

  const edit = [];
  const inicioTimeline = sesion.fromBin || 0;

  /*
   * Frames disponibles de un archivo, contados igual que los cuenta el motor
   * (segundos * fps, hacia abajo). Los bins de la envolvente y los segundos de
   * ffprobe se redondean por separado, así que sin acotar a esto un corte puede
   * pedir un frame más de los que el archivo tiene.
   */
  const framesDisponibles = (archivo) => {
    const info = probes[archivo];
    if (!info || !info.seconds) return null;
    return Math.floor(info.seconds * fps);
  };

  const acotar = (archivo, entrada, duracion) => {
    const total = framesDisponibles(archivo);
    if (total === null) return duracion;
    return Math.min(duracion, total - entrada);
  };

  /*
   * Vídeo: un corte por turno, desde la cámara de quien habla.
   *
   * La duración sale de restar las dos posiciones ya convertidas a frames, no de
   * convertir la duración por su cuenta. Redondear por separado el principio y lo
   * que dura hace que a veces un plano acabe un frame más allá de donde empieza el
   * siguiente, y entonces se solapan y Kdenlive no puede montarlos. Restando
   * posiciones, el final de un plano es exactamente el principio del otro.
   */
  for (const turno of turns) {
    const persona = people.find((p) => p.id === turno.id);
    if (!persona || !persona.cam) continue;
    const desfase = offsets[persona.cam] || 0;
    const inicioRef = turno.startBin / binHz;
    const dentroDelClip = inicioRef - desfase;
    if (dentroDelClip < 0) continue;

    const desde = aFrames(turno.startBin - inicioTimeline);
    const hasta = aFrames(turno.endBin - inicioTimeline);
    const entrada = Math.round(dentroDelClip * fps);
    const duracion = acotar(persona.cam, entrada, hasta - desde);
    if (duracion <= 0) continue;

    const corte = {
      clip: idPorArchivo.get(persona.cam),
      in: entrada,
      duration: duracion,
      at: desde,
      audio: false,
    };
    const color = colores[persona.cam];
    if (color) Object.assign(corte, color);
    edit.push(corte);
  }

  // Audio: cada micro entero y continuo, en su propia pista.
  const duracionTotal = aFrames((sesion.toBin || 0) - inicioTimeline);
  /*
   * Los tramos de una misma persona (jc y su retomado jc-2) comparten pista: no se solapan.
   * Un micro que empieza después del inicio del montaje (el tramo retomado) entra en su sitio.
   */
  const pistaDe = new Map();
  const cronologicas = [...people].sort((a, b) => (offsets[a.mic] || 0) - (offsets[b.mic] || 0));
  for (const persona of cronologicas) {
    if (!persona.mic) continue;
    const quien = personaBase(persona.id);
    if (!pistaDe.has(quien)) pistaDe.set(quien, pistaDe.size + 1);
    const desfase = offsets[persona.mic] || 0;
    const dentroDelClip = (inicioTimeline / binHz) - desfase;
    const entrada = dentroDelClip < 0 ? 0 : Math.round(dentroDelClip * fps);
    const en = dentroDelClip < 0 ? Math.round(-dentroDelClip * fps) : 0;
    const duracion = acotar(persona.mic, entrada, duracionTotal - en);
    if (duracion <= 0) continue;
    const pistaAudio = {
      clip: idPorArchivo.get(persona.mic),
      in: entrada,
      duration: duracion,
      at: en,
      audioTrack: pistaDe.get(quien),
    };
    if (ganancias[persona.mic]) pistaAudio.gain = ganancias[persona.mic];
    edit.push(pistaAudio);
  }

  const guides = turns.map((t) => ({
    at: aFrames(t.startBin - inicioTimeline),
    name: t.id,
    color: 'Blue',
  }));

  const primeraCam = people.find((p) => p.cam && probes[p.cam]);
  return {
    version: 1,
    notes: 'Montaje automático: corta a quien habla. El audio de los micros va continuo.',
    project: {
      name: sesion.nombre || 'Multicámara',
      fps,
      width: sesion.width || (primeraCam ? probes[primeraCam.cam].width : 1920) || 1920,
      height: sesion.height || (primeraCam ? probes[primeraCam.cam].height : 1080) || 1080,
    },
    bin: 'Material',
    media,
    timeline: { name: sesion.nombre || 'Multicámara v1' },
    tracks: { video: 1, audio: Math.max(1, pistaDe.size) },
    edit,
    guides,
  };
}

/* «jc-2» es el tramo retomado de «jc» tras una caída de la página del Estudio: la misma persona. */
function personaBase(id) {
  return String(id).replace(/-\d+$/, '');
}

module.exports = {
  personaBase, tramoDe, ROLES, sinAcentos, nombreBase, analizarNombre, inferRoles, aDb, suavizar, percentil,
  sueloDeRuido, detectTurns, buildRecipe,
};
