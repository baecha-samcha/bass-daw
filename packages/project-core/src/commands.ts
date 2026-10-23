// 02 §5 명령 레지스트리. 모든 명령은 (project, payload) → 새 Project 순수 함수이며 입력을 변경하지 않는다.
// 변경되지 않은 하위 객체는 공유한다(structural sharing) — Undo 스냅샷이 저렴하다.
import type {
  Project, Track, Clip, MusicClip, AudioClip, Source, Channel, PluginInstance, AutomationLane, TempoPoint, MeterPoint,
  Result, Id, TrackKind, Asset, Send, TabNote, TabStrum, MidiNote, DrumHit,
} from '@bass-daw/schemas';
import { uuid, createChannel, createPlugin, createSourceFor, nextTrackOrder, TRACK_COLORS, validateProject } from '@bass-daw/schemas';

export interface CommandOutput { project: Project; changedIds: Id[]; diagnostics: string[] }
type CmdResult = Result<CommandOutput>;

const fail = (code: string, path: string, message: string): CmdResult => ({ ok: false, errors: [{ code, path, message }] });
const ok = (project: Project, changedIds: Id[], diagnostics: string[] = []): CmdResult => ({ ok: true, value: { project, changedIds, diagnostics } });

// ---------- 불변 갱신 헬퍼 ----------
function mapTrack(p: Project, trackId: Id, fn: (t: Track) => Track): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === trackId ? fn(t) : t)) };
}
export function findClip(p: Project, clipId: Id): { track: Track; clip: Clip; index: number } | null {
  for (const track of p.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  return null;
}
function replaceClip(p: Project, clipId: Id, next: Clip[]): Project {
  const f = findClip(p, clipId)!;
  return mapTrack(p, f.track.id, (t) => ({ ...t, clips: [...t.clips.slice(0, f.index), ...next, ...t.clips.slice(f.index + 1)] }));
}
function mapChannel(p: Project, id: Id, fn: (c: Channel) => Channel): Project {
  return { ...p, channels: p.channels.map((c) => (c.id === id ? fn(c) : c)) };
}
function mapSource(p: Project, id: Id, fn: (s: Source) => Source): Project {
  return { ...p, sources: p.sources.map((s) => (s.id === id ? fn(s) : s)) };
}
const sourceOf = (p: Project, id: Id) => p.sources.find((s) => s.id === id);
const assetOfSource = (p: Project, s: Source | undefined): Asset | undefined => (s?.kind === 'audio' ? p.assets.find((a) => a.id === s.assetId) : undefined);

function clipUsers(p: Project, sourceId: Id): number {
  let n = 0;
  for (const t of p.tracks) for (const c of t.clips) if (c.sourceId === sourceId) n++;
  return n;
}

/** source 복제: 새 source ID 와 새 이벤트 ID. 링크 주법 대상도 재매핑. drum pad ID 는 kit 범위라 유지(decisions/0003). */
export function cloneSourceWithNewIds(s: Source): { source: Source; idMap: Map<Id, Id> } {
  const idMap = new Map<Id, Id>();
  const re = (id: Id) => { const n = uuid(); idMap.set(id, n); return n; };
  const nid = uuid(); idMap.set(s.id, nid);
  switch (s.kind) {
    case 'tab': {
      const notes = s.notes.map((n) => ({ ...n, id: re(n.id) }));
      const fixed = notes.map((n) => ({ ...n, techniques: n.techniques.map((t) => ('targetNoteId' in t ? { ...t, targetNoteId: idMap.get(t.targetNoteId) ?? t.targetNoteId } : t)) }));
      return { source: { ...s, id: nid, notes: fixed, strums: s.strums.map((x) => ({ ...x, id: re(x.id) })) }, idMap };
    }
    case 'midi':
      return { source: { ...s, id: nid, notes: s.notes.map((n) => ({ ...n, id: re(n.id) })), cc: s.cc.map((n) => ({ ...n, id: re(n.id) })), pitchBend: s.pitchBend.map((n) => ({ ...n, id: re(n.id) })) }, idMap };
    case 'drum':
      return { source: { ...s, id: nid, hits: s.hits.map((h) => ({ ...h, id: re(h.id) })) }, idMap };
    case 'audio':
      return { source: { ...s, id: nid }, idMap };
  }
}

// ---------- payload 타입 ----------
export type NoteOp =
  | { op: 'add'; collection: 'notes' | 'strums' | 'cc' | 'pitchBend' | 'hits'; item: TabNote | TabStrum | MidiNote | DrumHit | { id: Id; tick: number; channel: number; controller: number; value: number } | { id: Id; tick: number; channel: number; value: number } }
  | { op: 'update'; collection: 'notes' | 'strums' | 'cc' | 'pitchBend' | 'hits'; id: Id; patch: Record<string, unknown> }
  | { op: 'delete'; collection: 'notes' | 'strums' | 'cc' | 'pitchBend' | 'hits'; id: Id };

export type CommandPayload =
  | { type: 'SetTitle'; title: string }
  | { type: 'CreateTrack'; kind: TrackKind; name?: string; instrument?: 'bass' | 'guitar'; trackId?: Id; withClip?: boolean; lengthTicks?: number }
  | { type: 'DeleteTrack'; trackId: Id }
  | { type: 'RenameTrack'; trackId: Id; name: string }
  | { type: 'SetTrackFlags'; trackId: Id; muted?: boolean; solo?: boolean; color?: string }
  | { type: 'ReorderTrack'; trackId: Id; toIndex: number }
  | { type: 'CreateSource'; source: Source }
  | { type: 'ReplaceSource'; source: Source }
  | { type: 'SetSourceProps'; clipId: Id; props: { lengthTicks?: number; tuning?: number[]; maxFret?: number; pads?: unknown } }
  | { type: 'AddAsset'; asset: Asset }
  | { type: 'PlaceClip'; trackId: Id; clip: Clip }
  | { type: 'MoveClip'; clipId: Id; startTick?: number; startSeconds?: number; toTrackId?: Id }
  | { type: 'TrimClip'; clipId: Id; edge: 'start' | 'end'; tick?: number; seconds?: number }
  | { type: 'SplitClip'; clipId: Id; tick?: number; seconds?: number }
  | { type: 'DuplicateClip'; clipId: Id; startTick?: number; startSeconds?: number; newClipId?: Id }
  | { type: 'DeleteClip'; clipId: Id }
  | { type: 'SetClipProps'; clipId: Id; props: { name?: string; muted?: boolean; loopSource?: boolean; durationTicks?: number; gain?: number; fadeInFrames?: number; fadeOutFrames?: number } }
  | { type: 'EditNotes'; clipId: Id; ops: NoteOp[] }
  | { type: 'SetTempoMap'; tempoMap: TempoPoint[]; meterMap?: MeterPoint[] }
  | { type: 'SetLoop'; enabled: boolean; startTick: number; endTick: number }
  | { type: 'SetRouting'; channelId: Id; output?: Id; sends?: Send[]; effects?: Id[] }
  | { type: 'SetChannelFlags'; channelId: Id; muted?: boolean; solo?: boolean; name?: string }
  | { type: 'CreateBus'; name: string; busId?: Id }
  | { type: 'DeleteBus'; channelId: Id }
  | { type: 'InsertEffect'; channelId: Id; pluginId: string; index?: number; state?: PluginInstance['state']; instanceId?: Id; external?: { pluginVersion: string; stateVersion: number; parameters: Record<string, number> } }
  | { type: 'SetInstrument'; trackId: Id; plugin: PluginInstance }
  | { type: 'RemoveEffect'; channelId: Id; instanceId: Id }
  | { type: 'SetPluginState'; instanceId: Id; state: PluginInstance['state']; assets?: Id[] }
  | { type: 'SetParameter'; owner: 'channel' | 'plugin'; ownerId: Id; parameterId: string; value: number }
  | { type: 'EditAutomation'; op: 'upsert'; lane: AutomationLane } | { type: 'EditAutomation'; op: 'delete'; laneId: Id }
  | { type: 'SetMetadata'; key: string; value: string | null }
  | { type: 'Batch'; commands: CommandPayload[] };

// ---------- 명령 구현 ----------
export function applyCommand(p: Project, c: CommandPayload): CmdResult {
  const r = applyRaw(p, c);
  if (!r.ok) return r;
  const v = validateProject(r.value.project);
  if (!v.ok) return v as Result<never>;
  return r;
}

function applyRaw(p: Project, c: CommandPayload): CmdResult {
  switch (c.type) {
    case 'SetTitle': return ok({ ...p, title: c.title }, [p.id]);

    case 'CreateTrack': {
      const trackName = c.name ?? defaultTrackName(c.kind, c.instrument);
      const channel = createChannel('track', trackName, p.masterChannelId);
      const instrument = c.kind === 'audio' ? null : createPlugin('builtin.sampler', { version: 1, zones: [], pads: [], attackMs: 5, releaseMs: 80 });
      const id = c.trackId ?? uuid();
      const order = nextTrackOrder(p.tracks);
      const track: Track = {
        id, name: trackName, color: TRACK_COLORS[order % TRACK_COLORS.length], order,
        kind: c.kind, channelId: channel.id, muted: false, solo: false, clips: [], instrumentSlot: instrument?.instanceId ?? null,
      };
      let next: Project = { ...p, tracks: [...p.tracks, track], channels: [...p.channels, channel], plugins: instrument ? [...p.plugins, instrument] : p.plugins };
      const changed = [id, channel.id, ...(instrument ? [instrument.instanceId] : [])];
      if (c.withClip && c.kind !== 'audio') {
        const src = createSourceFor(c.kind, { instrument: c.instrument, lengthTicks: c.lengthTicks });
        const clip: MusicClip = { id: uuid(), kind: 'music', sourceId: src.id, name: track.name, muted: false, startTick: 0, durationTicks: (src as { lengthTicks: number }).lengthTicks, sourceOffsetTick: 0, loopSource: false };
        next = { ...next, sources: [...next.sources, src], tracks: next.tracks.map((t) => (t.id === id ? { ...t, clips: [clip] } : t)) };
        changed.push(src.id, clip.id);
      }
      return ok(next, changed);
    }

    case 'DeleteTrack': {
      const t = p.tracks.find((x) => x.id === c.trackId);
      if (!t) return fail('BROKEN_REFERENCE', '$.trackId', 'unknown track');
      const ch = p.channels.find((x) => x.id === t.channelId);
      const removedPlugins = new Set([...(t.instrumentSlot ? [t.instrumentSlot] : []), ...(ch?.effects ?? [])]);
      // source/asset 은 Undo·snapshot 참조 보존을 위해 남긴다(02 §2).
      return ok({
        ...p,
        tracks: p.tracks.filter((x) => x.id !== t.id),
        channels: p.channels.filter((x) => x.id !== t.channelId),
        plugins: p.plugins.filter((x) => !removedPlugins.has(x.instanceId)),
        automation: p.automation.filter((l) => l.target.ownerId !== t.channelId && !removedPlugins.has(l.target.ownerId)),
      }, [t.id, t.channelId, ...removedPlugins]);
    }

    case 'RenameTrack': {
      const t = p.tracks.find((x) => x.id === c.trackId);
      if (!t) return fail('BROKEN_REFERENCE', '$.trackId', 'unknown track');
      const next = mapChannel(mapTrack(p, t.id, (x) => ({ ...x, name: c.name })), t.channelId, (ch) => ({ ...ch, name: c.name }));
      return ok(next, [t.id]);
    }

    case 'SetTrackFlags': {
      const t = p.tracks.find((x) => x.id === c.trackId);
      if (!t) return fail('BROKEN_REFERENCE', '$.trackId', 'unknown track');
      let next = mapTrack(p, t.id, (x) => ({ ...x, ...(c.muted !== undefined && { muted: c.muted }), ...(c.solo !== undefined && { solo: c.solo }), ...(c.color !== undefined && { color: c.color }) }));
      // track.muted/solo 와 채널 플래그를 동기화한다(엔진은 채널 플래그를 사용).
      next = mapChannel(next, t.channelId, (ch) => ({ ...ch, ...(c.muted !== undefined && { muted: c.muted }), ...(c.solo !== undefined && { solo: c.solo }) }));
      return ok(next, [t.id, t.channelId]);
    }

    case 'ReorderTrack': {
      const sorted = [...p.tracks].sort((a, b) => a.order - b.order);
      const i = sorted.findIndex((t) => t.id === c.trackId);
      if (i < 0) return fail('BROKEN_REFERENCE', '$.trackId', 'unknown track');
      const [t] = sorted.splice(i, 1);
      sorted.splice(Math.max(0, Math.min(sorted.length, c.toIndex)), 0, t);
      const orderOf = new Map(sorted.map((x, k) => [x.id, k]));
      return ok({ ...p, tracks: p.tracks.map((x) => (x.order === orderOf.get(x.id) ? x : { ...x, order: orderOf.get(x.id)! })) }, [c.trackId]);
    }

    case 'CreateSource':
      if (sourceOf(p, c.source.id)) return fail('DUPLICATE_ID', '$.source.id', 'source exists');
      return ok({ ...p, sources: [...p.sources, c.source] }, [c.source.id]);

    case 'ReplaceSource':
      if (!sourceOf(p, c.source.id)) return fail('BROKEN_REFERENCE', '$.source.id', 'unknown source');
      return ok(mapSource(p, c.source.id, () => c.source), [c.source.id]);

    case 'SetSourceProps': {
      const f = findClip(p, c.clipId);
      if (!f || f.clip.kind !== 'music') return fail('BROKEN_REFERENCE', '$.clipId', 'unknown music clip');
      const { project: q, sourceId } = ensureExclusiveSource(p, f.clip);
      const next = mapSource(q, sourceId, (s) => ({ ...s, ...(c.props as object) } as Source));
      return ok(next, [sourceId, c.clipId]);
    }

    case 'AddAsset':
      if (p.assets.some((a) => a.id === c.asset.id)) return fail('DUPLICATE_ID', '$.asset.id', 'asset exists');
      return ok({ ...p, assets: [...p.assets, c.asset] }, [c.asset.id]);

    case 'PlaceClip':
      if (!p.tracks.some((t) => t.id === c.trackId)) return fail('BROKEN_REFERENCE', '$.trackId', 'unknown track');
      return ok(mapTrack(p, c.trackId, (t) => ({ ...t, clips: [...t.clips, c.clip] })), [c.clip.id]);

    case 'MoveClip': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      let moved: Clip;
      if (f.clip.kind === 'music') {
        if (c.startTick === undefined || !Number.isSafeInteger(c.startTick) || c.startTick < 0) return fail('INVALID_FIELD', '$.startTick', 'non-negative integer tick required');
        moved = { ...f.clip, startTick: c.startTick };
      } else {
        if (c.startSeconds === undefined || !(c.startSeconds >= 0)) return fail('INVALID_FIELD', '$.startSeconds', 'non-negative seconds required');
        moved = { ...f.clip, startSeconds: c.startSeconds };
      }
      if (c.toTrackId && c.toTrackId !== f.track.id) {
        const to = p.tracks.find((t) => t.id === c.toTrackId);
        if (!to) return fail('BROKEN_REFERENCE', '$.toTrackId', 'unknown track');
        if (to.kind !== f.track.kind) return fail('INVALID_FIELD', '$.toTrackId', 'track kind mismatch');
        const removed = replaceClip(p, c.clipId, []);
        return ok(mapTrack(removed, to.id, (t) => ({ ...t, clips: [...t.clips, moved] })), [c.clipId]);
      }
      return ok(replaceClip(p, c.clipId, [moved]), [c.clipId]);
    }

    case 'TrimClip': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      const r = trimClip(p, f.clip, c.edge, c.tick, c.seconds);
      if (!r.ok) return r as Result<never>;
      return ok(replaceClip(p, c.clipId, [r.value]), [c.clipId]);
    }

    case 'SplitClip': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      const r = splitClip(p, f.clip, c.tick, c.seconds);
      if (!r.ok) return r as Result<never>;
      return ok(replaceClip(p, c.clipId, r.value), r.value.map((x) => x.id));
    }

    case 'DuplicateClip': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      const newId = c.newClipId ?? uuid();
      let dup: Clip;
      if (f.clip.kind === 'music') dup = { ...f.clip, id: newId, startTick: c.startTick ?? f.clip.startTick + f.clip.durationTicks };
      else {
        const a = assetOfSource(p, sourceOf(p, f.clip.sourceId));
        const dur = a?.audio ? f.clip.sourceFrameCount / a.audio.sampleRate : 0;
        dup = { ...f.clip, id: newId, startSeconds: c.startSeconds ?? f.clip.startSeconds + dur };
      }
      return ok(mapTrack(p, f.track.id, (t) => ({ ...t, clips: [...t.clips, dup] })), [newId]);
    }

    case 'DeleteClip': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      return ok(replaceClip(p, c.clipId, []), [c.clipId]);
    }

    case 'SetClipProps': {
      const f = findClip(p, c.clipId);
      if (!f) return fail('BROKEN_REFERENCE', '$.clipId', 'unknown clip');
      const allowed = f.clip.kind === 'music' ? ['name', 'muted', 'loopSource', 'durationTicks'] : ['name', 'muted', 'gain', 'fadeInFrames', 'fadeOutFrames'];
      for (const k of Object.keys(c.props)) if (!allowed.includes(k)) return fail('INVALID_FIELD', `$.props.${k}`, 'not editable for this clip kind');
      return ok(replaceClip(p, c.clipId, [{ ...f.clip, ...c.props } as Clip]), [c.clipId]);
    }

    case 'EditNotes': {
      const f = findClip(p, c.clipId);
      if (!f || f.clip.kind !== 'music') return fail('BROKEN_REFERENCE', '$.clipId', 'unknown music clip');
      const { project: q, sourceId, idMap, cloned } = ensureExclusiveSource(p, f.clip);
      const src = sourceOf(q, sourceId)!;
      const r = applyNoteOps(src, c.ops, idMap);
      if (!r.ok) return r as Result<never>;
      return ok(mapSource(q, sourceId, () => r.value), [sourceId, c.clipId], cloned ? [`COPY_ON_WRITE: clip ${c.clipId} now uses new source ${sourceId}`] : []);
    }

    case 'SetTempoMap':
      return ok({ ...p, tempoMap: c.tempoMap, meterMap: c.meterMap ?? p.meterMap }, [p.id]);

    case 'SetLoop':
      return ok({ ...p, loop: { enabled: c.enabled, startTick: c.startTick, endTick: c.endTick } }, [p.id]);

    case 'SetRouting': {
      const ch = p.channels.find((x) => x.id === c.channelId);
      if (!ch) return fail('BROKEN_REFERENCE', '$.channelId', 'unknown channel');
      return ok(mapChannel(p, ch.id, (x) => ({ ...x, ...(c.output !== undefined && { output: c.output }), ...(c.sends && { sends: c.sends }), ...(c.effects && { effects: c.effects }) })), [ch.id]);
    }

    case 'SetChannelFlags': {
      const ch = p.channels.find((x) => x.id === c.channelId);
      if (!ch) return fail('BROKEN_REFERENCE', '$.channelId', 'unknown channel');
      let next = mapChannel(p, ch.id, (x) => ({ ...x, ...(c.muted !== undefined && { muted: c.muted }), ...(c.solo !== undefined && { solo: c.solo }), ...(c.name !== undefined && { name: c.name }) }));
      const t = p.tracks.find((x) => x.channelId === ch.id);
      if (t) next = mapTrack(next, t.id, (x) => ({ ...x, ...(c.muted !== undefined && { muted: c.muted }), ...(c.solo !== undefined && { solo: c.solo }) }));
      return ok(next, [ch.id]);
    }

    case 'CreateBus': {
      const bus = { ...createChannel('bus', c.name, p.masterChannelId), ...(c.busId && { id: c.busId }) };
      return ok({ ...p, channels: [...p.channels, bus] }, [bus.id]);
    }

    case 'DeleteBus': {
      const ch = p.channels.find((x) => x.id === c.channelId);
      if (!ch || ch.kind !== 'bus') return fail('BROKEN_REFERENCE', '$.channelId', 'unknown bus');
      // 이 버스로 향하던 출력은 master 로, send 는 제거한다.
      const fx = new Set(ch.effects);
      return ok({
        ...p,
        channels: p.channels.filter((x) => x.id !== ch.id).map((x) => (x.output === ch.id || x.sends.some((s) => s.targetChannelId === ch.id)
          ? { ...x, output: x.output === ch.id ? p.masterChannelId : x.output, sends: x.sends.filter((s) => s.targetChannelId !== ch.id) } : x)),
        plugins: p.plugins.filter((x) => !fx.has(x.instanceId)),
        automation: p.automation.filter((l) => l.target.ownerId !== ch.id && !fx.has(l.target.ownerId)),
      }, [ch.id]);
    }

    case 'InsertEffect': {
      const ch = p.channels.find((x) => x.id === c.channelId);
      if (!ch) return fail('BROKEN_REFERENCE', '$.channelId', 'unknown channel');
      const pl: PluginInstance = c.external
        ? { instanceId: c.instanceId ?? uuid(), pluginId: c.pluginId, pluginVersion: c.external.pluginVersion, stateVersion: c.external.stateVersion, role: 'effect', state: c.state ?? null, parameters: { ...c.external.parameters }, assets: [] }
        : { ...createPlugin(c.pluginId, c.state ?? defaultEffectState(c.pluginId)), ...(c.instanceId && { instanceId: c.instanceId }) };
      if (pl.role !== 'effect') return fail('INVALID_FIELD', '$.pluginId', 'not an effect');
      const fx = [...ch.effects]; fx.splice(c.index ?? fx.length, 0, pl.instanceId);
      return ok({ ...mapChannel(p, ch.id, (x) => ({ ...x, effects: fx })), plugins: [...p.plugins, pl] }, [pl.instanceId, ch.id]);
    }

    case 'SetInstrument': {
      const t = p.tracks.find((x) => x.id === c.trackId);
      if (!t || t.kind === 'audio') return fail('BROKEN_REFERENCE', '$.trackId', 'unknown instrument track');
      if (c.plugin.role !== 'instrument') return fail('INVALID_FIELD', '$.plugin.role', 'instrument required');
      const old = t.instrumentSlot;
      // 이전 instrument 인스턴스와 그 자동화는 제거(Undo 로 복원)
      return ok({
        ...mapTrack(p, t.id, (x) => ({ ...x, instrumentSlot: c.plugin.instanceId })),
        plugins: [...p.plugins.filter((x) => x.instanceId !== old), c.plugin],
        automation: p.automation.filter((l) => l.target.ownerId !== old),
      }, [t.id, c.plugin.instanceId]);
    }

    case 'RemoveEffect': {
      const ch = p.channels.find((x) => x.id === c.channelId);
      if (!ch || !ch.effects.includes(c.instanceId)) return fail('BROKEN_REFERENCE', '$.instanceId', 'effect not on channel');
      return ok({
        ...mapChannel(p, ch.id, (x) => ({ ...x, effects: x.effects.filter((e) => e !== c.instanceId) })),
        plugins: p.plugins.filter((x) => x.instanceId !== c.instanceId),
        automation: p.automation.filter((l) => l.target.ownerId !== c.instanceId),
      }, [c.instanceId, ch.id]);
    }

    case 'SetPluginState': {
      const pl = p.plugins.find((x) => x.instanceId === c.instanceId);
      if (!pl) return fail('BROKEN_REFERENCE', '$.instanceId', 'unknown plugin');
      return ok({ ...p, plugins: p.plugins.map((x) => (x.instanceId === pl.instanceId ? { ...x, state: c.state, ...(c.assets && { assets: c.assets }) } : x)) }, [pl.instanceId]);
    }

    case 'SetParameter': {
      if (c.owner === 'channel') {
        if (c.parameterId !== 'gain' && c.parameterId !== 'pan') return fail('INVALID_FIELD', '$.parameterId', 'gain|pan');
        if (!p.channels.some((x) => x.id === c.ownerId)) return fail('BROKEN_REFERENCE', '$.ownerId', 'unknown channel');
        return ok(mapChannel(p, c.ownerId, (x) => ({ ...x, [c.parameterId]: c.value })), [c.ownerId]);
      }
      const pl = p.plugins.find((x) => x.instanceId === c.ownerId);
      if (!pl) return fail('BROKEN_REFERENCE', '$.ownerId', 'unknown plugin');
      return ok({ ...p, plugins: p.plugins.map((x) => (x === pl ? { ...x, parameters: { ...x.parameters, [c.parameterId]: c.value } } : x)) }, [c.ownerId]);
    }

    case 'EditAutomation':
      if (c.op === 'delete') return ok({ ...p, automation: p.automation.filter((l) => l.id !== c.laneId) }, [c.laneId]);
      return ok({ ...p, automation: p.automation.some((l) => l.id === c.lane.id) ? p.automation.map((l) => (l.id === c.lane.id ? c.lane : l)) : [...p.automation, c.lane] }, [c.lane.id]);

    case 'SetMetadata': {
      const m = { ...p.metadata };
      if (c.value === null) delete m[c.key]; else m[c.key] = c.value;
      return ok({ ...p, metadata: m }, [p.id]);
    }

    case 'Batch': {
      // 복합 편집: 전부 성공 또는 전부 실패. 중간 결과는 검증하지 않고 마지막에 한 번 검증한다.
      let cur = p; const changed: Id[] = []; const diags: string[] = [];
      for (const [i, sub] of c.commands.entries()) {
        const r = applyRaw(cur, sub);
        if (!r.ok) return { ok: false, errors: r.errors.map((e) => ({ ...e, path: `$.commands[${i}]${e.path.slice(1)}` })) };
        cur = r.value.project; changed.push(...r.value.changedIds); diags.push(...r.value.diagnostics);
      }
      return ok(cur, [...new Set(changed)], diags);
    }
  }
}

