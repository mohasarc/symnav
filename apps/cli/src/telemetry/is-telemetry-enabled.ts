export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SYMNAV_TELEMETRY !== "0";
}
