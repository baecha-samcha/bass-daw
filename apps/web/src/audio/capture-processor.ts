// 녹음 capture Worklet: PCM block 을 main 으로 전달(01 §7). start/stop 은 실제 capture frame 으로 ack.
declare const currentFrame: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown) }

const CHUNK = 2048;

class CaptureProcessor extends AudioWorkletProcessor {
  private recording = false; private pendingStart = false; private pendingStop = false;
  private buf: Float32Array[] = []; private fill = 0; private chunkFrame = 0; private channels = 1;
  private peak = 0; private lastMeter = 0;
  constructor() {
    super();
    this.port.onmessage = (e) => {
      if (e.data.type === 'start') { this.pendingStart = true; this.channels = e.data.channels; }
      if (e.data.type === 'stop') this.pendingStop = true;
    };
  }
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const input = inputs[0];
    const n = outputs[0]?.[0]?.length ?? input?.[0]?.length ?? 128;
    for (const o of outputs[0] ?? []) o.fill(0);
    if (input && input.length) for (let i = 0; i < input[0].length; i++) { const a = Math.abs(input[0][i]); if (a > this.peak) this.peak = a; }
    if (currentFrame - this.lastMeter > 1600) { this.port.postMessage({ type: 'meter', peak: this.peak, hasInput: !!(input && input.length) }); this.peak = 0; this.lastMeter = currentFrame; }
    if (this.pendingStart) {
      this.pendingStart = false; this.recording = true; this.fill = 0; this.chunkFrame = currentFrame;
      this.buf = Array.from({ length: this.channels }, () => new Float32Array(CHUNK));
      this.port.postMessage({ type: 'started', frame: currentFrame });
    }
    if (this.recording) {
      const len = input?.[0]?.length ?? n;
      for (let i = 0; i < len; i++) {
        for (let c = 0; c < this.channels; c++) this.buf[c][this.fill] = input?.[Math.min(c, (input?.length ?? 1) - 1)]?.[i] ?? 0;
        if (++this.fill === CHUNK) this.flush();
      }
    }
    if (this.pendingStop && this.recording) {
      this.pendingStop = false; this.recording = false;
      this.flush();
      this.port.postMessage({ type: 'stopped', frame: currentFrame + n });
    }
    return true;
  }
  private flush() {
    if (this.fill === 0) return;
    const out = this.buf.map((b) => b.slice(0, this.fill));
    this.port.postMessage({ type: 'pcm', frame: this.chunkFrame, data: out }, out.map((x) => x.buffer));
    this.chunkFrame += this.fill; this.fill = 0;
  }
}
registerProcessor('bass-daw-capture', CaptureProcessor);
