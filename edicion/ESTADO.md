# Estado de la edición del podcast (edicion/)

Última sesión: 2026-10-06 (revisión del montaje y del Estudio; ver la sección de esa fecha).

## Hecho
- Generación de proyectos `.kdenlive` (documento 1.1, Kdenlive 26.8 detectado) y render con `melt`. El primer episodio se revisó abriéndolo en Kdenlive.
- `multicam`: sincronía, cambio de cámara por quien habla, nivel de audio (−16 LUFS), color, guías.
- `ajustar-audio`, `--audio-offset` por persona, `calibrar` (claqueta pitido + destello).

## Sesión de prueba (dj + jc), material en `D:\Datos\Descargas\` (histórico)
- `calibrar` midió dj −50 ms y jc +13 ms de retardo audio→imagen, y a oído pareció que hacían falta −140 ms más
  (`dj=-90,jc=-153`). **Superado**: en el episodio real el ajuste bueno fue 0 para los dos y lo de −140 ms fue una
  falsa alarma de VLC (ver «Resultado del primer episodio»). No se porta nada a `tools/alinear.js` del Estudio.
- Micro↔cámara: la correlación y el pitido coinciden a ~1 ms.
- Montaje de aquella prueba: `D:\Datos\montaje-final\`.

## Proceso semanal
El paso a paso, con lo decidido y las trampas, está en el skill `/episodio`. En corto:
```
node cli.js episodio nuevo                       # crea <raiz>/AAAA-MM-DD/{originales,montaje,entrega} y su episodio.json
node cli.js importar --copiar                    # trae las sesiones del Estudio a originales/<sesión>/
node cli.js analizar <carpeta>                   # propuesta de cortes técnicos (y transcripción)
node cli.js episodio <carpeta> --solo-montaje    # proyecto para revisar en Kdenlive
node cli.js episodio <carpeta> --reanudar        # render + acabado YouTube + verificación -> entrega/
```
- Configuración en dos niveles: `<raiz>/episodio.json` (lo del equipo: retardo, niveles, color…) y
  `<raiz>/AAAA-MM-DD/episodio.json` (cortes y ajustes de ese episodio). `config <carpeta>` muestra el resultado.
- Acabado: H.264 crf 18 (x264 `medium`, o `nvenc` si se pide), highpass + compresor suave, normalizado a −14 LUFS (2 pasadas). Probado: sale a −14,2.
- Escala: análisis de 20 min sintéticos en 26 s (≈80 s por hora). Prueba real de 36 s: 85 s en total. El render de 1 h no está medido.
- Opciones: `--solo-montaje` (hasta el .kdenlive), `--sin-acabado`.

## Primer episodio real (2026-10-03)
- Carpeta de trabajo: `D:\Datos\Videos\Dos Tipos Promedio Podcast\Episodios\2026-10-03\` (originales, montaje, entrega, pruebas).
- Dos sesiones por reconexiones: parte 1 (~58 min, archivos `(1)`) y parte 2 (~39 min, archivos `(2)`).
- `calibrar` por claqueta NO es fiable entre sesiones: jc dio +13 (prueba), −75 (parte 1) y +121 ms (parte 2). No hubo palmada.
  El retardo se elige a oído con clips cortos (`pruebas/`), con `ajustar-audio --probar`.
- La cámara de dj va a 29,97 fps y la de jc a 60.
- Mic de dj muy bajo (−33,9 LUFS, +17,9 dB de ganancia): vigilar el ruido.
- Parte 2: los primeros ~20 s de dj_camara salen sin la luz de frente; hay que cortarlos.
- Parte 1: lo del agua está al inicio. Jc habla de 1:18 a 2:01, hay silencio hasta 2:44 y respuestas cortas hasta ~3:01. Corte propuesto 1:15–3:01, SIN confirmar.
- El llanto de la hija no se trabaja por ahora.

## Resultado del primer episodio (2026-10-03)
- Entregado: `entrega/2026-10-03.mp4`, 93,9 min, 1080p, −14,1 LUFS. Revisado por Jose: audio y vídeo bien.
- Retardo de audio: se dejó en 0 para los dos (elegido a oído con clips cortos). Medido: no hay deriva entre WAV y MP4 (1 ms en una hora) y el acabado no mueve el audio (1–2 ms).
- Falsa alarma: en VLC se vio el audio atrasado, y en otro reproductor estaba bien. No fue el archivo.
- Fallo corregido: el render largo moría hacia los 9000 frames porque `spawnSync` limitaba la salida de melt a 1 MB; ahora va a un archivo y el límite de tiempo es de 8 h.
- El render de 94 min tardó ~1 h 20 min; el análisis de las dos partes, ~25 min. `--reanudar` salta el análisis.

## Cortes y partes (nuevo)
- `episodio` agrupa los archivos en partes y monta cada parte por separado, con su retardo. Al principio se agrupaba
  por el `(n)` que pone el navegador; desde el 2026-10-06, por sesión del Estudio (ver abajo).
- `episodio.json`: `silencios` (recorta los de 4 s o más dejando 1 s), `cortes` generales y `partes: { "1": { audioOffset, desde, hasta, cortes } }`.
  Los tiempos de los cortes son segundos del reloj de la llamada (`"2:02"`, `"1:15"`).
- Los cortes se aplican en la receta (`cortes.js`), así que el `.kdenlive` sale ya cortado. Las partes se unen en `montaje/episodio.json`.
- El análisis de volumen de 1 h de audio es lento (varios minutos por parte).

## Edición con transcripción y retoques (2026-10-04/05)
- **Versión final del episodio** (`entrega/2026-10-03.mp4`, 89,8 min, −14,1 LUFS, color suave): sustituye a la primera. Verificado con transcripción del vídeo ya renderizado (principio y final). Copia del proyecto aprobado: `montaje/episodio-APROBADO.*`.
- **Whisper local** (`transcribir.js`, comando `transcribir <carpeta>`): whisper.cpp v1.9.2 con CUDA 12.4 y modelo `large-v3-turbo-q5_0`, en `D:\Datos\Herramientas\whisper`. ~10 s por minuto de audio en la GTX 1650 con `-fa`. Deja `montaje/transcripcion-parte-N.txt/.json`.
  - ¡Ojo! Los tiempos de Whisper pueden ir hasta ~0,5 s desfasados al final de las frases (p. ej. un «Gracias» suelto). Para cortes finos, medir la energía del micro en vez de fiarse del texto.
  - Al inicio, el pitido de la claqueta (1,00–1,25 s) se transcribe como «Bienvenidos»: es un artefacto. La voz real empezó hacia 2,6 s.
- **Opciones nuevas de `episodio.json` por parte**: `desde`/`hasta`, `cortes`, `limpiezas` (IA RNNoise + puerta de ruido en un micro, en un tramo; modelo en `D:\Datos\Herramientas\rnnoise\sh.rnnn`), `insertar` (copia un tramo antes de un instante), `alFinal`, `mantenerPlano` (fija una cámara en un tramo para evitar ráfagas de cambios).
- **`--recortar`**: reutiliza el reparto de cámaras y solo reaplica cortes (segundos en vez de ~25 min). No vale si cambia `desde`, `hasta` o el retardo de audio (hay que borrar `parte-N/multicam.json` de esa parte).
- **Color** (`color` en la config, apagable con `activo:false`): curva casi plana, saturación 1,05, vibrance 0,18. Elegido por Jose entre varias; una versión más fuerte «se veía rara».
- **`muestra <carpeta>`**: vídeo corto con los empalmes y el color, sin renderizar todo (sin usar en el episodio final).
- **Llanto de fondo bajo la voz**: la puerta de ruido sola no basta (solo actúa en los silencios); RNNoise + puerta mejoró «mucho» según Jose.
- Mic de Douglas muy bajo (+18 dB de ganancia automática): si se oye ruido, activar `quitarRuido` (sin probar).
- Cuidado al escribir scripts: en este entorno se pierden barras invertidas en heredocs de bash y en algunos `Write`; usar la herramienta `Edit` para código con regex.

## Automatización del proceso (2026-10-05)
Objetivo: no volver a empezar de cero cada semana. Procedimiento y decisiones fijas en el skill `/episodio` y en la memoria.
- `analizar <carpeta>`: ~20 s (+ transcripción en segundo plano). Mide inicio/fin de voz (pitido de claqueta + energía), silencios ≥4 s y **marcas de charla técnica** («se perdió la conexión», «lo cortamos», «sí se escucha», «no tengo luz»…), más cambios de brillo al inicio de cada cámara. Escribe `montaje/propuesta.md/.json`. Probado en el episodio real: detecta exactamente los 4 eventos técnicos que se encontraron a mano y ninguna falsa alarma. **No propone contenido** (tangentes, partes flojas): lo decide el usuario.
- `aprobar <carpeta> 1.1 2.1`: pasa propuestas a `episodio.json` (desde el 2026-10-06, al del episodio) con los extremos ajustados al silencio más cercano.
- Cortes **por texto** en `episodio.json`: `{"desde":"frase","hasta":"frase","incluirHasta":false,"despuesDe":"10:00","ordinal":2}` (se quita desde el principio de la primera frase hasta el principio de la segunda). Evita calcular tiempos a mano y el desfase de Whisper.
- `desde`/`hasta` en `"auto"` (valor por defecto): empieza 0,25 s antes de la primera voz tras el pitido y acaba 0,25 s tras la última antes del pitido de cierre; si no hay pitido de cierre (grabación cortada) no recorta el final. Suelo de ruido por percentil 5 (robusto con un monólogo).
- Huella por parte (`parte-N/huella.txt`): si no cambian archivos ni `desde/hasta/audioOffset/minShot/lufs`, no se repite el análisis de ~25 min. `--rehacer` lo fuerza, `--recortar` lo evita siempre.
- `episodio` escribe `montaje/estado.json`; `estado <carpeta>` lo resume en una línea (y avisa si el proceso murió). Evita vigilantes largos, que caducan.
- `verificar <carpeta>` (y al final de `episodio`, salvo `--sin-verificar`): duración, formato, −14 LUFS, sin pitidos, la voz no entra «a medias», y comparación por transcripción del principio y del final. Probado sobre el vídeo real: 8/8 ✔.
- `importar [<carpeta>] [--mover]`: trae de Descargas los archivos del Estudio de las últimas 36 h (desde el 2026-10-06 los coge directamente del Estudio; Descargas queda con `--descargas`). `episodio nuevo` sin ruta usa `EP.RAIZ_POR_DEFECTO`.
- Pruebas: `tests/auto.test.js` (12) con audio sintético para los límites por voz.

## Tramos retomados (2026-10-05)
- Si la página de jc se cae y retoma, el Estudio genera `jc-2_camara/audio`. `multicam` los agrupa con `jc` (`personaBase`): el montaje cubre desde el primer archivo hasta el último de cada persona (el hueco no recorta), los micros de jc y jc-2 comparten pista (`buildRecipe`), el color cuenta a cada persona una vez y `--audio-offset` de `jc` vale para `jc-2`.
- Probado con una sesión sintética (`SESION.retomar`); **sin material real todavía**. Desde el 2026-10-06 `limpiezas` y `mantenerPlano` también valen para `jc-2`, y la llamada partida se une (ver abajo).
- El Estudio vive ahora en su propio repo (`josecarodri/Estudio`, `C:\Users\Carlos\Estudio`). Desde el 2026-10-06 la edición también (ver abajo).

## Revisión del montaje y del Estudio (2026-10-06)
Revisión completa del proceso buscando lo que podía romperse en el próximo episodio. Lo que se cambió:
- **Configuración por episodio.** Los cortes del primer episodio estaban en `Episodios\episodio.json` (la raíz) y se
  habrían aplicado también al siguiente. Ahora se lee por capas: valores por defecto → raíz (solo lo del equipo) →
  `AAAA-MM-DD\episodio.json` (`cortes`, `partes`, `limpiezas`, `mantenerPlano`, `insertar`, `alFinal` y un
  `desde`/`hasta` que no sea `auto`). Lo de un episodio que quede en la raíz se ignora con aviso;
  `config <carpeta> --tomar-de-raiz` lo pasa a su episodio (antes guarda una copia de la raíz). `aprobar` escribe en el
  del episodio y `episodio nuevo` lo crea vacío.
- **Partes por sesión.** `importar` coge las sesiones directamente de `C:\Users\Carlos\Estudio\grabaciones` (otra
  carpeta: variable `GRABACIONES_DIR`, la del servidor, o `--estudio`), en orden de grabación, cada una a `originales/<sesión>/` con
  su `session.json`. Opciones: `--copiar`/`--mover`, `--sesiones id,id`, `--horas`; Descargas sigue con `--descargas`.
  Al agrupar manda la subcarpeta o el prefijo de sesión del nombre; sin eso, el k-ésimo archivo de cada nombre (el
  `(n)` del navegador) es la parte k, con aviso. `episodio` enseña las partes y lo que se quedaría fuera **antes** del
  análisis largo.
- **Llamada partida** (`llamadas.js`). Si se cae la página que graba la llamada (la del PC), quedan `jc_llamada` y
  `jc-2_llamada`. Se unen en `montaje/parte-N/llamada-unida.wav` colocando cada tramo por correlación con la
  grabación continua de la otra persona (su cámara o su micro, la de más confianza, mínimo 5) o, si no, por el
  `startedAtServer` de `session.json`; `llamada-unida.json` dice cómo se colocó. Esa llamada es el reloj de la parte para todo: cortes, limpiezas, silencios y transcripción.
  `analizar` marca el hueco como caída.
- **Silencios confirmados en los micros.** Un silencio de la llamada solo se corta si los micros también callan
  (umbral: suelo de ruido + 20 dB, como poco −55 dB; más de 1 s de voz lo salva). Sin esto, un hueco de la llamada
  con alguien hablando se habría quitado.
- **Limpiezas** en segundos de la llamada, como los cortes, y también sobre `jc-2`. El WAV limpio lleva la parte y
  una firma de los tramos (`montaje/audio/parte-N-<micro>.limpio-<firma>.wav`): se rehace solo si cambian.
- **Proyecto retocado en Kdenlive.** `episodio` guarda la huella del `.kdenlive` que genera; si después se guardó en
  Kdenlive, se para (código 4) en vez de pisarlo. `--reanudar --usar-proyecto` renderiza ese proyecto (y `verificar`
  ya no compara la duración con la receta); `--descartar-cambios` lo rehace y guarda copia (`episodio.kdenlive.editado-…`).
- **Acabado más rápido.** x264 `medium` en vez de `slow`: medido 12,3 s frente a 21,3 s en la misma prueba, con un
  archivo un 2,2 % mayor (YouTube lo vuelve a codificar). `"codificador": "nvenc"` opcional, con vuelta a x264 si
  falla. También medido: melt no se salta fotogramas aunque vaya más lento que el tiempo real (700 de 700
  distintos), y `real_time=-2/-4` solo ganaba ~15 %: no se adoptó.
- **Color.** En archivos de más de ~7 min la muestra para emparejar cámaras empieza en el minuto 1: en los primeros
  segundos la exposición aún se está ajustando.
- **Grabación** (el Estudio): una página que pierde la orden de grabar o de parar se corrige sola en ≤5 s (sus pistas
  llevan `tarde: true`); «● REC» / «⚠ NO ESTÁ GRABANDO» sobre la imagen del otro; se borra de IndexedDB lo ya subido;
  si falla una escritura en el servidor, el archivo vuelve al último trozo bueno; las descargas llevan la sesión
  delante; `alinear` coloca bien los tramos sin pitido de inicio. Detalles en el `CLAUDE.md` de la raíz.
- Pruebas nuevas: `tests/episodio.test.js`, `tests/llamadas.test.js` y casos en `kdenlive.test.js` y `auto.test.js`
  (llamada partida sintética de 60 s, guarda del proyecto, silencios confirmados, partes por sesión).

## Todo en un repo, solo Kdenlive (2026-10-06)
- La edición estaba en el repo `Personal` (`tools/kdenlive-claude`), mezclada con la app de finanzas. Ahora vive aquí,
  en `edicion/`, junto a la grabación: todo lo del podcast en un solo repo. En el PC se trabaja desde
  `C:\Users\Carlos\Estudio\edicion` y Claude Code se abre en `C:\Users\Carlos\Estudio` (ahí están el skill `/episodio` y el `CLAUDE.md`).
- Las grabaciones se importan por defecto de `grabaciones/` de este mismo repo: ya no hay ruta fija del PC en el código.
- **Solo Kdenlive.** Se quitó la herramienta de DaVinci Resolve (`resolve-claude`): la versión gratuita solo admite
  scripts lanzados a mano desde dentro del programa, y con Kdenlive se monta y se renderiza sin abrirlo, que es lo que
  funciona. La validación de recetas, que venía de ella, es ahora propia (`recipe.js`, pruebas en `receta.test.js`).
- Pruebas: `npm test` en la raíz pasa las de la grabación y las de la edición; `npm run test:edicion`, solo estas.

## Marcas en vivo, saltos disimulados, revisión desde el móvil y avisos (2026-10-06)
- **Marcas en vivo** (Estudio + `analizar`): botones ✂ y ★ mientras se graba (teclas C y B en el PC). ✂ es un tramo
  que se abre y se cierra (lo cierra cualquiera; si no, al parar); ★ un instante. El servidor las guarda en
  `session.json` (`marcas`, hora del servidor) y avisa a las dos páginas. `analizar` las pasa al reloj de la llamada
  con el `startedAtServer` de cada tramo de la llamada (y `llamada-unida.json` si está partida): los ✂ de 3 s o más
  son propuestas aprobables (empiezan 1 s antes de la pulsación), los ★ y los ✂ más cortos salen en listas con lo
  que se dijo justo antes. `episodio` las pone como guías (★ verde, ✂ sin cortar rojo) y avisa de los ✂ sin cortar.
  `aprobar` deja una nota en el corte (tercer elemento: `[desde, hasta, "1.2 ✂ en vivo: marcado por JC"]`).
- **Saltos de imagen** (`CUT.disimularSaltos`, config `disimularCortes`): en cada empalme con la misma persona a los
  dos lados se pone 1,5 s la cámara del otro justo después, en sincronía (en la receta sin cortar), y se absorben los
  planos de menos de 0,6 s junto a un corte. También en la unión de dos partes. Comprobado renderizando: el contador
  de la cámara de dj salta de 37 a 42 detrás del plano de jc. Respeta `mantenerPlano` y no usa una cámara sin imagen
  (mira su duración con ffprobe).
- **Guías de los cortes**: cada empalme lleva «✂ motivo (−N s)» (silencio, texto, propuesta aprobada, corte a mano).
- **Revisión desde el móvil** (`revision`, sustituye a `muestra`): `montaje/revision.mp4` en 480p con un trozo por
  empalme (numerado, motivo encima, barra roja en el corte) más principio, final y uniones de partes, y
  `montaje/revision.md`. Sin silencios salvo `--silencios`. Trozos de melt y rotulados guardados con huella: repetirla
  sin cambios tarda menos de 1 s.
- **PC despierto y avisos** (`avisos.js`): los comandos largos piden a Windows no suspender (SetThreadExecutionState
  desde un PowerShell que se cierra al terminar el proceso) y, si tardaron 60 s o más, avisan: notificación de Windows
  y, con `avisos.ntfy`, en el móvil. Los scripts de PowerShell se comprobaron con su analizador y la definición de C#
  compila; falta verlos en el PC.
- Pruebas nuevas: `tests/marcas.test.js` (servidor), avisos y textos en `tests/llamada.test.js`, y en `edicion/tests`:
  `revision.test.js`, `avisos.test.js`, saltos en `cortes.test.js`, marcas en `auto.test.js` y de punta a punta en
  `kdenlive.test.js` (analizar con marcas, episodio con salto disimulado, guías y revisión).

## YouTube, cámaras, plano doble, rótulos, shorts y disco (2026-10-06)
- **YouTube** (`youtube.js`, `youtube`): el «mapa del montaje» traduce la transcripción de cada parte al vídeo final
  comparando dónde empieza cada micro en `parte-N/multicam.json` (in − at de cada micro) con dónde quedó cada trozo en
  `montaje/episodio.json`: lo cortado no sale, lo repetido (`alFinal`, `insertar`) sale dos veces, y no hace falta
  transcribir el vídeo final. Subtítulos de 2 líneas de 42 caracteres (mejor partidas tras un punto), `indice.md` para
  elegir capítulos sin leer la transcripción, capítulos por frase (siguen bien si cambian los cortes) y avisos con las
  reglas de YouTube. `episodio` lo hace solo al final si ya hay transcripciones.
- **Cámara congelada / en negro / sin imagen** (`camaras.js` + `CUT.cubrirCamaras`): ffmpeg `fps=5,scale=160`,
  `freezedetect=n=0.0003:d=1` (los trozos a menos de 0,6 s se juntan: cada imagen clave parte una congelación) y
  `blackdetect`; «sin imagen» si el vídeo acaba 2 s o más antes que el archivo. ≈3 min por hora de vídeo, guardado en
  `montaje/camaras.json`. Medido: un hueco sin imágenes (lo que deja una cámara colgada) da exactamente 0 y se detecta
  exacto; la misma imagen repetida a 10 Mb/s se detecta casi entera (el compresor la afina un poco al principio); una
  imagen quieta con ruido de cámara a esa calidad no da falsos positivos, pero a calidad baja (CRF 23 en 320x180) sí:
  el compresor se come el ruido. Se cubre con la otra cámara antes de copiar tramos y de disimular saltos (con vetos).
  Las cámaras de las sesiones falsas de las pruebas se mueven todas (antes la de jc era una carta de ajuste fija).
- **Plano doble** (`CUT.planoDoble`, `planoDoble`): 3 o más planos seguidos de menos de 2,5 s → los dos a la vez, zoom
  0,5 y ±ancho/4 (jc a la izquierda, V1; el otro en V2). Las funciones de planos (`planosDeVideo`) solo miran V1.
- **Rótulos** (`rotulos.js`, `rotulos.nombres`): QuickTime Animation (qtrle, argb) con `drawtext` en caja y fundido
  de alfa, en V3, en el primer plano de cada uno solo en que quepa. Las entradas de cada pista tienen que ir en orden
  de tiempo (si no, el montaje las toma por solapes): se ordena `edit` por `at`.
- **qtblend necesita pantalla en Linux**: el módulo Qt de MLT 7.22 no carga sin X11 (tampoco con
  `QT_QPA_PLATFORM=offscreen`), y sin él el reencuadre no se aplica al renderizar (el `.kdenlive` está bien). En Linux
  sin pantalla, melt se ejecuta con `xvfb-run -a` si está (`media.comandoMelt`). En Windows no pasa.
- **Shorts** (`shorts.js`, `shorts`): receta 9:16 del montaje final; zoom para llenar el alto = alto·(16/9)/ancho
  (3,16 con 1080x1920, medido: con 1,78 queda una franja); plano doble arriba/abajo (zoom 1,58, tilt ±alto/4). Por ★:
  40 s antes y 8 después, ajustado a frases (el inicio solo se adelanta hasta 2 s, al menos 5 s, como mucho 60).
  Subtítulos ASS (22 caracteres por línea) y −14 LUFS con ffmpeg.
- **Aviso de micro bajo** (Estudio, `Llamada.nivelDelMicro`): nivel cada 100 ms de los últimos 20 s; voz = lo que pasa
  de 12 dB sobre el ruido de fondo; «bajo» si su percentil 90 no llega a −32 dBFS, «satura» con 3 picos a 0 dBFS.
  Comprobado en Chromium con un micro falso a −42 dBFS.
- **Tiempos y disco**: `estado` dice lo que tardó cada fase la última vez (historial en `estado.json`). Render con
  `real_time=-2` (2 fotogramas a la vez): 18,6 → 13,3 s en la prueba de 720p, idéntico (PSNR inf); con -4 no mejora en 4
  núcleos. Presets más rápidos para el bruto no compensan (−10-15 % y ×2-×3 de tamaño). `limpiar` (sin `--confirmar`
  solo enseña; con el episodio listo).

## Pendiente
1. **Una vez, en el PC**: actualizar `C:\Users\Carlos\Estudio` (mejor como clon de git) y abrir Claude Code ahí. Después
   `node cli.js config "D:\Datos\Videos\Dos Tipos Promedio Podcast\Episodios\2026-10-03" --tomar-de-raiz`
   para sacar de la raíz los cortes del primer episodio (deja copia de la raíz).
2. Primer caso real de caída: revisar en Kdenlive el empalme jc → jc-2 y la llamada unida (`llamada-unida.json`).
3. Probar `"codificador": "nvenc"` en la GTX 1650: tiempo del acabado y aspecto.
4. (Opcional) Medir el retardo imagen↔sonido con una palmada filmada y ver si es el mismo entre sesiones. Hoy no hace
   falta: con 0 se ve y se oye bien.
5. En el primer episodio con todo esto: ver en el PC que salen el aviso de Windows y el modo despierto, que la
   revisión llega bien al móvil y que el plano del otro de 1,5 s en los empalmes queda natural (si no, `disimularCortes.segundos`).
6. (Opcional) Aviso en el móvil: instalar ntfy y poner el tema en `avisos.ntfy` del `episodio.json` del equipo.
7. En el primer episodio con lo nuevo: preguntar los nombres de los rótulos y el pie de YouTube (equipo); ver en la
   revisión cómo quedan el plano doble y los rótulos; mirar `estado` tras el render (tiempos por fase) para decidir si
   subir `render.hilos`; comprobar que no salen avisos ⚠ de cámara en material bueno.
8. Color base por cámara; quitar ruido (opción `quitarRuido`, sin probar); encuadre de los shorts por persona (hoy, por el centro).
