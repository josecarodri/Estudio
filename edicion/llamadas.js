/*
 * La llamada partida.
 *
 * La grabación de la llamada la hace la página que la tiene activada (la del PC de JC, el
 * anfitrión). Si esa página se cae y se retoma, la llamada queda en dos archivos (jc_llamada y
 * jc-2_llamada) con un hueco en medio. Todo lo que usa la llamada como reloj —la sincronía de las
 * cámaras, los pitidos, los silencios, la transcripción y los cortes por texto— necesita UNA sola,
 * así que se unen en un WAV: cada tramo en su sitio y silencio en el hueco.
 *
 * El sitio de cada tramo se mide contra la grabación continua de la otra persona (su micro o su
 * cámara): su voz está en ella y también en la llamada. Si esa medida no es fiable y está el
 * session.json del Estudio, se usa la hora a la que empezó cada pista.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SY = require('./sync.js');
const MC = require('./multicam.js');
const M = require('./media.js');

const CONFIANZA_MINIMA = 5;

/*
 * Los tramos de llamada de una parte, en orden. Si dos personas grabaron la llamada, son dos
 * copias de lo mismo: se usa la que esté entera (menos tramos) y la otra se ignora.
 */
function tramosDeLlamada(archivos) {
  const { llamadas, people } = MC.inferRoles(archivos);
  if (!llamadas.length) return { tramos: [], ignoradas: [], persona: null, people };
  const grupos = new Map();
  for (const l of llamadas) {
    if (!grupos.has(l.base)) grupos.set(l.base, []);
    grupos.get(l.base).push(l);
  }
  const elegido = [...grupos.values()].sort((a, b) => a.length - b.length || a[0].base.localeCompare(b[0].base))[0];
  return {
    tramos: elegido.map((l) => l.file),
    ignoradas: llamadas.filter((l) => !elegido.includes(l)).map((l) => l.file),
    persona: elegido[0].base,
    people,
  };
}

/*
 * Contra qué situar los tramos: las grabaciones de otra persona (su micro y su cámara), de la
 * más larga a la más corta. Con la página de esa persona entera, cubren la sesión de principio a
 * fin; se prueban todas y se usa la que dé la medida más fiable.
 */
function anclasPara(people, personaLlamada) {
  const candidatos = [];
  for (const p of people.values()) {
    if (MC.personaBase(p.id) === personaLlamada) continue;
    for (const f of [p.mic, p.cam].filter(Boolean)) {
      const info = M.probe(f, null);
      if (info.hasAudio && info.seconds) candidatos.push({ archivo: f, segundos: info.seconds, esMicro: f === p.mic });
    }
  }
  candidatos.sort((a, b) => b.segundos - a.segundos || Number(b.esMicro) - Number(a.esMicro));
  return candidatos.map((c) => c.archivo);
}

/* Hora de inicio de cada pista según el session.json del Estudio (ms del reloj común), por nombre de archivo. */
function iniciosDeSesion(sesionJson) {
  try {
    const s = JSON.parse(fs.readFileSync(sesionJson, 'utf8'));
    const out = {};
    for (const t of Object.values(s.tracks || {})) if (t && t.file && Number.isFinite(t.startedAtServer)) out[t.file] = t.startedAtServer;
    return out;
  } catch {
    return {};
  }
}

function huella(archivos) {
  const datos = archivos.filter(Boolean).map((f) => { const s = fs.statSync(f); return [path.resolve(f), s.size, Math.round(s.mtimeMs)]; });
  return crypto.createHash('sha1').update(JSON.stringify({ datos, v: 1 })).digest('hex').slice(0, 16);
}

/*
 * Une los tramos en un WAV (16 kHz, mono: solo sirve de reloj y para analizar), cada uno
 * retrasado lo que le toca. El reloj del resultado es el del primer tramo.
 */
function escribirUnida(tramos, inicios, destino) {
  const filtros = tramos.map((_, i) => `[${i}:a]aresample=16000,aformat=sample_fmts=s16:channel_layouts=mono,adelay=${Math.round(inicios[i] * 1000)}:all=1[a${i}]`);
  const mezcla = `${tramos.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tramos.length}:duration=longest:normalize=0[o]`;
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', ...tramos.flatMap((t) => ['-i', t]),
    '-filter_complex', `${filtros.join(';')};${mezcla}`, '-map', '[o]', '-c:a', 'pcm_s16le', destino],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (res.status !== 0) return (res.stderr || (res.error && res.error.message) || 'ffmpeg falló').trim().split('\n').slice(-3).join(' ');
  return null;
}

/**
 * La llamada de una parte para usar como reloj. Con un solo tramo es ese archivo, tal cual. Si
 * la llamada quedó partida, se unen los tramos en `carpeta/llamada-unida.wav` (la primera vez; luego
 * se reutiliza mientras no cambien los archivos).
 *
 * opciones: { sesion: ruta del session.json del Estudio (opcional), log: función para contarlo }
 * Devuelve { archivo, unida, tramos: [{ archivo, desde }], ignoradas, fuente } o { error }.
 */
