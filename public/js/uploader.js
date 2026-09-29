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

    async _loop() {
      let delay = 1000;
      while (this.acked < this.count || (this.finishInfo && !this.finished)) {
        try {
          if (!this._registered) await this._register();
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
            this.memory.delete(seq);
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

    /** Reconstruye el archivo completo desde el dispositivo (copia de seguridad). */
    async toBlob() {
      const parts = [];
      for (let i = 0; i < this.count; i++) {
        const b = await this._getChunk(i);
        if (b) parts.push(b);
      }
      const type = this.info.format === 'wav' ? 'audio/wav' : (this.info.mime || '').split(';')[0];
      if (this.info.format === 'wav' && this.info.sampleRate) {
        const dataBytes = parts.reduce((a, b) => a + b.size, 0);
        parts.unshift(wavHeader(this.info.sampleRate, this.info.channels || 1, dataBytes));
      }
      return new Blob(parts, { type });
    }

    fileName() {
      const ext = this.info.format === 'wav' ? 'wav' : ((this.info.mime || '').includes('mp4') ? 'mp4' : 'webm');
      const who = (this.info.name || 'yo').replace(/[^\w-]+/g, '_');
      return `${this.info.session}_${who}_${this.info.kind}.${ext}`;
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
        u.finishInfo = row.finishInfo; u.finished = row.finished;
        return u;
      });
    }
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
})();
