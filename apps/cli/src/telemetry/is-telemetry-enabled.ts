const enabledValues = new Set(["1", "true", "on", "yes"]);

export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.SYMNAV_TELEMETRY;
  return value !== undefined && enabledValues.has(value.trim().toLowerCase());
}
