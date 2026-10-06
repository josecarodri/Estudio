/*
 * Transcripción de la llamada de cada parte, con whisper.cpp (local, gratis, sin subir
 * nada). Sirve para decidir cortes leyendo, en vez de oyendo.
 *
 * Los tiempos salen en el reloj de la llamada, que es el mismo en el que se escriben los
 * cortes de episodio.json: lo que se lee en la transcripción se puede cortar tal cual.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DIR_WHISPER = 'D:/Datos/Herramientas/whisper';
const POR_DEFECTO = {
  cli: `${DIR_WHISPER}/bin12/Release/whisper-cli.exe`,
  modelo: `${DIR_WHISPER}/ggml-large-v3-turbo-q5_0.bin`,
  idioma: 'es',
  // Argumentos de más para whisper-cli, sin tocar el código. Por ejemplo, con el modelo de voz de
  // Silero descargado, ["--vad", "--vad-model", "D:/Datos/Herramientas/whisper/ggml-silero-v5.1.2.bin"]
  // salta los silencios: más rápido y sin frases inventadas en ellos.
  extra: [],
};

function ajustes(config) {
  return { ...POR_DEFECTO, ...((config && config.whisper) || {}) };
}

function reloj(seg) {
  const t = Math.max(0, Math.round(seg));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/* Comprueba que están el programa y el modelo, y dice qué falta. */
function comprobar(aj) {
  const faltan = [];
  if (!fs.existsSync(aj.cli)) faltan.push(`el programa ${aj.cli}`);
  if (!fs.existsSync(aj.modelo)) faltan.push(`el modelo ${aj.modelo}`);
  return faltan;
}

/*
 * Transcribe un archivo de audio o vídeo. Devuelve { segmentos: [{desde, hasta, texto}] }
 * y deja el texto y el JSON junto a `salidaBase`.
 */
function transcribir(archivo, salidaBase, config) {
  const aj = ajustes(config);
  const faltan = comprobar(aj);
  if (faltan.length) return { error: `falta ${faltan.join(' y ')}.` };

  fs.mkdirSync(path.dirname(salidaBase), { recursive: true });
  const wav = path.join(os.tmpdir(), `transcribir-${process.pid}-${Date.now()}.wav`);
  try {
    const dec = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', archivo, '-vn', '-ac', '1', '-ar', '16000', wav],
      { encoding: 'utf8' });
    if (dec.status !== 0) return { error: `ffmpeg no pudo leer el audio: ${(dec.stderr || '').trim()}` };

    const res = spawnSync(aj.cli, [
      '-m', aj.modelo, '-f', wav, '-l', aj.idioma, '-fa', '-ojf', '-of', salidaBase, ...(aj.extra || []).map(String),
    ], { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 4 * 3600 * 1000 });
    if (res.status !== 0) {
      return { error: `whisper falló: ${(res.stderr || res.error || '').toString().split('\n').slice(-6).join('\n')}` };
    }
  } finally {
    fs.rmSync(wav, { force: true });
  }

  const jsonFile = `${salidaBase}.json`;
  const datos = JSON.parse(fs.readFileSync(jsonFile, 'utf8'));
  const segmentos = (datos.transcription || []).map((s) => ({
    desde: s.offsets.from / 1000,
    hasta: s.offsets.to / 1000,
    texto: String(s.text || '').trim(),
  })).filter((s) => s.texto);

  const lineas = segmentos.map((s) => `[${reloj(s.desde)} → ${reloj(s.hasta)}] ${s.texto}`);
  fs.writeFileSync(`${salidaBase}.txt`, `${lineas.join('\n')}\n`, 'utf8');
  return { segmentos, texto: `${salidaBase}.txt`, json: jsonFile };
}

module.exports = { POR_DEFECTO, ajustes, comprobar, transcribir, reloj };
