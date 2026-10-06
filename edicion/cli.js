#!/usr/bin/env node
/*
 * Editor del podcast: monta proyectos de Kdenlive desde una receta, y el episodio entero.
 *
 *   node cli.js doctor                   qué hay instalado en este equipo
 *   node cli.js validate receta.json     revisa la receta sin tocar nada
 *   node cli.js build receta.json        escribe el .kdenlive
 *   node cli.js render receta.json       lo renderiza a vídeo con melt
 *
 * No hay que abrir el programa: el .kdenlive se escribe entero desde fuera y se
 * renderiza con melt sin abrirlo.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const P = require('./project.js');
const R = require('./recipe.js');
const M = require('./media.js');
const SY = require('./sync.js');
const MC = require('./multicam.js');
const AN = require('./analisis.js');
const CAL = require('./calibrar.js');
const EP = require('./episodio.js');
const CUT = require('./cortes.js');
const TR = require('./transcribir.js');
const AU = require('./auto.js');
const LL = require('./llamadas.js');
const RV = require('./revision.js');
const AV = require('./avisos.js');
const YT = require('./youtube.js');
const CAM = require('./camaras.js');
const RO = require('./rotulos.js');
const SH = require('./shorts.js');
const LI = require('./limpieza.js');

function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function which(bin) {
  const res = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 15000 });
  if (res.error) {
    const res2 = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000 });
    if (res2.error) return null;
    return (res2.stdout || res2.stderr || '').split('\n')[0].trim();
  }
  return (res.stdout || res.stderr || '').split('\n')[0].trim();
}

/*
 * Versión de Kdenlive instalada, como [mayor, menor] (p. ej. [24, 12]), o null si no
 * se puede saber. Importa porque un documento 1.1 no lo abre un Kdenlive anterior a
 * 23.04: hay que escribir el formato antiguo para esos.
 *
 * Con Flatpak o Snap el binario no suele estar en el PATH; entonces devuelve null y
 * se usa el formato nuevo, avisando de que se puede forzar con --doc-version.
 */
function kdenliveVersion() {
  const binario = buscarBinario('kdenlive');
  if (!binario) return null;
  for (const flag of ['--version', '-v']) {
    const res = spawnSync(binario, [flag], { encoding: 'utf8', timeout: 20000 });
    if (res.error) continue;
    const texto = `${res.stdout || ''}${res.stderr || ''}`;
    const m = texto.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
    if (m) return [parseInt(m[1], 10), parseInt(m[2], 10)];
  }
  return null;
}

/* Qué formato escribir: lo que pida el usuario, o lo que acepte su Kdenlive. */
function elegirFormato(pedido) {
  if (pedido) {
    const clave = String(pedido);
    if (!P.GENERATIONS[clave]) {
      throw new Error(`--doc-version ${clave} no existe; usa ${Object.keys(P.GENERATIONS).join(' o ')}`);
    }
    return { docVersion: clave, motivo: 'indicado con --doc-version' };
  }
  const version = kdenliveVersion();
  if (!version) {
    return { docVersion: P.DOC_VERSION, motivo: 'no se detectó Kdenlive; se asume 23.04 o posterior' };
  }
  const docVersion = P.generationFor(version);
  return { docVersion, motivo: `Kdenlive ${version.join('.')} detectado`, version };
}

/*
 * Kdenlive trae dentro su propio melt (el renderizador de MLT), pero en Windows y
 * macOS no quedan en el PATH. Buscarlos donde se instalan evita dos cosas: decir
 * "no instalado" cuando sí está, y no poder renderizar teniendo todo lo necesario.
 */
function carpetasDeKdenlive(plataforma) {
  const so = plataforma || process.platform;
  if (so === 'win32') {
    const programas = process.env.ProgramFiles || 'C:\\Program Files';
    const programasX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return [
      path.join(programas, 'kdenlive', 'bin'),
      path.join(programasX86, 'kdenlive', 'bin'),
      path.join(local, 'Programs', 'kdenlive', 'bin'),
      path.join(programas, 'Kdenlive', 'bin'),
    ];
  }
  if (so === 'darwin') {
    return [
      '/Applications/kdenlive.app/Contents/MacOS',
      path.join(os.homedir(), 'Applications', 'kdenlive.app', 'Contents', 'MacOS'),
    ];
  }
  return ['/usr/lib/kdenlive/bin', '/opt/kdenlive/bin'];
}

/*
 * Ruta de un binario: primero el PATH, luego donde instala Kdenlive.
 * Devuelve la ruta a usar, o null.
 */
const cacheBinarios = new Map();
function buscarBinario(nombre) {
  if (cacheBinarios.has(nombre)) return cacheBinarios.get(nombre);

  let encontrado = which(nombre) ? nombre : null;
  if (!encontrado) {
    const sufijos = process.platform === 'win32' ? ['.exe', ''] : [''];
    for (const dir of carpetasDeKdenlive()) {
      for (const sufijo of sufijos) {
        const candidato = path.join(dir, nombre + sufijo);
        if (exists(candidato)) {
          encontrado = candidato;
          break;
        }
      }
      if (encontrado) break;
    }
  }

  cacheBinarios.set(nombre, encontrado);
  return encontrado;
}

/*
 * Tiempo de una opción de línea de comandos, en segundos.
 *
 * Aquí un número suelto son segundos, no frames: en la receta "120" significa 120
 * frames, pero quien escribe "--desde 6" en la terminal quiere decir el segundo 6.
 * Acepta además "1:30", "00:01:30" y "6.5s".
 */
function tiempoASegundos(valor, donde) {
  const texto = String(valor).trim();
  if (texto === '') throw new Error(`${donde}: falta el valor`);

  const conSufijo = texto.match(/^(\d+(?:\.\d+)?)\s*[sS]$/);
  if (conSufijo) return parseFloat(conSufijo[1]);
  if (/^\d+(\.\d+)?$/.test(texto)) return parseFloat(texto);

  const trozos = texto.split(/[:;]/);
  if (trozos.length >= 2 && trozos.length <= 3 && trozos.every((t) => /^\d+(\.\d+)?$/.test(t))) {
    const n = trozos.map(Number);
    if (n.length === 2) return n[0] * 60 + n[1];
    return n[0] * 3600 + n[1] * 60 + n[2];
  }

  throw new Error(`${donde}: no entiendo "${texto}". Usa segundos (6 o 6.5), "1:30" o "00:01:30".`);
}

/*
 * Ajustes de audio por persona.
 *
 * Acepta un número suelto ("-140", para todos) o pares ("jc=-140,dj=0"). Hace falta
 * porque el retardo no tiene por qué ser el mismo para los dos: unos auriculares
 * Bluetooth meten 100-200 ms en la entrada de audio, y un micrófono integrado no mete
 * casi nada. Corregir a los dos por igual arregla a uno y estropea al otro.
 *
 * Devuelve una función que, dado el nombre de la persona, da los milisegundos.
 */
const personaBase = MC.personaBase;

function ajustesPorPersona(valor, donde) {
  if (valor === undefined || valor === true) return () => 0;

  const texto = String(valor).trim();
  if (texto === '') return () => 0;

  if (!texto.includes('=')) {
    const n = Number(texto);
    if (!Number.isFinite(n)) {
      throw new Error(`${donde}: "${texto}" no es un número de milisegundos. ` +
        'Usa -140, o "jc=-140,dj=0" para ajustar a cada uno por separado.');
    }
    return () => n;
  }

  const porNombre = new Map();
  for (const trozo of texto.split(',')) {
    const [nombre, bruto] = trozo.split('=').map((t) => (t || '').trim());
    const n = Number(bruto);
    if (!nombre || !Number.isFinite(n)) {
      throw new Error(`${donde}: no entiendo "${trozo.trim()}". El formato es "jc=-140,dj=0".`);
    }
    porNombre.set(nombre.toLowerCase(), n);
  }
  return (persona) => {
    const v = porNombre.get(String(persona).toLowerCase());
    return v === undefined ? 0 : v;
  };
}

const EXTENSIONES_MEDIA = ['.mp4', '.webm', '.mkv', '.mov', '.wav', '.m4a', '.mp3', '.ogg'];

/*
 * Convierte argumentos en una lista de archivos: una carpeta se expande a lo que
 * contiene. Una sesión del Estudio son cinco archivos con nombres largos, y escribirlos
 * a mano cada vez es una fuente de erratas.
 */
function expandirArchivos(entradas) {
  const salida = [];
  for (const entrada of entradas) {
    const ruta = path.resolve(entrada);
    if (!exists(ruta)) throw new Error(`no existe ${ruta}`);

    if (isDir(ruta)) {
      const dentro = fs.readdirSync(ruta)
        .filter((f) => EXTENSIONES_MEDIA.includes(path.extname(f).toLowerCase()))
        .sort()
        .map((f) => path.join(ruta, f));
      if (!dentro.length) throw new Error(`no hay archivos de audio ni vídeo en ${ruta}`);
      salida.push(...dentro);

      // Si el Estudio ya dejó una versión alineada, conviene decirlo: es mejor material.
      const alineados = path.join(ruta, 'alineados');
      if (isDir(alineados) && path.basename(ruta) !== 'alineados') {
        console.log(`  nota: esta carpeta tiene "alineados" dentro. Para montar usa esa;`);
        console.log(`        para calibrar usa esta, porque ahí el pitido ya no está.`);
      }
    } else {
      salida.push(ruta);
    }
  }
  return salida;
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [key, inline] = arg.slice(2).split('=');
      if (inline !== undefined) out.flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
        out.flags[key] = argv[i + 1];
        i += 1;
      } else out.flags[key] = true;
    } else {
      out._.push(arg);
    }
  }
  return out;
}

function readJson(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`no se puede leer ${file}: ${e.message}`);
  }
  try {
    return JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(`${file} no es JSON válido: ${e.message}`);
  }
}

/*
 * Comprueba qué servicio de composición puede cargar el MLT de este equipo. Kdenlive
 * trae qtblend, pero un MLT pelado en Linux puede no poder cargarlo, y entonces el
 * render saldría sin composición entre pistas.
 */
function compositingThatLoads(preferred) {
  const candidates = preferred ? [preferred, ...P.COMPOSITING] : P.COMPOSITING;
  const melt = buscarBinario('melt');
  if (!melt) return { service: candidates[0], checked: false };

  for (const service of candidates) {
    const xml = `<?xml version='1.0' encoding='utf-8'?>
<mlt LC_NUMERIC="C" version="7.0.0">
 <profile width="320" height="180" frame_rate_num="25" frame_rate_den="1" progressive="1"
          sample_aspect_num="1" sample_aspect_den="1" display_aspect_num="16" display_aspect_den="9"/>
 <producer id="p0" in="0" out="1"><property name="length">2</property><property name="eof">pause</property><property name="mlt_service">color</property><property name="resource">black</property></producer>
 <producer id="p1" in="0" out="1"><property name="length">2</property><property name="eof">pause</property><property name="mlt_service">color</property><property name="resource">red</property></producer>
 <tractor id="t0" in="0" out="1">
  <track producer="p0"/>
  <track producer="p1"/>
  <transition id="x0"><property name="a_track">0</property><property name="b_track">1</property><property name="mlt_service">${service}</property></transition>
 </tractor>
</mlt>`;
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-')), 'probe.mlt');
    fs.writeFileSync(tmp, xml);
    // Un productor de color es infinito: sin terminate_on_pause y sin tiempo
    // máximo esta sonda no acabaría nunca.
    const [cmd, ...previos] = M.comandoMelt(melt);
    const res = spawnSync(cmd, [...previos, tmp, '-consumer', 'null', 'terminate_on_pause=1'],
      { encoding: 'utf8', timeout: 20000 });
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    if (res.error) return { service: candidates[0], checked: false };
    const failed = /failed to load transition/i.test((res.stderr || '') + (res.stdout || ''));
    if (!failed) return { service, checked: true };
  }
  return { service: candidates[0], checked: true, noneLoaded: true };
}

// ------------------------------------------------------------------- construir

function buildFromRecipe(recipe, args, label) {
  const result = R.validate(recipe);
  if (result.warnings.length || result.errors.length) {
    for (const w of result.warnings) console.log(`  aviso   ${w}`);
    for (const e of result.errors) console.log(`  ERROR   ${e}`);
    console.log('');
  }
  if (result.errors.length) {
    throw new Error('la receta tiene errores; no se genera nada.');
  }

  const fps = Number((recipe.project || {}).fps) || 25;

  if (!M.hasFfprobe()) {
    console.log('  aviso   no hay ffprobe: no se pueden comprobar duraciones ni audio.');
    console.log('          instala ffmpeg para que avise de un "out" fuera de rango.');
  }
  const { byId, problems } = M.hasFfprobe()
    ? M.probeRecipe(recipe, fps)
    : { byId: Object.fromEntries((recipe.media || []).map((m) => [m.id, { path: m.path, name: path.basename(m.path), hasVideo: true, hasAudio: true, frames: null }])), problems: [] };

  for (const p of problems) console.log(`  ERROR   ${p}`);
  if (problems.length) {
    throw new Error('faltan archivos de vídeo o no se pudieron leer.');
  }

  for (const [id, info] of Object.entries(byId)) {
    if (!info.frames) continue;
    const bits = [];
    if (info.hasVideo) {
      bits.push(`${info.width}x${info.height}`, `${(info.fps || fps).toFixed(2)} fps`);
    } else {
      bits.push('solo audio');
    }
    bits.push(P.framesToTc(info.frames, fps));
    if (info.hasVideo) bits.push(info.hasAudio ? 'con audio' : 'SIN audio');
    console.log(`  clip ${id}: ${bits.join(' · ')}`);
  }

  const compositing = args.flags.compositing
    ? String(args.flags.compositing)
    : (args.flags.render ? compositingThatLoads().service : P.COMPOSITING[0]);

  const formato = elegirFormato(args.flags['doc-version']);
  console.log(`  formato: documento ${formato.docVersion} (${formato.motivo})`);
  if (formato.docVersion === '1.04' && !args.flags['doc-version']) {
    console.log('           tu Kdenlive no abre el formato nuevo, así que se escribe el');
    console.log('           anterior. Lo abre igual y no pierdes nada del montaje.');
  }

  const built = P.buildProject(recipe, {
    media: byId,
    fps,
    compositing,
    docVersion: formato.docVersion,
    root: args.flags.root ? String(args.flags.root) : undefined,
  });

  return { built, media: byId, formato };
}

function defaultOut(recipeFile, ext) {
  const dir = path.dirname(path.resolve(recipeFile));
  const name = path.basename(recipeFile).replace(/\.json$/i, '');
  return path.join(dir, `${name}${ext}`);
}

function cmdBuild(args) {
  const file = args._[0];
  if (!file) {
    console.error('uso: node cli.js build <receta.json> [--out proyecto.kdenlive]');
    return 2;
  }
  const recipe = readJson(file);
  const { built } = buildFromRecipe(recipe, args, file);

  const out = args.flags.out ? path.resolve(String(args.flags.out)) : defaultOut(file, '.kdenlive');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, built.xml, 'utf8');

  const s = built.summary;
  console.log('');
  console.log(`generado: ${out}`);
  console.log(`  ${s.width}x${s.height} @ ${s.fps} fps · ${s.cuts} corte(s) · duración ${s.duration}`);
  console.log(`  ${s.videoTracks} pista(s) de vídeo, ${s.audioTracks} de audio` +
    `${s.mixes ? ` · ${s.mixes} encadenado(s)` : ''}${s.fades ? ` · ${s.fades} clip(s) con fundido` : ''}`);
  console.log('');
  console.log('Ábrelo con Kdenlive, o renderízalo sin abrirlo:');
  console.log(`  node cli.js render ${file}`);
  return 0;
}

