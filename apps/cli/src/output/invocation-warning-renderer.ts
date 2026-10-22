import type { CommandWarning, InvocationWarningOptions } from "./invocation-warning.js";

export class InvocationWarningRenderer {
  public constructor(private readonly options: InvocationWarningOptions) {}

  public render(warning: CommandWarning): string | undefined {
    if (!this.options.warnings) return undefined;
    return `symnav: warning: ${warning.message}\n`;
  }
}
