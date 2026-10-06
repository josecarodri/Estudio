/*
 * Validación de recetas.
 *
 * Una receta es el montaje escrito en JSON: los clips, los cortes con su entrada y salida,
 * fundidos, encadenados, velocidad, reencuadre, pistas y guías. Se revisa entera antes de
 * escribir el proyecto y se devuelven todos los problemas a la vez: es más útil ver los cinco
 * fallos de una receta que ir arreglándolos de uno en uno. Lógica pura, sin tocar disco.
 *
 * Los errores impiden generar el proyecto. Los avisos no: una clave desconocida se ignora.
 */
'use strict';

const TOP_LEVEL_KEYS = [
  'version', 'project', 'bin', 'media', 'timeline', 'tracks', 'edit', 'transform',
  'guides', 'markers', 'notes', 'origenReferencia',
];

const KEYS = {
  project: ['name', 'fps', 'width', 'height'],
  timeline: ['name'],
  media: ['id', 'path'],
  tracks: ['video', 'audio'],
  edit: ['clip', 'in', 'out', 'duration', 'track', 'at', 'audio', 'video', 'audioTrack',
    'fadeIn', 'fadeOut', 'dissolve', 'speed', 'zoom', 'pan', 'tilt', 'opacity',
    'gain', 'rgb', 'contrast', 'saturation', 'gamma'],
  // transform[] reencuadra un corte por su número (1 = el primero de edit): es lo mismo
  // que poner esas claves en el propio corte, y lo del corte manda.
  transform: ['index', 'zoom', 'pan', 'tilt', 'opacity', 'speed'],
  // markers es otro nombre para guides.
  guides: ['at', 'name', 'comment', 'color'],
};

// Colores de guía que entiende Kdenlive (project.js los pasa a su categoría).
const GUIDE_COLORS = ['Red', 'Green', 'Blue', 'Yellow', 'Cyan', 'Purple', 'White', 'Orange'];

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/*
 * Formas aceptadas en los campos de tiempo: frames (12 o "12"), "HH:MM:SS:FF",
 * "HH:MM:SS", "MM:SS" y segundos ("2s", "2.5s"). El ';' del drop frame también vale.
 */
function isTimecode(v) {
  if (isFiniteNumber(v)) return Number.isInteger(v) && v >= 0;
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s === '') return false;
  if (/^\d+$/.test(s)) return true;
  if (/^\d+(\.\d+)?[sS]$/.test(s)) return true;
  return /^\d+([:;]\d+){1,3}$/.test(s);
}

function describe(v) {
  if (Array.isArray(v)) return 'lista';
  if (v === null) return 'null';
  return typeof v;
}

