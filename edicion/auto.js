/*
 * Lo que se puede decidir sin pensar en cada episodio:
 *   analizar  → mide inicio/fin, silencios y marcas de charla técnica; escribe una propuesta corta.
 *   aprobar   → pasa a episodio.json las propuestas que se elijan, con los cortes ajustados al silencio.
 *   verificar → comprueba el vídeo ya renderizado (duración, sonido, principio y final).
 *   estado    → en qué fase va el proceso, en una línea.
 * Y las ayudas que usa `episodio`: límites automáticos, cortes por texto y la huella que evita repetir análisis.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const EP = require('./episodio.js');
const CUT = require('./cortes.js');
const TR = require('./transcribir.js');
const A = require('./analizar.js');
const LL = require('./llamadas.js');

const reloj = TR.reloj;
const existe = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const leerJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));
const escribirJson = (p, d) => fs.writeFileSync(p, `${JSON.stringify(d, null, 2)}\n`, 'utf8');
const camarasDe = (parte) => parte.archivos.filter((f) => /camara|camera|cam\b/i.test(path.basename(f)) && /\.(mp4|mov|mkv|webm)$/i.test(f));

/* Huecos de una llamada partida (en segundos de la llamada unida); ninguno si está entera. */
function huecosDeLlamada(parte, montaje) {
  const notas = path.join(montaje, `parte-${parte.id}`, 'llamada-unida.json');
  if (!existe(notas)) return [];
  const { tramos } = leerJson(notas);
  const huecos = [];
  for (let i = 1; i < (tramos || []).length; i += 1) {
    const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', tramos[i - 1].archivo], { encoding: 'utf8' });
    const fin = tramos[i - 1].desde + (Number.parseFloat(r.stdout) || 0);
    if (tramos[i].desde - fin > 0.5) huecos.push({ desde: Math.round(fin * 100) / 100, hasta: Math.round(tramos[i].desde * 100) / 100 });
  }
  return huecos;
}

/*
 * La llamada de una parte, que es el reloj de todo (pitidos, silencios, transcripción, cortes).
 * Si quedó partida porque la página que la grababa se cayó y se retomó, es la versión unida que
 * se deja en montaje/parte-N/llamada-unida.wav (ver llamadas.js).
 */
function llamadaDe(parte, montaje) {
  if (!montaje) return LL.tramosDeLlamada(parte.archivos).tramos[0];
  const sesion = parte.carpeta && existe(path.join(parte.carpeta, 'session.json')) ? path.join(parte.carpeta, 'session.json') : null;
  const r = LL.llamadaParaReloj(parte.archivos, path.join(montaje, `parte-${parte.id}`), { sesion, log: (t) => console.log(`  ${t}`) });
  if (r.error) throw new Error(`parte ${parte.id}: ${r.error}`);
  return r.archivo;
}

/*
 * Marcas puestas mientras se grababa con los botones del Estudio («✂ cortar», un tramo; «★ bueno», un
 * instante), pasadas al reloj de la llamada de la parte: el de los cortes y la transcripción. Las horas
 * del session.json son del reloj del servidor; cada pista de la llamada apunta a qué hora del servidor
 * empezó, y si la llamada quedó partida, llamada-unida.json dice dónde va cada tramo.
 * Devuelve [{ tipo: 'corte'|'bueno', desde, hasta, nombre, persona, cerradoAlParar }] en segundos.
 */
function marcasEnVivo(parte, montaje) {
  const sesionFile = parte.carpeta ? path.join(parte.carpeta, 'session.json') : null;
  if (!sesionFile || !existe(sesionFile)) return [];
  let marcas;
  try { marcas = leerJson(sesionFile).marcas; } catch { return []; }
  if (!Array.isArray(marcas) || !marcas.length) return [];
  const { tramos } = LL.tramosDeLlamada(parte.archivos);
  if (!tramos.length) return [];
  let colocados = [{ archivo: tramos[0], desde: 0 }];
  const notas = montaje && path.join(montaje, `parte-${parte.id}`, 'llamada-unida.json');
  if (tramos.length > 1 && notas && existe(notas)) colocados = leerJson(notas).tramos || colocados;
  const inicios = LL.iniciosDeSesion(sesionFile);
  const conHora = colocados.map((t) => ({ ...t, inicio: inicios[path.basename(t.archivo)] })).filter((t) => Number.isFinite(t.inicio));
  if (!conHora.length) return [];
  // A cada hora le corresponde el tramo que estaba grabando entonces: el último que había empezado.
  const aLlamada = (hora) => {
    const t = [...conHora].reverse().find((x) => x.inicio <= hora) || conHora[0];
    return Math.max(0, Math.round((t.desde + (hora - t.inicio) / 1000) * 100) / 100);
  };
  const out = [];
  for (const m of marcas) {
    if (m && m.tipo === 'bueno' && Number.isFinite(m.hora)) {
      const t = aLlamada(m.hora);
      out.push({ tipo: 'bueno', desde: t, hasta: t, nombre: m.nombre || '', persona: m.persona || null });
    } else if (m && m.tipo === 'corte' && Number.isFinite(m.inicio)) {
      out.push({
        tipo: 'corte', desde: aLlamada(m.inicio), hasta: aLlamada(Number.isFinite(m.fin) ? m.fin : m.inicio),
        nombre: m.nombre || '', persona: m.persona || null, cerradoAlParar: !!m.cerradoAlParar,
      });
    }
  }
  return out.sort((a, b) => a.desde - b.desde);
}

