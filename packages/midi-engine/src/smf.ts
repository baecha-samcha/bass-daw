// SMF type 1 / division 960 내보내기·가져오기 (01 §8, 02 §7). 손실은 조용히 버리지 않고 losses[] 로 반환한다.
import type { Project, TempoPoint, MeterPoint, MidiNote, Id, Source } from '@bass-daw/schemas';
import { uuid } from '@bass-daw/schemas';
import { expandClip, type SourceCompileResult } from '@bass-daw/music-core';
import { compileMidiSource, compileDrumSource } from './adapter.ts';

export interface Loss { trackId: Id | null; kind: string; count: number; message: string }

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const text = (s: string) => Array.from(new TextEncoder().encode(s));

interface MEvent { tick: number; prio: number; seq: number; bytes: number[] }

function chunk(events: MEvent[]): number[] {
  events.sort((a, b) => a.tick - b.tick || a.prio - b.prio || a.seq - b.seq);
  const data: number[] = []; let last = 0;
  for (const e of events) { data.push(...vlq(e.tick - last), ...e.bytes); last = e.tick; }
  data.push(0, 0xff, 0x2f, 0);
  return [0x4d, 0x54, 0x72, 0x6b, ...u32(data.length), ...data];
}

/** TAB 어댑터는 tab-engine 에 있으므로 호출자가 주입한다(순환 의존 방지). */
export type TabCompiler = (s: Extract<Source, { kind: 'tab' }>) => SourceCompileResult;