/*
 * Traduce los avisos de MLT a algo accionable. El caso típico en Linux es un MLT sin
 * el módulo Qt operativo: entonces este render sale sin reencuadre ni composición,
 * pero el proyecto para Kdenlive es correcto, porque Kdenlive sí trae ese módulo.
 * Decirlo explícitamente evita dar por bueno un preview que no es fiel.
 */
function explainRenderLog(log) {
  const lines = log.split('\n');
  const filterFailed = new Set();
  const transitionFailed = new Set();
  const others = [];

  for (const line of lines) {
    const f = line.match(/failed to load filter "([^"]+)"/i);
    const t = line.match(/failed to load transition "([^"]+)"/i);
    if (f) filterFailed.add(f[1]);
    else if (t) transitionFailed.add(t[1]);
    else if (/\berror\b/i.test(line) && line.trim()) others.push(line.trim());
  }

  if (filterFailed.size) {
    console.log(`  aviso   tu MLT no carga el filtro ${[...filterFailed].join(', ')}.`);
    console.log('          En ESTE render no se aplican el reencuadre (zoom/pan/tilt) ni la');
    console.log('          opacidad. En Kdenlive sí se aplican: el .kdenlive es correcto.');
  }
  if (transitionFailed.size) {
    console.log(`  aviso   tu MLT no carga la transición ${[...transitionFailed].join(', ')}:`);
    console.log('          este render puede salir sin composición entre pistas.');
  }
  for (const o of others.slice(0, 4)) console.log(`  aviso   ${o}`);
}

// --------------------------------------------------------------------- render

function cmdRender(args) {
  const file = args._[0];
  if (!file) {
    console.error('uso: node cli.js render <receta.json|proyecto.kdenlive> [--out video.mp4] [--hilos 2]');
    return 2;
  }
  const melt = buscarBinario('melt');
  if (!melt) {
    console.error('error: no se encontró "melt" (el renderizador de MLT).');
    console.error('  Debian/Ubuntu: sudo apt install melt');
    console.error('  Windows/macOS: viene dentro de Kdenlive; si lo instalaste en otra');
    console.error('  carpeta, renderiza desde el propio Kdenlive (Proyecto > Renderizar).');
    return 1;
  }

  let projectFile;
  let cleanup = null;
  let summary = null;

  if (/\.kdenlive$|\.mlt$/i.test(file)) {
    projectFile = path.resolve(file);
    if (!exists(projectFile)) throw new Error(`no existe ${projectFile}`);
  } else {
    const recipe = readJson(file);
    const { built } = buildFromRecipe(recipe, { ...args, flags: { ...args.flags, render: true } }, file);
    summary = built.summary;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kdenlive-claude-'));
    projectFile = path.join(dir, 'proyecto.kdenlive');
    fs.writeFileSync(projectFile, built.xml, 'utf8');
    cleanup = dir;
    console.log(`  composición: ${built.summary.compositing}`);
  }

  const out = args.flags.out
    ? path.resolve(String(args.flags.out))
    : defaultOut(file, '.mp4');
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const consumer = [
    `avformat:${out}`,
    'vcodec=libx264',
    `crf=${args.flags.crf || 20}`,
    'preset=veryfast',
    'acodec=aac',
    'ab=192k',
    'movflags=+faststart',
  ];
  // Varios fotogramas a la vez (lo que en Kdenlive es el procesamiento en paralelo): con 2, un 28 % menos
  // en las pruebas y el mismo resultado imagen a imagen. --hilos 1 lo desactiva.
  const hilos = Math.max(1, Math.round(Number(args.flags.hilos) || 2));
  if (hilos > 1) consumer.push(`real_time=-${hilos}`);

  console.log(`\nrenderizando a ${out} ...`);
  /*
   * Melt escribe una línea de progreso por fotograma: en un vídeo largo son decenas de
   * megas, y spawnSync mata el proceso al pasar de su límite de salida (1 MB). Va a un
   * archivo y solo se lee el final, que es lo que explica un fallo.
   */
  const logFile = path.join(os.tmpdir(), `melt-${process.pid}-${Date.now()}.log`);
  const logFd = fs.openSync(logFile, 'w');
  const [cmdMelt, ...previos] = M.comandoMelt(melt);
  const res = spawnSync(cmdMelt, [...previos, projectFile, '-consumer', ...consumer], {
    stdio: ['ignore', logFd, logFd],
    timeout: Number(args.flags.timeout) > 0 ? Number(args.flags.timeout) * 1000 : 8 * 3600000,
  });
  fs.closeSync(logFd);
  let log = '';
  try {
    const tam = fs.statSync(logFile).size;
    const leer = Math.min(tam, 200000);
    const buf = Buffer.alloc(leer);
    const fd = fs.openSync(logFile, 'r');
    fs.readSync(fd, buf, 0, leer, tam - leer);
    fs.closeSync(fd);
    // Se quitan las líneas de progreso para que lo útil no quede enterrado.
    log = buf.toString('utf8').split(/\r?\n|\r/)
      .filter((l) => !/Current Position|deprecated pixel format/.test(l)).join('\n');
  } finally {
    fs.rmSync(logFile, { force: true });
  }
  if (res.error) log += `\n${res.error.message}`;
  explainRenderLog(log);

  if (res.status !== 0 || !exists(out)) {
    console.error('error: el render falló.');
    console.error(log.split('\n').slice(-12).join('\n'));
    if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
    return 1;
  }

  const size = (fs.statSync(out).size / (1024 * 1024)).toFixed(1);
  console.log(`\nlisto: ${out} (${size} MB)`);
  if (summary) console.log(`  esperado: ${summary.frames} frames · ${summary.duration}`);

  const probed = M.hasFfprobe() ? M.probe(out, summary ? summary.fps : null) : null;
  if (probed && probed.frames) {
    console.log(`  obtenido: ${probed.width}x${probed.height} · ${probed.seconds.toFixed(2)} s` +
      `${probed.hasAudio ? ' · con audio' : ' · SIN audio'}`);
  }

  if (cleanup) fs.rmSync(cleanup, { recursive: true, force: true });
  return 0;
}

// ------------------------------------------------------------------ calibrar

/*
 * Mide el retardo entre la imagen y el sonido de cada cámara.
 *
 * Es lo único que no se puede deducir comparando archivos entre sí: si la cadena de
 * grabación escribe el audio desplazado respecto al vídeo, los dos van desplazados a la
 * vez y la correlación no ve nada raro. Hace falta un suceso que esté en la imagen y en
 * el sonido a la vez. Una palmada delante de la cámara sirve; un destello de pantalla
 * que ilumine la cara, también.
 */
function cmdCalibrar(args) {
  if (!args._.length) {
    console.error('uso: node cli.js calibrar <camara.mp4|carpeta> [...] [--ventana 25]');
    console.error('  Usa la claqueta del Estudio (pitido + destello) si la hay; si no,');
    console.error('  una palmada delante de la cámara en los primeros segundos.');
    console.error('  Si le pasas una carpeta, mira todos los vídeos que haya dentro.');
    return 2;
  }
  if (!which('ffmpeg')) throw new Error('hace falta ffmpeg');

  /*
   * Solo tiene sentido calibrar lo que tiene imagen, y además solo las cámaras: la
   * grabación de la llamada se usa como referencia de sincronía pero no se ve en el
   * montaje, así que su retardo no se aplica a nada. Y al ser una composición, el
   * destello puede no estar ni en ella.
   */
  const archivos = expandirArchivos(args._).filter((f) => {
    const info = M.probe(f, null);
    if (!info.hasVideo) return false;
    // Ojo con \b aquí: en "jc_llamada" el guion bajo es carácter de palabra, así que
    // no hay frontera entre "jc_" y "llamada" y \bllamada\b no coincidiría.
    if (/(^|[_\-\s.])(llamada|call|zoom|meet|reunion|teams)([_\-\s.]|$)/i.test(MC.nombreBase(f))) {
      console.log(`  ${MC.nombreBase(f)}: es la grabación de la llamada, no una cámara; se omite.`);
      return false;
    }
    return true;
  });
  if (!archivos.length) throw new Error('no hay ningún archivo con vídeo que calibrar');

  const ventana = args.flags.ventana !== undefined ? Number(args.flags.ventana) : CAL.VENTANA_POR_DEFECTO;
  const modo = args.flags.modo ? String(args.flags.modo) : 'auto';
  console.log(`buscando la marca en los primeros ${ventana} s de cada archivo\n`);

  const recomendaciones = [];
  for (const file of archivos) {
    const info = M.probe(file, null);
    if (info.missing || info.probeFailed || !info.hasVideo) {
      console.log(`  ${MC.nombreBase(file).padEnd(22)} no sirve: ${info.probeFailed || 'no tiene vídeo'}`);
      continue;
    }

    const fps = info.fps || 25;

    /*
     * Si la grabación lleva la claqueta del Estudio (pitido de 1 kHz y destello de
     * pantalla a la vez), se usa: el pitido se localiza con precisión de muestra y el
     * destello es inconfundible. Si no hay claqueta, se recurre a buscar un golpe, que
     * sirve para una palmada pero es menos fiable.
     */
    let r = null;
    const radio = args.flags.radio !== undefined ? Number(args.flags.radio) : undefined;
    if (modo !== 'golpe') r = CAL.calibrarClaqueta(file, { fps, ventana, radio });
    const huboClaqueta = r && !r.error;
    if (!huboClaqueta && modo !== 'claqueta') {
      r = CAL.calibrarCamara(file, { fps, ventana });
    }

    if (!r || r.error) {
      console.log(`  ${MC.nombreBase(file).padEnd(22)} ${r ? r.error : 'no se pudo medir'}`);
      continue;
    }

    /*
     * Tres cosas distintas pueden invalidar la medida, y conviene distinguirlas en el
     * mensaje: que la marca no destaque, que el retardo salga fuera de lo creíble (señal
     * de que no había marca y se confundió con otra cosa), o que simplemente se esté
     * usando el modo de respaldo sobre material hablado, donde no es de fiar.
     */
    const flojo = r.confianzaVideo < 4 || r.confianzaAudio < 4;
    const inverosimil = Math.abs(r.retardoMs) > CAL.RETARDO_MAXIMO_CREIBLE_MS;
    const fiable = !flojo && !inverosimil && (huboClaqueta || !inverosimil);

    console.log(`  ${MC.nombreBase(file)}`);
    console.log(`    marca: ${huboClaqueta
      ? 'claqueta del Estudio (pitido + destello)'
      : 'sin claqueta; buscando un golpe en imagen y sonido'}`);
    console.log(`    en la imagen: ${r.tVideo.toFixed(3)}s  ·  en el sonido: ${r.tAudio.toFixed(3)}s`);
    console.log(`    retardo del audio: ${r.retardoMs >= 0 ? '+' : ''}${r.retardoMs} ms` +
      `${r.incertidumbreMs ? ` (±${r.incertidumbreMs} ms: el destello solo se puede situar al fotograma)` : ''}`);

    if (inverosimil) {
      console.log(`    NO VALE: ${Math.abs(r.retardoMs)} ms es demasiado para ser latencia de captura.`);
      console.log('    Lo que se ha encontrado no es una marca. Si la grabación es del Estudio,');
      console.log('    usa los archivos ORIGINALES: alinear.js quita el pitido.');
    } else if (flojo) {
      console.log('    NO VALE: la marca no destaca lo suficiente sobre el resto.');
    } else if (!huboClaqueta) {
      console.log('    Ojo: sin claqueta esto es una estimación. Compruébalo antes de fiarte.');
    }

    if (fiable) {
      const persona = MC.nombreBase(file).replace(/[_-]?(camara|camera|cam|video)\b.*$/i, '') || 'persona';
      console.log(`    -> --audio-offset "${persona}=${r.offsetRecomendado}"`);
      recomendaciones.push(`${persona}=${r.offsetRecomendado}`);
    }
    console.log('');
  }

  if (recomendaciones.length > 1) {
    console.log(`todas juntas:  --audio-offset "${recomendaciones.join(',')}"`);
  }
  return 0;
}

// ------------------------------------------------------------- ajustar audio

/*
 * Mueve el audio de una receta ya generada, sin repetir el análisis (que es lo lento).
 *
 * Sirve para afinar el labial a ojo cuando el material trae algún desfase propio que
 * no se puede medir desde fuera. Con --probar genera varias versiones de golpe para
 * poder elegir la buena en una sola pasada en vez de ir probando de una en una.
 */
function cmdAjustarAudio(args) {
  const file = args._[0];
  if (!file) {
    console.error('uso: node cli.js ajustar-audio <receta.json> --ms -40 [--render]');
    console.error('     node cli.js ajustar-audio <receta.json> --probar "0,-33,-66,-100"');
    console.error('  Negativo adelanta el audio (si va atrasado); positivo lo atrasa.');
    return 2;
  }

  const recipe = readJson(file);
  const fps = Number((recipe.project || {}).fps) || 25;
  const pistasAudio = (recipe.edit || []).filter((c) => c.audioTrack);
  if (!pistasAudio.length) {
    throw new Error('esta receta no tiene pistas de audio independientes; ' +
      'genera el montaje con "multicam" primero.');
  }

  const valores = args.flags.probar
    ? String(args.flags.probar).split(',').map((v) => Number(v.trim()))
    : [args.flags.ms !== undefined ? Number(args.flags.ms) : 0];
  if (valores.some((v) => !Number.isFinite(v))) {
    throw new Error('los milisegundos tienen que ser números, por ejemplo: --probar "0,-33,-66"');
  }

  /*
   * Con --persona solo se mueve el audio de esa persona. Sirve para afinar a quien
   * grabó con Bluetooth sin tocar a quien no lo usó.
   */
  const soloPersona = args.flags.persona ? String(args.flags.persona).toLowerCase() : null;
  const esSuya = (corte) => {
    if (!soloPersona) return true;
    const id = String(corte.clip || '').toLowerCase();
    return id === soloPersona || id === `mic_${soloPersona}`;
  };
  if (soloPersona) {
    const hay = pistasAudio.some(esSuya);
    if (!hay) {
      throw new Error(`--persona ${soloPersona}: no hay ninguna pista de audio suya. ` +
        `Las que hay son: ${pistasAudio.map((c) => c.clip).join(', ')}`);
    }
  }

  const carpeta = path.dirname(path.resolve(file));
  const base = path.basename(file).replace(/\.json$/i, '');

  for (const ms of valores) {
    /*
     * Adelantar el audio = empezar el clip más adentro, o sea subir su punto de
     * entrada. De ahí el signo cambiado: --ms -40 (adelantar 40 ms) sube el "in".
     */
    const delta = -Math.round((ms / 1000) * fps);
    const copia = JSON.parse(JSON.stringify(recipe));
    let recortados = 0;

    // Adelantar el audio lo acerca al final del archivo, así que además de mover el
    // punto de entrada hay que acortar la duración: pedir un frame que no existe hace
    // que no se genere nada, y perder la última décima de audio no se nota.
    const disponibles = M.hasFfprobe()
      ? Object.fromEntries((copia.media || []).map((m) => {
        const info = M.probe(m.path, fps);
        return [m.id, info.frames || null];
      }))
      : {};

    for (const corte of copia.edit) {
      if (!corte.audioTrack || !esSuya(corte)) continue;
      const nuevo = (corte.in || 0) + delta;
      if (nuevo < 0) {
        recortados += 1;
        corte.in = 0;
      } else {
        corte.in = nuevo;
      }
      const total = disponibles[corte.clip];
      if (total && corte.duration && corte.in + corte.duration > total) {
        corte.duration = Math.max(1, total - corte.in);
        recortados += 1;
      }
    }

    const sufijo = valores.length > 1 || ms !== 0
      ? `-audio${soloPersona ? `-${soloPersona}` : ''}${ms >= 0 ? '+' : ''}${ms}ms`
      : '-ajustado';
    const destino = path.join(carpeta, `${base}${sufijo}.json`);
    fs.writeFileSync(destino, `${JSON.stringify(copia, null, 2)}\n`, 'utf8');

    console.log(`\n${ms >= 0 ? '+' : ''}${ms} ms (${delta >= 0 ? '+' : ''}${delta} frames a ${fps} fps)` +
      `${recortados ? ` · ${recortados} pista(s) ajustadas al material disponible` : ''}`);
    console.log(`  receta: ${destino}`);

    const salida = path.join(carpeta, `${base}${sufijo}.${args.flags.render ? 'mp4' : 'kdenlive'}`);
    const sub = { ...args, _: [destino], flags: { ...args.flags, out: salida } };
    const resultado = args.flags.render ? cmdRender(sub) : cmdBuild(sub);
    if (resultado !== 0) return resultado;
  }

  if (valores.length > 1) {
    console.log('\nMira las versiones y quédate con la que cuadre. Esa cantidad de ms es la');
    console.log('que hay que pasarle a multicam con --audio-offset para las próximas veces.');
  }
  return 0;
}

