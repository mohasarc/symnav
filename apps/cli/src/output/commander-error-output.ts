export class CommanderErrorOutput {
  static write(message: string, write: (text: string) => void): void {
    write(`symnav: ${message}`);
  }
}
