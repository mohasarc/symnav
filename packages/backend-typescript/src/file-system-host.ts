import type { FileSystem } from "@symnav/core";
import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";

/**
 * Adapt our `FileSystem` to ts-morph's `FileSystemHost` so ts-morph
 * never reaches the real filesystem when a custom workspace fs is in use.
 *
 * Stage 1 only needs read-side methods plus enough probing for ts-morph to
 * load a single file: `readFile` / `readFileSync`, `fileExists` /
 * `fileExistsSync`, `directoryExists` / `directoryExistsSync`, `readDirSync`,
 * `realpathSync`, `getCurrentDirectory`, `isCaseSensitive`, and the glob
 * helpers. Mutating methods (`writeFile`, `delete`, `move`, `copy`, `mkdir`)
 * throw `unsupportedOperation` so a future use-case forces an explicit
 * decision rather than silent disk access.
 */
export function fileSystemHostFromWorkspace(fs: FileSystem): FileSystemHost {
  return {
    isCaseSensitive(): boolean {
      return true;
    },
    delete(path: string): Promise<void> {
      return Promise.reject(unsupportedOperation("delete", path));
    },
    deleteSync(path: string): void {
      throw unsupportedOperation("deleteSync", path);
    },
    readDirSync(dirPath: string): RuntimeDirEntry[] {
      const entries = fs.listDirSync(dirPath);
      return entries.map((name) => {
        const childPath = joinPath(dirPath, name);
        const isDirectory = fs.isDirectorySync(childPath);
        return {
          name: childPath,
          isFile: !isDirectory,
          isDirectory,
          isSymlink: false,
        };
      });
    },
    async readFile(filePath: string, _encoding?: string): Promise<string> {
      return fs.readFile(filePath);
    },
    readFileSync(filePath: string, _encoding?: string): string {
      return fs.readFileSync(filePath);
    },
    writeFile(filePath: string): Promise<void> {
      return Promise.reject(unsupportedOperation("writeFile", filePath));
    },
    writeFileSync(filePath: string): void {
      throw unsupportedOperation("writeFileSync", filePath);
    },
    mkdir(dirPath: string): Promise<void> {
      return Promise.reject(unsupportedOperation("mkdir", dirPath));
    },
    mkdirSync(dirPath: string): void {
      throw unsupportedOperation("mkdirSync", dirPath);
    },
    move(srcPath: string, _destPath: string): Promise<void> {
      return Promise.reject(unsupportedOperation("move", srcPath));
    },
    moveSync(srcPath: string, _destPath: string): void {
      throw unsupportedOperation("moveSync", srcPath);
    },
    copy(srcPath: string, _destPath: string): Promise<void> {
      return Promise.reject(unsupportedOperation("copy", srcPath));
    },
    copySync(srcPath: string, _destPath: string): void {
      throw unsupportedOperation("copySync", srcPath);
    },
    async fileExists(filePath: string): Promise<boolean> {
      return fs.existsSync(filePath) && !fs.isDirectorySync(filePath);
    },
    fileExistsSync(filePath: string): boolean {
      return fs.existsSync(filePath) && !fs.isDirectorySync(filePath);
    },
    async directoryExists(dirPath: string): Promise<boolean> {
      return fs.isDirectorySync(dirPath);
    },
    directoryExistsSync(dirPath: string): boolean {
      return fs.isDirectorySync(dirPath);
    },
    realpathSync(path: string): string {
      return path;
    },
    getCurrentDirectory(): string {
      return "/";
    },
    glob(_patterns: ReadonlyArray<string>): Promise<string[]> {
      return Promise.resolve([]);
    },
    globSync(_patterns: ReadonlyArray<string>): string[] {
      return [];
    },
  };
}

function joinPath(dirPath: string, name: string): string {
  if (dirPath === "" || dirPath === "/") {
    return `/${name}`;
  }
  return dirPath.endsWith("/") ? `${dirPath}${name}` : `${dirPath}/${name}`;
}

function unsupportedOperation(method: string, path: string): Error {
  return new Error(
    `fileSystemHostFromWorkspace: unsupported ${method} on ${path} — workspace adapter is read-only`,
  );
}
