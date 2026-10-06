/*
 * Mide el desfase entre la imagen y el sonido de una cámara, usando una palmada.
 *
 * Es la medida que faltaba. La sincronía entre archivos se puede calcular comparando
 * sus audios, pero el retardo que mete la propia cadena de grabación —que el audio de
 * una cámara vaya por detrás de su imagen— no se puede deducir desde fuera: no está en
 * los metadatos y la correlación lo reproduce fielmente porque es lo que el archivo
 * dice. La única forma de verlo es un suceso que esté a la vez en la imagen y en el
 * sonido, y una palmada delante de la cámara lo es.
 *
 * Se busca el pico de movimiento en la imagen y el golpe más seco en el audio del mismo
 * archivo. La diferencia entre los dos es el retardo, y cambiado de signo es el valor
 * que hay que pasarle a --audio-offset.
 */
'use strict';

const { spawnSync } = require('node:child_process');
const SY = require('./sync.js');

const VENTANA_POR_DEFECTO = 25;

/*
 * Retardo máximo que se considera creíble, en milisegundos.
 *
 * La latencia de una cadena de captura se cuenta en decenas o pocos cientos de ms. Si la
 * medida se va muy por encima, lo que ha pasado es que no había marca y se ha
 * confundido con cualquier otra cosa: en material hablado, el modo de respaldo encuentra
 * picos de movimiento y de sonido que no tienen nada que ver entre sí. Vale más decir
 * que no se pudo medir que dar un número con aire de seguro.
 */
const RETARDO_MAXIMO_CREIBLE_MS = 500;

/*
 * Cuánto se mira a cada lado del pitido para encontrar el destello, en segundos.
 *
 * Los retardos de captura medidos en material real están en decenas de milisegundos, así
 * que 300 ms es holgado. Estrecho a propósito: el arranque de una grabación está lleno de
 * cambios de brillo (la exposición ajustándose) que pueden parecerse mucho a un destello,
 * y la mejor defensa contra eso es no mirar donde el destello no puede estar. Si alguna
 * cadena de captura tuviera un retardo mayor, se amplía con --radio.
 */
const RADIO_BUSQUEDA_SEG = 0.3;

/*
 * Movimiento por fotograma: cuánto cambia cada imagen respecto a la anterior.
 * Una palmada delante de la cámara da un pico claro.
 */
function movimiento(file, segundos) {
  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-t', String(segundos),
    '-i', file,
    '-an',
    '-vf', 'tblend=all_mode=difference,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });

  if (res.error) return { error: `ffmpeg no se pudo ejecutar: ${res.error.message}` };

  const salida = `${res.stdout || ''}${res.stderr || ''}`;
  const valores = [];
  const re = /YAVG=([0-9.]+)/g;
  let m = re.exec(salida);
  while (m) {
    valores.push(parseFloat(m[1]));
    m = re.exec(salida);
  }
  if (valores.length < 5) return { error: 'no se pudo leer el movimiento del vídeo' };
  return { valores };
}

/* Índice del valor más alto, y cuánto destaca sobre el resto. */
function pico(valores) {
  let maximo = -Infinity;
  let indice = 0;
  let suma = 0;
  for (let i = 0; i < valores.length; i += 1) {
    suma += valores[i];
    if (valores[i] > maximo) {
      maximo = valores[i];
      indice = i;
    }
  }
  const media = suma / valores.length;
  let varianza = 0;
  for (let i = 0; i < valores.length; i += 1) varianza += (valores[i] - media) ** 2;
  const sd = Math.sqrt(varianza / valores.length) || 1e-9;
  return { indice, valor: maximo, destaque: (maximo - media) / sd };
}

/*
 * El golpe más seco del audio: donde más sube la energía de un instante al siguiente.
 * Se mira la subida y no el nivel porque una palmada es, sobre todo, un ataque.
 */
function golpe(envelope) {
  const subidas = new Float64Array(envelope.length);
  for (let i = 1; i < envelope.length; i += 1) {
    subidas[i] = Math.max(0, envelope[i] - envelope[i - 1]);
  }
  return pico(subidas);
}

/*
 * Centro de la ráfaga alrededor del máximo.
 *
 * Una palmada no es un instante: el movimiento sube, llega al golpe y baja, repartido
 * en varios fotogramas, y con un destello se ven dos picos (cuando entra y cuando
 * sale). Quedarse con el máximo elige uno de los dos bordes al azar; el centro de masas
 * de la ráfaga cae donde está el golpe y además afina por debajo del fotograma.
 */
