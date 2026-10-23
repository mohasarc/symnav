import * as files from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonPolicy } from "../daemon-policy.js";
import { PosixDaemonProcessLifetime } from "../process/posix-process-lifetime.js";
import { DaemonStateWriteErrors } from "../state-write-errors.js";
import { DaemonRegistry } from "./registry.js";
import { DaemonWorkspaceIdentity } from "./workspace-identity.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

describe.skipIf(process.platform === "win32")("prepared registry owner write provenance", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(["startup", "mutation"] as const)(
    "retains denied nested %s owner publication",
    (operation) => {
      const state = files.mkdtempSync(join(tmpdir(), "symnav-owner-write-"));
      const identity = DaemonWorkspaceIdentity.from(join(state, "workspace"), state);
      const registry = new DaemonRegistry(
        DaemonWorkspaceIdentity.registryDirectory(state),
        DaemonPolicy.currentSystem().values.startup,
      );
      const lease =
        operation === "mutation" ? registry.acquireStartup(identity, "instance")! : undefined;
      let publicationPath = "";
      let publication: Record<string, unknown> = {};
      const denied = Object.assign(new Error("publication denied"), {
        code: "EPERM",
        syscall: "open",
        path: "",
      });
      vi.mocked(files.writeFileSync).mockImplementationOnce((path, contents) => {
        publicationPath = String(path);
        publication = JSON.parse(String(contents)) as Record<string, unknown>;
        denied.path = publicationPath;
        throw denied;
      });
      let failure: unknown;
      try {
        if (operation === "startup") registry.acquireStartup(identity, "instance");
        else lease!.heartbeat();
      } catch (error) {
        failure = error;
      }
      try {
        expect(DaemonStateWriteErrors.from(failure)).toEqual({
          path: publicationPath,
          osCode: "EPERM",
        });
        expect((failure as Error).cause).toBe(denied);
        expect(basename(publicationPath)).toBe("owner.json");
        const token = operation === "startup" ? publication.claimToken : publication.token;
        expect(token).toEqual(expect.stringMatching(/^[a-f0-9-]{36}$/u));
        expect(basename(dirname(publicationPath))).toBe(token);
        expect(publication.ownerLifetime).toEqual(PosixDaemonProcessLifetime.current(state));
        if (lease !== undefined) expect(registry.startupOwner(identity)).toEqual(lease.owner);
        else expect(registry.startupOwner(identity)).toBeUndefined();
      } finally {
        files.rmSync(state, { recursive: true, force: true });
      }
    },
  );
});