// ------------------------------------------------------------------ multicam

/*
 * Monta una conversación grabada a varias cámaras: sincroniza, decide quién habla y
 * escribe la receta y el proyecto.
 */
function cmdMulticam(args) {
  if (!args._.length) {
    console.error('uso: node cli.js multicam <archivos...|carpeta> [--ref llamada.mp4] [--out carpeta]');
    console.error('  Pásale las cámaras, los audios de micro y, si la tienes, la captura');
    console.error('  de la llamada (se usa como referencia para sincronizar).');
    console.error('  También vale la carpeta de la sesión, y coge lo que haya dentro.');
    return 2;
  }
  const archivos = expandirArchivos(args._);
  if (archivos.length < 2) {
    throw new Error('hacen falta al menos dos archivos (una cámara y un audio).');
  }
  if (!which('ffmpeg')) {
    throw new Error('hace falta ffmpeg para leer y sincronizar el audio.\n' +
      '  Windows: winget install Gyan.FFmpeg   ·   Debian/Ubuntu: sudo apt install ffmpeg');
  }

  // --- 1. quién es quién
  const { people, call, calls, unknown } = MC.inferRoles(archivos);
  const carpeta = path.resolve(String(args.flags.out || path.dirname(archivos[0])));
  console.log('material reconocido:');
  for (const [id, p] of people) {
    console.log(`  ${id}: cámara ${p.cam ? MC.nombreBase(p.cam) : '(falta)'} · ` +
      `micro ${p.mic ? MC.nombreBase(p.mic) : '(falta, se usa el de la cámara)'}`);
  }
  let referencia = args.flags.ref ? path.resolve(String(args.flags.ref)) : call;
  if (!args.flags.ref && calls.length > 1) {
    // Varias llamadas: o la página que la grababa se cayó y se retomó (tramos que hay que unir), o
    // las dos personas la grabaron (copias de lo mismo). llamadas.js lo distingue.
    const u = LL.llamadaParaReloj(archivos, carpeta, { log: (t) => console.log(`  ${t}`) });
    if (u.error) throw new Error(u.error);
    referencia = u.archivo;
    for (const f of u.ignoradas) console.log(`  aviso   otra copia de la llamada, se ignora: ${MC.nombreBase(f)}`);
  }
  console.log(`  referencia de sincronía: ${referencia ? MC.nombreBase(referencia) : '(ninguna)'}`);
  for (const f of unknown) console.log(`  aviso   sin clasificar, se ignora: ${MC.nombreBase(f)}`);

  const personas = [...people.values()].filter((p) => p.cam);
  if (personas.length < 1) {
    throw new Error('no se reconoció ninguna cámara. Los nombres deben llevar "camara"/"cam" ' +
      'y "audio"/"mic", como dj_camara.mp4 y dj_audio.wav.');
  }
  if (!referencia) {
    throw new Error('hace falta una referencia para sincronizar: pásala con --ref ' +
      '(lo normal es la captura de la llamada, que contiene las dos voces).');
  }

  // --- 2. leer los archivos
  const usados = [referencia];
  for (const p of personas) {
    if (p.cam) usados.push(p.cam);
    if (p.mic) usados.push(p.mic);
  }
  const unicos = [...new Set(usados)];

  const probes = {};
  for (const f of unicos) {
    const info = M.probe(f, null);
    if (info.missing || info.probeFailed) {
      throw new Error(`no se pudo leer ${MC.nombreBase(f)}: ${info.probeFailed || 'no existe'}`);
    }
    probes[f] = info;
  }

  const fpsCamaras = personas.map((p) => probes[p.cam].fps).filter(Boolean);
  const fps = Number(args.flags.fps) || Math.round(fpsCamaras[0] || 25) || 25;
  const distintos = [...new Set(fpsCamaras.map((f) => Math.round(f)))];
  if (distintos.length > 1) {
    console.log('');
    console.log(`  aviso   las cámaras no van al mismo ritmo (${distintos.join(' y ')} fps).`);
    console.log(`          El montaje se hace a ${fps} fps y Kdenlive adapta la otra.`);
    console.log(`          Si prefieres el otro, añade --fps ${Math.max(...distintos)}.`);
  }

  console.log('');
  for (const f of unicos) {
    const i = probes[f];
    console.log(`  ${MC.nombreBase(f).padEnd(22)} ${i.seconds ? `${i.seconds.toFixed(1)}s` : '?'}` +
      `${i.hasVideo ? ` · ${i.width}x${i.height} · ${(i.fps || 0).toFixed(2)} fps` : ' · solo audio'}` +
      `${i.hasAudio ? '' : ' · SIN AUDIO'}`);
  }

  // --- 3. envolventes (una sola pasada: sirven para sincronizar y para los turnos)
  const analizar = args.flags.analyze ? Number(args.flags.analyze) : Infinity;
  console.log('\nanalizando el audio...');
  const envs = {};
  for (const f of unicos) {
    const e = SY.envelope(f, { analyzeSeconds: analizar });
    if (e.error) throw new Error(`no se pudo analizar ${MC.nombreBase(f)}: ${e.error}`);
    envs[f] = e;
  }

  /*
   * --- 4. desfases
   *
   * Las cámaras se alinean contra la referencia (normalmente la llamada), que es lo
   * único que contiene a las dos personas.
   *
   * Pero cada micro NO se alinea contra la llamada, sino contra su propia cámara. En
   * una llamada, la voz del otro llega con el retardo de la red, así que usar la
   * llamada como referencia para un micro mete ese retardo en el labial. El micro y
   * su cámara, en cambio, grabaron el mismo sonido en la misma habitación: entre esos
   * dos no hay nada que se interponga.
   */
  const offsets = {};
  const confianzas = {};
  offsets[referencia] = 0;
  confianzas[referencia] = Infinity;

  console.log('\ncámaras, respecto a la referencia:');
  console.log(`  ${MC.nombreBase(referencia).padEnd(22)} referencia`);

  /*
   * Dentro de un .mp4 la pista de audio puede no empezar en el mismo instante que la de
   * vídeo (pasa con capturas de webcam). Se mide y se informa, pero NO se descuenta:
   * medido sobre material con 120 ms inyectados a propósito, descontarlo empeora el
   * labial, porque ffmpeg ya ignora ese desplazamiento al decodificar y restarlo otra
   * vez lo cuenta dos veces. Lo que queda es un residuo pequeño, y para eso está
   * --audio-offset.
   */
  for (const persona of personas) {
    const r = SY.offsetBetween(envs[referencia].envelope, envs[persona.cam].envelope);
    offsets[persona.cam] = r.seconds;
    confianzas[persona.cam] = r.confidence;
    const skew = probes[persona.cam].skew || 0;
    console.log(`  ${MC.nombreBase(persona.cam).padEnd(22)} ${r.seconds >= 0 ? '+' : ''}` +
      `${r.seconds.toFixed(3)}s · confianza ${r.confidence.toFixed(1)}` +
      `${r.confidence >= 5 ? '' : '  <-- POCO FIABLE'}`);
    if (Math.abs(skew) > 0.005) {
      console.log(`  ${' '.repeat(22)} ojo: dentro de ese archivo el audio empieza ` +
        `${(skew * 1000).toFixed(0)} ms ${skew > 0 ? 'después' : 'antes'} que el vídeo`);
    }
  }

  const nudge = ajustesPorPersona(args.flags['audio-offset'], '--audio-offset');

  const conMicro = personas.filter((p) => p.mic);
  if (conMicro.length) {
    console.log('\nmicrófonos, respecto a SU cámara (así el labial no arrastra el retardo de la llamada):');
    for (const persona of conMicro) {
      const r = SY.offsetBetween(envs[persona.cam].envelope, envs[persona.mic].envelope);
      // Un tramo retomado (jc-2) hereda el ajuste de su persona (jc).
      const ms = nudge(persona.id) || nudge(personaBase(persona.id));
      offsets[persona.mic] = offsets[persona.cam] + r.seconds + ms / 1000;
      confianzas[persona.mic] = r.confidence;
      console.log(`  ${MC.nombreBase(persona.mic).padEnd(22)} ${r.seconds >= 0 ? '+' : ''}${r.seconds.toFixed(3)}s` +
        ` respecto a ${MC.nombreBase(persona.cam)} · confianza ${r.confidence.toFixed(1)}` +
        `${r.confidence >= 5 ? '' : '  <-- POCO FIABLE'}` +
        `${ms ? `  · ajuste manual ${ms >= 0 ? '+' : ''}${ms} ms` : ''}`);
    }
  }

  const dudosos = unicos.filter((f) => confianzas[f] < 5);
  if (dudosos.length) {
    console.log('');
    console.log('  aviso   la sincronía de ' + dudosos.map(MC.nombreBase).join(', ') + ' no es fiable.');
    console.log('          Pasa suele cuando el audio no comparte contenido reconocible con la');
    console.log('          referencia. Revisa esos clips en la timeline y muévelos si hace falta.');
  }

  // --- 5. ventana común: donde existen todos los archivos
  const binHz = SY.BIN_HZ;
  let desdeSeg = -Infinity;
  let hastaSeg = Infinity;
  /*
   * Cada persona cubre desde que empieza su primer archivo hasta que acaba el último: si se
   * cayó la página y retomó (jc y jc-2), el hueco no recorta el montaje. Entre personas sí
   * se intersecta, porque fuera de ahí falta alguien.
   */
  const tramos = new Map();
  for (const p of personas) {
    // Dentro de un tramo, la cámara y el micro tienen que coincidir.
    let d = -Infinity;
    let h = Infinity;
    for (const f of [p.cam, p.mic].filter(Boolean)) {
      d = Math.max(d, offsets[f]);
      h = Math.min(h, offsets[f] + (probes[f].seconds || 0));
    }
    const quien = personaBase(p.id);
    const t = tramos.get(quien) || { desde: Infinity, hasta: -Infinity };
    t.desde = Math.min(t.desde, d);
    t.hasta = Math.max(t.hasta, h);
    tramos.set(quien, t);
  }
  if (args.flags['usar-referencia'] && probes[referencia]) {
    tramos.set('referencia', { desde: offsets[referencia], hasta: offsets[referencia] + (probes[referencia].seconds || 0) });
  }
  for (const t of tramos.values()) {
    desdeSeg = Math.max(desdeSeg, t.desde);
    hastaSeg = Math.min(hastaSeg, t.hasta);
  }
  if (!(hastaSeg > desdeSeg)) {
    throw new Error('los archivos no se solapan en el tiempo: revisa los desfases detectados.');
  }
  let fromBin = Math.max(0, Math.round(desdeSeg * binHz));
  let toBin = Math.round(hastaSeg * binHz);
  console.log(`\nparte común: ${(desdeSeg).toFixed(2)}s a ${(hastaSeg).toFixed(2)}s ` +
    `(${((hastaSeg - desdeSeg)).toFixed(1)}s de montaje)`);

  // Recorte manual: lo normal es quitar el pitido de sincronía del principio y del
  // final, que no se puede detectar de forma fiable pero sí se sabe dónde está.
  const desdeFlag = args.flags.desde !== undefined
    ? Math.round(tiempoASegundos(args.flags.desde, '--desde') * binHz) : null;
  const hastaFlag = args.flags.hasta !== undefined
    ? Math.round(tiempoASegundos(args.flags.hasta, '--hasta') * binHz) : null;
  if (desdeFlag !== null) fromBin = Math.max(fromBin, desdeFlag);
  if (hastaFlag !== null) toBin = Math.min(toBin, hastaFlag);
  if (desdeFlag !== null || hastaFlag !== null) {
    if (!(toBin > fromBin)) {
      throw new Error(`--desde y --hasta no dejan nada que montar (quedaría de ` +
        `${(fromBin / binHz).toFixed(2)}s a ${(toBin / binHz).toFixed(2)}s). ` +
        'Son segundos del montaje, y la parte común empieza en ' +
        `${(desdeSeg).toFixed(2)}s.`);
    }
    console.log(`  recortado a ${(fromBin / binHz).toFixed(2)}s - ${(toBin / binHz).toFixed(2)}s ` +
      `(${((toBin - fromBin) / binHz).toFixed(1)}s)`);
  }

  // --- 6. turnos de palabra
  const pistas = personas.map((p) => {
    const fuente = p.mic || p.cam;
    return { id: p.id, envelope: envs[fuente].envelope, offsetBins: Math.round(offsets[fuente] * binHz) };
  });
  const turns = MC.detectTurns(pistas, {
    binHz,
    fromBin,
    toBin,
    minShot: args.flags['min-shot'] !== undefined ? Number(args.flags['min-shot']) : 2,
    confirm: args.flags.confirm !== undefined ? Number(args.flags.confirm) : 0.5,
  });

  if (!turns.length) {
    throw new Error('no se detectó quién habla en ningún momento. Si los micros están muy ' +
      'bajos o hay mucho ruido, prueba con --min-shot 1.');
  }

  const reparto = {};
  for (const t of turns) {
    reparto[t.id] = (reparto[t.id] || 0) + (t.endBin - t.startBin) / binHz;
  }
  console.log(`\n${turns.length} planos · duración media ` +
    `${(((toBin - fromBin) / binHz) / turns.length).toFixed(1)}s`);
  for (const [id, seg] of Object.entries(reparto)) {
    const pct = (100 * seg) / ((toBin - fromBin) / binHz);
    console.log(`  ${id}: ${seg.toFixed(1)}s en pantalla (${pct.toFixed(0)}%)`);
  }

  // --- 7. sonido: igualar el nivel de los micros
  const ganancias = {};
  const modoAudio = args.flags.audio === undefined ? 'auto' : String(args.flags.audio);
  if (modoAudio !== 'off' && conMicro.length) {
    const objetivo = args.flags.lufs !== undefined ? Number(args.flags.lufs) : AN.OBJETIVO_LUFS;
    console.log(`\nnivel de los micrófonos (objetivo ${objetivo} LUFS):`);
    for (const persona of conMicro) {
      const v = AN.volumen(persona.mic);
      if (v.error) {
        console.log(`  ${MC.nombreBase(persona.mic).padEnd(22)} no se pudo medir (${v.error})`);
        continue;
      }
      const g = AN.gananciaHacia(v.lufs, objetivo);
      if (g.db !== 0) ganancias[persona.mic] = g.db;
      console.log(`  ${MC.nombreBase(persona.mic).padEnd(22)} ${v.lufs.toFixed(1)} LUFS` +
        ` -> ${g.db >= 0 ? '+' : ''}${g.db} dB${g.recortada ? '  (acotada; estaba muy lejos del objetivo)' : ''}`);
    }
  }

  // --- 8. color: que las dos cámaras se parezcan
  const colores = {};
  const modoColor = args.flags.color === undefined ? 'auto' : String(args.flags.color);
  const saturacion = args.flags.saturacion !== undefined ? Number(args.flags.saturacion) : null;
  const contraste = args.flags.contraste !== undefined ? Number(args.flags.contraste) : null;

  if (modoColor !== 'off') {
    const medidos = {};
    for (const persona of personas) {
      // Para el color medio basta una muestra: 5 minutos, saltando el primero si la grabación es larga.
      // Decodificar la cámara entera (90 min, a veces a 60 fps) solo para esto costaba muchos minutos.
      const largo = probes[persona.cam].seconds || 0;
      const c = AN.colorMedio(persona.cam, { desde: largo > 400 ? 60 : 0, segundos: Math.min(analizar, 300) });
      if (!c.error) medidos[persona.cam] = c;
    }
    const lista = Object.values(medidos);
    if (lista.length) {
      console.log('\ncolor medio de cada cámara:');
      // Objetivo común: el punto medio entre todas. Así ninguna se lleva todo el
      // ajuste y las dos se mueven la mitad del camino.
      // Cada persona cuenta una vez, aunque tenga varios tramos de cámara (jc y jc-2).
      const medias = new Map();
      for (const persona of personas) {
        const c = medidos[persona.cam];
        if (!c) continue;
        const quien = personaBase(persona.id);
        const m = medias.get(quien) || { r: 0, g: 0, b: 0, n: 0 };
        m.r += c.r; m.g += c.g; m.b += c.b; m.n += 1;
        medias.set(quien, m);
      }
      const porPersona = [...medias.values()].map((m) => ({ r: m.r / m.n, g: m.g / m.n, b: m.b / m.n }));
      const objetivo = {
        r: porPersona.reduce((a, c) => a + c.r, 0) / porPersona.length,
        g: porPersona.reduce((a, c) => a + c.g, 0) / porPersona.length,
        b: porPersona.reduce((a, c) => a + c.b, 0) / porPersona.length,
      };
      for (const [archivo, c] of Object.entries(medidos)) {
        const g = lista.length > 1 ? AN.gananciasHacia(c, objetivo) : { r: 1, g: 1, b: 1 };
        const aplica = lista.length > 1 && AN.cambioApreciable(g);
        const ajuste = {};
        if (aplica) ajuste.rgb = g;
        if (saturacion !== null) ajuste.saturation = saturacion;
        if (contraste !== null) ajuste.contrast = contraste;
        if (Object.keys(ajuste).length) colores[archivo] = ajuste;
        console.log(`  ${MC.nombreBase(archivo).padEnd(22)} R${c.r.toFixed(0)} G${c.g.toFixed(0)} B${c.b.toFixed(0)}` +
          `${aplica ? ` -> x${g.r} x${g.g} x${g.b}` : '  (ya se parecen, sin cambio)'}`);
      }
      if (saturacion !== null || contraste !== null) {
        console.log(`  además, a todas: ${saturacion !== null ? `saturación x${saturacion}` : ''}` +
          `${saturacion !== null && contraste !== null ? ' y ' : ''}` +
          `${contraste !== null ? `contraste x${contraste}` : ''}`);
      }
    }
  }

  // --- 9. receta y proyecto
  const recipe = MC.buildRecipe({
    people: personas,
    offsets,
    probes,
    turns,
    fps,
    binHz,
    fromBin,
    toBin,
    ganancias,
    colores,
    nombre: args.flags.name ? String(args.flags.name) : 'Multicámara',
  });

  // En qué punto del reloj de la referencia empieza la línea de tiempo: lo necesitan los cortes.
  recipe.origenReferencia = fromBin / binHz;

  fs.mkdirSync(carpeta, { recursive: true });
  const recetaFile = path.join(carpeta, 'multicam.json');
  fs.writeFileSync(recetaFile, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');
  console.log(`\nreceta: ${recetaFile}`);

  const resultado = cmdBuild({ ...args, _: [recetaFile], flags: { ...args.flags, out: path.join(carpeta, 'multicam.kdenlive') } });
  if (resultado !== 0) return resultado;

  if (args.flags.render) {
    return cmdRender({ ...args, _: [recetaFile], flags: { ...args.flags, out: path.join(carpeta, 'multicam.mp4') } });
  }
  return 0;
}


function segundosAReloj(s) {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
}

// ------------------------------------------------------------------ episodio

/*
 * Las limpiezas de episodio.json, por micro y en el reloj de cada archivo. Se escriben como los
 * cortes, en el reloj de la llamada, y por persona: "jc" vale para todos sus tramos (jc y su
 * retomado jc-2), cada uno con su propio desfase; "jc-2" solo para ese tramo.
 */
function ventanasDeLimpieza(receta, limpiezas, parteId) {
  const out = new Map();
  const fps = Number(receta.project.fps);
  const origen = Number(receta.origenReferencia) || 0;
  for (const v of limpiezas) {
    const persona = String(v.persona || '');
    const mics = receta.media.filter((m) => m.id.startsWith('mic_')
      && (m.id.slice(4) === persona || personaBase(m.id.slice(4)) === persona));
    if (!mics.length) {
      console.log(`  aviso   limpieza: no hay micro de "${persona}" en la parte ${parteId}`);
      continue;
    }
    const desdeRef = tiempoASegundos(v.desde, `limpiezas de la parte ${parteId}`);
    const hastaRef = tiempoASegundos(v.hasta, `limpiezas de la parte ${parteId}`);
    for (const m of mics) {
      const e = receta.edit.find((x) => x.audioTrack && x.clip === m.id);
      if (!e) continue;
      // Segundo de la llamada en el que empieza el archivo: así se pasa de un reloj al otro.
      const desfase = origen + e.at / fps - (e.in || 0) / fps;
      const desde = Math.max(0, desdeRef - desfase);
      const hasta = hastaRef - desfase;
      if (!(hasta > desde)) continue;
      if (!out.has(m.id)) out.set(m.id, []);
      out.get(m.id).push({ desde: Math.round(desde * 1000) / 1000, hasta: Math.round(hasta * 1000) / 1000, ia: v.ia, puerta: v.puerta });
    }
  }
  return out;
}

/* Huella del episodio.kdenlive tal como se generó: si cambia, es que se guardó en Kdenlive. */
const huellaProyectoFile = (r) => path.join(r.montaje, 'episodio.kdenlive.huella');
const huellaArchivo = (f) => require('node:crypto').createHash('sha1').update(fs.readFileSync(f)).digest('hex');
function proyectoEditado(r) {
  const proyecto = path.join(r.montaje, 'episodio.kdenlive');
  if (!exists(proyecto) || !exists(huellaProyectoFile(r))) return false;
  return fs.readFileSync(huellaProyectoFile(r), 'utf8').trim() !== huellaArchivo(proyecto);
}

/* De qué archivos sale la configuración, y sus avisos (p. ej. cortes de otro episodio en la raíz). */
function mostrarConfig({ archivos, avisos }) {
  console.log(archivos.length ? `configuración: ${archivos.join(' + ')}` : 'configuración: valores por defecto (no hay episodio.json)');
  for (const a of avisos) console.log(`  aviso   ${a}`);
}

/*
 * Las partes que se van a montar y lo que se reconoce en cada una. Lo que se quedaría fuera (un
 * archivo repetido, por ejemplo) se dice aquí, antes de los minutos de análisis y no después.
 */
function mostrarPartes(partes) {
  console.log(`partes encontradas: ${partes.length}`);
  for (const p of partes) {
    const { people, llamadas, unknown } = MC.inferRoles(p.archivos);
    const quien = [...people.keys()].join(', ') || 'nadie';
    const llamada = !llamadas.length ? 'SIN llamada'
      : llamadas.length === 1 ? 'llamada' : `llamada en ${llamadas.length} tramos (${llamadas.map((l) => l.quien).join(' + ')})`;
    console.log(`  parte ${p.id}${p.sesion ? ` · sesión ${p.sesion}` : ''}: ${p.archivos.length} archivos · ${quien} · ${llamada}`);
    for (const f of unknown) console.log(`    aviso   se quedaría fuera: ${MC.nombreBase(f)}`);
  }
  if (partes.length > 1 && partes.some((p) => p.porNumero)) {
    console.log('  aviso   el orden de las partes sale del "(1)", "(2)" que pone el navegador al descargar:');
    console.log('          compruébalo. Es más seguro importar desde el Estudio: node cli.js importar --copiar');
  }
  console.log('');
}

/*
 * La configuración con la que se montaría un episodio: de qué archivos sale, cuánto vale cada
 * ajuste (y si no es el de por defecto) y lo propio del episodio. Con --tomar-de-raiz pasa a
 * este episodio los ajustes de episodio (cortes, partes…) que quedaron en la raíz.
 */
function cmdConfig(args) {
  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js config <carpeta-del-episodio> [--tomar-de-raiz]');
    return 2;
  }
  const r = EP.rutas(carpeta);
  if (args.flags['tomar-de-raiz']) {
    const t = EP.tomarDeRaiz(r.base);
    if (!t.movidas.length) console.log(`nada que mover: ${t.motivo}`);
    else {
      console.log(`pasado de la raíz a este episodio: ${t.movidas.join(', ')}`);
      console.log(`  ${t.archivoEpisodio}\n  copia de la raíz como estaba: ${t.copia}\n`);
    }
  }
  const c = EP.cargarConfig(r.base);
  console.log(`episodio: ${r.base}`);
  mostrarConfig(c);
  const texto = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  console.log('\nlo del equipo (si algo no es el valor por defecto, se indica):');
  for (const [k, def] of Object.entries(EP.CONFIG_POR_DEFECTO)) {
    if (EP.CLAVES_DEL_EPISODIO.includes(k)) continue;
    const v = c.config[k];
    const distinto = JSON.stringify(v) !== JSON.stringify(def);
    console.log(`  ${k.padEnd(14)} ${texto(v)}${distinto ? `   <- por defecto: ${texto(def)}` : ''}`);
  }
  for (const [k, v] of Object.entries(c.config)) {
    if (!(k in EP.CONFIG_POR_DEFECTO)) console.log(`  ${k.padEnd(14)} ${texto(v)}`);
  }
  console.log('\nde este episodio:');
  const general = c.config.cortes || [];
  console.log(`  cortes para todas las partes: ${general.length}`);
  for (const [id, p] of Object.entries(c.config.partes || {})) {
    const bits = Object.entries(p).map(([k, v]) => (Array.isArray(v) ? `${k}: ${v.length}` : `${k}: ${texto(v)}`));
    console.log(`  parte ${id}: ${bits.join(' · ') || '(nada)'}`);
  }
  if (!Object.keys(c.config.partes || {}).length) console.log('  (sin ajustes por parte)');
  return 0;
}

