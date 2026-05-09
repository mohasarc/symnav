import { posix } from "node:path";

export function posixify(input: string): string {
  if (input.startsWith("\\\\") || input.startsWith("//")) {
    throw new Error(`UNC paths are not supported: ${input}`);
  }
  return posix.normalize(input.replace(/\\/g, "/"));
}
