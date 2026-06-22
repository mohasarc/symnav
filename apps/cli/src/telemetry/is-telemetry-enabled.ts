const disabledValues = new Set(["0", "false", "off", "no"]);

export function isTelemetryEnabled(env: NodeJS.ProcessEnv): boolean {
  const value = env.SYMNAV_TELEMETRY;
  return value === undefined || !disabledValues.has(value.trim().toLowerCase());
}
