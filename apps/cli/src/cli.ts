#!/usr/bin/env node
import { CommandResultReplayer } from "./cli-program-executor.js";
import { DaemonCommandDispatcher } from "./daemon/daemon-command-dispatcher.js";
import { createDefaultDependencies, createDefaultProgramContext } from "./program.js";
import { StateDirectoryResolver } from "./state-directory-resolver.js";
import { DaemonPolicy } from "@symnav/daemon";

const stateDirectory = new StateDirectoryResolver(process.env).resolve();
const daemonPolicy = DaemonPolicy.currentSystem();
const dependencies = createDefaultDependencies(stateDirectory, daemonPolicy);
const dispatched = await new DaemonCommandDispatcher({
  createDependencies: (canonicalStateDirectory) =>
    createDefaultDependencies(canonicalStateDirectory, daemonPolicy),
  stateDirectory,
  policy: daemonPolicy,
  daemonEnabled: () => process.env.SYMNAV_DAEMON !== "0",
}).execute({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetryEnabled: dependencies.telemetryEnabled,
  executionMode: "cold",
});
await CommandResultReplayer.replay(dispatched.result, createDefaultProgramContext());
