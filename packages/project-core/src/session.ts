// 02 §5 ProjectService: execute/undo/redo, editSequence, STALE_EDIT, 세션 Undo 한도(100개 또는 64MiB).
import type { Project, Result, Id } from '@bass-daw/schemas';
import { validateProject, serializeProject, deserializeProject, nowIso } from '@bass-daw/schemas';
import { applyCommand, type CommandPayload } from './commands.ts';

export interface EditCommand { id: Id; expectedEditSequence: number; label: string; changes: CommandPayload }
export interface EditReceipt { editSequence: number; changedIds: Id[]; diagnostics: string[] }

interface UndoEntry { label: string; before: Project; after: Project; changedIds: Id[]; bytes: number }

export const UNDO_LIMIT = { commands: 100, bytes: 64 * 1024 * 1024 };

export type SessionListener = (s: ProjectSession, receipt: EditReceipt) => void;

export class ProjectSession {
  private _project: Project;
  private _editSequence = 0;
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private undoBytes = 0;
  /** 한도 때문에 오래된 Undo 가 버려진 횟수 — UI 표시용 */
  undoTrimmed = 0;
  private listeners = new Set<SessionListener>();
  /** 시간 공급자 — 테스트에서 고정한다. */
  clock: () => string = () => nowIso();

  constructor(project: Project, editSequence = 0) {
    this._project = project;
    this._editSequence = editSequence;
  }

  get project(): Project { return this._project; }
  get editSequence(): number { return this._editSequence; }
  get canUndo(): boolean { return this.undoStack.length > 0; }
  get canRedo(): boolean { return this.redoStack.length > 0; }
  get undoLabel(): string | null { return this.undoStack.at(-1)?.label ?? null; }
  get redoLabel(): string | null { return this.redoStack.at(-1)?.label ?? null; }
  get undoDepth(): number { return this.undoStack.length; }

  subscribe(fn: SessionListener): () => void { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  validate(input: unknown): Result<Project> { return validateProject(input); }
  serialize(project: Project = this._project): Result<Uint8Array> { return serializeProject(project); }
  deserialize(bytes: Uint8Array): Result<Project> { return deserializeProject(bytes); }

  /** 편집 미리보기 — 상태를 바꾸지 않고 결과만 계산한다(포인터 드래그 preview 용). */
  preview(changes: CommandPayload): Result<Project> {
    const r = applyCommand(this._project, changes);
    return r.ok ? { ok: true, value: r.value.project } : r;
  }

  execute(command: EditCommand): Result<EditReceipt> {
    if (command.expectedEditSequence !== this._editSequence) {
      return { ok: false, errors: [{ code: 'STALE_EDIT', path: '$.expectedEditSequence', message: `expected ${command.expectedEditSequence}, current ${this._editSequence}` }] };
    }
    const r = applyCommand(this._project, command.changes);
    if (!r.ok) return r;
    const before = this._project;
    const after = { ...r.value.project, updatedAt: this.bumpTime(before.updatedAt) };
    const bytes = estimateBytes(command.changes);
    this.undoStack.push({ label: command.label, before, after, changedIds: r.value.changedIds, bytes });
    this.undoBytes += bytes;
    // undo 후 새 편집은 redo 분기를 해제한다(저장 snapshot 은 storage 가 보존).
    this.redoStack = [];
    this.trim();
    this._project = after;
    return this.emit({ editSequence: ++this._editSequence, changedIds: r.value.changedIds, diagnostics: r.value.diagnostics });
  }

  /** 편의: 현재 sequence 로 명령 실행 */
  run(label: string, changes: CommandPayload): Result<EditReceipt> {
    return this.execute({ id: crypto.randomUUID(), expectedEditSequence: this._editSequence, label, changes });
  }

  undo(): Result<EditReceipt> {
    const e = this.undoStack.pop();
    if (!e) return { ok: false, errors: [{ code: 'NOTHING_TO_UNDO', path: '$', message: 'undo stack empty' }] };
    this.undoBytes -= e.bytes;
    this.redoStack.push(e);
    this._project = { ...e.before, updatedAt: this.bumpTime(this._project.updatedAt) };
    return this.emit({ editSequence: ++this._editSequence, changedIds: e.changedIds, diagnostics: [] });
  }

  redo(): Result<EditReceipt> {
    const e = this.redoStack.pop();
    if (!e) return { ok: false, errors: [{ code: 'NOTHING_TO_REDO', path: '$', message: 'redo stack empty' }] };
    this.undoStack.push(e);
    this.undoBytes += e.bytes;
    this._project = { ...e.after, updatedAt: this.bumpTime(this._project.updatedAt) };
    return this.emit({ editSequence: ++this._editSequence, changedIds: e.changedIds, diagnostics: [] });
  }

  /** 저장소에서 다시 연 프로젝트로 교체(세션 Undo 초기화 — 재시작 후 Undo 복원은 v1 제외). */
  replace(project: Project): void {
    this._project = project;
    this.undoStack = []; this.redoStack = []; this.undoBytes = 0;
    this.emit({ editSequence: ++this._editSequence, changedIds: [project.id], diagnostics: ['SESSION_REPLACED'] });
  }

  private trim(): void {
    while (this.undoStack.length > UNDO_LIMIT.commands || this.undoBytes > UNDO_LIMIT.bytes) {
      const e = this.undoStack.shift()!;
      this.undoBytes -= e.bytes;
      this.undoTrimmed++;
    }
  }

  private bumpTime(prev: string): string {
    const now = this.clock();
    return Date.parse(now) >= Date.parse(prev) ? now : prev;
  }

  private emit(receipt: EditReceipt): Result<EditReceipt> {
    for (const l of this.listeners) l(this, receipt);
    return { ok: true, value: receipt };
  }
}

/** Undo 메모리 추정: 구조 공유로 변경분만 새로 할당되므로 payload 크기 기반으로 근사한다. */
function estimateBytes(c: CommandPayload): number {
  try { return 256 + JSON.stringify(c).length * 2; } catch { return 1024; }
}