function defaultTrackName(kind: TrackKind, instrument?: 'bass' | 'guitar'): string {
  if (kind === 'tab') return instrument === 'guitar' ? 'Guitar' : 'Bass';
  return { midi: 'Keys', drum: 'Drums', audio: 'Audio' }[kind];
}

export function defaultEffectState(pluginId: string): PluginInstance['state'] {
  if (pluginId === 'builtin.reverb') return { version: 1, irAssetId: null };
  return { version: 1 };
}

/** 공유 source 를 편집하기 전 기본 copy-on-write. */
function ensureExclusiveSource(p: Project, clip: MusicClip): { project: Project; sourceId: Id; idMap: Map<Id, Id>; cloned: boolean } {
  if (clipUsers(p, clip.sourceId) <= 1) return { project: p, sourceId: clip.sourceId, idMap: new Map(), cloned: false };
  const { source, idMap } = cloneSourceWithNewIds(sourceOf(p, clip.sourceId)!);
  const q = replaceClip({ ...p, sources: [...p.sources, source] }, clip.id, [{ ...clip, sourceId: source.id }]);
  return { project: q, sourceId: source.id, idMap, cloned: true };
}

function applyNoteOps(src: Source, ops: NoteOp[], idMap: Map<Id, Id>): Result<Source> {
  if (src.kind === 'audio') return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.ops', message: 'audio source has no notes' }] };
  const s: Record<string, unknown[]> = {};
  const get = (col: string): { id: Id }[] => {
    if (!(col in src)) throw new Error(`collection ${col} not in ${src.kind} source`);
    return (s[col] ??= [...((src as unknown as Record<string, { id: Id }[]>)[col])]) as { id: Id }[];
  };
  try {
    for (const op of ops) {
      const arr = get(op.collection);
      if (op.op === 'add') arr.push(op.item);
      else {
        const id = idMap.get(op.id) ?? op.id;
        const i = arr.findIndex((x) => x.id === id);
        if (i < 0) return { ok: false, errors: [{ code: 'BROKEN_REFERENCE', path: '$.ops', message: `unknown ${op.collection} id ${op.id}` }] };
        if (op.op === 'delete') {
          arr.splice(i, 1);
          if (src.kind === 'tab' && op.collection === 'notes') {
            // 삭제된 노트를 가리키는 링크 주법도 제거(원자적 편집)
            const notes = arr as TabNote[];
            for (let k = 0; k < notes.length; k++) if (notes[k].techniques.some((t) => 'targetNoteId' in t && t.targetNoteId === id)) notes[k] = { ...notes[k], techniques: notes[k].techniques.filter((t) => !('targetNoteId' in t && t.targetNoteId === id)) };
          }
        } else {
          if ('id' in op.patch && op.patch.id !== id) return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.ops', message: 'id is immutable' }] };
          arr[i] = { ...arr[i], ...op.patch };
        }
      }
    }
  } catch (e) {
    return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.ops', message: (e as Error).message }] };
  }
  return { ok: true, value: { ...src, ...s } as Source };
}

