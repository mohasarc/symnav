import { isAbsolute, resolve } from "node:path";

export function resolveInputPath(args: { cwd: string; inputPath: string }): string {
  if (isAbsolute(args.inputPath)) {
    return args.inputPath;
  }
  return resolve(args.cwd, args.inputPath);
}
