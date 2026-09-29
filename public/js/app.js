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
    wakeLock: null,
  };

  function randomId() {
    const a = new Uint8Array(6);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }
  const localNow = () => Clock.localNow();
  const serverNow = () => localNow() + state.clock.offset;

  function toast(msg, kind = '') {
    const el = $('#toast');
    el.textContent = msg;
    el.className = `toast show ${kind}`;
    clearTimeout(toast.t);
    toast.t = setTimeout(() => { el.className = 'toast'; }, 4000);
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
    const constraints = {
      video: {
        width: { ideal: res.width }, height: { ideal: res.height }, frameRate: { ideal: 30 },
        ...(camId ? { deviceId: { exact: camId } } : { facingMode: 'user' }),
      },
      audio: {
        channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 },
        echoCancellation: processing, noiseSuppression: processing, autoGainControl: processing,
        ...(micId ? { deviceId: { exact: micId } } : {}),
      },
    };
    state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
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
    const tick = () => {
      state.audio.analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
      const db = 20 * Math.log10(peak || 1e-6);
      const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
      bar.style.width = `${pct}%`;
      bar.className = db > -3 ? 'clip' : db > -12 ? 'hot' : '';
      requestAnimationFrame(tick);
    };
    tick();
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
      state.clock = await Clock.sync();
    } finally {
      $('#btnJoin').disabled = false;
    }
    setInterval(() => { if (!state.rec) Clock.sync(6).then((c) => { state.clock = c; }).catch(() => {}); }, 30000);

    history.replaceState(null, '', `?sala=${encodeURIComponent(room)}`);
    $('#setup').hidden = true;
    $('#studio').hidden = false;
    $('#roomName').textContent = room;
    $('#localName').textContent = `${name} (tú)`;
    $('#inviteLink').value = inviteUrl();
    $('#clockInfo').textContent = `reloj ±${(state.clock.rtt / 2).toFixed(0)} ms`;
    connectEvents();
    window.addEventListener('beforeunload', (e) => {
      if (state.rec || state.uploaders.some((u) => !u.finished)) { e.preventDefault(); e.returnValue = ''; }
    });
  }

  function inviteUrl() {
    // Desde localhost, el enlace para el iPad debe llevar la IP del PC en la red local.
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const origin = local && state.lanUrls?.length ? state.lanUrls[0] : location.origin;
    return `${origin}${location.pathname}?sala=${encodeURIComponent(state.room)}`;
  }

  function connectEvents() {
    const q = new URLSearchParams({ peer: state.me.id, name: state.me.name, device: state.me.device });
    const es = new EventSource(`/api/rooms/${encodeURIComponent(state.room)}/events?${q}`);
    state.events = es;
    es.addEventListener('welcome', (e) => {
      const d = JSON.parse(e.data);
      setConn('Conectado a la sala');
      if (d.peers.length) {
        // Soy el último en llegar: inicio la llamada.
        const p = d.peers[0];
        startCall(p, true);
      } else {
        setRemote(null);
      }
      if (d.session?.recording && !state.rec) toast('Hay una grabación en curso; empezará con la próxima.', 'warn');
    });
    es.addEventListener('peer-joined', (e) => {
      const p = JSON.parse(e.data);
      toast(`${p.name} ha entrado`);
      startCall(p, false);
    });
    es.addEventListener('peer-left', (e) => {
      const { id } = JSON.parse(e.data);
      if (state.remote?.id === id) {
        toast(`${state.remote.name} ha salido`, 'warn');
        closeCall();
        setRemote(null);
      }
    });
    es.addEventListener('signal', (e) => onSignal(JSON.parse(e.data)));
    es.addEventListener('status', (e) => { state.remoteStatus = JSON.parse(e.data).status; renderRemoteStatus(); });
    es.addEventListener('record-start', (e) => startRecording(JSON.parse(e.data)).catch((err) => { console.error(err); toast(`Error al grabar: ${err.message}`, 'error'); }));
    es.addEventListener('record-stop', (e) => stopRecording(JSON.parse(e.data)));
    es.onerror = () => setConn('Reconectando…');
    es.addEventListener('open', () => setConn('Conectado a la sala'));
  }

  function setConn(text) { $('#connInfo').textContent = text; }

  function sendSignal(to, data) {
    state.signalChain = state.signalChain.then(() => fetch(`/api/rooms/${encodeURIComponent(state.room)}/signal`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: state.me.id, to, data }),
    })).catch((err) => console.warn('señal', err));
    return state.signalChain;
  }

  function closeCall() {
    if (state.pc) { state.pc.onicecandidate = null; state.pc.ontrack = null; state.pc.close(); }
    state.pc = null;
    state.pendingCandidates = [];
    connectRemoteAudio(null);
  }

  function startCall(peer, offerer) {
    closeCall();
    state.offerer = offerer;
    setRemote({ ...peer, stream: new MediaStream() });
    const pc = new RTCPeerConnection({ iceServers: state.iceServers });
    state.pc = pc;
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
      $('#remoteState').textContent = { connected: '', connecting: 'conectando…', failed: 'conexión fallida', disconnected: 'reconectando…' }[st] ?? st;
      if (st === 'failed' && state.offerer) pc.restartIce();
    };
    pc.onnegotiationneeded = async () => {
      if (!state.offerer || state.pc !== pc) return;
      try {
        await pc.setLocalDescription();
        sendSignal(peer.id, { description: pc.localDescription.toJSON() });
      } catch (err) { console.error(err); }
    };
  }

  async function onSignal({ from, data }) {
    if (!state.pc || state.remote?.id !== from) return;
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
    if (!r.ok) throw new Error(j.error || 'Error');
  }

  async function startRecording(session) {
    if (state.rec) return;
    // Se libera el espacio de grabaciones anteriores ya subidas.
    for (const u of state.uploaders.filter((x) => x.finished)) await u.deleteLocal().catch(() => {});
    state.uploaders = state.uploaders.filter((u) => !u.finished);

    const startLocal = session.startAt - state.clock.offset;
    const beepLocal = session.beepAt - state.clock.offset;
    const res = RESOLUTIONS[$('#resolution').value] || RESOLUTIONS['1080'];
    const vs = state.localStream.getVideoTracks()[0].getSettings();
    const base = {
      room: state.room, session: session.id, participant: state.me.id, name: state.me.name, device: state.me.device,
    };
    const rec = { session, startLocal, recorders: [], worklet: null, canvasTimer: null, stopping: false };
    state.rec = rec;
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
    scheduleBeep(ctxTimeFor(beepLocal));

    // Cuenta atrás y arranque sincronizado.
    const wait = startLocal - localNow();
    if (wait < 0) toast('La orden de grabar llegó tarde; se sincronizará con el pitido.', 'warn');
    countdown(startLocal);
    setTimeout(() => {
      for (const r of rec.recorders) { r.startedAtServer = serverNow(); r.recorder.start(1000); }
      setRecordingUi('recording');
      timerLoop();
    }, Math.max(0, wait));
    setTimeout(flash, Math.max(0, beepLocal - localNow()));
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
    recorder.onstop = () => {
      // Se espera a que se guarde el último trozo antes de cerrar la pista.
      setTimeout(() => uploader.finish(finishInfo(r.startedAtServer, r.endedAtServer, r.beepAt)), 200);
    };
    recorder.onerror = (e) => toast(`Error del grabador (${info.kind}): ${e.error?.message || ''}`, 'error');
    return r;
  }

  // Los tiempos son orientativos (el evento "start" de MediaRecorder puede llegar tarde);
  // la referencia exacta para sincronizar es el pitido.
  function finishInfo(startedAtServer, endedAtServer, beepAt) {
    return {
      startedAtServer, endedAtServer,
      beepOffsetSec: beepAt && startedAtServer ? (beepAt - startedAtServer) / 1000 : null,
      clockRttMs: state.clock.rtt,
      userAgent: navigator.userAgent,
    };
  }

  function onPcmMessage(pcm, msg) {
    if (msg.type === 'started') {
      // Mismo dominio de reloj que el pitido: el inicio exacto respecto a la hora programada.
      pcm.startedAtServer = pcm.session.startAt + (msg.time - pcm.startCtx) * 1000;
    } else if (msg.type === 'data') {
      pcm.parts.push(msg.samples);
      pcm.samples += msg.samples.length;
      if (pcm.samples >= state.ctx.sampleRate) flushPcm(pcm);   // ~1 s por trozo
    } else if (msg.type === 'stopped') {
      flushPcm(pcm);
      const endedAtServer = pcm.startedAtServer + (pcm.total / state.ctx.sampleRate) * 1000;
      pcm.uploader.finish(finishInfo(pcm.startedAtServer, endedAtServer, pcm.session.beepAt));
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
    const stopLocal = (session.stopAt || serverNow()) - state.clock.offset;
    rec.worklet.node.port.postMessage({ cmd: 'stop', at: ctxTimeFor(stopLocal) });
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
    btn.textContent = mode === 'idle' ? '● Grabar' : mode === 'armed' ? 'Preparando…' : '■ Detener';
    btn.disabled = mode === 'armed';
    $('#recBadge').hidden = mode !== 'recording';
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
    if (!rec) { $('#timer').textContent = '00:00:00'; return; }
    $('#timer').textContent = fmtTime(localNow() - rec.startLocal);
    setTimeout(timerLoop, 250);
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
        b.onclick = async () => downloadBlob(await u.toBlob(), u.fileName());
        row.querySelector('.upload-foot').appendChild(b);
      }
      box.appendChild(row);
    }
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
      body: JSON.stringify({ from: state.me.id, status: { recording: !!state.rec, uploads: uploadSummary(state.uploaders) } }),
    }).catch(() => {});
  }

  function renderRemoteStatus() {
    const box = $('#remoteUploads');
    const st = state.remoteStatus;
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
    const stored = (await TrackUploader.listStored().catch(() => [])).filter((u) => !u.finished);
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
      dl.onclick = async () => downloadBlob(await u.toBlob(), u.fileName());
      rm.onclick = async () => { if (confirm('¿Borrar esta grabación del dispositivo?')) { await u.deleteLocal(); li.remove(); } };
      li.append(up, dl, rm);
      list.appendChild(li);
    }
  }

  // ------------------------------------------------------------------ eventos de la interfaz
  function initStudio() {
    $('#btnRecord').addEventListener('click', async () => {
      const mode = $('#btnRecord').dataset.mode || 'idle';
      try {
        if (mode === 'idle') {
          if (!state.remote && !confirm('Estás solo en la sala. ¿Grabar igualmente?')) return;
          await requestRecord('start');
        } else if (mode === 'recording') {
          if (!confirm('¿Detener la grabación para los dos?')) return;
          await requestRecord('stop');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#btnCopy').addEventListener('click', async () => {
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
  }

  initSetup();
  initStudio();
})();
