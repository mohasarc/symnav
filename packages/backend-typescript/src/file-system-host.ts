import type { FileSystemHost, RuntimeDirEntry } from "ts-morph";
import type { WorkspaceFileSystem } from "@symnav/core";

export function fileSystemHostFromWorkspace(fs: WorkspaceFileSystem): FileSystemHost {
  function unsupported(method: string): never {
    throw new Error(
      `fileSystemHostFromWorkspace: ${method} is not supported in single-file overview mode`,
    );
  }

  return {
    isCaseSensitive() {
      return true;
    },
    delete(_path) {
      return unsupported("delete");
    },
    deleteSync(_path) {
      return unsupported("deleteSync");
    },
    readDirSync(absPath): RuntimeDirEntry[] {
      const names = fs.listDirSync(absPath);
      return names.map((name) => ({
        name: `${absPath}/${name}`,
        isFile: !fs.isDirectorySync(`${absPath}/${name}`),
        isDirectory: fs.isDirectorySync(`${absPath}/${name}`),
        isSymlink: false,
      }));
    },
    async readFile(absPath, _encoding) {
      return fs.readFile(absPath);
    },
    readFileSync(absPath, _encoding) {
      return fs.readFileSync(absPath);
    },
    writeFile(_absPath, _data) {
      return unsupported("writeFile");
    },
    writeFileSync(_absPath, _data) {
      return unsupported("writeFileSync");
    },
    async mkdir(_path) {
      unsupported("mkdir");
    },
    mkdirSync(_path) {
      unsupported("mkdirSync");
    },
    move(_src, _dest) {
      return unsupported("move");
    },
    moveSync(_src, _dest) {
      return unsupported("moveSync");
    },
    copy(_src, _dest) {
      return unsupported("copy");
    },
    copySync(_src, _dest) {
      return unsupported("copySync");
    },
    async fileExists(absPath) {
      return fs.exists(absPath);
    },
    fileExistsSync(absPath) {
      return fs.existsSync(absPath) && !fs.isDirectorySync(absPath);
    },
    async directoryExists(absPath) {
      return fs.isDirectorySync(absPath);
    },
    directoryExistsSync(absPath) {
      return fs.isDirectorySync(absPath);
    },
    realpathSync(absPath) {
      return absPath;
    },
    getCurrentDirectory() {
      return "/";
    },
    glob(_patterns) {
      return Promise.resolve([]);
    },
    globSync(_patterns) {
      return [];
    },
  };
}
