# Instalar Estudio en Windows, paso a paso

Solo hay que instalarlo en **el PC que hace de estudio**. La otra persona (con el iPad) no instala nada: abre un enlace
en Safari.

## 1. Instalar Node.js (una sola vez)

1. Entra en https://nodejs.org/es/download y descarga el instalador **LTS** para Windows (archivo `.msi`).
2. Ábrelo y pulsa **Siguiente** en todas las pantallas, dejando las opciones que vienen marcadas.
3. Cuando termine, **reinicia el PC** (o al menos cierra y vuelve a abrir la sesión) para que Windows lo reconozca.

> Alternativa rápida: abre **PowerShell** (tecla Windows → escribe «PowerShell» → Intro) y escribe
> `winget install OpenJS.NodeJS.LTS`.

## 2. Descargar Estudio

1. Entra en https://github.com/josecarodri/Personal con tu cuenta de GitHub.
2. Comprueba que arriba a la izquierda, en el botón de la rama, pone **`main`** (si no, elígela ahí).
3. Pulsa el botón verde **Code → Download ZIP**.
4. Antes de descomprimir: clic derecho sobre el ZIP → **Propiedades** → marca **Desbloquear** (abajo) → **Aceptar**.
   Así Windows no bloqueará los archivos de doble clic.
5. Clic derecho → **Extraer todo…** y elige una carpeta cómoda, por ejemplo `Documentos`.
6. Entra en la carpeta extraída y después en **`estudio`**. Todo lo demás se hace desde ahí.

## 3. Instalar (una sola vez)

Doble clic en **`Instalar (Windows).bat`**.

- Se abre una ventana negra que descarga lo necesario (1–2 minutos). Al final pone **«Listo»**; pulsa una tecla.
- Si Windows muestra **«Windows protegió su PC»**: pulsa **Más información → Ejecutar de todas formas**.
- Si dice que no encuentra Node.js, vuelve al paso 1 (y reinicia el PC).

## 3b. Crear el icono «Estudio» en el escritorio (una sola vez)

Doble clic en **`Crear acceso directo (Windows).bat`**. Aparece un icono **Estudio** (un punto rojo) en el escritorio y
en el menú Inicio. Desde entonces, para grabar basta con abrir ese icono.

Si mueves la carpeta del programa a otro sitio, vuelve a ejecutar este archivo.

## 4. Grabar con alguien en otra ciudad

1. Doble clic en el icono **Estudio** del escritorio (o en **`Estudio por internet (Windows).bat`**).
2. La primera vez, Windows pregunta si permites a **Node.js** acceder a la red: marca **Redes privadas** y pulsa
   **Permitir**.
3. Se abre el navegador con el estudio. En la ventana negra aparece un recuadro con el enlace público
   (`https://….trycloudflare.com`).
4. En el navegador pulsa **Entrar** (tu nombre y la sala se recuerdan). El **enlace de invitación se copia solo** al
   portapapeles: pégalo (Ctrl+V) en WhatsApp o en un correo para la otra persona. Ella lo abre en **Safari** en el
   iPad, pone su nombre y pulsa **Entrar**.
5. Pulsa **● Grabar**. Al terminar, **■ Detener** y esperad a que los dos pongan **✓ Guardado en el servidor**.

> **No cierres la ventana negra** mientras grabáis ni hasta que termine la subida: es el estudio. Para apagarlo,
> ciérrala cuando acabéis. El enlace cambia cada vez que lo arrancas, así que envía el nuevo en cada sesión.

Si la otra persona está en tu misma casa o red, usa en su lugar **`Estudio misma wifi (Windows).bat`**.

## 5. Dónde están las grabaciones

En la carpeta **`estudio\grabaciones`**, una subcarpeta por sala y otra por cada grabación (fecha y hora).
También puedes verlas y descargarlas desde el enlace **Grabaciones** (arriba a la derecha en el estudio).

## 6. (Opcional) Alinear automáticamente para el editor

1. Instala **ffmpeg** una vez: abre **PowerShell** y escribe `winget install Gyan.FFmpeg` (acepta con `Y`).
   Cierra PowerShell cuando termine.
2. Doble clic en **`Alinear grabaciones (Windows).bat`**. Crea en cada grabación una carpeta **`alineados`** con los
   archivos ya sincronizados (MP4 a 30 fps y WAV), listos para Premiere, DaVinci Resolve, etc.

## 7. (Recomendado) Servidor TURN para que la llamada conecte siempre

Si alguna vez el estudio avisa de que **la llamada no conecta** (pasa con algunas redes de móvil, empresa o
universidad), la grabación sigue funcionando pero no os veis. Para evitarlo:

1. Crea una cuenta gratuita en https://dash.cloudflare.com (el plan gratuito de
   TURN incluye 1000 GB al mes, de sobra para vuestras llamadas).
2. En el menú de la izquierda entra en **Realtime** → **TURN Server**. La primera vez Cloudflare pide **suscribirse**
   con un método de pago (tarjeta o PayPal) aunque el total sea **$0.00**: solo cobra si pasas de 1000 GB al mes
   ($0.05 por GB extra). Una hora de llamada por TURN gasta del orden de 1–3 GB.
   Después pulsa **Create** (ponle un nombre, p. ej. «Estudio»).