// ---------- split / trim 의미 (02 §5) ----------
export function splitClip(p: Project, clip: Clip, atTick?: number, atSeconds?: number): Result<Clip[]> {
  if (clip.kind === 'music') {
    const s = sourceOf(p, clip.sourceId) as { lengthTicks: number } | undefined;
    if (atTick === undefined || !Number.isSafeInteger(atTick)) return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.tick', message: 'integer tick required' }] };
    const left = atTick - clip.startTick;
    if (left <= 0 || left >= clip.durationTicks) return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.tick', message: 'split point must be inside clip' }] };
    const off = clip.sourceOffsetTick + left;
    const a: MusicClip = { ...clip, durationTicks: left };
    const b: MusicClip = { ...clip, id: uuid(), startTick: atTick, durationTicks: clip.durationTicks - left, sourceOffsetTick: clip.loopSource && s ? off % s.lengthTicks : off };
    return { ok: true, value: [a, b] };
  }
  const a0 = assetOfSource(p, sourceOf(p, clip.sourceId));
  if (!a0?.audio || atSeconds === undefined) return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.seconds', message: 'seconds and decoded asset required' }] };
  const leftFrames = Math.round((atSeconds - clip.startSeconds) * a0.audio.sampleRate);
  if (leftFrames <= 0 || leftFrames >= clip.sourceFrameCount) return { ok: false, errors: [{ code: 'INVALID_FIELD', path: '$.seconds', message: 'split point must be inside clip' }] };
  const a: AudioClip = { ...clip, sourceFrameCount: leftFrames, fadeOutFrames: Math.min(clip.fadeOutFrames, 0), fadeInFrames: Math.min(clip.fadeInFrames, leftFrames) };
  const b: AudioClip = {
    ...clip, id: uuid(), startSeconds: clip.startSeconds + leftFrames / a0.audio.sampleRate,
    sourceStartFrame: clip.sourceStartFrame + leftFrames, sourceFrameCount: clip.sourceFrameCount - leftFrames,
    fadeInFrames: 0, fadeOutFrames: Math.min(clip.fadeOutFrames, clip.sourceFrameCount - leftFrames),
  };
  return { ok: true, value: [a, b] };
}

