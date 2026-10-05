# Notas para Claude — Estudio

App de grabación de llamadas a dos (estilo Riverside) para el podcast «Dos Tipos Promedio». Es un repositorio **aparte** del de edición (`Personal`, carpeta `tools/kdenlive-claude`, que consume lo que sale de aquí). No mezclar con finanzas ni con el podcast.

- Responder en español.
- Arrancar: `npm start` (misma wifi) o `npm run internet` (túnel). Pruebas: `npm test` (30, deben pasar todas; antes `npm install`).
- Funcionamiento y decisiones: `README.md`. Registro de lo que ocurre: `logs/estudio-AAAA-MM-DD.log` (primer sitio donde mirar si algo falla).

## Ya decidido (no volver a discutirlo)
- **Caídas de conexión** (2026-10): la causa fue el cierre de la página de Edge, no el wifi. Se añadió registro (`lib/log.js`, `public/js/registro.js`), periodo de gracia de 45 s en la sala y **retomada**: al volver a abrir la página, un clic reanuda la grabación como tramo nuevo.
- Un tramo retomado no lleva pitido ni destello y genera archivos propios `jc-2_camara.mp4`, `jc-2_audio.wav`. En `session.json`: `retomada: true`, `retomaDe: "jc"`. Se sincroniza con la grabación de la llamada y la hora de inicio de cada pista.
- La claqueta (pitido 1 kHz a ~1 s) alinea los audios entre sí, pero **no ve el retardo imagen↔sonido de la cámara** (~140 ms, constante). Ver el documento `ESTUDIO-RETARDO-AV.md` del repo de edición. No se corrige aquí.

## Trampas
- Los archivos descargados llegan a `D:\Datos\Descargas` con nombres `dj_camara.mp4`, `jc_audio (1).wav`, `jc_llamada.mp4`; el número `(n)` marca cada reconexión.
- `.env`, `certs/`, `grabaciones/` y `logs/` no se versionan.
- En este entorno se pierden las barras invertidas al escribir código por heredoc de bash: para regex y `\n` usa la herramienta `Edit`.
