// File System Access is optional. A download is a request, not proof of a disk write.
export const PROJECT_EXTENSION = '.dawbae';
export const PROJECT_ACCEPT = '.dawbae,.bassdaw,.zip,application/zip';
export interface ProjectFileHandle {
  name: string;
  getFile(): Promise<File>;
  createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}
export interface ProjectFilePicker {
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<ProjectFileHandle>;
  showOpenFilePicker?: (options: { multiple: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<ProjectFileHandle[]>;
}
const types = [{ description: 'DAW Bae project', accept: { 'application/zip': ['.dawbae'] } }];
export const isFileCancelled = (e: unknown) => e instanceof Error && e.name === 'AbortError';
export function projectFileName(title: string) { return `${title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().slice(0,120) || 'project'}${PROJECT_EXTENSION}`; }
export async function pickSaveFile(picker: ProjectFilePicker, name: string): Promise<ProjectFileHandle | null> {
  return picker.showSaveFilePicker ? picker.showSaveFilePicker({ suggestedName: name, types: [types[0]!] }) : null;
}
export async function writeProjectFile(handle: ProjectFileHandle, blob: Blob): Promise<void> {
  const stream = await handle.createWritable();
  try { await stream.write(blob); await stream.close(); }
  catch (e) { try { await stream.abort(); } catch { /* preserve the original write/close error */ } throw e; }
}
