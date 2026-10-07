# Notas para Claude — podcast «Dos Tipos Promedio»

Todo lo del podcast vive en este repo: la **grabación** (el Estudio, estilo Riverside: `server.js`, `public/`, `lib/`, `tools/alinear.js`) y la **edición** (`edicion/`: monta el episodio en Kdenlive a partir de lo grabado y lo deja listo para YouTube). La app de finanzas está en otro repo (`Finanzas`, antes `Personal`) y no tiene nada que ver con esto.

- Responder en español.
- **Editar un episodio**: usa el skill **`/episodio`** (`.claude/skills/episodio/SKILL.md`). Trae el proceso fijo, las rutas, lo ya decidido y las trampas. No redescubras nada de eso y no leas transcripciones enteras: usa `analizar`, `verificar` y `estado`. Estado y decisiones técnicas de la edición: `edicion/ESTADO.md`.
- Arrancar el Estudio: `npm start` (misma wifi) o `npm run internet` (túnel). Funcionamiento y decisiones de la grabación: `README.md`. Registro de lo que ocurre: `logs/estudio-AAAA-MM-DD.log` (primer sitio donde mirar si algo falla).
- Pruebas: `npm test` (todas; deben pasar; antes `npm install`), o por partes con `npm run test:grabacion` y `npm run test:edicion`. Las que necesitan ffmpeg o melt se saltan solas si no están.

## Ya decidido (no volver a discutirlo)
- **Solo Kdenlive para editar**: el proyecto se escribe y se renderiza desde aquí sin abrir el programa, y así funciona bien. DaVinci Resolve se descartó (la versión gratuita no deja automatizarlo así) y su herramienta se quitó.
- **Caídas de conexión** (2026-10): la causa fue el cierre de la página de Edge (la de JC, el anfitrión), no el wifi. Se añadió registro (`lib/log.js`, `public/js/registro.js`), periodo de gracia de 45 s en la sala y **retomada**: al volver a abrir la página, un clic reanuda la grabación como tramo nuevo.
- Un tramo retomado no lleva pitido ni destello y genera archivos propios `jc-2_camara.mp4`, `jc-2_audio.wav` (y `jc-2_llamada.mp4` si esa página graba la llamada: la del PC lo hace). En `session.json`: `retomada: true`, `retomaDe: "jc"`. El editor (`edicion/`) junta los tramos y une la llamada partida.
- **Órdenes perdidas** (2026-10): si una página se pierde la orden de grabar (corte justo entonces) o entra con la grabación en marcha, empieza sola como tramo sin pitido (`tarde: true` en `session.json`); si se pierde la de parar, para sola. Lo decide `Llamada.alRecibirGrabacion` (al volver a la sala y cada 5 s con `GET /api/rooms/:sala/sesion`). Antes se avisaba «empezará con la próxima» y esa persona no grababa nada: no volver a eso. Sobre la imagen del otro se ve «● REC» o «⚠ NO ESTÁ GRABANDO».
- **Marcas en vivo** (2026-10): botones ✂ (un tramo: se abre y se cierra, lo cierra cualquiera y al parar se cierra solo) y ★ (un instante), teclas C y B en el PC. `POST /api/rooms/:sala/marca` con `accion` abrir/cerrar, no «cambiar»: si los dos pulsan a la vez no se abre y se cierra en el acto. Quedan en `session.json` (`marcas`) y las usa `edicion` (ver `edicion/ESTADO.md`).
- **Aviso de micro bajo** (2026-10): la página mide la voz de los últimos 20 s y, si llega baja (percentil 90 bajo −32 dBFS) o satura, lo dice sobre la imagen propia y sobre la de esa persona en la otra página (va en el `status`). Lógica en `Llamada.nivelDelMicro`.
- La página borra de IndexedDB lo que el servidor ya confirmó (al volver a abrir el estudio). Antes se acumulaban ~10 GB por episodio.
- La claqueta (pitido 1 kHz a ~1 s) alinea los audios entre sí. **Retardo imagen↔sonido de la cámara: con este equipo el ajuste correcto es 0** (elegido a oído en el episodio del 2026-10-03; el «−140 ms» que se vio antes fue una falsa alarma de VLC). No se corrige nada en la grabación. Contexto en `edicion/ESTUDIO-RETARDO-AV.md`.
- Para los episodios se recomienda el enlace fijo (Tailscale): con el de Cloudflare, si se reinicia el túnel, lo que el iPad tenga pendiente queda en la dirección vieja y solo se rescata con «Descargar copia».
- **«Descargar copia» sin IndexedDB** (2026-10): da el resto, `…_camara.resto-<bytes>.mp4` (lo que aún no tenía el servidor, con la cabecera del vídeo), o avisa de que ya está todo subido; nunca un archivo vacío o con huecos sin decirlo. Se junta con `node cli.js juntar-copia <archivo> <copia>` (exacto, por los bytes del nombre).

## Trampas
- Para editar no hace falta descargar nada: `edicion` importa directamente de `grabaciones/` con `node cli.js importar --copiar`. Las descargas desde «Grabaciones» llevan la sesión delante: `2026-10-10_21-30-05_dj_camara.mp4`. (Las antiguas, sin sesión, llegaban como `dj_camara.mp4`, `jc_audio (1).wav`…: el `(n)` lo pone el navegador y NO dice de qué sesión es.)
- `.env`, `certs/`, `grabaciones/` y `logs/` no se versionan.
- En este entorno se pierden las barras invertidas al escribir código por heredoc de bash: para regex y `\n` usa la herramienta `Edit`.
