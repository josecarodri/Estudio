/*
 * Vídeo de revisión: para dar el visto bueno al montaje desde el móvil, sin abrir Kdenlive.
 *
 * Un vídeo corto (480p) con unos segundos alrededor de cada empalme —numerado, con su motivo
 * escrito encima y una barra roja en el instante del corte—, más el principio y el final del
 * episodio y las uniones entre partes. Al lado, una lista (revision.md) con lo mismo y el minuto
 * de cada trozo en el vídeo final, para contestar «todo bien» o «el 4 no».
 *
 * Los silencios recortados (muchos y automáticos) no salen, salvo que se pidan. Cada trozo se
 * renderiza con melt a partir de su parte de la receta y se guarda con una huella: si luego se
 * cambia un corte, solo se rehacen los trozos que cambian.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CUT = require('./cortes.js');
const P = require('./project.js');
const { reloj } = require('./transcribir.js');

const existe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };

/*
 * Qué trozos lleva la revisión: el principio, cada empalme (salvo los de silencios, si no se piden),
 * los avisos «⚠» (cámara congelada cubierta con la otra), los dos primeros planos dobles «◫», las
 * uniones entre partes y el final. Los que se tocan se juntan en uno. Tiempos en frames del
 * montaje final. Devuelve { trozos: [{ n, desde, hasta, textos, empalmes }], silenciosFuera, segundosFuera }.
 */
function trozosDeRevision(receta, opciones) {
  const o = { silencios: false, antes: 4, despues: 4, inicio: 10, final: 12, ...opciones };
  const fps = Number(receta.project.fps);
  const total = CUT.duracionFrames(receta);
  const f = (s) => Math.round(s * fps);
  const puntos = [];
  let silenciosFuera = 0;
  let segundosFuera = 0;
  let dobles = 0;
  for (const g of receta.guides || []) {
    const c = CUT.leerGuiaDeCorte(g);
    // Avisos del montaje (cámara congelada cubierta con la otra…): también se revisan.
    if (!c && /^⚠ /.test(String(g.name || ''))) puntos.push({ at: g.at, texto: String(g.name).slice(2) });
    // Del plano doble, los dos primeros: para ver cómo queda sin llenar la revisión.
    if (!c && /^◫ /.test(String(g.name || '')) && dobles < 2) { dobles += 1; puntos.push({ at: g.at, texto: String(g.name).slice(2) }); }
    if (!c) continue;
    if (c.motivo === 'silencio' && !o.silencios) {
      silenciosFuera += 1;
      segundosFuera += c.segundos;
      continue;
    }
    puntos.push({ at: g.at, texto: `corte: ${c.motivo} (−${String(c.segundos).replace('.', ',')} s)` });
  }
  // Uniones entre partes: donde empieza el primer clip de cada parte (p2_, p3_…).
  const inicioDeParte = new Map();
  for (const e of receta.edit) {
    const m = /^p(\d+)_/.exec(e.clip);
    if (m && Number(m[1]) > 1) inicioDeParte.set(m[1], Math.min(inicioDeParte.get(m[1]) ?? Infinity, e.at));
  }
  for (const [n, at] of inicioDeParte) if (at > 0 && at < total) puntos.push({ at, texto: `empieza la parte ${n}` });
  puntos.sort((a, b) => a.at - b.at);

  const trozos = [{ desde: 0, hasta: Math.min(total, f(o.inicio)), textos: ['principio del episodio'], empalmes: [] }];
  for (const p of puntos) {
    const desde = Math.max(0, p.at - f(o.antes));
    const hasta = Math.min(total, p.at + f(o.despues));
    const u = trozos[trozos.length - 1];
    if (desde <= u.hasta) {
      u.hasta = Math.max(u.hasta, hasta);
      u.textos.push(p.texto);
      u.empalmes.push(p.at);
    } else {
      trozos.push({ desde, hasta, textos: [p.texto], empalmes: [p.at] });
    }
  }
  const desdeFinal = Math.max(0, total - f(o.final));
  const u = trozos[trozos.length - 1];
  if (desdeFinal <= u.hasta) {
    u.hasta = total;
    u.textos.push('final del episodio');
  } else {
    trozos.push({ desde: desdeFinal, hasta: total, textos: ['final del episodio'], empalmes: [] });
  }
  return {
    trozos: trozos.filter((t) => t.hasta > t.desde).map((t, i) => ({ n: i + 1, ...t })),
    silenciosFuera,
    segundosFuera: Math.round(segundosFuera * 10) / 10,
  };
}

