#!/usr/bin/env node
import { CliProgramExecutor, CommandResultReplayer } from "./cli-program-executor.js";
import { createDefaultDependencies, createDefaultProgramContext } from "./program.js";

const dependencies = createDefaultDependencies();
const result = await new CliProgramExecutor(dependencies).execute({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  telemetryEnabled: dependencies.telemetryEnabled,
});
CommandResultReplayer.replay(result, createDefaultProgramContext());
