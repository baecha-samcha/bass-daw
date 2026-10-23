// 내장 샘플러 (01 §6, 03 BuiltinSamplerState). pitch/velocity/articulation zone, drum pad + choke,
// CC64 sustain, 채널 pitch bend(±2st) + voice expression, 폴리포니 한도·voice stealing(5ms ramp).
import type { Pcm } from '../wav.ts';

export interface ZoneRt {
  id: string; pcm: Pcm | null; rootPitch: number; minPitch: number; maxPitch: number;
  minVelocity: number; maxVelocity: number; articulation: string; loopStart: number | null; loopEnd: number | null;
}
export interface PadRt { padId: string; pcm: Pcm | null; gain: number; chokeGroup: number | null }

export interface SamplerCounters { voiceSteals: number; articulationFallbacks: number; missingSamples: number; stuckVoices: number }

const RAMP_MS = 5;
const S_FREE = 0, S_ATTACK = 1, S_SUSTAIN = 2, S_RELEASE = 3, S_STEAL = 4;

export class SamplerDsp {
  // voice 상태(구조체 배열) — process 중 할당 없음
  readonly max: number;
  private state: Uint8Array; private pos: Float64Array; private baseRate: Float64Array; private amp: Float64Array;
  private env: Float64Array; private envStep: Float64Array; private voiceId: Uint32Array; private chan: Uint8Array;
  private bendSemis: Float64Array; private sustained: Uint8Array; private age: Float64Array; private choke: Int16Array; private oneShot: Uint8Array;
  private pcmL: (Float32Array | null)[]; private pcmR: (Float32Array | null)[]; private loopS: Float64Array; private loopE: Float64Array;
  private chanBend = new Float64Array(16); private sustain = new Uint8Array(16);
  private clock = 0;
  attackMs = 5; releaseMs = 80;
  counters: SamplerCounters = { voiceSteals: 0, articulationFallbacks: 0, missingSamples: 0, stuckVoices: 0 };
  private zonesByArt = new Map<string, ZoneRt[]>();
  private pads = new Map<string, PadRt>();

