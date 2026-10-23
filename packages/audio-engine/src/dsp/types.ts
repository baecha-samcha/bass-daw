// 내장 DSP 공통 인터페이스. 실시간 Worklet 과 offline renderer 가 같은 구현을 사용한다(01 §8).
// process 중 동적 할당·IO·JSON·log 금지.
export interface EffectDsp {
  readonly latencyFrames: number;
  readonly tailFrames: number;
  /** io: stereo in-place. params: descriptor 순서, 각 배열 길이 ≥ frames */
  process(io: Float32Array[], frames: number, params: Float32Array[]): void;
  reset(): void;
  diagnostics: string[];
}
