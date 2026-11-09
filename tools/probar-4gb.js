// ¿Sigue cerrándose la página cuando un MP4 de MediaRecorder llega a 4 GiB? Necesita Playwright (no es dependencia del Estudio).
// Uso: node tools/probar-4gb.js "video/mp4;codecs=vp9,opus" 200 1500   (tipo, Mbps pedidos, segundos como mucho; ~7 min hasta 4 GiB)
const { chromium } = require('playwright');
const mime = process.argv[2] || 'video/mp4;codecs=vp9,opus';
const mbps = Number(process.argv[3] || 600);
(async () => {
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const p = await b.newPage();
  let muerto = false;
  p.on('crash', () => { muerto = true; console.log(new Date().toISOString(), 'PAGINA CAIDA (crash)'); });
  p.on('console', (m) => console.log(new Date().toISOString().slice(11, 19), 'pagina:', m.text()));
  p.on('pageerror', (e) => console.log('error de pagina:', e.message));
  await p.goto('about:blank');
  await p.evaluate(({ mime, mbps }) => {
    const c = document.createElement('canvas'); c.width = 1920; c.height = 1080;
    const x = c.getContext('2d');
    // Ruido: no se deja comprimir, así el grabador gasta todos los bits que se le piden.
    // Unos pocos fotogramas de ruido ya hechos y repetidos: dibujarlos no cuesta y siguen sin comprimirse bien.
    const cuadros = [];
    for (let k = 0; k < 6; k++) {
      const cc = document.createElement('canvas'); cc.width = 1920; cc.height = 1080;
      const im = new ImageData(1920, 1080); const d = new Uint32Array(im.data.buffer);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 0xffffff) | 0xff000000;
      cc.getContext('2d').putImageData(im, 0, 0); cuadros.push(cc);
    }
    let n = 0;
    setInterval(() => { x.drawImage(cuadros[n++ % cuadros.length], 0, 0); }, 33);
    const t0 = performance.now();
    setInterval(() => { const t = window.t; console.log(`${((performance.now() - t0) / 1000).toFixed(0)} s ${(t.bytes / 2 ** 30).toFixed(3)} GiB trozos=${t.trozos} ultimo=${t.ultimo} estado=${window.r.state} ${t.error}`); }, 10000);
    const ac = new AudioContext(); const o = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); o.connect(dst); o.start();
    const s = new MediaStream([c.captureStream(30).getVideoTracks()[0], dst.stream.getAudioTracks()[0]]);
    const r = new MediaRecorder(s, { mimeType: mime, videoBitsPerSecond: mbps * 1e6, audioBitsPerSecond: 256000 });
    window.t = { bytes: 0, trozos: 0, estado: 'recording', error: '', ultimo: 0 };
    r.ondataavailable = (e) => { window.t.bytes += e.data.size; window.t.trozos++; window.t.ultimo = e.data.size; };
    r.onerror = (e) => { window.t.error = String(e.error && (e.error.name + ': ' + e.error.message)); };
    r.onstop = () => { window.t.estado = 'PARADO'; };
    window.r = r;
    r.start(1000);
  }, { mime, mbps });
  const t0 = Date.now();
  while (!muerto && Date.now() - t0 < Number(process.argv[4] || 1500) * 1000) await new Promise((r) => setTimeout(r, 2000));
  await b.close().catch(() => {});
  console.log('FIN');
})();
