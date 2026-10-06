'use strict';
/*
 * Estudio: servidor de señalización + recepción de grabaciones.
 *
 * - Sirve la app web (public/).
 * - Señalización WebRTC: eventos del servidor por WebSocket, mensajes del cliente por POST.
 * - Reloj común (/api/time) para que ambos dispositivos empiecen a grabar a la vez.
 * - Recibe por trozos las grabaciones locales de cada dispositivo y las guarda en grabaciones/.
 * - Credenciales TURN (Cloudflare u otro) para llamadas entre redes distintas.
 *
 * HTTPS (puerto 8443) con certificado autofirmado para que el iPad pueda usar cámara y micrófono
 * en la red local, y HTTP (puerto 8080) para usar en el propio PC (localhost) o detrás de un túnel.
 * Con `--internet` abre además un túnel HTTPS público de Cloudflare para invitar desde cualquier lugar.
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
require('./lib/env').loadEnv(path.join(__dirname, '.env'));
const { slug, sessionIdFromDate, wavHeader, fixWavHeader, chunkDecision, extFromMime } = require('./lib/core');

const HTTP_PORT = Number(process.env.PORT || 8080);
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 8443);
// Puerto interno (solo 127.0.0.1) al que apuntan los túneles públicos (Cloudflare / Tailscale Funnel).
// Por aquí se exige la clave de acceso y no se pueden ver ni descargar grabaciones.
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT || 8090);
const ENV_FILE = path.join(__dirname, '.env');
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const REC_DIR = path.resolve(process.env.GRABACIONES_DIR || path.join(ROOT, 'grabaciones'));
const CERT_DIR = path.join(ROOT, 'certs');
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_PEERS = 2;
// Si una persona pierde la conexión con la sala (un parpadeo del wifi, de la red del iPad, del túnel…) no se
// cuelga la llamada de inmediato: se le da tiempo a volver. Un cierre «limpio» (cerró la pestaña a propósito) casi no espera.
const graciaMs = () => Number(process.env.GRACIA_MS ?? 45000);
const graciaLimpiaMs = () => Number(process.env.GRACIA_LIMPIA_MS ?? 4000);
// Pings de la sala cada 15 s; se da por muerta una conexión tras este número de pings sin respuesta (≈ 45 s).
const PINGS_SIN_RESPUESTA = Number(process.env.PINGS_SIN_RESPUESTA ?? 3);

// Registro en logs/estudio-AAAA-MM-DD.log: qué pasó y cuándo, para poder explicar una caída a posteriori.
const { crearRegistro } = require('./lib/log');
const registro = crearRegistro(path.join(__dirname, 'logs'));
const slog = (evento, datos) => registro.escribir('servidor', evento, datos);

const now = () => performance.timeOrigin + performance.now();
const ACCESS_KEY = ensureAccessKey();
let httpsReady = false;
let publicUrl = process.env.PUBLIC_URL || '';

// ---------------------------------------------------------------- servidores ICE (STUN/TURN)
// STUN basta en la mayoría de conexiones; TURN retransmite la llamada cuando las redes no permiten
// conexión directa (redes móviles, empresas, algunos routers).
const STUN = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
let turnCache = { at: 0, servers: [] };

async function cloudflareTurn() {
  const id = process.env.CLOUDFLARE_TURN_KEY_ID;
  const token = process.env.CLOUDFLARE_TURN_API_TOKEN;
  if (!id || !token) return [];
  if (Date.now() - turnCache.at < 6 * 3600 * 1000) return turnCache.servers;
  const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: 24 * 3600 }),
  });
  if (!r.ok) throw new Error(`Cloudflare TURN respondió ${r.status}`);
  const j = await r.json();
  const list = Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers];
  // Los que tienen credenciales son los TURN (el STUN ya va incluido aparte).
  turnCache = { at: Date.now(), servers: list.filter((s) => s && s.username) };
  return turnCache.servers;
}

async function iceServers() {
  const out = [...STUN];
  if (process.env.TURN_URL) {
    out.push({ urls: process.env.TURN_URL.split(',').map((u) => u.trim()), username: process.env.TURN_USER || '', credential: process.env.TURN_PASS || '' });
  }
  try { out.push(...await cloudflareTurn()); } catch (err) { console.warn(`⚠  No se pudieron obtener credenciales TURN: ${err.message}`); }
  return out;
}
const hasTurn = () => !!(process.env.TURN_URL || (process.env.CLOUDFLARE_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_API_TOKEN));

// ---------------------------------------------------------------- salas y sesiones
/** room -> { peers: Map<id,{id,name,device,ws}>, session: {id,dir,startAt,beepAt,recording} | null } */
const rooms = new Map();
/** `${room}/${session}` -> datos de session.json en memoria */
const sessions = new Map();
/** `${room}/${session}/${track}` -> { file, nextSeq, bytes, kind } */
const tracks = new Map();

function getRoom(name) {
  let r = rooms.get(name);
  if (!r) { r = { peers: new Map(), session: null }; rooms.set(name, r); }
  return r;
}

/** Envía un evento a una persona; si está ausente (sin conexión) no se envía y devuelve false. */
function send(peer, event, data) {
  if (peer.ws && peer.ws.readyState === 1) {
    peer.ws.send(JSON.stringify({ event, data }));
    return true;
  }
  return false;
}

function broadcast(room, event, data, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) send(p, event, data);
}

