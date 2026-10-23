// F02 / F02-M2 부하 fixture (05 §3). seed=20261022, 자체 합성 자산만 사용.
// 16 트랙: bass TAB2 + guitar TAB2 + keys MIDI4 + drum4 + (M2: sampler 4 | full: audio 4), 4 buses + master, 120bpm 4/4, 30분.
import type { Project, Asset, Source, Track, Channel, PluginInstance, AutomationLane } from '@bass-daw/schemas';
import { createEmptyProject, uuid, createChannel, createPlugin, GM_DRUM_PADS, STANDARD_TUNINGS, validateProject } from '@bass-daw/schemas';
import { seededRng, synthKit, KIT_LICENSE, encodeWav, type KitName } from '@bass-daw/audio-engine';

export interface KitAssetMap { kit: KitName; assets: Asset[] } // samples 순서와 동일
export interface F02Options { variant: 'M2' | 'full'; minutes: number; m5Load: boolean }

const BAR = 3840;

function samplerState(kit: KitName, assets: Asset[], pads: { id: string; midiPitch: number; chokeGroup: number | null }[] = []) {
  const samples = synthKit(kit);
  return {
    version: 1,
    zones: samples.flatMap((s, i) => (s.role === 'zone' ? [{ id: `${kit}-${s.articulation}-${s.rootPitch}`, assetId: assets[i].id, rootPitch: s.rootPitch, minPitch: s.minPitch, maxPitch: s.maxPitch, minVelocity: 1, maxVelocity: 127, articulation: s.articulation, loopStartFrame: null, loopEndFrame: null }] : [])),
    pads: samples.flatMap((s, i) => (s.role === 'pad' ? pads.filter((p) => p.midiPitch === s.rootPitch).map((p) => ({ padId: p.id, assetId: assets[i].id, gain: 1, chokeGroup: p.chokeGroup })) : [])),
    attackMs: 2, releaseMs: 90,
  };
}

/** 60초 mono 48k float 합성 "보컬 대용" 신호 (재배포 가능) */
export function f02AudioWav(seed: number): Uint8Array {
  const r = seededRng(seed); const sr = 48000; const n = sr * 60; const x = new Float32Array(n);
  let ph = 0; let f = 220;
  for (let i = 0; i < n; i++) {
    if (i % (sr / 4) === 0) f = 180 + Math.floor(r() * 8) * 30;
    ph += (2 * Math.PI * f) / sr;
    const env = 0.5 + 0.5 * Math.sin((2 * Math.PI * i) / (sr * 2));
    x[i] = 0.25 * env * (Math.sin(ph) + 0.3 * Math.sin(2 * ph)) + 0.01 * (r() * 2 - 1);
  }
  return encodeWav({ sampleRate: sr, channels: [x], frames: n }, 'wav-float32');
}

