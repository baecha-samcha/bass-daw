// 02 §6 불변조건 검증기. 구조(알 수 없는 필드 거절) → 의미(참조·범위·DAG) 순서로 검사한다.
// 검증은 입력을 변경하지 않는다.
import type { Project, Result, ResultError, Source, TabSource, Channel } from './types.ts';
import { BUILTIN_DESCRIPTORS, PARAM_ID_RE, PLUGIN_ID_RE, CHANNEL_PARAMETERS, findDescriptor } from './plugin-contracts.ts';
import { SHA256_RE } from './sha256.ts';

export const LIMITS = {
  jsonBytes: 32 * 1024 * 1024,
  nesting: 32,
  title: 256,
  metadataBytes: 64 * 1024,
  pluginStateBytes: 1024 * 1024,
  pluginStateTotalBytes: 16 * 1024 * 1024,
  tracks: 128,
  clips: 20_000,
  sourceEvents: 1_000_000,
  assets: 10_000,
  plugins: 512,
  pointsPerLane: 100_000,
} as const;

type Ctx = { errors: ResultError[] };
type Check = (v: unknown, path: string, ctx: Ctx) => void;

const err = (ctx: Ctx, code: string, path: string, message: string) => {
  if (ctx.errors.length < 200) ctx.errors.push({ code, path, message });
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (o: { max?: number; min?: number; re?: RegExp; oneOf?: readonly string[] } = {}): Check => (v, path, ctx) => {
  if (typeof v !== 'string') return err(ctx, 'INVALID_FIELD', path, 'string expected');
  if (o.min !== undefined && v.length < o.min) err(ctx, 'INVALID_FIELD', path, `length < ${o.min}`);
  if (o.max !== undefined && v.length > o.max) err(ctx, 'INVALID_LIMIT', path, `length > ${o.max}`);
  if (o.re && !o.re.test(v)) err(ctx, 'INVALID_FIELD', path, `pattern ${o.re}`);
  if (o.oneOf && !o.oneOf.includes(v)) err(ctx, 'INVALID_FIELD', path, `one of ${o.oneOf.join('|')}`);
};
const num = (min = -Infinity, max = Infinity, integer = false): Check => (v, path, ctx) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return err(ctx, 'INVALID_FIELD', path, 'finite number expected');
  if (integer && !Number.isSafeInteger(v)) return err(ctx, 'INVALID_FIELD', path, 'safe integer expected');
  if (v < min || v > max) err(ctx, 'INVALID_FIELD', path, `range ${min}..${max}`);
};
const int = (min = 0, max = Number.MAX_SAFE_INTEGER) => num(min, max, true);
const bool: Check = (v, path, ctx) => { if (typeof v !== 'boolean') err(ctx, 'INVALID_FIELD', path, 'boolean expected'); };
const lit = (x: unknown): Check => (v, path, ctx) => { if (v !== x) err(ctx, 'INVALID_FIELD', path, `must be ${JSON.stringify(x)}`); };
const nullable = (c: Check): Check => (v, path, ctx) => { if (v !== null) c(v, path, ctx); };
const arr = (item: Check, max = Infinity, limitCode = 'INVALID_LIMIT'): Check => (v, path, ctx) => {
  if (!Array.isArray(v)) return err(ctx, 'INVALID_FIELD', path, 'array expected');
  if (v.length > max) return err(ctx, limitCode, path, `more than ${max} items`);
  v.forEach((x, i) => item(x, `${path}[${i}]`, ctx));
};
const obj = (shape: Record<string, Check>): Check => (v, path, ctx) => {
  if (!isObj(v)) return err(ctx, 'INVALID_FIELD', path, 'object expected');
  for (const k of Object.keys(v)) if (!(k in shape)) err(ctx, 'INVALID_FIELD', `${path}.${k}`, 'unknown field');
  for (const [k, c] of Object.entries(shape)) {
    if (!(k in v)) err(ctx, 'INVALID_FIELD', `${path}.${k}`, 'missing field');
    else c(v[k], `${path}.${k}`, ctx);
  }
};
const disc = (key: string, variants: Record<string, Check>): Check => (v, path, ctx) => {
  if (!isObj(v)) return err(ctx, 'INVALID_FIELD', path, 'object expected');
  const c = variants[String(v[key])];
  if (!c) return err(ctx, 'INVALID_FIELD', `${path}.${key}`, `one of ${Object.keys(variants).join('|')}`);
  c(v, path, ctx);
};
const jsonValue = (maxDepth: number): Check => (v, path, ctx) => {
  const walk = (x: unknown, d: number, p: string): void => {
    if (d > maxDepth) return err(ctx, 'INVALID_LIMIT', p, 'nesting too deep');
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return;
    if (typeof x === 'number') { if (!Number.isFinite(x)) err(ctx, 'INVALID_FIELD', p, 'finite number expected'); return; }
    if (Array.isArray(x)) { x.forEach((y, i) => walk(y, d + 1, `${p}[${i}]`)); return; }
    if (isObj(x)) { for (const [k, y] of Object.entries(x)) walk(y, d + 1, `${p}.${k}`); return; }
    err(ctx, 'INVALID_FIELD', p, 'JSON value expected');
  };
  walk(v, 1, path);
};
const recordOf = (val: Check): Check => (v, path, ctx) => {
  if (!isObj(v)) return err(ctx, 'INVALID_FIELD', path, 'object expected');
  for (const [k, x] of Object.entries(v)) val(x, `${path}.${k}`, ctx);
};

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const id = str({ min: 1, max: 128 });
const tick = int(0);
const velocity = int(1, 127);
const u7 = int(0, 127);

