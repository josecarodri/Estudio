/*
 * Construye el XML de un proyecto de Kdenlive (.kdenlive) a partir de una receta.
 *
 * Un .kdenlive es XML de MLT, así que se puede escribir entero desde fuera: no hace
 * falta ningún plugin ni abrir el programa. La estructura que se genera aquí imita la
 * que escribe Kdenlive 23.04+ (versión de documento 1.1, "generación 5"):
 *
 *   <mlt producer="main_bin">
 *     <profile/>                        formato del proyecto (fps, tamaño)
 *     <producer id="black_track"/>      fondo negro, pista 0 del montaje
 *     <chain idN/>                      un clip de origen por archivo
 *     <playlist id="main_bin"/>         la bandeja: ajustes del documento + clips
 *     playlist+playlist+tractor         una pista = dos sub-listas y un tractor
 *     <tractor kdenlive:uuid>           la secuencia: pistas + mezclas internas
 *     <tractor kdenlive:projectTractor> envoltorio final
 *   </mlt>
 *
 * Las dos sub-listas por pista no son un capricho: son lo que permite que dos clips
 * de la misma pista se solapen, y por tanto los fundidos encadenados.
 *
 * Todo el tiempo se expresa en frames enteros del proyecto. MLT los acepta tal cual
 * y así no hay errores de redondeo al convertir a reloj con fps fraccionarios.
 */
'use strict';

/*
 * Las dos generaciones de formato que sabe escribir este generador.
 *
 * Un documento 1.1 NO se puede abrir con Kdenlive anterior a 23.04 (ahí se introdujo
 * el cambio por las secuencias anidadas). Al revés sí: un 1.04 lo abre cualquier
 * Kdenlive desde 20.08, y los modernos lo actualizan solos dejando una copia
 * _backup. Por eso 1.04 es la opción segura cuando no se sabe qué versión hay.
 */
const GENERATIONS = {
  '1.1': {
    docVersion: '1.1',
    kdenliveVersion: '23.04.0',
    // Kdenlive 23.04+ escribe los clips de archivo como <chain> (MLT 7).
    clipTag: 'chain',
    // La secuencia va en su propio tractor con uuid, envuelto en el projectTractor.
    sequences: true,
    minKdenlive: [23, 4],
  },
  '1.04': {
    docVersion: '1.04',
    kdenliveVersion: '22.12.3',
    clipTag: 'producer',
    sequences: false,
    minKdenlive: [20, 8],
  },
};

const DOC_VERSION = '1.1';
const KDENLIVE_VERSION = '23.04.0';
const MLT_VERSION = '7.22.0';

/* Qué generación hace falta para una versión de Kdenlive dada ([23,8] -> '1.1'). */
function generationFor(kdenliveVersion) {
  if (!Array.isArray(kdenliveVersion)) return DOC_VERSION;
  const [major, minor] = kdenliveVersion;
  const [reqMajor, reqMinor] = GENERATIONS['1.1'].minKdenlive;
  if (major > reqMajor || (major === reqMajor && minor >= reqMinor)) return '1.1';
  return '1.04';
}

// Servicio de composición entre pistas de vídeo. Es el que escribe Kdenlive moderno;
// las instalaciones antiguas o sin Qt usan los otros dos.
const COMPOSITING = ['qtblend', 'frei0r.cairoblend', 'composite'];

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* Los caracteres de control no son válidos en XML 1.0 ni escapados. */
function cleanText(value) {
  return String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function toFrames(value, fps, where) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${where}: tiempo no numérico`);
    return Math.round(value);
  }
  const s = String(value).trim();
  if (s === '') return null;

  const secs = s.match(/^(\d+(?:\.\d+)?)\s*[sS]$/);
  if (secs) return Math.round(parseFloat(secs[1]) * fps);
  if (/^\d+$/.test(s)) return parseInt(s, 10);

  const parts = s.split(/[:;]/);
  if (parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`${where}: timecode inválido ${JSON.stringify(value)}`);
  }
  const n = parts.map((p) => parseInt(p, 10));
  if (n.length === 4) return Math.round((n[0] * 3600 + n[1] * 60 + n[2]) * fps) + n[3];
  if (n.length === 3) return Math.round((n[0] * 3600 + n[1] * 60 + n[2]) * fps);
  if (n.length === 2) return Math.round((n[0] * 60 + n[1]) * fps);
  throw new Error(`${where}: timecode inválido ${JSON.stringify(value)}`);
}

function framesToTc(frames, fps) {
  const total = Math.max(0, Math.round(frames));
  const ifps = Math.max(1, Math.round(fps));
  const f = total % ifps;
  const secs = Math.floor(total / ifps);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}:${pad(secs % 60)}:${pad(f)}`;
}

/* Reduce fps a la fracción que espera <profile frame_rate_num/den>. */
function fpsFraction(fps) {
  const known = {
    23.976: [24000, 1001],
    29.97: [30000, 1001],
    47.952: [48000, 1001],
    59.94: [60000, 1001],
    119.88: [120000, 1001],
  };
  const rounded = Math.round(fps * 1000) / 1000;
  if (known[rounded]) return known[rounded];
  if (Number.isInteger(fps)) return [fps, 1];
  return [Math.round(fps * 1000), 1000];
}