function peerList(room) {
  return [...room.peers.values()].map(({ id, name, device, ausente }) => ({ id, name, device, ausente: !!ausente }));
}

function sessionDir(room, id) { return path.join(REC_DIR, room, id); }

/** Bytes de cabecera al principio del archivo de una pista (los WAV llevan 44). */
const cabecera = (t) => (t.ext === 'wav' ? 44 : 0);

function saveSession(s) {
  fs.writeFileSync(path.join(s.dir, 'session.json'), JSON.stringify({ ...s, dir: undefined }, null, 2));
}

function loadSession(room, id) {
  const key = `${room}/${id}`;
  if (sessions.has(key)) return sessions.get(key);
  const file = path.join(sessionDir(room, id), 'session.json');
  if (!fs.existsSync(file)) return null;
  const s = { ...JSON.parse(fs.readFileSync(file, 'utf8')), dir: sessionDir(room, id) };
  sessions.set(key, s);
  return s;
}

// ---------------------------------------------------------------- utilidades HTTP
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = MAX_CHUNK) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Demasiado grande'), { status: 413 })); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  try { return JSON.parse(b.toString('utf8') || '{}'); } catch { throw Object.assign(new Error('JSON no válido'), { status: 400 }); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.sh': 'text/plain; charset=utf-8',
};

/**
 * Sirve un archivo dentro de baseDir evitando salir de él. `download`: true para descargarlo, o el
 * nombre con el que debe llegar a Descargas.
 */
function serveFile(req, res, baseDir, relPath, download) {
  const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
  if (!file.startsWith(baseDir + path.sep) && file !== baseDir) return json(res, 403, { error: 'Prohibido' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'No encontrado' });
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size };
    if (download) headers['Content-Disposition'] = `attachment; filename="${typeof download === 'string' ? download : path.basename(file)}"`;
    else headers['Cache-Control'] = 'no-cache';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

