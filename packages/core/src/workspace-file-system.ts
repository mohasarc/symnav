export interface WorkspaceFileSystem {
  readFile(absPath: string): Promise<string>;
  exists(absPath: string): Promise<boolean>;
  existsSync(absPath: string): boolean;
  readFileSync(absPath: string): string;
  listDirSync(absPath: string): readonly string[];
  isDirectorySync(absPath: string): boolean;
}
