// 플러그인 시험 렌더(적합성) 전용 worker. main 은 5초 watchdog 으로 terminate 할 수 있다.
import { runConformance } from '@bass-daw/plugin-api';

self.onmessage = async (e: MessageEvent) => {
  try {
    const mod = await WebAssembly.compile(e.data.dsp);
    const report = runConformance(mod, e.data.manifest, e.data.memoryPages);
    (self as unknown as Worker).postMessage({ report });
  } catch (err) { (self as unknown as Worker).postMessage({ error: (err as Error).message }); }
};