/* El texto que se escribe sobre el vídeo: sin símbolos que a lo mejor no tiene la fuente. */
function etiqueta(trozo, fps) {
  const donde = reloj((trozo.empalmes[0] ?? trozo.desde) / fps);
  const texto = `${trozo.n} · ${donde} · ${trozo.textos.join(' + ')}`.replace(/[✂★⚠◫]\s?/g, '');
  return texto.length > 90 ? `${texto.slice(0, 89)}…` : texto;
}

/* Una fuente para escribir encima (drawtext): se copia junto a los trozos para no lidiar con rutas «C:». */
const FUENTES = [
  'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/segoeui.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf', '/Library/Fonts/Arial.ttf',
];
function prepararFuente(dir) {
  const f = FUENTES.find(existe);
  if (!f) return 'font=Sans';
  fs.copyFileSync(f, path.join(dir, 'fuente.ttf'));
  return 'fontfile=fuente.ttf';
}

/*
 * Renderiza con melt un trozo de la receta (frames [desde, hasta) del montaje final), o lo reutiliza si ya
 * está hecho con la misma huella. Devuelve { archivo, reutilizado } o { error }.
 */
function renderizarTrozo(receta, trozo, h) {
  const fps = Number(receta.project.fps);
  const t = CUT.extraerTramo(receta, trozo.desde / fps, trozo.hasta / fps);
  const usados = new Set(t.piezas.map((e) => e.clip));
  const sub = { ...receta, media: receta.media.filter((m) => usados.has(m.id)), edit: t.piezas, guides: [] };
  delete sub.notes;
  const huella = crypto.createHash('sha1')
    .update(JSON.stringify({ edit: sub.edit, media: sub.media, project: sub.project, tracks: sub.tracks, c: h.compositing, v: 1 }))
    .digest('hex').slice(0, 16);
  const archivo = path.join(h.dir, `trozo-${huella}.mp4`);
  if (existe(archivo)) return { archivo, reutilizado: true };
  const built = P.buildProject(sub, { media: h.media, fps, compositing: h.compositing, docVersion: h.docVersion });
  const proyecto = path.join(h.dir, `trozo-${huella}.kdenlive`);
  fs.writeFileSync(proyecto, built.xml, 'utf8');
  const tmp = path.join(h.dir, `trozo-${huella}.tmp.mp4`);
  const [cmd, ...previos] = [].concat(h.melt); // melt, o [xvfb-run, -a, melt] en Linux sin pantalla (media.comandoMelt)
  const res = spawnSync(cmd, [...previos, proyecto, '-consumer', `avformat:${tmp}`, 'vcodec=libx264', 'crf=20', 'preset=veryfast', 'acodec=aac', 'ab=192k'],
    { stdio: 'ignore', timeout: 30 * 60000 });
  fs.rmSync(proyecto, { force: true });
  if (res.status !== 0 || !existe(tmp)) {
    fs.rmSync(tmp, { force: true });
    return { error: `melt falló en el trozo ${trozo.n}${res.error ? `: ${res.error.message}` : ''}` };
  }
  fs.renameSync(tmp, archivo);
  return { archivo, reutilizado: false };
}

/*
 * Pasa un trozo a 480p con su rótulo y la barra roja en cada empalme (y el color y el sonido del
 * acabado, para verlo como quedará). Si no se puede escribir texto, sale sin rótulo.
 */
function rotular(entrada, salida, texto, empalmesSeg, h) {
  const base = ['scale=854:-2', ...(h.filtrosVideo || [])];
  for (const t of empalmesSeg) {
    base.push(`drawbox=enable='between(t,${Math.max(0, t - 0.2).toFixed(2)},${(t + 0.2).toFixed(2)})':x=0:y=ih-14:w=iw:h=14:color=red@0.9:t=fill`);
  }
  const af = [...(h.filtrosAudio || []), 'loudnorm=I=-16:TP=-1.5:LRA=11', 'aresample=48000'].join(',');
  const nombreTexto = `${path.basename(salida, '.mp4')}.txt`;
  fs.writeFileSync(path.join(h.dir, nombreTexto), texto, 'utf8');
  // Se escribe aparte y se renombra al acabar: un trozo a medias no se reutiliza la próxima vez.
  const tmp = `${salida}.tmp.mp4`;
  const ffmpeg = (vf) => spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', entrada, '-vf', vf.join(','), '-af', af,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', tmp],
  { cwd: h.dir, encoding: 'utf8' });
  let res = h.fuente ? ffmpeg([...base, `drawtext=${h.fuente}:textfile=${nombreTexto}:fontsize=20:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:x=12:y=12`]) : null;
  if (!res || res.status !== 0) res = ffmpeg(base);
  fs.rmSync(path.join(h.dir, nombreTexto), { force: true });
  if (res.status !== 0) {
    fs.rmSync(tmp, { force: true });
    return (res.stderr || '').trim().split('\n').slice(-2).join(' ');
  }
  fs.renameSync(tmp, salida);
  return null;
}