function centroRafaga(valores, indice, radio) {
  const desde = Math.max(0, indice - radio);
  const hasta = Math.min(valores.length - 1, indice + radio);

  let suma = 0;
  let cuenta = 0;
  for (let i = 0; i < valores.length; i += 1) {
    suma += valores[i];
    cuenta += 1;
  }
  const fondo = suma / cuenta;

  let peso = 0;
  let acumulado = 0;
  for (let i = desde; i <= hasta; i += 1) {
    const v = Math.max(0, valores[i] - fondo);
    peso += v;
    acumulado += v * i;
  }
  return peso > 0 ? acumulado / peso : indice;
}

/*
 * Devuelve el retardo del audio de una cámara respecto a su propia imagen.
 *
 * { retardoMs, offsetRecomendado, confianzaVideo, confianzaAudio } o { error }.
 * retardoMs positivo = el sonido va por detrás de la imagen.
 */
function calibrarCamara(file, options) {
  const opts = options || {};
  const segundos = opts.ventana || VENTANA_POR_DEFECTO;

  const mov = movimiento(file, segundos);
  if (mov.error) return { error: mov.error };

  const env = SY.envelope(file, { analyzeSeconds: segundos });
  if (env.error) return { error: env.error };

  const fps = opts.fps || 25;
  const pv = pico(mov.valores);
  const pa = golpe(env.envelope);

  // Un cuarto de segundo a cada lado: coge la palmada entera sin tragarse otro gesto.
  const centroVideo = centroRafaga(mov.valores, pv.indice, Math.max(2, Math.round(fps / 4)));

  /*
   * El valor i de "movimiento" es el cambio ENTRE el fotograma i y el i+1, así que el
   * suceso cae en medio de los dos: de ahí el medio fotograma.
   */
  const tVideo = (centroVideo + 0.5) / fps;
  const tAudio = pa.indice / SY.BIN_HZ;

  return {
    tVideo,
    tAudio,
    retardoMs: Math.round((tAudio - tVideo) * 1000),
    offsetRecomendado: -Math.round((tAudio - tVideo) * 1000),
    confianzaVideo: pv.destaque,
    confianzaAudio: pa.destaque,
    fotogramas: mov.valores.length,
  };
}

// ----------------------------------------------- claqueta: pitido y destello

const BEEP_HZ = 1000;

/*
 * Potencia de una frecuencia concreta en un tramo (algoritmo de Goertzel).
 *
 * Mismo método que usa lib/beep.js del Estudio para su claqueta digital, a propósito: lo
 * que detecte uno tiene que detectarlo el otro igual, o los dos darían tiempos
 * distintos para el mismo pitido.
 */
function goertzel(x, from, n, freq, sampleRate) {
  const k = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(k);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = x[from + i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2;
}

/*
 * Inicio del pitido de 1 kHz, en segundos, o null si no hay.
 *
 * Se exige que el tramo sea un tono casi puro (la mayor parte de su energía en esa
 * frecuencia) y que dure lo suyo: así una consonante fuerte o un golpe no pasan por
 * claqueta.
 */
function buscarPitido(x, sampleRate, opciones) {
  const o = opciones || {};
  const freq = o.freq || BEEP_HZ;
  const n = Math.max(16, Math.round(sampleRate * (o.ventana || 0.005)));
  const minVentanas = Math.ceil((o.duracionMinima || 0.15) / (n / sampleRate));

  let seguidas = 0;
  let desde = -1;
  for (let w = 0; (w + 1) * n <= x.length; w += 1) {
    const from = w * n;
    let energia = 0;
    for (let i = 0; i < n; i += 1) energia += x[from + i] * x[from + i];
    const tono = goertzel(x, from, n, freq, sampleRate);
    const proporcion = energia > 0 ? tono / ((energia * n) / 2) : 0;
    const rms = Math.sqrt(energia / n);

    if (proporcion > 0.6 && rms > 0.02) {
      if (seguidas === 0) desde = w;
      seguidas += 1;
      if (seguidas >= minVentanas) return afinarInicio(x, desde * n, n, freq, sampleRate) / sampleRate;
    } else {
      seguidas = 0;
    }
  }
  return null;
}

/*
 * Afina el inicio muestra a muestra. Con un tono puro, la potencia que ve la ventana
 * crece según cuánto pitido abarca, así que el 25 % de la potencia estable marca el
 * punto en que la ventana cubre justo media.
 */
function afinarInicio(x, primeraVentana, n, freq, sampleRate) {
  const ref = primeraVentana + 2 * n;
  if (ref + n > x.length) return primeraVentana;
  const estable = goertzel(x, ref, n, freq, sampleRate);
  for (let s = Math.max(0, primeraVentana - 2 * n); s <= primeraVentana + n; s += 1) {
    if (goertzel(x, s, n, freq, sampleRate) >= estable * 0.25) return s + n / 2;
  }
  return primeraVentana;
}

/* Decodifica el audio de un archivo a mono para analizarlo. */
function pcmMono(file, segundos, sampleRate) {
  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-t', String(segundos),
    '-i', file,
    '-vn', '-ac', '1', '-ar', String(sampleRate),
    '-f', 's16le', '-',
  ], { encoding: 'buffer', timeout: 600000, maxBuffer: 256 * 1024 * 1024 });

  if (res.error || res.status !== 0) return null;
  const n = Math.floor(res.stdout.length / 2);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i += 1) x[i] = res.stdout.readInt16LE(i * 2) / 32768;
  return x;
}