// Un ✂ más corto que esto (dos pulsaciones seguidas) no dice qué cortar: se deja para revisar lo de justo antes.
const CORTE_EN_VIVO_MINIMO = 3;

/*
 * Guías para el proyecto de Kdenlive a partir de las marcas en vivo: ★ en verde y, en rojo, los tramos ✂
 * que no se van a cortar (para que se vean al revisar). Lo que cae dentro de un corte no lleva guía.
 * `tramos` son los cortes de la parte, en segundos de la llamada. Devuelve { guias, sinCortar }.
 */
function guiasDeMarcas(receta, marcas, tramos) {
  const fps = Number(receta.project.fps);
  const origen = Number(receta.origenReferencia) || 0;
  const fin = CUT.duracionFrames(receta);
  const cortes = CUT.unirTramos(tramos.map((t) => ({ desde: t.desde, hasta: t.hasta })));
  const cubierto = (desde, hasta) => cortes.reduce((s, c) => s + Math.max(0, Math.min(c.hasta, hasta) - Math.max(c.desde, desde)), 0);
  const guias = [];
  let sinCortar = 0;
  for (const m of marcas) {
    const at = Math.round((m.desde - origen) * fps);
    if (at < 0 || at >= fin) continue;
    if (m.tipo === 'bueno') {
      if (cubierto(m.desde, m.desde + 0.01) === 0) guias.push({ at, name: `★ ${m.nombre}`, color: 'Green' });
    } else if (m.hasta - m.desde >= CORTE_EN_VIVO_MINIMO && cubierto(m.desde, m.hasta) < 0.8 * (m.hasta - m.desde)) {
      sinCortar += 1;
      guias.push({ at, name: `✂ ${m.nombre} (marcado en vivo, ${Math.round(m.hasta - m.desde)} s, sin cortar)`, color: 'Red' });
    }
  }
  return { guias, sinCortar };
}

