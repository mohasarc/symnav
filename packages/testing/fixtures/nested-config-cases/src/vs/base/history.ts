export class HistoryNavigator2 {
  private readonly entries: string[] = [];

  add(entry: string): void {
    this.entries.push(entry);
  }
}
