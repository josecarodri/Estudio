/*
 * Para los procesos largos (el render de 2-3 h, la transcripción, el análisis):
 *   - que el PC no se duerma mientras trabajan, y
 *   - avisar al terminar (o al fallar): en Windows con una notificación del sistema y, si se
 *     configura un tema de ntfy (`avisos.ntfy` en el episodio.json del equipo), también en el
 *     móvil con la app gratuita ntfy.
 * Nada de esto hace esperar al proceso ni puede romperlo: si falla, se sigue igual.
 */
'use strict';

const { spawn } = require('node:child_process');

const pendientes = new Set();
let resumen = '';

/* Un PowerShell aparte, oculto, que no hace esperar a este proceso. */
function powershell(script) {
  const hijo = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { stdio: 'ignore', detached: true, windowsHide: true });
  hijo.on('error', () => {});
  hijo.unref();
  return hijo;
}

/* Texto dentro de comillas simples de PowerShell: la comilla se escribe doble. */
const textoPs = (t) => String(t).replace(/'/g, "''");

/*
 * Mantiene el PC despierto mientras viva este proceso. En Windows, un PowerShell aparte pide al
 * sistema que no se suspenda (SetThreadExecutionState) y se cierra solo en cuanto este proceso
 * termina, aunque muera de golpe. En macOS, `caffeinate -w`. Devuelve una función para soltarlo antes.
 * La pantalla sí se puede apagar: lo que no se duerme es el equipo.
 */
function mantenerDespierto() {
  if (process.env.EDICION_SIN_DESPIERTO) return () => {};
  let hijo = null;
  try {
    if (process.platform === 'win32') {
      hijo = powershell([
        `$t = Add-Type -Name Despierto -Namespace Edicion -PassThru -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'`,
        '[void]$t::SetThreadExecutionState([uint32]2147483649)',   // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
        `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 30 }`,
      ].join('; '));
    } else if (process.platform === 'darwin') {
      hijo = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', detached: true });
      hijo.on('error', () => {});
      hijo.unref();
    }
  } catch { /* sin eso, el proceso sigue igual */ }
  return () => { try { if (hijo) hijo.kill(); } catch { /* ya terminó */ } };
}

/* Dónde publicar en ntfy: un tema suelto (en ntfy.sh) o la dirección entera de uno (servidor propio). */
function destinoNtfy(valor) {
  const v = String(valor || '').trim();
  if (!v) return null;
  const m = /^(https?:\/\/[^/]+)\/([^/?#]+)/.exec(v);
  return m ? { base: m[1], tema: decodeURIComponent(m[2]) } : { base: 'https://ntfy.sh', tema: v };
}

/*
 * Aviso de que algo terminó o falló. En Windows, una notificación del sistema; y si hay un tema de
 * ntfy, también al móvil (en JSON, para que los acentos lleguen bien). El envío al móvil queda en
 * marcha: esperarAvisos() da unos segundos para que salga antes de cerrar el proceso.
 */
function avisar(config, titulo, texto, opciones) {
  const o = opciones || {};
  const a = (config && config.avisos) || {};
  if (process.env.EDICION_SIN_AVISOS) return;
  if (a.windows !== false && process.platform === 'win32') {
    try {
      powershell([
        'Add-Type -AssemblyName System.Windows.Forms',
        '$n = New-Object System.Windows.Forms.NotifyIcon',
        `$n.Icon = [System.Drawing.SystemIcons]::${o.error ? 'Error' : 'Information'}`,
        '$n.Visible = $true',
        `$n.ShowBalloonTip(20000, '${textoPs(titulo)}', '${textoPs(texto)}', '${o.error ? 'Error' : 'Info'}')`,
        'Start-Sleep -Seconds 20',
        '$n.Dispose()',
      ].join('; '));
    } catch { /* sin aviso en pantalla */ }
  }
  const destino = destinoNtfy(a.ntfy);
  if (destino && typeof fetch === 'function') {
    const p = fetch(`${destino.base}/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: destino.tema, title: titulo, message: texto, tags: [o.error ? 'warning' : 'white_check_mark'], priority: o.error ? 4 : 3 }),
      signal: AbortSignal.timeout(10000),
    })
      .then((r) => { if (!r.ok) console.log(`  aviso   el aviso al móvil (ntfy) respondió ${r.status}`); })
      .catch((e) => console.log(`  aviso   no se pudo avisar al móvil (ntfy): ${e.message}`))
      .finally(() => pendientes.delete(p));
    pendientes.add(p);
  }
}

/* Espera, como mucho `ms`, a que salgan los avisos al móvil pendientes. */
function esperarAvisos(ms) {
  if (!pendientes.size) return Promise.resolve();
  return Promise.race([Promise.allSettled([...pendientes]), new Promise((r) => { setTimeout(r, ms || 12000).unref(); })]);
}

/* Lo que dirá el aviso al terminar (lo pone cada comando: «listo para YouTube: 89,8 min…»). */
function ponerResumen(texto) { resumen = String(texto || ''); }
function tomarResumen() { const r = resumen; resumen = ''; return r; }

/* Solo se avisa de lo que tardó: un montaje que se rehace en segundos no merece una notificación. */
function debeAvisar(segundos, config) {
  const a = (config && config.avisos) || {};
  if (a.activo === false) return false;
  return segundos >= (Number.isFinite(Number(a.minimoSegundos)) ? Number(a.minimoSegundos) : 60);
}

/* «2 h 14 min», «3 min», «45 s» */
function duracionLegible(segundos) {
  const s = Math.round(segundos);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

module.exports = { mantenerDespierto, avisar, esperarAvisos, ponerResumen, tomarResumen, debeAvisar, duracionLegible, destinoNtfy, textoPs };
