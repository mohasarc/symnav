#!/usr/bin/env node
import { createWorkspace } from "@symnav/core";
import { CliInvocationCoordinator } from "./cli-invocation-coordinator.js";
import { CliProgramExecutor, CommandResultReplayer } from "./cli-program-executor.js";
import { createDefaultDependencies, createDefaultProgramContext } from "./program.js";
import { StateDirectoryResolver } from "./state-directory-resolver.js";
import { DaemonPolicy } from "@symnav/daemon";

const stateDirectory = new StateDirectoryResolver(process.env).resolve();
const daemonPolicy = DaemonPolicy.currentSystem();
const daemonEnabled = process.env.SYMNAV_DAEMON !== "0";
const dependencies = createDefaultDependencies(stateDirectory, daemonPolicy, daemonEnabled);
const execution = await new CliInvocationCoordinator({
  daemonClient: dependencies.daemonClient,
  createLocalExecutor: () => new CliProgramExecutor(dependencies),
  resolveWorkspaceRoot: async (startDirectory) =>
    (await createWorkspace({ startDir: startDirectory, fs: dependencies.fs })).root,
}).execute({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetryEnabled: dependencies.telemetryEnabled,
  executionMode: "cold",
});
await CommandResultReplayer.replay(execution.result, createDefaultProgramContext());