  constructor(private fs: number, polyphony: number, zones: ZoneRt[], pads: PadRt[]) {
    this.max = polyphony;
    const n = polyphony + Math.max(4, polyphony >> 2); // steal ramp 용 여유 슬롯
    this.state = new Uint8Array(n); this.pos = new Float64Array(n); this.baseRate = new Float64Array(n); this.amp = new Float64Array(n);
    this.env = new Float64Array(n); this.envStep = new Float64Array(n); this.voiceId = new Uint32Array(n); this.chan = new Uint8Array(n);
    this.bendSemis = new Float64Array(n); this.sustained = new Uint8Array(n); this.age = new Float64Array(n); this.choke = new Int16Array(n).fill(-1);
    this.oneShot = new Uint8Array(n); this.pcmL = new Array(n).fill(null); this.pcmR = new Array(n).fill(null);
    this.loopS = new Float64Array(n).fill(-1); this.loopE = new Float64Array(n).fill(-1);
    const sorted = [...zones].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)); // 중복 zone: id 사전순 첫 zone
    for (const z of sorted) { const l = this.zonesByArt.get(z.articulation) ?? []; l.push(z); this.zonesByArt.set(z.articulation, l); }
    for (const p of pads) this.pads.set(p.padId, p);
  }

  get activeVoices(): number { let c = 0; for (let i = 0; i < this.state.length; i++) if (this.state[i] !== S_FREE) c++; return c; }

  private findZone(pitch: number, vel: number, art: string): ZoneRt | null {
    const pick = (list: ZoneRt[] | undefined) => {
      if (!list) return null;
      let best: ZoneRt | null = null; let bestDist = Infinity;
      for (const z of list) {
        if (pitch < z.minPitch || pitch > z.maxPitch || vel < z.minVelocity || vel > z.maxVelocity) continue;
        return z;
      }
      // pitch 범위 밖이면 가장 가까운 root 의 zone 으로 transpose (진단 없이 허용: 범위 확장)
      for (const z of list) { if (vel < z.minVelocity || vel > z.maxVelocity) continue; const d = Math.abs(z.rootPitch - pitch); if (d < bestDist) { bestDist = d; best = z; } }
      return best;
    };
    const z = pick(this.zonesByArt.get(art));
    if (z) return z;
    if (art !== 'normal') { this.counters.articulationFallbacks++; return pick(this.zonesByArt.get('normal')); }
    return null;
  }

  private allocVoice(): number {
    let free = -1, active = 0;
    for (let i = 0; i < this.state.length; i++) { if (this.state[i] === S_FREE) { if (free < 0) free = i; } else if (this.state[i] !== S_STEAL) active++; }
    if (active >= this.max) {
      // release 중 가장 작은 amplitude → 없으면 가장 오래된 voice
      let victim = -1, best = Infinity;
      for (let i = 0; i < this.state.length; i++) if (this.state[i] === S_RELEASE && this.env[i] * this.amp[i] < best) { best = this.env[i] * this.amp[i]; victim = i; }
      if (victim < 0) { let oldest = Infinity; for (let i = 0; i < this.state.length; i++) if ((this.state[i] === S_ATTACK || this.state[i] === S_SUSTAIN) && this.age[i] < oldest) { oldest = this.age[i]; victim = i; } }
      if (victim >= 0) { this.rampOut(victim); this.counters.voiceSteals++; }
    }
    if (free < 0) {
      // 여유 슬롯까지 모두 사용 중: 가장 오래된 steal voice 를 즉시 회수
      let oldest = Infinity;
      for (let i = 0; i < this.state.length; i++) if (this.age[i] < oldest) { oldest = this.age[i]; free = i; }
      this.counters.voiceSteals++;
    }
    return free;
  }

  private rampOut(v: number) {
    this.state[v] = S_STEAL;
    this.envStep[v] = -Math.max(this.env[v], 1e-6) / Math.max(1, (RAMP_MS * this.fs) / 1000);
  }

  noteOn(voiceId: number, pitch: number, velocity: number, channel: number, articulation: string, padId: string | null): void {
    let pcm: Pcm | null = null; let rate = 1; let gain = velocity / 127; let choke = -1; let oneShot = 0; let ls = -1, le = -1;
    if (padId !== null) {
      const pad = this.pads.get(padId);
      if (!pad?.pcm) { this.counters.missingSamples++; return; }
      pcm = pad.pcm; gain *= pad.gain; oneShot = 1; choke = pad.chokeGroup ?? -1;
      if (choke >= 0) for (let i = 0; i < this.state.length; i++) if (this.state[i] !== S_FREE && this.state[i] !== S_STEAL && this.choke[i] === choke) this.rampOut(i);
    } else {
      const z = this.findZone(pitch, velocity, articulation);
      if (!z?.pcm) { this.counters.missingSamples++; return; }
      pcm = z.pcm; rate = Math.pow(2, (pitch - z.rootPitch) / 12) * (pcm.sampleRate / this.fs);
      if (z.loopStart !== null && z.loopEnd !== null) { ls = z.loopStart; le = z.loopEnd; }
    }
    const v = this.allocVoice();
    this.state[v] = S_ATTACK; this.pos[v] = 0; this.baseRate[v] = rate; this.amp[v] = gain;
    const atk = (this.attackMs * this.fs) / 1000;
    if (atk < 1) { this.state[v] = S_SUSTAIN; this.env[v] = 1; this.envStep[v] = 0; }
    else { this.env[v] = 0; this.envStep[v] = 1 / atk; }
    this.voiceId[v] = voiceId; this.chan[v] = channel & 15; this.bendSemis[v] = 0; this.sustained[v] = 0;
    this.age[v] = this.clock++; this.choke[v] = choke; this.oneShot[v] = oneShot;
    this.pcmL[v] = pcm.channels[0]; this.pcmR[v] = pcm.channels[1] ?? pcm.channels[0];
    this.loopS[v] = ls; this.loopE[v] = le;
  }

  private release(v: number) {
    this.state[v] = S_RELEASE;
    this.envStep[v] = -Math.max(this.env[v], 1e-6) / Math.max(1, (this.releaseMs * this.fs) / 1000);
  }

  noteOff(voiceId: number): void {
    for (let i = 0; i < this.state.length; i++) {
      if (this.voiceId[i] !== voiceId || this.state[i] === S_FREE || this.state[i] === S_STEAL || this.state[i] === S_RELEASE) continue;
      if (this.oneShot[i]) continue; // drum one-shot
      if (this.sustain[this.chan[i]]) this.sustained[i] = 1; else this.release(i);
    }
  }

  cc(channel: number, controller: number, value: number): void {
    const ch = channel & 15;
    if (controller === 64) {
      const on = value >= 64 ? 1 : 0;
      this.sustain[ch] = on;
      if (!on) for (let i = 0; i < this.state.length; i++) if (this.sustained[i] && this.chan[i] === ch) { this.sustained[i] = 0; if (this.state[i] === S_ATTACK || this.state[i] === S_SUSTAIN) this.release(i); }
    } else if (controller === 120 || controller === 123) this.allNotesOff();
  }

  pitchBend(channel: number, value: number): void { this.chanBend[channel & 15] = (value / 8192) * 2; }

  expression(voiceId: number, parameterId: string, value: number): void {
    if (parameterId !== 'pitch.semitones') return;
    for (let i = 0; i < this.state.length; i++) if (this.voiceId[i] === voiceId && this.state[i] !== S_FREE) this.bendSemis[i] = value;
  }

  /** stop/seek/loop: 모든 voice 5ms ramp 로 종료, sustain 강제 해제 */
  allNotesOff(): void {
    for (let i = 0; i < this.state.length; i++) if (this.state[i] !== S_FREE && this.state[i] !== S_STEAL) this.rampOut(i);
    this.sustain.fill(0); this.sustained.fill(0); this.chanBend.fill(0);
  }

  /** panic: 즉시 무음 */
  hardReset(): void { this.state.fill(S_FREE); this.sustain.fill(0); this.sustained.fill(0); this.chanBend.fill(0); }

  /** out: stereo 누산(+=) — [start,end) 구간만 렌더 (block 내부 sample offset 처리) */
  render(out: Float32Array[], start: number, end: number, gainParam: Float32Array | null): void {
    const L = out[0], R = out[1];
    for (let v = 0; v < this.state.length; v++) {
      const st = this.state[v];
      if (st === S_FREE) continue;
      const pl = this.pcmL[v]!, pr = this.pcmR[v]!;
      const len = pl.length;
      const rate = this.baseRate[v] * Math.pow(2, (this.bendSemis[v] + this.chanBend[this.chan[v]]) / 12);
      let pos = this.pos[v], env = this.env[v]; const step = this.envStep[v]; const amp = this.amp[v];
      const ls = this.loopS[v], le = this.loopE[v];
      let state = st;
      for (let i = start; i < end; i++) {
        if (ls >= 0 && pos >= le) pos = ls + (pos - le);
        const i0 = pos | 0;
        if (i0 >= len - 1) { state = S_FREE; break; }
        const f = pos - i0;
        const g = env * amp * (gainParam ? gainParam[i] : 1);
        L[i] += (pl[i0] + (pl[i0 + 1] - pl[i0]) * f) * g;
        R[i] += (pr[i0] + (pr[i0 + 1] - pr[i0]) * f) * g;
        pos += rate;
        if (state === S_ATTACK) { env += step; if (env >= 1) { env = 1; state = S_SUSTAIN; } }
        else if (state === S_RELEASE || state === S_STEAL) { env += step; if (env <= 0) { env = 0; state = S_FREE; break; } }
      }
      this.pos[v] = pos; this.env[v] = env; this.state[v] = state;
      if (state === S_SUSTAIN && this.envStep[v] > 0) this.envStep[v] = 0;
    }
  }
}