3. Cloudflare te muestra dos valores: **Turn Token ID** y **API Token**. Cópialos en un lugar seguro: el API Token
   solo se muestra una vez (si lo pierdes, crea otra clave).
4. En la carpeta `estudio`, doble clic en **`Configurar TURN (Windows).bat`**, pega cada valor cuando lo pida
   (clic derecho en la ventana para pegar) y pulsa Intro. Al final comprueba la conexión con Cloudflare y debe poner
   **«✓ TURN configurado correctamente»**.
5. Vuelve a abrir el estudio. En la ventana negra debe poner **`TURN: configurado ✓`**.

Los valores se guardan en el archivo `estudio\.env`, que solo está en tu PC (no se sube a GitHub). No los compartas:
quien los tenga puede usar tu cuota de Cloudflare.

<details><summary>Hacerlo a mano en lugar del doble clic</summary>

Crea en la carpeta `estudio` un archivo llamado `.env` (con el Bloc de notas: **Guardar como** → Tipo **Todos los
archivos** → nombre `.env`) con estas dos líneas, sin espacios ni comillas:

```
CLOUDFLARE_TURN_KEY_ID=el-turn-token-id
CLOUDFLARE_TURN_API_TOKEN=el-api-token
```

Para comprobarlo: en esa carpeta, abre PowerShell y escribe `npm run probar-turn`.

Si usas otro servidor TURN (coturn propio, Metered, Twilio…), en su lugar pon `TURN_URL=turn:servidor:3478`,
`TURN_USER=…` y `TURN_PASS=…`.
</details>

## 8. (Opcional) Enlace fijo con Tailscale Funnel

Con Cloudflare el enlace cambia cada vez. Con **Tailscale Funnel** es **siempre el mismo**
(`https://<tu-pc>.<tu-red>.ts.net/?sala=…&k=…`), así que la otra persona puede guardarlo en la pantalla de inicio de
su iPad y entrar con un toque. Tailscale es gratuito para uso personal y solo hay que instalarlo en **tu PC**.

1. Descarga Tailscale de https://tailscale.com/download/windows, instálalo e **inicia sesión** (con Google, Microsoft,
   GitHub…). Debe quedar el icono de Tailscale junto al reloj, conectado.
2. En la carpeta `estudio`, doble clic en **`Elegir tipo de enlace (Windows).bat`** y pulsa **1** (fijo).
3. Abre el estudio con el icono **Estudio**. **Solo la primera vez**, Tailscale abre una página en el navegador para
   activar *Funnel* (y los certificados HTTPS): pulsa **Enable / Activar**. La ventana negra muestra entonces
   **«Dirección fija: https://….ts.net»**. El primer acceso desde fuera puede tardar hasta un minuto mientras
   Tailscale prepara el certificado.
4. Entra en el estudio: el enlace de invitación se copia solo, como siempre. Envíaselo una vez; a partir de ahí
   será siempre el mismo.

**En el iPad (la otra persona):** abre el enlace en Safari → botón **Compartir** (cuadrado con flecha) →
**Añadir a pantalla de inicio**. Aparece el icono **Estudio**; la próxima vez basta con tocarlo (con tu estudio abierto
en el PC).

Para volver al enlace de Cloudflare: `Elegir tipo de enlace (Windows).bat` → **2**.

### Seguridad del enlace público (Cloudflare o Tailscale)

- El enlace lleva una **clave secreta** (`&k=…`). Sin ella, el estudio muestra «Acceso restringido».
  Compártelo solo con quien vaya a grabar contigo.
- Las **grabaciones solo se pueden ver y descargar desde tu PC** (`http://localhost:8080`). Por el enlace público no
  se puede acceder a ellas, aunque se tenga la clave.
- El enlace solo funciona **mientras el estudio está abierto** en tu PC; al cerrar la ventana negra deja de responder.
- Si alguna vez enviaste el enlace a quien no debías: abre `.env` con el Bloc de notas, borra la línea
  `CLAVE_ACCESO=…` y vuelve a abrir el estudio. Se crea una clave nueva y los enlaces antiguos dejan de funcionar.

## Problemas frecuentes

| Qué pasa | Qué hacer |
|---|---|
| «No se encuentra Node.js» | Instala Node.js (paso 1) y reinicia el PC. |
| «El puerto 8080 está ocupado» | Ya tienes el estudio abierto en otra ventana negra: ciérrala y vuelve a empezar. |
| «No se pudo abrir el túnel» | Comprueba la conexión a internet; si tu antivirus bloquea `cloudflared`, permítelo. |
| El navegador no pide cámara | Abre siempre el estudio en el PC como `http://localhost:8080` (lo hace el doble clic). |
| La otra persona ve «sala llena» | Solo caben dos personas; cierra pestañas del estudio abiertas de más. |
| «No se pudieron obtener credenciales TURN» | Vuelve a ejecutar `Configurar TURN (Windows).bat` y pega bien los dos valores (o crea una clave nueva en Cloudflare). |
| La otra persona ve «Acceso restringido» | El enlace está incompleto: envíale de nuevo el enlace de invitación entero (termina en `&k=…`). |
| «Tailscale no está conectado» | Abre Tailscale (icono junto al reloj) e inicia sesión; luego vuelve a abrir el estudio. |
| La subida va lenta | Es normal con poca subida en el iPad: se guarda allí y termina al acabar. No cerréis Safari. |
