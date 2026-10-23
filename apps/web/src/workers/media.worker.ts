// 디코드/파형 worker: WAV 디코딩과 min/max 피라미드 계산을 main thread 밖에서 수행한다(01 §7).
import { decodeWav, buildPyramid, serializePyramid } from '@bass-daw/audio-engine';

self.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m.type === 'decode-wav') {
      const pcm = decodeWav(new Uint8Array(m.bytes));
      const pyr = serializePyramid(buildPyramid(pcm.channels, pcm.sampleRate));
      (self as unknown as Worker).postMessage({ id: m.id, ok: true, sampleRate: pcm.sampleRate, channels: pcm.channels.length, frames: pcm.frames, pyramid: pyr }, [pyr.buffer]);
    } else if (m.type === 'pyramid') {
      const chans = (m.channels as ArrayBuffer[]).map((b) => new Float32Array(b));
      const pyr = serializePyramid(buildPyramid(chans, m.sampleRate));
      (self as unknown as Worker).postMessage({ id: m.id, ok: true, pyramid: pyr }, [pyr.buffer]);
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id: m.id, ok: false, error: (err as Error).message });
  }
};
