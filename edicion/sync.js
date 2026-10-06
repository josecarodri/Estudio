/*
 * Sincronización de audio por correlación cruzada.
 *
 * Para un multicámara hay que saber cuánto después empezó cada archivo. Se resuelve
 * comparando la *envolvente* de energía de cada pista con la de una referencia: la
 * envolvente aguanta bien que cada micro suene distinto (timbre y nivel diferentes),
 * mientras que comparar la onda cruda solo funciona si es literalmente el mismo audio.
 *
 * Resolución: una muestra de envolvente cada 10 ms, que a 30 fps es menos de un frame.
 * La correlación se hace con FFT, así que una sesión de una hora se resuelve en un
 * instante en lugar de en minutos.
 *
 * Solo necesita ffmpeg; nada de dependencias de Node.
 */
'use strict';

const { spawnSync } = require('node:child_process');

const SAMPLE_RATE = 8000;   // suficiente para la energía de la voz
const BIN_HZ = 100;         // una muestra de envolvente cada 10 ms
const ANALYZE_SECONDS = 600; // cuánto audio se mira; acota la memoria

/* FFT iterativa radix-2 en vectores separados de parte real e imaginaria. */
function fft(re, im, inverse) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const uRe = re[i + k];
        const uIm = im[i + k];
        const vRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const vIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = uRe + vRe;
        im[i + k] = uIm + vIm;
        re[i + k + len / 2] = uRe - vRe;
        im[i + k + len / 2] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/*
 * Envolvente de energía del archivo: un valor RMS cada 10 ms.
 * Devuelve { envelope, seconds } o { error }.
 */
function envelope(file, options) {
  const opts = options || {};
  const seconds = opts.analyzeSeconds || ANALYZE_SECONDS;

  // Sin límite finito se analiza el archivo entero: la sincronización se resuelve
  // con los primeros minutos, pero detectar turnos de palabra necesita todo.
  const limite = Number.isFinite(seconds) ? ['-t', String(seconds)] : [];

  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    ...limite,
    '-i', file,
    '-vn',
    '-ac', '1',
    '-ar', String(SAMPLE_RATE),
    '-f', 's16le',
    '-',
  ], { maxBuffer: 512 * 1024 * 1024, timeout: 600000, encoding: 'buffer' });

  if (res.error) return { error: `ffmpeg no se pudo ejecutar: ${res.error.message}` };
  if (res.status !== 0) {
    return { error: (res.stderr ? res.stderr.toString() : 'ffmpeg falló').trim().split('\n')[0] };
  }

  const pcm = res.stdout;
  const samples = Math.floor(pcm.length / 2);
  if (samples === 0) return { error: 'el archivo no tiene audio' };

  const perBin = Math.round(SAMPLE_RATE / BIN_HZ);
  const bins = Math.floor(samples / perBin);
  if (bins < 10) return { error: 'el audio es demasiado corto para sincronizar' };

  const env = new Float64Array(bins);
  for (let b = 0; b < bins; b += 1) {
    let sum = 0;
    const base = b * perBin;
    for (let k = 0; k < perBin; k += 1) {
      const v = pcm.readInt16LE((base + k) * 2) / 32768;
      sum += v * v;
    }
    env[b] = Math.sqrt(sum / perBin);
  }

  return { envelope: env, seconds: samples / SAMPLE_RATE, binHz: BIN_HZ };
}

/* Centra y normaliza, para que la correlación no dependa del volumen de grabación. */
function normalize(env) {
  const n = env.length;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += env[i];
  mean /= n;
  let variance = 0;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    out[i] = env[i] - mean;
    variance += out[i] * out[i];
  }
  const sd = Math.sqrt(variance / n) || 1;
  for (let i = 0; i < n; i += 1) out[i] /= sd;
  return out;
}

/*
 * Desfase de `other` respecto a `ref`, en segundos.
 *
 * Positivo = `other` empezó DESPUÉS que `ref`, es decir, al tiempo T de la referencia
 * le corresponde el instante T - desfase dentro de `other`.
 *
 * Devuelve { seconds, confidence, peak }. La confianza es cuánto destaca el máximo
 * sobre el resto de la correlación: por debajo de 5 no hay que fiarse.
 */
function offsetBetween(refEnv, otherEnv) {
  const a = normalize(refEnv);
  const b = normalize(otherEnv);
  const n = nextPow2(a.length + b.length);

  const aRe = new Float64Array(n);
  const aIm = new Float64Array(n);
  const bRe = new Float64Array(n);
  const bIm = new Float64Array(n);
  aRe.set(a);
  bRe.set(b);

  fft(aRe, aIm, false);
  fft(bRe, bIm, false);

  // Correlación cruzada = IFFT( A * conj(B) ).
  const cRe = new Float64Array(n);
  const cIm = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    cRe[i] = aRe[i] * bRe[i] + aIm[i] * bIm[i];
    cIm[i] = aIm[i] * bRe[i] - aRe[i] * bIm[i];
  }
  fft(cRe, cIm, true);

  let peak = -Infinity;
  let peakIndex = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i += 1) {
    const v = cRe[i];
    sumSq += v * v;
    if (v > peak) {
      peak = v;
      peakIndex = i;
    }
  }

  // Los índices por encima de n/2 son desfases negativos.
  const lag = peakIndex > n / 2 ? peakIndex - n : peakIndex;
  const rms = Math.sqrt(sumSq / n) || 1;

  /*
   * El máximo real casi nunca cae justo en un bin. Ajustando una parábola a los tres
   * valores de alrededor se afina por debajo de la resolución de la envolvente: se
   * pasa de 10 ms a cosa de 1 ms, que para el labial se nota.
   */
  const anterior = cRe[(peakIndex - 1 + n) % n];
  const siguiente = cRe[(peakIndex + 1) % n];
  const denominador = anterior - 2 * peak + siguiente;
  const ajuste = denominador !== 0
    ? Math.max(-0.5, Math.min(0.5, (0.5 * (anterior - siguiente)) / denominador))
    : 0;

  return {
    seconds: (lag + ajuste) / BIN_HZ,
    confidence: peak / rms,
    peak,
    lagBins: lag,
    ajusteBins: ajuste,
  };
}

/*
 * Sincroniza una lista de archivos contra uno de referencia.
 * Devuelve { byFile: { ruta: { seconds, confidence, error } }, reference }.
 */
function syncFiles(files, reference, options) {
  const opts = options || {};
  const refEnv = envelope(reference, opts);
  if (refEnv.error) {
    throw new Error(`no se pudo analizar la referencia ${reference}: ${refEnv.error}`);
  }

  const byFile = {};
  for (const file of files) {
    if (file === reference) {
      byFile[file] = { seconds: 0, confidence: Infinity, isReference: true };
      continue;
    }
    const env = envelope(file, opts);
    if (env.error) {
      byFile[file] = { error: env.error };
      continue;
    }
    byFile[file] = offsetBetween(refEnv.envelope, env.envelope);
  }

  return { byFile, reference, referenceSeconds: refEnv.seconds };
}

module.exports = {
  SAMPLE_RATE,
  BIN_HZ,
  ANALYZE_SECONDS,
  fft,
  nextPow2,
  envelope,
  normalize,
  offsetBetween,
  syncFiles,
};