/*
 * El proceso semanal entero: originales → montaje → vídeo de YouTube.
 *   episodio nuevo <raiz> [--fecha AAAA-MM-DD]   crea las carpetas
 *   episodio <carpeta>                            lo monta y lo acaba
 * La configuración (retardos de audio por persona, niveles...) sale de episodio.json.
 */
function cmdEpisodio(args) {
  if (args._[0] === 'nuevo') {
    // Sin ruta, se usa la carpeta fija de episodios (así no se vuelve a crear en el sitio equivocado).
    const raiz = args._[1] || EP.RAIZ_POR_DEFECTO;
    const fecha = args.flags.fecha ? String(args.flags.fecha) : EP.fechaHoy();
    const r = EP.crearEstructura(path.join(path.resolve(raiz), fecha));
    const cfg = EP.escribirConfigSiFalta(raiz);
    const propia = EP.escribirConfigEpisodioSiFalta(r.base);
    console.log(`episodio creado: ${r.base}`);
    console.log(`  originales/    deja aquí lo que sale del Estudio, sin tocar (node cli.js importar --copiar)`);
    console.log(`  montaje/       receta, proyecto de Kdenlive y render en bruto`);
    console.log(`  entrega/       el vídeo final para YouTube`);
    console.log(`  episodio.json  los cortes y ajustes de ESTE episodio (lo del equipo está en ${path.join(path.resolve(raiz), 'episodio.json')})`);
    if (cfg) console.log(`\nconfiguración del equipo nueva: ${cfg}`);
    if (!propia) console.log('\n(el episodio.json del episodio ya existía; no se ha tocado)');
    for (const a of EP.cargarConfig(r.base).avisos) console.log(`\naviso   ${a}`);
    return 0;
  }

  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js episodio <carpeta> [--solo-montaje] [--reanudar] [--recortar] [--rehacer] [--sin-silencios]');
    console.error('                [--sin-acabado] [--sin-verificar] [--sin-camaras] [--usar-proyecto | --descartar-cambios]');
    console.error('     node cli.js episodio nuevo <raiz>');
    return 2;
  }
  if (!which('ffmpeg')) throw new Error('hace falta ffmpeg.');
  const r = EP.rutas(carpeta);
  if (!exists(r.originales)) {
    throw new Error(`no existe ${r.originales}. Crea el episodio con: node cli.js episodio nuevo <raiz>`);
  }
  const cargada = EP.cargarConfig(r.base);
  const { config } = cargada;
  mostrarConfig(cargada);

  const partes = EP.agruparPartes(r.originales);
  if (!partes.length) throw new Error(`no hay archivos de vídeo ni audio en ${r.originales}.`);
  mostrarPartes(partes);

  const recetaUnida = path.join(r.montaje, 'episodio.json');
  const reanudar = Boolean(args.flags.reanudar) && exists(recetaUnida);
  if (args.flags.reanudar && !reanudar) console.log('aviso   no hay montaje previo que reanudar; se hace desde cero.');
  if (reanudar) console.log(`reanudando con el montaje ya hecho: ${recetaUnida}`);
  const recetas = [];
  let personaAntes = null; // a quién se ve al acabar la parte anterior (la unión de las partes también es un empalme)
  const agregados = []; // tramos que se ponen al final del episodio
  for (const parte of reanudar ? [] : partes) {
    const cfg = EP.configDeParte(config, parte.id);
    console.log(`\n=== parte ${parte.id} ===`);
    AU.marcarFase(r, `montando-parte-${parte.id}`);
    // La llamada es el reloj de la parte; si quedó partida (caída de la página que la grababa), se une aquí.
    const llamada = AU.llamadaDe(parte, r.montaje);
    // `desde`/`hasta` pueden ser "auto": se miden con el pitido de la claqueta y la voz de la llamada.
    const lim = AU.resolverLimites(parte, cfg, r.montaje);
    cfg.desde = lim.desde;
    cfg.hasta = lim.hasta;
    console.log(`  audio-offset: ${cfg.audioOffset || '(ninguno)'} · desde ${cfg.desde || 0}s${cfg.hasta ? ` · hasta ${cfg.hasta}s` : ''}`);
    for (const d of lim.detalle) console.log(`  ${d}`);

    const carpetaParte = path.join(r.montaje, `parte-${parte.id}`);
    const flags = {
      ...args.flags,
      out: carpetaParte,
      name: `${path.basename(r.base)} parte ${parte.id}`,
      'min-shot': config.minShot,
      lufs: config.lufsMicros,
    };
    delete flags.render;
    if (llamada) flags.ref = llamada;
    if (cfg.audioOffset) flags['audio-offset'] = cfg.audioOffset;
    if (cfg.desde) flags.desde = String(cfg.desde);
    if (cfg.hasta) flags.hasta = String(cfg.hasta);

    /*
     * Con --recortar se reutiliza el reparto de cámaras ya hecho (multicam.json, sin
     * cortes) y solo se vuelven a aplicar los cortes: segundos en vez de los ~25 min del
     * análisis. Vale mientras no cambien `desde`, `hasta` ni el retardo de audio.
     */
    const recetaFile = path.join(carpetaParte, 'multicam.json');
    // La huella resume los archivos y los ajustes que afectan al reparto: si no cambió, no se repite el análisis largo.
    const huella = AU.huellaDeParte(parte, cfg);
    const huellaFile = path.join(carpetaParte, 'huella.txt');
    const mismaHuella = exists(huellaFile) && fs.readFileSync(huellaFile, 'utf8').trim() === huella;
    if (exists(recetaFile) && !args.flags.rehacer && (args.flags.recortar || mismaHuella)) {
      console.log(`  reutilizando el reparto de cámaras ya hecho (${mismaHuella ? 'nada cambió desde el análisis anterior' : '--recortar'})`);
    } else {
      const m = cmdMulticam({ ...args, _: parte.archivos, flags });
      if (m !== 0) return m;
      fs.writeFileSync(huellaFile, `${huella}\n`, 'utf8');
    }

    let receta = readJson(recetaFile);

    // Limpieza de micros en tramos (p. ej. un llanto de fondo): se usa un WAV nuevo por micro.
    const limpiezas = ventanasDeLimpieza(receta, cfg.limpiezas || [], parte.id);
    for (const [id, ventanas] of limpiezas) {
      const media = receta.media.find((m) => m.id === id);
      // El nombre lleva la parte (con una carpeta por sesión, dos partes tienen el mismo jc_audio.wav)
      // y una firma de las ventanas: si cambian, se rehace; si no, se reutiliza.
      const firma = require('node:crypto').createHash('sha1').update(JSON.stringify({ origen: media.path, ventanas })).digest('hex').slice(0, 8);
      const limpio = path.join(r.montaje, 'audio', `parte-${parte.id}-${path.basename(media.path, path.extname(media.path))}.limpio-${firma}.wav`);
      if (!exists(limpio)) {
        console.log(`\nlimpiando el micro ${id.slice(4)}: ${ventanas.map((v) => `${segundosAReloj(v.desde)}-${segundosAReloj(v.hasta)}`).join(', ')} (reloj del micro) ...`);
        const l = EP.limpiarMicro(media.path, limpio, ventanas, config);
        if (l.error) {
          console.error(`error en la limpieza: ${l.error}`);
          return 1;
        }
      }
      media.path = limpio;
      console.log(`  micro ${id.slice(4)}: ${path.basename(limpio)}`);
    }

    // Tramos en los que no se cambia de cámara (p. ej. la despedida), antes de cortar nada.
    for (const t of cfg.mantenerPlano || []) {
      const desde = tiempoASegundos(t[0], `mantenerPlano de la parte ${parte.id}`);
      const hasta = tiempoASegundos(t[1], `mantenerPlano de la parte ${parte.id}`);
      receta = CUT.mantenerPlano(receta, desde, hasta);
      console.log(`  plano fijo: ${segundosAReloj(desde)} → ${segundosAReloj(hasta)}`);
    }

    // Hasta dónde tiene imagen cada archivo de cámara (para no ponerla donde ya, o aún, no la hay).
    const fps = Number(receta.project.fps);
    const origen = Number(receta.origenReferencia) || 0;
    const fotogramas = {};
    if (M.hasFfprobe()) {
      for (const m of receta.media) {
        if (!m.id.startsWith('cam_')) continue;
        const p = M.probe(m.path, null);
        if (p && p.seconds) fotogramas[m.id] = Math.floor(p.seconds * fps);
      }
    }
    // Cámara congelada, en negro o sin imagen: esos tramos se cubren con la otra cámara (ver camaras.js).
    // Antes de sacar los tramos que se copian (alFinal, insertar), para que tampoco salga en ellos.
    let vetos = {};
    let cubiertos = [];
    const cc = { ...CAM.POR_DEFECTO, ...(config.camaras || {}) };
    if (cc.activo !== false && !args.flags['sin-camaras']) {
      const pc = CAM.problemasDeCamaras(receta, { cache: path.join(r.montaje, 'camaras.json'), opciones: cc, log: (t) => console.log(`  ${t}`) });
      for (const e of pc.errores) console.log(`  aviso   no se pudo revisar la imagen de ${e}`);
      if (pc.problemas.length) {
        const c = CUT.cubrirCamaras(receta, pc.problemas, { fotogramas, minimo: (config.disimularCortes || {}).minimo });
        receta = c.receta;
        vetos = c.vetos;
        cubiertos = c.cubiertos;
        for (const x of cubiertos) {
          console.log(`  ⚠ ${segundosAReloj(origen + x.desde / fps)} → ${segundosAReloj(origen + x.hasta / fps)} ${CAM.textoDeCamara(x, fps)}`
            + `${x.visto && (!x.con || x.quedan) ? ' (revísalo en Kdenlive)' : ''}`);
        }
      }
    }

    // Tramos a quitar: los que se marcan a mano y los silencios largos.
    // Los cortes pueden ser tiempos ["10:27","12:55"] o texto { "desde": "frase", "hasta": "frase" } (se buscan en la transcripción).
    const tramos = AU.resolverCortesTexto(cfg.cortes, parte, r.montaje).map((x) => {
      const t = {
        desde: tiempoASegundos(x.tramo[0], `cortes de la parte ${parte.id}`),
        hasta: tiempoASegundos(x.tramo[1], `cortes de la parte ${parte.id}`),
      };
      if (x.texto) console.log(`  corte por texto ${x.texto}: ${segundosAReloj(t.desde)} → ${segundosAReloj(t.hasta)}`);
      // De dónde sale cada corte (para la revisión): un texto, una propuesta aprobada o un corte a mano.
      t.motivo = x.texto ? `texto ${x.texto}` : (x.nota || 'corte a mano');
      return t;
    });
    if (config.silencios && config.silencios.activo && !args.flags['sin-silencios'] && llamada) {
      console.log('\nbuscando silencios largos...');
      const s = CUT.detectarSilencios(llamada, config.silencios);
      if (s.error) {
        console.log(`  aviso   no se pudieron buscar silencios: ${s.error}`);
      } else {
        const fin = origen + CUT.duracionFrames(receta) / fps;
        const dentro = s.tramos.filter((t) => t.hasta > origen && t.desde < fin);
        // La llamada puede callar mientras alguien habla (si se cortó): se comprueba en los micros.
        const conf = config.silencios.confirmarEnMicros === false ? { quedan: dentro, descartados: [] } : AU.confirmarSilencios(receta, dentro);
        console.log(`  ${conf.quedan.length} silencio(s) de ${config.silencios.min}s o más; se dejan ${config.silencios.dejar}s de pausa`);
        for (const d of conf.descartados) {
          console.log(`    no se corta ${segundosAReloj(d.desde)} → ${segundosAReloj(d.hasta)}: la llamada calla, pero en el micro de ${d.micro} hay ${d.segundos.toFixed(1)} s de voz (¿se cortó la llamada?)`);
        }
        tramos.push(...conf.quedan.map((t) => ({ ...t, motivo: 'silencio' })));
      }
    }
    // Marcas puestas en vivo con los botones del Estudio: ★ y los tramos ✂ que no se cortan, como guías.
    const enVivo = AU.marcasEnVivo(parte, r.montaje);
    if (enVivo.length) {
      const g = AU.guiasDeMarcas(receta, enVivo, tramos);
      receta = { ...receta, guides: [...(receta.guides || []), ...g.guias] };
      const buenos = enVivo.filter((m) => m.tipo === 'bueno').length;
      console.log(`  marcas en vivo: ${buenos} ★, ${enVivo.length - buenos} ✂ (en el proyecto como guías)`);
      if (g.sinCortar) {
        console.log(`  aviso   ${g.sinCortar} tramo(s) ✂ marcados en vivo NO se cortan: si sobran, aprueba su propuesta (ver montaje/propuesta.md)`);
      }
    }
    // Tramos que se copian al final del episodio (p. ej. el llamado a las plataformas).
    for (const t of cfg.alFinal || []) {
      const desde = tiempoASegundos(t[0], `alFinal de la parte ${parte.id}`);
      const hasta = tiempoASegundos(t[1], `alFinal de la parte ${parte.id}`);
      const tramo = CUT.extraerTramo(receta, desde, hasta);
      agregados.push({ prefijo: `p${partes.indexOf(parte) + 1}_`, tramo });
      console.log(`  al final del episodio: ${segundosAReloj(desde)} → ${segundosAReloj(hasta)} (${(tramo.frames / Number(receta.project.fps)).toFixed(1)} s)`);
    }

    // Tramos que se copian en mitad del episodio, antes de un instante (p. ej. el llamado a las
    // plataformas, antes de la despedida final). Se sacan de la receta aún sin cortar.
    const insertados = (cfg.insertar || []).map((t) => {
      const desde = tiempoASegundos(t.tramo[0], `insertar de la parte ${parte.id}`);
      const hasta = tiempoASegundos(t.tramo[1], `insertar de la parte ${parte.id}`);
      return { antes: tiempoASegundos(t.antes, `insertar de la parte ${parte.id}`), desde, hasta, tramo: CUT.extraerTramo(receta, desde, hasta) };
    });
    const recetaSinCortar = receta;

    // Saltos de imagen: si a los dos lados de un corte (o de la unión con la parte anterior) se ve a la
    // misma persona, se pone un momento la cámara del otro. Se hace en la receta sin cortar, en sincronía.
    const dc = config.disimularCortes || {};
    const fijos = (cfg.mantenerPlano || []).map((t) => [
      tiempoASegundos(t[0], `mantenerPlano de la parte ${parte.id}`), tiempoASegundos(t[1], `mantenerPlano de la parte ${parte.id}`)]);
    if (dc.activo !== false && (tramos.length || personaAntes)) {
      const d = CUT.disimularSaltos(receta, tramos, { segundos: dc.segundos, minimo: dc.minimo, fijos, personaAntes, fotogramas, vetos });
      receta = d.receta;
      if (d.disimulados || d.absorbidos) {
        console.log(`  saltos de imagen: ${d.disimulados} disimulado(s) con el plano del otro`
          + `${d.absorbidos ? `, ${d.absorbidos} plano(s) de un instante absorbido(s)` : ''}`);
      }
    }
    // Lo que se va a cortar, en frames de la receta sin cortar: una guía de algo que cae entero ahí no se pone.
    const cortesF = CUT.unirTramos(tramos.map((t) => ({ desde: Math.round((t.desde - origen) * fps), hasta: Math.round((t.hasta - origen) * fps) })));
    const seCorta = (a, b) => cortesF.some((x) => x.desde <= a && b <= x.hasta);
    // Plano doble en los intercambios rápidos: los dos a la vez, cada uno en su mitad (ver cortes.planoDoble).
    const pd = config.planoDoble || {};
    if (pd.activo !== false) {
      const d = CUT.planoDoble(receta, { ...pd, fijos, fotogramas, vetos });
      if (d.dobles.length) {
        const s = (f) => Math.round(f / fps);
        const guias = d.dobles.filter((x) => !seCorta(x.desde, x.hasta)).map((x) => ({ at: x.desde, name: `◫ plano doble (${s(x.hasta - x.desde)} s)`, color: 'Blue' }));
        receta = { ...d.receta, guides: [...(d.receta.guides || []), ...guias] };
        console.log(`  plano doble: ${d.dobles.length} intercambio(s) rápido(s), ${s(d.dobles.reduce((n, x) => n + x.hasta - x.desde, 0))} s en total`
          + ` (${d.dobles[0].izquierda} a la izquierda)`);
      }
    }
    // Una guía en cada empalme («✂ motivo (−4,2 s)»): se ven en Kdenlive y las usa el vídeo de revisión.
    if (tramos.length) receta = { ...receta, guides: [...(receta.guides || []), ...CUT.guiasDeCortes(receta, tramos)] };
    if (cubiertos.length) receta = { ...receta, guides: [...(receta.guides || []), ...CAM.guiasDeCamaras(cubiertos, fps, cortesF)] };

    const antes = CUT.duracionFrames(receta);
    if (tramos.length) {
      receta = CUT.aplicarCortes(receta, tramos);
      const quitado = (antes - CUT.duracionFrames(receta)) / Number(receta.project.fps);
      console.log(`  cortes: ${CUT.unirTramos(tramos).length} tramos, ${quitado.toFixed(1)} s menos`
        + ` (${(antes / receta.project.fps / 60).toFixed(1)} → ${(CUT.duracionFrames(receta) / receta.project.fps / 60).toFixed(1)} min)`);
      for (const t of CUT.unirTramos(tramos)) {
        console.log(`    ${segundosAReloj(t.desde)} → ${segundosAReloj(t.hasta)}`);
      }
    }
    for (const ins of insertados) {
      const pos = CUT.posicionTrasCortes(recetaSinCortar, tramos, ins.antes);
      receta = CUT.insertarTramo(receta, ins.tramo, pos, '');
      console.log(`  insertado: ${segundosAReloj(ins.desde)} → ${segundosAReloj(ins.hasta)} (${(ins.tramo.frames / Number(receta.project.fps)).toFixed(1)} s) antes de ${segundosAReloj(ins.antes)}`);
    }
    fs.writeFileSync(path.join(carpetaParte, 'multicam-cortado.json'), `${JSON.stringify(receta, null, 2)}\n`, 'utf8');
    recetas.push(receta);
    personaAntes = CUT.personaAlFinal(receta);
  }

  const nombre = path.basename(r.base);
  let unida = reanudar ? readJson(recetaUnida) : CUT.unirRecetas(recetas, nombre);
  for (const a of agregados) unida = CUT.agregarAlFinal(unida, [a.tramo], a.prefijo);
  // Rótulos con el nombre de cada uno, la primera vez que se le ve solo (si están los nombres: ver rotulos.js).
  const ro = config.rotulos || {};
  if (!reanudar && ro.activo !== false && ro.nombres && Object.keys(ro.nombres).length) {
    const fpsU = Number(unida.project.fps);
    const lista = [];
    for (const [persona, texto] of Object.entries(ro.nombres)) {
      const h = RO.hacerRotulo(String(texto), {
        dir: path.join(r.montaje, 'rotulos'), ancho: Number(unida.project.width), alto: Number(unida.project.height), fps: fpsU, segundos: ro.segundos || 4,
      });
      if (h.error) console.log(`aviso   no se pudo hacer el rótulo de ${persona}: ${h.error}`);
      else lista.push({ persona, archivo: h.archivo });
    }
    const c = RO.colocarRotulos(unida, lista, { segundos: ro.segundos || 4, desde: ro.desde ?? 3 });
    unida = c.receta;
    if (c.puestos.length) console.log(`rótulos: ${c.puestos.map((x) => `${ro.nombres[x.persona]} en ${segundosAReloj(x.at / fpsU)}`).join(' · ')}`);
    for (const p of c.sinSitio) console.log(`aviso   no hay un plano de ${p} solo de ${(ro.segundos || 4) + 1} s para su rótulo`);
  }
  if (!reanudar) fs.writeFileSync(recetaUnida, `${JSON.stringify(unida, null, 2)}\n`, 'utf8');
  const dur = CUT.duracionFrames(unida) / Number(unida.project.fps);
  console.log(`\nepisodio: ${partes.length} parte(s) unidas · ${(dur / 60).toFixed(1)} min · ${recetaUnida}`);

  /*
   * El proyecto de Kdenlive se vuelve a escribir desde la receta. Si se guardó en Kdenlive después
   * de generarlo (se retocó a mano), no se pisa sin más: esos cambios no están en la receta y el
   * render los ignoraría. Se elige: renderizar ese proyecto tal cual, o descartarlos.
   */
  const proyecto = path.join(r.montaje, 'episodio.kdenlive');
  const usarProyecto = Boolean(args.flags['usar-proyecto']);
  if (usarProyecto) {
    if (!exists(proyecto)) throw new Error('no hay montaje/episodio.kdenlive que renderizar: genera antes el montaje.');
    console.log('se renderiza montaje/episodio.kdenlive tal como quedó en Kdenlive, con sus cambios a mano');
  } else {
    if (proyectoEditado(r)) {
      if (!args.flags['descartar-cambios']) {
        console.error(`error: ${proyecto} tiene cambios hechos en Kdenlive (se guardó después de generarlo).`);
        console.error('  Si lo vuelvo a generar desde la receta, esos cambios se pierden. Elige:');
        console.error(`    node cli.js episodio "${r.base}" --reanudar --usar-proyecto     renderiza ESE proyecto, con tus cambios`);
        console.error(`    node cli.js episodio "${r.base}" --descartar-cambios            lo rehace desde la receta (guarda una copia)`);
        console.error('  Lo que quieras conservar para otras veces (cortes, planos fijos…) va en episodio.json.');
        AU.marcarFase(r, 'error', 'el proyecto tiene cambios hechos en Kdenlive');
        return 4;
      }
      const copia = `${proyecto}.editado-${Date.now()}`;
      fs.copyFileSync(proyecto, copia);
      console.log(`los cambios hechos en Kdenlive se descartan; copia en ${copia}`);
    }
    const b = cmdBuild({ ...args, _: [recetaUnida], flags: { ...args.flags, out: proyecto } });
    if (b !== 0) { AU.marcarFase(r, 'error', 'no se pudo generar el proyecto'); return b; }
    fs.writeFileSync(huellaProyectoFile(r), `${huellaArchivo(proyecto)}\n`, 'utf8');
  }
  if (args.flags['solo-montaje']) {
    AU.marcarFase(r, 'montaje-listo', `${(dur / 60).toFixed(1)} min`);
    AV.ponerResumen(`proyecto listo para revisar: ${(dur / 60).toFixed(1)} min (montaje/episodio.kdenlive)`);
    return 0;
  }

  const bruto = path.join(r.montaje, 'episodio-bruto.mp4');
  AU.marcarFase(r, 'renderizando', `${(dur / 60).toFixed(1)} min de vídeo`);
  const c = cmdRender({ ...args, _: [usarProyecto ? proyecto : recetaUnida], flags: { ...args.flags, out: bruto, crf: 14, hilos: (config.render || {}).hilos } });
  if (c !== 0) { AU.marcarFase(r, 'error', 'falló el render'); AV.ponerResumen('falló el render (mira la consola)'); return c; }
  // verificar compara la duración con la receta, salvo si se renderizó el proyecto retocado a mano.
  fs.writeFileSync(path.join(r.montaje, 'episodio-bruto.origen'), usarProyecto ? 'proyecto\n' : 'receta\n', 'utf8');
  if (args.flags['sin-acabado']) { AU.marcarFase(r, 'render-listo'); AV.ponerResumen('render en bruto listo (montaje/episodio-bruto.mp4)'); return 0; }

  const final = path.join(r.entrega, `${nombre}.mp4`);
  console.log('');
  AU.marcarFase(r, 'acabado', 'codificación final para YouTube');
  const a = EP.acabado(bruto, final, config);
  if (a.error) {
    console.error(`error en el acabado: ${a.error}`);
    AU.marcarFase(r, 'error', 'falló el acabado');
    AV.ponerResumen(`falló el acabado: ${a.error}`.slice(0, 200));
    return 1;
  }
  const p = M.hasFfprobe() ? M.probe(final, null) : null;
  console.log(`\nlisto para YouTube: ${final}${a.codificador ? ` (vídeo con ${a.codificador})` : ''}`);
  if (p) console.log(`  ${p.width}x${p.height} · ${p.seconds.toFixed(1)} s · ${(fs.statSync(final).size / 1048576).toFixed(0)} MB`);
  // Subtítulos, capítulos y descripción, si ya están las transcripciones (las hace `analizar`). No con el proyecto
  // retocado a mano: sus tiempos ya no son los de la receta, de la que sale el mapa del montaje.
  if (usarProyecto) {
    console.log('  YouTube: no se prepara solo (se renderizó el proyecto retocado en Kdenlive y sus tiempos no son los de la receta)');
  } else {
    try {
      const y = paqueteYoutube(r, config, { transcribirSiFalta: false });
      if (y) console.log(`  YouTube: ${y.subtitulos} subtítulos, ${y.capitulos.length} capítulos → entrega/youtube.md${y.faltan.length ? ` (falta ${y.faltan.length} cosa(s))` : ''}`);
    } catch (e) {
      console.log(`  aviso   lo de YouTube no se pudo preparar: ${e.message}`);
    }
  }
  // Comprobación automática del resultado (principio, final, sonido, duración)..
  if (!args.flags['sin-verificar']) {
    AU.marcarFase(r, 'verificando');
    const v = AU.verificar(r.base);
    console.log(`\nverificación:\n  ${v.lineas.join('\n  ')}`);
    AU.marcarFase(r, v.fallos ? 'listo-con-avisos' : 'listo', v.fallos ? `${v.fallos} comprobación(es) fallida(s)` : 'verificado');
    AV.ponerResumen(`listo para YouTube: ${path.basename(final)}${p ? ` · ${(p.seconds / 60).toFixed(1)} min` : ''} · `
      + `${v.fallos ? `${v.fallos} comprobación(es) con aviso: mira «estado»` : 'verificación ✔'}`);
    return v.fallos ? 3 : 0;
  }
  AU.marcarFase(r, 'listo');
  AV.ponerResumen(`listo para YouTube: ${path.basename(final)}`);
  return 0;
}