function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

function displayAspect(width, height) {
  const d = gcd(width, height) || 1;
  return [width / d, height / d];
}

// --------------------------------------------------------------- constructor XML

class Xml {
  constructor() {
    this.lines = [];
  }

  open(tag, attrs, indent) {
    this.lines.push(`${' '.repeat(indent)}<${tag}${this.attrs(attrs)}>`);
  }

  close(tag, indent) {
    this.lines.push(`${' '.repeat(indent)}</${tag}>`);
  }

  empty(tag, attrs, indent) {
    this.lines.push(`${' '.repeat(indent)}<${tag}${this.attrs(attrs)}/>`);
  }

  prop(name, value, indent) {
    if (value === undefined || value === null || value === '') {
      this.lines.push(`${' '.repeat(indent)}<property name="${escapeXml(name)}"/>`);
    } else {
      this.lines.push(
        `${' '.repeat(indent)}<property name="${escapeXml(name)}">${escapeXml(cleanText(value))}</property>`,
      );
    }
  }

  attrs(attrs) {
    if (!attrs) return '';
    return Object.keys(attrs)
      .filter((k) => attrs[k] !== undefined && attrs[k] !== null)
      .map((k) => ` ${k}="${escapeXml(attrs[k])}"`)
      .join('');
  }

  toString() {
    return this.lines.join('\n') + '\n';
  }
}

// ------------------------------------------------------------------- disposición

/*
 * Convierte la lista de cortes en lo que hay que escribir por pista: entradas con su
 * posición en la timeline, a qué sub-lista van (0 o 1) y las mezclas entre ellas.
 *
 * Reglas:
 *  - sin "at", cada corte va detrás del anterior de su pista;
 *  - con "dissolve", el corte se solapa con el anterior esos frames y se pone en la
 *    sub-lista contraria, que es la única forma de que dos clips coexistan en la
 *    misma pista; la mezcla se declara en el tractor de la pista.
 */
