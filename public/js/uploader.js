// Guarda cada trozo de grabación en IndexedDB y lo sube al servidor en orden, con reintentos.
// Si la conexión falla, la grabación sigue a salvo en el dispositivo y se puede reanudar o descargar.
(function () {
  'use strict';

  const DB_NAME = 'estudio-grabaciones';
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('chunks');            // clave: `${trackKey}#${seq}` (seq con ceros)
        db.createObjectStore('tracks', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);           // sin IndexedDB: se trabaja en memoria
    });
    return dbPromise;
  }

  function tx(db, store, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const r = fn(s);
      t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const chunkKey = (trackKey, seq) => `${trackKey}#${String(seq).padStart(7, '0')}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  class TrackUploader {
    /**
     * @param {object} info { room, session, participant, name, device, kind, mime, format, sampleRate, ... }
     */
    constructor(info) {
      this.info = info;
      this.key = `${info.room}/${info.session}/${info.participant}-${info.kind}`;
      this.trackId = `${info.participant}-${info.kind}`;
      this.count = 0;            // trozos producidos
      this.acked = 0;            // trozos confirmados por el servidor
      this.bytesTotal = 0;
      this.bytesAcked = 0;
      this.memory = new Map();   // respaldo si no hay IndexedDB
      this.sizes = new Map();
      this.finishInfo = null;
      this.finished = false;
      this.error = '';
      this.onchange = null;
      this._running = false;
      this._registered = false;
    }

    get label() {
      return { camara: 'Cámara', audio: 'Audio WAV', llamada: 'Llamada' }[this.info.kind] || this.info.kind;
    }

    async _saveMeta() {
      const db = await openDb();
      if (!db) return;
      await tx(db, 'tracks', 'readwrite', (s) => s.put({
        key: this.key, info: this.info, count: this.count, acked: this.acked,
        bytesTotal: this.bytesTotal, finishInfo: this.finishInfo, finished: this.finished, updatedAt: Date.now(),
      }));
    }

    async start() {
      await this._saveMeta();
      this._register().catch(() => {});
    }

    async _register() {
      const r = await fetch('/api/tracks', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(this.info),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      const j = await r.json();
      this.acked = Math.max(this.acked, j.nextSeq);
      this._registered = true;
    }

    /** Añade un trozo (Blob). Se guarda primero en el dispositivo y luego se sube. */
    async push(blob) {
      if (!blob || !blob.size) return;
      const seq = this.count++;
      this.bytesTotal += blob.size;
      this.sizes.set(seq, blob.size);
      const db = await openDb();
      if (db) {
        try { await tx(db, 'chunks', 'readwrite', (s) => s.put(blob, chunkKey(this.key, seq))); }
        catch { this.memory.set(seq, blob); }          // p. ej. cuota llena: se mantiene en memoria
      } else this.memory.set(seq, blob);
      this._saveMeta().catch(() => {});
      this._kick();
    }

    async _getChunk(seq) {
      if (this.memory.has(seq)) return this.memory.get(seq);
      const db = await openDb();
      if (!db) return null;
      return tx(db, 'chunks', 'readonly', (s) => s.get(chunkKey(this.key, seq)));
    }

    _emit() { if (this.onchange) this.onchange(this); }

    _kick() {
      if (this._running) return;
      this._running = true;
      this._loop().finally(() => { this._running = false; this._emit(); });
    }

    /**
     * Hora (del reloj común) a la que empezó de verdad la pista. Se manda en cuanto se sabe, y no solo al
     * cerrarla, para que el servidor la tenga aunque esta página muera: el editor la usa para situar los tramos.
     */
    anotarInicio(startedAtServer) {
      if (!Number.isFinite(startedAtServer)) return;
      this.inicio = startedAtServer;
      this._inicioEnviado = false;
      this._kick();
    }

    async _loop() {
      let delay = 1000;
      while (this.acked < this.count || (this.finishInfo && !this.finished) || (this.inicio !== undefined && !this._inicioEnviado)) {
        try {
          if (!this._registered) await this._register();
          if (this.inicio !== undefined && !this._inicioEnviado) {
            const r = await fetch('/api/tracks/start', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ room: this.info.room, session: this.info.session, track: this.trackId, startedAtServer: this.inicio }),
            });
            // Un 404 no se reintenta: es solo un dato de ayuda y no debe frenar la subida.
            if (!r.ok && r.status !== 404) throw new Error(`HTTP ${r.status}`);
            this._inicioEnviado = true;
            continue;
          }
          if (this.acked < this.count) {
            const seq = this.acked;
            const blob = await this._getChunk(seq);
            if (!blob) throw Object.assign(new Error(`Falta el trozo ${seq} en el dispositivo`), { fatal: true });
            const q = new URLSearchParams({ room: this.info.room, session: this.info.session, track: this.trackId, seq });
            const r = await fetch(`/api/upload?${q}`, { method: 'PUT', body: blob });
            const j = await r.json().catch(() => ({}));
            if (r.status === 404) { this._registered = false; throw new Error('El servidor no reconoce la pista'); }
            if (r.status === 409) {
              // El servidor espera otro trozo (p. ej. tras un reinicio): se continúa desde ahí.
              if (j.expected > this.count) throw Object.assign(new Error('Estado inconsistente con el servidor'), { fatal: true });
              this.acked = j.expected;
              continue;
            }
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            this.acked = seq + 1;
            this.bytesAcked += this.sizes.get(seq) || blob.size;
            // En memoria (sin IndexedDB) lo subido se suelta, salvo el primer trozo: lleva la cabecera del vídeo,
            // y sin ella una copia de lo que aún no se ha subido no se podría abrir.
            if (seq !== 0) this.memory.delete(seq);
          } else {
            const r = await fetch('/api/tracks/finish', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ room: this.info.room, session: this.info.session, track: this.trackId, chunks: this.count, ...this.finishInfo }),
            });
            const j = await r.json().catch(() => ({}));
            if (r.status === 409 && Number.isInteger(j.expected)) { this.acked = j.expected; continue; }
            if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
            this.finished = true;
          }
          this.error = '';
          delay = 1000;
          this._saveMeta().catch(() => {});
          this._emit();
        } catch (err) {
          this.error = err.message || String(err);
          // Se anota el primer error, y luego uno de cada 20, para no llenar el registro si la red está caída.
          this._erroresRegistrados = (this._erroresRegistrados || 0) + 1;
          if (this._erroresRegistrados <= 3 || this._erroresRegistrados % 20 === 0) {
            window.Registro?.anotar('subida-error', { pista: this.info?.kind, mensaje: this.error, veces: this._erroresRegistrados, fatal: !!err.fatal });
          }
          this._emit();
          if (err.fatal) return;
          await sleep(delay);
          delay = Math.min(delay * 2, 15000);
        }
      }
    }

    /** Marca el final de la pista; se envía al servidor cuando se hayan subido todos los trozos. */
    async finish(info) {
      this.finishInfo = info;
      await this._saveMeta();
      this._kick();
    }

    /*
     * Copia de seguridad desde este dispositivo: { blob, nombre, aviso } o solo { aviso } si no hay nada que copiar.
     * Con IndexedDB está todo y sale el archivo entero. Sin él (o con el disco lleno) los trozos van en memoria y
     * se sueltan al subirse: lo ya subido no está aquí, así que la copia es el resto (lo que aún no tiene el
     * servidor), con la cabecera para que se pueda abrir, y se dice desde qué minuto empieza. Nunca da un archivo
     * vacío ni con huecos sin decirlo.
     */
    async copia() {
      const trozos = [];
      const faltan = [];
      for (let i = 0; i < this.count; i++) {
        const b = await this._getChunk(i);
        if (b) trozos.push({ i, b }); else faltan.push(i);
      }
      if (!trozos.length && !this.count) return { aviso: 'Esta pista no tiene nada grabado.' };
      if (!faltan.length) return { blob: this._armar(trozos.map((t) => t.b)), nombre: this.fileName() };
      // Cada trozo es ~1 s de grabación: el número de trozo dice el minuto.
      const minuto = (n) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
      const subidos = Math.max(this.acked, this.ackedPrevio || 0);
      const perdidos = faltan.filter((i) => i >= subidos).length;
      const resto = trozos.filter((t) => t.i >= subidos);
      const huecos = perdidos ? ` Faltan ${perdidos} s que no llegaron a guardarse en ningún sitio.` : '';
      if (!resto.length) {
        return { aviso: `${subidos >= this.count ? 'Ya está todo en el servidor: no hace falta copia.' : 'En este dispositivo no queda nada sin subir.'}${huecos}` };
      }
      // Cuántos bytes tiene ya el servidor: va en el nombre, para juntar la copia con lo suyo sin huecos ni repetidos.
      const local = new Map(trozos.map((t) => [t.i, t.b.size]));
      let enServidor = 0;
      for (let i = 0; i < subidos; i++) enServidor += this.sizes.get(i) ?? local.get(i) ?? NaN;
      const partes = resto.map((t) => t.b);
      if (this.info.format !== 'wav') {
        const primero = trozos.find((t) => t.i === 0);
        const c = primero && resto[0].i !== 0 ? await cabecera(primero.b) : null;
        if (c) partes.unshift(c);
      }
      return {
        blob: this._armar(partes),
        nombre: this.fileName(Number.isFinite(enServidor) ? enServidor : 'resto'),
        aviso: `Hasta el minuto ${minuto(subidos)} ya está en el servidor: esta copia lleva el resto, desde ahí. Guárdala: al editar se junta con lo del servidor.${huecos}`,
      };
    }

    _armar(parts) {
      const type = this.info.format === 'wav' ? 'audio/wav' : (this.info.mime || '').split(';')[0];
      if (this.info.format === 'wav' && this.info.sampleRate) {
        const dataBytes = parts.reduce((a, b) => a + b.size, 0);
        parts = [wavHeader(this.info.sampleRate, this.info.channels || 1, dataBytes), ...parts];
      }
      return new Blob(parts, { type });
    }

    /**
     * Nombre del archivo de la copia. Con `resto` (lo que ya tenía el servidor, en bytes) es el de una copia que
     * solo lleva lo que falta: «…_camara.resto-123456.mp4» (edicion: juntar-copia).
     */
    fileName(resto) {
      const ext = this.info.format === 'wav' ? 'wav' : ((this.info.mime || '').includes('mp4') ? 'mp4' : 'webm');
      const who = (this.info.name || 'yo').replace(/[^\w-]+/g, '_');
      const sufijo = resto === undefined ? '' : typeof resto === 'number' ? `.resto-${resto}` : '.resto';
      return `${this.info.session}_${who}_${this.info.kind}${sufijo}.${ext}`;
    }

    async deleteLocal() {
      this.memory.clear();
      const db = await openDb();
      if (!db) return;
      const range = IDBKeyRange.bound(`${this.key}#`, `${this.key}#￿`);
      await tx(db, 'chunks', 'readwrite', (s) => s.delete(range));
      await tx(db, 'tracks', 'readwrite', (s) => s.delete(this.key));
    }

    /** Pistas que quedaron en el dispositivo (p. ej. se cerró la pestaña a mitad de subida). */
    static async listStored() {
      const db = await openDb();
      if (!db) return [];
      const rows = await tx(db, 'tracks', 'readonly', (s) => s.getAll());
      return (rows || []).map((row) => {
        const u = new TrackUploader(row.info);
        u.count = row.count; u.acked = 0; u.bytesTotal = row.bytesTotal;
        u.ackedPrevio = row.acked || 0;   // lo que confirmó el servidor entonces (para la copia)
        u.finishInfo = row.finishInfo; u.finished = row.finished;
        return u;
      });
    }
  }

  /*
   * La cabecera de un vídeo de MediaRecorder (lo que va antes del primer fragmento): en MP4, las cajas de primer
   * nivel hasta el primer «moof»; en WebM, hasta el primer Cluster. null si no se encuentra.
   */
  async function cabecera(blob) {
    const buf = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let o = 0;
    while (o + 8 <= buf.length) {
      let tam = dv.getUint32(o);
      const tipo = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
      if (tipo === 'moof') return o ? blob.slice(0, o) : null;
      if (tam === 1 && o + 16 <= buf.length) tam = Number(dv.getBigUint64(o + 8));
      if (tam < 8 || !/^[\x20-\x7e]{4}$/.test(tipo)) break;   // no es MP4
      o += tam;
    }
    for (let i = 0; i + 4 <= buf.length; i++) {
      if (buf[i] === 0x1f && buf[i + 1] === 0x43 && buf[i + 2] === 0xb6 && buf[i + 3] === 0x75) return i ? blob.slice(0, i) : null;
    }
    return null;
  }

  function wavHeader(sampleRate, channels, dataBytes) {
    const b = new DataView(new ArrayBuffer(44));
    const w = (o, s) => { for (let i = 0; i < s.length; i++) b.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); b.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE'); w(12, 'fmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, channels, true);
    b.setUint32(24, sampleRate, true); b.setUint32(28, sampleRate * channels * 2, true);
    b.setUint16(32, channels * 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, dataBytes, true);
    return new Blob([b.buffer]);
  }

  window.TrackUploader = TrackUploader;
  window.TrackUploader.cabecera = cabecera;
})();
