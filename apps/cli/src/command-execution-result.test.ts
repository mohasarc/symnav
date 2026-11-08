import { DaemonControlledFailureMessage } from "@symnav/daemon";
import { describe, expect, it } from "vitest";
import {
  ControlledCommandResult,
  type CommandExecutionResult,
} from "./command-execution-result.js";

class ControlledStderr {
  static async read(result: CommandExecutionResult): Promise<string> {
    const chunks: string[] = [];
    for await (const record of result.output.records()) {
      expect(record.stream).toBe("stderr");
      chunks.push(Buffer.from(record.bytes).toString("utf8"));
    }
    return chunks.join("");
  }
}

describe("ControlledCommandResult", () => {
  it.each([
    [
      "accepted request did not complete",
      ControlledCommandResult.acceptedRequestDidNotComplete(),
      DaemonControlledFailureMessage.acceptedRequestDidNotComplete,
    ],
    [
      "response capacity exceeded",
      ControlledCommandResult.responseCapacityExceeded(),
      DaemonControlledFailureMessage.responseCapacityExceeded,
    ],
  ])("writes the daemon-owned %s message, exit 1", async (_name, result, message) => {
    expect(result.exitCode).toBe(1);
    expect(await ControlledStderr.read(result)).toBe(message);
  });
});