function layout(recipe, media, fps) {
  const cuts = recipe.edit || [];

  // transform[] reencuadra un corte por su número (1 = el primero); se fusiona en
  // el corte y lo que diga el propio corte manda.
  const byIndex = new Map();
  for (const t of recipe.transform || []) byIndex.set(t.index, t);

  const tracks = new Map(); // índice de pista de vídeo -> { items: [], mixes: [] }
  const ensure = (n) => {
    if (!tracks.has(n)) tracks.set(n, { items: [], mixes: [], cursor: 0 });
    return tracks.get(n);
  };

  // Las pistas de audio llevan su propia cuenta: ahí caen tanto el audio de los
  // clips de vídeo como los clips de solo audio (un .wav de micro, por ejemplo).
  const lanes = new Map();
  const ensureLane = (n) => {
    if (!lanes.has(n)) lanes.set(n, { items: [], mixes: [], cursor: 0 });
    return lanes.get(n);
  };

  let maxVideo = 1;
  let maxAudio = 0;
  const placed = [];

  cuts.forEach((cut, i) => {
    const where = `edit[${i}]`;
    const clip = media[cut.clip];
    if (!clip) throw new Error(`${where}: el clip "${cut.clip}" no está en media[]`);

    const extra = byIndex.get(i + 1) || {};

    // Un archivo sin vídeo (o un corte con "video": false) no ocupa pista de vídeo:
    // va directo a una pista de audio.
    const audioOnly = clip.hasVideo === false || cut.video === false;
    const laneNo = cut.audioTrack ? Math.round(cut.audioTrack) : 1;
    if (laneNo < 1) throw new Error(`${where}.audioTrack debe ser 1 o más`);

    const trackNo = cut.track ? Math.round(cut.track) : 1;
    if (!audioOnly && trackNo > maxVideo) maxVideo = trackNo;
    const track = audioOnly ? ensureLane(laneNo) : ensure(trackNo);

    const speed = cut.speed !== undefined ? Number(cut.speed) : (extra.speed !== undefined ? Number(extra.speed) : 1);
    if (!(speed > 0)) throw new Error(`${where}.speed debe ser mayor que 0`);

    // Duración disponible del origen, en frames del proyecto y ya con la velocidad.
    const sourceFrames = Math.max(1, Math.floor((clip.frames || 0) / speed) || 1);

    let inFrame = toFrames(cut.in, fps, `${where}.in`);
    let outFrame = toFrames(cut.out, fps, `${where}.out`);
    const duration = toFrames(cut.duration, fps, `${where}.duration`);

    if (inFrame === null) inFrame = 0;
    if (outFrame === null) {
      outFrame = duration !== null ? inFrame + duration - 1 : sourceFrames - 1;
    }
    if (outFrame < inFrame) {
      throw new Error(`${where}: out (${outFrame}) va antes que in (${inFrame})`);
    }
    if (clip.frames && outFrame > sourceFrames - 1) {
      throw new Error(
        `${where}: out ${framesToTc(outFrame, fps)} pasa del final del clip ` +
        `"${cut.clip}" (${framesToTc(sourceFrames - 1, fps)}${speed !== 1 ? ` a velocidad ${speed}x` : ''})`,
      );
    }

    const length = outFrame - inFrame + 1;
    const dissolve = toFrames(cut.dissolve, fps, `${where}.dissolve`);
    let prevEndForMix = null;

    let start;
    let sub = 0;
    if (cut.at !== undefined) {
      start = toFrames(cut.at, fps, `${where}.at`);
      if (start < track.cursor && track.items.length > 0) {
        throw new Error(
          `${where}.at ${framesToTc(start, fps)} se solapa con el corte anterior de ` +
          `${audioOnly ? `A${laneNo}` : `V${trackNo}`} ` +
          '(usa "dissolve" para un fundido encadenado, o mueve el corte)',
        );
      }
    } else {
      start = track.cursor;
    }

    if (dissolve) {
      const prev = track.items[track.items.length - 1];
      if (!prev) {
        throw new Error(`${where}.dissolve: no hay un corte anterior en ` +
          `${audioOnly ? `A${laneNo}` : `V${trackNo}`} con el que fundir`);
      }
      if (dissolve >= prev.length || dissolve >= length) {
        throw new Error(
          `${where}.dissolve de ${dissolve} frame(s) no cabe: los clips duran ` +
          `${prev.length} y ${length} frame(s), y el solape tiene que ser menor que ambos`,
        );
      }
      start = prev.end + 1 - dissolve;
      sub = prev.sub === 0 ? 1 : 0;
      prevEndForMix = prev.end;
      track.mixes.push({
        in: start,
        out: prev.end,
        mixcut: Math.floor(dissolve / 2),
      });
    } else {
      // Sin mezcla va a la sub-lista 0, como hace Kdenlive. La 1 se reserva para el
      // clip que se solapa con el anterior, que es lo que permite el encadenado.
      sub = 0;
    }

    const item = {
      cutIndex: i,
      clipId: cut.clip,
      start,
      end: start + length - 1,
      length,
      sourceIn: inFrame,
      sourceOut: outFrame,
      sub,
      speed,
      fadeIn: toFrames(cut.fadeIn, fps, `${where}.fadeIn`),
      fadeOut: toFrames(cut.fadeOut, fps, `${where}.fadeOut`),
      transform: {
        zoom: cut.zoom !== undefined ? cut.zoom : extra.zoom,
        pan: cut.pan !== undefined ? cut.pan : extra.pan,
        tilt: cut.tilt !== undefined ? cut.tilt : extra.tilt,
        opacity: cut.opacity !== undefined ? cut.opacity : extra.opacity,
      },
      audio: cut.audio !== false && clip.hasAudio,
      audioOnly,
      laneNo,
      gain: cut.gain !== undefined ? Number(cut.gain) : null,
      color: {
        rgb: cut.rgb,
        contrast: cut.contrast,
        saturation: cut.saturation,
        gamma: cut.gamma,
      },
      dissolve: dissolve || 0,
    };

    for (const key of ['fadeIn', 'fadeOut']) {
      if (item[key] !== null && item[key] >= length) {
        throw new Error(
          `${where}.${key} de ${item[key]} frame(s) no cabe en un corte de ${length} frame(s)`,
        );
      }
    }

    track.items.push(item);
    track.cursor = item.end + 1;

    if (item.audio) {
      maxAudio = Math.max(maxAudio, laneNo);
      if (!audioOnly) {
        // El audio de un clip de vídeo se duplica en su pista de audio, en la misma
        // posición y la misma sub-lista, para que el encadenado valga también ahí.
        const lane = ensureLane(laneNo);
        lane.items.push(item);
        lane.cursor = Math.max(lane.cursor, item.end + 1);
        if (dissolve) {
          lane.mixes.push({ in: start, out: prevEndForMix, mixcut: Math.floor(dissolve / 2) });
        }
      }
    }
    placed.push(item);
  });

  return { tracks, lanes, maxVideo, maxAudio: Math.max(maxAudio, 0), placed };
}

// ----------------------------------------------------------------------- emisión

