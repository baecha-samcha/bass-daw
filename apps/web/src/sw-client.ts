// PWA: 새 shell 은 대기시키고, 재생/녹음 중이 아닐 때 사용자가 업데이트를 선택하면 전환(강제 reload 금지).
import { useApp } from './store.ts';
import { engine } from './audio/engine.ts';
import { recorderBusy } from './audio/recorder.ts';

let waiting: ServiceWorker | null = null;

export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    const check = () => { if (reg.waiting && navigator.serviceWorker.controller) { waiting = reg.waiting; useApp.getState().set({ updateReady: true }); } };
    check();
    reg.addEventListener('updatefound', () => { reg.installing?.addEventListener('statechange', check); });
  }).catch(() => undefined);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (applying && !reloaded) { reloaded = true; location.reload(); } });
}

let applying = false;
export function canApplyUpdate(): boolean { return engine.state !== 'playing' && !recorderBusy(); }
export async function applyUpdate(): Promise<boolean> {
  if (!waiting || !canApplyUpdate()) return false;
  await useApp.getState().saveNow();
  applying = true;
  waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}
