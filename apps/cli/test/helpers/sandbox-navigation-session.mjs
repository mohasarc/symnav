import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, createConnection } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";

class SandboxNavigationSession {
  static async main() {
    process.env.TMPDIR = process.argv[3];
    process.env.TMP = process.argv[3];
    process.env.TEMP = process.argv[3];
    process.stdout.write(JSON.stringify({ ready: true }) + "\n");
    const input = createInterface({ input: process.stdin });
    for await (const line of input) {
      const request = JSON.parse(line);
      try {
        const result =
          request.kind === "permissions"
            ? await this.permissions(request)
            : await this.run(request.argv, request.environment, request.script);
        process.stdout.write(JSON.stringify(result) + "\n");
      } catch (error) {
        process.stdout.write(JSON.stringify({ error: String(error) }) + "\n");
      }
    }
  }

  static run(argv, environment = {}, script = process.argv[2]) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [script, ...argv], {
        env: { ...process.env, ...environment },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on("data", (bytes) => stdout.push(bytes));
      child.stderr.on("data", (bytes) => stderr.push(bytes));
      child.once("error", reject);
      child.once("close", (status) =>
        resolve({
          status,
          stdout: Buffer.concat(stdout).toString(),
          stderr: Buffer.concat(stderr).toString(),
        }),
      );
    });
  }

  static async permissions(request) {
    let writeCode;
    try {
      writeFileSync(request.forbiddenPath, "forbidden");
    } catch (error) {
      writeCode = error.code;
    }
    const unixCode = await this.bind(join(process.env.SYMNAV_STATE_DIR, "denied.sock"));
    const tcpCode = await this.connectHost(request.hostPort);
    return { writeCode, unixCode, tcpCode };
  }

  static connectHost(port) {
    return new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (code) => {
        socket.destroy();
        resolve(code);
      };
      socket.once("connect", () => finish("allowed"));
      socket.once("error", (error) => finish(error.code));
      socket.setTimeout(1000, () => finish("ETIMEDOUT"));
    });
  }

  static bind(address) {
    return new Promise((resolve) => {
      const server = createServer();
      server.once("error", (error) => resolve(error.code));
      server.listen(address, () => server.close(() => resolve("allowed")));
    });
  }
}

await SandboxNavigationSession.main();
