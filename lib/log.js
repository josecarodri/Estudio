'use strict';
/*
 * Registro del Estudio, pensado para poder explicar a posteriori por qué se cayó una llamada
 * o se paró una grabación. Escribe líneas de texto con la hora y quién las genera:
 *
 *   2026-10-03 21:36:50.412 servidor ws-cerrado peer=ce00 nombre=JC codigo=1006 conectado_s=3512
 *   2026-10-03 21:36:41.003 cliente:jc latido rec=si memoria_mb=212 pc=connected ws=1
 *
 * Un archivo por día en la carpeta `logs/`. Nunca lanza errores: un fallo al escribir el registro
 * no debe afectar a una grabación.
 */
const fs = require('fs');
const path = require('path');

const pad = (n, l = 2) => String(n).padStart(l, '0');
const dia = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hora = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;

/** Un valor en una sola línea: números redondeados, textos con espacios entre comillas. */
function valor(v) {
  if (typeof v === 'boolean') return v ? 'si' : 'no';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10);
  const s = String(v).replace(/[\r\n\t]+/g, ' ').slice(0, 200);
  return /[\s="]/.test(s) ? JSON.stringify(s) : s;
}

function formato(datos) {
  return Object.entries(datos || {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${valor(v)}`)
    .join(' ');
}

function crearRegistro(carpetaPorDefecto) {
  const carpeta = () => process.env.LOGS_DIR || carpetaPorDefecto;
  /** Escribe una línea y la devuelve (útil en las pruebas). */
  function escribir(origen, evento, datos) {
    const d = new Date();
    const extra = formato(datos);
    const linea = `${dia(d)} ${hora(d)} ${origen} ${evento}${extra ? ` ${extra}` : ''}\n`;
    try {
      fs.mkdirSync(carpeta(), { recursive: true });
      fs.appendFileSync(path.join(carpeta(), `estudio-${dia(d)}.log`), linea);
    } catch { /* el registro es opcional */ }
    return linea;
  }
  return { escribir, carpeta, archivoDeHoy: () => path.join(carpeta(), `estudio-${dia(new Date())}.log`) };
}

module.exports = { crearRegistro, formato, valor };
