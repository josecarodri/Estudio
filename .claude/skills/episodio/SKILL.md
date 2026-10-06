---
name: episodio
description: Edita un episodio del podcast «Dos Tipos Promedio» (JC/José y DJ/Douglas) desde las grabaciones del Estudio hasta el vídeo final para YouTube. Úsalo cuando se hable de editar, montar, cortar, renderizar o revisar un episodio, de sus cortes, del audio o del color, o de grabaciones del Estudio (dj_camara, jc_audio, jc_llamada, jc-2…).
---

# Editar un episodio (proceso fijo)

**No redescubras nada de esto. Léelo, ejecútalo, y piensa solo en lo que está marcado como «decide el usuario».**
Todo se ejecuta desde `C:\Users\Carlos\Estudio\edicion` con `node cli.js …` (el editor vive en el repo del Estudio, junto a la grabación). Estado y detalles: `ESTADO.md` y `README.md` de esa carpeta.

## Rutas fijas
- Episodios: `D:\Datos\Videos\Dos Tipos Promedio Podcast\Episodios\AAAA-MM-DD\{originales, montaje, entrega}`.
- **Hay dos `episodio.json`.** El de `Episodios\` es **del equipo** (retardo, niveles, color, silencios, codificador; ya trae los valores buenos, no hace falta tocarlo). El de cada `Episodios\AAAA-MM-DD\` es **de ese episodio**: `cortes`, `partes`, `limpiezas`, `mantenerPlano`, `insertar`, `alFinal`. Lo de un episodio puesto en la raíz no se aplica (y se avisa). `node cli.js config <carpeta>` enseña qué vale cada ajuste y de qué archivo sale.
- Grabaciones: `C:\Users\Carlos\Estudio\grabaciones\<sala>\<sesión>\` (la carpeta del propio repo), cada sesión con su `session.json`. `importar` las coge de ahí: no hace falta descargar nada.
- Whisper: `D:\Datos\Herramientas\whisper`. RNNoise: `D:\Datos\Herramientas\rnnoise`.

## Pasos (en este orden)
1. `node cli.js episodio nuevo` → crea la carpeta de hoy con su `episodio.json`. `node cli.js importar` → lista las sesiones del Estudio de las últimas 36 h, de la más antigua a la más reciente: **cada sesión es una parte**. Avisa de pistas sin terminar de subir y de sesiones de menos de 2 min («¿una prueba?»): si sobra alguna, pregunta y elige con `--sesiones <id>,<id>`. Después `node cli.js importar --copiar` (cada sesión a `originales/<sesión>/`; `--mover` las quita del Estudio).
2. **`node cli.js analizar <carpeta>`** (en segundo plano: transcribe, ≈10 min por hora de audio; usa `estado` para ver cómo va). Escribe `montaje/propuesta.md`: **léelo, no leas las transcripciones enteras** (son ~35 000 tokens y casi todo es contenido). Incluye lo marcado en vivo al grabar: los tramos ✂ salen como propuestas (se aprueban como las demás); los ★ (momentos buenos) y los ✂ sin tramo, en listas aparte con lo que se dijo justo antes.
3. Enséñale al usuario la propuesta en pocas líneas. `node cli.js aprobar <carpeta> 1.1 2.1` pasa las que acepte al `episodio.json` del episodio.
4. **Decide el usuario** (pregunta, no supongas): qué sobra del contenido (tangentes, partes flojas, preguntas que no funcionaron), si se corta el llanto u otra cosa, el cierre/despedida. Para cortar por contenido usa **cortes por texto** en el `episodio.json` del episodio (`{"desde":"frase","hasta":"frase"}`, se ajustan solos al silencio) en lugar de calcular tiempos a mano. Para dudas de contenido, busca la frase con `grep` en `montaje/transcripcion-parte-N.txt`.
5. `node cli.js episodio <carpeta> --solo-montaje` → deja el proyecto `.kdenlive` (sin renderizar). Cambiar cortes después no repite el análisis largo (la huella lo evita) y tarda segundos.
   Luego **`node cli.js revision <carpeta>`** (en segundo plano: unos minutos la primera vez, segundos si no cambió nada): deja `montaje/revision.mp4` (480p: un trozo numerado por empalme, más el principio y el final, con una barra roja en el corte) y `montaje/revision.md` (la lista). **Mándale el vídeo** (si puedes enviar archivos, envíalo; si no, dile dónde está) con la lista resumida: lo revisa en el móvil y contesta «todo bien» o «el 4 no». Los silencios recortados no salen (son automáticos); `--silencios` los añade. Si prefiere Kdenlive, el proyecto lleva una guía morada en cada empalme («✂ motivo (−N s)»), verdes los ★ y rojos los ✂ en vivo que no se cortaron.
   Si el usuario retoca y **guarda** el proyecto en Kdenlive, el siguiente `episodio` se para (código 4) en vez de pisar sus cambios. Pregúntale: `--reanudar --usar-proyecto` renderiza ese proyecto tal cual; `--descartar-cambios` lo rehace desde la receta (guarda copia). Lo que deba repetirse va mejor en `episodio.json`.
6. Solo con el visto bueno: `node cli.js episodio <carpeta> --reanudar` (renderiza + acabado + **verificación automática**). Tarda 2-3 h para 90 min. El PC no se duerme mientras tanto y al terminar avisa (ver «Avisos»). Mira el avance con `node cli.js estado <carpeta>` (una línea); **no uses vigilantes largos**, caducan.
7. `node cli.js verificar <carpeta>` si hace falta repetir la comprobación. Debe dar todo ✔.

## Ya decidido (no preguntar)
- Sonido: −14 LUFS, limpieza suave. Los micros se igualan a −16 LUFS. El micro de DJ suele ser bajo (+18 dB): revisar ruido solo si el usuario lo dice.
- Color: **suave** (activo por defecto). Probado y rechazado: una versión más fuerte «se ve muy rara».
- Un solo vídeo por episodio, **una sola despedida**. Se quita lo de «se perdió la conexión», «lo cortamos», «esto lo vas a cortar», el llanto de la niña de JC y el inicio sin luz de DJ.
- Retardo de audio: sin ajuste (`dj=0,jc=0`). `calibrar` NO es fiable entre sesiones; no lo uses para decidir.
- Inicio y fin: `auto` (voz tras el pitido de inicio; última voz antes del pitido de cierre). Sin pitido de cierre = grabación cortada: se termina donde acabe. Sin pitido de inicio (la página que graba la llamada empezó tarde) no se recorta el principio: propón un `desde` para esa parte.
- Silencios de 4 s o más: se dejan en 1 s, **solo si los micros también callan**. Si la llamada perdió el audio de alguien, ese tramo no se corta (lo dice al montar).
- El llamado a seguir en plataformas va en la descripción de YouTube, no en el vídeo.
- Antes de renderizar de verdad: **siempre** el visto bueno del usuario, con el vídeo de revisión o en Kdenlive. Cada render cuesta más de una hora.
- Saltos de imagen: si en un empalme se vería a la misma persona a los dos lados (un corte o un silencio recortado en mitad de su plano, o la unión de dos partes), `episodio` pone 1,5 s la cámara del otro justo después, en sincronía, y no deja planos de un instante junto a un corte (`disimularCortes`, lo dice al montar). Respeta los `mantenerPlano`. No hace falta tocar nada.
- Acabado con x264 `medium` (1,7 veces más rápido que `slow`, +2 % de tamaño). `"codificador": "nvenc"` en el `episodio.json` del equipo usa la tarjeta gráfica (si falla, repite solo con x264): sin probar en este PC; propónlo solo si el acabado se hace largo.

## Caídas y tramos retomados
- Si una página del Estudio se cae y se retoma, salen `jc-2_camara`/`jc-2_audio` (y `jc-2_llamada` si era la que grababa la llamada: la del PC). `episodio` lo junta solo: `jc-2` es la misma persona que `jc`, y la llamada partida se une en `montaje/parte-N/llamada-unida.wav`, que es **el reloj de la parte** para cortes, limpiezas y transcripción. El hueco sale en la propuesta como «se cayó la página que grababa la llamada».
- `audioOffset`, `limpiezas` y `mantenerPlano` de `jc` valen también para `jc-2`. Las `limpiezas` van en segundos de la llamada, como los cortes.
- Probado solo con material sintético: en el primer caso real, que el usuario revise en Kdenlive el empalme jc → jc-2 y el labial de jc-2 antes de renderizar.
- Pistas con `tarde` en `session.json` (esa página perdió la orden de grabar y empezó sola unos segundos después): no llevan pitido de inicio y se sincronizan por la voz. No hay que hacer nada.

## Al grabar (el Estudio: `server.js` y `public/` en la raíz de este repo)
- Mejor el enlace fijo (Tailscale) que el de Cloudflare.
- Mientras se graba, sobre la imagen del otro debe verse «● REC». «⚠ NO ESTÁ GRABANDO» que no se corrige solo en unos segundos: esa persona recarga la página y vuelve a grabar (sale como tramo retomado).
- No cerrar nada hasta que las dos páginas pongan «✓ Guardado en el servidor».
- **Marcas en vivo**: mientras se graba, ✂ (tecla C en el PC) abre un tramo para cortar y la siguiente pulsación, de cualquiera de los dos, lo cierra (si nadie lo cierra, se cierra al parar); ★ (tecla B) marca un buen momento, lo de justo antes. Quedan en `session.json` y `analizar` las convierte en propuestas. Recuérdaselo al usuario si va a grabar.

## Avisos
- Lo largo (`episodio`, `analizar`, `transcribir`, `revision`, `render`) mantiene el PC despierto mientras corre y, si tardó más de un minuto, avisa al terminar o al fallar: notificación de Windows y, si en el `episodio.json` del equipo hay `"avisos": { "ntfy": "<tema>" }`, también en el móvil (app gratuita ntfy suscrita a ese tema). El tema hace de contraseña: que sea difícil de adivinar (`dtp-` y letras al azar). Si el usuario quiere el aviso en el móvil, propón el tema y ponlo tú en la configuración del equipo.

## Trampas conocidas
- **Whisper desfasa hasta ~0,5 s** el final de las frases y transcribe el pitido de inicio como «Bienvenidos». Para cortes finos usa la energía del audio (ya lo hace `ajustarASilencio`).
- Kdenlive no recarga un proyecto abierto: pide **cerrar sin guardar y reabrir** el `.kdenlive` o verá una versión vieja.
- VLC puede mostrar el audio atrasado en un archivo que está bien: comprobar en otro reproductor antes de tocar nada.
- Archivos de Descargas (`importar --descargas`): los nuevos llevan la sesión delante (`2026-10-10_21-30-05_dj_camara.mp4`) y se agrupan bien; los antiguos, con `(1)`, `(2)` del navegador, **no dicen de qué sesión son**: `episodio` avisa y hay que comprobar el orden.
- Al escribir código/scripts: en este entorno **se pierden las barras invertidas** en heredocs de bash y en algunos `Write`. Para regex y `\n` usa la herramienta `Edit`.
- Cada confirmación pendiente del usuario: si responde con otra cosa, no asumas el resto.

## Ahorra esfuerzo
- Resume, no vuelques: tablas cortas, tiempos en `mm:ss`, qué cambió y qué debe mirar.
- No releas transcripciones, `session.json` ni logs largos: usa `analizar`, `verificar`, `estado`, `config` y `grep` puntual.
- Si surge algo nuevo y reutilizable, **déjalo en el código o en `ESTADO.md`**, no solo en la conversación.
