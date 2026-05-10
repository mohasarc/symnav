import type { FileSystem } from "@symnav/core";
import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

function unsupported(operation: string): never {
  throw new Error(`WorkspaceFileSystemHost: ${operation} not supported in single-file mode`);
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
    return unsupported("readDirSync");
  }

  async delete(_path: string): Promise<void> {
    return unsupported("delete");
  }

  deleteSync(_path: string): void {
    return unsupported("deleteSync");
  }

  async writeFile(_filePath: string, _fileText: string): Promise<void> {
    return unsupported("writeFile");
  }

  writeFileSync(_filePath: string, _fileText: string): void {
    return unsupported("writeFileSync");
  }

  async mkdir(_dirPath: string): Promise<void> {
    return unsupported("mkdir");
  }

  mkdirSync(_dirPath: string): void {
    return unsupported("mkdirSync");
  }

  async move(_srcPath: string, _destPath: string): Promise<void> {
    return unsupported("move");
  }

  moveSync(_srcPath: string, _destPath: string): void {
    return unsupported("moveSync");
  }

  async copy(_srcPath: string, _destPath: string): Promise<void> {
    return unsupported("copy");
  }

  copySync(_srcPath: string, _destPath: string): void {
    return unsupported("copySync");
  }

  async glob(_patterns: ReadonlyArray<string>): Promise<string[]> {
    return unsupported("glob");
  }

  globSync(_patterns: ReadonlyArray<string>): string[] {
    return unsupported("globSync");
  }
}