function validate(recipe) {
  const errors = [];
  const warnings = [];
  const err = (msg) => errors.push(msg);
  const warn = (msg) => warnings.push(msg);

  if (!isPlainObject(recipe)) {
    return { errors: [`la receta debe ser un objeto JSON, no ${describe(recipe)}`], warnings };
  }

  for (const key of Object.keys(recipe)) {
    if (key === 'titles') warn('titles: los títulos todavía no se hacen; se ignoran');
    else if (!TOP_LEVEL_KEYS.includes(key)) {
      warn(`clave desconocida "${key}" (se ignora). Válidas: ${TOP_LEVEL_KEYS.join(', ')}`);
    }
  }

  const checkKeys = (obj, group, where) => {
    for (const key of Object.keys(obj)) {
      if (!KEYS[group].includes(key)) warn(`${where}: clave desconocida "${key}" (se ignora)`);
    }
  };

  const checkTime = (value, where) => {
    if (value === undefined) return;
    if (!isTimecode(value)) {
      err(`${where}: tiempo inválido (${JSON.stringify(value)}). ` +
        'Usa frames (120), "HH:MM:SS:FF", "MM:SS" o segundos ("2.5s")');
    }
  };

  // ---- project
  if (recipe.project !== undefined) {
    if (!isPlainObject(recipe.project)) {
      err(`project debe ser un objeto, no ${describe(recipe.project)}`);
    } else {
      const p = recipe.project;
      checkKeys(p, 'project', 'project');
      if (p.name !== undefined && !isNonEmptyString(p.name)) err('project.name debe ser un texto');
      for (const k of ['fps', 'width', 'height']) {
        if (p[k] !== undefined && !(isFiniteNumber(p[k]) && p[k] > 0)) {
          err(`project.${k} debe ser un número mayor que 0`);
        }
      }
    }
  }

  if (recipe.bin !== undefined && !isNonEmptyString(recipe.bin)) {
    err('bin debe ser el nombre de la carpeta de la bandeja, como texto');
  }

  // ---- media
  const ids = new Set();
  if (recipe.media !== undefined) {
    if (!Array.isArray(recipe.media)) {
      err(`media debe ser una lista, no ${describe(recipe.media)}`);
    } else {
      recipe.media.forEach((entry, i) => {
        const where = `media[${i}]`;
        if (!isPlainObject(entry)) {
          err(`${where} debe ser un objeto con id y path`);
          return;
        }
        checkKeys(entry, 'media', where);
        if (!isNonEmptyString(entry.id)) {
          err(`${where}.id es obligatorio (es el nombre corto que usas en edit)`);
        } else if (ids.has(entry.id)) {
          err(`${where}.id duplicado: "${entry.id}"`);
        } else {
          ids.add(entry.id);
        }
        if (!isNonEmptyString(entry.path)) {
          err(`${where}.path es obligatorio (ruta completa del archivo)`);
        } else if (!/^([a-zA-Z]:[\\/]|[\\/]|\\\\)/.test(entry.path)) {
          warn(`${where}.path no parece una ruta absoluta: "${entry.path}". ` +
            'Se buscará desde la carpeta en la que se ejecute el comando: mejor la ruta completa');
        }
      });
    }
  }

  // ---- timeline
  if (recipe.timeline !== undefined) {
    if (!isPlainObject(recipe.timeline)) {
      err(`timeline debe ser un objeto, no ${describe(recipe.timeline)}`);
    } else {
      checkKeys(recipe.timeline, 'timeline', 'timeline');
      if (recipe.timeline.name !== undefined && !isNonEmptyString(recipe.timeline.name)) {
        err('timeline.name debe ser un texto');
      }
    }
  }

  // ---- tracks
  if (recipe.tracks !== undefined) {
    if (!isPlainObject(recipe.tracks)) {
      err('tracks debe ser un objeto { video, audio }');
    } else {
      checkKeys(recipe.tracks, 'tracks', 'tracks');
      for (const k of ['video', 'audio']) {
        const v = recipe.tracks[k];
        if (v !== undefined && !(Number.isInteger(v) && v >= 1 && v <= 24)) {
          err(`tracks.${k} debe ser un entero entre 1 y 24`);
        }
      }
    }
  }

  // ---- edit
  let editLength = 0;
  if (recipe.edit === undefined) {
    warn('la receta no tiene edit: no hay nada que montar');
  } else if (!Array.isArray(recipe.edit)) {
    err(`edit debe ser una lista de cortes, no ${describe(recipe.edit)}`);
  } else {
    editLength = recipe.edit.length;
    recipe.edit.forEach((cut, i) => {
      const where = `edit[${i}]`;
      if (!isPlainObject(cut)) {
        err(`${where} debe ser un objeto con al menos "clip"`);
        return;
      }
      checkKeys(cut, 'edit', where);
      if (!isNonEmptyString(cut.clip)) {
        err(`${where}.clip es obligatorio y debe ser un id de media[]`);
      } else if (ids.size > 0 && !ids.has(cut.clip)) {
        err(`${where}.clip "${cut.clip}" no está en media[]. Disponibles: ${[...ids].join(', ') || 'ninguno'}`);
      }
      checkTime(cut.in, `${where}.in`);
      checkTime(cut.out, `${where}.out`);
      checkTime(cut.duration, `${where}.duration`);
      checkTime(cut.at, `${where}.at`);
      if (cut.out !== undefined && cut.duration !== undefined) {
        warn(`${where}: tiene out y duration a la vez; manda out`);
      }
      if (cut.track !== undefined && !(Number.isInteger(cut.track) && cut.track >= 1)) {
        err(`${where}.track debe ser un entero >= 1 (número de pista de vídeo)`);
      }
      if (typeof cut.in === 'number' && typeof cut.out === 'number' && cut.out < cut.in) {
        err(`${where}: out (${cut.out}) va antes que in (${cut.in})`);
      }

      for (const k of ['fadeIn', 'fadeOut', 'dissolve']) {
        if (cut[k] !== undefined && !isTimecode(cut[k])) {
          err(`${where}.${k}: usa frames (25) o segundos ("1s")`);
        }
      }
      if (cut.dissolve !== undefined && i === 0) {
        err(`${where}.dissolve: el primer corte no tiene nada antes con lo que fundir`);
      }
      if (cut.dissolve !== undefined && cut.at !== undefined) {
        warn(`${where}: dissolve manda sobre at; la posición la fija el solape`);
      }

      if (cut.speed !== undefined) {
        if (!isFiniteNumber(cut.speed) || cut.speed <= 0) {
          err(`${where}.speed debe ser un número mayor que 0 (2 = el doble de rápido)`);
        } else if (cut.speed > 20) {
          warn(`${where}.speed de ${cut.speed}x es muy alto; revisa que sea lo que quieres`);
        }
      }

      if (cut.audio !== undefined && typeof cut.audio !== 'boolean') {
        err(`${where}.audio debe ser true o false`);
      }
      if (cut.video !== undefined && typeof cut.video !== 'boolean') {
        err(`${where}.video debe ser true o false (false = solo el audio del clip)`);
      }
      if (cut.audioTrack !== undefined && !(Number.isInteger(cut.audioTrack) && cut.audioTrack >= 1)) {
        err(`${where}.audioTrack debe ser un entero >= 1 (número de pista de audio)`);
      }

      if (cut.gain !== undefined) {
        if (!isFiniteNumber(cut.gain)) {
          err(`${where}.gain debe ser un número de decibelios (3.5 sube, -3.5 baja)`);
        } else if (Math.abs(cut.gain) > 40) {
          warn(`${where}.gain de ${cut.gain} dB es enorme; revisa que sea lo que quieres`);
        }
      }

      if (cut.rgb !== undefined) {
        if (!isPlainObject(cut.rgb)) {
          err(`${where}.rgb debe ser un objeto { r, g, b } con la ganancia de cada canal`);
        } else {
          for (const canal of ['r', 'g', 'b']) {
            const v = cut.rgb[canal];
            if (v !== undefined && !(isFiniteNumber(v) && v > 0)) {
              err(`${where}.rgb.${canal} debe ser un número mayor que 0 (1 = sin tocar)`);
            }
          }
          for (const clave of Object.keys(cut.rgb)) {
            if (!['r', 'g', 'b'].includes(clave)) warn(`${where}.rgb: clave desconocida "${clave}"`);
          }
        }
      }
      for (const clave of ['contrast', 'saturation', 'gamma']) {
        const v = cut[clave];
        if (v !== undefined && !(isFiniteNumber(v) && v >= 0)) {
          err(`${where}.${clave} debe ser un número >= 0 (1 = sin tocar)`);
        }
      }

      for (const k of ['zoom', 'pan', 'tilt', 'opacity']) {
        if (cut[k] !== undefined && !isFiniteNumber(cut[k])) err(`${where}.${k} debe ser un número`);
      }
      if (cut.opacity !== undefined && (cut.opacity < 0 || cut.opacity > 100)) {
        err(`${where}.opacity va de 0 a 100`);
      }
    });
  }

  // ---- transform
  if (recipe.transform !== undefined) {
    if (!Array.isArray(recipe.transform)) {
      err(`transform debe ser una lista, no ${describe(recipe.transform)}`);
    } else {
      recipe.transform.forEach((t, i) => {
        const where = `transform[${i}]`;
        if (!isPlainObject(t)) {
          err(`${where} debe ser un objeto`);
          return;
        }
        checkKeys(t, 'transform', where);
        if (!Number.isInteger(t.index) || t.index < 1) {
          err(`${where}.index debe ser un entero >= 1 (el número de corte en edit[], empezando en 1)`);
        } else if (editLength > 0 && t.index > editLength) {
          err(`${where}.index ${t.index} no existe: edit[] tiene ${editLength} corte(s)`);
        }
        for (const k of ['zoom', 'pan', 'tilt', 'opacity', 'speed']) {
          if (t[k] !== undefined && !isFiniteNumber(t[k])) err(`${where}.${k} debe ser un número`);
        }
        if (t.opacity !== undefined && (t.opacity < 0 || t.opacity > 100)) {
          err(`${where}.opacity va de 0 a 100`);
        }
        if (isFiniteNumber(t.speed) && t.speed <= 0) err(`${where}.speed debe ser mayor que 0`);
      });
    }
  }

  // ---- guías (guides; markers es otro nombre para lo mismo)
  for (const group of ['guides', 'markers']) {
    const list = recipe[group];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      err(`${group} debe ser una lista`);
      continue;
    }
    list.forEach((g, i) => {
      const where = `${group}[${i}]`;
      if (!isPlainObject(g)) {
        err(`${where} debe ser un objeto`);
        return;
      }
      checkKeys(g, 'guides', where);
      if (g.at === undefined) err(`${where}.at es obligatorio`);
      else checkTime(g.at, `${where}.at`);
      if (g.color !== undefined && !GUIDE_COLORS.includes(g.color)) {
        warn(`${where}.color "${g.color}" no es un color de guía de Kdenlive. Válidos: ${GUIDE_COLORS.join(', ')}`);
      }
    });
  }
  if (recipe.guides !== undefined && recipe.markers !== undefined) {
    warn('hay guides y markers a la vez: se usan las guides (markers es otro nombre para lo mismo)');
  }

  return { errors, warnings };
}

module.exports = { validate, isTimecode, TOP_LEVEL_KEYS, KEYS, GUIDE_COLORS };