// ---------------------------------------------------------------- rutas
async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);

  // Las grabaciones solo se ven desde este mismo PC.
  const privateRoute = parts[0] === 'grabaciones' || parts[0] === 'grabaciones.html' || (parts[0] === 'api' && parts[1] === 'sessions');
  if (privateRoute && !isLocalRequest(req)) return forbidden(res, 'Las grabaciones solo se pueden ver desde el PC del estudio.');

  if (parts[0] !== 'api') {
    // Al descargar, el nombre lleva la sesión (2026-10-10_21-30-05_dj_camara.mp4): si se bajan varias
    // sesiones a la misma carpeta no se confunden, y el editor sabe de qué sesión es cada archivo.
    if (parts[0] === 'grabaciones') {
      const nombre = parts.length === 4 ? `${parts[2]}_${parts[3]}` : true;
      return serveFile(req, res, REC_DIR, parts.slice(1).join('/'), nombre);
    }
    return serveFile(req, res, PUBLIC_DIR, parts.length ? parts.join('/') : 'index.html', false);
  }

  // GET /api/time — reloj del servidor en ms con decimales
  if (parts[1] === 'time') return json(res, 200, { now: now() });

  if (parts[1] === 'config') {
    const lanUrls = httpsReady ? lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}`) : [];
    // La clave solo se entrega en el PC del estudio (para construir el enlace de invitación).
    const accessKey = isLocalRequest(req) ? ACCESS_KEY : undefined;
    return json(res, 200, { iceServers: await iceServers(), turn: hasTurn(), lanUrls, publicUrl, accessKey });
  }

  // /api/rooms/:room/...
  if (parts[1] === 'rooms' && parts[2]) {
    const roomName = slug(parts[2], 'sala');
    const room = getRoom(roomName);
    const action = parts[3];

    // Estado de la grabación de la sala. Las páginas lo consultan cada pocos segundos por si se
    // perdieron la orden de grabar o de parar (un corte de su conexión justo en ese momento).
    if (action === 'sesion' && req.method === 'GET') return json(res, 200, { session: room.session, now: now() });

    if (action === 'signal' && req.method === 'POST') {
      const msg = await readJson(req);
      const to = room.peers.get(msg.to);
      if (!to) return json(res, 404, { error: 'Destino no conectado' });
      // Si el destino está ausente (reconectando) el mensaje se pierde: se anota, no es un error.
      if (!send(to, 'signal', { from: msg.from, data: msg.data })) {
        slog('senal-no-entregada', { sala: roomName, de: msg.from, para: msg.to, motivo: 'ausente' });
        return json(res, 200, { ok: true, entregado: false });
      }
      return json(res, 200, { ok: true, entregado: true });
    }

    // Registro enviado por las páginas (conexión, errores, latidos): se guarda junto al del servidor.
    if (action === 'log' && req.method === 'POST') {
      const msg = await readJson(req);
      const quien = slug(msg.nombre || msg.peer, 'anonimo');
      const eventos = Array.isArray(msg.eventos) ? msg.eventos.slice(0, 200) : [];
      for (const e of eventos) {
        if (!e || typeof e !== 'object') continue;
        const datos = { peer: msg.peer, hora_cliente: e.hora };
        for (const [k, v] of Object.entries(e.d || {})) {
          if (/^[a-z0-9_]{1,30}$/i.test(k) && ['string', 'number', 'boolean'].includes(typeof v)) datos[k] = v;
        }
        registro.escribir(`cliente:${quien}`, String(e.ev || 'evento').replace(/[^a-z0-9_.-]/gi, '_').slice(0, 40), datos);
      }
      return json(res, 200, { ok: true, n: eventos.length });
    }

    if (action === 'status' && req.method === 'POST') {
      const msg = await readJson(req);
      broadcast(room, 'status', { from: msg.from, status: msg.status }, msg.from);
      return json(res, 200, { ok: true });
    }

    if (action === 'record' && req.method === 'POST') {
      const msg = await readJson(req);
      if (msg.action === 'start') {
        if (room.session?.recording) return json(res, 409, { error: 'Ya se está grabando' });
        const t = now();
        const id = sessionIdFromDate(new Date(t));
        const dir = sessionDir(roomName, id);
        fs.mkdirSync(dir, { recursive: true });
        // Margen para que la orden llegue a todos (también por internet); la "claqueta" (pitido) suena 1 s después del arranque.
        const startAt = t + 3000;
        const s = {
          room: roomName, id, dir, createdAt: new Date(t).toISOString(), startAt, beepAt: startAt + 1000,
          participants: Object.fromEntries(peerList(room).map((p) => [p.id, { name: p.name, device: p.device }])),
          tracks: {},
        };
        sessions.set(`${roomName}/${id}`, s);
        saveSession(s);
        room.session = { id, startAt, beepAt: s.beepAt, recording: true };
        slog('grabacion-inicio', { sala: roomName, sesion: id, personas: peerList(room).map((p) => p.name).join(',') });
        broadcast(room, 'record-start', room.session);
        return json(res, 200, room.session);
      }
      if (msg.action === 'stop') {
        if (!room.session?.recording) return json(res, 409, { error: 'No se está grabando' });
        // Pitido final 1,5 s después de la orden (margen para que llegue por internet) y parada 1 s más tarde.
        const t = now();
        const endBeepAt = t + 1500;
        const stopAt = t + 2500;
        room.session = { ...room.session, recording: false, stopAt, endBeepAt };
        const s = sessions.get(`${roomName}/${room.session.id}`);
        if (s) { s.stopAt = stopAt; s.endBeepAt = endBeepAt; saveSession(s); }
        slog('grabacion-fin', { sala: roomName, sesion: room.session.id, pedida_por: msg.from });
        broadcast(room, 'record-stop', room.session);
        return json(res, 200, room.session);
      }
      return json(res, 400, { error: 'Acción desconocida' });
    }
    return json(res, 404, { error: 'Ruta desconocida' });
  }

  // POST /api/tracks — registra una pista (archivo) de una sesión
  if (parts[1] === 'tracks' && req.method === 'POST' && !parts[2]) {
    const m = await readJson(req);
    const s = loadSession(slug(m.room, 'sala'), String(m.session || ''));
    if (!s) return json(res, 404, { error: 'Sesión desconocida' });
    const pid = slug(m.participant, 'p');
    // Etiqueta única por persona para los nombres de archivo.
    const part = s.participants[pid] || (s.participants[pid] = { name: m.name || 'Invitado', device: m.device || '' });
    // Una página que se cerró en plena grabación y vuelve a entrar para seguir: sus archivos son un tramo nuevo de la
    // misma sesión. Se anota de quién continúa para poder juntarlos después.
    if (m.retomada && !part.retomada) {
      part.retomada = true;
      const previa = Object.entries(s.participants).find(([otro, p]) => otro !== pid && p.name === part.name && p.label);
      if (previa) part.retomaDe = previa[1].label;
      slog('grabacion-retomada', { sala: s.room, sesion: s.id, nombre: part.name, retoma_de: part.retomaDe });
    }
    // Una página que no recibió la orden de grabar (se cortó su conexión justo entonces, o entró con la
    // grabación ya en marcha) y se unió después: sus pistas no llevan pitido de inicio.
    if (m.tarde && !part.tarde) {
      part.tarde = true;
      slog('grabacion-tarde', { sala: s.room, sesion: s.id, nombre: part.name });
    }
    if (!part.label) {
      const base = slug(part.name, 'persona');
      const used = new Set(Object.values(s.participants).map((p) => p.label).filter(Boolean));
      let label = base; let i = 2;
      while (used.has(label)) label = `${base}-${i++}`;
      part.label = label;
    }
    const kind = ['camara', 'audio', 'llamada'].includes(m.kind) ? m.kind : 'otro';
    const trackId = `${pid}-${kind}`;
    const key = `${s.room}/${s.id}/${trackId}`;
    const ext = m.kind === 'audio' && m.format === 'wav' ? 'wav' : extFromMime(m.mime);
    const fileName = `${part.label}_${kind}.${ext}`;
    const file = path.join(s.dir, fileName);
    const progressFile = path.join(s.dir, `.${fileName}.seq`);
    let t = tracks.get(key);
    if (!t && fs.existsSync(file) && fs.existsSync(progressFile)) {
      // El servidor se reinició a mitad de grabación: se continúa donde se quedó.
      const p = JSON.parse(fs.readFileSync(progressFile, 'utf8'));
      t = { file, progressFile, nextSeq: p.nextSeq, bytes: p.bytes, ext };
      // Si se cayó justo entre guardar un trozo y apuntarlo, ese trozo está de más en el archivo y va a
      // llegar otra vez: se quita para que no quede duplicado.
      const esperado = cabecera(t) + p.bytes;
      const tam = fs.statSync(file).size;
      if (tam > esperado) {
        slog('pista-recortada', { sala: s.room, sesion: s.id, archivo: fileName, sobraban_bytes: tam - esperado });
        fs.truncateSync(file, esperado);
      }
      tracks.set(key, t);
    }
    if (!t) {
      if (ext === 'wav') fs.writeFileSync(file, wavHeader(m.sampleRate || 48000, m.channels || 1, 0));
      else fs.writeFileSync(file, Buffer.alloc(0));
      t = { file, progressFile, nextSeq: 0, bytes: 0, ext };
      tracks.set(key, t);
    }
    s.tracks[trackId] = {
      ...(s.tracks[trackId] || {}),
      participant: pid, kind, file: fileName, mime: m.mime || '', format: ext,
      sampleRate: m.sampleRate || null, channels: m.channels || null,
      width: m.width || null, height: m.height || null, frameRate: m.frameRate || null,
      complete: false,
    };
    saveSession(s);
    return json(res, 200, { track: trackId, file: fileName, nextSeq: t.nextSeq });
  }

  // PUT /api/upload?room&session&track&seq — un trozo de grabación (en orden)
  if (parts[1] === 'upload' && (req.method === 'PUT' || req.method === 'POST')) {
    const room = slug(url.searchParams.get('room'), 'sala');
    const key = `${room}/${url.searchParams.get('session')}/${url.searchParams.get('track')}`;
    const t = tracks.get(key);
    if (!t) { req.resume(); return json(res, 404, { error: 'Pista desconocida' }); }
    const seq = Number(url.searchParams.get('seq'));
    const decision = chunkDecision(t.nextSeq, seq);
    if (decision === 'invalid') { req.resume(); return json(res, 400, { error: 'seq no válido' }); }
    if (decision === 'gap') { req.resume(); return json(res, 409, { error: 'Falta un trozo anterior', expected: t.nextSeq }); }
    const body = await readBody(req);
    if (decision === 'duplicate') return json(res, 200, { ok: true, duplicate: true, nextSeq: t.nextSeq });
    // Serializa escrituras de la misma pista. La decisión se vuelve a tomar dentro: mientras llegaba
    // este cuerpo pudo llegar y guardarse el mismo trozo por otro envío (dos pestañas, un reintento),
    // y añadirlo otra vez lo duplicaría y desplazaría todo lo que viene detrás.
    // Un fallo al escribir no bloquea la pista: el siguiente envío vuelve a intentarlo.
    const turno = (t.writing || Promise.resolve()).catch(() => {}).then(async () => {
      const ahora = chunkDecision(t.nextSeq, seq);
      if (ahora !== 'append') return ahora;
      try {
        await fs.promises.appendFile(t.file, body);
      } catch (err) {
        // Lo que se llegara a escribir de este trozo se quita: el reintento lo manda entero.
        await fs.promises.truncate(t.file, cabecera(t) + t.bytes).catch(() => {});
        throw err;
      }
      t.nextSeq++; t.bytes += body.length;
      // El WAV vale en todo momento, aunque la página muera antes de cerrarlo.
      if (t.ext === 'wav') fixWavHeader(t.file);
      await fs.promises.writeFile(t.progressFile, JSON.stringify({ nextSeq: t.nextSeq, bytes: t.bytes }));
      return 'append';
    });
    t.writing = turno;
    const hecho = await turno;
    if (hecho === 'duplicate') return json(res, 200, { ok: true, duplicate: true, nextSeq: t.nextSeq });
    if (hecho === 'gap') return json(res, 409, { error: 'Falta un trozo anterior', expected: t.nextSeq });
    return json(res, 200, { ok: true, nextSeq: t.nextSeq, bytes: t.bytes });
  }

  // POST /api/tracks/start — hora a la que empezó de verdad una pista. Se manda en cuanto se sabe (y no
  // solo al cerrarla) para que quede aunque la página muera: el editor la usa para situar los tramos.
  if (parts[1] === 'tracks' && parts[2] === 'start' && req.method === 'POST') {
    const m = await readJson(req);
    const s = loadSession(slug(m.room, 'sala'), String(m.session || ''));
    if (!s || !s.tracks[m.track]) return json(res, 404, { error: 'Pista desconocida' });
    if (Number.isFinite(m.startedAtServer) && !s.tracks[m.track].complete) {
      s.tracks[m.track].startedAtServer = m.startedAtServer;
      saveSession(s);
    }
    return json(res, 200, { ok: true });
  }

  // POST /api/tracks/finish — cierra una pista y guarda sus tiempos para sincronizar
  if (parts[1] === 'tracks' && parts[2] === 'finish' && req.method === 'POST') {
    const m = await readJson(req);
    const s = loadSession(slug(m.room, 'sala'), String(m.session || ''));
    if (!s || !s.tracks[m.track]) return json(res, 404, { error: 'Pista desconocida' });
    const t = tracks.get(`${s.room}/${s.id}/${m.track}`);
    if (t) {
      await (t.writing || Promise.resolve()).catch(() => {});
      if (t.nextSeq < m.chunks) return json(res, 409, { error: 'Faltan trozos', expected: t.nextSeq });
      if (t.ext === 'wav') fixWavHeader(t.file);
    }
    Object.assign(s.tracks[m.track], {
      complete: true,
      chunks: m.chunks,
      bytes: t ? fs.statSync(t.file).size : null,
      startedAtServer: m.startedAtServer ?? s.tracks[m.track].startedAtServer ?? null,
      endedAtServer: m.endedAtServer ?? null,
      beepOffsetSec: m.beepOffsetSec ?? null,
      endBeepOffsetSec: m.endBeepOffsetSec ?? null,
      clockRttMs: m.clockRttMs ?? null,
      userAgent: String(m.userAgent || '').slice(0, 300),
    });
    saveSession(s);
    return json(res, 200, { ok: true, track: s.tracks[m.track] });
  }

  // GET /api/sessions — lista de grabaciones guardadas
  if (parts[1] === 'sessions' && req.method === 'GET') {
    const list = [];
    if (fs.existsSync(REC_DIR)) {
      for (const room of fs.readdirSync(REC_DIR)) {
        const roomDir = path.join(REC_DIR, room);
        if (!fs.statSync(roomDir).isDirectory()) continue;
        for (const id of fs.readdirSync(roomDir)) {
          const s = loadSession(room, id);
          if (!s) continue;
          const files = fs.readdirSync(s.dir).filter((f) => !f.startsWith('.'))
            .map((f) => ({ name: f, bytes: fs.statSync(path.join(s.dir, f)).size, url: `/grabaciones/${encodeURIComponent(room)}/${encodeURIComponent(id)}/${encodeURIComponent(f)}` }));
          list.push({ room, id, createdAt: s.createdAt, startAt: s.startAt, beepAt: s.beepAt, participants: s.participants, tracks: s.tracks, files });
        }
      }
    }
    list.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(res, 200, list);
  }

  return json(res, 404, { error: 'Ruta desconocida' });
}

// ---------------------------------------------------------------- WebSocket de la sala
// ws(s)://…/api/rooms/:room/ws?peer=&name=&device=  → eventos del servidor en JSON {event, data}
function attachSignaling(server, { requireKey = false } = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (requireKey) req.viaPublic = true;
    if (!m || (requireKey && !hasValidKey(req, url))) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onPeerSocket(ws, decodeURIComponent(m[1]), url.searchParams, req));
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      // Una conexión solo se da por muerta tras varios pings sin respuesta seguidos: un iPad que tarda en
      // contestar un momento (pantalla, wifi) no debe tirar la sala.
      if ((ws.sinRespuesta || 0) >= PINGS_SIN_RESPUESTA) {
        slog('ping-sin-respuesta', { peer: ws.etiqueta, pings: ws.sinRespuesta });
        ws.terminate();
        continue;
      }
      ws.sinRespuesta = (ws.sinRespuesta || 0) + 1;
      ws.ping();
    }
  }, 15000);
  ping.unref?.();
  server.on('close', () => clearInterval(ping));
  return wss;
}

function onPeerSocket(ws, rawRoom, params, req) {
  const roomName = slug(rawRoom, 'sala');
  const room = getRoom(roomName);
  const id = slug(params.get('peer'), '');
  ws.sinRespuesta = 0;
  ws.on('pong', () => { ws.sinRespuesta = 0; });
  if (!id) { ws.close(4000, 'Falta peer'); return; }
  const name = String(params.get('name') || 'Invitado').slice(0, 40);
  const device = String(params.get('device') || '').slice(0, 40);
  ws.etiqueta = `${name}/${id}`;
  const existing = room.peers.get(id);
  // Quien se había caído y no volvió sigue ocupando su sitio hasta que acabe su gracia. Si llega alguien
  // nuevo (p. ej. la misma persona con la pestaña recargada, que trae otro identificador) se libera ese sitio.
  if (!existing) liberarAusentes(room, roomName, name, device);
  if (!existing && room.peers.size >= MAX_PEERS) {
    ws.send(JSON.stringify({ event: 'room-full', data: { error: 'La sala está llena (máximo 2 personas)' } }));
    ws.close(4009, 'Sala llena');
    return;
  }
  let peer = existing;
  let volvio = false;
  if (existing) {
    // Es la misma página que reconecta (mismo identificador): vuelve a su sitio sin cambiar nada más.
    if (existing.timer) { clearTimeout(existing.timer); existing.timer = null; }
    volvio = !!existing.ausente;
    const anterior = existing.ws;
    Object.assign(existing, { ws, ausente: false, name, device, desde: Date.now() });
    if (anterior && anterior !== ws) anterior.close(4001, 'Reemplazado');
    slog(volvio ? 'ws-reconectado' : 'ws-reemplazado', { sala: roomName, peer: id, nombre: name, ausente_s: existing.ausenteDesde ? (Date.now() - existing.ausenteDesde) / 1000 : undefined });
  } else {
    peer = { id, name, device, ws, timer: null, ausente: false, desde: Date.now() };
    room.peers.set(id, peer);
    slog('ws-abierto', { sala: roomName, peer: id, nombre: name, dispositivo: device, ua: req.headers['user-agent'] });
  }
  // Quien abre la sala en este mismo PC recibe el enlace de invitación ya copiado en el portapapeles.
  const inviteCopied = room.peers.size === 1 && isLocalRequest(req) && publicUrl
    ? copyToClipboard(inviteLink(roomName)) : false;
  send(peer, 'welcome', { id, room: roomName, peers: peerList(room).filter((p) => p.id !== id), session: room.session, inviteCopied, volvio });
  broadcast(room, 'peer-joined', { id, name: peer.name, device: peer.device, volvio }, id);
  ws.on('close', (code, reason) => {
    if (peer.ws !== ws) return;           // ya lo ha reemplazado otra conexión suya
    const limpio = code === 1000 || code === 1005;
    slog('ws-cerrado', { sala: roomName, peer: id, nombre: peer.name, codigo: code, motivo: reason?.toString(), conectado_s: (Date.now() - peer.desde) / 1000 });
    peer.ws = null;
    const espera = limpio ? 0 : (code === 1001 ? graciaLimpiaMs() : graciaMs());
    const salir = () => {
      if (room.peers.get(id) !== peer) return;
      room.peers.delete(id);
      slog('peer-salio', { sala: roomName, peer: id, nombre: peer.name });
      broadcast(room, 'peer-left', { id });
      if (!room.peers.size && !room.session?.recording) rooms.delete(roomName);
    };
    if (!espera) { salir(); return; }
    peer.ausente = true;
    peer.ausenteDesde = Date.now();
    // Se avisa a la otra persona, pero la llamada no se cuelga: puede que solo haya sido el canal de la sala.
    broadcast(room, 'peer-away', { id, graciaMs: espera });
    slog('peer-ausente', { sala: roomName, peer: id, nombre: peer.name, gracia_s: espera / 1000 });
    peer.timer = setTimeout(salir, espera);
    peer.timer.unref?.();
  });
}

/** Libera los sitios de personas ausentes que no han vuelto, para dejar entrar a quien llega. */
function liberarAusentes(room, roomName, name, device) {
  const fuera = (p, motivo) => {
    clearTimeout(p.timer);
    room.peers.delete(p.id);
    slog('peer-reemplazado', { sala: roomName, peer: p.id, nombre: p.name, motivo });
    broadcast(room, 'peer-left', { id: p.id });
  };
  for (const p of [...room.peers.values()]) if (p.ausente && p.name === name && p.device === device) fuera(p, 'misma persona vuelve con otra página');
  for (const p of [...room.peers.values()]) if (p.ausente && room.peers.size >= MAX_PEERS) fuera(p, 'sala llena');
}

/** Conexión hecha desde este mismo PC (no a través de un túnel ni de la red local). */
function isLocalRequest(req) {
  if (!req || req.viaPublic || req.socket.localPort === PUBLIC_PORT) return false;
  const h = req.headers;
  if (h['cf-connecting-ip'] || h['x-forwarded-for'] || h['tailscale-funnel-request'] || h['x-forwarded-host']) return false;
  const ip = req.socket.remoteAddress || '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

// ---------------------------------------------------------------- clave de acceso
/** Clave secreta que debe llevar el enlace público. Se genera una vez y se guarda en .env. */
function ensureAccessKey() {
  if (process.env.CLAVE_ACCESO) return process.env.CLAVE_ACCESO.trim();
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = require('crypto').randomBytes(12);
  const key = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
  if (require.main === module) {
    try {
      const prev = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
      fs.writeFileSync(ENV_FILE, `${prev}${prev && !prev.endsWith('\n') ? '\n' : ''}\n# Clave secreta del enlace público (cámbiala para invalidar enlaces antiguos)\nCLAVE_ACCESO=${key}\n`);
    } catch (err) { console.warn(`⚠  No se pudo guardar la clave en .env: ${err.message}`); }
  }
  process.env.CLAVE_ACCESO = key;
  return key;
}