// ----------------------------------------------------------- analizar / aprobar / verificar / estado

/*
 * Trae a originales/ lo que grabó el Estudio. Por omisión lo coge de la carpeta de grabaciones
 * del propio Estudio, que está en este PC: cada sesión va a su subcarpeta con su session.json, y
 * el orden de las partes sale de la grabación (no del "(1)" del navegador). Con --descargas, o si
 * no está esa carpeta, lo busca en Descargas como antes. Sin --copiar ni --mover solo enseña qué
 * haría. Sin carpeta usa el episodio más reciente que tenga originales/ vacío.
 */
function cmdImportar(args) {
  let carpeta = args._[0];
  if (!carpeta) {
    let candidatos = [];
    try { candidatos = fs.readdirSync(EP.RAIZ_POR_DEFECTO).filter((n) => /^\d{4}-\d{2}-\d{2}/.test(n)).sort().reverse(); } catch { /* sin raíz */ }
    carpeta = candidatos.map((n) => path.join(EP.RAIZ_POR_DEFECTO, n)).find((d) => {
      try { return !fs.readdirSync(path.join(d, 'originales')).length; } catch { return false; }
    });
    if (!carpeta) throw new Error('no hay un episodio con originales/ vacío. Crea uno con: node cli.js episodio nuevo');
  }
  const r = EP.rutas(carpeta);
  if (!exists(r.originales)) throw new Error(`no existe ${r.originales}`);
  const horas = args.flags.horas ? Number(args.flags.horas) : 36;
  const accion = args.flags.mover ? 'mover' : (args.flags.copiar ? 'copiar' : null);
  const gb = (n) => (n / 1073741824).toFixed(2);

  const estudio = typeof args.flags.estudio === 'string' ? args.flags.estudio : EP.ESTUDIO_POR_DEFECTO;
  if (!args.flags.descargas && isDir(estudio)) {
    let sesiones = EP.descubrirSesionesEstudio(estudio, horas);
    if (typeof args.flags.sesiones === 'string') {
      const elegidas = args.flags.sesiones.split(',').map((s) => s.trim());
      sesiones = sesiones.filter((s) => elegidas.includes(s.id));
    }
    if (!sesiones.length) {
      console.log(`no hay sesiones del Estudio de las últimas ${horas} h en ${estudio} (--horas 72 mira más atrás).`);
      return 0;
    }
    console.log(`episodio: ${r.base}\n${sesiones.length} sesión(es) del Estudio en ${estudio}, de la más antigua a la más reciente:`);
    let sinTerminar = 0;
    sesiones.forEach((s, i) => {
      const meta = JSON.parse(fs.readFileSync(s.meta, 'utf8'));
      const min = meta.stopAt && meta.startAt ? (meta.stopAt - meta.startAt) / 60000 : null;
      const total = s.archivos.reduce((a, f) => a + f.bytes, 0);
      console.log(`  parte ${i + 1} · sesión ${s.id} (sala ${s.sala})${min !== null ? ` · ${min.toFixed(1)} min${min < 2 ? ' (¿una prueba?)' : ''}` : ' · sin parada registrada'} · ${gb(total)} GB`);
      for (const f of s.archivos) {
        if (!f.completa) sinTerminar += 1;
        console.log(`      ${f.nombre}${f.completa ? '' : '   <- SIN TERMINAR DE SUBIR'}`);
      }
    });
    if (sinTerminar) {
      console.log('\naviso   hay pistas sin terminar de subir. Si alguien sigue subiendo, espera a que su página ponga');
      console.log('        «✓ Guardado en el servidor» y vuelve a importar (lo que ya esté igual se salta).');
      console.log('        Si su página se cayó, se importa lo que llegó al servidor.');
    }
    if (sesiones.length > 1) console.log('\nCada sesión es una parte. Si alguna sobra (una prueba), elige con --sesiones <id>,<id>');
    if (!accion) {
      console.log('\nNo he copiado nada. Para traerlas a originales/: --copiar (o --mover para quitarlas del Estudio)');
      return 0;
    }
    for (const s of sesiones) {
      const res = EP.importarSesion(s, r.originales, { mover: accion === 'mover' });
      const cuenta = {};
      for (const h of res.hechos) cuenta[h.accion] = (cuenta[h.accion] || 0) + 1;
      console.log(`  ${s.id}: ${Object.entries(cuenta).map(([a, n]) => `${n} ${a}`).join(', ')} → ${res.destino}`);
    }
    console.log(`\nlisto en ${r.originales}`);
    return 0;
  }

  const origen = typeof args.flags.descargas === 'string' ? args.flags.descargas : EP.DESCARGAS_POR_DEFECTO;
  const archivos = EP.descubrirDescargas(origen, horas);
  if (!archivos.length) {
    console.log(`no hay archivos del Estudio recientes en ${origen}.`);
    return 0;
  }
  console.log(`episodio: ${r.base}\n${archivos.length} archivo(s) de ${origen}:`);
  for (const f of archivos) console.log(`  ${f.nombre}  (${gb(fs.statSync(f.ruta).size)} GB)`);
  if (!accion) {
    console.log('\nNo he movido nada. Para pasarlos a originales/ añade --mover (o --copiar)');
    return 0;
  }
  for (const f of archivos) {
    const destino = path.join(r.originales, f.nombre);
    if (exists(destino)) { console.log(`  ya existe, se salta: ${f.nombre}`); continue; }
    if (accion === 'copiar') { fs.copyFileSync(f.ruta, destino); continue; }
    try { fs.renameSync(f.ruta, destino); } catch (e) {
      if (e.code !== 'EXDEV') throw e;
      fs.copyFileSync(f.ruta, destino);
      fs.unlinkSync(f.ruta);
    }
  }
  console.log(`\n${accion === 'copiar' ? 'copiados' : 'movidos'} a ${r.originales}`);
  return 0;
}

