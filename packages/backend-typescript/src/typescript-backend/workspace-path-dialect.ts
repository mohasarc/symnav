import { posix, win32 } from "node:path";

export class WorkspacePathDialect {
  readonly caseSensitive: boolean;
  private readonly windows: boolean;

  constructor(root: string) {
    this.windows = /^[A-Za-z]:[\\/]/.test(root);
    this.caseSensitive = !this.windows;
  }

  normalize(path: string): string {
    return path.replaceAll("\\", "/");
  }

  join(...paths: readonly string[]): string {
    return this.normalize(this.windows ? win32.join(...paths) : posix.join(...paths));
  }

  resolve(from: string, target: string): string {
    return this.normalize(this.windows ? win32.resolve(from, target) : posix.resolve(from, target));
  }

  dirname(path: string): string {
    return this.normalize(this.windows ? win32.dirname(path) : posix.dirname(path));
  }

  relative(from: string, target: string): string {
    return this.normalize(
      this.windows ? win32.relative(from, target) : posix.relative(from, target),
    );
  }

  isAbsolute(path: string): boolean {
    return this.windows ? win32.isAbsolute(path) : posix.isAbsolute(path);
  }

  equals(left: string, right: string): boolean {
    return this.key(left) === this.key(right);
  }

  contains(root: string, target: string): boolean {
    const relative = this.relative(root, target);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith("../") && !this.isAbsolute(relative))
    );
  }

  key(path: string): string {
    const normalized = this.normalize(path);
    return this.caseSensitive ? normalized : normalized.toLowerCase();
  }
}
