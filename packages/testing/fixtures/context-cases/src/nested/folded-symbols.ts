export function foldedRoot(enabled: boolean): number {
  if (enabled) {
    function foldedInner(): number {
      return foldedLeaf();
    }

    return foldedInner();
  }

  return 0;
}

export function foldedLeaf(): number {
  return 1;
}

export const foldedHost = (enabled: boolean): number => {
  if (enabled) {
    function foldedNested(): number {
      return foldedLeaf();
    }

    return foldedNested();
  }

  return 0;
};