function cookieValue(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie || '');
  return m ? decodeURIComponent(m[1]) : '';
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && require('crypto').timingSafeEqual(x, y);
}

function hasValidKey(req, url) {
  return safeEqual(url.searchParams.get('k') || '', ACCESS_KEY) || safeEqual(cookieValue(req, 'estudio_k'), ACCESS_KEY);
}

function forbidden(res, msg) {
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Estudio</title><body style="font:16px system-ui;background:#111318;color:#eceef3;display:grid;place-items:center;min-height:90vh;text-align:center">
<div><h1 style="font-size:20px">🔒 Acceso restringido</h1><p>${msg}</p></div></body>`);
}

/** Peticiones que llegan por el túnel público: exigen la clave y nunca dan acceso a las grabaciones. */
function onPublicRequest(req, res) {
  req.viaPublic = true;
  const url = new URL(req.url, 'http://x');
  if (!hasValidKey(req, url)) {
    return forbidden(res, 'Este enlace no es válido o está incompleto. Pide el enlace de invitación completo a quien te invitó.');
  }
  if (url.searchParams.get('k')) {
    // Se recuerda la clave para el resto de peticiones de la página (vídeo, subidas, sala).
    res.setHeader('Set-Cookie', `estudio_k=${encodeURIComponent(ACCESS_KEY)}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`);
  }
  return onRequest(req, res);
}

/** Copia texto al portapapeles del PC (Windows y Mac). Devuelve true si lo intentó. */
function copyToClipboard(text) {
  const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : null;
  if (!cmd) return false;
  try {
    const p = require('child_process').spawn(cmd, [], { stdio: ['pipe', 'ignore', 'ignore'] });
    p.on('error', () => {});
    p.stdin.end(text);
    console.log(`   📋 Enlace de invitación copiado: ${text}`);
    return true;
  } catch { return false; }
}

function inviteLink(room) {
  return `${publicUrl}/?sala=${encodeURIComponent(room)}&k=${encodeURIComponent(ACCESS_KEY)}`;
}

function onRequest(req, res) {
  handle(req, res).catch((err) => {
    if (!res.headersSent) json(res, err.status || 500, { error: err.message });
    else res.end();
    if (!err.status) console.error(err);
  });
}

// ---------------------------------------------------------------- arranque
function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function loadOrCreateCert(ips) {
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const ipsFile = path.join(CERT_DIR, 'ips.json');
  const wanted = JSON.stringify([...ips].sort());
  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.existsSync(ipsFile) && fs.readFileSync(ipsFile, 'utf8') === wanted) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }
  let selfsigned;
  try { selfsigned = require('selfsigned'); } catch {
    console.warn('⚠  Falta la dependencia "selfsigned" (ejecuta npm install). Sin HTTPS el iPad no podrá usar la cámara.');
    return null;
  }
  const altNames = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'Estudio local' }], {
    keySize: 2048, algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 365 * 24 * 3600 * 1000),
    extensions: [{ name: 'basicConstraints', cA: false }, { name: 'subjectAltName', altNames }],
  });
  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.writeFileSync(keyFile, pems.private);
  fs.writeFileSync(certFile, pems.cert);
  fs.writeFileSync(ipsFile, wanted);
  return { key: pems.private, cert: pems.cert };
}

/** Abre un túnel HTTPS público de Cloudflare (sin cuenta) hacia el servidor local. */
async function startTunnel() {
  let cf;
  try { cf = require('cloudflared'); } catch {
    console.error('✗ Falta el componente del túnel. Ejecuta «npm install» y vuelve a probar.');
    return;
  }
  if (!fs.existsSync(cf.bin)) {
    console.log('   Descargando cloudflared (solo la primera vez)…');
    await cf.install(cf.bin);
  }
  const t = cf.Tunnel.quick(`http://localhost:${PUBLIC_PORT}`);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cloudflare no respondió en 60 s')), 60000);
    t.once('url', (u) => { clearTimeout(timer); resolve(u); });
    t.once('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared terminó (código ${code})`)); });
  });
  publicUrl = url;
  const line = '─'.repeat(url.length + 8);
  console.log(`\n   ┌${line}┐\n   │  🌍  ${url}  │\n   └${line}┘`);
  console.log('   Enlace público (cambia cada vez que arrancas). En este PC usa http://localhost:' + HTTP_PORT + ';');
  console.log('   el enlace de invitación (con su clave) se copia solo al entrar en el estudio.\n');
  if (!hasTurn()) {
    console.log('   Consejo: configura un servidor TURN en .env (ver .env.ejemplo) para que la llamada conecte');
    console.log('   aunque alguna de las redes bloquee las conexiones directas.\n');
  }
  const stop = () => { try { t.stop(); } catch { /* ya parado */ } process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  t.on('exit', (code) => { if (publicUrl === url) { publicUrl = ''; console.error(`⚠  El túnel se cerró (código ${code}). Reinicia con npm run internet.`); } });
}

