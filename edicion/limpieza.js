/*
 * Limpiar el disco cuando el episodio ya está hecho. Se borra lo que se puede volver a generar: el render
 * en bruto, el vídeo de revisión y sus trozos, los intermedios de los shorts, los micros limpiados, la
 * llamada unida y los temporales. Con `estudio`, también las grabaciones del Estudio que ya están copiadas
 * en originales/ (archivo a archivo, con el mismo tamaño). Nunca toca originales/, entrega/, los proyectos
 * de Kdenlive (ni sus copias de lo retocado a mano) ni la configuración.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const tam = (ruta) => {
  let total = 0;
  const st = fs.statSync(ruta);
  if (!st.isDirectory()) return st.size;
  for (const e of fs.readdirSync(ruta)) total += tam(path.join(ruta, e));
  return total;
};
const hay = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const lista = (dir) => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } };

/*
 * Qué se puede borrar. r: las rutas del episodio (episodio.rutas). `estudio`: la carpeta de grabaciones del
 * Estudio (o null para no mirarla). Devuelve [{ ruta, bytes, motivo }].
 */
function queBorrar(r, { estudio } = {}) {
  const out = [];
  const poner = (ruta, motivo) => { if (hay(ruta)) out.push({ ruta, bytes: tam(ruta), motivo }); };
  poner(path.join(r.montaje, 'episodio-bruto.mp4'), 'render en bruto (el final ya está en entrega/)');
  poner(path.join(r.montaje, 'episodio-bruto.origen'), 'render en bruto');
  poner(path.join(r.montaje, 'revision'), 'trozos del vídeo de revisión');
  poner(path.join(r.montaje, 'revision.mp4'), 'vídeo de revisión');
  poner(path.join(r.montaje, 'shorts'), 'intermedios de los shorts (los shorts están en entrega/shorts/)');
  for (const e of lista(path.join(r.montaje, 'audio'))) {
    if (e.isFile() && /\.limpio-[0-9a-f]+\.wav$/.test(e.name)) poner(path.join(r.montaje, 'audio', e.name), 'micro limpiado (se rehace si hace falta)');
  }
  for (const e of lista(r.montaje)) {
    if (e.isDirectory() && /^parte-\d+$/.test(e.name)) poner(path.join(r.montaje, e.name, 'llamada-unida.wav'), 'llamada unida (se rehace si hace falta)');
    if (e.isFile() && /\.tmp\.(mp4|mov|wav)$/.test(e.name)) poner(path.join(r.montaje, e.name), 'temporal de un proceso cortado');
  }
  if (estudio) out.push(...copiasEnElEstudio(r, estudio));
  return out;
}

/*
 * Grabaciones del Estudio que ya están en originales/: para cada sesión importada (originales/<sesión>/),
 * los archivos de grabaciones/<sala>/<sesión>/ con una copia del mismo tamaño en originales/. Si están
 * todos, la carpeta entera de la sesión.
 */
function copiasEnElEstudio(r, estudio) {
  const out = [];
  for (const sesion of lista(r.originales).filter((e) => e.isDirectory())) {
    for (const sala of lista(estudio).filter((e) => e.isDirectory())) {
      const dir = path.join(estudio, sala.name, sesion.name);
      if (!hay(path.join(dir, 'session.json'))) continue;
      const archivos = lista(dir).filter((e) => e.isFile() && e.name !== 'session.json');
      const copiados = archivos.filter((e) => {
        const copia = path.join(r.originales, sesion.name, e.name);
        return hay(copia) && fs.statSync(copia).size === fs.statSync(path.join(dir, e.name)).size;
      });
      const motivo = `grabación del Estudio ya copiada en originales/${sesion.name}`;
      if (copiados.length && copiados.length === archivos.length) out.push({ ruta: dir, bytes: tam(dir), motivo });
      else for (const e of copiados) out.push({ ruta: path.join(dir, e.name), bytes: fs.statSync(path.join(dir, e.name)).size, motivo });
    }
  }
  return out;
}

/* Borra lo de la lista. Devuelve { bytes, errores }. */
function borrar(cosas) {
  let bytes = 0;
  const errores = [];
  for (const c of cosas) {
    try {
      fs.rmSync(c.ruta, { recursive: true, force: true });
      bytes += c.bytes;
    } catch (e) {
      errores.push(`${c.ruta}: ${e.message}`);
    }
  }
  return { bytes, errores };
}

module.exports = { queBorrar, copiasEnElEstudio, borrar };
