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
   * La sala da la bienvenida (welcome) a quien acaba de entrar. ¿Qué hace con una grabación en curso?
   * - 'retomar': venimos de una caída (el usuario pidió retomar) y la grabación sigue: se graba ya, como tramo nuevo.
   * - 'terminada': venimos de una caída pero la grabación ya acabó mientras tanto: no hay nada que retomar.
   * - 'avisar': entra alguien normal con una grabación en marcha: empezará con la próxima.
   * - 'nada': no hay grabación en curso.
   */
  function alRecibirGrabacion({ recuperando, grabandoYa, sesionEnCurso }) {
    if (grabandoYa) return 'nada';
    if (sesionEnCurso) return recuperando ? 'retomar' : 'avisar';
    return recuperando ? 'terminada' : 'nada';
  }

  const api = {
    viva, alEntrarOtro, alVolver, ofertaNueva, esDeLlamadaAnterior, ofreceYo, alPedirReinicio,
    recuperacionVigente, alRecibirGrabacion,
  };
  root.Llamada = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
