'use strict';
/* Clips horizontales: dónde empieza y acaba cada uno (por minuto o por frase), su descripción y sus subtítulos. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CL = require('../clips.js');

/* Una frase de 4 palabras cada 10 s durante 10 min; la del segundo 300 es «bueno cuéntame del viaje.». */
function palabras() {
  const out = [];
  for (let t = 0; t < 600; t += 10) {
    const ws = t === 300 ? ['bueno', 'cuéntame', 'del', 'viaje.'] : ['una', 'frase', 'cualquiera', 'aquí.'];
    ws.forEach((w, k) => out.push({ w, ini: t + k * 0.5, fin: t + k * 0.5 + 0.4 }));
  }
  return out;
}

test('clips por minuto: se ajustan a frases completas, con un respiro', () => {
  const { clips, avisos } = CL.rangosDeClips({ entradas: [{ titulo: 'Uno', desde: '1:01', hasta: '3:05' }], palabras: palabras(), total: 600 });
  assert.deepStrictEqual(avisos, []);
  assert.strictEqual(clips.length, 1);
  assert.strictEqual(clips[0].titulo, 'Uno');
  assert.ok(Math.abs(clips[0].desde - 59.7) < 0.01, `empieza en la frase de 1:00 (${clips[0].desde})`);
  assert.ok(Math.abs(clips[0].hasta - 182.3) < 0.01, `acaba con la frase de 3:00 (${clips[0].hasta})`);
});

test('clips por frase: «desde» empieza en ella y «hasta» acaba justo antes de ella', () => {
  const { clips, avisos } = CL.rangosDeClips({
    entradas: [{ titulo: 'Viaje', desde: 'bueno, cuéntame del viaje', hasta: '8:00' }, { desde: '1:00', hasta: 'Bueno cuéntame del VIAJE' }],
    palabras: palabras(), total: 600,
  });
  assert.deepStrictEqual(avisos, []);
  assert.ok(Math.abs(clips[0].desde - 299.7) < 0.01, `${clips[0].desde}`);
  assert.ok(clips[1].hasta <= 300 && clips[1].hasta > 292, `acaba antes de la frase (${clips[1].hasta})`);
  assert.strictEqual(clips[1].titulo, 'Clip 2');
});

test('clips: avisa de lo que no vale y no lo hace', () => {
  const { clips, avisos } = CL.rangosDeClips({
    entradas: [{ desde: '1:00' }, { desde: 'esto no se dijo', hasta: '5:00' }, { desde: '2:00', hasta: '2:30' }, { desde: '5:00', hasta: '1:00' }],
    palabras: palabras(), total: 600,
  });
  assert.strictEqual(clips.length, 0);
  assert.strictEqual(avisos.length, 4);
  assert.match(avisos[1], /no encuentro «esto no se dijo»/);
  assert.match(avisos[2], /dura 30 s/);
});

test('descripción del clip: resumen, enlace al episodio y pie; sin enlace, lo dice', () => {
  const d = CL.descripcionDelClip({ resumen: 'De qué va.', tituloEpisodio: 'El episodio', enlace: 'https://youtu.be/x', pie: 'Síguenos' });
  assert.strictEqual(d, 'De qué va.\n\n▶ Episodio completo («El episodio»): https://youtu.be/x\n\nSíguenos');
  assert.match(CL.descripcionDelClip({}), /falta el enlace/);
});

test('subtítulos del clip: con tiempos desde su principio', () => {
  const cues = CL.subtitulosDelClip(palabras(), 299.7, 312);
  assert.ok(cues.length >= 1);
  assert.ok(cues[0].ini >= 0 && cues[0].ini < 1);
  assert.match(cues[0].lineas.join(' '), /bueno cuéntame/);
});

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
test('hacerClip: recorta con fundidos y deja la imagen para la miniatura', { skip: !hayFfmpeg && 'sin ffmpeg' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-'));
  const entrada = path.join(dir, 'final.mp4');
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=8', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=8',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', entrada]);
  const salida = path.join(dir, 'clips', 'x-clip-1.mp4');
  const res = CL.hacerClip({ entrada, salida, desde: 2, hasta: 5, codificador: 'x264', argumentosVideo: () => ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'] });
  assert.ok(!res.error, res.error);
  const dur = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', salida], { encoding: 'utf8' }).stdout);
  assert.ok(Math.abs(dur - 3) < 0.15, `dura ${dur}`);
  assert.ok(fs.existsSync(salida.replace(/\.mp4$/, '.jpg')));
  fs.rmSync(dir, { recursive: true, force: true });
});
