import { DaemonPolicy, type DaemonPolicyValues } from "../../src/daemon-policy.js";

type DaemonPolicyOverrides = {
  readonly [Section in keyof DaemonPolicyValues]?: Partial<DaemonPolicyValues[Section]>;
};

export class DaemonPolicyTestFactory {
  static withOverrides(base: DaemonPolicy, overrides: DaemonPolicyOverrides): DaemonPolicy {
    const values = Object.fromEntries(
      Object.entries(base.values).map(([section, sectionValues]) => [
        section,
        { ...sectionValues, ...overrides[section as keyof DaemonPolicyValues] },
      ]),
    ) as unknown as DaemonPolicyValues;
    return DaemonPolicy.fromSerialized({ schemaVersion: 1, values });
  }
}
