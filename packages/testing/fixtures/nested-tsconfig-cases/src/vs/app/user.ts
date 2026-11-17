import { HistoryNavigator } from "vs/base/history";

export function recordVisit(page: string): HistoryNavigator {
  const history = new HistoryNavigator();
  history.add(page);
  return history;
}
