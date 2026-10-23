import { Command as CommanderCommand } from "commander";
import type { InvocationWarningOptions } from "./output/invocation-warning.js";

export class InvocationProgram extends CommanderCommand {
  public warningOptions(argv: readonly string[]): InvocationWarningOptions {
    return { warnings: this.selectWarningArguments(argv).warnings };
  }

  public override parseOptions(argv: string[]): { operands: string[]; unknown: string[] } {
    return super.parseOptions(this.selectWarningArguments(argv).argv);
  }

  private selectWarningArguments(argv: readonly string[]): {
    readonly argv: string[];
    readonly warnings: boolean;
  } {
    const normalized: string[] = [];
    let command: CommanderCommand = this;
    let warnings = true;
    for (let index = 0; index < argv.length; index += 1) {
      const argument = argv[index]!;
      if (argument === "--") {
        normalized.push(...argv.slice(index));
        break;
      }
      const option = [...command.options, ...this.options].find(
        (candidate) => candidate.long === argument || candidate.short === argument,
      );
      const value = argv[index + 1];
      if (option?.required && value !== undefined) {
        if (value === "--no-warnings") normalized.push(`${argument}=${value}`);
        else normalized.push(argument, value);
        index += 1;
        continue;
      }
      if (argument === "--no-warnings") warnings = false;
      normalized.push(argument);
      command = command.commands.find((candidate) => candidate.name() === argument) ?? command;
    }
    return { argv: normalized, warnings };
  }
}
