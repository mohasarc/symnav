#!/usr/bin/env node
import { createWorkspace } from "@symnav/core";
import { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import { CliInvocationRunner } from "./cli-invocation-runner.js";
import { InvocationWorkspaceSelector } from "./invocation-workspace-selector.js";
import { isTelemetryEnabled } from "./telemetry/is-telemetry-enabled.js";
import { CliProgramExecutor } from "./cli-program-executor.js";
import { createDefaultDependencies, createDefaultProgramContext } from "./program.js";
import { StateDirectoryResolver } from "./state-directory-resolver.js";
import { DaemonPolicy } from "@symnav/daemon";

const daemonPolicy = DaemonPolicy.currentSystem();
const daemonEnabled = process.env.SYMNAV_DAEMON !== "0";
const telemetryEnabled = isTelemetryEnabled(process.env);
const selectedRoute = new InvocationWorkspaceSelector().classify(
  process.argv.slice(2),
  process.cwd(),
);
const stateRequired =
  daemonEnabled ||
  telemetryEnabled ||
  selectedRoute.kind === "control" ||
  (selectedRoute.kind === "workspace" && selectedRoute.commandName === "stats");
const stateDirectory = stateRequired ? new StateDirectoryResolver(process.env).resolve() : "";
const dependencies = createDefaultDependencies(stateDirectory, daemonPolicy, daemonEnabled);
const coordinator = new CliInvocationCoordinator({
  daemonClient: dependencies.daemonClient,
  createLocalExecutor: () => new CliProgramExecutor(dependencies),
  resolveWorkspaceRoot: async (startDirectory) =>
    (await createWorkspace({ startDir: startDirectory, fs: dependencies.fs })).root,
});
const exitCode = await new CliInvocationRunner({ dependencies, coordinator }).run(
  {
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    telemetryEnabled: dependencies.telemetryEnabled,
    executionMode: "cold",
  },
  createDefaultProgramContext(),
);
if (exitCode !== 0) process.exit(exitCode);
