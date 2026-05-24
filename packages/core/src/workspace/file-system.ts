export interface FileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  listDir(absPath: string): Promise<readonly string[]>;
  isDirectory(absPath: string): Promise<boolean>;
  existsSync(absPath: string): boolean;
  readFileSync(absPath: string): string;
  listDirSync(absPath: string): readonly string[];
  isDirectorySync(absPath: string): boolean;
}
