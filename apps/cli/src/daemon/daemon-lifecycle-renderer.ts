import type { DaemonStartResult } from "./daemon-protocol.js";

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
}