const technique = disc('kind', {
  mute: obj({ kind: str() }), slap: obj({ kind: str() }), pop: obj({ kind: str() }),
  'hammer-on': obj({ kind: str(), targetNoteId: id }),
  'pull-off': obj({ kind: str(), targetNoteId: id }),
  slide: obj({ kind: str(), targetNoteId: id }),
  bend: obj({ kind: str(), points: arr(obj({ offsetTick: tick, semitones: num(-12, 12) }), 1024) }),
});

const sourceCheck = disc('kind', {
  tab: obj({
    id, kind: str(), lengthTicks: int(1), instrument: str({ oneOf: ['bass', 'guitar'] }),
    tuning: arr(u7, 7), maxFret: int(1, 36),
    notes: arr(obj({ id, tick, durationTicks: int(1), stringIndex: int(0, 6), fret: int(0, 36), velocity, techniques: arr(technique, 8) })),
    strums: arr(obj({
      id, tick, durationTicks: int(1), chordName: nullable(str({ max: 64 })),
      strings: arr(obj({ stringIndex: int(0, 6), fret: nullable(int(0, 36)), velocity }), 7),
      direction: str({ oneOf: ['down', 'up'] }), spreadMs: num(0, 100), accent: num(0, 2),
      arpeggio: nullable(obj({ order: arr(int(0, 6), 64), stepTicks: int(1) })),
    })),
  }),
  midi: obj({
    id, kind: str(), lengthTicks: int(1),
    notes: arr(obj({ id, tick, durationTicks: int(1), pitch: u7, velocity, channel: int(0, 15) })),
    cc: arr(obj({ id, tick, channel: int(0, 15), controller: u7, value: u7 })),
    pitchBend: arr(obj({ id, tick, channel: int(0, 15), value: int(-8192, 8191) })),
  }),
  drum: obj({
    id, kind: str(), lengthTicks: int(1),
    hits: arr(obj({ id, tick, padId: id, velocity })),
    pads: arr(obj({ id, name: str({ max: 64 }), midiPitch: u7, chokeGroup: nullable(int(0, 15)) }), 128),
  }),
  audio: obj({ id, kind: str(), assetId: id }),
});

// 구조 공유 덕분에 변경되지 않은 source 는 같은 객체이다. 검증을 통과한 source 객체(동결 가정)의
// 구조·내부 검사를 건너뛴다. 전역 ID 중복 검사는 매번 수행한다. 명령 경로 외 제자리 변경은 금지.
const validSources = new WeakSet<object>();
const cachedSourceCheck: Check = (v, path, ctx) => {
  if (typeof v === 'object' && v !== null && validSources.has(v)) return;
  sourceCheck(v, path, ctx);
};

const clipCheck = disc('kind', {
  music: obj({ id, kind: str(), sourceId: id, name: str({ max: 256 }), muted: bool, startTick: tick, durationTicks: int(1), sourceOffsetTick: tick, loopSource: bool }),
  audio: obj({ id, kind: str(), sourceId: id, name: str({ max: 256 }), muted: bool, startSeconds: num(0, 1e7), sourceStartFrame: int(0), sourceFrameCount: int(1), gain: num(0, 4), fadeInFrames: int(0), fadeOutFrames: int(0) }),
});

