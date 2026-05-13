export interface ProgramContext {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  cwd: string;
  exit: (code: number) => never;
}