export function trimClip(p: Project, clip: Clip, edge: 'start' | 'end', tick?: number, seconds?: number): Result<Clip> {
  const bad = (m: string): Result<Clip> => ({ ok: false, errors: [{ code: 'INVALID_FIELD', path: '$', message: m }] });
  if (clip.kind === 'music') {
    if (tick === undefined || !Number.isSafeInteger(tick)) return bad('integer tick required');
    const len = (sourceOf(p, clip.sourceId) as { lengthTicks: number }).lengthTicks;
    const end = clip.startTick + clip.durationTicks;
    if (edge === 'end') {
      if (tick <= clip.startTick) return bad('end must be after start');
      return { ok: true, value: { ...clip, durationTicks: tick - clip.startTick } };
    }
    if (tick >= end || tick < 0) return bad('start must be before end');
    const delta = tick - clip.startTick;
    let off = clip.sourceOffsetTick + delta;
    if (clip.loopSource) off = ((off % len) + len) % len;
    else if (off < 0) return bad('cannot trim before source start');
    return { ok: true, value: { ...clip, startTick: tick, durationTicks: end - tick, sourceOffsetTick: off } };
  }
  const a = assetOfSource(p, sourceOf(p, clip.sourceId));
  if (!a?.audio || seconds === undefined) return bad('seconds and decoded asset required');
  const sr = a.audio.sampleRate;
  if (edge === 'end') {
    const count = Math.round((seconds - clip.startSeconds) * sr);
    if (count < 1) return bad('end must be after start');
    if (clip.sourceStartFrame + count > a.audio.frameCount) return bad('cannot extend past source end');
    return { ok: true, value: { ...clip, sourceFrameCount: count, fadeInFrames: Math.min(clip.fadeInFrames, count), fadeOutFrames: Math.min(clip.fadeOutFrames, count - Math.min(clip.fadeInFrames, count)) } };
  }
  const delta = Math.round((seconds - clip.startSeconds) * sr);
  const start = clip.sourceStartFrame + delta;
  const count = clip.sourceFrameCount - delta;
  if (start < 0) return bad('cannot trim before source start');
  if (count < 1) return bad('start must be before end');
  return { ok: true, value: { ...clip, startSeconds: clip.startSeconds + delta / sr, sourceStartFrame: start, sourceFrameCount: count, fadeInFrames: Math.min(clip.fadeInFrames, count), fadeOutFrames: Math.min(clip.fadeOutFrames, count - Math.min(clip.fadeInFrames, count)) } };
}
