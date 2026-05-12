import type { FileSystem } from "@symnav/core";
import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

const UNSUPPORTED_HOST_METHOD = "WorkspaceFileSystemHost: unsupported method in single-file mode";

function unsupported(): never {
  throw new Error(UNSUPPORTED_HOST_METHOD);
}

export class WorkspaceFileSystemHost implements FileSystemHost {
  constructor(private readonly fs: FileSystem) {}

  isCaseSensitive(): boolean {
    return true;
  }

  async readFile(filePath: string): Promise<string> {
    return this.fs.readFile(filePath);
  }

  readFileSync(filePath: string): string {
    return this.fs.readFileSync(filePath);
  }

  async fileExists(filePath: string): Promise<boolean> {
    return this.fs.existsSync(filePath) && !this.fs.isDirectorySync(filePath);
  }

  fileExistsSync(filePath: string): boolean {
    return this.fs.existsSync(filePath) && !this.fs.isDirectorySync(filePath);
  }

  async directoryExists(dirPath: string): Promise<boolean> {
    return this.fs.isDirectorySync(dirPath);
  }

  directoryExistsSync(dirPath: string): boolean {
    return this.fs.isDirectorySync(dirPath);
  }

  realpathSync(path: string): string {
    return path;
  }

  getCurrentDirectory(): string {
    return "/";
  }

  readDirSync(_dirPath: string): RuntimeDirEntry[] {
    return unsupported();
  }

  async delete(_path: string): Promise<void> {
    return unsupported();
  }

  deleteSync(_path: string): void {
    return unsupported();
  }

  async writeFile(_filePath: string, _fileText: string): Promise<void> {
    return unsupported();
  }

  writeFileSync(_filePath: string, _fileText: string): void {
    return unsupported();
  }

  async mkdir(_dirPath: string): Promise<void> {
    return unsupported();
  }

  mkdirSync(_dirPath: string): void {
    return unsupported();
  }

  async move(_srcPath: string, _destPath: string): Promise<void> {
    return unsupported();
  }

  moveSync(_srcPath: string, _destPath: string): void {
    return unsupported();
  }

  async copy(_srcPath: string, _destPath: string): Promise<void> {
    return unsupported();
  }

  copySync(_srcPath: string, _destPath: string): void {
    return unsupported();
  }

  async glob(_patterns: ReadonlyArray<string>): Promise<string[]> {
    return unsupported();
  }

  globSync(_patterns: ReadonlyArray<string>): string[] {
    return unsupported();
  }
}
