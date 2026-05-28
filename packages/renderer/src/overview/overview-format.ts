export function formatOverviewHeader(filePath: string): string {
  return `Overview: ${filePath}\n`;
}

export function formatEmptyOverview(filePath: string): string {
  return `${formatOverviewHeader(filePath)}(no symbols)\n`;
}

export function formatSignatureLine(prefix: string, lineNumber: number, text: string): string {
  return `${prefix}${lineNumber} ${text}\n`;
}
