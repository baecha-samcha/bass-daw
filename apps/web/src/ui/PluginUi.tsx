// 별도 origin sandbox iframe 플러그인 UI (03 §5). allow-scripts 만, allow-same-origin 없음(opaque origin).
// capability 는 nonce 가 있는 전용 MessageChannel 로만 전달하고, 자기 instance 의 파라미터 변경·resize·선택 자산 요청만 허용한다.
import { useEffect, useRef, useState } from 'react';
import type { PluginManifest, PluginInstance } from '@bass-daw/schemas';
import { useApp } from '../store.ts';
import { engine } from '../audio/engine.ts';

const CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'";
export const UI_LIMITS = { messageBytes: 64 * 1024, perSecond: 60, maxHeight: 600 };

export function PluginUiFrame({ html, manifest, pl, channelId }: { html: string; manifest: PluginManifest; pl: PluginInstance; channelId: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(80);
  const [stats, setStats] = useState({ accepted: 0, rejected: 0, connected: false });
  const src = { srcdoc: `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">${html}` };
  const plRef = useRef(pl); plRef.current = pl;
  useEffect(() => {
    const f = ref.current; if (!f) return;
    const ch = new MessageChannel();
    const nonce = crypto.randomUUID();
    const times: number[] = [];
    let connected = false; let commit: ReturnType<typeof setTimeout> | null = null;
    const st = { accepted: 0, rejected: 0 };
    const reject = () => { st.rejected++; setStats({ ...st, connected }); };
    ch.port1.onmessage = (e) => {
      const now = performance.now();
      while (times.length && now - times[0] > 1000) times.shift();
      if (times.length >= UI_LIMITS.perSecond) return reject(); // 60개/초 초과 차단
      times.push(now);
      let size = 0; try { size = JSON.stringify(e.data).length; } catch { return reject(); }
      if (size > UI_LIMITS.messageBytes || !e.data || typeof e.data !== 'object') return reject();
      const d = e.data as { type?: string; nonce?: string; id?: string; value?: number; height?: number };
      if (d.type === 'hello') { if (d.nonce !== nonce) return reject(); connected = true; st.accepted++; setStats({ ...st, connected }); ch.port1.postMessage({ type: 'state', parameters: { ...Object.fromEntries(manifest.parameters.map((x) => [x.id, x.default])), ...plRef.current.parameters } }); return; }
      if (!connected) return reject();
      if (d.type === 'param') {
        const desc = manifest.parameters.find((x) => x.id === d.id);
        if (!desc || typeof d.value !== 'number' || !Number.isFinite(d.value) || d.value < desc.min || d.value > desc.max) return reject();
        st.accepted++; setStats({ ...st, connected });
        engine.previewEffect(channelId, plRef.current.instanceId, desc.id, d.value);
        if (commit) clearTimeout(commit);
        const v = d.value;
        commit = setTimeout(() => useApp.getState().run(`${manifest.name} ${desc.name}`, { type: 'SetParameter', owner: 'plugin', ownerId: plRef.current.instanceId, parameterId: desc.id, value: v }), 300);
        return;
      }
      if (d.type === 'resize' && typeof d.height === 'number') { st.accepted++; setHeight(Math.max(40, Math.min(UI_LIMITS.maxHeight, d.height))); return; }
      if (d.type === 'request-asset') {
        if (!manifest.permissions.includes('read-selected-assets')) { ch.port1.postMessage({ type: 'denied', reason: 'permission' }); return reject(); }
        const p = useApp.getState().project!;
        const list = p.assets.filter((a) => a.audio);
        const pick = prompt(`플러그인 UI 가 자산 읽기를 요청합니다. 허용할 자산 번호(취소=거부):\n${list.map((a, i) => `${i + 1}. ${a.sha256.slice(0, 10)} ${a.audio!.frameCount}fr`).join('\n')}`);
        const a = pick ? list[Number(pick) - 1] : undefined;
        if (!a) { ch.port1.postMessage({ type: 'denied', reason: 'user' }); return; }
        st.accepted++;
        ch.port1.postMessage({ type: 'asset', assetId: a.id, sampleRate: a.audio!.sampleRate, frames: a.audio!.frameCount, channels: a.audio!.channels }); // 제한된 handle(메타데이터)
        return;
      }
      reject();
    };
    const onLoad = () => f.contentWindow?.postMessage({ type: 'bass-daw-connect', nonce }, '*', [ch.port2]);
    f.addEventListener('load', onLoad);
    return () => { f.removeEventListener('load', onLoad); ch.port1.close(); if (commit) clearTimeout(commit); };
  }, [html, manifest, channelId]);
  return (
    <div data-testid={`plugin-ui-${pl.instanceId}`} data-accepted={stats.accepted} data-rejected={stats.rejected} data-connected={stats.connected}>
      <iframe ref={ref} title={`${manifest.name} UI`} sandbox="allow-scripts" referrerPolicy="no-referrer" style={{ width: '100%', height, border: '1px solid var(--line)', borderRadius: 6, background: '#1f2229' }}
        srcDoc={src.srcdoc} />
      <div className="mono dim" style={{ fontSize: 10 }}>sandbox UI · {stats.connected ? 'connected' : 'connecting'} · 거절 {stats.rejected}</div>
    </div>
  );
}