const projectShape = obj({
  format: lit('bass-daw-project'), schemaVersion: lit(1), id,
  title: str({ max: LIMITS.title }), createdAt: str({ re: ISO_UTC }), updatedAt: str({ re: ISO_UTC }), ppq: lit(960),
  tempoMap: arr(obj({ tick, bpm: num(20, 400), transition: lit('step') }), 10_000),
  meterMap: arr(obj({ tick, numerator: int(1, 32), denominator: (v, p, c) => { if (![1, 2, 4, 8, 16, 32].includes(v as number)) err(c, 'INVALID_FIELD', p, 'denominator 1|2|4|8|16|32'); } }), 10_000),
  tracks: arr(obj({
    id, name: str({ max: 256 }), color: str({ max: 32 }), order: int(0),
    kind: str({ oneOf: ['tab', 'midi', 'drum', 'audio'] }), channelId: id, muted: bool, solo: bool,
    clips: arr(clipCheck, LIMITS.clips), instrumentSlot: nullable(id),
  }), LIMITS.tracks),
  sources: arr(cachedSourceCheck, 1_000_000),
  assets: arr(obj({
    id, sha256: str({ re: SHA256_RE }), byteLength: int(0), mediaType: str({ max: 128 }),
    audio: nullable(obj({ sampleRate: int(8000, 192000), channels: int(1, 2), frameCount: int(1) })),
    license: obj({ name: str({ max: 256 }), origin: str({ max: 1024 }), redistribution: str({ oneOf: ['allowed', 'unknown', 'forbidden'] }) }),
  }), LIMITS.assets),
  channels: arr(obj({
    id, kind: str({ oneOf: ['track', 'bus', 'master'] }), name: str({ max: 256 }),
    gain: num(0, 4), pan: num(-1, 1), muted: bool, solo: bool, output: nullable(id), effects: arr(id, 64),
    sends: arr(obj({ id, targetChannelId: id, gain: num(0, 4), tap: str({ oneOf: ['pre', 'post'] }) }), 64),
  }), 4096),
  masterChannelId: id,
  plugins: arr(obj({
    instanceId: id, pluginId: str({ re: PLUGIN_ID_RE, max: 128 }), pluginVersion: str({ min: 1, max: 64 }), stateVersion: int(0),
    role: str({ oneOf: ['instrument', 'effect'] }), state: jsonValue(LIMITS.nesting - 4),
    parameters: recordOf(num()), assets: arr(id, 10_000),
  }), LIMITS.plugins),
  automation: arr(obj({
    id, target: obj({ owner: str({ oneOf: ['channel', 'plugin'] }), ownerId: id, parameterId: str({ re: PARAM_ID_RE }) }),
    enabled: bool,
    points: arr(obj({ tick, value: num(), interpolation: str({ oneOf: ['step', 'linear'] }) }), LIMITS.pointsPerLane),
  }), 10_000),
  loop: obj({ enabled: bool, startTick: tick, endTick: tick }),
  metadata: recordOf(str()),
});

export function ticksPerBar(numerator: number, denominator: number): number {
  return (numerator * 960 * 4) / denominator;
}

