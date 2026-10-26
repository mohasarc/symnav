import type {
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
  DaemonStatusReport,
  DaemonFailure,
} from "@symnav/daemon";

export class DaemonLifecycleRenderer {
  static renderStartText(result: DaemonStartResult): string {
    if (result.status === "ready") {
      return `Daemon ready for ${result.workspaceRoot}\n${result.fileCount} files loaded in ${DaemonLifecycleRenderer.duration(result.loadDurationMs)}\n`;
    }
    if (result.status === "already-running") {
      return `Daemon already running for ${result.workspaceRoot} (pid ${result.pid}, up ${DaemonLifecycleRenderer.uptime(result.uptimeMs)})\n`;
    }
    return "Daemon disabled by SYMNAV_DAEMON=0\n";
  }

  static renderStartJson(result: DaemonStartResult): string {
    return `${JSON.stringify(result)}\n`;
  }

  static renderStatusText(report: DaemonStatusReport, now = Date.now()): string {
    const lines =
      report.daemons.length === 0
        ? ["No daemons running."]
        : report.daemons.flatMap((daemon) => {
            const status = DaemonLifecycleRenderer.statusLine(daemon);
            const fallbacks = daemon.recentFallbacks;
            return fallbacks === undefined
              ? [status]
              : [
                  status,
                  `  ${fallbacks.count} ${fallbacks.count === 1 ? "fallback" : "fallbacks"} in last hour: ${DaemonLifecycleRenderer.failureText(fallbacks.latest)}`,
                ];
          });
    for (const startup of report.startupFailures ?? [])
      lines.push(
        `${startup.workspaceRoot}  last startup failed ${DaemonLifecycleRenderer.uptime(now - startup.failure.timestamp)} ago: ${DaemonLifecycleRenderer.failureText(startup.failure)}`,
      );
    return `${lines.join("\n")}\n`;
  }

  static renderStatusJson(report: DaemonStatusReport): string {
    return `${JSON.stringify({ schemaVersion: 1, daemons: report.daemons, ...(report.startupFailures === undefined || report.startupFailures.length === 0 ? {} : { startupFailures: report.startupFailures }) })}\n`;
  }

  private static failureText(failure: DaemonFailure): string {
    return `${failure.reason.replaceAll("-", " ")}${failure.osCode === undefined ? "" : ` (${failure.osCode})`}`;
  }

  static renderStopText(result: DaemonStopResult): string {
    if (result.status === "not-running") {
      return `No daemon running for ${result.workspaceRoot}\n`;
    }
    if (result.status === "killed") {
      return `Killed daemon for ${result.workspaceRoot} (pid ${result.pid})\n`;
    }
    return `Stopped daemon for ${result.workspaceRoot} (pid ${result.pid})\n`;
  }

  static renderStopJson(result: DaemonStopResult): string {
    return `${JSON.stringify(result)}\n`;
  }

  private static statusLine(result: RunningDaemonStatus): string {
    if (result.state === "starting") {
      const memory =
        result.memoryBytes === undefined
          ? ""
          : `  ${DaemonLifecycleRenderer.bytes(result.memoryBytes)}`;
      return `${result.workspaceRoot}  pid ${result.pid}  starting ${DaemonLifecycleRenderer.uptime(result.startupElapsedMs)}${memory}`;
    }
    const prefix = `${result.workspaceRoot}  pid ${result.pid}  up ${DaemonLifecycleRenderer.uptime(result.uptimeMs)}`;
    if (result.state === "unresponsive") return `${prefix}  unresponsive`;
    if (result.state === "busy") {
      return `${prefix}  busy ${result.command}  ${DaemonLifecycleRenderer.uptime(result.elapsedMs)}  queued ${result.queued}  ${DaemonLifecycleRenderer.bytes(result.memoryBytes)}`;
    }
    if (result.state === "recovering") {
      return `${prefix}  recovering ${result.detail}  queued ${result.queued}  ${DaemonLifecycleRenderer.bytes(result.memoryBytes)}`;
    }
    const fileCount = `${result.fileCount} files`;
    const memory = DaemonLifecycleRenderer.bytes(result.memoryBytes);
    const lastRequest =
      result.lastRequestAgoMs === undefined
        ? "no requests"
        : `last request ${DaemonLifecycleRenderer.uptime(result.lastRequestAgoMs)} ago`;
    return `${prefix}  ready  ${fileCount}  ${memory}  ${lastRequest}`;
  }

  private static duration(durationMs: number): string {
    if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))}ms`;
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  private static uptime(uptimeMs: number): string {
    const seconds = Math.max(0, Math.floor(uptimeMs / 1_000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    return `${Math.floor(minutes / 60)}h`;
  }

  private static bytes(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"];
    let value = Math.max(0, bytes);
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit += 1;
    }
    const precision = value >= 10 || unit === 0 || Number.isInteger(value) ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unit]}`;
  }
}
