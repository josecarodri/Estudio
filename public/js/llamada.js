'use strict';
/*
 * Decisiones sobre la llamada cuando una persona pierde y recupera la conexión con la sala.
 *
 * Antes, cualquier corte del canal de la sala (un parpadeo del wifi del iPad, del túnel…) colgaba la
 * llamada de las dos personas y la montaba de nuevo, con 20-30 s de imagen congelada, aunque el
 * vídeo y el audio de la llamada (que van por otro camino) estuvieran bien. Ahora la llamada solo
 * se rehace si de verdad está muerta, o si la otra persona es una página nueva.
 *
 * Es código sin dependencias del navegador para poder probarlo en Node (tests/llamada.test.js).
 */
(function (root) {
  /** ¿La conexión de la llamada se puede seguir usando? («disconnected» a veces se recupera sola). */
  const viva = (estado) => !!estado && estado !== 'failed' && estado !== 'closed';

  /**
   * Quien se quedó en la sala ve entrar (evento peer-joined) a la otra persona.
   * - volvio: es la misma página que reconecta (mismo identificador), no una persona nueva.
   * Devuelve 'mantener' o 'rehacer-respondiendo'.
   */
  function alEntrarOtro({ volvio, mismoRemoto, estadoPc }) {
    if (volvio && mismoRemoto && viva(estadoPc)) return 'mantener';
    return 'rehacer-respondiendo';
  }

  /**
   * Quien se había caído vuelve a la sala (evento welcome) y ve a la otra persona dentro.
   * - volvio: el servidor confirma que reconectó DENTRO del plazo de gracia. Si no (se había dado por
   *   salida), la otra persona ya colgó su llamada y hay que ofrecer una nueva aunque la mía parezca viva.
   * Devuelve 'mantener' o 'rehacer-ofreciendo' (quien llega es quien ofrece la llamada).
   */
  function alVolver({ volvio, mismoRemoto, estadoPc }) {
    if (volvio && mismoRemoto && viva(estadoPc)) return 'mantener';
    return 'rehacer-ofreciendo';
  }

  /** ¿Llega una oferta de una llamada distinta de la que tengo (otra conexión nueva)? */
  function ofertaNueva({ cidActual, cidMensaje }) {
    return !!cidMensaje && !!cidActual && cidMensaje !== cidActual;
  }

  /** ¿Un mensaje de señal es de una llamada anterior que ya no existe? Hay que ignorarlo. */
  function esDeLlamadaAnterior({ cidActual, cidMensaje, esOferta }) {
    return !esOferta && !!cidMensaje && !!cidActual && cidMensaje !== cidActual;
  }

  /** Desempate si las dos personas rehacen la llamada a la vez: ofrece quien tenga el identificador mayor. */
  const ofreceYo = (yo, otro) => String(yo) > String(otro);

  /**
   * Quien rehízo la llamada como respondedor pide a la otra persona que ofrezca (mensaje «reiniciar»).
   * Devuelve 'ofrecer' o 'esperar'. `yoTambienRehago`: yo también estoy esperando una oferta (las dos
   * llamadas estaban muertas): entonces decide el desempate.
   */
  function alPedirReinicio({ yoTambienRehago, miId, otroId }) {
    if (!yoTambienRehago) return 'ofrecer';
    return ofreceYo(miId, otroId) ? 'ofrecer' : 'esperar';
  }

  /**
   * Recuperación tras la caída de la página en plena grabación. La página deja una marca (en el navegador)
   * mientras graba y la borra al parar a propósito: si al abrir sigue ahí y es reciente, es que se cerró grabando.
   * Devuelve la marca si es válida (con los segundos transcurridos) o null.
   */
  function recuperacionVigente(marca, ahora, vigenciaMs) {
    if (!marca || !marca.grabando || !marca.sala || !marca.nombre || !(marca.ts > 0)) return null;
    const pasado = ahora - marca.ts;
    if (pasado < 0 || pasado > vigenciaMs) return null;
    return { ...marca, segundos: Math.round(pasado / 1000) };
  }

  /**
   * ¿Qué hace esta página con la grabación de la sala? Se pregunta al entrar (welcome) y cada pocos
   * segundos, porque una orden de grabar o de parar se pierde si la conexión de esa página se corta
   * justo entonces. Antes, quien se perdía la orden de grabar no grababa nada en toda la sesión, y quien
   * se perdía la de parar seguía grabando sin poder pararlo.
   *  - grabando / miSesion: si esta página graba, y qué sesión.
   *  - sesion: la grabación de la sala según el servidor ({ id, recording }), o null si no sabe de ninguna.
   * Devuelve:
   *  - 'retomar': venimos de una caída de la página y la grabación sigue: se graba ya, como tramo nuevo.
   *  - 'unirse': hay una grabación en marcha y esta página no graba (no le llegó la orden, o entró después).
   *  - 'parar': esta página sigue grabando una sesión que ya se paró.
   *  - 'cambiar': graba una sesión vieja y hay otra en marcha: para la suya y se une a la nueva.
   *  - 'terminada': venimos de una caída pero la grabación ya acabó mientras tanto.
   *  - 'nada'.
   * Si el servidor no sabe de ninguna grabación (p. ej. se reinició), quien graba sigue grabando.
   */
  function alRecibirGrabacion({ recuperando, grabando, miSesion, sesion }) {
    const enCurso = !!(sesion && sesion.recording);
    if (grabando) {
      if (!sesion) return 'nada';
      if (sesion.id === miSesion) return enCurso ? 'nada' : 'parar';
      return enCurso ? 'cambiar' : 'parar';
    }
    if (enCurso) return recuperando ? 'retomar' : 'unirse';
    return recuperando ? 'terminada' : 'nada';
  }

  /**
   * En la comprobación periódica, ¿es pronto para actuar? La orden normal (con su cuenta atrás y su
   * pitido) puede estar aún en camino: se le da `margenMs` desde la hora de empezar o de parar.
   */
  function esPronto({ accion, sesion, ahora, margenMs = 2000 }) {
    if (!sesion) return false;
    if (accion === 'unirse' || accion === 'cambiar') return ahora < sesion.startAt + margenMs;
    if (accion === 'parar') return ahora < (sesion.stopAt || 0) + margenMs;
    return false;
  }

  /**
   * Indicador de si la otra persona graba, para quien está grabando. 'graba' o 'no-graba' (tras
   * `graciaMs` desde que empezó, para no avisar durante la cuenta atrás), o null si no hay nada que decir.
   */
  function estadoDelOtro({ hayOtro, yoGrabo, otroGraba, msGrabando, graciaMs = 5000 }) {
    if (!hayOtro || otroGraba === undefined || otroGraba === null) return null;
    if (otroGraba) return 'graba';
    return yoGrabo && msGrabando > graciaMs ? 'no-graba' : null;
  }

  /**
   * Aviso que se enseña cuando alguien pone una marca mientras se graba (✂ cortar un tramo, ★ buen
   * momento). `propia`: la puso esta página. Devuelve { texto, tipo } para el aviso.
   */
  function avisoDeMarca(marca, { propia } = {}) {
    if (!marca) return null;
    if (marca.tipo === 'bueno') {
      return { texto: propia ? '★ Buen momento marcado' : `★ ${marca.nombre} marcó un buen momento`, tipo: '' };
    }
    if (marca.tipo !== 'corte') return null;
    if (marca.fin == null) {
      return { texto: `✂ ${propia ? 'Tramo' : `${marca.nombre} abrió un tramo`} para cortar: pulsa ✂ cuando acabe`, tipo: 'warn' };
    }
    const s = Math.max(0, Math.round((marca.fin - marca.inicio) / 1000));
    return { texto: `✂ Tramo para cortar cerrado (${s} s)`, tipo: '' };
  }

  /** Texto del botón ✂: abrir un tramo, o cerrarlo y cuánto lleva abierto. */
  function textoBotonCorte(corteAbierto, ahora) {
    if (!corteAbierto) return '✂ Cortar';
    const s = Math.max(0, Math.floor((ahora - corteAbierto.inicio) / 1000));
    return `✂ Cerrar corte ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  /**
   * ¿Llega bien la voz al micro? `tramos`: el nivel de los últimos ~20 s, uno cada 100 ms, en dBFS
   * ({ rms, pico }). Solo cuenta la voz: lo que está claramente por encima del ruido de fondo. Devuelve
   * { estado, vozDb }: 'bajo' si lo normal de la voz (su percentil 90) no llega a −32 dBFS (al editar
   * habría que subirlo mucho, y con él el ruido); 'satura' si recorta (picos a 0 dBFS) varias veces;
   * 'bien'; o null si aún no hay voz bastante para saberlo (p. ej. mientras habla el otro).
   */
  function nivelDelMicro(tramos, opciones) {
    const o = { bajo: -32, recorte: -0.5, recortes: 3, vozMinima: 30, ...opciones };
    if (!tramos || !tramos.length) return { estado: null, vozDb: null };
    if (tramos.filter((t) => t.pico >= o.recorte).length >= o.recortes) return { estado: 'satura', vozDb: null };
    const niveles = tramos.map((t) => t.rms).sort((a, b) => a - b);
    const suelo = niveles[Math.floor(niveles.length * 0.1)];
    const voz = niveles.filter((x) => x > Math.max(-55, suelo + 12));
    if (voz.length < o.vozMinima) return { estado: null, vozDb: null };
    const vozDb = Math.round(voz[Math.floor(voz.length * 0.9)]);
    return { estado: vozDb < o.bajo ? 'bajo' : 'bien', vozDb };
  }

  /** Aviso del micro: el propio («Tu micro…») o el de la otra persona, con su nombre. */
  function avisoDeMicro(estado, { nombre } = {}) {
    if (estado === 'bajo') return nombre ? `🎙 El micro de ${nombre} llega bajo` : '🎙 Tu micro llega bajo: acércate o súbele el volumen';
    if (estado === 'satura') return nombre ? `🎙 El micro de ${nombre} satura` : '🎙 Tu micro satura: bájale el volumen o aléjate un poco';
    return '';
  }

  const api = {
    viva, alEntrarOtro, alVolver, ofertaNueva, esDeLlamadaAnterior, ofreceYo, alPedirReinicio,
    recuperacionVigente, alRecibirGrabacion, esPronto, estadoDelOtro, avisoDeMarca, textoBotonCorte,
    nivelDelMicro, avisoDeMicro,
  };
  root.Llamada = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
