// Sincronización de reloj con el servidor (estilo NTP simplificado).
// Se usa tanto en el navegador (window.Clock) como en las pruebas de Node (module.exports).
//
// Se van acumulando muestras {t0, server, t1} (hora local al enviar, hora de referencia, hora local al recibir)
// de las últimas WINDOW_MS y se usa la de menor ida y vuelta: por internet la latencia varía mucho y la muestra
// más rápida es la más fiable. La ventana es corta para que la deriva de los relojes no acumule error.
(function (root) {
  'use strict';

  const WINDOW_MS = 60000;
  const pool = [];

  /** Desfase (referencia - local) a partir de la muestra con menor ida y vuelta. */
  function computeOffset(samples) {
    const valid = samples.filter((s) => s && s.t1 >= s.t0 && Number.isFinite(s.server));
    if (!valid.length) throw new Error('Sin muestras de reloj');
    const best = valid.reduce((a, b) => (b.t1 - b.t0 < a.t1 - a.t0 ? b : a));
    const rtt = best.t1 - best.t0;
    return { offset: best.server - (best.t0 + rtt / 2), rtt, source: best.source || 'servidor' };
  }

  function localNow() {
    return performance.timeOrigin + performance.now();
  }

  function prune(nowMs) {
    while (pool.length && pool[0].t1 < nowMs - WINDOW_MS) pool.shift();
  }

  /** Añade una muestra (del servidor o de la otra persona por la conexión directa). */
  function addSample(s) {
    pool.push(s);
    pool.sort((a, b) => a.t1 - b.t1);
    prune(localNow());
  }

  function estimate() {
    prune(localNow());
    return computeOffset(pool);
  }

  /** Toma n muestras contra /api/time y devuelve la estimación actualizada. */
  async function sample(n = 3) {
    for (let i = 0; i < n; i++) {
      const t0 = localNow();
      const r = await fetch('/api/time', { cache: 'no-store' });
      const { now } = await r.json();
      addSample({ t0, server: now, t1: localNow(), source: 'servidor' });
    }
    return estimate();
  }

  const api = { computeOffset, localNow, addSample, estimate, sample, sync: sample, _pool: pool };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Clock = api;
})(typeof self !== 'undefined' ? self : this);
