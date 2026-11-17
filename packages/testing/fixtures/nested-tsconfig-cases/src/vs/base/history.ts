export class HistoryNavigator {
  private readonly entries: string[] = [];

  add(entry: string): void {
    this.entries.push(entry);
  }
}