function emitFades(xml, item, indent) {
  const { sourceIn, sourceOut, fadeIn, fadeOut } = item;

  if (fadeIn) {
    xml.open('filter', { id: `fadein${item.cutIndex}`, in: sourceIn, out: sourceIn + fadeIn - 1 }, indent);
    xml.prop('start', 1, indent + 1);
    xml.prop('level', '0=0;-1=1', indent + 1);
    xml.prop('mlt_service', 'brightness', indent + 1);
    xml.prop('kdenlive_id', 'fade_from_black', indent + 1);
    xml.prop('alpha', 1, indent + 1);
    xml.close('filter', indent);

    if (item.audio) {
      // El filtro volume anima "level" en dB; gain/end están obsoletos y se ignoran
      // en cuanto level está presente. -60 dB es silencio a efectos prácticos.
      xml.open('filter', { id: `afadein${item.cutIndex}`, in: sourceIn, out: sourceIn + fadeIn - 1 }, indent);
      xml.prop('level', '0=-60;-1=0', indent + 1);
      xml.prop('mlt_service', 'volume', indent + 1);
      xml.prop('kdenlive_id', 'fadein', indent + 1);
      xml.close('filter', indent);
    }
  }

  if (fadeOut) {
    xml.open('filter', { id: `fadeout${item.cutIndex}`, in: sourceOut - fadeOut + 1, out: sourceOut }, indent);
    xml.prop('start', 1, indent + 1);
    xml.prop('level', '0=1;-1=0', indent + 1);
    xml.prop('mlt_service', 'brightness', indent + 1);
    xml.prop('kdenlive_id', 'fade_to_black', indent + 1);
    xml.prop('alpha', 1, indent + 1);
    xml.close('filter', indent);

    if (item.audio) {
      xml.open('filter', { id: `afadeout${item.cutIndex}`, in: sourceOut - fadeOut + 1, out: sourceOut }, indent);
      xml.prop('level', '0=0;-1=-60', indent + 1);
      xml.prop('mlt_service', 'volume', indent + 1);
      xml.prop('kdenlive_id', 'fadeout', indent + 1);
      xml.close('filter', indent);
    }
  }
}

/*
 * Ganancia de audio, en dB. Es el mismo filtro que usan los fundidos, pero con un
 * valor fijo: sirve para igualar dos micrófonos grabados a distinto nivel.
 */
function emitGain(xml, item, indent) {
  if (item.gain === null || item.gain === undefined || item.gain === 0) return;
  xml.open('filter', { id: `gain${item.cutIndex}` }, indent);
  xml.prop('level', item.gain, indent + 1);
  xml.prop('mlt_service', 'volume', indent + 1);
  xml.prop('kdenlive_id', 'volume', indent + 1);
  xml.close('filter', indent);
}

/*
 * Corrección de color.
 *
 * Las ganancias por canal van con lift_gamma_gain, que es el "Lift/gamma/gain" de
 * Kdenlive: emparejar dos cámaras es, casi siempre, multiplicar cada canal por una
 * constante. El contraste y la saturación van aparte con avfilter.eq, porque
 * lift_gamma_gain no los toca.
 */
function emitColor(xml, item, indent) {
  const c = item.color || {};
  const rgb = c.rgb;

  if (rgb && (rgb.r !== undefined || rgb.g !== undefined || rgb.b !== undefined)) {
    xml.open('filter', { id: `color${item.cutIndex}` }, indent);
    xml.prop('gain_r', rgb.r !== undefined ? rgb.r : 1, indent + 1);
    xml.prop('gain_g', rgb.g !== undefined ? rgb.g : 1, indent + 1);
    xml.prop('gain_b', rgb.b !== undefined ? rgb.b : 1, indent + 1);
    if (c.gamma !== undefined) {
      xml.prop('gamma_r', c.gamma, indent + 1);
      xml.prop('gamma_g', c.gamma, indent + 1);
      xml.prop('gamma_b', c.gamma, indent + 1);
    }
    xml.prop('mlt_service', 'lift_gamma_gain', indent + 1);
    xml.prop('kdenlive_id', 'lift_gamma_gain', indent + 1);
    xml.close('filter', indent);
  }

  if (c.contrast !== undefined || c.saturation !== undefined) {
    xml.open('filter', { id: `eq${item.cutIndex}` }, indent);
    if (c.contrast !== undefined) xml.prop('av.contrast', c.contrast, indent + 1);
    if (c.saturation !== undefined) xml.prop('av.saturation', c.saturation, indent + 1);
    xml.prop('mlt_service', 'avfilter.eq', indent + 1);
    xml.prop('kdenlive_id', 'avfilter.eq', indent + 1);
    xml.close('filter', indent);
  }
}

/*
 * Reencuadre y opacidad. qtblend coloca el fotograma en un rectángulo, que es lo que
 * usa Kdenlive para "Posición y zoom": con zoom 1.9 en un proyecto vertical se recorta
 * un 16:9 a 9:16 sin deformarlo.
 */
function emitTransform(xml, item, size, indent) {
  const t = item.transform;
  const hasGeometry = t.zoom !== undefined || t.pan !== undefined || t.tilt !== undefined;
  const hasOpacity = t.opacity !== undefined;
  if (!hasGeometry && !hasOpacity) return;

  const zoom = t.zoom !== undefined ? Number(t.zoom) : 1;
  const w = Math.round(size.width * zoom);
  const h = Math.round(size.height * zoom);
  const x = Math.round((size.width - w) / 2 + Number(t.pan || 0));
  const y = Math.round((size.height - h) / 2 - Number(t.tilt || 0));
  const opacity = hasOpacity ? Math.max(0, Math.min(100, Number(t.opacity))) / 100 : 1;

  xml.open('filter', { id: `transform${item.cutIndex}` }, indent);
  xml.prop('rect', `0=${x} ${y} ${w} ${h} ${opacity}`, indent + 1);
  xml.prop('compositing', 0, indent + 1);
  xml.prop('distort', 0, indent + 1);
  xml.prop('rotate_center', 1, indent + 1);
  xml.prop('mlt_service', 'qtblend', indent + 1);
  xml.prop('kdenlive_id', 'qtblend', indent + 1);
  xml.close('filter', indent);
}

