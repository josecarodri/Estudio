# Estudio — grabación local de llamadas a dos (estilo Riverside)

Haz una videollamada entre **un PC y un iPad** —en la misma casa o **en ciudades distintas, con wifis distintas**— y
graba en cada dispositivo, **en local y en alta calidad**, su propia cámara y su propio micrófono (sin la compresión ni
los cortes de la llamada). Al mismo tiempo se graba **la llamada** como referencia. Todo se sube al PC mientras grabas y
queda listo para sincronizar en tu editor de vídeo.

## Cómo funciona

```
   Ciudad A (PC, anfitrión)                                  Ciudad B (iPad, invitado)
 ┌──────────────────────────┐                             ┌──────────────────────────┐
 │ servidor Estudio         │◄── enlace https público ────│ Safari                   │
 │  · guarda grabaciones    │    (túnel de Cloudflare)    │  · graba cámara + micro  │
 │ Chrome                   │     señalización, reloj,    │    en local, alta calidad│
 │  · graba cámara + micro  │     subida de archivos      │  · lo sube por trozos    │
 └──────────────────────────┘                             └──────────────────────────┘
              ▲                    videollamada (WebRTC)                ▲
              └──────────── directa, o por TURN si las redes lo bloquean┘
```

El **PC hace de estudio**: ejecuta un pequeño servidor que guarda los archivos de los dos. Con `npm run internet` crea
automáticamente un **enlace https público** (gratis, sin cuenta, mediante Cloudflare) que la otra persona abre desde
cualquier lugar. La calidad de la llamada no afecta a la grabación: cada dispositivo graba lo suyo en local y lo sube
aparte, aunque su conexión sea lenta.

## Qué se graba

Por cada persona, en `grabaciones/<sala>/<fecha_hora>/` del PC:

| Archivo | Qué es |
|---|---|
| `ana_camara.mp4` / `.webm` | Cámara + micrófono **del propio dispositivo**, hasta 1080p/4K (5–35 Mbps). Es la pista buena para editar. |
| `ana_audio.wav` | Micrófono **sin pérdida** (WAV PCM 16 bits, 48 kHz), empezando en la muestra exacta. |
| `ana_llamada.mp4` / `.webm` | La llamada tal como se vio: las dos cámaras lado a lado (720p) + el audio de ambos. Referencia opcional. |
| `session.json` | Tiempos de cada pista en el reloj común y datos para sincronizar. |

El iPad (Safari) graba en MP4 H.264/AAC; Chrome/Edge en el PC graba en MP4 si puede y si no en WebM.

> **¿Usas Windows?** Sigue la guía paso a paso [INSTALAR-WINDOWS.md](INSTALAR-WINDOWS.md): se instala y se
> arranca con doble clic, sin escribir comandos.

## Requisitos

