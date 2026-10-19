'use strict';
/*
 * Registro del lado del navegador. Envía al servidor (que lo guarda en logs/) lo que le pasa a esta página:
 * conexión de la sala y de la llamada, errores, si la pestaña se oculta o se congela, y un «latido» cada
 * 30 s con el estado de la grabación y la memoria. Si la página muere de golpe, el último latido dice
 * cuándo y en qué estado estaba; es lo que faltaba para poder explicar una caída.
 *
 * Todo es opcional: si algo falla aquí, no afecta a la grabación.
 *
 * Los envíos normales (cada 5 s) son peticiones corrientes, uno a la vez y con un tiempo máximo. «keepalive» y
 * sendBeacon solo al ocultarse o cerrarse la página: el navegador deja como mucho 64 KiB de esos en vuelo y, si se
 * agotan, los rechaza todos. El 2026-10-18 pasó eso en el PC de JC (Edge) y el registro no llegó en 70 minutos.
 */
(function () {
  const COLA_MAX = 500;
  const CADA_LATIDO_MS = 30000;
  const CADA_ENVIO_MS = 5000;
  const ENVIO_MAX_MS = 15000;          // si el servidor no contesta en este tiempo, se corta y se reintenta
  const LOTE_MAX = 200;                // eventos por envío: el servidor no guarda más
  const LOTE_MAX_BYTES = 30000;        // con margen bajo los 64 KiB que admite el envío al cerrar

  let cola = [];
  let ctx = null;
  let latidoFn = null;
  let enVuelo = null;                  // lote del envío normal que aún no ha contestado
  let atasco = null;                   // { desde, fallos, error } mientras los envíos fallan

  const hora = () => {
    const d = new Date();
    const p = (n, l = 2) => String(n).padStart(l, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  /** Solo valores simples: el servidor descarta lo demás. */
  function simple(d) {
    const out = {};
    for (const [k, v] of Object.entries(d || {})) {
      if (v === undefined || v === null) continue;
      if (typeof v === 'number') out[k] = Number.isFinite(v) ? v : String(v);
      else if (typeof v === 'boolean') out[k] = v;
      else out[k] = String(v).slice(0, 160);
    }
    return out;
  }

  function anotar(ev, d) {
    try {
      cola.push({ ev, hora: hora(), d: simple(d) });
      if (cola.length > COLA_MAX) cola = cola.slice(-COLA_MAX);
      if (ev === 'error' || ev === 'pagehide') volcar(ev === 'pagehide' && 'cierre');   // lo grave se manda enseguida
    } catch { /* sin registro */ }
  }

  /** Lo más antiguo de `de` que cabe en un envío. */
  function lote(de) {
    let n = 0;
    let bytes = 0;
    while (n < de.length && n < LOTE_MAX) {
      bytes += JSON.stringify(de[n]).length + 1;
      if (n && bytes > LOTE_MAX_BYTES) break;
      n += 1;
    }
    return de.slice(0, n);
  }

  const cuerpo = (eventos) => JSON.stringify({ peer: ctx.peer, nombre: ctx.nombre, eventos });
  const urlLog = () => `/api/rooms/${encodeURIComponent(ctx.room)}/log`;

  /**
   * Manda lo pendiente. `alSalir` (la página se oculta o se cierra): sendBeacon, que sigue aunque la página muera.
   * Si no, una petición normal: una a la vez y cortada a los ENVIO_MAX_MS, así un envío colgado no para a los demás.
   */
  async function volcar(alSalir) {
    if (!ctx) return;
    if (alSalir) {
      // Al cerrarse se pierde el envío normal que esté en marcha: va también aquí (mejor repetido que perdido).
      const conEnVuelo = alSalir === 'cierre' && !!enVuelo;
      const l = lote(conEnVuelo ? enVuelo.concat(cola) : cola);
      if (!l.length || !navigator.sendBeacon) return;
      try {
        if (navigator.sendBeacon(urlLog(), new Blob([cuerpo(l)], { type: 'application/json' }))) {
          cola = cola.filter((e) => !l.includes(e));
          if (conEnVuelo && enVuelo) enVuelo = [];   // ya va en la baliza: si el envío falla, no se repite
        }
      } catch { /* queda para el envío normal */ }
      return;
    }
    if (enVuelo || !cola.length) return;
    const l = lote(cola);
    cola = cola.slice(l.length);
    enVuelo = l;
    const corte = new AbortController();
    const reloj = setTimeout(() => corte.abort(), ENVIO_MAX_MS);
    try {
      const r = await fetch(urlLog(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo(l), signal: corte.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      enVuelo = null;
      if (atasco) {
        const a = atasco;
        atasco = null;
        anotar('registro-atasco', a);                  // cuánto tiempo y por qué no llegó el registro
      }
    } catch (e) {
      cola = enVuelo.concat(cola).slice(-COLA_MAX);    // se reintenta en el siguiente envío
      enVuelo = null;
      atasco = atasco || { desde: hora(), fallos: 0 };
      atasco.fallos += 1;
      atasco.error = corte.signal.aborted ? `sin respuesta en ${ENVIO_MAX_MS / 1000} s` : String(e?.message || e);
    } finally {
      clearTimeout(reloj);
    }
  }

  function latido() {
    const m = performance.memory;
    anotar('latido', {
      ...(latidoFn ? latidoFn() : {}),
      registro_cola: cola.length,
      oculta: document.hidden,
      memoria_mb: m ? Math.round(m.usedJSHeapSize / 1048576) : undefined,
      memoria_limite_mb: m ? Math.round(m.jsHeapSizeLimit / 1048576) : undefined,
    });
  }

  function iniciar({ room, peer, nombre, latido: fn }) {
    if (ctx) return;
    ctx = { room, peer, nombre };
    latidoFn = fn;
    const c = navigator.connection;
    anotar('pagina', {
      ua: navigator.userAgent,
      pantalla: `${screen.width}x${screen.height}@${window.devicePixelRatio}`,
      nucleos: navigator.hardwareConcurrency,
      memoria_gb: navigator.deviceMemory,
      red: c ? `${c.effectiveType || ''} ${c.downlink ?? ''}Mbps rtt${c.rtt ?? ''}` : undefined,
    });
    setInterval(latido, CADA_LATIDO_MS);
    setInterval(() => volcar(false), CADA_ENVIO_MS);
    c?.addEventListener?.('change', () => anotar('red', { tipo: c.effectiveType, bajada_mbps: c.downlink, rtt_ms: c.rtt }));
  }

  // Estos avisos se recogen desde el principio, también antes de entrar en la sala.
  window.addEventListener('error', (e) => anotar('error', { mensaje: e.message, archivo: String(e.filename || '').split('/').pop(), linea: e.lineno, columna: e.colno }));
  window.addEventListener('unhandledrejection', (e) => anotar('error', { mensaje: `promesa rechazada: ${e.reason?.message || e.reason}` }));
  window.addEventListener('online', () => anotar('red', { estado: 'conectada' }));
  window.addEventListener('offline', () => anotar('red', { estado: 'sin conexión' }));
  document.addEventListener('visibilitychange', () => {
    anotar('visibilidad', { oculta: document.hidden });
    if (document.hidden) volcar(true);
  });
  window.addEventListener('pagehide', (e) => anotar('pagehide', { persistida: e.persisted }));
  document.addEventListener('freeze', () => anotar('congelada'));
  document.addEventListener('resume', () => anotar('reanudada'));

  window.Registro = { iniciar, anotar, volcar, latido };
})();