function llamadaParaReloj(archivos, carpeta, opciones) {
  const o = opciones || {};
  const log = o.log || (() => {});
  const { tramos, ignoradas, persona, people } = tramosDeLlamada(archivos);
  if (!tramos.length) return { archivo: null, unida: false, tramos: [], ignoradas };
  if (tramos.length === 1) return { archivo: tramos[0], unida: false, tramos: [{ archivo: tramos[0], desde: 0 }], ignoradas };

  const anclas = anclasPara(people, persona);
  const destino = path.join(carpeta, 'llamada-unida.wav');
  const notas = path.join(carpeta, 'llamada-unida.json');
  const firma = huella([...tramos, ...anclas, o.sesion && fs.existsSync(o.sesion) ? o.sesion : null]);
  if (fs.existsSync(destino) && fs.existsSync(notas)) {
    try {
      const previo = JSON.parse(fs.readFileSync(notas, 'utf8'));
      if (previo.huella === firma) return { archivo: destino, unida: true, tramos: previo.tramos, ignoradas, fuente: previo.fuente, reutilizada: true };
    } catch { /* se rehace */ }
  }

  log(`la llamada está partida en ${tramos.length} tramos (la página que la grababa se cerró y se retomó): se unen`);
  // 1. Por correlación con la grabación continua de la otra persona (la más fiable de las que haya).
  let inicios = null;
  let fuente = null;
  let confianzas = [];
  const envTramos = tramos.map((t) => SY.envelope(t, { analyzeSeconds: Infinity }));
  let mejor = null;
  for (const ancla of envTramos.every((e) => !e.error) ? anclas : []) {
    const envAncla = SY.envelope(ancla, { analyzeSeconds: Infinity });
    if (envAncla.error) continue;
    const medidas = envTramos.map((e) => SY.offsetBetween(envAncla.envelope, e.envelope));
    const peor = Math.min(...medidas.map((m) => m.confidence));
    if (!mejor || peor > mejor.peor) mejor = { ancla, medidas, peor };
  }
  if (mejor) {
    confianzas = mejor.medidas.map((m) => Math.round(m.confidence * 10) / 10);
    if (mejor.peor >= CONFIANZA_MINIMA) {
      inicios = mejor.medidas.map((m) => m.seconds - mejor.medidas[0].seconds);
      fuente = `correlación con ${MC.nombreBase(mejor.ancla)}`;
    }
  }
  // 2. Si no, con la hora de inicio de cada pista que apuntó el Estudio.
  if (!inicios && o.sesion && fs.existsSync(o.sesion)) {
    const desde = iniciosDeSesion(o.sesion);
    const horas = tramos.map((t) => desde[path.basename(t)]);
    if (horas.every((h) => Number.isFinite(h))) {
      inicios = horas.map((h) => (h - horas[0]) / 1000);
      fuente = 'hora de inicio de cada pista (session.json)';
    }
  }
  if (!inicios) {
    return {
      error: `la llamada está partida (${tramos.map(MC.nombreBase).join(' + ')}) y no se pudo situar cada tramo: `
        + `${mejor ? `la correlación con ${MC.nombreBase(mejor.ancla)} no es fiable (confianza ${confianzas.join(', ')})` : 'no hay grabación continua de la otra persona'}`
        + ' y no hay session.json del Estudio. Importa la sesión desde el Estudio (node cli.js importar --copiar) o pásale una referencia con --ref.',
    };
  }
  // Un tramo no puede empezar antes de que acabe el anterior (son páginas sucesivas).
  for (let i = 1; i < tramos.length; i += 1) {
    const anterior = M.probe(tramos[i - 1], null).seconds || 0;
    if (inicios[i] < inicios[i - 1] + anterior - 1) {
      log(`  aviso   el tramo ${MC.nombreBase(tramos[i])} parece solaparse con el anterior (${(inicios[i - 1] + anterior - inicios[i]).toFixed(1)} s): revisa la sincronía`);
    }
  }
  const minimo = Math.min(...inicios);
  const relativos = inicios.map((x) => x - minimo);
  const error = escribirUnida(tramos, relativos, destino);
  if (error) return { error: `no se pudo unir la llamada: ${error}` };
  const lista = tramos.map((t, i) => ({ archivo: t, desde: Math.round(relativos[i] * 1000) / 1000 }));
  fs.writeFileSync(notas, `${JSON.stringify({ huella: firma, fuente, confianzas, tramos: lista }, null, 2)}\n`, 'utf8');
  for (const t of lista) log(`  ${MC.nombreBase(t.archivo).padEnd(22)} empieza en el segundo ${t.desde.toFixed(2)} de la llamada unida`);
  log(`  medido por ${fuente}${confianzas.length ? ` (confianza ${confianzas.join(', ')})` : ''}`);
  return { archivo: destino, unida: true, tramos: lista, ignoradas, fuente };
}

module.exports = { CONFIANZA_MINIMA, tramosDeLlamada, anclasPara, iniciosDeSesion, llamadaParaReloj };
