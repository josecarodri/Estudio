# Estado de la edición del podcast (edicion/)

Corto a propósito: lo vigente y lo pendiente. El proceso está en el skill `/episodio`; el detalle de cada pieza, en
`README.md`; cómo se llegó a cada decisión, en `HISTORIAL.md` (no hace falta leerlo: búscalo con `grep`).

Última sesión: 2026-11-16 (revisión general: estabilidad de la grabación, limpieza y edición más automática).

## Cómo está
- Cuatro episodios hechos con este proceso (2026-10-03, 10-10, 10-18 y 11-01). Kdenlive 26.8, documento 1.1, ffmpeg 9.
- Todo sale de dos archivos: `<raíz>/episodio.json` (equipo) y `<raíz>/AAAA-MM-DD/episodio.json` (ese episodio).
- Tiempos orientativos para 90 min: análisis ≈25 min, transcripción ≈10 min por hora, render ≈1 h 20 min, acabado
  con nvenc ≈40 min. `estado` da los reales de la última vez.

## Cambios del 2026-11-16
- **`preparar`**: crea el episodio (con la fecha de la grabación), trae las sesiones y las analiza, en una orden.
  Se para sin copiar nada si hay una sesión de menos de 2 min o pistas a medio subir; elegir con `--sesiones` es la
  confirmación. `episodio nuevo`, `importar` y `analizar` siguen existiendo por separado.
- **La carpeta del episodio ya no hay que escribirla**: sin ella, el más reciente (y lo dice); también vale solo la
  fecha (`2026-11-15`).
- **`estado` dice el siguiente paso**, mirando lo que hay en el episodio. Al montar se guarda una huella de los
  cortes y ajustes (`montaje/config.huella`): si cambian después, avisa de que toca montar otra vez; escribir el
  título o los capítulos no cuenta.
- **Quitado**: `calibrar` (no era fiable entre sesiones y el retardo quedó en 0), el alias `muestra`, el MP3 del
  podcast (decidido el 2026-10-19; `"podcast"` en el `episodio.json` del equipo ya no hace nada y se puede borrar) y,
  en la grabación, el alineador (`tools/alinear.js`, `lib/beep.js`): el editor sincroniza por su cuenta desde
  `grabaciones/`. `ajustar-audio --probar` sigue: es lo que sirve si un día cambia el equipo y hay que elegir el
  retardo a oído.
- **Vídeos del PC en WebM → MP4 al importar**: Edge y Chrome cerraban la página al llegar el MP4 a 4 GB (era la causa
  de las caídas de JC); ahora graban WebM con H.264 y `importarSesion` lo convierte sin recodificar (`webmAMp4`),
  apunta el tamaño del WebM en `.<nombre>.mp4.de-webm` para no repetirlo y renombra la pista en el `session.json`
  copiado (`archivoOriginal` guarda el nombre de antes). Un WebM suelto en `originales/` se convierte al analizar o
  montar y se aparta a `.webm/`. Probado de punta a punta con una grabación de Chromium (preparar, analizar y montar).
- Sin probar con material real: `preparar` solo se ha probado con sesiones de mentira (las pruebas) y aquí no hay
  `melt`; lo que hace por dentro (importar y analizar) es lo de siempre.

## Pendiente
0. **Primera grabación larga con el PC en WebM**: comprobar que la página de JC pasa de los 58 min sin cerrarse, que
   en `grabaciones/` salen `jc_camara.webm` y `jc_llamada.webm`, y que el latido dice `grabadores=recording+recording`.
   Antes, 10 min en el PC de JC con `http://localhost:8080/prueba-4gb.html`: debe salir «WebM con H.264: pasó de 4 GB».
   Si ese botón sale desactivado, Edge grabaría en VP9 (más carga de procesador): avisar.
1. En el próximo episodio: empezar con `node cli.js preparar` y comprobar que la carpeta sale con la fecha de la
   grabación y que `estado` acierta el siguiente paso en cada momento.
2. Primer caso real de caída (2026-10-18): que Jose revise en la revisión el empalme jc → jc-2 y el labial de jc-2.
3. Que Jose vea la notificación de Windows al terminar, el tiempo real del acabado con nvenc en `estado`, que la
   revisión llega bien al móvil y que el plano del otro de 1,5 s en los empalmes queda natural (si no,
   `disimularCortes.segundos`).
4. (Opcional) Aviso en el móvil: instalar ntfy y poner el tema en `avisos.ntfy` del `episodio.json` del equipo.
5. Preguntar el pie de YouTube (equipo) si aún falta; mirar `estado` tras el render para decidir si subir
   `render.hilos`; comprobar que no salen avisos ⚠ de cámara en material bueno.
6. Color base por cámara; quitar ruido (opción `quitarRuido`, sin probar); encuadre de los shorts por persona (hoy,
   por el centro).
7. Que Jose mire el color en la revisión (matriz BT.709 bien desde el 2026-10-08; si lo ve menos cálido, se ajusta
   `color`).
