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
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const REC_DIR = path.resolve(process.env.GRABACIONES_DIR || path.join(ROOT, 'grabaciones'));
const CERT_DIR = path.join(ROOT, 'certs');
const MAX_CHUNK = 64 * 1024 * 1024;
const MAX_PEERS = 2;

const now = () => performance.timeOrigin + performance.now();
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

function send(peer, event, data) {
  if (peer.ws.readyState === 1) peer.ws.send(JSON.stringify({ event, data }));
}

function broadcast(room, event, data, exceptId) {
  for (const p of room.peers.values()) if (p.id !== exceptId) send(p, event, data);
}

function peerList(room) {
  return [...room.peers.values()].map(({ id, name, device }) => ({ id, name, device }));
}

function sessionDir(room, id) { return path.join(REC_DIR, room, id); }

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

/** Sirve un archivo dentro de baseDir evitando salir de él. */
function serveFile(req, res, baseDir, relPath, download) {
  const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + relPath));
  if (!file.startsWith(baseDir + path.sep) && file !== baseDir) return json(res, 403, { error: 'Prohibido' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return json(res, 404, { error: 'No encontrado' });
    const headers = { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length': st.size };
    if (download) headers['Content-Disposition'] = `attachment; filename="${path.basename(file)}"`;
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

  if (parts[0] !== 'api') {
    if (parts[0] === 'grabaciones') return serveFile(req, res, REC_DIR, parts.slice(1).join('/'), true);
    return serveFile(req, res, PUBLIC_DIR, parts.length ? parts.join('/') : 'index.html', false);
  }

  // GET /api/time — reloj del servidor en ms con decimales
  if (parts[1] === 'time') return json(res, 200, { now: now() });

  if (parts[1] === 'config') {
    const lanUrls = httpsReady ? lanAddresses().map((ip) => `https://${ip}:${HTTPS_PORT}`) : [];
    return json(res, 200, { iceServers: await iceServers(), turn: hasTurn(), lanUrls, publicUrl });
  }

  // /api/rooms/:room/...
  if (parts[1] === 'rooms' && parts[2]) {
    const roomName = slug(parts[2], 'sala');
    const room = getRoom(roomName);
    const action = parts[3];

    if (action === 'signal' && req.method === 'POST') {
      const msg = await readJson(req);
      const to = room.peers.get(msg.to);
      if (!to) return json(res, 404, { error: 'Destino no conectado' });
      send(to, 'signal', { from: msg.from, data: msg.data });
      return json(res, 200, { ok: true });
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
    // Serializa escrituras de la misma pista.
    t.writing = (t.writing || Promise.resolve()).then(async () => {
      await fs.promises.appendFile(t.file, body);
      t.nextSeq++; t.bytes += body.length;
      await fs.promises.writeFile(t.progressFile, JSON.stringify({ nextSeq: t.nextSeq, bytes: t.bytes }));
    });
    await t.writing;
    return json(res, 200, { ok: true, nextSeq: t.nextSeq, bytes: t.bytes });
  }

  // POST /api/tracks/finish — cierra una pista y guarda sus tiempos para sincronizar
  if (parts[1] === 'tracks' && parts[2] === 'finish' && req.method === 'POST') {
    const m = await readJson(req);
    const s = loadSession(slug(m.room, 'sala'), String(m.session || ''));
    if (!s || !s.tracks[m.track]) return json(res, 404, { error: 'Pista desconocida' });
    const t = tracks.get(`${s.room}/${s.id}/${m.track}`);
    if (t) {
      await t.writing;
      if (t.nextSeq < m.chunks) return json(res, 409, { error: 'Faltan trozos', expected: t.nextSeq });
      if (t.ext === 'wav') fixWavHeader(t.file);
    }
    Object.assign(s.tracks[m.track], {
      complete: true,
      chunks: m.chunks,
      bytes: t ? fs.statSync(t.file).size : null,
      startedAtServer: m.startedAtServer ?? null,
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
function attachSignaling(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = /^\/api\/rooms\/([^/]+)\/ws$/.exec(url.pathname);
    if (!m) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => onPeerSocket(ws, decodeURIComponent(m[1]), url.searchParams));
  });
  const ping = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.alive === false) { ws.terminate(); continue; }
      ws.alive = false;
      ws.ping();
    }
  }, 15000);
  server.on('close', () => clearInterval(ping));
  return wss;
}

function onPeerSocket(ws, rawRoom, params) {
  const roomName = slug(rawRoom, 'sala');
  const room = getRoom(roomName);
  const id = slug(params.get('peer'), '');
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  if (!id) { ws.close(4000, 'Falta peer'); return; }
  const existing = room.peers.get(id);
  if (!existing && room.peers.size >= MAX_PEERS) {
    ws.send(JSON.stringify({ event: 'room-full', data: { error: 'La sala está llena (máximo 2 personas)' } }));
    ws.close(4009, 'Sala llena');
    return;
  }
  if (existing) existing.ws.close(4001, 'Reemplazado');
  const peer = { id, name: String(params.get('name') || 'Invitado').slice(0, 40), device: String(params.get('device') || '').slice(0, 40), ws };
  room.peers.set(id, peer);
  send(peer, 'welcome', { id, room: roomName, peers: peerList(room).filter((p) => p.id !== id), session: room.session });
  broadcast(room, 'peer-joined', { id, name: peer.name, device: peer.device }, id);
  ws.on('close', () => {
    if (room.peers.get(id) !== peer) return;
    room.peers.delete(id);
    broadcast(room, 'peer-left', { id });
    if (!room.peers.size && !room.session?.recording) rooms.delete(roomName);
  });
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
  const t = cf.Tunnel.quick(`http://localhost:${HTTP_PORT}`);
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Cloudflare no respondió en 60 s')), 60000);
    t.once('url', (u) => { clearTimeout(timer); resolve(u); });
    t.once('exit', (code) => { clearTimeout(timer); reject(new Error(`cloudflared terminó (código ${code})`)); });
  });
  publicUrl = url;
  const line = '─'.repeat(url.length + 8);
  console.log(`\n   ┌${line}┐\n   │  🌍  ${url}  │\n   └${line}┘`);
  console.log('   Enlace público (cambia cada vez que arrancas). Ábrelo en ambos dispositivos o comparte');
  console.log('   el «enlace de invitación» que aparece dentro del estudio.\n');
  if (!hasTurn()) {
    console.log('   Consejo: configura un servidor TURN en .env (ver .env.ejemplo) para que la llamada conecte');
    console.log('   aunque alguna de las redes bloquee las conexiones directas.\n');
  }
  const stop = () => { try { t.stop(); } catch { /* ya parado */ } process.exit(0); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  t.on('exit', (code) => { if (publicUrl === url) { publicUrl = ''; console.error(`⚠  El túnel se cerró (código ${code}). Reinicia con npm run internet.`); } });
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
  console.log(`\n🎙  Estudio en marcha. Grabaciones en: ${REC_DIR}\n`);
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
  if (process.argv.includes('--internet') || process.env.INTERNET === '1') {
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

module.exports = { onRequest, attachSignaling, iceServers, hasTurn };