function cmdAnalizar(args) {
  const carpeta = args._[0];
  if (!carpeta) { console.error('uso: node cli.js analizar <carpeta-del-episodio> [--sin-transcribir]'); return 2; }
  const res = AU.analizar(carpeta, args.flags);
  console.log(res.texto);
  const partes = Object.values(res.propuesta.partes);
  const n = (k) => partes.reduce((s, p) => s + ((p[k] || []).length), 0);
  AV.ponerResumen(`propuesta lista: ${n('marcas')} propuesta(s) de corte${n('momentos') ? `, ${n('momentos')} ★` : ''} (montaje/propuesta.md)`);
  return 0;
}

function cmdAprobar(args) {
  const [carpeta, ...ids] = args._;
  if (!carpeta || !ids.length) { console.error('uso: node cli.js aprobar <carpeta> 1.1 2.1 ...   (los números salen de analizar)'); return 2; }
  const r = AU.aprobar(carpeta, ids);
  console.log(r.hechos.map((h) => `  ${h}`).join('\n'));
  console.log(`guardado en ${r.destino}`);
  return 0;
}

function cmdVerificar(args) {
  const carpeta = args._[0];
  if (!carpeta) { console.error('uso: node cli.js verificar <carpeta-del-episodio>'); return 2; }
  const v = AU.verificar(carpeta);
  console.log(v.lineas.join('\n'));
  return v.fallos ? 3 : 0;
}

function cmdEstado(args) {
  const carpeta = args._[0];
  if (!carpeta) { console.error('uso: node cli.js estado <carpeta-del-episodio>'); return 2; }
  console.log(AU.estado(carpeta).texto);
  return 0;
}

// -------------------------------------------------------------------- transcribir

/*
 * Transcribe la llamada de cada parte de un episodio y deja el texto con tiempos en
 * montaje/transcripcion-parte-N.txt. Con eso se deciden cortes leyendo.
 */
function cmdTranscribir(args) {
  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js transcribir <carpeta-del-episodio> [--parte 1]');
    return 2;
  }
  const r = EP.rutas(carpeta);
  if (!exists(r.originales)) throw new Error(`no existe ${r.originales}`);
  const { config } = EP.cargarConfig(r.base);
  const faltan = TR.comprobar(TR.ajustes(config));
  if (faltan.length) throw new Error(`falta ${faltan.join(' y ')}. Se instala en D:/Datos/Herramientas/whisper.`);

  const partes = EP.agruparPartes(r.originales);
  for (const parte of partes) {
    if (args.flags.parte && String(args.flags.parte) !== parte.id) continue;
    const llamada = AU.llamadaDe(parte, r.montaje);
    if (!llamada) {
      console.log(`parte ${parte.id}: no hay archivo de llamada; se omite.`);
      continue;
    }
    const base = path.join(r.montaje, `transcripcion-parte-${parte.id}`);
    console.log(`parte ${parte.id}: transcribiendo ${path.basename(llamada)} ...`);
    const t0 = Date.now();
    const res = TR.transcribir(llamada, base, config);
    if (res.error) {
      console.error(`error: ${res.error}`);
      return 1;
    }
    console.log(`  ${res.segmentos.length} frases en ${((Date.now() - t0) / 60000).toFixed(1)} min → ${res.texto}`);
  }
  return 0;
}

// ----------------------------------------------------------------------- muestra

/*
 * Vídeo de muestra de un episodio ya montado: solo unos segundos alrededor de cada
 * empalme (donde se quitó algo) y de la unión entre partes, con el color de acabado
 * aplicado. Sirve para comprobar los cortes y el color sin renderizar el episodio entero.
 */
/*
 * Vídeo de revisión para el móvil: unos segundos alrededor de cada empalme (numerados, con su motivo y
 * una barra roja en el corte), el principio y el final, en 480p. Deja montaje/revision.mp4 y
 * montaje/revision.md. Los silencios recortados solo salen con --silencios. Ver revision.js.
 */