/* Brillo medio de cada fotograma. */
function brillo(file, segundos) {
  const res = spawnSync('ffmpeg', [
    '-v', 'error',
    '-t', String(segundos),
    '-i', file,
    '-an',
    '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-',
    '-f', 'null', '-',
  ], { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024 });

  if (res.error) return { error: `ffmpeg no se pudo ejecutar: ${res.error.message}` };
  const salida = `${res.stdout || ''}${res.stderr || ''}`;
  const valores = [];
  const re = /YAVG=([0-9.]+)/g;
  let m = re.exec(salida);
  while (m) {
    valores.push(parseFloat(m[1]));
    m = re.exec(salida);
  }
  if (valores.length < 5) return { error: 'no se pudo leer el brillo del vídeo' };
  return { valores };
}

/* Duración del destello del Estudio: arranca a tope y se apaga linealmente. */
const DESTELLO_SEG = 0.35;

/*
 * Busca el destello por su FORMA, no por ser la mayor subida de brillo.
 *
 * Quedarse con la subida más grande falla con material real por dos motivos que se ven
 * en cuanto se prueba: al empezar a grabar, el ajuste automático de exposición mueve el
 * brillo muchísimo, y a mitad de grabación cualquiera se mueve o cambia la luz. Las dos
 * cosas dan subidas mayores que un destello de pantalla reflejado en una cara.
 *
 * Lo que sí distingue al destello es su perfil: sube de golpe y se apaga en 350 ms. Se
 * compara cada candidato con esa forma. Y como el destello se dispara a la vez que el
 * pitido, se busca solo cerca de él, que es donde tiene que estar.
 *
 * Además se prefiere lo que esté cerca del pitido. No es un capricho: el retardo de
 * captura son decenas de milisegundos, así que un destello discreto justo al lado del
 * pitido es mucho más creíble que uno bien formado medio segundo antes. Sin esta
 * preferencia, todo depende de dónde caiga exactamente el borde de la ventana.
 *
 * @param valores brillo por fotograma
 * @param fps
 * @param centroSeg segundo alrededor del cual buscar (el del pitido), o null para todo
 * @param radioSeg  cuánto mirar a cada lado
 */