function emitEntry(xml, item, producerId, kdenliveId, size, isAudio, indent) {
  xml.open('entry', { producer: producerId, in: item.sourceIn, out: item.sourceOut }, indent);
  xml.prop('kdenlive:id', kdenliveId, indent + 1);
  if (isAudio) {
    if (item.fadeIn || item.fadeOut) {
      emitFades(xml, { ...item, audio: true, transform: {} }, indent + 1);
    }
    emitGain(xml, item, indent + 1);
  } else {
    emitFades(xml, { ...item, audio: false }, indent + 1);
    emitTransform(xml, item, size, indent + 1);
    emitColor(xml, item, indent + 1);
    // Un clip de solo audio no pasa por aquí; si el vídeo lleva su propio sonido en
    // la misma pista, la ganancia va también en la entrada de vídeo.
    if (item.audioOnly) emitGain(xml, item, indent + 1);
  }
  xml.close('entry', indent);
}

function emitPlaylist(xml, id, items, opts, indent) {
  const attrs = { id };
  const hasBody = items.length > 0 || opts.isAudio;
  if (!hasBody) {
    xml.empty('playlist', attrs, indent);
    return;
  }
  xml.open('playlist', attrs, indent);
  if (opts.isAudio) xml.prop('kdenlive:audio_track', 1, indent + 1);

  let cursor = 0;
  for (const item of items) {
    if (item.start > cursor) {
      xml.empty('blank', { length: item.start - cursor }, indent + 1);
    }
    emitEntry(xml, item, opts.producerFor(item), opts.kdenliveIdFor(item), opts.size,
      opts.isAudio, indent + 1);
    cursor = item.end + 1;
  }
  xml.close('playlist', indent);
}

/*
 * Devuelve el XML del proyecto y un resumen de lo que contiene.
 *
 * media: { id: { path, frames, hasAudio, hasVideo, width, height, fps } }, tal como
 * lo devuelve media.js tras consultar el archivo con ffprobe.
 */
