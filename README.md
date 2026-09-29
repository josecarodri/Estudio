# Estudio — grabación local de llamadas a dos (estilo Riverside)

Haz una videollamada entre **un PC y un iPad** y graba en cada dispositivo, **en local y en alta calidad**, su propia
cámara y su propio micrófono (sin la compresión ni los cortes de la llamada). Al mismo tiempo se graba **la llamada**
como referencia. Todo se sube al PC mientras grabas y queda listo para sincronizar en tu editor de vídeo.

## Qué se graba

Por cada persona, en `grabaciones/<sala>/<fecha_hora>/`:

| Archivo | Qué es |
|---|---|
| `ana_camara.mp4` / `.webm` | Cámara + micrófono **del propio dispositivo**, hasta 1080p/4K (5–35 Mbps). Es la pista buena para editar. |
| `ana_audio.wav` | Micrófono **sin pérdida** (WAV PCM 16 bits, 48 kHz), empezando en la muestra exacta. |
| `ana_llamada.mp4` / `.webm` | La llamada tal como se vio: las dos cámaras lado a lado (720p) + el audio de ambos. Referencia opcional. |
| `session.json` | Tiempos de inicio de cada pista (reloj común) y datos para sincronizar. |

El iPad (Safari) graba en MP4 H.264/AAC; Chrome/Edge en el PC graba en MP4 si puede y si no en WebM.

## Cómo se sincroniza

1. **Reloj común**: ambos dispositivos miden su desfase con el reloj del servidor (±1–10 ms en wifi) y empiezan a grabar
   a la misma hora programada, con cuenta atrás de 3 s.
2. **Claqueta digital**: 1 s después del inicio se inserta un **pitido de 1 kHz** directamente en todas las grabaciones
   (no se oye por los altavoces ni pasa por la llamada), exactamente a la misma hora en los dos dispositivos. En pantalla
   verás un destello blanco en ese momento.
3. **Alineado automático**: `npm run alinear` busca el pitido en cada archivo y genera en `alineados/` versiones que
   empiezan en el mismo instante, con la misma duración, vídeo H.264 a **30 fps constantes** (los editores lo agradecen:
   las grabaciones del navegador son de fotogramas variables) y audio a 48 kHz. En las pruebas, todas las pistas quedan
   alineadas con menos de 1 ms de diferencia.

Sin `ffmpeg` también puedes alinear a mano en Premiere / DaVinci Resolve / Final Cut: busca el pitido del primer segundo
en la forma de onda de cada pista (o usa «sincronizar por audio»), o desplaza cada pista lo que indica la página
**Grabaciones**.

## Requisitos

- Un PC (Windows, Mac o Linux) con **Node.js 18 o superior** — https://nodejs.org
- Chrome o Edge en el PC; Safari en el iPad (iPadOS 16.4 o superior recomendado).
- Opcional, para `npm run alinear`: **ffmpeg** (`winget install ffmpeg` en Windows, `brew install ffmpeg` en Mac).
- Para la mejor calidad de audio: **auriculares** en los dos lados.

## Uso (PC e iPad en la misma wifi)

```bash
cd estudio
npm install
npm start
```

El servidor muestra algo así:

```
En este PC:          http://localhost:8080
iPad (misma wifi):   https://192.168.1.34:8443
```

1. **En el PC** abre `http://localhost:8080`, escribe tu nombre, deja la sala que sale y pulsa **Entrar**.
2. **En el iPad** abre en Safari el **enlace de invitación** que aparece arriba en el estudio del PC
   (`https://<IP-del-PC>:8443/?sala=…`; envíatelo por AirDrop, WhatsApp o escríbelo). Como el certificado es autofirmado, Safari avisa:
   pulsa **Mostrar detalles → visitar este sitio web → Visitar**. Pon tu nombre, comprueba que la sala es la misma y
   pulsa **Entrar**. Permite cámara y micrófono.
3. Cualquiera de los dos pulsa **● Grabar**. Cuenta atrás, destello, y a grabar.
4. **■ Detener** para los dos. Espera a que en *Archivos de este dispositivo* ponga **✓ Guardado en el servidor**
   (en ambos; el PC muestra también el progreso del iPad).
5. Abre **Grabaciones** (arriba a la derecha) para descargar, o ve a la carpeta `grabaciones/`.
6. Opcional: `npm run alinear` → archivos listos para el editor en `grabaciones/<sala>/<sesión>/alineados/`.

> Si el PC tiene cortafuegos, permite a Node.js conexiones en red privada (Windows lo pregunta la primera vez).

### Si la otra persona está en otro sitio (por internet)

La cámara del navegador exige HTTPS. La forma más sencilla es un túnel gratuito de Cloudflare:

```bash
cloudflared tunnel --url http://localhost:8080
```

Comparte la dirección `https://….trycloudflare.com` que aparece (ábrela tú también en el PC). La llamada usa STUN de
Google; si alguna red es muy restrictiva y no conecta, configura un servidor TURN con las variables `TURN_URL`,
`TURN_USER` y `TURN_PASS`.

## Consejos para una buena grabación

- **iPad**: conéctalo al cargador, activa *No molestar*, y **no salgas de Safari ni bloquees la pantalla** mientras
  grabas (iPadOS pausa la cámara en segundo plano). La app mantiene la pantalla encendida mientras graba.
- Marca **«Uso auriculares»** si ambos lleváis auriculares: se desactivan la cancelación de eco y la reducción de ruido
  y el audio suena más natural. Sin auriculares, déjalo desmarcado para evitar eco.
- La **grabación de la llamada** viene activada por defecto en el PC y desactivada en el iPad para no cargarlo.
- Haz una prueba corta antes de la grabación real.

## Resistencia a fallos

- Cada segundo de grabación se guarda primero **en el propio dispositivo** (IndexedDB) y después se sube en orden.
  Si la wifi se corta, la grabación continúa y la subida se reanuda sola al volver la conexión.
- Si se cierra la pestaña a mitad de la subida, al volver a abrir el estudio aparece **«Grabaciones sin terminar de
  subir»** con opciones para subirlas, descargarlas o borrarlas.
- Tras grabar, cada pista tiene un botón **Descargar copia** que la reconstruye desde el dispositivo.
- Si el servidor se reinicia, las pistas continúan donde se quedaron.

## Estructura

```
server.js              Servidor: web, señalización (SSE), reloj común, recepción de grabaciones, HTTPS
lib/core.js            Utilidades (WAV, nombres, orden de trozos)
lib/beep.js            Detección del pitido de sincronía (Goertzel)
public/index.html      Estudio (preparación + llamada + grabación)
public/grabaciones.html Lista de sesiones, descargas y desfases
public/js/app.js       WebRTC, grabadores, claqueta, interfaz
public/js/uploader.js  Guardado local + subida en orden con reintentos
public/js/clock.js     Sincronización de reloj con el servidor
public/js/pcm-worklet.js Captura de audio WAV con inicio exacto
tools/alinear.js       Alineado y conversión con ffmpeg
tests/                 Pruebas (npm test)
```

Variables de entorno: `PORT` (8080), `HTTPS_PORT` (8443), `GRABACIONES_DIR`, `TURN_URL`, `TURN_USER`, `TURN_PASS`.