function cmdRevision(args) {
  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js revision <carpeta-del-episodio> [--silencios] [--antes 4] [--despues 4]');
    return 2;
  }
  const melt = buscarBinario('melt');
  if (!melt) throw new Error('no se encontró melt (viene con Kdenlive).');
  if (!which('ffmpeg')) throw new Error('hace falta ffmpeg.');
  const r = EP.rutas(carpeta);
  const recetaFile = path.join(r.montaje, 'episodio.json');
  if (!exists(recetaFile)) throw new Error('no hay montaje: ejecuta primero  node cli.js episodio <carpeta> --solo-montaje');
  const { config } = EP.cargarConfig(r.base);
  const receta = readJson(recetaFile);
  const fps = Number(receta.project.fps);
  const { byId, problems } = M.probeRecipe(receta, fps);
  if (problems.length) throw new Error(`no se pueden leer los archivos del montaje: ${problems.join('; ')}`);
  const num = (v, d) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  console.log('vídeo de revisión: un trozo por empalme, más el principio y el final');
  AU.marcarFase(r, 'revision', 'vídeo de revisión');
  const res = RV.hacerRevision(receta, {
    dir: path.join(r.montaje, 'revision'),
    salida: path.join(r.montaje, 'revision.mp4'),
    md: path.join(r.montaje, 'revision.md'),
    melt: M.comandoMelt(melt),
    media: byId,
    compositing: compositingThatLoads().service,
    docVersion: elegirFormato(args.flags['doc-version']).docVersion,
    filtrosVideo: EP.filtrosVideo(config),
    filtrosAudio: EP.filtrosAudio(config),
    silencios: Boolean(args.flags.silencios),
    antes: num(args.flags.antes, 4),
    despues: num(args.flags.despues, 4),
    episodio: path.basename(r.base),
    log: (t) => console.log(t),
  });
  if (res.error) {
    AU.marcarFase(r, 'error', 'falló el vídeo de revisión');
    throw new Error(res.error);
  }
  const mb = (fs.statSync(path.join(r.montaje, 'revision.mp4')).size / 1048576).toFixed(0);
  console.log(`
revisión lista: ${path.join(r.montaje, 'revision.mp4')} (${segundosAReloj(res.segundos)}, ${mb} MB, ${res.trozos} trozos`
    + `${res.rehechos < res.trozos ? `; ${res.trozos - res.rehechos} reutilizados` : ''})`);
  console.log(`lista: ${path.join(r.montaje, 'revision.md')}`);
  if (res.silenciosFuera) console.log(`(${res.silenciosFuera} silencios recortados no salen: --silencios para verlos)`);
  AU.marcarFase(r, 'revision-lista', `${res.trozos} trozos, ${mb} MB`);
  AV.ponerResumen(`revisión lista: ${res.trozos} trozos, ${segundosAReloj(res.segundos)} (montaje/revision.mp4)`);
  return 0;
}

/*
 * Lo de YouTube, con los tiempos del vídeo final: subtítulos (.srt), la transcripción del vídeo final, un
 * índice corto para elegir capítulos y la descripción (resumen, capítulos y el pie del equipo con los
 * enlaces). Hace falta el montaje (episodio --solo-montaje) y la transcripción de cada parte (si falta, la
 * hace). Los capítulos, el título y el resumen van en el episodio.json del episodio. Ver youtube.js.
 */
function cmdYoutube(args) {
  const carpeta = args._[0];
  if (!carpeta) { console.error('uso: node cli.js youtube <carpeta-del-episodio>'); return 2; }
  const r = EP.rutas(carpeta);
  const { config } = EP.cargarConfig(r.base);
  const y = paqueteYoutube(r, config, { transcribirSiFalta: true });
  console.log(`subtítulos: entrega/${y.nombre}.srt (${y.subtitulos})`);
  console.log(`capítulos: ${y.capitulos.length ? y.capitulos.map((c) => `${segundosAReloj(Math.floor(c.t))} ${c.titulo}`).join(' · ') : 'ninguno todavía'}`);
  for (const a of y.avisos) console.log(`  aviso   ${a}`);
  if (y.faltan.length) console.log(`falta: ${y.faltan.join('; ')}`);
  console.log(`listo: entrega/youtube.md (y transcripcion.txt, indice.md, ${y.nombre}.descripcion.txt)`);
  AV.ponerResumen(`YouTube: ${y.subtitulos} subtítulos, ${y.capitulos.length} capítulos${y.faltan.length ? ` · falta ${y.faltan.length} cosa(s)` : ''}`);
  return 0;
}

/*
 * Escribe en entrega/ lo de YouTube. Sin `transcribirSiFalta`, si a alguna parte le falta la
 * transcripción devuelve null (así `episodio` lo deja hecho solo cuando ya se transcribió con `analizar`).
 */
/*
 * El montaje final y lo que se dice en él, con los tiempos del vídeo final: { final, partes, mapa,
 * transcripciones, palabras }. Lo usan `youtube` y `shorts`. Sin `transcribirSiFalta`, si a alguna parte
 * le falta la transcripción devuelve null.
 */
function textoDelMontaje(r, config, { transcribirSiFalta }) {
  const finalFile = path.join(r.montaje, 'episodio.json');
  if (!exists(finalFile)) throw new Error('no hay montaje: ejecuta primero  node cli.js episodio <carpeta> --solo-montaje');
  const final = readJson(finalFile);
  const partes = EP.agruparPartes(r.originales);
  const recetas = [];
  const transcripciones = [];
  for (const parte of partes) {
    const multicam = path.join(r.montaje, `parte-${parte.id}`, 'multicam.json');
    if (!exists(multicam)) throw new Error(`falta ${multicam}: vuelve a montar con  node cli.js episodio <carpeta> --solo-montaje`);
    recetas.push({ indice: Number(parte.id), receta: readJson(multicam) });
    const base = path.join(r.montaje, `transcripcion-parte-${parte.id}`);
    if (!exists(`${base}.json`)) {
      if (!transcribirSiFalta) return null;
      console.log(`parte ${parte.id}: transcribiendo (≈10 min por hora de audio)…`);
      AU.marcarFase(r, `transcribiendo-parte-${parte.id}`);
      const t = TR.transcribir(AU.llamadaDe(parte, r.montaje), base, config);
      if (t.error) throw new Error(`no se pudo transcribir la parte ${parte.id}: ${t.error}`);
    }
    transcripciones.push({ indice: Number(parte.id), palabras: YT.palabrasConPuntuacion(`${base}.json`) });
  }
  const mapa = YT.mapaDelMontaje(final, recetas);
  const palabras = YT.palabrasFinales(mapa, transcripciones);
  if (!palabras.length) throw new Error('la transcripción no tiene nada dentro del montaje');
  return { final, partes, mapa, transcripciones, palabras };
}

function paqueteYoutube(r, config, { transcribirSiFalta }) {
  const texto0 = textoDelMontaje(r, config, { transcribirSiFalta });
  if (!texto0) return null;
  const { mapa, transcripciones, palabras } = texto0;
  const nombre = path.basename(r.base);
  fs.mkdirSync(r.entrega, { recursive: true });
  const cues = YT.subtitulos(palabras);
  fs.writeFileSync(path.join(r.entrega, `${nombre}.srt`), YT.aSrt(cues), 'utf8');
  fs.writeFileSync(path.join(r.entrega, 'transcripcion.txt'), `${YT.frasesConTiempo(palabras).join('\n')}\n`, 'utf8');
  fs.writeFileSync(path.join(r.entrega, 'indice.md'), [
    `# Índice · ${nombre} (cada 2 min del vídeo final)`, '',
    'Para elegir capítulos: cómo empieza cada tramo y sus palabras más repetidas. La frase exacta, en `entrega/transcripcion.txt`.', '',
    ...YT.indice(palabras).map((l) => `- ${l}`), '',
  ].join('\n'), 'utf8');

  const cap = YT.resolverCapitulos(config.capitulos, { mapa, transcripciones });
  const yt = config.youtube || {};
  const texto = YT.descripcion({ resumen: config.resumen, capitulos: cap.capitulos, pie: yt.pie });
  fs.writeFileSync(path.join(r.entrega, `${nombre}.descripcion.txt`), `${texto}\n`, 'utf8');
  const faltan = [
    !config.titulo && 'el título («titulo» en el episodio.json del episodio)',
    !config.resumen && 'el resumen («resumen»)',
    !cap.capitulos.length && 'los capítulos («capitulos», por frase: ver entrega/indice.md)',
    !yt.pie && 'el pie con los enlaces («youtube.pie» en el episodio.json del equipo)',
  ].filter(Boolean);
  fs.writeFileSync(path.join(r.entrega, 'youtube.md'), [
    `# YouTube · ${nombre}`, '',
    '## Título', config.titulo ? String(config.titulo) : '(falta)', '',
    '## Descripción (copiar tal cual; también en ' + `\`${nombre}.descripcion.txt\`)`, '', '```', texto || '(vacía)', '```', '',
    ...(Array.isArray(yt.etiquetas) && yt.etiquetas.length ? ['## Etiquetas', yt.etiquetas.join(', '), ''] : []),
    '## Archivos',
    `- Vídeo: \`entrega/${nombre}.mp4\``,
    `- Subtítulos: \`entrega/${nombre}.srt\` (YouTube Studio → Subtítulos → Añadir idioma: español → Subir archivo → «Con tiempos»)`,
    '',
    ...(faltan.length || cap.avisos.length ? ['## Pendiente', ...faltan.map((f) => `- Falta ${f}`), ...cap.avisos.map((a) => `- ${a}`), ''] : []),
  ].join('\n'), 'utf8');
  return { nombre, subtitulos: cues.length, capitulos: cap.capitulos, avisos: cap.avisos, faltan };
}

/*
 * Shorts verticales (9:16) con subtítulos, sacados del montaje final: uno por cada ★ marcada al grabar
 * (con lo de antes de la marca, que es cuando pasó lo bueno), o los que diga «shorts» en el episodio.json
 * del episodio. Quedan en entrega/shorts/ con una lista (shorts.md). Ver shorts.js.
 */
function cmdShorts(args) {
  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js shorts <carpeta-del-episodio> [--antes 40] [--despues 8]');
    return 2;
  }
  const melt = buscarBinario('melt');
  if (!melt) throw new Error('no se encontró melt (viene con Kdenlive).');
  if (!which('ffmpeg')) throw new Error('hace falta ffmpeg.');
  const r = EP.rutas(carpeta);
  const { config } = EP.cargarConfig(r.base);
  const { final, partes, mapa, palabras } = textoDelMontaje(r, config, { transcribirSiFalta: true });
  const fps = Number(final.project.fps);
  const total = CUT.duracionFrames(final) / fps;
  const momentos = [];
  for (const parte of partes) {
    for (const m of AU.marcasEnVivo(parte, r.montaje)) {
      if (m.tipo !== 'bueno') continue;
      const t = YT.aFinal(mapa, Number(parte.id), m.desde)[0];
      if (t !== undefined) momentos.push({ t, nombre: m.nombre });
    }
  }
  const num = (v, d) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : d);
  const { rangos, avisos } = SH.rangosDeShorts({
    entradas: config.shorts, momentos: momentos.sort((a, b) => a.t - b.t), palabras, total,
    antes: num(args.flags.antes, 40), despues: num(args.flags.despues, 8),
  });
  for (const a of avisos) console.log(`aviso   ${a}`);
  if (!rangos.length) {
    console.log('no hay shorts que hacer: no se marcó ningún ★ al grabar y no hay «shorts» en el episodio.json del episodio.');
    console.log('  p. ej.  "shorts": [{ "desde": "12:30", "hasta": "13:20" }, { "frase": "lo de Japón fue", "segundos": 45 }]');
    return 0;
  }
  const { byId, problems } = M.probeRecipe(final, fps);
  if (problems.length) throw new Error(`no se pueden leer los archivos del montaje: ${problems.join('; ')}`);
  const nombre = path.basename(r.base);
  const lista = [];
  const compositing = compositingThatLoads().service;
  const docVersion = elegirFormato(args.flags['doc-version']).docVersion;
  AU.marcarFase(r, 'shorts', `${rangos.length} short(s)`);
  for (const [i, x] of rangos.entries()) {
    const salida = path.join(r.entrega, 'shorts', `${nombre}-short-${i + 1}.mp4`);
    console.log(`short ${i + 1}: ${segundosAReloj(x.desde)} → ${segundosAReloj(x.hasta)} (${(x.hasta - x.desde).toFixed(0)} s) · ${x.motivo}`);
    const res = SH.hacerShort({
      final, media: byId, desde: x.desde, hasta: x.hasta, palabras, dir: path.join(r.montaje, 'shorts'), salida,
      melt: M.comandoMelt(melt), compositing, docVersion,
    });
    if (res.error) { console.error(`  error: ${res.error}`); continue; }
    const inicio = palabras.filter((p) => p.ini >= x.desde && p.ini < x.hasta).slice(0, 14).map((p) => p.w).join(' ');
    lista.push(`| ${i + 1} | ${segundosAReloj(x.desde)} → ${segundosAReloj(x.hasta)} | ${res.segundos} s | ${x.motivo} | «${inicio}…» | \`${path.basename(salida)}\` |`);
    console.log(`  listo: ${salida} (${res.subtitulos} subtítulos)`);
  }
  fs.mkdirSync(path.join(r.entrega, 'shorts'), { recursive: true });
  fs.writeFileSync(path.join(r.entrega, 'shorts', 'shorts.md'), [
    `# Shorts · ${nombre}`, '', 'Verticales (1080x1920) con subtítulos. Para subirlos: YouTube Studio → Crear → Subir vídeos (al durar 60 s o menos y ser verticales, YouTube los trata como Shorts).', '',
    '| # | En el vídeo final | Dura | De dónde | Empieza | Archivo |', '|---|---|---|---|---|---|', ...lista, '',
  ].join('\n'), 'utf8');
  AU.marcarFase(r, 'shorts-listos', `${lista.length} short(s)`);
  AV.ponerResumen(`shorts: ${lista.length} de ${rangos.length} listos (entrega/shorts/)`);
  return lista.length === rangos.length ? 0 : 1;
}

/*
 * Libera disco cuando el episodio ya está hecho: borra lo que se puede volver a generar (render en bruto,
 * revisión, intermedios) y, con --estudio, las grabaciones del Estudio ya copiadas en originales/. Sin
 * --confirmar solo dice qué borraría. Ver limpieza.js.
 */
function cmdLimpiar(args) {
  const carpeta = args._[0];
  if (!carpeta) {
    console.error('uso: node cli.js limpiar <carpeta-del-episodio> [--estudio [carpeta]] [--confirmar] [--forzar]');
    return 2;
  }
  const r = EP.rutas(carpeta);
  if (!exists(r.montaje)) throw new Error(`no existe ${r.montaje}`);
  const e = AU.estado(r.base);
  if (!['listo', 'listo-con-avisos'].includes(e.fase) && !args.flags.forzar) {
    console.error(`el episodio no está listo (fase: ${e.fase || 'ninguna'}): lo que se borra aún puede hacer falta.`);
    console.error('  Cuando esté publicado, vuelve a ejecutarlo; o añade --forzar si sabes lo que haces.');
    return 3;
  }
  const estudio = args.flags.estudio ? (typeof args.flags.estudio === 'string' ? args.flags.estudio : EP.ESTUDIO_POR_DEFECTO) : null;
  const cosas = LI.queBorrar(r, { estudio });
  const gb = (n) => `${(n / 1073741824).toFixed(2)} GB`;
  if (!cosas.length) { console.log('no hay nada que limpiar.'); return 0; }
  for (const c of cosas) console.log(`  ${gb(c.bytes).padStart(9)}  ${path.relative(path.dirname(r.base), c.ruta) || c.ruta}  · ${c.motivo}`);
  const total = cosas.reduce((n, c) => n + c.bytes, 0);
  if (!args.flags.confirmar) {
    console.log(`
se liberarían ${gb(total)}. No he borrado nada: añade --confirmar para borrarlo.`);
    if (!estudio) console.log('(con --estudio, también las grabaciones del Estudio que ya están copiadas en originales/)');
    return 0;
  }
  const b = LI.borrar(cosas);
  for (const x of b.errores) console.error(`  no se pudo borrar ${x}`);
  console.log(`
liberados ${gb(b.bytes)}`);
  return b.errores.length ? 1 : 0;
}

/* `muestra` era la versión anterior de `revision`. */
function cmdMuestra(args) {
  console.log('(muestra ahora se llama revision)\n');
  return cmdRevision(args);
}

// ------------------------------------------------------------------- selftest

/*
 * Genera un proyecto de prueba con material propio para comprobar, en el Kdenlive de
 * quien lo ejecuta, que el archivo abre bien y que se ve lo que debe verse. Es la
 * única comprobación que no se puede hacer desde aquí, así que se deja preparada.
 */
