declare const flag: boolean;
declare const values: readonly string[];
declare const mode: "read" | "write";
declare function tap(value: string): void;

export const topLevelValue = "root";

tap(topLevelValue);

if (flag) {
  const branchValue = "branch";
  tap(branchValue);
}

for (const value of values) {
  const loopValue = value.toUpperCase();
  tap(loopValue);
}

for (let index = 0; index < values.length; index += 1) {
  const indexedValue = values[index];
  tap(indexedValue);
}

while (flag) {
  const whileValue = values[0];
  tap(whileValue);
  break;
}

switch (mode) {
  case "read": {
    const readMode = "read";
    tap(readMode);
    break;
  }
  case "write": {
    const writeMode = "write";
    tap(writeMode);
    break;
  }
}

try {
  const tryValue = "try";
  tap(tryValue);
} catch (error) {
  const caughtError = error;
  void caughtError;
} finally {
  const cleanupValue = "cleanup";
  tap(cleanupValue);
}

{
  const blockValue = "block";
  tap(blockValue);
}

values.map((value) => {
  const callbackValue = value.toLowerCase();
  return callbackValue;
});

export class FoldMemberHost {
  run(): void {
    if (flag) {
      const memberBranchValue = this.memberValue();
      tap(memberBranchValue);
    }
  }

  private memberValue(): string {
    return topLevelValue;
  }
}

export function outerDeclaration(): void {
  function nestedDeclaration(): string {
    return "nested";
  }

  tap(nestedDeclaration());
}

export const initializerHost = (): string => {
  function initializerNestedDeclaration(): string {
    return "initializer-nested";
  }

  return initializerNestedDeclaration();
};
