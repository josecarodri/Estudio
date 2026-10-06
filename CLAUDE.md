# Notas para Claude — Estudio

App de grabación de llamadas a dos (estilo Riverside) para el podcast «Dos Tipos Promedio». Es un repositorio **aparte** del de edición (`Personal`, carpeta `tools/kdenlive-claude`, que consume lo que sale de aquí). No mezclar con la app de finanzas, que también vive en `Personal`.

- Responder en español.
- Arrancar: `npm start` (misma wifi) o `npm run internet` (túnel). Pruebas: `npm test` (deben pasar todas; antes `npm install`; las de `alinear` necesitan ffmpeg).
- Funcionamiento y decisiones: `README.md`. Registro de lo que ocurre: `logs/estudio-AAAA-MM-DD.log` (primer sitio donde mirar si algo falla).

## Ya decidido (no volver a discutirlo)
- **Caídas de conexión** (2026-10): la causa fue el cierre de la página de Edge (la de JC, el anfitrión), no el wifi. Se añadió registro (`lib/log.js`, `public/js/registro.js`), periodo de gracia de 45 s en la sala y **retomada**: al volver a abrir la página, un clic reanuda la grabación como tramo nuevo.
- Un tramo retomado no lleva pitido ni destello y genera archivos propios `jc-2_camara.mp4`, `jc-2_audio.wav` (y `jc-2_llamada.mp4` si esa página graba la llamada: la del PC lo hace). En `session.json`: `retomada: true`, `retomaDe: "jc"`. El editor junta los tramos y une la llamada partida.
- **Órdenes perdidas** (2026-10): si una página se pierde la orden de grabar (corte justo entonces) o entra con la grabación en marcha, empieza sola como tramo sin pitido (`tarde: true` en `session.json`); si se pierde la de parar, para sola. Lo decide `Llamada.alRecibirGrabacion` (al volver a la sala y cada 5 s con `GET /api/rooms/:sala/sesion`). Antes se avisaba «empezará con la próxima» y esa persona no grababa nada: no volver a eso. Sobre la imagen del otro se ve «● REC» o «⚠ NO ESTÁ GRABANDO».
- La página borra de IndexedDB lo que el servidor ya confirmó (al volver a abrir el estudio). Antes se acumulaban ~10 GB por episodio.
- La claqueta (pitido 1 kHz a ~1 s) alinea los audios entre sí. **Retardo imagen↔sonido de la cámara: con este equipo el ajuste correcto es 0** (elegido a oído en el episodio del 2026-10-03; el «−140 ms» que se vio antes fue una falsa alarma de VLC). No se corrige nada aquí. Contexto en `tools/kdenlive-claude/ESTUDIO-RETARDO-AV.md` del repo de edición.
- Para los episodios se recomienda el enlace fijo (Tailscale): con el de Cloudflare, si se reinicia el túnel, lo que el iPad tenga pendiente queda en la dirección vieja y solo se rescata con «Descargar copia».

## Trampas
- Las descargas desde «Grabaciones» llevan la sesión delante: `2026-10-10_21-30-05_dj_camara.mp4`. Para editar no hace falta descargar: el editor importa directamente de `grabaciones/` con `node cli.js importar --copiar`. (Las descargas antiguas, sin sesión, llegaban como `dj_camara.mp4`, `jc_audio (1).wav`…: el `(n)` lo pone el navegador y NO dice de qué sesión es.)
- `.env`, `certs/`, `grabaciones/` y `logs/` no se versionan.
- En este entorno se pierden las barras invertidas al escribir código por heredoc de bash: para regex y `\n` usa la herramienta `Edit`.
