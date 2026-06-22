import type { ArgKind, LengthBucket } from "@symnav/telemetry";

export function classifyArgKind(value: string): ArgKind {
  if (value.length === 0) return "empty";
  if (value.includes("::")) return "symbol_id";
  if (value.includes("/") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value)) return "path";
  return "bare";
}

export function lengthBucketOf(value: string): LengthBucket {
  if (value.length === 0) return "empty";
  if (value.length <= 20) return "short";
  if (value.length <= 80) return "medium";
  return "long";
}
