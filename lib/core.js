'use strict';
// Utilidades puras del servidor (sin E/S salvo las funciones de WAV que reciben un descriptor).
const fs = require('fs');

/** Convierte un texto libre en un nombre seguro para carpetas/archivos. */
function slug(text, fallback = 'x') {
  const s = String(text || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || fallback;
}

/** Identificador de sesión legible y ordenable: 2026-09-29_15-30-05 (hora local del servidor). */
function sessionIdFromDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Cabecera WAV PCM de 16 bits (44 bytes). dataBytes puede ser 0 y parchearse después. */
function wavHeader(sampleRate, channels, dataBytes) {
  const b = Buffer.alloc(44);
  const blockAlign = channels * 2;
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(Math.min(36 + dataBytes, 0xffffffff), 4);
  b.write('WAVE', 8, 'ascii');
  b.write('fmt ', 12, 'ascii');
  b.writeUInt32LE(16, 16);            // tamaño del bloque fmt
  b.writeUInt16LE(1, 20);             // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * blockAlign, 28);
  b.writeUInt16LE(blockAlign, 32);
  b.writeUInt16LE(16, 34);            // bits por muestra
  b.write('data', 36, 'ascii');
  b.writeUInt32LE(Math.min(dataBytes, 0xffffffff), 40);
  return b;
}

/** Reescribe los tamaños de la cabecera WAV según el tamaño real del archivo. */
function fixWavHeader(file) {
  const size = fs.statSync(file).size;
  if (size < 44) return;
  const dataBytes = size - 44;
  const fd = fs.openSync(file, 'r+');
  try {
    const riff = Buffer.alloc(4); riff.writeUInt32LE(Math.min(36 + dataBytes, 0xffffffff));
    const data = Buffer.alloc(4); data.writeUInt32LE(Math.min(dataBytes, 0xffffffff));
    fs.writeSync(fd, riff, 0, 4, 4);
    fs.writeSync(fd, data, 0, 4, 40);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Decide qué hacer con un trozo que llega para una pista.
 * Los trozos deben llegar en orden; los repetidos se ignoran (reintentos idempotentes).
 */
function chunkDecision(nextSeq, seq) {
  if (!Number.isInteger(seq) || seq < 0) return 'invalid';
  if (seq < nextSeq) return 'duplicate';
  if (seq === nextSeq) return 'append';
  return 'gap';
}

/** Extensión de archivo a partir del tipo MIME que produjo MediaRecorder. */
function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/mp4') || m.startsWith('audio/mp4')) return m.startsWith('audio') ? 'm4a' : 'mp4';
  if (m.startsWith('video/webm')) return 'webm';
  if (m.startsWith('audio/webm')) return 'webm';
  if (m.startsWith('audio/wav') || m.startsWith('audio/pcm')) return 'wav';
  return 'bin';
}

module.exports = { slug, sessionIdFromDate, wavHeader, fixWavHeader, chunkDecision, extFromMime };