- **En el PC (anfitrión):** Windows, Mac o Linux con **Node.js 18 o superior** (https://nodejs.org) y Chrome o Edge.
- **En el iPad (invitado):** Safari, iPadOS 16.4 o superior recomendado. No hay que instalar nada.
- Opcional, para `npm run alinear`: **ffmpeg** (`winget install Gyan.FFmpeg` en Windows, `brew install ffmpeg` en Mac).
- Para la mejor calidad de audio: **auriculares** en los dos lados.
- Conexión: para 1080p conviene que el invitado tenga **≥ 12 Mbps de subida**. Si tiene menos no se pierde nada: lo
  que no da tiempo a subir se guarda en su iPad y se termina de subir al acabar (o elige 720p).

## Uso desde ciudades distintas (por internet)

En el PC, la primera vez:

```bash
cd estudio
npm install
```

Cada vez que vayas a grabar:

```bash
npm run internet
```

Aparece algo así:

```
   En este PC:          http://localhost:8080
   ┌───────────────────────────────────────────────────┐
   │  🌍  https://palabras-al-azar.trycloudflare.com  │
   └───────────────────────────────────────────────────┘
```

1. **En el PC** abre `http://localhost:8080`, escribe tu nombre y pulsa **Entrar**.
2. Pulsa **Copiar enlace** (arriba) y envíaselo a la otra persona por WhatsApp, correo…; ya lleva el enlace público y
   la sala. El enlace cambia cada vez que arrancas `npm run internet`.
3. **En el iPad** la otra persona abre el enlace en Safari, pone su nombre, pulsa **Entrar** y permite cámara y micrófono.
4. Arriba verás **«sincronía ±N ms»** y **«llamada directa»** o **«llamada vía TURN»**.
5. Cualquiera de los dos pulsa **● Grabar**: cuenta atrás, destello, y a grabar.
6. **■ Detener** para los dos. Espera a que en *Archivos de este dispositivo* ponga **✓ Guardado en el servidor** en
   ambos (el PC muestra también el progreso del iPad). **El invitado no debe cerrar Safari hasta entonces.**
7. Abre **Grabaciones** (arriba a la derecha) o la carpeta `grabaciones/`. Opcional: `npm run alinear`.

> El PC tiene que estar encendido y con `npm run internet` en marcha durante toda la sesión (y hasta que termine la
> subida). No hace falta abrir puertos en el router.

### Si la llamada no conecta (servidor TURN)

Entre la mayoría de redes la llamada va directa. Algunas (datos móviles, redes de empresa o universidad, ciertos
routers) lo impiden; entonces el estudio avisa de que la llamada no conecta. **La grabación funciona igualmente**, pero
para verse y oírse hace falta un servidor TURN que retransmita la llamada. La opción más sencilla y gratuita
(1000 GB al mes) es **Cloudflare Realtime TURN**:

1. Crea una cuenta gratuita en https://dash.cloudflare.com → **Realtime** → **TURN Server** → *Create*.
2. Copia `.env.ejemplo` como `.env` (en la carpeta `estudio`) y pega el **Turn Token ID** y el **API Token**:
   ```
   CLOUDFLARE_TURN_KEY_ID=...
   CLOUDFLARE_TURN_API_TOKEN=...
   ```
3. Reinicia `npm run internet`. Al arrancar debe decir `TURN: configurado ✓`.
   Puedes comprobarlo antes con `npm run probar-turn`. En Windows, el doble clic en
   `Configurar TURN (Windows).bat` hace los pasos 2 y la comprobación por ti.

También sirve cualquier otro TURN (coturn propio, Metered, Twilio…) con `TURN_URL`, `TURN_USER` y `TURN_PASS`.
Recomendado configurarlo antes de una grabación importante.

### ¿Prefieres una dirección fija? (Tailscale Funnel)

Con `PUBLICO=tailscale` en `.env` (o `node server.js --tailscale`) el estudio se publica con **Tailscale Funnel** en
`https://<tu-pc>.<tu-red>.ts.net`, siempre la misma dirección. Requiere Tailscale instalado en el PC con sesión
iniciada; la primera vez pide activar Funnel en el navegador. Ver [INSTALAR-WINDOWS.md](INSTALAR-WINDOWS.md#8-opcional-enlace-fijo-con-tailscale-funnel).
El enlace solo responde mientras el estudio está abierto.

Otra opción: un túnel con nombre de Cloudflare o ngrok hacia `http://localhost:8090` y `PUBLIC_URL=https://…` en `.env`.

### Seguridad del enlace público

Los túneles apuntan a un puerto interno (8090, solo accesible desde el propio PC) que **exige la clave secreta** del
enlace de invitación (`&k=…`, guardada en `.env` como `CLAVE_ACCESO`) y **no da acceso a las grabaciones**: estas solo
se ven desde `http://localhost:8080` en el PC del estudio.

## Uso en la misma wifi

`npm start` y abre en el PC `http://localhost:8080`. El enlace de invitación apuntará a `https://<IP-del-PC>:8443`.
Como el certificado es autofirmado, Safari avisa: **Mostrar detalles → visitar este sitio web → Visitar**. Si el PC
tiene cortafuegos, permite a Node.js conexiones en red privada.

## Cómo se sincroniza

1. **Reloj común**: ambos dispositivos miden continuamente su desfase con el reloj del PC y usan la medida más rápida
   del último minuto. El invitado además afina su reloj **directamente con el PC anfitrión** por la conexión de la
   llamada, que suele ser más rápida que pasar por el túnel. Así ambos empiezan a grabar a la misma hora programada.
2. **Claqueta digital**: 1 s después del inicio se inserta un **pitido de 1 kHz** directamente en todas las grabaciones
   (no se oye por los altavoces ni pasa por la llamada), a la misma hora en los dos dispositivos. Al detener hay un
   **segundo pitido**, 1 s antes del final. En pantalla verás un destello en cada uno.
3. **Alineado automático** (`npm run alinear`): busca los pitidos en cada archivo y genera en `alineados/` versiones que
   empiezan en el mismo instante, con la misma duración, vídeo H.264 a **30 fps constantes** y audio a 48 kHz, con los
   pitidos silenciados, y con dos personas una vista **`lado_a_lado.mp4`** (las dos cámaras juntas, para usar como tercer ángulo en un multicámara). Con el pitido final **corrige la deriva**: los relojes de dos dispositivos distintos nunca van
   exactamente a la misma velocidad y en una hora pueden separarse decenas de milisegundos; el alineado estira o encoge
   cada pista para compensarlo.

En las pruebas, con 120 ms de latencia simulada entre los dos, el inicio queda alineado con menos de 1 ms de
diferencia; con una deriva exagerada de ±300 ppm (18 ms por minuto), tras corregirla quedan a ±1,5 ms.

Sin `ffmpeg` también puedes alinear a mano en Premiere / DaVinci Resolve / Final Cut: busca el pitido del primer segundo
en la forma de onda de cada pista (o usa «sincronizar por audio»).

## Consejos para una buena grabación

- **iPad**: conéctalo al cargador, activa *No molestar*, y **no salgas de Safari ni bloquees la pantalla** mientras
  grabas ni mientras sube (iPadOS pausa la cámara y la red en segundo plano). La app mantiene la pantalla encendida.
- Marca **«Uso auriculares»** si ambos lleváis auriculares: se desactivan la cancelación de eco y la reducción de ruido
  y el audio suena más natural. Sin auriculares, déjalo desmarcado para evitar eco.
- La **grabación de la llamada** viene activada por defecto en el PC y desactivada en el iPad para no cargarlo.
- Haz una prueba corta con la otra persona antes de la grabación real.

## Resistencia a fallos

- Cada segundo de grabación se guarda primero **en el propio dispositivo** (IndexedDB) y después se sube en orden.
  Si internet se corta, la grabación continúa y la subida se reanuda sola al volver la conexión.
- Si se cae la conexión con la sala (un parpadeo del wifi, de la red del iPad o del túnel), la otra persona **no cuelga
  la llamada**: se le da un **periodo de gracia de 45 s** para volver. Si vuelve con la misma página, la llamada
  (vídeo y audio, que van por otro camino) sigue como estaba, sin imagen congelada. Solo se rehace si la llamada
  murió de verdad o si la persona vuelve con una página nueva (p. ej. tras recargar). Un cierre a propósito de la
  pestaña apenas espera.
- **Si la página se cierra o falla en plena grabación** (p. ej. un fallo del navegador), la otra persona **sigue
  grabando** sin tocar nada. Al volver a abrir el estudio (en los siguientes 15 min) aparece un aviso grande:
  **«La página se cerró mientras se grababa — Volver a entrar y seguir grabando»**. Con un clic entra en la sala y
  **empieza a grabar al instante**, como un **tramo nuevo de la misma grabación**: sin cuenta atrás, sin pitido ni
  destello (sonarían en mitad de la conversación) y con archivos propios (`jc-2_camara.mp4`, `jc-2_audio.wav`…).
  En `session.json` esa persona figura con `retomada: true` y `retomaDe: "jc"`. Hace falta el clic porque los
  navegadores no dejan arrancar el audio sin un gesto del usuario. La parte que se grabó antes de la caída se conserva
  (hasta el último trozo subido). Para sincronizar el tramo nuevo no hay pitido de inicio: se alinea con la grabación
  de la llamada y con la hora de inicio de cada pista.
- Si se cierra la pestaña a mitad de la subida, al volver a abrir el estudio aparece **«Grabaciones sin terminar de
  subir»** con opciones para subirlas, descargarlas o borrarlas.
- Tras grabar, cada pista tiene un botón **Descargar copia** que la reconstruye desde el dispositivo.
- Si el servidor se reinicia, las pistas continúan donde se quedaron (con `npm run internet` el enlace cambia: el
  invitado debe abrir el nuevo para terminar de subir).

## Si algo falla: el registro

El estudio anota lo que ocurre en `logs/estudio-AAAA-MM-DD.log` (un archivo por día, texto plano). El servidor y las
páginas de cada persona escriben ahí, con la hora:

```
21:36:41.003 cliente:jc latido grabando=si grabadores=recording+recording+... llamada=connected memoria_mb=212
21:36:50.412 servidor ws-cerrado sala=dtp peer=ce00… nombre=JC codigo=1006 conectado_s=3512
21:36:50.413 servidor peer-ausente sala=dtp peer=ce00… nombre=JC gracia_s=45
```

- **`latido`**: cada 30 s, el estado de cada página (grabando, estado de la llamada, memoria, subidas pendientes). Si una
  página muere de golpe, el **último latido** dice cuándo y cómo estaba.
- **`ws-cerrado` / `peer-ausente` / `ws-reconectado` / `peer-salio`**: la conexión con la sala, con el código de cierre
  (`1006` = corte sin aviso, que es lo típico de un fallo de red o de que el navegador se cierre de golpe).
- **`error`**: errores de la página, del grabador o de la cámara.
- Al avisar de un problema, **guarda ese archivo** (y, en Windows, mira si Edge o Chrome dejaron un informe en
  `%LOCALAPPDATA%\Microsoft\Edge\User Data\Crashpad\reports`).

Ajustes opcionales en `.env`: `GRACIA_MS` (45000), `PINGS_SIN_RESPUESTA` (3 pings de 15 s) y `LOGS_DIR`.

## Estructura

```
server.js                Servidor: web, sala por WebSocket, reloj común, recepción de grabaciones, TURN, túnel
lib/core.js              Utilidades (WAV, nombres, orden de trozos)
lib/beep.js              Detección de los pitidos de sincronía (Goertzel)
lib/env.js               Lectura de .env
public/index.html        Estudio (preparación + llamada + grabación)
public/grabaciones.html  Lista de sesiones y descargas
public/js/app.js         WebRTC, grabadores, claqueta, interfaz
public/js/uploader.js    Guardado local + subida en orden con reintentos
public/js/clock.js       Reloj común
public/js/pcm-worklet.js Captura de audio WAV con inicio exacto
tools/alinear.js         Alineado, corrección de deriva y conversión con ffmpeg
tests/                   Pruebas (npm test)
```

Variables (en `.env` o en el entorno): `PORT` (8080), `HTTPS_PORT` (8443), `GRABACIONES_DIR`, `PUBLIC_URL`, `PUBLICO` (`cloudflare`/`tailscale`), `CLAVE_ACCESO`, `PUBLIC_PORT` (8090),
`CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN`, `TURN_URL`, `TURN_USER`, `TURN_PASS`.
