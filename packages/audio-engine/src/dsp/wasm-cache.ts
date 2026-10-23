// 외부 WASM 모듈 준비(컴파일) 캐시. 컴파일은 준비 단계에서만 한다(03 §4 prepare, 01 §9).
// - 렌더 스레드 transport 가 'idle' 일 때만 컴파일한다. 'starting'/'playing' 이면 거절하고 기록만 남긴다.
// - RenderCore/WasmEffectDsp/WasmInstrumentDsp 는 이 캐시의 Map 을 읽기만 하며 직접 컴파일하지 않는다.
//   준비되지 않은 모듈은 effect=지연 보상 dry bypass, instrument=무음('not-prepared') 으로 처리된다.

export type TransportState = 'idle' | 'starting' | 'playing';
export interface CompileRecord { key: string; transport: TransportState; ok: boolean; reason?: string }

export class WasmModuleCache {
  readonly modules = new Map<string, WebAssembly.Module>();
  /** 최근 컴파일 시도 기록(진단·회귀 테스트용, 최대 64개) */
  readonly log: CompileRecord[] = [];
  constructor(private compile: (bytes: Uint8Array) => WebAssembly.Module = (b) => new WebAssembly.Module(b as unknown as BufferSource)) {}

  private record(r: CompileRecord) { this.log.push(r); if (this.log.length > 64) this.log.shift(); }

  /** 준비 단계 전용. 재생 중이면 어떤 모듈도 컴파일하지 않는다. */
  prepare(entries: [string, Uint8Array][], transport: TransportState): { compiled: string[]; refused: string[]; failed: [string, string][] } {
    const out = { compiled: [] as string[], refused: [] as string[], failed: [] as [string, string][] };
    for (const [key, bytes] of entries) {
      if (this.modules.has(key)) continue;
      if (transport !== 'idle') { out.refused.push(key); this.record({ key, transport, ok: false, reason: 'COMPILE_WHILE_PLAYING' }); continue; }
      try { this.modules.set(key, this.compile(bytes)); out.compiled.push(key); this.record({ key, transport, ok: true }); }
      catch (e) { const reason = String((e as Error)?.message ?? e); out.failed.push([key, reason]); this.record({ key, transport, ok: false, reason }); }
    }
    return out;
  }

  /** 더 이상 쓰지 않는 모듈 해제 */
  retain(keys: Iterable<string>) { const keep = new Set(keys); for (const k of [...this.modules.keys()]) if (!keep.has(k)) this.modules.delete(k); }
}