/* Lo que se dijo entre dos instantes, según la transcripción (lo más reciente si es largo). */
function textoEntre(segs, desde, hasta, max = 220) {
  const t = segs.filter((s) => s.hasta > desde && s.desde < hasta).map((s) => s.texto).join(' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `…${t.slice(-max)}` : t;
}

// ------------------------------------------------------------------ estado
function marcarFase(r, fase, detalle) {
  try {
    fs.mkdirSync(r.montaje, { recursive: true });
    const f = path.join(r.montaje, 'estado.json');
    const previo = existe(f) ? leerJson(f) : {};
    const ahora = new Date().toISOString();
    escribirJson(f, { ...previo, fase, detalle: detalle || '', inicioFase: ahora, actualizado: ahora, pid: process.pid, inicio: previo.inicio || ahora });
  } catch { /* el estado es una ayuda, no debe romper nada */ }
}

function estado(carpeta) {
  const r = EP.rutas(carpeta);
  const f = path.join(r.montaje, 'estado.json');
  if (!existe(f)) return { texto: 'sin actividad registrada en este episodio.' };
  const e = leerJson(f);
  const min = Math.round((Date.now() - new Date(e.inicioFase).getTime()) / 60000);
  let vivo = false;
  try { process.kill(e.pid, 0); vivo = true; } catch { vivo = false; }
  const extra = [];
  for (const [nombre, ruta] of [['bruto', path.join(r.montaje, 'episodio-bruto.mp4')], ['final', path.join(r.entrega, `${path.basename(r.base)}.mp4`)]]) {
    if (existe(ruta)) extra.push(`${nombre} ${(fs.statSync(ruta).size / 1073741824).toFixed(2)} GB`);
  }
  const marca = vivo || e.fase === 'listo' || e.fase === 'error' ? '' : ' (el proceso ya no está: se interrumpió)';
  return { fase: e.fase, vivo, minutos: min, texto: `${e.fase}${e.detalle ? ` · ${e.detalle}` : ''} · hace ${min} min${extra.length ? ` · ${extra.join(' · ')}` : ''}${marca}` };
}

// ------------------------------------------------------------------ huella (evita repetir el análisis largo)
function huellaDeParte(parte, cfg) {
  const archivos = parte.archivos.map((f) => { const s = fs.statSync(f); return [path.basename(f), s.size, Math.round(s.mtimeMs)]; });
  const ajustes = { desde: cfg.desde, hasta: cfg.hasta, audioOffset: cfg.audioOffset, minShot: cfg.minShot, lufs: cfg.lufsMicros, v: 1 };
  return crypto.createHash('sha1').update(JSON.stringify({ archivos, ajustes })).digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ límites automáticos y cortes por texto
/**
 * Convierte `desde: "auto"` / `hasta: "auto"` en segundos reales, midiendo el pitido y la voz de la llamada.
 * Devuelve { desde, hasta, detalle } con null donde no hay límite que poner.
 */
function resolverLimites(parte, cfg, montaje) {
  const out = { desde: cfg.desde, hasta: cfg.hasta, detalle: [] };
  const auto = (v) => v === 'auto' || v === true;
  if (!auto(cfg.desde) && !auto(cfg.hasta)) return out;
  const llamada = llamadaDe(parte, montaje);
  const lim = llamada ? A.limitesDeVoz(llamada) : null;
  if (auto(cfg.desde)) {
    out.desde = lim && lim.inicio != null ? Math.round(lim.inicio * 100) / 100 : null;
    out.detalle.push(out.desde != null ? `inicio automático ${out.desde}s (voz tras el pitido)` : 'sin pitido inicial: no se recorta el inicio');
  }
  if (auto(cfg.hasta)) {
    out.hasta = lim && lim.fin != null ? Math.round(lim.fin * 100) / 100 : null;
    out.detalle.push(out.hasta != null ? `final automático ${out.hasta}s (última voz antes del pitido de cierre)` : 'sin pitido de cierre: se termina donde acaben los archivos');
  }
  return out;
}

/**
 * Cortes escritos como texto: { "desde": "frase", "hasta": "frase" } → tramo en segundos.
 * Se quita desde el principio de la primera frase hasta el principio de la segunda (que se conserva), salvo con
 * "incluirHasta". "despuesDe" (tiempo) y "ordinal" desambiguan frases repetidas. Los extremos se llevan al silencio más cercano.
 */
function resolverCortesTexto(entradas, parte, montaje) {
  const salida = [];
  const jsonFile = path.join(montaje, `transcripcion-parte-${parte.id}.json`);
  let palabras = null;
  const llamada = (entradas || []).some((e) => !Array.isArray(e)) ? llamadaDe(parte, montaje) : null;
  for (const e of entradas || []) {
    // Un corte por tiempos puede llevar una nota detrás (["10:27", "12:55", "1.2 ✂ en vivo"]): de dónde salió.
    if (Array.isArray(e)) { salida.push({ tramo: e, ...(typeof e[2] === 'string' ? { nota: e[2] } : {}) }); continue; }
    if (!palabras) {
      if (!existe(jsonFile)) throw new Error(`hay cortes escritos con texto pero falta la transcripción de la parte ${parte.id}. Ejecuta: node cli.js transcribir <carpeta>`);
      palabras = A.palabras(jsonFile);
    }
    const despuesDe = e.despuesDe !== undefined ? tiempoASeg(e.despuesDe) : 0;
    const a = A.buscarFrase(palabras, String(e.desde), { despuesDe, ordinal: e.ordinal });
    if (!a) throw new Error(`parte ${parte.id}: no encuentro «${e.desde}» en la transcripción${despuesDe ? ` después de ${reloj(despuesDe)}` : ''}.`);
    const b = A.buscarFrase(palabras, String(e.hasta), { despuesDe: a.hasta });
    if (!b) throw new Error(`parte ${parte.id}: no encuentro «${e.hasta}» después de «${e.desde}».`);
    let desde = a.desde;
    let hasta = e.incluirHasta ? b.hasta : b.desde;
    if (llamada) { desde = A.ajustarASilencio(llamada, desde, 0.6); hasta = A.ajustarASilencio(llamada, hasta, 0.6); }
    if (!(hasta > desde)) throw new Error(`parte ${parte.id}: el corte «${e.desde}» → «${e.hasta}» sale vacío.`);
    salida.push({ tramo: [Math.round(desde * 100) / 100, Math.round(hasta * 100) / 100], texto: `«${e.desde}» → «${e.hasta}»` });
  }
  return salida;
}

/*
 * Ruido de fondo de un micro, en dB (RMS de ventanas de 50 ms): el percentil 10 de unos cuantos
 * trozos repartidos por el archivo. En una conversación cada micro calla buena parte del tiempo
 * (mientras habla el otro), así que eso es su ruido de fondo.
 */
function sueloDeRuido(archivo) {
  const dur = A.duracion(archivo);
  if (!dur) return null;
  const valores = [];
  const trozos = Math.min(10, Math.max(1, Math.floor(dur / 30)));
  for (let i = 0; i < trozos; i += 1) {
    const x = A.pcm(archivo, (dur * (i + 0.5)) / trozos - 10, Math.min(20, dur));
    if (x) valores.push(...A.energia(x));
  }
  if (!valores.length) return null;
  valores.sort((a, b) => a - b);
  return valores[Math.floor(valores.length * 0.1)];
}

/*
 * Los silencios largos se buscan en la llamada, pero lo que se oye en el episodio son los micros.
 * Si la llamada perdió el audio de alguien (un corte de la conexión, o el hueco de una caída de la
 * página) mientras esa persona seguía hablando, la llamada dice «silencio» y no lo es: se quitaría
 * algo que se dijo. Antes de quitar un silencio se mira en los micros: si alguno tiene voz (más de
 * `minimoVoz` s claramente por encima de su ruido de fondo), ese silencio se deja y se avisa.
 * `tramos` en segundos de la llamada; devuelve { quedan, descartados }.
 */
function confirmarSilencios(receta, tramos, opciones) {
  const o = opciones || {};
  const margenDb = o.margenDb !== undefined ? o.margenDb : 20;
  const minimoVoz = o.minimoVoz !== undefined ? o.minimoVoz : 1;
  const fps = Number(receta.project.fps);
  const origen = Number(receta.origenReferencia) || 0;
  const micros = receta.edit.filter((e) => e.audioTrack).map((e) => {
    const media = (receta.media || []).find((m) => m.id === e.clip);
    // Segundo de la llamada en el que empieza el archivo: así se pasa de un reloj al otro.
    return media && { e, archivo: media.path, desfase: origen + e.at / fps - (e.in || 0) / fps };
  }).filter(Boolean);
  const suelos = new Map();
  const umbralDe = (archivo) => {
    if (!suelos.has(archivo)) {
      const s = sueloDeRuido(archivo);
      // Con un micro casi mudo (ceros digitales) el suelo no dice nada: por debajo de −55 dB no es voz.
      suelos.set(archivo, s === null ? null : Math.max(s + margenDb, -55));
    }
    return suelos.get(archivo);
  };
  const quedan = [];
  const descartados = [];
  for (const t of tramos) {
    let voz = null;
    for (const m of micros) {
      const desde = Math.max(t.desde, origen + m.e.at / fps);
      const hasta = Math.min(t.hasta, origen + (m.e.at + m.e.duration) / fps);
      if (hasta - desde < minimoVoz) continue;
      const umbral = umbralDe(m.archivo);
      const x = umbral === null ? null : A.pcm(m.archivo, desde - m.desfase, hasta - desde);
      if (!x) continue;
      const segundos = A.energia(x).filter((db) => db > umbral).length * 0.05;
      if (segundos >= minimoVoz) {
        voz = { micro: m.e.clip.replace(/^(p\d+_)?mic_/, ''), segundos };
        break;
      }
    }
    if (voz) descartados.push({ ...t, ...voz });
    else quedan.push(t);
  }
  return { quedan, descartados };
}

function tiempoASeg(v) {
  if (typeof v === 'number') return v;
  const p = String(v).split(':').map(Number);
  return p.reduce((acc, x) => acc * 60 + x, 0);
}

// ------------------------------------------------------------------ analizar
function analizar(carpeta, flags) {
  const r = EP.rutas(carpeta);
  if (!existe(r.originales)) throw new Error(`no existe ${r.originales}`);
  const { config } = EP.cargarConfig(r.base);
  const partes = EP.agruparPartes(r.originales);
  if (!partes.length) throw new Error('no hay archivos en originales/');
  fs.mkdirSync(r.montaje, { recursive: true });
  const propuesta = { episodio: path.basename(r.base), generado: new Date().toISOString(), partes: {} };
  const md = [];
  let total = 0;
  for (const parte of partes) {
    marcarFase(r, `analizando-parte-${parte.id}`);
    const llamada = llamadaDe(parte, r.montaje);
    if (!llamada) { md.push(`## Parte ${parte.id}\n- No hay archivo de llamada: no se puede analizar.`); continue; }
    const base = path.join(r.montaje, `transcripcion-parte-${parte.id}`);
    if (!existe(`${base}.json`) && !flags['sin-transcribir']) {
      console.log(`parte ${parte.id}: transcribiendo (≈10 min por hora de audio)…`);
      marcarFase(r, `transcribiendo-parte-${parte.id}`);
      const t = TR.transcribir(llamada, base, config);
      if (t.error) { console.log(`  aviso: ${t.error} Se sigue sin transcripción.`); }
    }
    const lim = A.limitesDeVoz(llamada);
    total += lim.duracion || 0;
    const sil = CUT.detectarSilencios(llamada, config.silencios);
    const silencios = sil.error ? [] : sil.tramos;
    const segs = existe(`${base}.json`) ? A.segmentos(`${base}.json`) : [];
    let marcas = A.candidatos(segs).map((m) => {
      const desde = Math.round(A.ajustarASilencio(llamada, m.desde, 0.6) * 100) / 100;
      const hasta = Math.round(A.ajustarASilencio(llamada, m.hasta, 0.6) * 100) / 100;
      return { desde, hasta, tipos: m.tipos, texto: m.marcas[0], contexto: m.contexto };
    });
    // Si la llamada quedó partida, el hueco entre tramos es el rato en que la página estuvo caída.
    for (const h of huecosDeLlamada(parte, r.montaje)) {
      marcas.push({ desde: h.desde, hasta: h.hasta, tipos: ['caida'], texto: 'hueco: se cayó la página que grababa la llamada', contexto: '' });
    }
    // Marcas puestas en vivo con los botones del Estudio. Los tramos ✂ son propuestas como las demás; los ★
    // (buenos momentos) y los ✂ sin tramo se listan aparte, con lo que se dijo justo antes de la marca.
    const momentos = [];
    const paraRevisar = [];
    for (const m of marcasEnVivo(parte, r.montaje)) {
      if (m.tipo === 'bueno') {
        momentos.push({ t: m.desde, nombre: m.nombre, texto: textoEntre(segs, m.desde - 30, m.desde + 2) });
      } else if (m.hasta - m.desde < CORTE_EN_VIVO_MINIMO) {
        paraRevisar.push({ t: m.desde, nombre: m.nombre, texto: textoEntre(segs, m.desde - 20, m.desde + 2) });
      } else {
        // Se pulsa un momento después de que empiece lo que se quiere quitar: se adelanta 1 s.
        const desde = Math.round(A.ajustarASilencio(llamada, Math.max(0, m.desde - 1), 0.6) * 100) / 100;
        const hasta = Math.round(A.ajustarASilencio(llamada, lim.duracion ? Math.min(m.hasta, lim.duracion) : m.hasta, 0.6) * 100) / 100;
        marcas.push({
          desde, hasta, tipos: ['✂ en vivo'], texto: `marcado por ${m.nombre}`, contexto: textoEntre(segs, desde, hasta), enVivo: true,
          ...(m.cerradoAlParar ? { aviso: 'nadie lo cerró: llega hasta el final de la grabación' } : {}),
        });
      }
    }
    marcas = marcas.sort((a, b) => a.desde - b.desde).map((m, i) => ({ id: `${parte.id}.${i + 1}`, ...m }));
    const brillos = [];
    for (const cam of camarasDe(parte)) {
      const s = A.saltoDeBrilloInicial(cam, 45, 8);
      if (s) brillos.push({ archivo: path.basename(cam), ...s });
    }
    propuesta.partes[parte.id] = { llamada: path.basename(llamada), duracion: lim.duracion, inicioVoz: lim.inicio, finVoz: lim.fin, pitidoInicio: !!lim.pitidoInicio, pitidoFin: !!lim.pitidoFin, silencios, marcas, brillos, momentos, paraRevisar };

    md.push(`## Parte ${parte.id} — ${path.basename(llamada)} (${reloj(lim.duracion)})`);
    md.push(`- Inicio de voz: ${lim.inicio != null ? `${lim.inicio.toFixed(2)} s` : '— (no hay pitido inicial)'} · Final de voz: ${lim.fin != null ? `${reloj(lim.fin)}` : '— (no hay pitido de cierre: ¿se cortó la grabación?)'}`);
    md.push(`- Silencios largos (≥${config.silencios.min} s, se recortan solos): ${silencios.length}${silencios.length ? ` · ${silencios.slice(0, 6).map((s) => reloj(s.desde)).join(', ')}${silencios.length > 6 ? '…' : ''}` : ''}`);
    for (const b of brillos) md.push(`- ⚠ Cambio de brillo en ${b.archivo} a los ${b.t.toFixed(1)} s (de ${b.de} a ${b.a}): ¿luz encendida o expuesto distinto al inicio?`);
    if (marcas.length) {
      md.push('- Propuestas de corte (charla técnica y tramos ✂ marcados en vivo):');
      for (const m of marcas) {
        md.push(`  - **${m.id}** ${reloj(m.desde)} → ${reloj(m.hasta)} (${(m.hasta - m.desde).toFixed(0)} s) · ${m.tipos.join('+')} · «${m.texto.slice(0, 70)}»`
          + `${m.aviso ? ` · ⚠ ${m.aviso}` : ''}${m.enVivo && m.contexto ? ` · se dice: «${m.contexto.slice(0, 160)}»` : ''}`);
      }
    } else {
      md.push(`- Propuestas de corte: ninguna${existe(`${base}.json`) ? '' : ' (sin transcripción)'}`);
    }
    if (momentos.length) {
      md.push('- ★ Momentos buenos marcados en vivo (lo de justo antes de la marca):');
      for (const x of momentos) md.push(`  - ${reloj(x.t)} · ${x.nombre}${x.texto ? ` · «${x.texto}»` : ''}`);
    }
    if (paraRevisar.length) {
      md.push('- ✂ marcados en vivo sin tramo (dos pulsaciones seguidas): revisa lo de justo antes:');
      for (const x of paraRevisar) md.push(`  - ${reloj(x.t)} · ${x.nombre}${x.texto ? ` · «${x.texto}»` : ''}`);
    }
    md.push('');
  }
  md.unshift(`# Propuesta · ${propuesta.episodio} · ${reloj(total)} en ${partes.length} parte(s)`, '');
  md.push('Lo que NO propongo (decides tú): tangentes, partes flojas, qué sobra del contenido.');
  md.push('Para aplicar propuestas: `node cli.js aprobar <carpeta> 1.1 2.1`   ·   para montar: `node cli.js episodio <carpeta>`');
  escribirJson(path.join(r.montaje, 'propuesta.json'), propuesta);
  fs.writeFileSync(path.join(r.montaje, 'propuesta.md'), `${md.join('\n')}\n`, 'utf8');
  marcarFase(r, 'analisis-listo');
  return { texto: md.join('\n'), propuesta };
}

// ------------------------------------------------------------------ aprobar
function aprobar(carpeta, ids) {
  const r = EP.rutas(carpeta);
  const pf = path.join(r.montaje, 'propuesta.json');
  if (!existe(pf)) throw new Error('no hay propuesta: ejecuta primero  node cli.js analizar <carpeta>');
  const propuesta = leerJson(pf);
  // Los cortes son de ESTE episodio: van a su propio episodio.json, nunca al de la raíz (que es de
  // todos los episodios y se aplicaría también a los siguientes).
  const destino = EP.archivoDelEpisodio(r.base);
  const actual = EP.leerConfig(destino) || JSON.parse(JSON.stringify(EP.PLANTILLA_EPISODIO));
  actual.partes = actual.partes || {};
  const hechos = [];
  for (const id of ids) {
    const [p] = String(id).split('.');
    const m = ((propuesta.partes[p] || {}).marcas || []).find((x) => x.id === String(id));
    if (!m) throw new Error(`no existe la propuesta ${id}. Las hay: ${Object.values(propuesta.partes).flatMap((x) => x.marcas.map((y) => y.id)).join(', ') || '(ninguna)'}`);
    const parte = (actual.partes[p] = actual.partes[p] || {});
    parte.cortes = parte.cortes || [];
    const yaEsta = parte.cortes.some((c) => Array.isArray(c) && Math.abs(Number(c[0]) - m.desde) < 0.5);
    // La nota (tercer elemento) dice de dónde sale el corte; el montaje solo usa los dos tiempos.
    if (!yaEsta) parte.cortes.push([m.desde, m.hasta, `${id} ${m.tipos.join('+')}: ${m.texto}`.slice(0, 120)]);
    hechos.push(`${id}: parte ${p}, ${reloj(m.desde)} → ${reloj(m.hasta)}${yaEsta ? ' (ya estaba)' : ''}`);
  }
  escribirJson(destino, actual);
  return { destino, hechos };
}

// ------------------------------------------------------------------ verificar
function ffmpegTexto(args) {
  const res = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  return `${res.stdout || ''}${res.stderr || ''}`;
}

function transcribirFragmento(final, desde, dur, config) {
  const aj = TR.ajustes(config);
  if (TR.comprobar(aj).length) return null;
  const tmp = path.join(require('node:os').tmpdir(), `verif-${process.pid}-${Math.round(desde)}.wav`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(desde), '-t', String(dur), '-i', final, '-vn', '-ac', '1', '-ar', '16000', tmp]);
  const res = spawnSync(aj.cli, ['-m', aj.modelo, '-f', tmp, '-l', aj.idioma, '-fa', '-np', '-nt', ...(aj.extra || []).map(String)], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  fs.rmSync(tmp, { force: true });
  return A.norm(res.stdout || '');
}

/** ¿Cuántas de las palabras esperadas aparecen en el texto oído? */
function coincidencia(esperadas, oido) {
  const set = new Set(String(oido).split(' '));
  const lista = esperadas.map(A.norm).filter(Boolean);
  if (!lista.length) return 1;
  return lista.filter((w) => set.has(w)).length / lista.length;
}

function verificar(carpeta) {
  const r = EP.rutas(carpeta);
  const nombre = path.basename(r.base);
  const final = path.join(r.entrega, `${nombre}.mp4`);
  const { config } = EP.cargarConfig(r.base);
  const lineas = [];
  let fallos = 0;
  const ok = (cond, bien, mal) => { lineas.push(`${cond ? '✔' : '✘'} ${cond ? bien : mal}`); if (!cond) fallos += 1; };
  const aviso = (txt) => lineas.push(`· ${txt}`);

  if (!existe(final)) throw new Error(`no existe el vídeo final: ${final}`);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,width,height', '-of', 'json', final], { encoding: 'utf8' });
  const info = JSON.parse(probe.stdout || '{}');
  const dur = Number(info.format && info.format.duration) || 0;
  const rec = existe(path.join(r.montaje, 'episodio.json')) ? leerJson(path.join(r.montaje, 'episodio.json')) : null;
  const origenBruto = path.join(r.montaje, 'episodio-bruto.origen');
  const desdeProyecto = existe(origenBruto) && fs.readFileSync(origenBruto, 'utf8').trim() === 'proyecto';
  if (rec && desdeProyecto) {
    aviso(`duración ${reloj(dur)} (renderizado desde el proyecto retocado en Kdenlive: no se compara con la receta, que dura ${reloj(CUT.duracionFrames(rec) / Number(rec.project.fps))})`);
  } else if (rec) {
    const esperada = CUT.duracionFrames(rec) / Number(rec.project.fps);
    ok(Math.abs(dur - esperada) <= 1.5, `duración ${reloj(dur)} (esperada ${reloj(esperada)})`, `duración ${reloj(dur)} pero el proyecto dura ${reloj(esperada)}`);
  } else aviso(`duración ${reloj(dur)} (no hay proyecto con qué comparar)`);
  const v = (info.streams || []).find((s) => s.width);
  ok(!!v && !!(info.streams || []).find((s) => s.codec_name === 'aac'), `formato ${v ? `${v.width}x${v.height}` : '?'} con audio`, 'falta el vídeo o el audio');

  const eb = ffmpegTexto(['-hide_banner', '-nostats', '-i', final, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const lufs = Number((/I:\s+(-?[\d.]+) LUFS/.exec(eb.split('Summary:')[1] || '') || [])[1]);
  ok(Number.isFinite(lufs) && Math.abs(lufs - config.lufsEntrega) <= 1, `sonido ${lufs} LUFS (objetivo ${config.lufsEntrega})`, `sonido ${lufs} LUFS, lejos del objetivo ${config.lufsEntrega}`);

  // Sin pitidos de claqueta ni silencio de más al final.
  const cola = A.pcm(final, Math.max(0, dur - 4), 4);
  const inicio = A.pcm(final, 0, 4);
  ok(!(cola && A.pitidos(cola, 0).length) && !(inicio && A.pitidos(inicio, 0).length), 'sin pitidos de claqueta al principio ni al final', 'queda un pitido de claqueta en el vídeo');
  if (cola) {
    const env = A.energia(cola);
    const umbral = Math.max(...env) - 45;
    let ult = env.length - 1;
    while (ult > 0 && env[ult] < umbral) ult -= 1;
    const silencio = (env.length - 1 - ult) * 0.05;
    ok(silencio <= 0.8, `termina ${silencio.toFixed(1)} s después de la última voz`, `quedan ${silencio.toFixed(1)} s de silencio al final`);
  }

  // Principio y final: se transcribe y se compara con lo que debía decirse.
  const partes = EP.agruparPartes(r.originales);
  const primera = partes[0];
  const ultima = partes[partes.length - 1];
  const cortado = (p) => { const f = path.join(r.montaje, `parte-${p.id}`, 'multicam-cortado.json'); return existe(f) ? leerJson(f) : null; };
  const pj = (p) => path.join(r.montaje, `transcripcion-parte-${p.id}.json`);
  // El vídeo no debe arrancar con una palabra ya empezada: al principio hay un instante de silencio y luego entra la voz.
  if (inicio) {
    const env = A.energia(inicio);
    const suelo = env.length ? Math.min(...env) : -90;
    const umbral = Math.max(suelo + 14, -50);
    const entra = env.findIndex((db) => db > umbral);
    const t = entra < 0 ? null : entra * 0.05;
    ok(t === null || t >= 0.1, t === null ? 'el principio es silencio (la voz entra después de 4 s)' : `la voz entra a ${t.toFixed(2)} s (no arranca con una palabra a medias)`, 'el vídeo arranca con la voz ya sonando: puede faltar el principio de una palabra');
  }
  const r1 = primera && cortado(primera);
  if (r1 && existe(pj(primera))) {
    const esperadas = A.palabras(pj(primera)).filter((w) => w.a >= (Number(r1.origenReferencia) || 0) - 0.1).slice(0, 7).map((w) => w.w);
    const oido = transcribirFragmento(final, 0, 12, config);
    if (oido === null) aviso('principio no comprobado (no hay Whisper)');
    else { const c = coincidencia(esperadas, oido); ok(c >= 0.6, `empieza con «${esperadas.slice(0, 5).join(' ')}…» (${Math.round(c * 100)} % de coincidencia)`, `el principio no coincide con lo esperado «${esperadas.join(' ')}» (se oye «${oido.slice(0, 60)}»)`); }
  } else aviso('principio no comprobado (falta transcripción o receta cortada)');
  const cfgUlt = EP.configDeParte(config, ultima && ultima.id);
  const rU = ultima && cortado(ultima);
  if (rU && existe(pj(ultima)) && !(cfgUlt.insertar || []).length && !(cfgUlt.alFinal || []).length) {
    // Fin en el reloj de la llamada: el de la receta SIN cortar (los cortes del medio no cambian dónde acaba).
    const sinCortar = path.join(r.montaje, `parte-${ultima.id}`, 'multicam.json');
    const rSin = existe(sinCortar) ? leerJson(sinCortar) : rU;
    const fin = (Number(rSin.origenReferencia) || 0) + CUT.duracionFrames(rSin) / Number(rSin.project.fps);
    const esperadas = A.palabras(pj(ultima)).filter((w) => w.b <= fin + 0.1).slice(-6).map((w) => w.w);
    const oido = transcribirFragmento(final, Math.max(0, dur - 10), 10, config);
    if (oido === null) aviso('final no comprobado (no hay Whisper)');
    else { const c = coincidencia(esperadas, oido); ok(c >= 0.5, `termina con «…${esperadas.slice(-4).join(' ')}» (${Math.round(c * 100)} % de coincidencia)`, `el final no coincide con lo esperado «${esperadas.join(' ')}» (se oye «${oido.slice(-60)}»)`); }
  } else aviso('final no comprobado (tramos insertados o sin transcripción)');
  return { lineas, fallos };
}

module.exports = {
  marcarFase, estado, huellaDeParte, llamadaDe, resolverLimites, resolverCortesTexto, sueloDeRuido, confirmarSilencios,
  analizar, aprobar, verificar, coincidencia, tiempoASeg, marcasEnVivo, guiasDeMarcas, textoEntre, CORTE_EN_VIVO_MINIMO,
};
