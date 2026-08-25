import type {
  DaemonStartResult,
  DaemonStopResult,
  RunningDaemonStatus,
} from "./daemon-protocol.js";

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

  static renderStatusText(results: readonly RunningDaemonStatus[]): string {
    if (results.length === 0) return "No daemons running.\n";
    return `${results.map((result) => DaemonLifecycleRenderer.statusLine(result)).join("\n")}\n`;
  }

  static renderStatusJson(results: readonly RunningDaemonStatus[]): string {
    return `${JSON.stringify(results)}\n`;
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
    const prefix = `${result.workspaceRoot}  pid ${result.pid}  up ${DaemonLifecycleRenderer.uptime(result.uptimeMs)}`;
    if (result.state === "starting") return `${prefix}  starting`;
    if (result.state === "unresponsive") return `${prefix}  unresponsive`;
    if (result.state === "busy") {
      return `${prefix}  busy ${result.currentCommand ?? "unknown"}  ${DaemonLifecycleRenderer.uptime(result.currentCommandElapsedMs ?? 0)}  queued ${result.queued ?? 0}`;
    }
    const fileCount = `${result.fileCount ?? 0} files`;
    const memory = DaemonLifecycleRenderer.bytes(result.memoryBytes ?? 0);
    const lastRequest =
      result.lastRequestAgoMs === undefined
        ? "no requests"
        : `last request ${DaemonLifecycleRenderer.uptime(result.lastRequestAgoMs)} ago`;
    return `${prefix}  ${fileCount}  ${memory}  ${lastRequest}`;
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
    const precision = value >= 10 || unit === 0 ? 0 : 1;
    return `${value.toFixed(precision)} ${units[unit]}`;
  }
}