export function exportMidi(p: Project, compileTab: TabCompiler): { bytes: Uint8Array; losses: Loss[] } {
  const losses: Loss[] = [];
  const conductor: MEvent[] = [];
  let seq = 0;
  conductor.push({ tick: 0, prio: 0, seq: seq++, bytes: [0xff, 0x03, ...vlq(text(p.title).length), ...text(p.title)] });
  for (const t of p.tempoMap) {
    const us = Math.round(60_000_000 / t.bpm);
    if (Math.abs(60_000_000 / us - t.bpm) > 1e-6) losses.push({ trackId: null, kind: 'tempo-rounding', count: 1, message: `tempo ${t.bpm} rounded to ${(60_000_000 / us).toFixed(6)} (µs/quarter)` });
    conductor.push({ tick: t.tick, prio: 1, seq: seq++, bytes: [0xff, 0x51, 3, (us >> 16) & 255, (us >> 8) & 255, us & 255] });
  }
  for (const m of p.meterMap) conductor.push({ tick: m.tick, prio: 1, seq: seq++, bytes: [0xff, 0x58, 4, m.numerator, Math.log2(m.denominator), 24, 8] });
  const chunks: number[][] = [chunk(conductor)];
  const sources = new Map(p.sources.map((s) => [s.id, s]));
  for (const t of [...p.tracks].sort((a, b) => a.order - b.order)) {
    if (t.kind === 'audio') { losses.push({ trackId: t.id, kind: 'audio-track', count: t.clips.length, message: `audio track "${t.name}" is not representable in MIDI (${t.clips.length} clips)` }); continue; }
    const evs: MEvent[] = [{ tick: 0, prio: 0, seq: seq++, bytes: [0xff, 0x03, ...vlq(text(t.name).length), ...text(t.name)] }];
    let tabNotes = 0, techniques = 0, strums = 0, bends = 0, strumOffsets = 0;
    for (const c of t.clips) {
      if (c.kind !== 'music') continue;
      const s = sources.get(c.sourceId)!;
      let compiled: SourceCompileResult;
      if (s.kind === 'tab') {
        compiled = compileTab(s);
        tabNotes += s.notes.length; strums += s.strums.length;
        techniques += s.notes.reduce((n, x) => n + x.techniques.filter((q) => q.kind !== 'bend').length, 0);
        bends += s.notes.reduce((n, x) => n + x.techniques.filter((q) => q.kind === 'bend').length, 0);
      } else if (s.kind === 'midi') compiled = compileMidiSource(s);
      else if (s.kind === 'drum') compiled = compileDrumSource(s);
      else continue;
      const voices = new Map<string, { pitch: number; ch: number }>();
      for (const e of expandClip(t.id, c, s.id, s.lengthTicks, compiled.events)) {
        // 스트로크 현 간격(ms)은 해당 위치 템포로 가장 가까운 tick 으로 양자화
        let tick = e.tick;
        if (e.timeOffsetSeconds) { strumOffsets++; const bpm = tempoAt(p.tempoMap, e.tick); tick += Math.round((e.timeOffsetSeconds * bpm * 960) / 60); }
        const ch = s.kind === 'drum' ? 9 : 'channel' in e ? (e as { channel: number }).channel : 0;
        if (e.kind === 'noteOn') { voices.set(e.voiceKey, { pitch: e.pitch, ch }); evs.push({ tick, prio: 3, seq: seq++, bytes: [0x90 | ch, e.pitch, e.velocity] }); }
        else if (e.kind === 'noteOff') {
          const v = voices.get(e.voiceKey);
          if (v) evs.push({ tick, prio: 1, seq: seq++, bytes: [0x80 | v.ch, v.pitch, 0] });
        } else if (e.kind === 'cc') evs.push({ tick, prio: 2, seq: seq++, bytes: [0xb0 | e.channel, e.controller, e.value] });
        else if (e.kind === 'pitchBend') { const v = e.value + 8192; evs.push({ tick, prio: 2, seq: seq++, bytes: [0xe0 | e.channel, v & 0x7f, (v >> 7) & 0x7f] }); }
      }
    }
    if (tabNotes) losses.push({ trackId: t.id, kind: 'tab-string-fret', count: tabNotes, message: `"${t.name}": string/fret positions of ${tabNotes} TAB notes are not stored in MIDI` });
    if (techniques) losses.push({ trackId: t.id, kind: 'tab-technique', count: techniques, message: `"${t.name}": ${techniques} techniques (hammer-on/pull-off/slide/mute/slap/pop) exported as plain notes` });
    if (bends) losses.push({ trackId: t.id, kind: 'tab-bend', count: bends, message: `"${t.name}": ${bends} bends (per-voice expression) not exported` });
    if (strums) losses.push({ trackId: t.id, kind: 'tab-strum', count: strums, message: `"${t.name}": ${strums} strums exported as individual notes; direction/accent pattern not preserved${strumOffsets ? `, ${strumOffsets} string offsets quantized to ticks` : ''}` });
    chunks.push(chunk(evs));
  }
  if (p.automation.length || p.channels.some((c) => c.effects.length || c.sends.length)) losses.push({ trackId: null, kind: 'mixer', count: p.automation.length, message: 'mixer, effects, sends and automation are not exported to MIDI' });
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, (chunks.length >> 8) & 255, chunks.length & 255, (960 >> 8) & 255, 960 & 255];
  return { bytes: new Uint8Array([...header, ...chunks.flat()]), losses };
}

function tempoAt(map: TempoPoint[], tick: number): number { let b = map[0].bpm; for (const t of map) if (t.tick <= tick) b = t.bpm; return b; }

// ---------------- import ----------------
export interface ImportedMidi {
  tempoMap: TempoPoint[]; meterMap: MeterPoint[];
  tracks: { name: string; notes: MidiNote[]; cc: { id: Id; tick: number; channel: number; controller: number; value: number }[]; pitchBend: { id: Id; tick: number; channel: number; value: number }[]; lengthTicks: number }[];
  losses: Loss[];
}