function semantic(p: Project, ctx: Ctx): void {
  const ids = new Map<string, string>();
  const claim = (v: string, path: string) => {
    const prev = ids.get(v);
    if (prev !== undefined) err(ctx, 'DUPLICATE_ID', path, `id ${v} already used at ${prev}`);
    else ids.set(v, path);
  };
  claim(p.id, '$.id');

  if (Date.parse(p.updatedAt) < Date.parse(p.createdAt)) err(ctx, 'INVALID_FIELD', '$.updatedAt', 'updatedAt < createdAt');

  const metaBytes = Object.entries(p.metadata).reduce((s, [k, v]) => s + k.length + v.length, 0);
  if (metaBytes > LIMITS.metadataBytes) err(ctx, 'INVALID_LIMIT', '$.metadata', 'metadata > 64KiB');

  // tempo / meter
  if (p.tempoMap.length === 0 || p.tempoMap[0].tick !== 0) err(ctx, 'INVALID_FIELD', '$.tempoMap', 'tick 0 required');
  for (let i = 1; i < p.tempoMap.length; i++) if (p.tempoMap[i].tick <= p.tempoMap[i - 1].tick) err(ctx, 'INVALID_FIELD', `$.tempoMap[${i}].tick`, 'strictly ascending');
  if (p.meterMap.length === 0 || p.meterMap[0].tick !== 0) err(ctx, 'INVALID_FIELD', '$.meterMap', 'tick 0 required');
  for (let i = 1; i < p.meterMap.length; i++) {
    const a = p.meterMap[i - 1], b = p.meterMap[i];
    if (b.tick <= a.tick) err(ctx, 'INVALID_FIELD', `$.meterMap[${i}].tick`, 'strictly ascending');
    else if ((b.tick - a.tick) % ticksPerBar(a.numerator, a.denominator) !== 0) err(ctx, 'INVALID_FIELD', `$.meterMap[${i}].tick`, 'meter change must be on a bar boundary');
  }
  if (p.loop.endTick <= p.loop.startTick) err(ctx, 'INVALID_FIELD', '$.loop', 'endTick > startTick');

  // assets
  const assets = new Map(p.assets.map((a) => [a.id, a]));
  p.assets.forEach((a, i) => claim(a.id, `$.assets[${i}]`));

  // sources
  const sources = new Map<string, Source>();
  let events = 0;
  p.sources.forEach((s, i) => {
    const sp = `$.sources[${i}]`;
    claim(s.id, sp);
    sources.set(s.id, s);
    if (validSources.has(s)) { events += claimCachedSource(s, sp, claim); return; }
    const before = ctx.errors.length;
    try { validateSourceInternal(s, sp); } finally { if (ctx.errors.length === before && s.kind !== 'audio') validSources.add(s); }
  });
  function validateSourceInternal(s: Source, sp: string): void {
    if (s.kind === 'tab') events += s.notes.length + s.strums.length, checkTab(s, sp, ctx, claim);
    else if (s.kind === 'midi') {
      events += s.notes.length + s.cc.length + s.pitchBend.length;
      s.notes.forEach((n, j) => { claim(n.id, `${sp}.notes[${j}]`); if (n.tick + n.durationTicks > s.lengthTicks) err(ctx, 'INVALID_FIELD', `${sp}.notes[${j}]`, 'note exceeds source length'); });
      s.cc.forEach((n, j) => { claim(n.id, `${sp}.cc[${j}]`); if (n.tick >= s.lengthTicks) err(ctx, 'INVALID_FIELD', `${sp}.cc[${j}]`, 'cc exceeds source length'); });
      s.pitchBend.forEach((n, j) => { claim(n.id, `${sp}.pitchBend[${j}]`); if (n.tick >= s.lengthTicks) err(ctx, 'INVALID_FIELD', `${sp}.pitchBend[${j}]`, 'pitch bend exceeds source length'); });
    } else if (s.kind === 'drum') {
      events += s.hits.length;
      const pads = new Set<string>();
      s.pads.forEach((pd, j) => { if (pads.has(pd.id)) err(ctx, 'DUPLICATE_ID', `${sp}.pads[${j}]`, 'duplicate pad id'); pads.add(pd.id); });
      s.hits.forEach((h, j) => {
        claim(h.id, `${sp}.hits[${j}]`);
        if (!pads.has(h.padId)) err(ctx, 'BROKEN_REFERENCE', `${sp}.hits[${j}].padId`, 'unknown pad');
        if (h.tick >= s.lengthTicks) err(ctx, 'INVALID_FIELD', `${sp}.hits[${j}]`, 'hit exceeds source length');
      });
    } else if (s.kind === 'audio') {
      const a = assets.get(s.assetId);
      if (!a) err(ctx, 'BROKEN_REFERENCE', `${sp}.assetId`, 'unknown asset');
      else if (!a.audio) err(ctx, 'INVALID_FIELD', `${sp}.assetId`, 'asset has no audio metadata');
    }
  }
  if (events > LIMITS.sourceEvents) err(ctx, 'INVALID_LIMIT', '$.sources', 'too many source events');

  // plugins
  const plugins = new Map(p.plugins.map((x) => [x.instanceId, x]));
  let stateTotal = 0;
  p.plugins.forEach((pl, i) => {
    const pp = `$.plugins[${i}]`;
    claim(pl.instanceId, pp);
    const bytes = JSON.stringify(pl.state).length;
    stateTotal += bytes;
    if (bytes > LIMITS.pluginStateBytes) err(ctx, 'INVALID_LIMIT', `${pp}.state`, 'plugin state > 1MiB');
    pl.assets.forEach((a, j) => { if (!assets.has(a)) err(ctx, 'BROKEN_REFERENCE', `${pp}.assets[${j}]`, 'unknown asset'); });
    const desc = BUILTIN_DESCRIPTORS[pl.pluginId];
    if (desc && desc.role !== pl.role) err(ctx, 'INVALID_FIELD', `${pp}.role`, 'role does not match builtin descriptor');
    for (const [k, v] of Object.entries(pl.parameters)) {
      if (!PARAM_ID_RE.test(k)) err(ctx, 'INVALID_FIELD', `${pp}.parameters.${k}`, 'invalid parameter id');
      const d = findDescriptor(pl.pluginId, k);
      if (d && (v < d.min || v > d.max)) err(ctx, 'INVALID_FIELD', `${pp}.parameters.${k}`, `range ${d.min}..${d.max}`);
    }
  });
  if (stateTotal > LIMITS.pluginStateTotalBytes) err(ctx, 'INVALID_LIMIT', '$.plugins', 'total plugin state > 16MiB');

  // channels & routing
  const channels = new Map<string, Channel>();
  p.channels.forEach((c, i) => { claim(c.id, `$.channels[${i}]`); channels.set(c.id, c); });
  const masters = p.channels.filter((c) => c.kind === 'master');
  const master = channels.get(p.masterChannelId);
  if (masters.length !== 1 || !master || master.kind !== 'master') err(ctx, 'INVALID_ROUTING', '$.masterChannelId', 'exactly one master channel required');
  const slotUse = new Map<string, string>();
  const useSlot = (pid: string, path: string, role: 'instrument' | 'effect') => {
    const pl = plugins.get(pid);
    if (!pl) return err(ctx, 'BROKEN_REFERENCE', path, 'unknown plugin instance');
    if (pl.role !== role) err(ctx, 'INVALID_FIELD', path, `plugin role must be ${role}`);
    if (slotUse.has(pid)) err(ctx, 'INVALID_ROUTING', path, `plugin already used at ${slotUse.get(pid)}`);
    slotUse.set(pid, path);
  };
  p.channels.forEach((c, i) => {
    const cp = `$.channels[${i}]`;
    if (c.kind === 'master') { if (c.output !== null) err(ctx, 'INVALID_ROUTING', `${cp}.output`, 'master output must be null'); }
    else if (c.output === null) err(ctx, 'INVALID_ROUTING', `${cp}.output`, 'output required');
    else {
      const o = channels.get(c.output);
      if (!o) err(ctx, 'BROKEN_REFERENCE', `${cp}.output`, 'unknown channel');
      else if (o.kind === 'track') err(ctx, 'INVALID_ROUTING', `${cp}.output`, 'cannot output to a track channel');
    }
    c.effects.forEach((e, j) => useSlot(e, `${cp}.effects[${j}]`, 'effect'));
    c.sends.forEach((s, j) => {
      claim(s.id, `${cp}.sends[${j}]`);
      const t = channels.get(s.targetChannelId);
      if (!t) err(ctx, 'BROKEN_REFERENCE', `${cp}.sends[${j}].targetChannelId`, 'unknown channel');
      else if (t.kind === 'track') err(ctx, 'INVALID_ROUTING', `${cp}.sends[${j}]`, 'cannot send to a track channel');
      if (s.targetChannelId === c.id) err(ctx, 'INVALID_ROUTING', `${cp}.sends[${j}]`, 'self send');
    });
  });
  const cycle = findRoutingCycle(p.channels);
  if (cycle) err(ctx, 'INVALID_ROUTING', '$.channels', `feedback cycle: ${cycle.join(' -> ')}`);
  else if (master) {
    for (const [i, c] of p.channels.entries()) {
      let cur: Channel | undefined = c; let guard = 0;
      while (cur && cur.output !== null && guard++ < 5000) cur = channels.get(cur.output);
      if (!cur || cur.id !== master.id) err(ctx, 'INVALID_ROUTING', `$.channels[${i}]`, 'does not reach master');
    }
  }

  // tracks & clips
  const trackChannels = new Map<string, string>();
  const orders = new Set<number>();
  let clipCount = 0;
  p.tracks.forEach((t, i) => {
    const tp = `$.tracks[${i}]`;
    claim(t.id, tp);
    if (orders.has(t.order)) err(ctx, 'INVALID_FIELD', `${tp}.order`, 'duplicate order'); orders.add(t.order);
    const ch = channels.get(t.channelId);
    if (!ch) err(ctx, 'BROKEN_REFERENCE', `${tp}.channelId`, 'unknown channel');
    else if (ch.kind !== 'track') err(ctx, 'INVALID_ROUTING', `${tp}.channelId`, 'track must use a track channel');
    if (trackChannels.has(t.channelId)) err(ctx, 'INVALID_ROUTING', `${tp}.channelId`, 'channel already used by another track');
    trackChannels.set(t.channelId, t.id);
    if (t.kind === 'audio') { if (t.instrumentSlot !== null) err(ctx, 'INVALID_FIELD', `${tp}.instrumentSlot`, 'audio track has no instrument'); }
    else if (t.instrumentSlot !== null) useSlot(t.instrumentSlot, `${tp}.instrumentSlot`, 'instrument');
    clipCount += t.clips.length;
    t.clips.forEach((c, j) => {
      const cp = `${tp}.clips[${j}]`;
      claim(c.id, cp);
      const s = sources.get(c.sourceId);
      if (!s) return err(ctx, 'BROKEN_REFERENCE', `${cp}.sourceId`, 'unknown source');
      if (s.kind !== t.kind) return err(ctx, 'INVALID_FIELD', `${cp}.sourceId`, `source kind ${s.kind} does not match track kind ${t.kind}`);
      if (c.kind === 'music') {
        if (s.kind === 'audio') return err(ctx, 'INVALID_FIELD', cp, 'music clip on audio source');
        if (c.loopSource) { if (c.sourceOffsetTick >= s.lengthTicks) err(ctx, 'INVALID_FIELD', `${cp}.sourceOffsetTick`, 'offset < source length required'); }
        else if (c.sourceOffsetTick + c.durationTicks > s.lengthTicks) err(ctx, 'INVALID_FIELD', cp, 'offset + duration exceeds source length');
        if (!Number.isSafeInteger(c.startTick + c.durationTicks)) err(ctx, 'INVALID_FIELD', cp, 'tick overflow');
      } else {
        if (s.kind !== 'audio') return err(ctx, 'INVALID_FIELD', cp, 'audio clip on music source');
        const a = assets.get(s.assetId);
        if (a?.audio && c.sourceStartFrame + c.sourceFrameCount > a.audio.frameCount) err(ctx, 'INVALID_FIELD', cp, 'selection exceeds frameCount');
        if (c.fadeInFrames + c.fadeOutFrames > c.sourceFrameCount) err(ctx, 'INVALID_FIELD', cp, 'fades exceed selection');
      }
    });
  });
  for (const c of p.channels) if (c.kind === 'track' && !trackChannels.has(c.id)) err(ctx, 'INVALID_ROUTING', `$.channels[${p.channels.indexOf(c)}]`, 'track channel without track');
  if (clipCount > LIMITS.clips) err(ctx, 'INVALID_LIMIT', '$.tracks', 'too many clips');

  // automation
  const targets = new Set<string>();
  p.automation.forEach((l, i) => {
    const lp = `$.automation[${i}]`;
    claim(l.id, lp);
    const key = `${l.target.owner}:${l.target.ownerId}:${l.target.parameterId}`;
    if (targets.has(key)) err(ctx, 'DUPLICATE_ID', `${lp}.target`, 'target already automated'); targets.add(key);
    let range: { min: number; max: number } | undefined;
    if (l.target.owner === 'channel') {
      if (!channels.has(l.target.ownerId)) err(ctx, 'BROKEN_REFERENCE', `${lp}.target.ownerId`, 'unknown channel');
      range = CHANNEL_PARAMETERS.find((d) => d.id === l.target.parameterId);
      if (!range) err(ctx, 'INVALID_FIELD', `${lp}.target.parameterId`, 'channel parameter must be gain|pan');
    } else {
      const pl = plugins.get(l.target.ownerId);
      if (!pl) err(ctx, 'BROKEN_REFERENCE', `${lp}.target.ownerId`, 'unknown plugin instance');
      else {
        range = findDescriptor(pl.pluginId, l.target.parameterId);
        if (BUILTIN_DESCRIPTORS[pl.pluginId] && !range) err(ctx, 'INVALID_FIELD', `${lp}.target.parameterId`, 'unknown parameter');
        else if (range && 'automation' in range && (range as { automation: string }).automation === 'none') err(ctx, 'INVALID_FIELD', `${lp}.target.parameterId`, 'parameter is not automatable');
      }
    }
    l.points.forEach((pt, j) => {
      if (j > 0 && pt.tick <= l.points[j - 1].tick) err(ctx, 'INVALID_FIELD', `${lp}.points[${j}].tick`, 'strictly ascending');
      if (range && (pt.value < range.min || pt.value > range.max)) err(ctx, 'INVALID_FIELD', `${lp}.points[${j}].value`, `range ${range.min}..${range.max}`);
    });
  });
}