function cmdSelftest(args) {
  const dir = path.resolve(String(args.flags.dir || 'prueba-kdenlive'));
  fs.mkdirSync(dir, { recursive: true });

  let clips = [];
  if (args.flags.media) {
    clips = String(args.flags.media).split(',').map((f) => path.resolve(f.trim()));
    for (const c of clips) {
      if (!exists(c)) throw new Error(`no existe ${c}`);
    }
  } else {
    if (!which('ffmpeg')) {
      throw new Error('hace falta ffmpeg para generar los clips de prueba.\n' +
        '  Alternativa: node cli.js selftest --media video1.mp4,video2.mp4');
    }
    const patrones = [['a.mp4', 'testsrc', 440], ['b.mp4', 'smptebars', 880]];
    for (const [nombre, patron, hz] of patrones) {
      const destino = path.join(dir, nombre);
      const res = spawnSync('ffmpeg', ['-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `${patron}=size=1280x720:rate=25:duration=5`,
        '-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=5`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', destino],
        { encoding: 'utf8', timeout: 180000 });
      if (res.status !== 0) throw new Error(`ffmpeg falló generando ${nombre}: ${res.stderr}`);
      clips.push(destino);
    }
    console.log(`clips de prueba generados en ${dir}`);
  }

  // La receta se ajusta al material: con --media los clips son los del usuario y
  // pueden ser cortos, así que las duraciones se calculan, no se fijan.
  const primero = M.probe(clips[0], null);
  const fps = Math.round(primero.fps || 25) || 25;
  const leidos = clips.map((c) => M.probe(c, fps));
  for (let i = 0; i < leidos.length; i += 1) {
    if (leidos[i].missing || leidos[i].probeFailed) {
      throw new Error(`no se pudo leer ${clips[i]}: ${leidos[i].probeFailed || 'no existe'}`);
    }
  }

  const disponible = Math.min(...leidos.map((c) => c.frames || 0));
  if (!disponible || disponible < fps * 2) {
    throw new Error('los clips son demasiado cortos para la prueba: hacen falta al menos 2 ' +
      'segundos de cada uno.');
  }

  // Cada corte usa como mucho la mitad del clip, entre 1 y 3 segundos.
  const corte = Math.max(fps, Math.min(Math.floor(disponible / 2), fps * 3));
  const solape = Math.max(4, Math.floor(corte / 4));
  const fundido = Math.max(4, Math.floor(corte / 4));

  const recipe = {
    project: {
      name: 'Prueba claude',
      fps,
      width: primero.width || 1280,
      height: primero.height || 720,
    },
    bin: 'Prueba',
    media: [{ id: 'a', path: clips[0] }, { id: 'b', path: clips[1] }],
    timeline: { name: 'Prueba' },
    edit: [
      { clip: 'a', in: 0, duration: corte, fadeIn: fundido },
      { clip: 'b', in: 0, duration: corte, dissolve: solape },
      // El tercero sale del final del clip, para que se note que no es el mismo trozo.
      { clip: 'a', in: disponible - corte, duration: corte, dissolve: solape, zoom: 1.4, fadeOut: fundido },
    ],
    guides: [{ at: corte, name: 'el primer encadenado', color: 'Red' }],
  };

  const recetaFile = path.join(dir, 'prueba.json');
  fs.writeFileSync(recetaFile, `${JSON.stringify(recipe, null, 2)}\n`, 'utf8');

  const { built } = buildFromRecipe(recipe, args, recetaFile);
  const proyecto = path.join(dir, 'prueba.kdenlive');
  fs.writeFileSync(proyecto, built.xml, 'utf8');

  const s = built.summary;
  console.log('');
  console.log(`proyecto de prueba: ${proyecto}`);
  console.log(`  ${s.width}x${s.height} @ ${s.fps} fps · ${s.cuts} cortes · ${s.duration}`);
  console.log('');
  console.log('Ábrelo con Kdenlive y comprueba estas cinco cosas:');
  console.log('  1. Abre sin avisos de versión ni de archivos que faltan.');
  console.log('  2. En la timeline hay 3 clips seguidos en V1 (y su audio en A1).');
  console.log(`  3. La duración total es ${s.duration} (los encadenados se solapan).`);
  console.log('  4. El primero entra desde negro y el último sale a negro.');
  console.log('  5. Entre clip y clip hay un encadenado, no un corte seco,');
  console.log('     y el tercero se ve más ampliado que los otros.');
  console.log('');
  console.log('Si algo no cuadra, dime qué y lo ajusto.');

  if (args.flags.render) {
    return cmdRender({ ...args, _: [recetaFile], flags: { ...args.flags, out: path.join(dir, 'prueba.mp4') } });
  }
  console.log('Para ver también el vídeo ya montado: añade --render');
  return 0;
}

// --------------------------------------------------------------------- doctor

function cmdDoctor() {
  console.log('edición del podcast · diagnóstico\n');
  console.log(`sistema: ${process.platform} (${os.release()})`);
  console.log(`node: ${process.version}\n`);

  const tools = [
    ['ffprobe', 'leer duración, fps y audio de tus clips'],
    ['ffmpeg', 'no imprescindible, útil para pruebas'],
    ['melt', 'renderizar sin abrir Kdenlive'],
    ['kdenlive', 'el programa (no hace falta para generar el proyecto)'],
  ];
  for (const [bin, why] of tools) {
    const enPath = which(bin);
    const ruta = enPath ? bin : buscarBinario(bin);
    const detalle = enPath || (ruta ? `encontrado en ${ruta}` : '(no encontrado)');
    console.log(`  [${ruta ? 'x' : ' '}] ${bin.padEnd(9)} ${detalle}`);
    console.log(`      ${why}`);
  }

  console.log('');
  const version = kdenliveVersion();
  if (version) {
    const docVersion = P.generationFor(version);
    console.log(`Kdenlive ${version.join('.')} · se escribirá el formato de documento ${docVersion}`);
    if (docVersion === '1.04') {
      console.log('  (tu versión es anterior a 23.04, que es cuando cambió el formato;');
      console.log('   se usa el anterior, que tu Kdenlive abre sin problema)');
    }
  } else {
    console.log(`Kdenlive: no se pudo saber la versión · se escribirá el formato ${P.DOC_VERSION}`);
    console.log('  No se encontró el ejecutable (pasa con Flatpak, Snap o una instalación');
    console.log('  en otra carpeta). Mira la versión en Ayuda > Acerca de Kdenlive; si es');
    console.log('  anterior a 23.04, añade --doc-version 1.04 al generar.');
  }

  console.log('');
  if (buscarBinario('melt')) {
    const c = compositingThatLoads();
    console.log(`composición entre pistas: ${c.service}${c.noneLoaded ? ' (ninguna carga aquí)' : ''}`);
    if (c.service !== P.COMPOSITING[0]) {
      console.log(`  nota: Kdenlive usa ${P.COMPOSITING[0]}; tu MLT no lo carga, así que al`);
      console.log(`  renderizar desde aquí se usa ${c.service}. El proyecto para Kdenlive`);
      console.log(`  se sigue generando con ${P.COMPOSITING[0]}, que es lo correcto.`);
    }
  } else {
    console.log('composición entre pistas: no comprobable sin melt');
  }

  console.log('\nrecetas de ejemplo:');
  const dir = path.join(__dirname, 'recipes');
  if (exists(dir)) {
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      console.log(`  recipes/${f}`);
    }
  }
  console.log('\nsiguiente paso:  node cli.js build recipes/<receta>.json');
  return 0;
}

function cmdValidate(args) {
  const file = args._[0];
  if (!file) {
    console.error('uso: node cli.js validate <receta.json>');
    return 2;
  }
  const recipe = readJson(file);
  const { errors, warnings } = R.validate(recipe);
  console.log(`receta: ${file}`);
  for (const w of warnings) console.log(`  aviso   ${w}`);
  for (const e of errors) console.log(`  ERROR   ${e}`);
  if (!errors.length && !warnings.length) console.log('  todo correcto');
  return errors.length ? 1 : 0;
}

function usage() {
  console.log(`edición del podcast · proyectos de Kdenlive desde una receta, y el episodio entero

  node cli.js doctor                   qué hay instalado
  node cli.js validate <receta.json>   revisa la receta
  node cli.js build <receta.json>      escribe el .kdenlive
  node cli.js render <receta.json>     renderiza a vídeo con melt
  node cli.js selftest                 proyecto de prueba para comprobar tu Kdenlive
  node cli.js multicam <archivos...>   monta una conversación a varias cámaras
  node cli.js ajustar-audio <receta>   mueve el audio sin repetir el análisis
  node cli.js calibrar <camaras...>    mide el retardo imagen-sonido (claqueta o palmada)
  node cli.js revision <carpeta>       vídeo corto (480p) con cada empalme numerado, para revisar desde el móvil
  node cli.js youtube <carpeta>        subtítulos .srt, capítulos y descripción con los tiempos del vídeo final
  node cli.js shorts <carpeta>         shorts verticales con subtítulos, de los ★ marcados al grabar (o de «shorts»)
  node cli.js limpiar <carpeta>        libera disco cuando el episodio está hecho (sin --confirmar solo lo enseña)
  node cli.js importar [<carpeta>]     trae las sesiones del Estudio a originales/ (--copiar o --mover;
                                       --descargas para cogerlas de Descargas, --sesiones id,id para elegir)
  node cli.js config <carpeta>         configuración efectiva del episodio y de dónde sale (--tomar-de-raiz)
  node cli.js analizar <carpeta>       propuesta: inicio/fin, silencios y marcas de charla técnica
  node cli.js aprobar <carpeta> 1.1    pasa propuestas a episodio.json (cortes ajustados al silencio)
  node cli.js verificar <carpeta>      comprueba el vídeo final (duración, sonido, principio y final)
  node cli.js estado <carpeta>         en qué fase va el proceso, en una línea
  node cli.js transcribir <carpeta>    transcribe la llamada de cada parte (para decidir cortes)
  node cli.js episodio nuevo <raiz>    crea la carpeta del episodio de hoy
  node cli.js episodio <carpeta>       monta, renderiza y deja el vídeo listo para YouTube

opciones:
  --out <archivo>          destino (por defecto, junto a la receta)
  --doc-version 1.1|1.04   formato; por omisión, el que acepte tu Kdenlive
  --compositing <servicio> qtblend (por defecto), frei0r.cairoblend o composite
  --root <carpeta>         atributo root del proyecto
  --dir <carpeta>          (selftest) dónde dejar la prueba
  --media a.mp4,b.mp4      (selftest) usar tus clips en vez de generarlos
  --render                 renderizar también el vídeo
  --ref <archivo>          (multicam) referencia de sincronía; por omisión, la llamada
  --min-shot <segundos>    (multicam) duración mínima de cada plano (2 por omisión)
  --name <nombre>          (multicam) nombre del proyecto
  --analyze <segundos>     (multicam) analizar solo los primeros segundos
  --desde <tiempo>         (multicam) empezar ahí: segundos, "1:30" o "00:01:30"
  --hasta <tiempo>         (multicam) terminar ahí (para quitar el pitido del final)
  --audio-offset <ms>      (multicam) adelantar(-) o atrasar(+) el audio a mano.
                           Un número vale para todos; "jc=-140,dj=0" va por persona
  --ms <n>                 (ajustar-audio) lo mismo, sobre una receta ya hecha
  --probar "0,-33,-66"     (ajustar-audio) genera una versión por cada valor
  --persona <id>           (ajustar-audio) mover solo el audio de esa persona
  --ventana <segundos>     (calibrar) dónde buscar la marca (25 por omisión)
  --modo claqueta|golpe    (calibrar) forzar el tipo de marca
  --radio <segundos>       (calibrar) cuánto mirar a cada lado del pitido (0.3)
  --audio off              (multicam) no igualar el nivel de los micrófonos
  --lufs <valor>           (multicam) nivel objetivo (-16 por omisión)
  --color off              (multicam) no emparejar el color de las cámaras
  --saturacion <x>         (multicam) saturación, 1 = sin tocar (prueba 1.1)
  --contraste <x>          (multicam) contraste, 1 = sin tocar (prueba 1.05)

ejemplo:
  node cli.js build recipes/ejemplo-vertical.json
  node cli.js render recipes/ejemplo-vertical.json --out /tmp/prueba.mp4
`);
}

function main(argv) {
  const args = parseArgs(argv.slice(2));
  const cmd = args._.shift();
  const commands = {
    doctor: cmdDoctor,
    validate: cmdValidate,
    build: cmdBuild,
    render: cmdRender,
    selftest: cmdSelftest,
    multicam: cmdMulticam,
    'ajustar-audio': cmdAjustarAudio,
    calibrar: cmdCalibrar,
    episodio: cmdEpisodio,
    transcribir: cmdTranscribir,
    importar: cmdImportar,
    analizar: cmdAnalizar,
    aprobar: cmdAprobar,
    verificar: cmdVerificar,
    estado: cmdEstado,
    muestra: cmdMuestra,
    revision: cmdRevision,
    youtube: cmdYoutube,
    shorts: cmdShorts,
    limpiar: cmdLimpiar,
    config: cmdConfig,
  };

  if (!cmd || cmd === 'help' || args.flags.help) {
    usage();
    return cmd ? 0 : 2;
  }
  if (!commands[cmd]) {
    console.error(`comando desconocido: ${cmd}\n`);
    usage();
    return 2;
  }
  // Lo que puede tardar mucho: el PC no se duerme mientras corre y, si tardó, se avisa al terminar.
  const largo = COMANDOS_LARGOS.has(cmd) && args._[0] !== 'nuevo';
  const soltar = largo ? AV.mantenerDespierto() : null;
  const inicio = Date.now();
  let codigo;
  let fallo = null;
  try {
    codigo = commands[cmd](args);
  } catch (e) {
    console.error(`error: ${e.message}`);
    fallo = e;
    codigo = 1;
  }
  if (soltar) soltar();
  if (largo) avisarAlTerminar(cmd, args, codigo, fallo, (Date.now() - inicio) / 1000);
  else AV.tomarResumen();
  return codigo;
}

const COMANDOS_LARGOS = new Set(['episodio', 'analizar', 'transcribir', 'render', 'revision', 'muestra', 'youtube', 'shorts']);

/*
 * Aviso al terminar un comando largo: en Windows y, si el episodio.json del equipo tiene un tema de ntfy,
 * en el móvil. Dice el episodio, cómo acabó y lo que dejó el comando (AV.ponerResumen).
 */
function avisarAlTerminar(cmd, args, codigo, fallo, segundos) {
  const resumen = AV.tomarResumen();
  let config = EP.CONFIG_POR_DEFECTO;
  let nombre = '';
  try {
    if (cmd !== 'render' && args._[0]) {
      const r = EP.rutas(args._[0]);
      config = EP.cargarConfig(r.base).config;
      nombre = path.basename(r.base);
    }
  } catch { /* sin configuración: solo el aviso de Windows */ }
  if (!AV.debeAvisar(segundos, config)) return;
  const estado = codigo === 0 ? 'terminado' : (codigo === 3 ? 'terminado con avisos' : 'falló');
  const texto = (fallo && fallo.message) || resumen || (codigo === 0 ? 'listo' : `código ${codigo}: mira la consola`);
  AV.avisar(config, `${nombre ? `${nombre} · ` : ''}${cmd} ${estado}`, `${texto} (${AV.duracionLegible(segundos)})`, { error: codigo !== 0 });
}

if (require.main === module) {
  const codigo = main(process.argv);
  // Se da un momento a que salga el aviso al móvil antes de cerrar.
  AV.esperarAvisos().then(() => process.exit(codigo));
}

module.exports = {
  main,
  parseArgs,
  compositingThatLoads,
  which,
  explainRenderLog,
  kdenliveVersion,
  tiempoASegundos,
  expandirArchivos,
  ajustesPorPersona,
  buscarBinario,
  carpetasDeKdenlive,
  cmdMulticam,
  cmdAjustarAudio,
  cmdCalibrar,
  elegirFormato,
  ventanasDeLimpieza,
};