export function importMidi(bytes: Uint8Array): ImportedMidi {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'MThd') throw new Error('NOT_MIDI');
  const ntr = v.getUint16(10); const div = v.getUint16(12);
  if (div & 0x8000) throw new Error('SMPTE division not supported');
  const scale = 960 / div;
  const losses: Loss[] = [];
  let quantized = 0, programs = 0, sysex = 0, other = 0;
  const conv = (t: number) => { const x = t * scale; const r = Math.round(x); if (r !== x) quantized++; return r; };
  const tempoMap: TempoPoint[] = []; const meterMap: MeterPoint[] = [];
  const tracks: ImportedMidi['tracks'] = [];
  let p = 8 + v.getUint32(4);
  for (let tr = 0; tr < ntr && p < bytes.length; tr++) {
    if (tag(p) !== 'MTrk') throw new Error('BAD_TRACK');
    const len = v.getUint32(p + 4); let q = p + 8; const end = q + len; p = end;
    let tick = 0; let status = 0; let name = `Track ${tr}`;
    const on = new Map<string, { tick: number; vel: number }>();
    const notes: MidiNote[] = []; const cc: ImportedMidi['tracks'][number]['cc'] = []; const pb: ImportedMidi['tracks'][number]['pitchBend'] = [];
    const readVlq = () => { let n = 0, b; do { b = bytes[q++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    while (q < end) {
      tick += readVlq();
      let st = bytes[q];
      if (st & 0x80) { q++; status = st; } else st = status;
      const t = conv(tick);
      if (st === 0xff) {
        const type = bytes[q++]; const l = readVlq(); const d = bytes.subarray(q, q + l); q += l;
        if (type === 0x51) tempoMap.push({ tick: t, bpm: Math.round((60_000_000 / ((d[0] << 16) | (d[1] << 8) | d[2])) * 1e6) / 1e6, transition: 'step' });
        else if (type === 0x58) meterMap.push({ tick: t, numerator: d[0], denominator: (1 << d[1]) as MeterPoint['denominator'] });
        else if (type === 0x03) name = new TextDecoder().decode(d);
        else if (type === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { const l = readVlq(); q += l; sysex++; continue; }
      const kind = st & 0xf0, ch = st & 15;
      if (kind === 0x90 || kind === 0x80) {
        const pitch = bytes[q++], vel = bytes[q++];
        const key = `${ch}:${pitch}`;
        if (kind === 0x90 && vel > 0) on.set(key, { tick: t, vel });
        else { const o = on.get(key); if (o) { on.delete(key); notes.push({ id: uuid(), tick: o.tick, durationTicks: Math.max(1, t - o.tick), pitch, velocity: o.vel, channel: ch }); } }
      } else if (kind === 0xb0) { cc.push({ id: uuid(), tick: t, channel: ch, controller: bytes[q++], value: bytes[q++] }); }
      else if (kind === 0xe0) { const lsb = bytes[q++], msb = bytes[q++]; pb.push({ id: uuid(), tick: t, channel: ch, value: ((msb << 7) | lsb) - 8192 }); }
      else if (kind === 0xc0) { q += 1; programs++; }
      else if (kind === 0xd0) { q += 1; other++; }
      else if (kind === 0xa0) { q += 2; other++; }
      else throw new Error(`BAD_STATUS ${st}`);
    }
    if (notes.length || cc.length || pb.length) {
      const lengthTicks = Math.max(960, ...notes.map((n) => n.tick + n.durationTicks), ...cc.map((c) => c.tick + 1), ...pb.map((c) => c.tick + 1));
      tracks.push({ name, notes: notes.sort((a, b) => a.tick - b.tick), cc, pitchBend: pb, lengthTicks: Math.ceil(lengthTicks / 3840) * 3840 });
    }
  }
  if (!tempoMap.length || tempoMap[0].tick !== 0) tempoMap.unshift({ tick: 0, bpm: 120, transition: 'step' });
  if (!meterMap.length || meterMap[0].tick !== 0) meterMap.unshift({ tick: 0, numerator: 4, denominator: 4 });
  if (quantized) losses.push({ trackId: null, kind: 'quantization', count: quantized, message: `${quantized} events rounded to the nearest 960-PPQ tick (source division ${div})` });
  if (programs) losses.push({ trackId: null, kind: 'program-change', count: programs, message: `${programs} program changes ignored (v1)` });
  if (sysex) losses.push({ trackId: null, kind: 'sysex', count: sysex, message: `${sysex} SysEx messages ignored (v1)` });
  if (other) losses.push({ trackId: null, kind: 'aftertouch', count: other, message: `${other} aftertouch messages ignored (v1)` });
  return { tempoMap: dedupeTicks(tempoMap), meterMap: dedupeTicks(meterMap), tracks, losses };
}

function dedupeTicks<T extends { tick: number }>(a: T[]): T[] { const m = new Map<number, T>(); for (const x of a) m.set(x.tick, x); return [...m.values()].sort((x, y) => x.tick - y.tick); }
