// Sincronización de reloj con el servidor (estilo NTP simplificado).
// Se usa tanto en el navegador (window.Clock) como en las pruebas de Node (module.exports).
(function (root) {
  'use strict';

  /**
   * A partir de varias muestras {t0, server, t1} (hora local al enviar, hora del servidor, hora local al recibir)
   * elige la de menor ida y vuelta y devuelve el desfase servidor - local.
   */
  function computeOffset(samples) {
    const valid = samples.filter((s) => s && s.t1 >= s.t0 && Number.isFinite(s.server));
    if (!valid.length) throw new Error('Sin muestras de reloj');
    const best = valid.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
    const rtt = best.t1 - best.t0;
    return { offset: best.server - (best.t0 + rtt / 2), rtt };
  }

  function localNow() {
    return performance.timeOrigin + performance.now();
  }

  /** Mide el desfase contra /api/time con n peticiones. */
  async function sync(n = 10) {
    const samples = [];
    for (let i = 0; i < n; i++) {
      const t0 = localNow();
      const r = await fetch('/api/time', { cache: 'no-store' });
      const { now } = await r.json();
      samples.push({ t0, server: now, t1: localNow() });
    }
    return computeOffset(samples);
  }

  const api = { computeOffset, localNow, sync };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Clock = api;
})(typeof self !== 'undefined' ? self : this);
