'use strict';
/*
 * Avisos al terminar y PC despierto: el aviso al móvil (ntfy) se prueba contra un servidor local que
 * hace de ntfy; el de Windows y lo de no dormirse solo se pueden comprobar en Windows (aquí no hacen nada).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const AV = require('../avisos.js');

const hayFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

/** Un «ntfy» local: guarda lo que le publican. */
function ntfyFalso() {
  const recibidos = [];
  const server = http.createServer((req, res) => {
    let cuerpo = '';
    req.on('data', (c) => { cuerpo += c; });
    req.on('end', () => {
      recibidos.push({ metodo: req.method, ruta: req.url, cuerpo: JSON.parse(cuerpo || '{}') });
      res.end('{}');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, recibidos, url: `http://127.0.0.1:${server.address().port}` })));
}

test('avisos: tema suelto (ntfy.sh) o dirección de un servidor propio', () => {
  assert.deepStrictEqual(AV.destinoNtfy('dtp-x7k2'), { base: 'https://ntfy.sh', tema: 'dtp-x7k2' });
  assert.deepStrictEqual(AV.destinoNtfy('https://ntfy.casa.es/podcast'), { base: 'https://ntfy.casa.es', tema: 'podcast' });
  assert.strictEqual(AV.destinoNtfy(''), null);
  assert.strictEqual(AV.textoPs("JC's"), "JC''s");
  assert.deepStrictEqual([AV.duracionLegible(42), AV.duracionLegible(185), AV.duracionLegible(8040)], ['42 s', '3 min', '2 h 14 min']);
});

test('avisos: solo de lo que tardó (un minuto por omisión), y nada si se apagan', () => {
  assert.strictEqual(AV.debeAvisar(30, {}), false);
  assert.strictEqual(AV.debeAvisar(90, {}), true);
  assert.strictEqual(AV.debeAvisar(10, { avisos: { minimoSegundos: 5 } }), true);
  assert.strictEqual(AV.debeAvisar(9000, { avisos: { activo: false } }), false);
});

test('avisos: al móvil va en JSON (los acentos llegan bien), con prioridad alta si algo falló', async () => {
  const n = await ntfyFalso();
  try {
    const config = { avisos: { ntfy: `${n.url}/dtp-prueba`, windows: false } };
    AV.avisar(config, '2026-10-10 · episodio terminado', 'listo para YouTube: 89,8 min · verificación ✔');
    AV.avisar(config, '2026-10-10 · episodio falló', 'falló el render', { error: true });
    await AV.esperarAvisos(5000);
    assert.deepStrictEqual(n.recibidos.map((r) => [r.metodo, r.ruta]), [['POST', '/'], ['POST', '/']]);
    assert.deepStrictEqual(n.recibidos[0].cuerpo, {
      topic: 'dtp-prueba', title: '2026-10-10 · episodio terminado', message: 'listo para YouTube: 89,8 min · verificación ✔', tags: ['white_check_mark'], priority: 3,
    });
    assert.deepStrictEqual([n.recibidos[1].cuerpo.priority, n.recibidos[1].cuerpo.tags], [4, ['warning']]);
  } finally {
    n.server.close();
  }
});

test('avisos: sin tema de ntfy no se manda nada; un ntfy que no responde no rompe nada', async () => {
  AV.avisar({ avisos: { windows: false } }, 'x', 'y');
  await AV.esperarAvisos(1000);
  AV.avisar({ avisos: { ntfy: 'http://127.0.0.1:9/nadie', windows: false } }, 'x', 'y');   // puerto cerrado
  await AV.esperarAvisos(5000);
  assert.ok(true);
});

test('PC despierto: devuelve con qué soltarlo, y aquí (no es Windows) no lanza nada', () => {
  const soltar = AV.mantenerDespierto();
  assert.strictEqual(typeof soltar, 'function');
  soltar();
});

test('Windows: el PowerShell aparte llega a ejecutarse (lanzado «detached» se cerraba sin hacer nada)',
  { skip: process.platform !== 'win32' }, async () => {
    const marca = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'avisos-ps-')), 'hecho.txt');
    AV.powershell(`Start-Sleep -Milliseconds 500; 'si' | Out-File -Encoding ascii -FilePath '${AV.textoPs(marca)}'`);
    const hasta = Date.now() + 15000;
    while (!fs.existsSync(marca) && Date.now() < hasta) await new Promise((r) => setTimeout(r, 200));
    assert.ok(fs.existsSync(marca), 'el script del PowerShell aparte no llegó a ejecutarse');
  });

test('Windows: la notificación sigue viva aunque node termine enseguida (sale sola o con process.exit)',
  { skip: process.platform !== 'win32' }, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'avisos-sobrevive-'));
    // Como `episodio` al acabar: lanza y sale. El script escribe su marca 2 s después de empezar,
    // cuando node ya terminó: sin el nieto (o si node no espera a lanzarlo) muere antes con el job de libuv.
    const lanzar = (marca, conExit) => spawnSync(process.execPath, ['-e', `
      const AV = require(${JSON.stringify(path.join(__dirname, '..', 'avisos.js'))});
      AV.powershellQueSobrevive("Start-Sleep -Seconds 2; 'si' | Out-File -Encoding ascii -FilePath '" + AV.textoPs(${JSON.stringify(marca)}) + "'");
      ${conExit ? 'AV.esperarAvisos(12000).then(() => process.exit(0));' : ''}
    `], { timeout: 30000 });
    const casos = [[path.join(dir, 'sola.txt'), false], [path.join(dir, 'exit.txt'), true]];
    for (const [marca, conExit] of casos) {
      assert.strictEqual(lanzar(marca, conExit).status, 0);
      assert.ok(!fs.existsSync(marca), 'node no debe esperar al script entero, solo a que quede lanzado');
    }
    const hasta = Date.now() + 20000;
    while (casos.some(([m]) => !fs.existsSync(m)) && Date.now() < hasta) await new Promise((r) => setTimeout(r, 250));
    for (const [marca, conExit] of casos) assert.ok(fs.existsSync(marca), `el PowerShell murió con node (${conExit ? 'process.exit' : 'sale solo'})`);
  });

test('al terminar un comando largo se avisa con el episodio, cómo acabó y su resumen', { skip: !hayFfmpeg }, async () => {
  const SESION = require('./sesion-falsa.js');
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'avisos-'));
  const ep = path.join(raiz, '2026-10-10');
  SESION.generar(path.join(ep, 'originales'), { duracion: 20 });
  const n = await ntfyFalso();
  try {
    // En el episodio.json del equipo: el tema de ntfy, y avisar aunque tarde poco (para la prueba).
    fs.writeFileSync(path.join(raiz, 'episodio.json'), JSON.stringify({ avisos: { ntfy: `${n.url}/dtp`, windows: false, minimoSegundos: 0 } }));
    const hijo = spawn(process.execPath, [path.join(__dirname, '..', 'cli.js'), 'analizar', ep, '--sin-transcribir'], { stdio: 'ignore' });
    const codigo = await new Promise((r) => hijo.on('exit', r));
    assert.strictEqual(codigo, 0);
    assert.strictEqual(n.recibidos.length, 1);
    const aviso = n.recibidos[0].cuerpo;
    assert.strictEqual(aviso.title, '2026-10-10 · analizar terminado');
    assert.match(aviso.message, /^propuesta lista: \d+ propuesta\(s\) de corte .*\(\d+ s\)$/);
  } finally {
    n.server.close();
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});