function buildProject(recipe, options) {
  const opts = options || {};
  const media = opts.media || {};
  const project = recipe.project || {};

  const gen = GENERATIONS[opts.docVersion] || GENERATIONS[DOC_VERSION];

  const fps = Number(project.fps) || opts.fps || 25;
  const size = {
    width: Math.round(Number(project.width) || opts.width || 1920),
    height: Math.round(Number(project.height) || opts.height || 1080),
  };
  const compositing = opts.compositing || COMPOSITING[0];

  const { tracks, lanes, maxVideo, maxAudio, placed } = layout(recipe, media, fps);

  const videoTracks = Math.max(maxVideo, Number((recipe.tracks || {}).video) || 2);
  const audioTracks = Math.max(maxAudio, Number((recipe.tracks || {}).audio) || 2);

  // kdenlive:id 1 es la secuencia; los clips van del 2 en adelante.
  const usedIds = Object.keys(media).filter((id) => placed.some((p) => p.clipId === id));
  const clipIds = new Map();
  usedIds.forEach((id, i) => clipIds.set(id, i + 2));

  // Un producer por clip, más uno extra por cada velocidad distinta usada.
  const producers = new Map(); // clave -> { id, clipId, speed }
  const producerKey = (clipId, speed) => (speed === 1 ? clipId : `${clipId}@${speed}`);
  for (const item of placed) {
    const key = producerKey(item.clipId, item.speed);
    if (!producers.has(key)) {
      producers.set(key, {
        id: item.speed === 1 ? `chain${producers.size}` : `producer_tw${producers.size}`,
        clipId: item.clipId,
        speed: item.speed,
      });
    }
  }

  const totalFrames = placed.reduce((max, item) => Math.max(max, item.end + 1), 0);
  const lastFrame = Math.max(0, totalFrames - 1);
  const uuid = opts.uuid || '{00000000-0000-0000-0000-000000000001}';

  const xml = new Xml();
  xml.lines.push("<?xml version='1.0' encoding='utf-8'?>");
  xml.open('mlt', {
    LC_NUMERIC: 'C',
    producer: 'main_bin',
    version: MLT_VERSION,
    root: opts.root || undefined,
    'xmlns:kdenlive': 'http://www.kdenlive.org/project',
  }, 0);

  const [rateNum, rateDen] = fpsFraction(fps);
  const [aspectNum, aspectDen] = displayAspect(size.width, size.height);
  xml.empty('profile', {
    description: `${size.width}x${size.height} ${fps} fps`,
    width: size.width,
    height: size.height,
    progressive: 1,
    sample_aspect_num: 1,
    sample_aspect_den: 1,
    display_aspect_num: aspectNum,
    display_aspect_den: aspectDen,
    frame_rate_num: rateNum,
    frame_rate_den: rateDen,
    colorspace: 709,
  }, 1);

  // --- fondo negro (pista 0 del montaje)
  xml.open('producer', { id: 'black_track', in: 0, out: Math.max(lastFrame, 1) }, 1);
  xml.prop('length', 2147483647, 2);
  xml.prop('eof', 'continue', 2);
  xml.prop('resource', 'black', 2);
  xml.prop('aspect_ratio', 1, 2);
  xml.prop('mlt_service', 'color', 2);
  xml.prop('mlt_image_format', 'rgba', 2);
  xml.prop('set.test_audio', 0, 2);
  xml.prop('kdenlive:playlistid', 'black_track', 2);
  xml.close('producer', 1);

  // --- clips de origen
  for (const p of producers.values()) {
    const clip = media[p.clipId];
    const kid = clipIds.get(p.clipId);
    const frames = Math.max(1, Math.floor((clip.frames || 1) / p.speed));
    // timewarp siempre es <producer>; los clips normales, lo que use la generación.
    const tag = p.speed === 1 ? gen.clipTag : 'producer';

    xml.open(tag, { id: p.id, in: 0, out: frames - 1 }, 1);
    xml.prop('length', frames, 2);
    xml.prop('eof', 'pause', 2);
    if (p.speed === 1) {
      xml.prop('resource', clip.path, 2);
      xml.prop('mlt_service', 'avformat-novalidate', 2);
    } else {
      xml.prop('resource', `${p.speed}:${clip.path}`, 2);
      xml.prop('mlt_service', 'timewarp', 2);
      xml.prop('warp_speed', p.speed, 2);
      xml.prop('warp_pitch', 0, 2);
    }
    xml.prop('seekable', 1, 2);
    if (clip.hasVideo) xml.prop('video_index', clip.videoIndex !== undefined ? clip.videoIndex : 0, 2);
    xml.prop('audio_index', clip.hasAudio ? (clip.audioIndex !== undefined ? clip.audioIndex : 1) : -1, 2);
    xml.prop('kdenlive:clipname', clip.name || '', 2);
    xml.prop('kdenlive:clip_type', 0, 2);
    xml.prop('kdenlive:folderid', recipe.bin ? 2 : -1, 2);
    xml.prop('kdenlive:id', kid, 2);
    xml.prop('kdenlive:duration', framesToTc(frames, fps), 2);
    xml.close(tag, 1);
  }

  // --- la bandeja
  xml.open('playlist', { id: 'main_bin' }, 1);
  xml.prop('kdenlive:docproperties.version', gen.docVersion, 2);
  xml.prop('kdenlive:docproperties.kdenliveversion', gen.kdenliveVersion, 2);
  xml.prop('kdenlive:docproperties.profile', `${size.width}x${size.height}`, 2);
  xml.prop('kdenlive:docproperties.audioChannels', 2, 2);
  xml.prop('kdenlive:docproperties.documentid', String(opts.documentId || 1000000000000), 2);
  xml.prop('kdenlive:docproperties.enableproxy', 0, 2);
  xml.prop('kdenlive:docproperties.generateproxy', 0, 2);
  xml.prop('kdenlive:docproperties.compositing', 1, 2);
  if (gen.sequences) {
    // Estas tres atan el documento con su secuencia. Si faltan, Kdenlive abre el
    // proyecto pero puede no mostrar la timeline.
    xml.prop('kdenlive:docproperties.uuid', uuid, 2);
    xml.prop('kdenlive:docproperties.opensequences', uuid, 2);
    xml.prop('kdenlive:docproperties.activetimeline', uuid, 2);
  } else {
    // Antes de las secuencias, el estado de la timeline vivía en el documento.
    xml.prop('kdenlive:docproperties.activeTrack', audioTracks, 2);
    xml.prop('kdenlive:docproperties.position', 0, 2);
    xml.prop('kdenlive:docproperties.zonein', 0, 2);
    xml.prop('kdenlive:docproperties.zoneout', Math.max(lastFrame, 1), 2);
  }
  if (!gen.sequences && (recipe.guides || recipe.markers)) {
    xml.prop('kdenlive:docproperties.guides', guidesJson(recipe, fps), 2);
  }
  if (recipe.bin) xml.prop(`kdenlive:folder.-1.2`, recipe.bin, 2);
  xml.prop('kdenlive:documentnotes', recipe.notes || '', 2);
  xml.prop('xml_retain', 1, 2);
  if (gen.sequences) xml.empty('entry', { producer: uuid, in: 0, out: lastFrame }, 2);
  for (const p of producers.values()) {
    const frames = Math.max(1, Math.floor((media[p.clipId].frames || 1) / p.speed));
    xml.empty('entry', { producer: p.id, in: 0, out: frames - 1 }, 2);
  }
  xml.close('playlist', 1);

  // --- pistas: cada una son dos sub-listas y un tractor
  // Orden en MLT: fondo, pistas de audio (de la última a la primera) y luego vídeo.
  let playlistCount = 0;
  let tractorCount = 0;
  const trackOrder = [];

  for (let n = audioTracks; n >= 1; n -= 1) {
    const lane = lanes.get(n) || { items: [], mixes: [] };
    const items = lane.items;
    const bySub = [items.filter((i) => i.sub === 0), items.filter((i) => i.sub === 1)];
    const ids = [`playlist${playlistCount++}`, `playlist${playlistCount++}`];
    const producerFor = (item) => producers.get(producerKey(item.clipId, item.speed)).id;
    const kdenliveIdFor = (item) => clipIds.get(item.clipId);

    for (let s = 0; s < 2; s += 1) {
      emitPlaylist(xml, ids[s], bySub[s], { isAudio: true, size, producerFor, kdenliveIdFor }, 1);
    }

    const tractorId = `tractor${tractorCount++}`;
    xml.open('tractor', { id: tractorId, in: 0, out: lastFrame }, 1);
    xml.prop('kdenlive:audio_track', 1, 2);
    xml.prop('kdenlive:trackheight', 67, 2);
    xml.prop('kdenlive:timeline_active', 1, 2);
    xml.prop('kdenlive:collapsed', 0, 2);
    xml.prop('kdenlive:track_name', `A${n}`, 2);
    xml.prop('kdenlive:thumbs_format', '', 2);
    xml.prop('kdenlive:audio_rec', '', 2);
    xml.empty('track', { hide: 'video', producer: ids[0] }, 2);
    xml.empty('track', { hide: 'video', producer: ids[1] }, 2);
    // Las mezclas de audio de la pista (el otro lado del fundido encadenado).
    {
      lane.mixes.forEach((mix, i) => {
        xml.open('transition', { id: `amix${tractorId}_${i}`, in: mix.in, out: mix.out }, 2);
        xml.prop('a_track', 0, 3);
        xml.prop('b_track', 1, 3);
        xml.prop('mlt_service', 'mix', 3);
        xml.prop('kdenlive_id', 'mix', 3);
        xml.prop('kdenlive:mixcut', mix.mixcut, 3);
        xml.prop('start', 0, 3);
        xml.prop('end', 1, 3);
        xml.prop('accepts_blanks', 1, 3);
        xml.close('transition', 2);
      });
    }
    xml.close('tractor', 1);
    trackOrder.push({ id: tractorId, kind: 'audio' });
  }

  for (let n = 1; n <= videoTracks; n += 1) {
    const track = tracks.get(n) || { items: [], mixes: [] };
    const bySub = [track.items.filter((i) => i.sub === 0), track.items.filter((i) => i.sub === 1)];
    const ids = [`playlist${playlistCount++}`, `playlist${playlistCount++}`];
    const producerFor = (item) => producers.get(producerKey(item.clipId, item.speed)).id;
    const kdenliveIdFor = (item) => clipIds.get(item.clipId);

    for (let s = 0; s < 2; s += 1) {
      emitPlaylist(xml, ids[s], bySub[s], { isAudio: false, size, producerFor, kdenliveIdFor }, 1);
    }

    const tractorId = `tractor${tractorCount++}`;
    xml.open('tractor', { id: tractorId, in: 0, out: lastFrame }, 1);
    xml.prop('kdenlive:trackheight', 67, 2);
    xml.prop('kdenlive:timeline_active', 1, 2);
    xml.prop('kdenlive:collapsed', 0, 2);
    xml.prop('kdenlive:track_name', `V${n}`, 2);
    xml.prop('kdenlive:thumbs_format', '', 2);
    xml.prop('kdenlive:audio_rec', '', 2);
    xml.empty('track', { hide: 'audio', producer: ids[0] }, 2);
    xml.empty('track', { hide: 'audio', producer: ids[1] }, 2);
    track.mixes.forEach((mix, i) => {
      xml.open('transition', { id: `mix${tractorId}_${i}`, in: mix.in, out: mix.out }, 2);
      xml.prop('a_track', 0, 3);
      xml.prop('b_track', 1, 3);
      xml.prop('factory', 'loader', 3);
      xml.prop('resource', '', 3);
      xml.prop('mlt_service', 'luma', 3);
      xml.prop('kdenlive_id', 'luma', 3);
      xml.prop('kdenlive:mixcut', mix.mixcut, 3);
      xml.prop('softness', 0, 3);
      xml.prop('alpha_over', 1, 3);
      xml.prop('invert', 0, 3);
      xml.prop('reverse', 0, 3);
      xml.close('transition', 2);
    });
    xml.close('tractor', 1);
    trackOrder.push({ id: tractorId, kind: 'video' });
  }

  // --- el montaje: las pistas y las mezclas internas de Kdenlive.
  // En 1.1 es un tractor de secuencia identificado por uuid, que luego envuelve el
  // projectTractor. En 1.04 no hay secuencias: este mismo tractor es el último del
  // archivo y eso es lo que lo identifica como el montaje.
  const seqId = `tractor${tractorCount++}`;
  xml.open('tractor', { id: gen.sequences ? uuid : seqId, in: 0, out: lastFrame }, 1);
  if (gen.sequences) {
    xml.prop('kdenlive:uuid', uuid, 2);
    xml.prop('kdenlive:clipname', (recipe.timeline && recipe.timeline.name) || 'Secuencia 1', 2);
    xml.prop('kdenlive:sequenceproperties.hasAudio', audioTracks > 0 ? 1 : 0, 2);
    xml.prop('kdenlive:sequenceproperties.hasVideo', videoTracks > 0 ? 1 : 0, 2);
    xml.prop('kdenlive:sequenceproperties.activeTrack', audioTracks, 2);
    xml.prop('kdenlive:sequenceproperties.tracksCount', audioTracks + videoTracks, 2);
    xml.prop('kdenlive:sequenceproperties.documentuuid', uuid, 2);
    xml.prop('kdenlive:sequenceproperties.position', 0, 2);
    xml.prop('kdenlive:sequenceproperties.zonein', 0, 2);
    xml.prop('kdenlive:sequenceproperties.zoneout', Math.max(lastFrame, 1), 2);
    xml.prop('kdenlive:sequenceproperties.scrollPos', 0, 2);
    xml.prop('kdenlive:sequenceproperties.verticalzoom', 1, 2);
    xml.prop('kdenlive:sequenceproperties.zoom', 8, 2);
    xml.prop('kdenlive:sequenceproperties.disablepreview', 0, 2);
    xml.prop('kdenlive:sequenceproperties.thumbnailFrame', -1, 2);
    if (recipe.guides || recipe.markers) {
      xml.prop('kdenlive:sequenceproperties.guides', guidesJson(recipe, fps), 2);
    }
    xml.prop('kdenlive:duration', framesToTc(totalFrames, fps), 2);
    xml.prop('kdenlive:maxduration', totalFrames, 2);
    xml.prop('kdenlive:producer_type', 17, 2);
    xml.prop('kdenlive:clip_type', 0, 2);
    xml.prop('kdenlive:id', 1, 2);
    xml.prop('kdenlive:folderid', -1, 2);
  }

  xml.empty('track', { producer: 'black_track' }, 2);
  trackOrder.forEach((t) => xml.empty('track', { producer: t.id }, 2));

  trackOrder.forEach((t, i) => {
    const index = i + 1;
    if (t.kind === 'audio') {
      xml.open('transition', { id: `transition${index}` }, 2);
      xml.prop('a_track', 0, 3);
      xml.prop('b_track', index, 3);
      xml.prop('mlt_service', 'mix', 3);
      xml.prop('kdenlive_id', 'mix', 3);
      xml.prop('internal_added', 237, 3);
      xml.prop('always_active', 1, 3);
      xml.prop('accepts_blanks', 1, 3);
      xml.prop('sum', 1, 3);
      xml.close('transition', 2);
    } else {
      xml.open('transition', { id: `transition${index}` }, 2);
      xml.prop('a_track', 0, 3);
      xml.prop('b_track', index, 3);
      xml.prop('compositing', 0, 3);
      xml.prop('distort', 0, 3);
      xml.prop('rotate_center', 0, 3);
      xml.prop('mlt_service', compositing, 3);
      xml.prop('kdenlive_id', compositing, 3);
      xml.prop('always_active', 1, 3);
      xml.prop('internal_added', 237, 3);
      xml.close('transition', 2);
    }
  });
  xml.close('tractor', 1);

  // --- envoltorio final (solo en 1.1: envuelve la secuencia)
  if (gen.sequences) {
    xml.open('tractor', { id: seqId, in: 0, out: lastFrame }, 1);
    xml.prop('kdenlive:projectTractor', 1, 2);
    xml.empty('track', { producer: uuid, in: 0, out: lastFrame }, 2);
    xml.close('tractor', 1);
  }

  xml.close('mlt', 0);

  return {
    xml: xml.toString(),
    summary: {
      fps,
      width: size.width,
      height: size.height,
      videoTracks,
      audioTracks,
      cuts: placed.length,
      frames: totalFrames,
      duration: framesToTc(totalFrames, fps),
      mixes: [...tracks.values()].reduce((n, t) => n + t.mixes.length, 0),
      fades: placed.filter((i) => i.fadeIn || i.fadeOut).length,
      compositing,
      clips: clipIds.size,
      docVersion: gen.docVersion,
      kdenliveMinimo: gen.minKdenlive.join('.'),
    },
  };
}

function guidesJson(recipe, fps) {
  const list = recipe.guides || recipe.markers || [];
  const colors = { Red: 1, Green: 2, Blue: 3, Yellow: 4, Cyan: 5, Purple: 6, White: 7, Orange: 8 };
  return JSON.stringify(list.map((g, i) => ({
    comment: String(g.name || g.comment || `Marca ${i + 1}`),
    pos: toFrames(g.at, fps, `guides[${i}].at`) || 0,
    type: colors[g.color] !== undefined ? colors[g.color] : 0,
  })));
}

module.exports = {
  GENERATIONS,
  generationFor,
  DOC_VERSION,
  KDENLIVE_VERSION,
  COMPOSITING,
  escapeXml,
  toFrames,
  framesToTc,
  fpsFraction,
  displayAspect,
  layout,
  buildProject,
  guidesJson,
};
