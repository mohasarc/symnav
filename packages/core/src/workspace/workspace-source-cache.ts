import type { FileSystem } from "./file-system.js";
import type { WorkspaceSnapshot } from "./workspace.js";

export class WorkspaceSourceCache {
  private revisions = new Map<string, string>();
  private contents = new Map<string, string>();

  constructor(private readonly fileSystem: FileSystem) {}

  refresh(snapshot: WorkspaceSnapshot): void {
    const nextRevisions = new Map(
      snapshot.files.map((file) => [file.absolute, file.metadata.changeToken]),
    );
    for (const [path, revision] of this.revisions) {
      if (nextRevisions.get(path) !== revision) this.contents.delete(path);
    }
    this.revisions = nextRevisions;
  }

  async readFile(absPath: string): Promise<string> {
    const cached = this.contents.get(absPath);
    if (cached !== undefined) return cached;
    const content = await this.fileSystem.readFile(absPath);
    if (this.revisions.has(absPath)) this.contents.set(absPath, content);
    return content;
  }
}
