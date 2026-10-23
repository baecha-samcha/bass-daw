// alphaTab 렌더 래퍼(렌더 전용). alphaTab 은 필요할 때만 동적 import 한다(초기 번들·재생 경로와 분리).
import type { NotationScore, DrumScore } from '@bass-daw/notation';
import { toAlphaTabDrumScore } from './drum-adapter.ts';
import { toAlphaTabScore, renderSettings } from './alphatab-adapter.ts';

export interface RenderedScore { destroy(): void; systems: number; ms: number }

export async function renderNotation(el: HTMLElement, ns: NotationScore | DrumScore): Promise<RenderedScore> {
  const at = await import('@coderline/alphatab');
  const fontDirectory = new URL('./alphatab/font/', document.baseURI).href;
  el.innerHTML = '';
  const t0 = performance.now();
  el.dataset.renderStarted = String(t0);
  const api = new at.AlphaTabApi(el, renderSettings(at, 'kind' in ns ? { staves: 'score', startBar: ns.startBar } : ns, fontDirectory));
  const score = 'kind' in ns ? toAlphaTabDrumScore(at, ns) : toAlphaTabScore(at, ns);
  score.finish(api.settings); // importer 와 같이 모델 연결(붙임줄·슬라이드 대상·음가) 확정
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('RENDER_TIMEOUT: alphaTab did not finish in 60s')), 60_000);
    api.error.on((e) => { clearTimeout(timer); reject(e instanceof Error ? e : new Error(String(e))); });
    api.postRenderFinished.on(() => {
      clearTimeout(timer);
      el.dataset.rendered = 'true';
      el.dataset.renderFinished = String(performance.now());
      el.dataset.renderMs = String(Math.round(performance.now() - t0));
      resolve({ destroy: () => api.destroy(), systems: el.querySelectorAll('.at-surface > div').length, ms: Math.round(performance.now() - t0) });
    });
    api.renderScore(score, [0]);
  });
}
