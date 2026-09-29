// Captura PCM sin pérdida a partir de un instante exacto del reloj de audio.
// El hilo principal recibe bloques Float32 y los convierte a WAV de 16 bits.
class PcmRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.startAt = Infinity;   // en segundos de currentTime
    this.stopAt = Infinity;
    this.started = false;
    this.done = false;
    this.port.onmessage = (e) => {
      if (e.data.cmd === 'start') this.startAt = e.data.at;
      if (e.data.cmd === 'stop') this.stopAt = e.data.at;
    };
  }

  process(inputs) {
    if (this.done) return false;
    const input = inputs[0];
    const ch = input && input[0];
    const n = ch ? ch.length : 128;
    const blockStart = currentTime;
    const blockEnd = currentTime + n / sampleRate;
    if (blockEnd <= this.startAt) return true;

    // Recorta el bloque al intervalo [startAt, stopAt) con precisión de muestra.
    let from = 0;
    let to = n;
    if (!this.started) {
      from = Math.max(0, Math.round((this.startAt - blockStart) * sampleRate));
      this.started = true;
      this.port.postMessage({ type: 'started', frame: currentFrame + from, time: blockStart + from / sampleRate });
    }
    if (this.stopAt < blockEnd) to = Math.max(from, Math.round((this.stopAt - blockStart) * sampleRate));

    const out = new Float32Array(to - from);
    if (ch) out.set(ch.subarray(from, to));
    this.port.postMessage({ type: 'data', samples: out }, [out.buffer]);

    if (this.stopAt < blockEnd) {
      this.done = true;
      this.port.postMessage({ type: 'stopped' });
      return false;
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
