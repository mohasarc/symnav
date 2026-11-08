export class CommandErrorLine {
  static render(reason: string): string {
    return `symnav: error: ${reason}\n`;
  }

  static renderError(error: unknown): string {
    return CommandErrorLine.render(error instanceof Error ? error.message : String(error));
  }
}