function claimCachedSource(s: Source, sp: string, claim: (v: string, path: string) => void): number {
  switch (s.kind) {
    case 'tab': for (const n of s.notes) claim(n.id, sp); for (const n of s.strums) claim(n.id, sp); return s.notes.length + s.strums.length;
    case 'midi': for (const n of s.notes) claim(n.id, sp); for (const n of s.cc) claim(n.id, sp); for (const n of s.pitchBend) claim(n.id, sp); return s.notes.length + s.cc.length + s.pitchBend.length;
    case 'drum': for (const n of s.hits) claim(n.id, sp); return s.hits.length;
    case 'audio': return 0;
  }
}

function checkTab(s: TabSource, sp: string, ctx: Ctx, claim: (v: string, path: string) => void): void {
  const n = s.tuning.length;
  const okLen = s.instrument === 'bass' ? n >= 4 && n <= 6 : n >= 6 && n <= 7;
  if (!okLen) err(ctx, 'INVALID_FIELD', `${sp}.tuning`, `${s.instrument} requires ${s.instrument === 'bass' ? '4-6' : '6-7'} strings`);
  const byId = new Map(s.notes.map((x) => [x.id, x]));
  // 현별 [start,end) 구간 — 노트와 스트럼 현 모두 포함
  const spans: { s: number; e: number; str: number; path: string }[] = [];
  s.notes.forEach((note, j) => {
    const np = `${sp}.notes[${j}]`;
    claim(note.id, np);
    if (note.stringIndex >= n) err(ctx, 'INVALID_FIELD', `${np}.stringIndex`, 'string out of tuning');
    if (note.fret > s.maxFret) err(ctx, 'INVALID_FIELD', `${np}.fret`, 'fret > maxFret');
    if (note.stringIndex < n && note.fret + s.tuning[note.stringIndex] > 127) err(ctx, 'INVALID_FIELD', `${np}.fret`, 'pitch > 127');
    if (note.tick + note.durationTicks > s.lengthTicks) err(ctx, 'INVALID_FIELD', np, 'note exceeds source length');
    spans.push({ s: note.tick, e: note.tick + note.durationTicks, str: note.stringIndex, path: np });
    let links = 0, bends = 0;
    note.techniques.forEach((t, k) => {
      const tp = `${np}.techniques[${k}]`;
      if (t.kind === 'hammer-on' || t.kind === 'pull-off' || t.kind === 'slide') {
        links++;
        const target = byId.get(t.targetNoteId);
        if (!target) return err(ctx, 'BROKEN_REFERENCE', `${tp}.targetNoteId`, 'unknown target note in source');
        if (target.id === note.id) return err(ctx, 'INVALID_FIELD', tp, 'self reference');
        if (target.stringIndex !== note.stringIndex) err(ctx, 'INVALID_FIELD', tp, 'target must be on same string');
        if (target.tick !== note.tick + note.durationTicks) err(ctx, 'INVALID_FIELD', tp, 'target.tick must equal note end');
        if (t.kind === 'hammer-on' && !(target.fret > note.fret)) err(ctx, 'INVALID_FIELD', tp, 'hammer-on requires higher fret');
        if (t.kind === 'pull-off' && !(target.fret < note.fret)) err(ctx, 'INVALID_FIELD', tp, 'pull-off requires lower fret');
        if (t.kind === 'slide' && target.fret === note.fret) err(ctx, 'INVALID_FIELD', tp, 'slide requires a different fret');
      } else if (t.kind === 'bend') {
        bends++;
        const pts = t.points;
        if (pts.length === 0 || pts[0].offsetTick !== 0) err(ctx, 'INVALID_FIELD', `${tp}.points`, 'bend must start at offset 0');
        pts.forEach((pt, q) => {
          if (q > 0 && pt.offsetTick <= pts[q - 1].offsetTick) err(ctx, 'INVALID_FIELD', `${tp}.points[${q}]`, 'strictly ascending');
          if (pt.offsetTick > note.durationTicks) err(ctx, 'INVALID_FIELD', `${tp}.points[${q}]`, 'offset > duration');
        });
      }
    });
    if (links > 1) err(ctx, 'INVALID_FIELD', `${np}.techniques`, 'at most one link technique');
    if (bends > 1) err(ctx, 'INVALID_FIELD', `${np}.techniques`, 'at most one bend');
  });
  s.strums.forEach((st, j) => {
    const p = `${sp}.strums[${j}]`;
    claim(st.id, p);
    if (st.tick + st.durationTicks > s.lengthTicks) err(ctx, 'INVALID_FIELD', p, 'strum exceeds source length');
    const seen = new Set<number>();
    st.strings.forEach((x, k) => {
      if (x.stringIndex >= n) err(ctx, 'INVALID_FIELD', `${p}.strings[${k}]`, 'string out of tuning');
      if (seen.has(x.stringIndex)) err(ctx, 'INVALID_FIELD', `${p}.strings[${k}]`, 'duplicate string'); seen.add(x.stringIndex);
      if (x.fret !== null) {
        if (x.fret > s.maxFret) err(ctx, 'INVALID_FIELD', `${p}.strings[${k}].fret`, 'fret > maxFret');
        if (x.stringIndex < n && x.fret + s.tuning[x.stringIndex] > 127) err(ctx, 'INVALID_FIELD', `${p}.strings[${k}].fret`, 'pitch > 127');
        spans.push({ s: st.tick, e: st.tick + st.durationTicks, str: x.stringIndex, path: p });
      }
    });
    if (st.arpeggio) {
      st.arpeggio.order.forEach((o, k) => { if (!seen.has(o)) err(ctx, 'INVALID_FIELD', `${p}.arpeggio.order[${k}]`, 'string not in chord'); });
      if ((st.arpeggio.order.length - 1) * st.arpeggio.stepTicks >= st.durationTicks) err(ctx, 'INVALID_FIELD', `${p}.arpeggio`, 'arpeggio steps exceed strum duration');
    }
  });
  spans.sort((a, b) => a.str - b.str || a.s - b.s);
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1], b = spans[i];
    if (a.str === b.str && b.s < a.e) err(ctx, 'INVALID_FIELD', b.path, `overlaps on string ${b.str} with ${a.path}`);
  }
}