export function buildF02(kits: Record<KitName, Asset[]>, audio: Asset[], o: F02Options): Project {
  const r = seededRng(20261022);
  const p = createEmptyProject({ title: `F02${o.variant === 'M2' ? '-M2' : ''} (${o.minutes}min${o.m5Load ? ', M5 load' : ''})` });
  const master = p.masterChannelId;
  const buses: Channel[] = [1, 2, 3, 4].map((i) => createChannel('bus', `Bus ${i}`, master));
  p.channels.push(...buses);
  for (const list of Object.values(kits)) for (const a of list) if (!p.assets.some((x) => x.id === a.id)) p.assets.push(a);
  p.assets.push(...audio);
  const totalBars = Math.ceil((o.minutes * 60 * 2) / 4); // 120bpm → 2 beats/s
  const srcBars = 128;
  const notesPerTrack = Math.round(10000 / 12);
  let order = 0;
  const addTrack = (kind: Track['kind'], name: string, kit: KitName | null, makeSource: (() => Source) | null, busIdx: number) => {
    const ch = { ...createChannel('track', name, buses[busIdx].id), gain: 0.2 }; // 16트랙 합산 클리핑 방지
    p.channels.push(ch);
    let inst: PluginInstance | null = null;
    const t: Track = { id: uuid(), name, color: ['#e07a5f', '#3d9970', '#4f86c6', '#c9a227'][busIdx], order: order++, kind, channelId: ch.id, muted: false, solo: false, clips: [], instrumentSlot: null };
    if (makeSource) {
      const s = makeSource(); p.sources.push(s);
      if (kit) {
        const pads = s.kind === 'drum' ? s.pads : [];
        inst = createPlugin('builtin.sampler', samplerState(kit, kits[kit], pads) as never);
        inst.assets = kits[kit].map((a) => a.id);
        p.plugins.push(inst); t.instrumentSlot = inst.instanceId;
      }
      const len = (s as { lengthTicks: number }).lengthTicks;
      for (let start = 0; start < totalBars * BAR; start += len) t.clips.push({ id: uuid(), kind: 'music', sourceId: s.id, name, muted: false, startTick: start, durationTicks: Math.min(len, totalBars * BAR - start), sourceOffsetTick: 0, loopSource: false });
    }
    p.tracks.push(t);
    return { t, ch };
  };
  const tabSource = (inst: 'bass' | 'guitar'): Source => {
    const tuning = [...(inst === 'bass' ? STANDARD_TUNINGS.bass4 : STANDARD_TUNINGS.guitar6)];
    const notes = []; const step = Math.floor((srcBars * BAR) / notesPerTrack / 120) * 120 || 120;
    const lastEnd = new Array(tuning.length).fill(0);
    for (let i = 0, t = 0; i < notesPerTrack && t < srcBars * BAR - step; i++, t += step) {
      const si = Math.floor(r() * tuning.length);
      if (t < lastEnd[si]) continue;
      const dur = step;
      notes.push({ id: uuid(), tick: t, durationTicks: dur, stringIndex: si, fret: Math.floor(r() * 12), velocity: 70 + Math.floor(r() * 50), techniques: r() < 0.08 ? [{ kind: 'mute' as const }] : [] });
      lastEnd[si] = t + dur;
    }
    return { id: uuid(), kind: 'tab', lengthTicks: srcBars * BAR, instrument: inst, tuning, maxFret: 24, notes, strums: [] };
  };
  const midiSource = (lo: number): Source => {
    const notes = []; const step = Math.floor((srcBars * BAR) / notesPerTrack / 60) * 60 || 60;
    for (let i = 0, t = 0; i < notesPerTrack && t < srcBars * BAR - step; i++, t += step) notes.push({ id: uuid(), tick: t, durationTicks: step, pitch: lo + Math.floor(r() * 24), velocity: 60 + Math.floor(r() * 60), channel: 0 });
    return { id: uuid(), kind: 'midi', lengthTicks: srcBars * BAR, notes, cc: [{ id: uuid(), tick: 0, channel: 0, controller: 64, value: 0 }], pitchBend: [] };
  };
  const drumSource = (pattern: number): Source => {
    const pads = GM_DRUM_PADS.map((x) => ({ id: uuid(), ...x }));
    const hits = []; const step = 240;
    for (let t = 0, i = 0; t < srcBars * BAR && i < notesPerTrack; t += step) {
      const pad = pads[(pattern * 3 + Math.floor(t / step)) % 3 === 0 ? 0 : r() < 0.5 ? 2 : 1 + Math.floor(r() * 7)];
      if (r() < 0.45) { hits.push({ id: uuid(), tick: t, padId: pad.id, velocity: 70 + Math.floor(r() * 57) }); i++; }
    }
    return { id: uuid(), kind: 'drum', lengthTicks: srcBars * BAR, hits, pads };
  };
  const made: { t: Track; ch: Channel }[] = [];
  made.push(addTrack('tab', 'Bass 1', 'bass', () => tabSource('bass'), 0), addTrack('tab', 'Bass 2', 'bass', () => tabSource('bass'), 0));
  made.push(addTrack('tab', 'Guitar 1', 'guitar', () => tabSource('guitar'), 1), addTrack('tab', 'Guitar 2', 'guitar', () => tabSource('guitar'), 1));
  for (let i = 0; i < 4; i++) made.push(addTrack('midi', `Keys ${i + 1}`, 'keys', () => midiSource(48 + i * 6), 2));
  for (let i = 0; i < 4; i++) made.push(addTrack('drum', `Drums ${i + 1}`, 'drums', () => drumSource(i), 3));
  if (o.variant === 'M2') {
    // F02-M2: audio 4개를 같은 길이의 sampler fixture 로 대체
    for (let i = 0; i < 4; i++) made.push(addTrack('midi', `Sampler-for-audio ${i + 1}`, 'keys', () => ({ id: uuid(), kind: 'midi', lengthTicks: 30 * BAR, notes: [{ id: uuid(), tick: 0, durationTicks: 30 * BAR, pitch: 50 + i * 5, velocity: 70, channel: 0 }], cc: [], pitchBend: [] }), 2));
  } else {
    for (let i = 0; i < 4; i++) {
      const m = addTrack('audio', `Audio ${i + 1}`, null, null, 2); made.push(m); const t = m.t;
      const a = audio[i];
      const s: Source = { id: uuid(), kind: 'audio', assetId: a.id }; p.sources.push(s);
      for (let sec = 0; sec < o.minutes * 60; sec += 60) t.clips.push({ id: uuid(), kind: 'audio', sourceId: s.id, name: `vox ${i + 1}`, muted: false, startSeconds: sec, sourceStartFrame: 0, sourceFrameCount: a.audio!.frameCount, gain: 0.8, fadeInFrames: 240, fadeOutFrames: 240 });
    }
  }
  if (o.m5Load) {
    // M5 부하: 16 channel EQ, compressor 4, reverb 1, sends 8, 자동화 32 lane × 10점/초
    for (const m of made) { const eq = createPlugin('builtin.eq', { version: 1 }); p.plugins.push(eq); m.ch.effects.push(eq.instanceId); }
    buses.forEach((b) => { const c = createPlugin('builtin.compressor', { version: 1 }); p.plugins.push(c); b.effects.push(c.instanceId); });
    const fx = createChannel('bus', 'Reverb', master); p.channels.push(fx);
    const rv = createPlugin('builtin.reverb', { version: 1, irAssetId: null }); p.plugins.push(rv); fx.effects.push(rv.instanceId);
    made.slice(0, 8).forEach((m) => m.ch.sends.push({ id: uuid(), targetChannelId: fx.id, gain: 0.3, tap: 'post' }));
    const totalTicks = totalBars * BAR; const stepT = 192; // 10 pts/s @120bpm (1920 tick/s)
    made.forEach((m, i) => {
      for (const param of ['gain', 'pan'] as const) {
        const pts = [];
        for (let t = 0, j = 0; t < totalTicks; t += stepT, j++) pts.push({ tick: t, value: param === 'gain' ? 0.6 + 0.3 * Math.sin(j / 50 + i) : 0.5 * Math.sin(j / 70 + i), interpolation: 'linear' as const });
        p.automation.push({ id: uuid(), target: { owner: 'channel', ownerId: m.ch.id, parameterId: param }, enabled: true, points: pts } as AutomationLane);
      }
    });
  }
  p.loop = { enabled: false, startTick: 0, endTick: 8 * BAR };
  const v = validateProject(p);
  if (!v.ok) throw new Error(`F02 invalid: ${JSON.stringify(v.errors.slice(0, 3))}`);
  return p;
}

export function kitAssetTemplates(kit: KitName, hashes: { hash: string; bytes: number }[]): Asset[] {
  return synthKit(kit).map((s, i) => ({ id: uuid(), sha256: hashes[i].hash, byteLength: hashes[i].bytes, mediaType: 'audio/wav', audio: { sampleRate: 48000, channels: 1, frameCount: (s.bytes.length - 44) / 2 }, license: { ...KIT_LICENSE } }));
}
