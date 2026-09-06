import { DaemonTestingInspector } from "@symnav/daemon/testing";
import { StateDirectoryResolver } from "../../src/state-directory-resolver.js";

export class CliDaemonTesting {
  readonly inspector: DaemonTestingInspector;

  constructor(stateDirectory: string) {
    this.inspector = new DaemonTestingInspector(
      StateDirectoryResolver.canonicalize(stateDirectory),
    );
  }

  processIds(): readonly number[] {
    return this.inspector.listInstances().map((instance) => instance.pid);
  }
}