/** main output + sends 방향 그래프의 사이클을 찾는다 (02 §4 DAG). */
export function findRoutingCycle(channels: Channel[]): string[] | null {
  const adj = new Map<string, string[]>();
  for (const c of channels) adj.set(c.id, [...(c.output ? [c.output] : []), ...c.sends.map((s) => s.targetChannelId)]);
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const dfs = (u: string): string[] | null => {
    state.set(u, 1); stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (!adj.has(v)) continue;
      if (state.get(v) === 1) return [...stack.slice(stack.indexOf(v)), v];
      if (!state.get(v)) { const r = dfs(v); if (r) return r; }
    }
    state.set(u, 2); stack.pop();
    return null;
  };
  for (const c of channels) if (!state.get(c.id)) { const r = dfs(c.id); if (r) return r; }
  return null;
}

export function validateProject(input: unknown): Result<Project> {
  const ctx: Ctx = { errors: [] };
  projectShape(input, '$', ctx);
  if (ctx.errors.length) return { ok: false, errors: ctx.errors };
  try {
    semantic(input as Project, ctx);
  } catch (e) {
    err(ctx, 'INVALID_FIELD', '$', `validator exception: ${(e as Error).message}`);
  }
  if (ctx.errors.length) return { ok: false, errors: ctx.errors };
  return { ok: true, value: input as Project };
}
