/* global Clock, TrackUploader */
(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const RESOLUTIONS = {
    '720': { width: 1280, height: 720, bitrate: 5_000_000 },
    '1080': { width: 1920, height: 1080, bitrate: 10_000_000 },
    '2160': { width: 3840, height: 2160, bitrate: 35_000_000 },
  };
  const BEEP_HZ = 1000;
  const BEEP_SEC = 0.25;

  const state = {
    me: { id: randomId(), name: '', device: isIOS ? 'iPad' : 'PC' },
    room: '',
    localStream: null,
    ctx: null,
    audio: null,          // nodos de audio
    pc: null,
    remote: null,         // { id, name, device, stream }
    offerer: false,
    pendingCandidates: [],
    signalChain: Promise.resolve(),
    events: null,
    clock: { offset: 0, rtt: 0 },
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    rec: null,            // grabación en curso
    uploaders: [],
    remoteStatus: null,
    nivelMicro: [],      // nivel del micro cada 100 ms de los últimos 20 s (para el aviso de micro bajo)
    micEstado: null,
    micVozDb: null,
    wakeLock: null,
    recuperando: false,   // se entró para retomar una grabación tras una caída de la página
    corteAbierto: null,   // tramo «✂ cortar» abierto en la sala: { inicio (hora del servidor), nombre }
  };

  // Marca en el navegador mientras se graba: si la página muere, al reabrir sigue ahí y permite retomar.
  const CLAVE_RECUPERAR = 'estudio.recuperar';
  const VIGENCIA_RECUPERAR_MS = 15 * 60 * 1000;
  function marcarRecuperacion(datos) {
    try {
      if (datos) localStorage.setItem(CLAVE_RECUPERAR, JSON.stringify({ ...datos, ts: Date.now() }));
      else localStorage.removeItem(CLAVE_RECUPERAR);
    } catch { /* sin almacenamiento: no hay recuperación */ }
  }
  function leerRecuperacion() {
    try { return Llamada.recuperacionVigente(JSON.parse(localStorage.getItem(CLAVE_RECUPERAR) || 'null'), Date.now(), VIGENCIA_RECUPERAR_MS); } catch { return null; }
  }

  function randomId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const localNow = () => Clock.localNow();
  const serverNow = () => localNow() + state.clock.offset;

  function toast(msg, kind = '', ms = 4000) {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.className = 'toast'; }, ms);
  }

  function fmtBytes(n) {
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
    return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }
  function fmtTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const p = (n) => String(n).padStart(2, '0');
    return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
  }

  // ------------------------------------------------------------------ preparación
  function initSetup() {
    const params = new URLSearchParams(location.search);
    $('#room').value = params.get('sala') || localStorage.getItem('estudio.room') || `sala-${randomId().slice(0, 4)}`;
    $('#name').value = localStorage.getItem('estudio.name') || '';
    $('#resolution').value = localStorage.getItem('estudio.res') || '1080';
    $('#headphones').checked = localStorage.getItem('estudio.headphones') === '1';
    $('#recordCall').checked = localStorage.getItem('estudio.recordCall') ? localStorage.getItem('estudio.recordCall') === '1' : !isIOS;
    $('#deviceLabel').textContent = isIOS ? 'iPad / iPhone' : 'Ordenador';

    if (!window.isSecureContext || !navigator.mediaDevices) {
      $('#secureWarning').hidden = false;
    }
    $('#btnPreview').addEventListener('click', () => startPreview().catch(showMediaError));
    $('#camera').addEventListener('change', () => startPreview().catch(showMediaError));
    $('#mic').addEventListener('change', () => startPreview().catch(showMediaError));
    $('#resolution').addEventListener('change', () => state.localStream && startPreview().catch(showMediaError));
    $('#headphones').addEventListener('change', () => state.localStream && startPreview().catch(showMediaError));
    $('#setupForm').addEventListener('submit', (e) => { e.preventDefault(); join().catch((err) => { console.error(err); toast(err.message, 'error'); }); });
    checkStoredUploads();
    ofrecerRecuperacion();
    // Las grabaciones solo se ven en el PC del estudio: el enlace solo aparece allí.
    fetch('/api/config').then((r) => r.json()).then((c) => { $('#linkGrabaciones').hidden = !c.accessKey; }).catch(() => {});
  }

  /**
   * Si la página se cerró (o falló) en plena grabación y se vuelve a abrir enseguida, ofrece retomarla con un clic.
   * Hace falta el clic porque los navegadores no dejan arrancar el audio sin un gesto del usuario.
   */
  function ofrecerRecuperacion() {
    const marca = leerRecuperacion();
    if (!marca) return;
    Registro.anotar('recuperacion-ofrecida', { sala: marca.sala, hace_s: marca.segundos });
    $('#room').value = marca.sala;
    $('#name').value = marca.nombre;
    $('#recuperarTexto').textContent = `En «${marca.sala}» se estaba grabando hace ${marca.segundos} s. Si la otra persona sigue grabando, puedes continuar: se guarda como un tramo nuevo de la misma grabación.`;
    $('#recuperar').hidden = false;
    $('#btnRecuperar').addEventListener('click', () => {
      state.recuperando = true;
      $('#recuperar').hidden = true;
      Registro.anotar('recuperacion-aceptada', { sala: marca.sala });
      join().catch((err) => { state.recuperando = false; console.error(err); toast(err.message, 'error'); $('#recuperar').hidden = false; });
    });
    $('#btnDescartar').addEventListener('click', () => {
      marcarRecuperacion(null);
      $('#recuperar').hidden = true;
      Registro.anotar('recuperacion-descartada', { sala: marca.sala });
    });
  }

  function showMediaError(err) {
    console.error(err);
    const msg = err.name === 'NotAllowedError' ? 'Permiso de cámara/micrófono denegado. Actívalo en los ajustes del navegador.'
      : err.name === 'NotFoundError' ? 'No se encontró cámara o micrófono.'
        : err.name === 'OverconstrainedError' ? 'La cámara no admite esa resolución; prueba otra.'
          : `No se pudo abrir la cámara: ${err.message}`;
    toast(msg, 'error');
  }

  async function startPreview() {
    const res = RESOLUTIONS[$('#resolution').value] || RESOLUTIONS['1080'];
    const processing = !$('#headphones').checked;
    const camId = $('#camera').value;
    const micId = $('#mic').value;
    if (state.localStream) state.localStream.getTracks().forEach((t) => t.stop());
    // Como mucho 30 fps: el montaje va a 30, y una cámara a 60 gasta el doble de bits por segundo en
    // fotogramas que luego se tiran (peor calidad por fotograma) y el doble de trabajo al editar.
    const constraints = (conTope) => ({
      video: {
        width: { ideal: res.width }, height: { ideal: res.height }, frameRate: conTope ? { ideal: 30, max: 30 } : { ideal: 30 },
        ...(camId ? { deviceId: { exact: camId } } : { facingMode: 'user' }),
      },
      audio: {
        channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
        echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing,
        ...(micId ? { deviceId: { exact: micId } } : {}),
      },
    });
    try {
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints(true));
    } catch (err) {
      // Alguna cámara no admite el tope: entonces sin él, como antes.
      if (err.name !== 'OverconstrainedError') throw err;
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints(false));
    }
    vigilarPistas(state.localStream);
    $('#preview').srcObject = state.localStream;
    $('#localVideo').srcObject = state.localStream;
    await fillDevices();
    const s = state.localStream.getVideoTracks()[0].getSettings();
    $('#previewInfo').textContent = `${s.width}×${s.height} · ${Math.round(s.frameRate || 30)} fps`;
    // Si ya hay llamada, se sustituyen las pistas enviadas sin renegociar.
    if (state.audio) rewireMic();
    if (state.pc) {
      for (const sender of state.pc.getSenders()) {
        const t = state.localStream.getTracks().find((x) => sender.track && x.kind === sender.track.kind);
        if (t) sender.replaceTrack(t);
      }
    }
  }

  async function fillDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const fill = (sel, kind, current) => {
      const prev = sel.value || current;
      sel.innerHTML = '';
      devices.filter((d) => d.kind === kind).forEach((d, i) => {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || `${kind === 'videoinput' ? 'Cámara' : 'Micrófono'} ${i + 1}`;
        sel.appendChild(o);
      });
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    };
    const vt = state.localStream?.getVideoTracks()[0];
    const at = state.localStream?.getAudioTracks()[0];
    fill($('#camera'), 'videoinput', vt?.getSettings().deviceId);
    fill($('#mic'), 'audioinput', at?.getSettings().deviceId);
  }

  // ------------------------------------------------------------------ audio (WebAudio)
  async function setupAudio() {
    let ctx;
    try { ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' }); } catch { ctx = new AudioContext(); }
    await ctx.resume();
    // Si el audio se detiene (en iPad: una llamada, Siri, salir de Safari…), el WAV se queda sin esas muestras
    // y lo que viene detrás se adelanta. Se anota, se intenta reanudar y, si hace falta, se pide un toque.
    ctx.onstatechange = () => {
      Registro.anotar('audio-estado', { estado: ctx.state, grabando: !!state.rec });
      if (ctx.state !== 'running' && state.rec) {
        ctx.resume().catch(() => {});
        toast('El audio se ha detenido: toca la pantalla para reanudarlo.', 'error');
      }
    };
    document.addEventListener('pointerdown', () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); });
    await ctx.audioWorklet.addModule('js/pcm-worklet.js');
    const recBus = ctx.createGain();          // micrófono + claqueta → grabaciones locales
    const mixBus = ctx.createGain();          // recBus + audio remoto → grabación de la llamada
    const recDest = ctx.createMediaStreamDestination();
    const mixDest = ctx.createMediaStreamDestination();
    recBus.connect(recDest);
    recBus.connect(mixBus);
    mixBus.connect(mixDest);
    // Medidor de nivel del micrófono.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    recBus.connect(analyser);
    state.ctx = ctx;
    state.audio = { recBus, mixBus, recDest, mixDest, analyser, mic: null, remote: null };
    rewireMic();
    meterLoop();
  }

  function rewireMic() {
    const a = state.audio;
    if (a.mic) a.mic.disconnect();
    a.mic = state.ctx.createMediaStreamSource(state.localStream);
    a.mic.connect(a.recBus);
    // Otro micro: su nivel se mide de cero.
    state.nivelMicro = [];
    if (state.micEstado) ponerMicEstado(null, null);
  }

  function connectRemoteAudio(stream) {
    const a = state.audio;
    if (!a) return;
    if (a.remote) { a.remote.disconnect(); a.remote = null; }
    if (stream && stream.getAudioTracks().length) {
      a.remote = state.ctx.createMediaStreamSource(stream);
      a.remote.connect(a.mixBus);
    }
  }

  function meterLoop() {
    const buf = new Float32Array(state.audio.analyser.fftSize);
    const bar = $('#meter');
    // Además del medidor, el nivel de cada 100 ms (últimos 20 s): con él se avisa si el micro llega bajo o satura.
    let acum = { sq: 0, n: 0, pico: 0, desde: performance.now() };
    let revisado = 0;
    const tick = () => {
      state.audio.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      let sq = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = Math.abs(buf[i]);
        if (v > peak) peak = v;
        sq += v * v;
      }
      const db = 20 * Math.log10(peak || 1e-6);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      bar.style.width = `${pct}%`;
      bar.className = db > -3 ? 'clip' : db > -12 ? 'hot' : '';
      acum.sq += sq;
      acum.n += buf.length;
      acum.pico = Math.max(acum.pico, peak);
      const ahora = performance.now();
      if (ahora - acum.desde >= 100) {
        state.nivelMicro.push({ rms: 10 * Math.log10(acum.sq / acum.n || 1e-12), pico: 20 * Math.log10(acum.pico || 1e-6) });
        if (state.nivelMicro.length > 200) state.nivelMicro.shift();
        acum = { sq: 0, n: 0, pico: 0, desde: ahora };
      }
      if (ahora - revisado >= 1000) { revisado = ahora; revisarMicro(); }
      requestAnimationFrame(tick);
    };
    tick();
  }

  /** Aviso si la voz llega baja o satura (en mi imagen, y a la otra persona por el estado). */
  function revisarMicro() {
    const pista = state.localStream?.getAudioTracks()[0];
    if (pista && !pista.enabled) return; // silenciado: no se mide
    const { estado, vozDb } = Llamada.nivelDelMicro(state.nivelMicro);
    if (estado === null || estado === state.micEstado) return;
    ponerMicEstado(estado, vozDb);
  }
  function ponerMicEstado(estado, vozDb) {
    state.micEstado = estado;
    state.micVozDb = vozDb;
    if (estado) Registro.anotar('micro', { estado, voz_db: vozDb });
    const aviso = $('#micAviso');
    aviso.textContent = Llamada.avisoDeMicro(estado);
    aviso.hidden = !aviso.textContent;
    sendStatusSoon();
  }

  /** Convierte una hora local (ms) al reloj del AudioContext (s). */
  function ctxTimeFor(localMs) {
    const ctx = state.ctx;
    const ts = ctx.getOutputTimestamp ? ctx.getOutputTimestamp() : null;
    if (ts && ts.performanceTime > 0) {
      return ts.contextTime + (localMs - (performance.timeOrigin + ts.performanceTime)) / 1000;
    }
    return ctx.currentTime + (localMs - localNow()) / 1000;
  }
  function scheduleBeep(atCtx) {
    const osc = state.ctx.createOscillator();
    const g = state.ctx.createGain();
    osc.frequency.value = BEEP_HZ;
    g.gain.setValueAtTime(0, atCtx);
    g.gain.linearRampToValueAtTime(0.5, atCtx + 0.002);
    g.gain.setValueAtTime(0.5, atCtx + BEEP_SEC - 0.002);
    g.gain.linearRampToValueAtTime(0, atCtx + BEEP_SEC);
    osc.connect(g).connect(state.audio.recBus);
    osc.start(atCtx);
    osc.stop(atCtx + BEEP_SEC + 0.05);
  }

  // ------------------------------------------------------------------ sala y señalización
  async function join() {
    const name = $('#name').value.trim();
    const room = $('#room').value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    if (!name) throw new Error('Escribe tu nombre');
    if (!room) throw new Error('Escribe el nombre de la sala');
    localStorage.setItem('estudio.name', name);
    localStorage.setItem('estudio.room', room);
    localStorage.setItem('estudio.res', $('#resolution').value);
    localStorage.setItem('estudio.headphones', $('#headphones').checked ? '1' : '0');
    localStorage.setItem('estudio.recordCall', $('#recordCall').checked ? '1' : '0');
    state.me.name = name;
    state.room = room;

    $('#btnJoin').disabled = true;
    try {
      if (!state.localStream) await startPreview();
      await setupAudio();           // dentro del clic: necesario en iPad
      const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => null);
      if (cfg?.iceServers) state.iceServers = cfg.iceServers;
      state.lanUrls = cfg?.lanUrls || [];
      state.publicUrl = cfg?.publicUrl || '';
      state.accessKey = cfg?.accessKey || '';
      state.hasTurn = !!cfg?.turn;
      state.clock = await Clock.sample(12);
    } finally {
      $('#btnJoin').disabled = false;
    }
    // Muestras de reloj continuas (ligeras): la estimación usa la más rápida del último minuto.
    setInterval(() => { Clock.sample(2).then(updateClock).catch(() => {}); }, 5000);

    // Se conserva la clave en la dirección para que funcione al guardarla en la pantalla de inicio del iPad.
    const k = new URLSearchParams(location.search).get('k');
    history.replaceState(null, '', `?sala=${encodeURIComponent(room)}${k ? `&k=${encodeURIComponent(k)}` : ''}`);
    $('#setup').hidden = true;
    $('#studio').hidden = false;
    $('#roomName').textContent = room;
    $('#localName').textContent = `${name} (tú)`;
    $('#inviteLink').value = inviteUrl();
    updateClock(state.clock);
    Registro.iniciar({ room, peer: state.me.id, nombre: name, latido: latidoDatos });
    Registro.anotar('sala', { sala: room, nombre: name, dispositivo: state.me.device, resolucion: $('#resolution').value });
    connectEvents();
    // Red de seguridad por si se pierde una orden de grabar o de parar (un corte justo entonces), y el
    // estado propio repetido de vez en cuando por si la otra página se perdió el último.
    setInterval(vigilarGrabacion, 5000);
    setInterval(sendStatus, 5000);
    window.addEventListener('beforeunload', (e) => {
      if (state.rec || state.uploaders.some((u) => !u.finished)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  /**
   * Mira cómo está la grabación de la sala en el servidor y corrige esta página si se perdió una orden:
   * empieza (un tramo sin pitido) si hay una grabación en marcha y no graba, y para si sigue grabando una
   * sesión que ya terminó. Se deja tiempo a la orden normal, que llega con cuenta atrás y pitido.
   */
  let vigilando = false;
  async function vigilarGrabacion() {
    if (vigilando || state.rec?.stopping) return;
    vigilando = true;
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(state.room)}/sesion`, { cache: 'no-store' });
      if (!r.ok) return;
      const { session } = await r.json();
      aplicarMarcas(session);   // por si se perdió el aviso de un tramo ✂ abierto o cerrado
      const accion = Llamada.alRecibirGrabacion({ recuperando: false, grabando: !!state.rec, miSesion: state.rec?.session.id, sesion: session });
      if (accion === 'nada' || Llamada.esPronto({ accion, sesion: session, ahora: serverNow() })) return;
      Registro.anotar('grabacion-corregida', { accion, sesion: session?.id });
      aplicarGrabacion(accion, session);
    } catch { /* sin conexión: se vuelve a mirar en unos segundos */ } finally {
      vigilando = false;
    }
  }

  /** Lleva a cabo lo que decidió Llamada.alRecibirGrabacion. */
  function aplicarGrabacion(accion, sesion) {
    if (accion === 'retomar' || accion === 'unirse') {
      if (accion === 'retomar') state.recuperando = false;   // una sola vez: las bienvenidas siguientes no arrancan otra
      // Si la hora de empezar aún no ha llegado, se empieza como siempre (con pitido); si ya pasó, como tramo tardío.
      const tarde = !(sesion.startAt - serverNow() > 500);
      toast(accion === 'retomar' ? 'Retomando la grabación…' : 'Hay una grabación en marcha: empiezas a grabar ya.', 'warn');
      startRecording(sesion, tarde ? { tarde: true, retomada: accion === 'retomar' } : {})
        .catch((err) => { console.error(err); toast(`No se pudo grabar: ${err.message}`, 'error'); });
    } else if (accion === 'parar') {
      toast('La grabación ya había terminado: se para también aquí.', 'warn');
      stopRecording(sesion);   // si su pitido final aún no ha sonado, se graba; si ya pasó, se para sin él
    } else if (accion === 'cambiar') {
      // Se para ya la sesión vieja y, en cuanto termina, se une a la nueva.
      stopRecording({ ...state.rec.session, stopAt: serverNow(), endBeepAt: null });
      setTimeout(() => aplicarGrabacion('unirse', sesion), 500);
    } else if (accion === 'terminada') {
      state.recuperando = false;
      marcarRecuperacion(null);
      toast('La grabación ya había terminado. Los archivos que no se llegaron a subir aparecen en «Grabaciones sin terminar de subir».', 'warn');
    }
  }

  function updateClock(c) {
    state.clock = c;
    const el = $('#clockInfo');
    el.textContent = `sincronía ±${Math.max(1, Math.round(c.rtt / 2))} ms`;
    el.title = `Precisión estimada del reloj común (fuente: ${c.source})`;
    el.classList.toggle('bad', c.rtt / 2 > 40);
  }

  function inviteUrl() {
    // Prioridad: enlace público de internet; desde localhost, la IP del PC en la red local; si no, esta misma dirección.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const origin = state.publicUrl || (local && state.lanUrls?.length ? state.lanUrls[0] : location.origin);
    // El enlace público lleva la clave de acceso; sin ella el estudio no se abre desde internet.
    const key = state.publicUrl ? (state.accessKey || '') : (new URLSearchParams(location.search).get('k') || '');
    return `${origin}${location.pathname}?sala=${encodeURIComponent(state.room)}${key ? `&k=${encodeURIComponent(key)}` : ''}`;
  }

  /** Canal de eventos de la sala por WebSocket, con reconexión automática. */
  function connectEvents(attempt = 0) {
    const q = new URLSearchParams({ peer: state.me.id, name: state.me.name, device: state.me.device });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${encodeURIComponent(state.room)}/ws?${q}`);
    state.events = ws;
    let opened = false;
    const handlers = {
      welcome: onWelcome,
      'peer-joined': (p) => {
        const mismoRemoto = state.remote?.id === p.id;
        const accion = Llamada.alEntrarOtro({ volvio: p.volvio, mismoRemoto, estadoPc: state.pc?.connectionState });
        Registro.anotar('persona-entra', { nombre: p.name, volvio: !!p.volvio, accion, pc: state.pc?.connectionState });
        if (accion === 'mantener') {
          // Solo se había caído el canal de la sala: la llamada (vídeo y audio) sigue, no se toca.
          toast(`${p.name} ha vuelto`);
          $('#remoteState').textContent = state.pc?.connectionState === 'connected' ? '' : 'reconectando…';
          return;
        }
        toast(`${p.name} ha entrado`);
        sendStatusSoon();   // que sepa enseguida si esta página graba
        startCall(p, false);
        // Misma página pero con su llamada muerta: se pide a la otra parte que ofrezca una nueva.
        if (p.volvio && mismoRemoto) { state.rehaciendo = true; sendSignal(p.id, { reiniciar: true }); }
      },
      'peer-away': ({ id, graciaMs }) => {
        if (state.remote?.id !== id) return;
        Registro.anotar('persona-ausente', { nombre: state.remote.name, gracia_s: graciaMs / 1000, pc: state.pc?.connectionState });
        toast(`${state.remote.name} ha perdido la conexión con la sala. Se espera a que vuelva…`, 'warn');
      },
      'peer-left': ({ id }) => {
        if (state.remote?.id !== id) return;
        Registro.anotar('persona-sale', { nombre: state.remote.name });
        toast(`${state.remote.name} ha salido`, 'warn');
        closeCall();
        setRemote(null);
      },
      signal: onSignal,
      status: (d) => { state.remoteStatus = d.status; renderRemoteStatus(); },
      'record-start': (d) => {
        aplicarMarcas(d);
        // Si esta página seguía grabando una sesión anterior (se perdió su parada), la cierra y empieza la nueva.
        if (state.rec && state.rec.session.id !== d.id) { aplicarGrabacion('cambiar', d); return; }
        startRecording(d).catch((err) => { console.error(err); toast(`Error al grabar: ${err.message}`, 'error'); });
      },
      'record-stop': (d) => { aplicarMarcas(d); stopRecording(d); },
      marca: (d) => {
        aplicarMarcas(d.session);
        if (d.de === state.me.id) return;   // quien la puso ya vio su aviso
        const aviso = Llamada.avisoDeMarca(d.marca, { propia: false });
        if (aviso) toast(aviso.texto, aviso.tipo);
      },
      'room-full': (d) => { state.roomFull = true; setConn('Sala llena'); toast(d.error, 'error'); },
    };
    ws.onopen = () => { opened = true; setConn('Conectado a la sala'); Registro.anotar('ws-abierto', { intento: attempt }); };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handlers[msg.event]?.(msg.data);
    };
    ws.onclose = (e) => {
      Registro.anotar('ws-cerrado', { codigo: e.code, motivo: e.reason, estuvo_abierto: opened });
      if (state.events !== ws || state.roomFull) return;
      setConn('Reconectando…');
      const next = opened ? 0 : attempt + 1;
      setTimeout(() => connectEvents(next), Math.min(1000 * 2 ** next, 15000));
    };
  }

  function onWelcome(d) {
    setConn('Conectado a la sala');
    sendStatusSoon();   // la otra persona ve enseguida si esta página graba o no
    if (d.inviteCopied) toast('Enlace de invitación copiado: pégalo en WhatsApp o en un correo para la otra persona.');
    if (d.peers.length) {
      const otro = d.peers[0];
      const accion = Llamada.alVolver({ volvio: d.volvio, mismoRemoto: state.remote?.id === otro.id, estadoPc: state.pc?.connectionState });
      Registro.anotar('bienvenida', { otro: otro.name, otro_ausente: !!otro.ausente, volvio: !!d.volvio, accion, pc: state.pc?.connectionState });
      // Si solo se cayó el canal de la sala y la llamada sigue viva, se conserva. Si no, soy el último en llegar: la inicio.
      if (accion !== 'mantener') startCall(otro, true);
    } else {
      closeCall();
      setRemote(null);
    }
    aplicarMarcas(d.session);
    // Al (re)entrar se mira la grabación de la sala: si se perdió la orden de grabar o de parar, se corrige ya.
    const accion = Llamada.alRecibirGrabacion({ recuperando: state.recuperando, grabando: !!state.rec, miSesion: state.rec?.session.id, sesion: d.session });
    if (accion !== 'nada') Registro.anotar('grabacion-en-curso', { accion, sesion: d.session?.id });
    if (accion !== 'parar' || !state.rec?.stopping) aplicarGrabacion(accion, d.session);
  }

  function setConn(text) { $('#connInfo').textContent = text; }

  /** Estado que se anota en cada latido (cada 30 s): si la página muere, el último latido dice cómo estaba. */
  function latidoDatos() {
    const v = state.localStream?.getVideoTracks()[0];
    const a = state.localStream?.getAudioTracks()[0];
    return {
      grabando: !!state.rec,
      grabadores: state.rec ? state.rec.recorders.map((r) => r.recorder.state).join('+') : '',
      sala_ws: state.events?.readyState,
      llamada: state.pc?.connectionState || 'ninguna',
      ice: state.pc?.iceConnectionState,
      con: state.remote?.name,
      cam: v?.readyState,
      cam_apagada: v?.muted,
      mic: a?.readyState,
      reloj_rtt_ms: Math.round(state.clock.rtt),
      subidas_pendientes: state.uploaders.filter((u) => !u.finished).length,
      subidas_con_error: state.uploaders.filter((u) => u.error).length,
      audio: state.ctx?.state,
      // Cuánto se ha quedado atrás el reloj del audio desde que empezó la grabación: si el audio se detuvo
      // (p. ej. una llamada en el iPad), el WAV tiene un hueco de ese tamaño y lo de detrás va adelantado.
      audio_retraso_ms: state.rec?.worklet?.startCtx && state.ctx
        ? Math.round((localNow() - state.rec.startLocal) - (state.ctx.currentTime - state.rec.worklet.startCtx) * 1000) : undefined,
      otro_graba: state.remoteStatus ? !!state.remoteStatus.recording : undefined,
      mic_nivel: state.micEstado || undefined,
      mic_voz_db: state.micVozDb ?? undefined,
    };
  }

  /** Anota cuando la cámara o el micro se paran o se quedan sin señal (un fallo así cortaría la grabación). */
  function vigilarPistas(stream) {
    for (const t of stream.getTracks()) {
      t.addEventListener('ended', () => Registro.anotar('error', { mensaje: `pista ${t.kind} terminada`, etiqueta: t.label }));
      t.addEventListener('mute', () => Registro.anotar('pista-sin-senal', { tipo: t.kind }));
      t.addEventListener('unmute', () => Registro.anotar('pista-con-senal', { tipo: t.kind }));
    }
  }

  function sendSignal(to, data) {
    state.signalChain = state.signalChain.then(() => fetch(`/api/rooms/${encodeURIComponent(state.room)}/signal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // `cid` identifica esta llamada: permite a la otra parte distinguir mensajes de una llamada anterior.
      body: JSON.stringify({ from: state.me.id, to, data: { cid: state.callId, ...data } }),
    })).catch((err) => console.warn('señal', err));
    return state.signalChain;
  }

  function closeCall() {
    if (state.pc) { state.pc.onicecandidate = null; state.pc.ontrack = null; state.pc.close(); }
    clearInterval(state.clockPing);
    state.pc = null;
    state.pendingCandidates = [];
    connectRemoteAudio(null);
  }

  function startCall(peer, offerer) {
    closeCall();
    state.offerer = offerer;
    state.callId = randomId();
    state.remoteCid = null;
    if (offerer) state.rehaciendo = false;
    setRemote({ ...peer, stream: new MediaStream() });
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.pc = pc;
    Registro.anotar('llamada-inicia', { con: peer.name, ofrece: offerer, cid: state.callId });
    pc.oniceconnectionstatechange = () => Registro.anotar('ice', { estado: pc.iceConnectionState });
    pc.onsignalingstatechange = () => Registro.anotar('senalizacion', { estado: pc.signalingState });
    for (const t of state.localStream.getTracks()) pc.addTrack(t, state.localStream);
    // Prioriza calidad de la llamada sin afectar a la grabación local (que usa la cámara directamente).
    for (const s of pc.getSenders()) {
      if (s.track?.kind === 'video') {
        const p = s.getParameters();
        p.encodings = p.encodings?.length ? p.encodings : [{}];
        p.encodings[0].maxBitrate = 2_500_000;
        s.setParameters(p).catch(() => {});
      }
    }
    setupClockChannel(pc);
    pc.onicecandidate = (e) => { if (e.candidate) sendSignal(peer.id, { candidate: e.candidate.toJSON() }); };
    pc.ontrack = (e) => {
      const stream = state.remote.stream;
      if (!stream.getTracks().includes(e.track)) stream.addTrack(e.track);
      $('#remoteVideo').srcObject = stream;
      $('#remoteVideo').play().catch(() => {});
      if (e.track.kind === 'audio') connectRemoteAudio(stream);
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      Registro.anotar('llamada', { estado: st });
      $('#remoteState').textContent = { connected: '', connecting: 'conectando…', failed: 'sin conexión de vídeo', disconnected: 'reconectando…' }[st] ?? st;
      if (st === 'connected') { state.rehaciendo = false; reportRoute(pc); }
      if (st === 'failed') {
        if (state.offerer) pc.restartIce();
        toast(state.hasTurn
          ? 'No se pudo conectar la llamada. Reintentando…'
          : 'La llamada no conecta entre estas dos redes. Configura un servidor TURN (ver README). La grabación local funciona igualmente.', 'warn');
      }
    };
    pc.onnegotiationneeded = async () => {
      if (!state.offerer || state.pc !== pc) return;
      try {
        await pc.setLocalDescription();
        sendSignal(peer.id, { description: pc.localDescription.toJSON() });
      } catch (err) { console.error(err); }
    };
  }

  /**
   * Canal de datos directo para afinar el reloj: si la otra persona está en el mismo PC que el servidor
   * (su reloj es casi exacto), sus respuestas son muestras de reloj con menos latencia que pasar por el túnel.
   */
  function setupClockChannel(pc) {
    let ch;
    try { ch = pc.createDataChannel('reloj', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 }); } catch { return; }
    ch.onmessage = (e) => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'ping') {
        // Solo responde quien tiene un reloj de referencia fiable (±2 ms).
        if (state.clock.rtt < 4) ch.send(JSON.stringify({ t: 'pong', t0: m.t0, server: serverNow(), q: state.clock.rtt }));
      } else if (m.t === 'pong' && m.q < 4) {
        Clock.addSample({ t0: m.t0, server: m.server, t1: localNow(), source: 'directo' });
        updateClock(Clock.estimate());
      }
    };
    ch.onopen = () => {
      clearInterval(state.clockPing);
      state.clockPing = setInterval(() => {
        if (ch.readyState === 'open' && state.clock.rtt >= 4) ch.send(JSON.stringify({ t: 'ping', t0: localNow() }));
      }, 1000);
    };
  }

  /** Indica si la llamada va directa o retransmitida por TURN. */
  async function reportRoute(pc) {
    try {
      const stats = await pc.getStats();
      let pair = null;
      stats.forEach((r) => { if (r.type === 'transport' && r.selectedCandidatePairId) pair = stats.get(r.selectedCandidatePairId); });
      if (!pair) stats.forEach((r) => { if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pair = r; });
      const local = pair && stats.get(pair.localCandidateId);
      const relay = local?.candidateType === 'relay';
      Registro.anotar('ruta', { tipo: relay ? 'TURN' : 'directa', candidato: local?.candidateType });
      $('#routeInfo').textContent = relay ? 'llamada vía TURN' : 'llamada directa';
      $('#routeInfo').hidden = false;
    } catch { /* sin estadísticas */ }
  }

  async function onSignal({ from, data }) {
    if (!state.remote || state.remote.id !== from) return;
    // La otra parte rehízo su llamada como respondedora y pide que ofrezca una nueva (o decidimos por desempate).
    if (data.reiniciar) {
      const accion = Llamada.alPedirReinicio({ yoTambienRehago: !!state.rehaciendo, miId: state.me.id, otroId: from });
      Registro.anotar('reinicio-pedido', { accion });
      if (accion === 'ofrecer') startCall(state.remote, true);
      return;
    }
    const esOferta = data.description?.type === 'offer';
    // Una oferta de otra conexión de la misma persona: se rehace la llamada de cero en lugar de mezclarla con la actual.
    if (esOferta && Llamada.ofertaNueva({ cidActual: state.remoteCid, cidMensaje: data.cid })) {
      Registro.anotar('oferta-nueva', { cid: data.cid });
      startCall(state.remote, false);
    }
    // Mensajes sueltos (candidatos) de una llamada anterior que ya no existe: se ignoran.
    if (Llamada.esDeLlamadaAnterior({ cidActual: state.remoteCid, cidMensaje: data.cid, esOferta })) return;
    if (data.cid) state.remoteCid = data.cid;
    if (!state.pc) return;
    const pc = state.pc;
    try {
      if (data.description) {
        await pc.setRemoteDescription(data.description);
        if (data.description.type === 'offer') {
          await pc.setLocalDescription();
          sendSignal(from, { description: pc.localDescription.toJSON() });
        }
        for (const c of state.pendingCandidates.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {});
        else state.pendingCandidates.push(data.candidate);
      }
    } catch (err) { console.error('señalización', err); }
  }

  function setRemote(peer) {
    state.remote = peer;
    $('#remoteName').textContent = peer ? `${peer.name}${peer.device ? ` · ${peer.device}` : ''}` : '';
    $('#waiting').hidden = !!peer;
    $('#remoteState').textContent = peer ? 'conectando…' : '';
    if (!peer) { $('#remoteVideo').srcObject = null; state.remoteStatus = null; renderRemoteStatus(); }
  }

  // ------------------------------------------------------------------ grabación
  function pickMime(kind) {
    const video = [
      'video/mp4;codecs=avc1.640028,mp4a.40.2',
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
      'video/mp4',
    ];
    const list = kind === 'video' ? video : ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
    return list.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
  }

  async function requestRecord(action) {
    const r = await fetch(`/api/rooms/${encodeURIComponent(state.room)}/record`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, from: state.me.id }),
    });
    const j = await r.json();
    if (!r.ok) throw Object.assign(new Error(j.error || 'Error'), { status: r.status });
  }

  /**
   * Empieza a grabar. Con `tarde` (retomar tras la caída de la página, o unirse a una grabación que ya estaba en
   * marcha) se graba ya mismo, sin cuenta atrás, sin pitido ni destello (sonarían en mitad de la conversación) y
   * como un tramo nuevo de la misma sesión. `retomada` dice que viene de una caída de la página.
   * La sincronía con el resto sigue saliendo de la hora de inicio de cada pista y de la grabación de la llamada.
   */
  async function startRecording(sessionServidor, { tarde = false, retomada = false } = {}) {
    if (state.rec) return;
    // Se libera el espacio de grabaciones anteriores ya subidas.
    for (const u of state.uploaders.filter((x) => x.finished)) await u.deleteLocal().catch(() => {});
    state.uploaders = state.uploaders.filter((u) => !u.finished);

    const startLocal = tarde ? localNow() + 500 : sessionServidor.startAt - state.clock.offset;
    const beepLocal = tarde ? null : sessionServidor.beepAt - state.clock.offset;
    // Para este dispositivo la «hora de inicio programada» es la real; sin claqueta no hay pitido que medir.
    const session = tarde ? { ...sessionServidor, startAt: startLocal + state.clock.offset, beepAt: null } : sessionServidor;
    const res = RESOLUTIONS[$('#resolution').value] || RESOLUTIONS['1080'];
    const vs = state.localStream.getVideoTracks()[0].getSettings();
    const base = {
      room: state.room, session: session.id, participant: state.me.id, name: state.me.name, device: state.me.device,
      ...(retomada ? { retomada: true } : tarde ? { tarde: true } : {}),
    };
    const rec = { session, startLocal, recorders: [], worklet: null, canvasTimer: null, stopping: false, tarde };
    state.rec = rec;
    // Marca de recuperación: si esta página muere grabando, la siguiente podrá ofrecer retomar.
    const marca = () => marcarRecuperacion({ grabando: true, sala: state.room, nombre: state.me.name, sesion: session.id });
    marca();
    rec.marcaTimer = setInterval(marca, 5000);
    Registro.anotar('grabacion-inicio', { sesion: session.id, resolucion: `${vs.width}x${vs.height}`, fps: vs.frameRate, tarde, retomada });
    requestWakeLock();
    setRecordingUi('armed');

    // 1) Cámara + micrófono en alta calidad
    const camStream = new MediaStream([state.localStream.getVideoTracks()[0], state.audio.recDest.stream.getAudioTracks()[0]]);
    const vMime = pickMime('video');
    rec.recorders.push(makeRecorder(camStream, {
      ...base, kind: 'camara', mime: vMime, width: vs.width, height: vs.height, frameRate: vs.frameRate,
    }, { videoBitsPerSecond: res.bitrate, audioBitsPerSecond: 256_000 }));

    // 2) Audio WAV sin pérdida (con inicio exacto por muestra)
    const wav = new TrackUploader({ ...base, kind: 'audio', format: 'wav', mime: 'audio/wav', sampleRate: state.ctx.sampleRate, channels: 1 });
    addUploader(wav);
    const node = new AudioWorkletNode(state.ctx, 'pcm-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    const sink = state.ctx.createGain(); sink.gain.value = 0;
    state.audio.recBus.connect(node); node.connect(sink).connect(state.ctx.destination);
    const pcm = { node, sink, uploader: wav, parts: [], samples: 0, total: 0, startedAtServer: null, startCtx: 0, session };
    rec.worklet = pcm;
    node.port.onmessage = (e) => onPcmMessage(pcm, e.data);
    await wav.start();
    const startCtx = ctxTimeFor(startLocal);
    pcm.startCtx = startCtx;
    node.port.postMessage({ cmd: 'start', at: startCtx });

    // 3) La llamada (las dos cámaras lado a lado + audio mezclado), como referencia
    if ($('#recordCall').checked) {
      const canvas = document.createElement('canvas');
      canvas.width = 1280; canvas.height = 720;
      const c2d = canvas.getContext('2d');
      const draw = () => drawComposite(c2d, canvas);
      draw();
      rec.canvasTimer = setInterval(draw, 1000 / 30);
      const cStream = canvas.captureStream(30);
      const mixed = new MediaStream([cStream.getVideoTracks()[0], state.audio.mixDest.stream.getAudioTracks()[0]]);
      rec.recorders.push(makeRecorder(mixed, { ...base, kind: 'llamada', mime: vMime, width: 1280, height: 720, frameRate: 30 },
        { videoBitsPerSecond: 4_000_000, audioBitsPerSecond: 192_000 }));
    }

    for (const r of rec.recorders) await r.uploader.start();

    // Claqueta digital: pitido de 1 kHz en todas las grabaciones a la misma hora del servidor.
    if (!tarde) scheduleBeep(ctxTimeFor(beepLocal));

    // Cuenta atrás y arranque sincronizado.
    const wait = startLocal - localNow();
    if (wait < 0 && !tarde) toast('La orden de grabar llegó tarde; se sincronizará con el pitido.', 'warn');
    if (!tarde) countdown(startLocal);
    setTimeout(() => {
      for (const r of rec.recorders) {
        r.startedAtServer = serverNow();
        r.recorder.start(1000);
        r.uploader.anotarInicio(r.startedAtServer);   // queda en el servidor aunque esta página muera
      }
      setRecordingUi('recording');
      timerLoop();
    }, Math.max(0, wait));
    if (!tarde) setTimeout(flash, Math.max(0, beepLocal - localNow()));
  }

  function makeRecorder(stream, info, opts) {
    const uploader = new TrackUploader(info);
    addUploader(uploader);
    let recorder;
    try { recorder = new MediaRecorder(stream, { mimeType: info.mime, ...opts }); } catch {
      recorder = new MediaRecorder(stream, opts);
      info.mime = recorder.mimeType;
    }
    const r = { recorder, uploader, info, startedAtServer: null, endedAtServer: null, beepAt: state.rec.session.beepAt };
    recorder.ondataavailable = (e) => {
      if (!info.mime && e.data.type) info.mime = e.data.type;
      uploader.push(e.data);
    };
    recorder.onstart = () => Registro.anotar('grabador-inicio', { pista: info.kind, mime: info.mime });
    recorder.onstop = () => {
      Registro.anotar('grabador-fin', { pista: info.kind });
      // Se espera a que se guarde el último trozo antes de cerrar la pista.
      setTimeout(() => uploader.finish(finishInfo(r.startedAtServer, r.endedAtServer, r.beepAt, r.endBeepAt)), 200);
    };
    recorder.onerror = (e) => {
      Registro.anotar('error', { mensaje: `grabador ${info.kind}: ${e.error?.message || e.error?.name || ''}` });
      toast(`Error del grabador (${info.kind}): ${e.error?.message || ''}`, 'error');
    };
    return r;
  }

  // Los tiempos son orientativos (el evento "start" de MediaRecorder puede llegar tarde);
  // la referencia exacta para sincronizar es el pitido.
  function finishInfo(startedAtServer, endedAtServer, beepAt, endBeepAt) {
    return {
      startedAtServer, endedAtServer,
      beepOffsetSec: beepAt && startedAtServer ? (beepAt - startedAtServer) / 1000 : null,
      endBeepOffsetSec: endBeepAt && startedAtServer ? (endBeepAt - startedAtServer) / 1000 : null,
      clockRttMs: state.clock.rtt,
      userAgent: navigator.userAgent,
    };
  }

  function onPcmMessage(pcm, msg) {
    if (msg.type === 'started') {
      // Mismo dominio de reloj que el pitido: el inicio exacto respecto a la hora programada.
      pcm.startedAtServer = pcm.session.startAt + (msg.time - pcm.startCtx) * 1000;
      pcm.uploader.anotarInicio(pcm.startedAtServer);
    } else if (msg.type === 'data') {
      pcm.parts.push(msg.samples);
      pcm.samples += msg.samples.length;
      if (pcm.samples >= state.ctx.sampleRate) flushPcm(pcm);   // ~1 s por trozo
    } else if (msg.type === 'stopped') {
      flushPcm(pcm);
      const endedAtServer = pcm.startedAtServer + (pcm.total / state.ctx.sampleRate) * 1000;
      pcm.uploader.finish(finishInfo(pcm.startedAtServer, endedAtServer, pcm.session.beepAt, pcm.endBeepAt));
      pcm.node.disconnect(); pcm.sink.disconnect();
      try { state.audio.recBus.disconnect(pcm.node); } catch { /* ya desconectado */ }
    }
  }

  function flushPcm(pcm) {
    if (!pcm.samples) return;
    const out = new Int16Array(pcm.samples);
    let o = 0;
    for (const part of pcm.parts) {
      for (let i = 0; i < part.length; i++) {
        const v = Math.max(-1, Math.min(1, part[i]));
        out[o++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      }
    }
    pcm.total += pcm.samples;
    pcm.parts = []; pcm.samples = 0;
    pcm.uploader.push(new Blob([out.buffer], { type: 'application/octet-stream' }));
  }

  function stopRecording(session) {
    const rec = state.rec;
    if (!rec || rec.stopping) return;
    rec.stopping = true;
    // Una parada normal no debe dejar marca de «se cerró grabando».
    clearInterval(rec.marcaTimer);
    marcarRecuperacion(null);
    Registro.anotar('grabacion-fin', { sesion: session.id });
    const stopLocal = (session.stopAt || serverNow()) - state.clock.offset;
    // Pitido final: con el inicial permite medir y corregir la deriva entre los relojes de los dispositivos.
    const endBeepLocal = session.endBeepAt ? session.endBeepAt - state.clock.offset : null;
    const endBeepAt = endBeepLocal && endBeepLocal - localNow() > 50 && stopLocal - endBeepLocal > 0.3 * 1000 ? session.endBeepAt : null;
    if (endBeepAt) {
      scheduleBeep(ctxTimeFor(endBeepLocal));
      setTimeout(flash, endBeepLocal - localNow());
    }
    for (const r of rec.recorders) r.endBeepAt = endBeepAt;
    rec.worklet.endBeepAt = endBeepAt;
    rec.worklet.node.port.postMessage({ cmd: 'stop', at: ctxTimeFor(stopLocal) });
    setRecordingUi('stopping');
    setTimeout(() => {
      for (const r of rec.recorders) if (r.recorder.state !== 'inactive') { r.endedAtServer = serverNow(); r.recorder.stop(); }
      clearInterval(rec.canvasTimer);
      state.rec = null;
      releaseWakeLock();
      setRecordingUi('idle');
      toast('Grabación terminada. Subiendo archivos…');
    }, Math.max(0, stopLocal - localNow()));
  }

  function drawComposite(c, canvas) {
    const W = canvas.width; const H = canvas.height;
    c.fillStyle = '#111'; c.fillRect(0, 0, W, H);
    const tiles = [
      { video: $('#localVideo'), name: state.me.name },
      { video: $('#remoteVideo'), name: state.remote?.name || '' },
    ];
    const tw = W / 2; const th = (tw * 9) / 16; const ty = (H - th) / 2;
    tiles.forEach((t, i) => {
      const v = t.video; const x = i * tw;
      if (v && v.videoWidth && v.readyState >= 2) {
        // Recorte tipo "cover" para rellenar el recuadro 16:9.
        const vr = v.videoWidth / v.videoHeight; const tr = tw / th;
        let sw = v.videoWidth; let sh = v.videoHeight; let sx = 0; let sy = 0;
        if (vr > tr) { sw = sh * tr; sx = (v.videoWidth - sw) / 2; } else { sh = sw / tr; sy = (v.videoHeight - sh) / 2; }
        c.drawImage(v, sx, sy, sw, sh, x, ty, tw, th);
      }
      if (t.name) {
        c.font = '600 22px system-ui, sans-serif';
        const w = c.measureText(t.name).width + 20;
        c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(x + 12, ty + th - 44, w, 32);
        c.fillStyle = '#fff'; c.fillText(t.name, x + 22, ty + th - 21);
      }
    });
  }

  // ------------------------------------------------------------------ interfaz de grabación
  function setRecordingUi(mode) {
    const btn = $('#btnRecord');
    btn.dataset.mode = mode;
    btn.classList.remove('confirm');
    btn.textContent = { idle: '● Grabar', armed: 'Preparando…', stopping: 'Terminando…' }[mode] || '■ Detener';
    btn.disabled = mode === 'armed' || mode === 'stopping';
    $('#recBadge').hidden = mode !== 'recording' && mode !== 'stopping';
    document.body.classList.toggle('recording', mode === 'recording');
    sendStatus();
  }

  function countdown(startLocal) {
    const el = $('#countdown');
    el.hidden = false;
    const tick = () => {
      const left = startLocal - localNow();
      if (left <= 0) { el.hidden = true; return; }
      el.textContent = Math.ceil(left / 1000);
      setTimeout(tick, 100);
    };
    tick();
  }

  function flash() {
    const el = $('#flash');
    el.classList.remove('on'); void el.offsetWidth; el.classList.add('on');
  }

  function timerLoop() {
    const rec = state.rec;
    if (!rec) { $('#timer').textContent = '00:00:00'; renderRemoteStatus(); renderMarcas(); return; }
    $('#timer').textContent = fmtTime(localNow() - rec.startLocal);
    renderRemoteStatus();
    renderMarcas();
    setTimeout(timerLoop, 250);
  }

  // ------------------------------------------------------------------ marcas en vivo
  // ✂ abre un tramo para cortar y lo cierra la siguiente pulsación (de cualquiera de los dos); ★ marca un buen
  // momento (lo de justo antes). Quedan en la sesión con la hora del servidor y el editor las convierte en
  // propuestas de corte y en guías del proyecto. En el PC, también con las teclas C y B.
  async function marcar(tipo) {
    if (!state.rec || state.rec.stopping) return;
    const cuerpo = { tipo, from: state.me.id, hora: serverNow() };
    if (tipo === 'corte') cuerpo.accion = state.corteAbierto ? 'cerrar' : 'abrir';
    try {
      const r = await fetch(`/api/rooms/${encodeURIComponent(state.room)}/marca`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Error');
      aplicarMarcas(j.session);
      const aviso = Llamada.avisoDeMarca(j.marca, { propia: true });
      if (aviso) toast(aviso.texto, aviso.tipo);
      Registro.anotar('marca', { tipo, accion: cuerpo.accion || '' });
    } catch (err) {
      toast(`No se pudo marcar: ${err.message}`, 'error');
    }
  }

  function aplicarMarcas(sesion) {
    state.corteAbierto = (sesion && sesion.recording !== false && sesion.corteAbierto) || null;
    renderMarcas();
  }

  function renderMarcas() {
    const btn = $('#btnCorte');
    btn.textContent = Llamada.textoBotonCorte(state.corteAbierto, serverNow());
    btn.classList.toggle('active', !!state.corteAbierto);
  }

  function addUploader(u) {
    state.uploaders.push(u);
    u.onchange = () => { renderUploads(); sendStatusSoon(); };
    renderUploads();
  }

  function uploadSummary(list) {
    return list.map((u) => ({
      label: u.label, finished: u.finished, error: u.error,
      pct: u.bytesTotal ? Math.round((u.bytesAcked / u.bytesTotal) * 100) : (u.finished ? 100 : 0),
      bytes: u.bytesTotal,
    }));
  }

  function renderUploads() {
    // Por internet la subida puede ir más lenta que la grabación: lo pendiente queda a salvo en el dispositivo.
    const pending = state.uploaders.filter((u) => !u.finished).reduce((a, u) => a + (u.bytesTotal - u.bytesAcked), 0);
    const warn = $('#uploadWarning');
    if (pending > 8 * 1024 * 1024 || (!state.rec && state.uploaders.some((u) => !u.finished))) {
      warn.hidden = false;
      warn.textContent = state.rec
        ? `Pendiente de subir: ${fmtBytes(pending)}. Tu conexión sube más despacio de lo que grabas; no pasa nada, se guarda en este dispositivo y se terminará de subir al acabar.`
        : `Faltan ${fmtBytes(pending)} por subir. No cierres esta página ni bloquees el dispositivo hasta que todo esté ✓ guardado.`;
    } else warn.hidden = true;
    const box = $('#uploads');
    box.innerHTML = '';
    if (!state.uploaders.length) { box.innerHTML = '<p class="muted">Aún no hay grabaciones en esta sesión.</p>'; return; }
    for (const u of state.uploaders) {
      const pct = u.bytesTotal ? Math.round((u.bytesAcked / u.bytesTotal) * 100) : 0;
      const row = document.createElement('div');
      row.className = 'upload';
      const status = u.finished ? '✓ Guardado en el servidor' : u.error ? `⚠ ${u.error} (reintentando)` : state.rec ? 'Grabando y subiendo…' : 'Subiendo…';
      row.innerHTML = `
        <div class="upload-head"><strong>${u.label}</strong><span>${fmtBytes(u.bytesTotal)}</span></div>
        <div class="bar"><div style="width:${u.finished ? 100 : pct}%"></div></div>
        <div class="upload-foot"><span class="${u.error ? 'err' : ''}">${status}</span></div>`;
      if (!state.rec && u.count) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'link'; b.textContent = 'Descargar copia';
        b.onclick = () => descargarCopia(u);
        row.querySelector('.upload-foot').appendChild(b);
      }
      box.appendChild(row);
    }
  }

  /** «Descargar copia»: el archivo de este dispositivo, o lo que falte en el servidor, y siempre se dice qué es. */
  async function descargarCopia(u) {
    const c = await u.copia();
    if (c.aviso) toast(c.aviso, c.blob ? 'warn' : '', 12000);
    if (c.blob) downloadBlob(c.blob, c.nombre);
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  let statusTimer = null;
  function sendStatusSoon() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => { statusTimer = null; sendStatus(); }, 1000);
  }
  function sendStatus() {
    if (!state.room) return;
    fetch(`/api/rooms/${encodeURIComponent(state.room)}/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: state.me.id, status: { recording: !!state.rec, uploads: uploadSummary(state.uploaders), mic: state.micEstado } }),
    }).catch(() => {});
  }

  function renderRemoteStatus() {
    const st = state.remoteStatus;
    // Si la otra persona graba o no, bien visible sobre su imagen: si se perdió la orden de grabar, se ve en
    // segundos (y su página se corrige sola), no al acabar el episodio.
    const indicador = Llamada.estadoDelOtro({
      hayOtro: !!state.remote, yoGrabo: !!state.rec, otroGraba: st ? st.recording : undefined,
      msGrabando: state.rec ? localNow() - state.rec.startLocal : 0,
    });
    const rec = $('#remoteRec');
    rec.hidden = !indicador;
    rec.className = `rec-otro ${indicador || ''}`;
    rec.textContent = indicador === 'graba' ? '● REC' : '⚠ NO ESTÁ GRABANDO';
    if (indicador === 'no-graba' && !renderRemoteStatus.avisado) {
      renderRemoteStatus.avisado = true;
      Registro.anotar('otro-no-graba', { nombre: state.remote?.name });
    }
    if (indicador !== 'no-graba') renderRemoteStatus.avisado = false;

    // Si el micro de la otra persona llega bajo o satura, también se ve aquí (sobre todo para quien dirige).
    const mic = $('#remoteMic');
    mic.textContent = Llamada.avisoDeMicro(st && st.mic, { nombre: state.remote?.name || 'la otra persona' });
    mic.hidden = !mic.textContent;

    const box = $('#remoteUploads');
    if (!st || !st.uploads?.length) { box.textContent = ''; return; }
    const pending = st.uploads.filter((u) => !u.finished);
    box.textContent = pending.length
      ? `${state.remote?.name || 'Invitado'}: subiendo ${pending.map((u) => `${u.label} ${u.pct}%`).join(' · ')}`
      : `${state.remote?.name || 'Invitado'}: todo subido ✓`;
  }

  async function requestWakeLock() {
    try { state.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* no disponible */ }
  }
  function releaseWakeLock() { state.wakeLock?.release().catch(() => {}); state.wakeLock = null; }

  // ------------------------------------------------------------------ subidas pendientes de otra vez
  async function checkStoredUploads() {
    const todas = await TrackUploader.listStored().catch(() => []);
    // Lo que el servidor ya confirmó entero se borra del dispositivo. Antes se quedaba para siempre: unos
    // 10 GB por episodio de 90 min en el disco del PC (y en el iPad, con el enlace fijo).
    for (const u of todas.filter((x) => x.finished)) await u.deleteLocal().catch(() => {});
    const stored = todas.filter((u) => !u.finished);
    if (!stored.length) return;
    const box = $('#pending');
    box.hidden = false;
    const list = $('#pendingList');
    list.innerHTML = '';
    for (const u of stored) {
      const li = document.createElement('li');
      li.innerHTML = `<span>${u.info.session} · ${u.label} · ${fmtBytes(u.bytesTotal || 0)}</span>`;
      const up = document.createElement('button'); up.type = 'button'; up.className = 'link'; up.textContent = 'Subir';
      const dl = document.createElement('button'); dl.type = 'button'; dl.className = 'link'; dl.textContent = 'Descargar';
      const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'link danger'; rm.textContent = 'Borrar';
      up.onclick = () => {
        u.onchange = () => { up.textContent = u.finished ? 'Subido ✓' : u.error ? 'Reintentando…' : `${Math.round((u.acked / Math.max(1, u.count)) * 100)}%`; };
        if (!u.finishInfo) u.finishInfo = { startedAtServer: null, endedAtServer: null, recovered: true };
        u._kick();
      };
      dl.onclick = () => descargarCopia(u);
      rm.onclick = async () => { if (confirm('¿Borrar esta grabación del dispositivo?')) { await u.deleteLocal(); li.remove(); } };
      li.append(up, dl, rm);
      list.appendChild(li);
    }
  }

  // ------------------------------------------------------------------ eventos de la interfaz
  function initStudio() {
    // Confirmación en dos pulsaciones dentro del propio botón. No se usa confirm(): mientras una ventana
    // modal está abierta el navegador pausa la página y la imagen grabada se queda congelada.
    let pending = null;
    const armConfirm = (action, label) => {
      const btn = $('#btnRecord');
      pending = action;
      btn.textContent = label;
      btn.classList.add('confirm');
      clearTimeout(armConfirm.t);
      armConfirm.t = setTimeout(() => { if (pending === action) { pending = null; btn.classList.remove('confirm'); setRecordingUi(btn.dataset.mode); } }, 4000);
    };
    $('#btnRecord').addEventListener('click', async () => {
      const btn = $('#btnRecord');
      const mode = btn.dataset.mode || 'idle';
      try {
        if (mode === 'idle') {
          if (!state.remote && pending !== 'start') { armConfirm('start', 'Estás solo: pulsa otra vez para grabar'); return; }
          pending = null; btn.classList.remove('confirm');
          await requestRecord('start');
        } else if (mode === 'recording') {
          if (pending !== 'stop') { armConfirm('stop', '¿Detener para los dos? Pulsa otra vez'); return; }
          pending = null; btn.classList.remove('confirm');
          try {
            await requestRecord('stop');
          } catch (err) {
            // El servidor no tiene esta grabación en marcha (se reinició, o ya se paró): se para aquí igualmente,
            // en vez de dejar esta página grabando sin poder detenerla.
            if (err.status !== 409 || !state.rec) throw err;
            if (state.rec.stopping) return;   // la otra persona la paró a la vez: ya se está parando
            Registro.anotar('parada-local', { sesion: state.rec.session.id, motivo: err.message });
            stopRecording({ ...state.rec.session, stopAt: serverNow(), endBeepAt: null });
            toast('El servidor no tenía esta grabación en marcha (¿se reinició?): se para en esta página. La otra persona debe pulsar Detener en la suya.', 'warn');
          }
        }
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#btnCopy').addEventListener('click', async () => {
      // El enlace público puede haber llegado después de entrar (el túnel tarda unos segundos).
      const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => null);
      if (cfg) { state.publicUrl = cfg.publicUrl || ''; state.accessKey = cfg.accessKey || ''; state.lanUrls = cfg.lanUrls || []; $('#inviteLink').value = inviteUrl(); }
      try { await navigator.clipboard.writeText($('#inviteLink').value); toast('Enlace copiado'); } catch { $('#inviteLink').select(); }
    });
    $('#btnMute').addEventListener('click', () => {
      const t = state.localStream.getAudioTracks()[0];
      t.enabled = !t.enabled;
      $('#btnMute').textContent = t.enabled ? 'Silenciar' : 'Activar micro';
      $('#btnMute').classList.toggle('active', !t.enabled);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.rec && isIOS) toast('En iPad no salgas de Safari mientras grabas: la cámara se detiene.', 'warn');
    });
    $('#btnCorte').addEventListener('click', () => marcar('corte'));
    $('#btnBueno').addEventListener('click', () => marcar('bueno'));
    // Teclas C (✂) y B (★) mientras se graba, salvo si se está escribiendo en un campo.
    document.addEventListener('keydown', (e) => {
      if (!state.rec || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable) return;
      const tecla = e.key.toLowerCase();
      if (tecla === 'c') marcar('corte');
      else if (tecla === 'b') marcar('bueno');
    });
  }

  initSetup();
  initStudio();
})();