/*
 * Hace la revisión entera. h: { dir (trozos), salida (.mp4), md, melt, media (byId), compositing, docVersion,
 * filtrosVideo, filtrosAudio, silencios, antes, despues, episodio, log }.
 * Devuelve { trozos, rehechos, segundos, silenciosFuera, segundosFuera } o { error }.
 */
function hacerRevision(receta, h) {
  const log = h.log || (() => {});
  const fps = Number(receta.project.fps);
  fs.mkdirSync(h.dir, { recursive: true });
  const plan = trozosDeRevision(receta, { silencios: h.silencios, antes: h.antes, despues: h.despues });
  const conFuente = { ...h, fuente: prepararFuente(h.dir) };
  const finales = [];
  const vivos = new Set();
  let rehechos = 0;
  for (const t of plan.trozos) {
    const r = renderizarTrozo(receta, t, h);
    if (r.error) return { error: r.error };
    vivos.add(path.basename(r.archivo));
    if (!r.reutilizado) rehechos += 1;
    // El trozo rotulado también se guarda con su huella: si no cambia nada, la revisión sale en segundos.
    const texto = etiqueta(t, fps);
    const empalmes = t.empalmes.map((at) => (at - t.desde) / fps);
    const huella = crypto.createHash('sha1')
      .update(JSON.stringify({ trozo: path.basename(r.archivo), texto, empalmes, fv: h.filtrosVideo || [], fa: h.filtrosAudio || [], v: 1 }))
      .digest('hex').slice(0, 16);
    const salida = path.join(h.dir, `rotulado-${huella}.mp4`);
    if (!existe(salida)) {
      const err = rotular(r.archivo, salida, texto, empalmes, conFuente);
      if (err) return { error: `no se pudo preparar el trozo ${t.n}: ${err}` };
    }
    vivos.add(path.basename(salida));
    finales.push(salida);
    log(`  ${t.n}/${plan.trozos.length} ${reloj((t.empalmes[0] ?? t.desde) / fps)} · ${t.textos.join(' + ')}${r.reutilizado ? ' (ya estaba)' : ''}`);
  }
  const lista = path.join(h.dir, 'lista.txt');
  fs.writeFileSync(lista, finales.map((f) => `file '${path.basename(f)}'`).join('\n'), 'utf8');
  const tmp = path.join(os.tmpdir(), `revision-${process.pid}-${Date.now()}.mp4`);
  const res = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', lista, '-c', 'copy', '-movflags', '+faststart', tmp],
    { encoding: 'utf8' });
  fs.rmSync(lista, { force: true });
  if (res.status !== 0 || !existe(tmp)) return { error: `no se pudieron unir los trozos: ${(res.stderr || '').trim()}` };
  fs.copyFileSync(tmp, h.salida);
  fs.rmSync(tmp, { force: true });
  // Trozos de revisiones anteriores que ya no salen: fuera, para no llenar el disco.
  for (const f of fs.readdirSync(h.dir)) if (/^(trozo|rotulado)-.*\.mp4$/.test(f) && !vivos.has(f)) fs.rmSync(path.join(h.dir, f), { force: true });

  const segundos = plan.trozos.reduce((s, t) => s + (t.hasta - t.desde) / fps, 0);
  const md = [
    `# Revisión · ${h.episodio || ''} · ${reloj(CUT.duracionFrames(receta) / fps)}`,
    '',
    `Vídeo: \`${path.basename(h.salida)}\` (${reloj(segundos)}). Cada trozo lleva su número arriba a la izquierda;`,
    'la barra roja de abajo marca el instante del empalme. Contesta «todo bien» o «el 4 no».',
    '',
    '| # | En el vídeo final | Qué hay |',
    '|---|---|---|',
    ...plan.trozos.map((t) => `| ${t.n} | ${reloj((t.empalmes[0] ?? t.desde) / fps)} | ${t.textos.join(' + ')} |`),
    '',
    plan.silenciosFuera
      ? `Silencios recortados que no salen aquí: ${plan.silenciosFuera} (${reloj(plan.segundosFuera)} en total). Para verlos también: \`node cli.js revision <carpeta> --silencios\`.`
      : 'No hay silencios recortados fuera de la revisión.',
  ];
  fs.writeFileSync(h.md, `${md.join('\n')}\n`, 'utf8');
  return { trozos: plan.trozos.length, rehechos, segundos, silenciosFuera: plan.silenciosFuera, segundosFuera: plan.segundosFuera };
}

module.exports = { trozosDeRevision, etiqueta, hacerRevision };
