# Edición del podcast · montar en Kdenlive desde el chat

Monta el proyecto entero de Kdenlive desde fuera: importa los clips, pone los cortes
con su entrada y salida, fundidos, encadenados, reencuadre, cambios de velocidad y
marcas. Y con `melt` (viene con Kdenlive) lo **renderiza a vídeo sin abrir el programa**.
Encima de eso está el proceso del podcast entero, de las grabaciones del Estudio al
vídeo para YouTube: [El episodio semanal](#el-episodio-semanal-episodio).

Se puede porque un `.kdenlive` es XML del framework MLT: no hay API a la que pedir
permiso, es un archivo de texto con una estructura conocida. Así se monta, se renderiza
y se comprueba el resultado midiéndolo, sin tocar la interfaz. (Con DaVinci Resolve
gratuito no se puede: solo admite scripts lanzados a mano desde dentro del programa,
y se descartó.)

---

## Puesta en marcha

No hay nada que instalar dentro de Kdenlive.

```bash
cd edicion
node cli.js doctor      # qué hay instalado y qué formato se usará
node cli.js selftest    # proyecto de prueba, para comprobarlo en tu Kdenlive
```

`selftest` se inventa dos clips (o usa los tuyos con `--media a.mp4,b.mp4`), monta un
proyecto que toca cortes, fundidos, encadenados y reencuadre, y te dice qué deberías ver
al abrirlo. Es la forma de comprobar en un minuto que el archivo le sienta bien a tu
instalación. Añade `--render` y te deja además el vídeo montado.

Conviene tener dos herramientas, ninguna imprescindible:

- **ffprobe** (del paquete `ffmpeg`): para leer duración, fps y audio de tus clips.
  Sin él todo funciona, pero no se puede avisar de un `out` que se pasa del final.
- **melt** (`sudo apt install melt`): para renderizar sin abrir Kdenlive. Si tienes
  Kdenlive instalado, ya lo tienes.

### Las dos generaciones de formato

Kdenlive cambió el formato de proyecto en la versión **23.04**, y el nuevo (documento
`1.1`) **no se puede abrir con versiones anteriores**. Al revés sí: el antiguo (`1.04`)
lo abre cualquier Kdenlive desde 20.08, y los modernos lo actualizan solos dejando una
copia `_backup`.

`doctor` y `build` detectan tu versión y eligen por ti:

```
Kdenlive 24.12 · se escribirá el formato de documento 1.1
```

Si tienes Kdenlive por Flatpak o Snap, el binario no está en el `PATH` y no se puede
detectar: entonces se asume 23.04 o posterior. Mira la versión en *Ayuda > Acerca de
Kdenlive* y, si es anterior, añade `--doc-version 1.04`. Los dos formatos producen
exactamente el mismo montaje (hay una prueba que compara los dos renders frame a
frame: salen idénticos).

## El ciclo de trabajo

```bash
# 1. yo escribo o actualizo la receta (o la editas tú)
#    recipes/mi-video.json

node cli.js validate recipes/mi-video.json   # revisar sin tocar nada
node cli.js build    recipes/mi-video.json   # escribe mi-video.kdenlive
node cli.js render   recipes/mi-video.json   # y además lo pasa a vídeo
```

`build` lee tus clips antes de montar y te dice qué encontró:

```
  clip a: 1920x1080 · 29.97 fps · 00:02:14:08 · con audio
  clip b: 1920x1080 · 29.97 fps · 00:00:48:12 · SIN audio

generado: /home/jose/videos/mi-video.kdenlive
  1080x1920 @ 30 fps · 3 corte(s) · duración 00:00:27:02
  2 pista(s) de vídeo, 2 de audio · 2 encadenado(s) · 2 clip(s) con fundido
```

Si un corte se sale del material, lo dice antes de generar nada, con los dos tiempos:

```
  ERROR   edit[2]: out 00:02:30:00 pasa del final del clip "a" (00:02:14:07)
```

Luego abres el `.kdenlive` con doble clic, o lo renderizas directamente.

## Montaje automático de una conversación (multicámara)

Para el material típico de una entrevista a distancia —la cámara y el micro de cada
persona, y la captura de la llamada— hay un comando que lo monta solo:

```bash
node cli.js multicam \
  "D:\Descargas\dj_camara.mp4" "D:\Descargas\dj_audio.wav" \
  "D:\Descargas\jc_camara.mp4" "D:\Descargas\jc_audio.wav" \
  "D:\Descargas\jc_llamada.mp4"
```

Hace cinco cosas:

1. **Reconoce el material** por el nombre del archivo: `dj_camara.mp4` es la cámara de
   `dj`, `dj_audio.wav` su micro, y lo que lleve `llamada` o `call` es la referencia
   para sincronizar. Imprime lo que ha entendido, y lo que no reconoce lo dice y lo deja
   fuera en lugar de colarlo. Los tramos retomados del Estudio (`jc-2_camara`,
   `jc-2_audio`) son la misma persona que `jc`; si la llamada quedó partida
   (`jc_llamada` + `jc-2_llamada`), une los tramos en `llamada-unida.wav` y usa esa.
2. **Sincroniza**: compara la envolvente de energía de cada archivo con la de la
   referencia para saber cuántos segundos después empezó cada uno. Da también una
   *confianza*: por debajo de 5 avisa de que no se fía, en vez de alinear mal en
   silencio.
3. **Corta a quien habla**: compara el volumen de los dos micros y va alternando de
   cámara. El audio de los micros **no se corta nunca**: va continuo en su pista, que es
   lo que hace que una conversación no suene a saltos.
4. **Iguala el nivel de los micros**: mide el volumen percibido de cada uno (EBU R128) y
   le pone la ganancia que le falta para llegar a −16 LUFS. Así no hay que estar
   subiendo y bajando según quién habla.
5. **Empareja el color de las cámaras**: mide el color medio de cada una y las acerca a
   un punto común, para que el corte de una a otra no cante.

### Sobre la sincronía: cada micro va contra SU cámara

Las cámaras se alinean contra la referencia (la llamada), que es lo único donde están
las dos personas. Pero los micros **no**: cada micro se alinea contra su propia cámara.

El motivo es que en una llamada la voz del otro llega con el retardo de la red, así que
usar la grabación de la llamada como referencia para un micro mete ese retardo en el
labial. El micro y su cámara, en cambio, grabaron el mismo sonido en la misma
habitación: entre esos dos no se interpone nada.

La precisión es de ~1 ms (se afina por debajo de la resolución de la envolvente
ajustando una parábola al máximo de la correlación). El límite real lo pone la timeline,
que solo coloca clips en frames enteros: ±16 ms a 30 fps, ±8 ms a 60.

El montaje se verifica de punta a punta con material cuyo **brillo sigue a la voz**: así
se puede correlacionar imagen y sonido en el vídeo renderizado y medir el labial en
lugar de mirarlo. Sobre material limpio sale a **+0,1 ms**.

Si aun así el audio te queda movido, es cosa del material. Para eso:

```bash
# genera varias versiones y te quedas con la que cuadre, sin repetir el análisis
node cli.js ajustar-audio montaje/multicam.json --probar "0,-33,-66,-100" --render

# y ya para siempre, en el propio multicam:
node cli.js multicam ... --audio-offset -33
```

**Negativo adelanta el audio** (úsalo si va atrasado), positivo lo atrasa. El sentido
está calibrado contra un archivo con 100 ms de retardo metidos a propósito, no deducido.

### De dónde sale ese retardo, y cómo medirlo en vez de buscarlo

Si la grabación se hizo con una claqueta digital (un pitido inyectado en el bus de
audio, como hace el Estudio, la parte de grabación de este repo), ese pitido alinea el audio de todos con
mucha precisión, pero **no dice nada del vídeo**: se genera dentro del grafo de audio,
mientras que la cámara se captura por otro camino con su propia latencia. Las dos pistas
quedan desplazadas a la vez, así que comparar archivos entre sí no lo detecta.

Para verlo hace falta un suceso que esté en la imagen y en el sonido a la vez. El
Estudio ya lo graba: además del pitido, **destella la pantalla**, y esa luz
en la cara sí queda en el vídeo.

```bash
# archivos sueltos, o la carpeta de la sesión y coge lo que haya dentro
node cli.js calibrar ../grabaciones/dtp/2026-10-03_19-30-00
```

Localiza el pitido de 1 kHz con Goertzel (el mismo método que `lib/beep.js` del Estudio, a
propósito: lo que detecte uno tiene que detectarlo el otro igual) y, **a partir de ahí**,
el destello.

> Con el equipo del podcast la conclusión fue que **no hace falta ajuste** (0 para los dos, elegido a oído en el
> primer episodio), y que `calibrar` da valores distintos en cada sesión: no lo uses para decidir. Ver `ESTADO.md`.

Buscar el destello como «la mayor subida de brillo del archivo» no funciona con material
real, y se vio en cuanto se probó: al empezar a grabar, el ajuste automático de
exposición mueve el brillo muchísimo, y a mitad de grabación cualquiera se mueve o
enciende una luz. Las dos cosas dan subidas mayores que un destello de pantalla
reflejado en una cara. Así que se busca de otra forma:

- **solo cerca del pitido** (±300 ms, ajustable con `--radio`), porque los dos se
  disparan a la vez. Es estrecho a propósito: el arranque de una grabación está lleno de
  cambios de brillo y la mejor defensa es no mirar donde el destello no puede estar;
- **por su forma**, comparando con el perfil del destello (golpe y caída de 350 ms), no
  por ser el cambio más grande;
- midiendo el fondo con un **percentil bajo** en lugar de la media, porque si justo antes
  viene cayendo otra cosa, la media sale alta y tapa la subida que se busca. Con la media,
  un destello real llegaba a puntuar negativo.

Lo que no resuelve: si justo encima del destello hay otro cambio de brillo con su misma
forma y varias veces mayor, gana el otro. No se puede distinguir por la señal, solo por la
posición, y para eso ya está la ventana. La diferencia es el retardo, y da directamente el `--audio-offset` de
cada persona.

Si no hay claqueta, busca un golpe en imagen y sonido a la vez, que es lo que da una
palmada delante de la cámara.

Y si no hay ninguna marca, **no da número**. Sin ese cuidado, en material hablado el modo
de respaldo encuentra el mayor movimiento y el mayor golpe de sonido, que no tienen nada
que ver entre sí, y suelta algo como «−1800 ms» con confianza suficiente para parecer
bueno. Se rechaza todo lo que pase de medio segundo, porque la latencia de una cadena de
captura se cuenta en decenas o pocos cientos de milisegundos, y se dice cuál de las tres
cosas falló: marca poco clara, retardo imposible, o que se esté usando el respaldo.

El pitido se localiza con precisión de muestra, pero el destello solo se puede situar
**al fotograma**: queda una incertidumbre de medio fotograma (±17 ms a 30 fps, ±8 a 60)
que se informa junto al resultado. Verificado con el destello cayendo en distintos
puntos del fotograma: el error nunca se sale de ahí.

### El ajuste puede ser distinto para cada persona

Cada uno graba con lo que tiene —unos auriculares, el micrófono de una tableta, una
interfaz— y cada cadena mete su propio retardo. Un valor único arregla a uno y estropea
al otro, así que ambas opciones aceptan pares:

```bash
node cli.js multicam ... --audio-offset "jc=-60,dj=0"

# y para encontrar el de cada uno sin tocar al otro:
node cli.js ajustar-audio montaje/multicam.json --probar "-30,-60,-90" --persona jc
```

Quien no se nombre se queda sin tocar. Ese retardo suele ser constante del equipo, no de
la grabación: una vez encontrado, sirve para las siguientes.

`multicam` avisa además si dentro de un `.mp4` la pista de audio no empieza a la vez que
la de vídeo, que es una causa típica de que el labial no cuadre. Ese desfase se informa
pero **no se descuenta**: medido sobre material con 120 ms inyectados, descontarlo
empeora el resultado, porque ffmpeg ya lo ignora al decodificar y restarlo otra vez lo
cuenta dos veces.

```
desfases respecto a la referencia:
  jc_llamada (1)         referencia
  dj_camara              +4.40s · confianza 13.0
  dj_audio               +3.00s · confianza 11.6
  jc_camara (1)          +0.60s · confianza 16.3
  jc_audio (1)           +1.20s · confianza 14.4

parte común: 4.40s a 30.00s (25.6s de montaje)

5 planos · duración media 5.1s
  dj: 12.6s en pantalla (49%)
  jc: 13.0s en pantalla (51%)
```

El montaje solo cubre la parte en la que **existen todos los archivos**: si una cámara
empezó más tarde, el proyecto arranca ahí. El hueco entre un tramo y su retomado
(`jc` → `jc-2`) no recorta nada: cuenta de la primera a la última grabación de cada persona.

Opciones útiles:

- `--min-shot <segundos>`: cuánto dura como poco cada plano (2 por omisión). Súbelo para
  un montaje más calmado, bájalo para uno más picado.
- `--desde <tiempo>` y `--hasta <tiempo>`: recortan el principio y el final, que es donde
  suele estar el pitido de sincronía. Aquí un número suelto son **segundos** (al revés
  que en la receta); también valen `1:30` y `00:01:30`.
- `--audio-offset <ms>`: mueve el audio a mano. Negativo lo adelanta, positivo lo atrasa.
- `--audio off`, `--lufs <valor>`: no igualar niveles, o cambiar el objetivo.
- `--color off`: no emparejar las cámaras.
- `--saturacion <x>`, `--contraste <x>`: a gusto, sobre todas las cámaras (1 = sin tocar).
- `--ref <archivo>`: la referencia de sincronía, si no se reconoce sola.
- `--fps <n>`: ritmo del montaje cuando las cámaras no coinciden.
- `--render`: deja además el vídeo montado.
- `--name "..."`, `--out <carpeta>`, `--analyze <segundos>`.

Deja en la carpeta de salida `multicam.json` (la receta, editable) y
`multicam.kdenlive`. Si el reparto no te convence, cambias la receta y vuelves a
`build`; o abres el proyecto y mueves los cortes a mano, que para eso están.

Cada plano queda además marcado con una **guía** con el nombre de quien habla, así se ve
de un vistazo en la timeline por qué está cortado ahí.

### Comandos

| | |
|---|---|
| `node cli.js doctor` | qué hay instalado y qué falta |
| `node cli.js validate <receta>` | revisa la receta, todos los fallos a la vez |
| `node cli.js build <receta>` | escribe el `.kdenlive` |
| `node cli.js render <receta>` | lo renderiza a vídeo con `melt` |
| `node cli.js selftest` | proyecto de prueba para comprobar tu Kdenlive |
| `node cli.js multicam <archivos...>` | monta una conversación a varias cámaras |
| `node cli.js ajustar-audio <receta>` | mueve el audio sin repetir el análisis |
| `node cli.js calibrar <camaras...>` | mide el retardo imagen-sonido (claqueta o palmada) |
| `node cli.js episodio nuevo [<raiz>]` / `episodio <carpeta>` | proceso semanal completo (sin raíz usa la carpeta fija de episodios) |
| `node cli.js importar [<carpeta>] [--copiar \| --mover]` | trae las sesiones del Estudio a `originales/` (sin opción, solo las lista) |
| `node cli.js config <carpeta> [--tomar-de-raiz]` | configuración efectiva del episodio y de qué archivo sale cada ajuste |
| `node cli.js analizar <carpeta>` | propuesta: inicio/fin de voz, silencios y marcas de charla técnica (no propone contenido) |
| `node cli.js aprobar <carpeta> 1.1 2.1` | pasa propuestas al `episodio.json` del episodio, con los cortes ajustados al silencio |
| `node cli.js verificar <carpeta>` | comprueba el vídeo final: duración, −14 LUFS, sin pitidos, principio y final |
| `node cli.js estado <carpeta>` | en qué fase va el proceso, en una línea, y lo que tardó cada fase la última vez |
| `node cli.js transcribir <carpeta>` | transcripción local con Whisper (texto con tiempos por parte) |
| `node cli.js revision <carpeta> [--silencios]` | vídeo corto (480p) para revisar el montaje desde el móvil: cada empalme numerado, principio y final |
| `node cli.js youtube <carpeta>` | subtítulos `.srt`, transcripción e índice del vídeo final, y la descripción con capítulos (`entrega/youtube.md`) |
| `node cli.js shorts <carpeta> [--antes 40] [--despues 8]` | shorts verticales con subtítulos, de los ★ marcados al grabar (o de `shorts`), en `entrega/shorts/` |
| `node cli.js limpiar <carpeta> [--estudio] [--confirmar]` | libera disco con el episodio hecho (sin `--confirmar` solo enseña qué borraría) |

Opciones: `--out <archivo>`, `--doc-version 1.1|1.04`,
`--compositing qtblend|frei0r.cairoblend|composite`, `--root <carpeta>`,
`--timeout <segundos>` y `--hilos <n>` (en `render`: fotogramas a la vez, 2 por omisión), y en `selftest` además `--dir <carpeta>`,
`--media a.mp4,b.mp4` y `--render`.

## El episodio semanal (`episodio`)

Encadena todo lo anterior para el podcast: de las grabaciones del Estudio al vídeo para YouTube. El paso a paso,
con lo ya decidido y las trampas, está en el skill `/episodio` (`.claude/skills/episodio/SKILL.md` en la raíz del
repo); aquí va cómo funciona por dentro.

**Carpetas.** `<raiz>/AAAA-MM-DD/` con `originales/` (lo del Estudio, sin tocar, una subcarpeta por sesión),
`montaje/` (recetas, proyecto, render en bruto, transcripciones, propuesta, estado) y `entrega/` (el vídeo final).

**Configuración en capas.** Los valores por defecto (`CONFIG_POR_DEFECTO` en `episodio.js`), encima
`<raiz>/episodio.json` con lo del equipo (retardo de audio por persona, niveles, silencios, color, codificador) y
encima `<raiz>/AAAA-MM-DD/episodio.json` con lo de ese episodio. Las claves de episodio (`cortes`, `partes`,
`limpiezas`, `mantenerPlano`, `insertar`, `alFinal`, `titulo`, `resumen`, `capitulos`, `shorts`, y `desde`/`hasta` que no sean `auto`) puestas en la raíz no se
aplican: se avisa, y `config <carpeta> --tomar-de-raiz` las pasa a su episodio. Un `episodio.json` de episodio:

```jsonc
{
  "titulo": "…", "resumen": "…",                       // para YouTube (ver más abajo)
  "capitulos": [{ "titulo": "Intro" }, { "titulo": "El viaje", "frase": "bueno, cuéntame del viaje" }],
  "shorts": [{ "desde": "12:30", "hasta": "13:20" }],  // minutos del vídeo final; sin esto, uno por ★
  "cortes": [["2:02", "2:34"]],                        // para todas las partes
  "partes": {
    "1": {
      "desde": "auto", "hasta": "auto",                  // o un tiempo
      "cortes": [{ "desde": "frase", "hasta": "frase" }],  // por texto: se buscan en la transcripción
      "limpiezas": [{ "persona": "jc", "desde": "10:40", "hasta": "12:10" }],  // RNNoise + puerta ("ia": false, "puerta": false)
      "mantenerPlano": [["58:10", "59:30"]],             // sin cambios de cámara (p. ej. la despedida)
      "insertar": [{ "tramo": ["1:00:05", "1:00:40"], "antes": "58:10" }],
      "alFinal": [["1:00:05", "1:00:40"]]
    }
  }
}
```

Todos los tiempos son **segundos del reloj de la llamada de esa parte**, el mismo que el de la transcripción: lo que
se lee se corta tal cual. Los `cortes` generales se suman a los de cada parte; lo demás de una parte sustituye a lo
general.

**Partes.** Cada sesión del Estudio es una parte. `importar` las trae de `grabaciones/` de este repo (o de
`GRABACIONES_DIR`, la misma variable que usa el servidor, o de `--estudio`; con `--descargas`, de Descargas) en orden de grabación, cada una a
`originales/<sesión>/` con su `session.json`. Al agrupar manda la subcarpeta, o el prefijo de sesión del nombre
(`2026-10-10_21-30-05_dj_camara.mp4`); sin ninguno de los dos, el k-ésimo archivo de cada nombre (el `(n)` del
navegador) es la parte k, y se avisa. Cada parte se monta por separado con `multicam` y luego se unen.

**Llamada partida.** Si se cae la página que graba la llamada, quedan `jc_llamada` y `jc-2_llamada`. `llamadas.js`
coloca cada tramo por correlación con la grabación continua de la otra persona (o, si no es fiable, con la hora de
inicio que apuntó el Estudio en `session.json`) y los une en `montaje/parte-N/llamada-unida.wav`, con silencio en el
hueco. Esa es la referencia y el reloj de la parte. `analizar` marca el hueco como caída.

**Silencios.** Se buscan en la llamada (4 s o más, se dejan en 1 s) y se confirman en los micros: si en alguno hay
voz, la llamada perdió audio y ese tramo no se corta.

**Marcas en vivo.** Mientras se graba, en el Estudio se puede pulsar ✂ (abre un tramo para cortar; la siguiente
pulsación, de cualquiera de los dos, lo cierra) y ★ (un buen momento: lo de justo antes). Quedan en `session.json`
con la hora del servidor; `analizar` las pasa al reloj de la llamada (también si está partida) y convierte los ✂ en
propuestas aprobables (empiezan 1 s antes de la pulsación) y los ★ en una lista de momentos buenos con lo que se dijo.
En el proyecto de Kdenlive salen como guías: verdes los ★, rojos los ✂ que no se cortaron.

**Saltos de imagen.** Si en un empalme (un corte, un silencio recortado, la unión de dos partes) se vería a la misma
persona a los dos lados, la cara cambia de golpe. `episodio` pone justo después del empalme 1,5 s la cámara del otro
(en sincronía: es su imagen de ese momento) y vuelve a quien habla; y un plano que junto a un corte quedaría de un
instante se absorbe en el de al lado. Se hace en la receta sin cortar, solo en el vídeo, y no toca los
`mantenerPlano` ni usa una cámara donde no tiene imagen. Se ajusta con `disimularCortes` (`segundos`, `minimo`,
`activo: false` para no hacerlo). Cada empalme lleva además una guía morada: «✂ motivo (−N s)».

**Revisión desde el móvil.** `revision <carpeta>` hace `montaje/revision.mp4` (480p): unos segundos alrededor de
cada empalme, numerados, con el motivo escrito encima y una barra roja en el instante del corte, más el principio y
el final del episodio y las uniones de partes; y `montaje/revision.md` con la lista y el minuto de cada uno en el
vídeo final. Los silencios recortados solo salen con `--silencios`. Cada trozo se guarda con una huella: si no
cambia nada, la revisión sale en segundos, y si cambia un corte solo se rehace lo que cambió.

**Cámara congelada o en negro.** Si una webcam se cuelga (imagen quieta, o un hueco sin imagen en el archivo), se
tapa, se apaga o deja de dar imagen antes de que acabe el archivo, `camaras.js` lo encuentra con ffmpeg
(`freezedetect` y `blackdetect` a 5 imágenes por segundo y 160 px de ancho: ≈3 min por hora de vídeo, guardado en
`montaje/camaras.json` para no repetirlo) y `cortes.cubrirCamaras` pone en esos tramos la cámara del otro, en
sincronía, antes de sacar lo que se copia (`alFinal`, `insertar`) y de disimular saltos (que ya no la vuelve a
poner ahí). Al montar lo dice («⚠ 0:30 → 0:40 cámara de dj congelada (10 s): se ve a jc») y deja una guía naranja
«⚠» que sale en la revisión. La tolerancia es muy baja: una imagen repetida tal cual da diferencia 0, y alguien
quieto con el ruido de su cámara no (a la calidad del Estudio, 10 Mb/s en 1080p). Ajustes en `camaras`
(`congelada` 4 s, `negro` 2 s, `tolerancia`); `--sin-camaras` lo salta.

**Plano doble.** Cuando la conversación va y viene deprisa (`planoDoble.planos`, 3, planos seguidos de menos de
`corto`, 2,5 s, y al menos `minimo`, 3 s), tanto cambio de cámara marea: en ese tramo se ve a los dos a la vez, cada
uno en su mitad (zoom 0,5; la izquierda en V1 y la derecha en V2; `izquierda`: `jc`), con una guía azul «◫». Se
hace tras disimular los saltos, en la receta sin cortar, y no usa una cámara congelada ni toca los `mantenerPlano`.
La revisión enseña los dos primeros. `"planoDoble": { "activo": false }` lo quita.

**Rótulos con el nombre.** Con `"rotulos": { "nombres": { "jc": "José", "dj": "Douglas" } }` en la configuración
del equipo, la primera vez que se ve a cada uno solo (desde el segundo `desde`, 3, en un plano en que quepa entero)
sale su nombre abajo a la izquierda `segundos` (4), con fundido. Cada rótulo es un vídeo con transparencia
(QuickTime Animation, `montaje/rotulos/`) hecho con ffmpeg y va en la pista V3: en Kdenlive se mueve o se quita como
cualquier clip. Sin nombres no se pone ninguno.

**YouTube.** `youtube <carpeta>` traduce la transcripción de cada parte (reloj de su llamada) al vídeo final con el
«mapa del montaje» (`youtube.js`: compara dónde empieza cada micro en la receta sin cortar con dónde quedó cada
trozo en la final; lo cortado no sale y lo repetido sale dos veces), sin volver a transcribir. Deja en `entrega/`
los subtítulos (`<episodio>.srt`, frases de 2 líneas de 42 caracteres), `transcripcion.txt`, `indice.md` (cada 2
min: cómo empieza y sus palabras más repetidas, para elegir capítulos), `<episodio>.descripcion.txt` y
`youtube.md` (título, descripción, etiquetas, archivos y lo que falta). Los capítulos van por frase (o `"en":
"12:34"`): el primero siempre en 0:00, y avisa si hay menos de 3 o alguno de menos de 10 s (YouTube no los
mostraría). El pie de la descripción y las etiquetas son del equipo: `"youtube": { "pie": "…", "etiquetas": [] }`.
`episodio` lo hace solo al final si ya están las transcripciones.

**Shorts.** `shorts <carpeta>` hace uno vertical (1080x1920) por cada ★ marcada al grabar, con los 40 s de antes
de la marca y 8 de después, ajustados a frases (o los de `shorts` en el `episodio.json` del episodio:
`{ "desde", "hasta" }` en minutos del vídeo final, o `{ "frase", "segundos" }`), como mucho 60 s. Sale del montaje
final, con lo ya cortado y disimulado: cada cámara recortada por el centro para llenar el alto (zoom
alto·(16/9)/ancho = 3,16, medido con melt) y el plano doble con una persona arriba y otra abajo (sin rótulos).
Encima, con ffmpeg, los subtítulos grabados (ASS: letra gruesa blanca con borde, a dos tercios del alto, encima de
los botones de YouTube) y el volumen a −14 LUFS. Quedan en `entrega/shorts/` con su lista `shorts.md`.

**Lo que no se repite.** La huella de cada parte (`parte-N/huella.txt`) evita repetir el análisis de cámaras si no
cambiaron los archivos ni lo que afecta al reparto; cambiar cortes tarda segundos. `--rehacer` lo fuerza,
`--recortar` lo evita siempre, `--reanudar` parte del montaje ya unido y salta al render.

**Proyecto retocado a mano.** `episodio` guarda la huella del `episodio.kdenlive` que escribe. Si después se guardó
en Kdenlive, no lo pisa: termina con código 4 y propone `--reanudar --usar-proyecto` (renderiza ese proyecto con sus
cambios) o `--descartar-cambios` (lo rehace desde la receta y guarda una copia, `episodio.kdenlive.editado-…`).

**Acabado.** Segunda pasada con ffmpeg sobre el render de melt: highpass y compresor suaves, −14 LUFS en dos
pasadas (pico −1 dBTP), color de acabado, H.264 crf 18 con el índice al principio. `codificador: "x264"` (preset
`medium`) o `"nvenc"` (tarjeta gráfica; si falla, se repite solo con x264). El color de acabado y la limpieza de
sonido no están en el `.kdenlive`: en Kdenlive se ve el montaje, no el aspecto final.

**PC despierto y aviso al terminar.** `episodio`, `analizar`, `transcribir`, `revision`, `render`, `youtube` y `shorts` impiden que
el PC se duerma mientras trabajan (en Windows, con un PowerShell aparte que se cierra solo al acabar) y, si tardaron
más de `avisos.minimoSegundos` (60), avisan al terminar o al fallar: notificación de Windows y, con
`"avisos": { "ntfy": "<tema>" }` en la configuración del equipo, también en el móvil con la app gratuita ntfy
suscrita a ese tema (o la dirección de un servidor ntfy propio). El tema hace de contraseña: mejor uno difícil de
adivinar.

**Tiempos y disco.** Cada fase apunta en `montaje/estado.json` lo que tardó, y `estado` enseña los tiempos de la
última vez (p. ej. «montando-parte-1 3 min · renderizando 42 min · acabado 11 min»). El render hace 2 fotogramas a
la vez (`"render": { "hilos": 2 }`, el `real_time=-2` de melt): un 28 % más rápido en las pruebas y el mismo
resultado imagen a imagen; con 1, de uno en uno. Un preset de x264 más rápido para el render en bruto no
compensa (10-15 % menos y el doble o el triple de tamaño). Con el episodio hecho, `limpiar <carpeta>` dice qué se
puede borrar (render en bruto, revisión, intermedios de los shorts, micros limpiados, llamada unida, temporales;
con `--estudio`, las grabaciones del Estudio ya copiadas en `originales/` con el mismo tamaño) y cuánto libera, y
lo borra con `--confirmar`. Nunca toca `originales/`, `entrega/` ni los proyectos de Kdenlive, y pide que el
episodio esté listo (o `--forzar`).

Opciones de `episodio`: `--solo-montaje`, `--reanudar`, `--recortar`, `--rehacer`, `--sin-silencios`,
`--sin-acabado`, `--sin-verificar`, `--sin-camaras`, `--usar-proyecto`, `--descartar-cambios`; `episodio nuevo [<raiz>] --fecha AAAA-MM-DD`.
De `importar`: `--copiar`, `--mover`, `--sesiones <id>,<id>`, `--horas <n>` (36), `--estudio <carpeta>`,
`--descargas [<carpeta>]`.

---

## La receta

Es lo que escriben `multicam` y `episodio` (`montaje/parte-N/multicam.json`,
`montaje/episodio.json`), y también se puede escribir a mano. `validate` la revisa entera y
dice todos los fallos a la vez; lo que no conoce lo avisa y lo ignora.

Los tiempos aceptan frames (`120`), `"HH:MM:SS:FF"`, `"MM:SS"` o segundos (`"2.5s"`).

```jsonc
{
  "project": { "name": "Vertical 9x16", "fps": 30, "width": 1080, "height": 1920 },
  "bin": "Claude",
  "media": [
    { "id": "a", "path": "/home/jose/videos/entrevista.mp4" },
    { "id": "b", "path": "/home/jose/videos/broll.mp4" }
  ],
  "timeline": { "name": "Vertical v1" },
  "tracks": { "video": 2, "audio": 2 },     // opcional; crece solo si hace falta

  "edit": [
    {
      "clip": "a",
      "in": "00:00:10:00", "out": "00:00:22:00",  // o "duration": "3s"
      "track": 1,            // pista de vídeo (V1, V2...)
      "at": "00:00:05:00",   // posición; por omisión va tras el corte anterior
      "audio": true,         // false = sin su audio
      "fadeIn": "0.5s",      // fundido desde negro (y de audio desde el silencio)
      "fadeOut": "1s",
      "dissolve": "0.4s",    // encadenado con el corte anterior de esta pista
      "speed": 2,            // 2 = el doble de rápido, 0.5 = a la mitad
      "zoom": 3.16,          // reencuadre: en un proyecto 9:16, 3,16 llena el alto con un 16:9
      "pan": 0, "tilt": 40,  // desplazamiento en píxeles
      "opacity": 100
    }
  ],

  "guides": [
    { "at": "00:00:12:00", "name": "corte a b-roll", "color": "Red" }
  ]
}
```

`transform: [{ "index": 1, "zoom": 3.16 }]` también vale: se aplica al corte número 1 de
`edit` (lo que diga el propio corte manda).

Hay tres ejemplos en `recipes/`: `ejemplo-simple.json`, `ejemplo-vertical.json`
(Reels/Shorts con reencuadre y encadenados) y `ejemplo-ritmo.json` (cortes cortos y un
clip al doble de velocidad).

---

## Qué está verificado y qué no

Esto importa, así que va explícito.

**Verificado renderizando y midiendo el resultado**, no por suposición:

- La duración sale exacta, con el solape de los encadenados descontado
  (50 + 50 − 25 = 75 frames).
- El fundido de entrada arranca en negro puro y sube de forma continua; el de salida
  baja hasta negro. Medido con el brillo medio de cada frame.
- El encadenado es una mezcla real: a mitad del solape el frame está *entre* los dos
  clips, y la transición progresa sin cortes.
- Los fundidos de audio van del silencio (−86 dB) al nivel normal y vuelven.
- El XML es válido y MLT lo renderiza con vídeo y audio.

Encontrar esto sirvió de algo: los fundidos de audio **estaban mal** en la primera
versión (usaban parámetros que MLT ignora en silencio) y solo se vio al medir.

- Los dos formatos de documento (1.1 y 1.04) montan lo mismo: los dos renders salen
  idénticos frame a frame (`PSNR average:inf`).
- El multicámara, contra una sesión fabricada con desfases y turnos conocidos: recupera
  los cuatro desfases **exactos** (confianza 10-16), el reparto de tiempo en pantalla
  coincide con los turnos programados, y en el vídeo renderizado los cortes caen a
  40-120 ms de los cambios de turno reales.
- La sincronía afinada acierta desfases fraccionarios con menos de 1 ms de error, frente
  a los 10 ms de salto que imponía la resolución de la envolvente.
- La ganancia de audio y la corrección de color **se aplican de verdad al renderizar**,
  no solo se escriben: pedir +6 dB da exactamente +6,0 dB medidos, y pedir ganancias de
  canal 1,3 / 1,0 / 0,7 da 1,28 / 0,99 / 0,72.
- Emparejar las cámaras reduce el salto de color en los cortes de 42,0 a 10,1 (−76%), y
  el montaje entero queda a −16,1 LUFS con el objetivo en −16.
- El labial del montaje, medido correlacionando el brillo de la imagen con la energía
  del sonido en el vídeo ya renderizado: **+0,1 ms**. Y `ajustar-audio` mueve justo lo
  que se le pide: pedir 33 ms da 33,4 medidos, y 66 da 66,6.

- El plano doble, los rótulos y los shorts, renderizados con melt y mirados imagen a imagen: cada persona en su
  mitad (o arriba y abajo en vertical) y en sincronía, el rótulo con su transparencia sobre el plano de esa
  persona, y el vertical con los subtítulos grabados. Así se vio que el reencuadre para llenar un vertical es
  zoom 3,16 y no 1,9, como se había escrito sin medirlo.
- La cámara congelada: en una sesión fabricada con la cámara de dj congelada 10 s, se encuentra justo ese tramo y en
  el render se ve a jc en sincronía y luego otra vez a dj, ya moviéndose. Un hueco sin imágenes en el archivo (lo
  que deja una cámara colgada) se detecta exacto; una imagen quieta con ruido de cámara, a la calidad del Estudio,
  no se toma por congelada.
- Renderizar 2 fotogramas a la vez da el mismo vídeo imagen a imagen (`PSNR average:inf`).

Buscar los fallos midiendo salió a cuenta: además de los fundidos de audio, así
aparecieron un desajuste de un frame al acotar el audio al final del archivo, y un suelo
de ruido que se metía dentro de la voz cuando una persona habla casi todo el rato (un
monólogo), con lo que no se la habría detectado hablando nunca.

**Que Kdenlive lo abra** no se pudo comprobar donde se escribió esto (no hay Kdenlive
instalado); se comprobó después en uso: el proyecto del primer episodio se revisó en
Kdenlive 26.8. Lo que se hizo para llegar ahí: copiar la estructura de los proyectos de
prueba del propio KDE y comparar propiedad por propiedad con ellos para no omitir nada
que haga falta al abrir (así se encontraron tres que faltaban: `uuid`, `opensequences`
y `activetimeline`, sin las cuales la timeline puede no aparecer).

Para cerrar ese hueco está `node cli.js selftest`: lo ejecutas, abres el proyecto y en
cinco comprobaciones se ve si el formato le sienta bien a tu instalación. Si algo no
cuadra, dímelo y lo ajusto.

## Limitaciones conocidas

- **Títulos de Kdenlive.** No se usan: los rótulos con el nombre son vídeos con transparencia hechos con ffmpeg
  (pista V3). Para cambiar un nombre se cambia en la configuración y se vuelve a montar.
- **Efectos en el proyecto.** En el `.kdenlive` no hay más que reencuadre, opacidad,
  fundidos, ganancia de audio y el emparejado de color entre cámaras. El color de
  acabado y la limpieza de sonido del episodio los aplica `episodio` con ffmpeg después
  del render: en Kdenlive se ve el montaje, no el aspecto final.
- **Un encadenado por punto de corte**, que es también el límite de Kdenlive.
- **Rótulos en `multicam`.** Solo los pone `episodio` (con `rotulos.nombres`); en `multicam` las guías de la
  timeline dicen quién es.
- **Shorts recortados por el centro.** Si alguien se sienta muy a un lado de su cámara, el vertical puede cortarle.
- **Cámara congelada con muy poca calidad.** Si el compresor deja idénticas las imágenes de alguien muy quieto
  (pasa con mucha menos calidad que la del Estudio), no se distingue de una cámara colgada: se vería al otro.
- **El sonido, en `multicam`, se iguala pero no se limpia.** La limpieza va en
  `episodio`: filtro de graves y compresor suaves en el acabado, y RNNoise + puerta de
  ruido en los tramos que se pidan (`limpiezas`). Sin probar: `quitarRuido` (todo el
  episodio).
- **El color se empareja, no se "mejora".** Se acercan las cámaras entre sí multiplicando
  cada canal, que es lo que se puede medir y defender. Dar más contraste o saturación es
  cuestión de gusto, y para eso están `--contraste` y `--saturacion`.
- **El pitido de sincronía, en `multicam`, no se quita solo.** Se quita con `--desde` y
  `--hasta`. `episodio` sí lo hace (`desde`/`hasta` en `auto`): empieza con la primera
  voz tras el pitido y acaba con la última antes del pitido de cierre.
- **Un retardo metido en el propio contenido no se puede medir desde fuera.** Si la
  cadena de grabación de alguien escribe su audio desplazado respecto a su vídeo, los
  metadatos no lo dicen y la correlación lo reproduce fielmente. Eso se afina con
  `--audio-offset`, y conviene hacerlo por persona.
- **Sincronía por envolvente.** Necesita que los audios compartan contenido reconocible
  con la referencia. Con música de fondo constante o un tono plano no hay forma: ahí la
  confianza baja y lo dice, para que lo revises en la timeline.
- **`melt` sin pantalla en Linux.** El módulo Qt de MLT (el de `qtblend`: reencuadre, plano doble, rótulos y
  composición entre pistas) pide una pantalla («requires a X11 environment»). Si está `xvfb-run`, `render`,
  `revision` y `shorts` lo usan solos (`media.comandoMelt`); si no, el vídeo sale sin reencuadre ni composición. El
  `.kdenlive` sigue siendo correcto, y en Windows no pasa.

## Pruebas

```bash
npm test               # desde la raíz del repo: grabación y edición
npm run test:edicion   # solo las del editor
```

Cubre el cálculo de tiempos, la disposición de los cortes, el XML generado, la
validación y los mensajes de error. Y cuando hay `ffmpeg` y `melt`, genera clips de
prueba, monta el proyecto, lo **renderiza** y comprueba que dura exactamente lo pedido;
si no están, esas pruebas se saltan solas.

## Archivos

```
cli.js         todos los comandos (doctor, build, render, multicam, episodio, importar…)
sync.js        sincronía de audio por correlación cruzada (FFT, sin dependencias)
multicam.js    reparto de material, turnos de palabra y receta del multicámara
calibrar.js    retardo entre imagen y sonido de una cámara (claqueta o palmada)
analisis.js    medidas con ffmpeg: volumen percibido (EBU R128) y color medio
project.js     genera el XML del proyecto (función pura, sin tocar disco)
recipe.js      validación de recetas (todos los fallos a la vez)
media.js       lee los clips con ffprobe
episodio.js    carpetas, configuración en capas, partes, importar del Estudio, limpieza y acabado
llamadas.js    une la llamada partida (tramos de una página que se cayó y se retomó)
cortes.js      quita, inserta y une tramos en la receta (cortes, plano fijo, partes, saltos, plano doble)
auto.js        analizar, aprobar, verificar, estado; límites por voz, cortes por texto, huella
analizar.js    medidas rápidas de una parte: inicio y fin de voz, charla técnica, citas → tiempos
transcribir.js transcripción local con whisper.cpp
revision.js    vídeo de revisión para el móvil (trozos alrededor de cada empalme)
avisos.js      PC despierto durante lo largo y aviso al terminar (Windows y ntfy)
camaras.js     cámara congelada, en negro o sin imagen (la cubre cortes.cubrirCamaras)
rotulos.js     rótulos con el nombre (vídeos con transparencia en V3)
youtube.js     mapa del montaje, subtítulos, capítulos, índice y descripción
shorts.js      shorts verticales con subtítulos grabados
limpieza.js    qué se puede borrar con el episodio hecho
recipes/       ejemplos
tests/sesion-falsa.js   genera una sesión de prueba con desfases y turnos conocidos (y caídas)
```

Las pruebas están en `tests/` de esta carpeta: `kdenlive.test.js`, `auto.test.js`,
`cortes.test.js`, `episodio.test.js`, `llamadas.test.js`, `receta.test.js`, `revision.test.js`, `avisos.test.js`,
`youtube.test.js`, `camaras.test.js`, `rotulos.test.js`, `shorts.test.js` y `limpieza.test.js`.