function buscarDestello(valores, fps, centroSeg, radioSeg) {
  const largo = Math.max(2, Math.round(DESTELLO_SEG * fps));
  const radio = radioSeg !== undefined ? radioSeg : RADIO_BUSQUEDA_SEG;

  let desde = 1;
  let hasta = valores.length - largo - 1;
  if (centroSeg !== null && centroSeg !== undefined) {
    desde = Math.max(1, Math.round((centroSeg - radio) * fps));
    hasta = Math.min(valores.length - largo - 1, Math.round((centroSeg + radio) * fps));
  }
  if (hasta < desde) return { indice: null, destaque: 0, salto: 0 };

  // La plantilla: 1 justo al empezar, bajando hasta 0 al final del destello.
  const plantilla = new Float64Array(largo);
  for (let i = 0; i < largo; i += 1) plantilla[i] = 1 - i / largo;
  let normaPlantilla = 0;
  for (let i = 0; i < largo; i += 1) normaPlantilla += plantilla[i] * plantilla[i];
  normaPlantilla = Math.sqrt(normaPlantilla) || 1;

  /*
   * Fondo justo antes del candidato. Se toma un percentil bajo y no la media porque si
   * ahí viene cayendo otra cosa (un destello anterior, la exposición ajustándose) la
   * media sale alta y tapa la subida que se busca: con la media, un destello real puede
   * llegar a puntuar negativo.
   */
  const fondoAntesDe = (i) => {
    const anteriores = Array.from(valores.slice(Math.max(0, i - Math.round(0.2 * fps)), i));
    if (!anteriores.length) return null;
    anteriores.sort((a, b) => a - b);
    return anteriores[Math.floor(anteriores.length * 0.2)];
  };

  const puntuaciones = new Float64Array(valores.length);
  for (let i = desde; i <= hasta; i += 1) {
    const base = fondoAntesDe(i);
    if (base === null) continue;

    let producto = 0;
    let norma = 0;
    for (let k = 0; k < largo; k += 1) {
      const v = valores[i + k] - base;
      producto += v * plantilla[k];
      norma += v * v;
    }
    norma = Math.sqrt(norma);
    if (norma <= 0) continue;

    // Parecido a la forma (0 a 1) por cuánto sube: una subida con la forma correcta
    // pero minúscula no es un destello, y una grande con otra forma tampoco.
    const parecido = producto / (norma * normaPlantilla);
    const altura = (valores[i] - base);
    let puntos = parecido > 0 ? parecido * parecido * Math.max(0, altura) : 0;

    if (centroSeg !== null && centroSeg !== undefined && puntos > 0) {
      // Campana suave alrededor del pitido: a 150 ms pesa bastante menos, a 400 ms casi
      // nada. No descarta nada por sí sola, solo ordena.
      const distancia = Math.abs(i / fps - centroSeg);
      puntos *= Math.exp(-((distancia / 0.15) ** 2) / 2);
    }
    puntuaciones[i] = puntos;
  }

  const p = pico(puntuaciones);
  if (!(p.valor > 0)) return { indice: null, destaque: 0, salto: 0 };

  const base = fondoAntesDe(p.indice) || 0;

  // El valor i es el primer fotograma ya iluminado: el suceso cae entre él y el anterior.
  return { indice: p.indice - 0.5, destaque: p.destaque, salto: valores[p.indice] - base };
}

/*
 * Retardo del audio respecto a la imagen usando la claqueta del Estudio: el pitido de
 * 1 kHz marca el audio y el destello de pantalla marca la imagen.
 */
function calibrarClaqueta(file, options) {
  const opts = options || {};
  const segundos = opts.ventana || VENTANA_POR_DEFECTO;
  const fps = opts.fps || 25;
  const sampleRate = 16000;

  const x = pcmMono(file, segundos, sampleRate);
  if (!x || !x.length) return { error: 'no se pudo leer el audio' };
  const tAudio = buscarPitido(x, sampleRate);
  if (tAudio == null) return { error: 'no se encontró el pitido de 1 kHz' };

  const br = brillo(file, segundos);
  if (br.error) return { error: br.error };

  /*
   * Se busca cerca del pitido: los dos se disparan a la vez, así que el destello tiene
   * que estar ahí. La ventana es justo lo que se considera creíble como latencia: así
   * todo lo que se encuentre es, por construcción, un valor aceptable, y de paso se deja
   * fuera el arranque de la grabación, donde el ajuste automático de exposición sube y
   * baja el brillo con una forma parecida a la de un destello.
   */
  const radio = opts.radio !== undefined ? opts.radio : RADIO_BUSQUEDA_SEG;
  const destello = buscarDestello(br.valores, fps, tAudio, radio);
  if (destello.indice === null) {
    return {
      error: `se encontró el pitido en ${tAudio.toFixed(3)}s, pero ningún destello a menos `
        + `de ${Math.round(radio * 1000)} ms de él`,
    };
  }
  const tVideo = destello.indice / fps;

  /*
   * La imagen solo puede decir "entre este fotograma y el anterior": el pitido se
   * localiza con precisión de muestra, pero el destello no puede afinarse más allá del
   * fotograma. Medio fotograma es la incertidumbre irreducible, y conviene decirla.
   */
  const incertidumbreMs = Math.round((500 / fps));

  return {
    modo: 'claqueta',
    tVideo,
    tAudio,
    retardoMs: Math.round((tAudio - tVideo) * 1000),
    offsetRecomendado: -Math.round((tAudio - tVideo) * 1000),
    incertidumbreMs,
    confianzaVideo: destello.destaque,
    confianzaAudio: Infinity,
    saltoBrillo: destello.salto,
  };
}

module.exports = {
  VENTANA_POR_DEFECTO, RETARDO_MAXIMO_CREIBLE_MS, RADIO_BUSQUEDA_SEG, BEEP_HZ, movimiento, pico, golpe, centroRafaga, calibrarCamara,
  goertzel, buscarPitido, pcmMono, brillo, buscarDestello, calibrarClaqueta, DESTELLO_SEG,
};