// ---------------------------------------------------------------- Tailscale Funnel (dirección fija)
function tailscaleExe() {
  const { spawnSync } = require('child_process');
  const candidates = ['tailscale'];
  if (process.platform === 'win32') candidates.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'));
  if (process.platform === 'darwin') candidates.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  for (const c of candidates) {
    const r = spawnSync(c, ['version'], { encoding: 'utf8' });
    if (!r.error && r.status === 0) return c;
  }
  return null;
}

/** Publica el estudio en https://<pc>.<tailnet>.ts.net mientras esté abierto. */
async function startTailscale() {
  const { spawn, spawnSync } = require('child_process');
  const exe = tailscaleExe();
  if (!exe) throw new Error('Tailscale no está instalado (https://tailscale.com/download). Ver INSTALAR-WINDOWS.md');
  const st = spawnSync(exe, ['status', '--json'], { encoding: 'utf8' });
  let status = {};
  try { status = JSON.parse(st.stdout); } catch { /* sin datos */ }
  if (status.BackendState !== 'Running') throw new Error('Tailscale no está conectado: ábrelo e inicia sesión, y vuelve a probar');
  const dns = String(status.Self?.DNSName || '').replace(/\.$/, '');
  if (!dns) throw new Error('Tailscale no tiene nombre DNS: activa MagicDNS en https://login.tailscale.com/admin/dns');

  // Se ejecuta en primer plano: el enlace solo funciona mientras el estudio está abierto.
  const p = spawn(exe, ['funnel', String(PUBLIC_PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stop = () => { try { p.kill(); } catch { /* ya parado */ } };
  process.once('exit', stop);
  process.once('SIGINT', () => { stop(); process.exit(0); });
  process.once('SIGTERM', () => { stop(); process.exit(0); });
  await new Promise((resolve, reject) => {
    let opened = false;
    const timer = setTimeout(resolve, 8000);   // sin mensaje claro: se da por activo
    const onData = (d) => {
      const text = d.toString();
      const login = /https:\/\/login\.tailscale\.com\/\S+/.exec(text);
      if (login && !opened) {
        opened = true;
        clearTimeout(timer);
        console.log('\n   Tailscale pide activar Funnel (solo la primera vez). Se abre en el navegador:');
        console.log(`   ${login[0]}`);
        console.log('   Pulsa «Enable» / «Activar» y vuelve aquí; el estudio sigue en cuanto esté activado.\n');
        openBrowser(login[0]);
      }
      if (/available on the internet|Funnel on|Press Ctrl\+C/i.test(text)) { clearTimeout(timer); resolve(); }
      if (/error|not allowed|denied/i.test(text) && !login) console.error(`   tailscale: ${text.trim()}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('exit', (code) => { clearTimeout(timer); reject(new Error(`tailscale funnel terminó (código ${code})`)); });
  });
  p.removeAllListeners('exit');
  p.on('exit', (code) => { publicUrl = ''; console.error(`⚠  Tailscale Funnel se detuvo (código ${code}). Cierra y vuelve a abrir el estudio.`); });
  publicUrl = `https://${dns}`;
  console.log(`\n   🌍  Dirección fija:  ${publicUrl}`);
  console.log('   El enlace de invitación (con su clave) se copia solo al entrar en el estudio; es siempre el mismo.\n');
}

async function main() {
  fs.mkdirSync(REC_DIR, { recursive: true });
  const ips = lanAddresses();
  const httpServer = http.createServer(onRequest);
  attachSignaling(httpServer);
  await new Promise((r) => {
    httpServer.once('error', (err) => {
      if (err.code === 'EADDRINUSE') console.error(`✗ El puerto ${HTTP_PORT} está ocupado: ¿ya tienes el estudio abierto en otra ventana? Ciérralo o usa PORT=8081.`);
      else console.error(err);
      process.exit(1);
    });
    httpServer.listen(HTTP_PORT, r);
  });
  slog('arranque', { pid: process.pid, node: process.version, turn: hasTurn(), grabaciones: REC_DIR, logs: registro.carpeta() });
  // Un error que se escapa también queda anotado (y se muestra), para no perder la pista de por qué cayó el servidor.
  process.on('uncaughtException', (err) => { slog('error-no-capturado', { mensaje: err?.message, pila: String(err?.stack || '').split('\n')[1]?.trim() }); console.error(err); });
  process.on('unhandledRejection', (err) => { slog('promesa-rechazada', { mensaje: err?.message || String(err) }); console.error(err); });
  console.log(`\n🎙  Estudio en marcha. Grabaciones en: ${REC_DIR}`);
  console.log(`   Registro de lo que ocurre: ${registro.carpeta()}\n`);
  console.log(`   En este PC:          http://localhost:${HTTP_PORT}`);
  const tls = await loadOrCreateCert(ips);
  if (tls) {
    const httpsServer = https.createServer(tls, onRequest);
    attachSignaling(httpsServer);
    httpsReady = await new Promise((r) => {
      httpsServer.once('error', () => { console.warn(`⚠  El puerto ${HTTPS_PORT} está ocupado: sin acceso por la wifi local.`); r(false); });
      httpsServer.listen(HTTPS_PORT, () => r(true));
    });
    if (httpsReady) for (const ip of ips) console.log(`   Misma wifi (iPad):   https://${ip}:${HTTPS_PORT}   (certificado autofirmado: «Mostrar detalles» → «visitar este sitio web»)`);
  }
  console.log(`   TURN: ${hasTurn() ? 'configurado ✓' : 'no configurado (opcional, ver .env.ejemplo)'}`);
  const wantsTailscale = process.argv.includes('--tailscale') || String(process.env.PUBLICO || '').toLowerCase() === 'tailscale';
  const wantsInternet = wantsTailscale || process.argv.includes('--internet') || process.env.INTERNET === '1';
  const ownTunnel = !!process.env.PUBLIC_URL && !wantsInternet;   // túnel propio hacia PUBLIC_PORT
  if (wantsInternet || ownTunnel) {
    // Servidor solo para los túneles: escucha únicamente en este PC y exige la clave de acceso.
    const publicServer = http.createServer(onPublicRequest);
    attachSignaling(publicServer, { requireKey: true });
    await new Promise((r, j) => { publicServer.once('error', j); publicServer.listen(PUBLIC_PORT, '127.0.0.1', r); })
      .catch((err) => { console.error(`✗ El puerto ${PUBLIC_PORT} está ocupado (${err.code}). Usa PUBLIC_PORT=8091.`); process.exit(1); });
  }
  if (wantsTailscale) {
    console.log('\n   Publicando con Tailscale Funnel…');
    try { await startTailscale(); } catch (err) { console.error(`✗ ${err.message}`); }
  } else if (wantsInternet) {
    console.log('\n   Abriendo enlace público por internet…');
    try { await startTunnel(); } catch (err) {
      console.error(`✗ No se pudo abrir el túnel: ${err.message}. Comprueba la conexión a internet (o un cortafuegos que bloquee cloudflared) y vuelve a probar.`);
    }
  } else {
    console.log('\n   ¿La otra persona está en otra ciudad? Arranca con: npm run internet\n');
  }
  if (process.argv.includes('--abrir')) openBrowser(`http://localhost:${HTTP_PORT}`);
}

/** Abre el estudio en el navegador predeterminado (para los accesos directos de doble clic). */
function openBrowser(url) {
  const { spawn } = require('child_process');
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  } catch { /* sin navegador: se abre a mano */ }
}

if (require.main === module) main();

module.exports = { onRequest, onPublicRequest, attachSignaling, iceServers, hasTurn, ACCESS_KEY, PUBLIC_PORT };
