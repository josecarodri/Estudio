'use strict';
/*
 * Registro del lado del navegador. Envía al servidor (que lo guarda en logs/) lo que le pasa a esta página:
 * conexión de la sala y de la llamada, errores, si la pestaña se oculta o se congela, y un «latido» cada
 * 30 s con el estado de la grabación y la memoria. Si la página muere de golpe, el último latido dice
 * cuándo y en qué estado estaba; es lo que faltaba para poder explicar una caída.
 *
 * Todo es opcional: si algo falla aquí, no afecta a la grabación.
 */
(function () {
  const COLA_MAX = 500;
  const CADA_LATIDO_MS = 30000;
  const CADA_ENVIO_MS = 5000;

  let cola = [];
  let ctx = null;
  let latidoFn = null;

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
      if (ev === 'error' || ev === 'pagehide') volcar(ev === 'pagehide');   // lo grave se manda enseguida
    } catch { /* sin registro */ }
  }

  async function volcar(conBeacon) {
    if (!ctx || !cola.length) return;
    const lote = cola.splice(0, 200);
    const cuerpo = JSON.stringify({ peer: ctx.peer, nombre: ctx.nombre, eventos: lote });
    const url = `/api/rooms/${encodeURIComponent(ctx.room)}/log`;
    try {
      if (conBeacon && navigator.sendBeacon) {
        if (!navigator.sendBeacon(url, new Blob([cuerpo], { type: 'application/json' }))) cola = lote.concat(cola);
        return;
      }
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: cuerpo, keepalive: cuerpo.length < 60000 });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
    } catch {
      cola = lote.concat(cola).slice(-COLA_MAX);       // se reintenta en el siguiente envío
    }
  }

  function latido() {
    const m = performance.memory;
    anotar('latido', {
      ...(latidoFn ? latidoFn() : {}),
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
