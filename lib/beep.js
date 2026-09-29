'use strict';
// Detección de la claqueta digital (pitido de 1 kHz) en audio PCM mono.

/** Potencia de la frecuencia `freq` en x[from..from+n) mediante el algoritmo de Goertzel. */
function goertzel(x, from, n, freq, sampleRate) {
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0; let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = x[from + i] + coeff * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/**
 * Busca el inicio del pitido. Devuelve el tiempo en segundos o null.
 * @param {Float32Array|number[]} x muestras en [-1, 1]
 * @param {number} sampleRate
 * @param {object} [o] { freq=1000, minDurSec=0.15, win=0.005 }
 */
function findBeep(x, sampleRate, o = {}) {
  const freq = o.freq || 1000;
  const n = Math.max(16, Math.round(sampleRate * (o.win || 0.005)));
  const minWins = Math.ceil((o.minDurSec || 0.15) / (n / sampleRate));
  let run = 0; let runStart = -1;
  for (let w = 0; (w + 1) * n <= x.length; w++) {
    const from = w * n;
    let energy = 0;
    for (let i = 0; i < n; i++) energy += x[from + i] * x[from + i];
    // Para un tono puro, la potencia de Goertzel ≈ energía · n / 2.
    const tone = goertzel(x, from, n, freq, sampleRate);
    const ratio = energy > 0 ? tone / (energy * n / 2) : 0;
    const rms = Math.sqrt(energy / n);
    const isTone = ratio > 0.6 && rms > 0.05;
    if (isTone) {
      if (run === 0) runStart = w;
      run++;
      if (run >= minWins) return refineOnset(x, runStart * n, n, freq, sampleRate) / sampleRate;
    } else {
      run = 0;
    }
  }
  return null;
}

/**
 * Afina el inicio con una ventana deslizante de muestra en muestra: con un tono puro la amplitud
 * detectada crece en proporción al solape, así que el 50 % de amplitud (25 % de potencia)
 * se alcanza cuando la ventana cubre media ventana de pitido.
 */
function refineOnset(x, firstToneWin, n, freq, sampleRate) {
  const ref = firstToneWin + 2 * n;
  if (ref + n > x.length) return firstToneWin;
  const steady = goertzel(x, ref, n, freq, sampleRate);
  for (let s = Math.max(0, firstToneWin - 2 * n); s <= firstToneWin + n; s++) {
    if (goertzel(x, s, n, freq, sampleRate) >= steady * 0.25) return s + n / 2;
  }
  return firstToneWin;
}

module.exports = { goertzel, findBeep };
