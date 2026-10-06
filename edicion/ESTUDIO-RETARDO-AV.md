# El retardo entre imagen y sonido del Estudio

> **Conclusión (2026-10): con el equipo del podcast no hay nada que corregir.** En el primer episodio
> (2026-10-03) el ajuste bueno, elegido a oído con clips cortos, fue **0 para los dos**. El «−140 ms» de abajo
> salió de una sesión de prueba mirada en VLC, que enseñaba el audio atrasado en un archivo que estaba bien.
> Además `calibrar` da valores distintos en cada sesión (jc: +13, −75 y +121 ms), así que no se ha portado nada a
> `alinear.js`. Esta nota se queda como explicación de por qué la claqueta no ve ese retardo, por si cambia el
> equipo y vuelve a hacer falta.

Notas para quien trabaje en la grabación (el servidor y la página, en la raíz de este repo). Escrito desde el lado
del editor (`edicion/`), tras
montar una grabación de prueba y perseguir un desfase de labial.

## El síntoma

En el montaje de una sesión de prueba, el audio iba **ligeramente atrasado** respecto a
la imagen. Buscando a mano, el valor que lo arreglaba era **−140 ms** para una de las dos
personas. Constante durante toda la grabación, no una deriva.

## Por qué la claqueta no lo ve

En `public/js/app.js` del Estudio:

```js
function scheduleBeep(atCtx) {
  const osc = state.ctx.createOscillator();
  ...
  osc.connect(g).connect(state.audio.recBus);   // <-- al bus de grabación
  osc.start(atCtx);
}
```

El pitido **se inyecta en el grafo de audio**, no sale por los altavoces. Eso lo hace
perfecto para lo que fue pensado —alinear entre sí las pistas de audio de los dos
participantes— y a la vez ciego para lo que nos ocupa: la cámara se captura por otro
camino, con su propia latencia, y el pitido no la toca.

Dicho de otro modo: el pitido marca el momento exacto del **audio**, y el audio y el
vídeo de un mismo archivo pueden estar desplazados entre sí. Como los dos se desplazan a
la vez, comparar archivos entre sí no lo detecta nunca. En la grabación de prueba, los
desfases entre archivos medidos por correlación daban entre −0,10 s y 0,00 s: la claqueta
estaba haciendo su trabajo. El problema estaba dentro de cada archivo.

## Lo que sí lo ve: el destello

`flash()` se dispara a la vez que el pitido y pone la pantalla blanca al 85 % durante
350 ms. Esa luz ilumina la cara y **queda grabada en el vídeo**. Con eso la claqueta está
en las dos pistas, y el retardo se puede medir.

Implementado y verificado en `edicion/calibrar.js`:

- el pitido se localiza con Goertzel, el mismo método que `lib/beep.js` del Estudio (a
  propósito: si los dos detectaran el tono de forma distinta darían tiempos distintos
  para el mismo pitido);
- el destello, por la **subida** de brillo. No vale el centro de la ráfaga: arranca a
  tope y se apaga, así que su centro cae muy por detrás del suceso;
- el retardo es la diferencia, y cambiado de signo es el ajuste que hay que aplicar.

```
node edicion/cli.js calibrar grabaciones/<sala>/<sesion>/jc_camara.mp4
```

Hay que ejecutarlo sobre los archivos **originales**: `alinear.js` quita el pitido salvo
con `--mantener-pitido`.

### Precisión

El pitido se sitúa por muestras. El destello solo se puede situar **al fotograma**, así
que queda una incertidumbre irreducible de medio fotograma: ±17 ms a 30 fps, ±8 a 60.
Comprobado con el destello cayendo en cuatro puntos distintos dentro del fotograma; el
error nunca se sale de ese margen.

## La corrección propuesta, en el Estudio

Hoy el editor lo corrige a posteriori con `--audio-offset`, que es un parche: hay que
medirlo y pasarlo a mano en cada montaje.

Lo natural sería corregirlo en origen, en `tools/alinear.js` del Estudio, que ya decodifica el
audio y ya detecta el pitido. Le faltaría:

1. medir el brillo por fotograma y localizar el destello (unas 30 líneas, ya escritas y
   probadas en `calibrar.js`: `brillo()` y `buscarDestello()`);
2. calcular `retardo = tPitido − tDestello` por archivo con vídeo;
3. aplicarlo en el transcodificado que ya hace, desplazando el audio respecto al vídeo;
4. anotarlo en `alineados/LEEME.txt`, para que quede constancia de cuánto se corrigió.

Con eso los archivos de `alineados/` saldrían ya cuadrados y el editor no necesitaría
ningún ajuste manual.

**Antes de hacerlo conviene comprobar una cosa**: si el retardo es el mismo en todas las
grabaciones del mismo equipo, es latencia fija de la cadena de captura y se puede
corregir con confianza. Si varía entre sesiones, hay que medirlo en cada una (que es lo
que hace `calibrar`) y entonces el paso 2 es imprescindible, no una optimización.

## Lo que no sé

No tengo la conversación en la que se diseñó el Estudio, así que no sé si algo de esto se
consideró y se descartó por un motivo que desconozco. Si el destello se añadió justamente
pensando en esto, el paso 1 ya estaba previsto y solo falta usarlo.
