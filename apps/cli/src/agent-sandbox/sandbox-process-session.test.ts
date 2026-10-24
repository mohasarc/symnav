import { expect, it } from "vitest";
import { SandboxProcessSession } from "./sandbox-process-session.js";

it("keeps one owned wrapper alive through request and cleanup and observes its exit", async () => {
  const source = `const readline=require('node:readline');console.log(JSON.stringify({id:0,reply:{kind:'ready'}}));readline.createInterface({input:process.stdin}).on('line',line=>{const {id,message}=JSON.parse(line);console.log(JSON.stringify({id,reply:message.action==='cleanup'?{kind:'cleaned'}:{kind:'command',exitCode:0,stdout:'proof',stderr:''}}));});`;
  const session = new SandboxProcessSession({
    executable: process.execPath,
    argv: ["-e", source],
    cwd: process.cwd(),
    environment: process.env,
  });
  try {
    await session.ready(AbortSignal.timeout(2000));
    expect(await session.request({ action: "run" })).toMatchObject({
      kind: "command",
      stdout: "proof",
    });
    expect(await session.request({ action: "cleanup" })).toEqual({ kind: "cleaned" });
  } finally {
    await session.close();
  }
  await expect(session.request({ action: "run" })).rejects.toThrow("exited");
});
it("cancels a pending request and closes only its retained wrapper", async () => {
  const session = new SandboxProcessSession({
    executable: process.execPath,
    argv: [
      "-e",
      "console.log(JSON.stringify({id:0,reply:{kind:'ready'}}));process.stdin.resume();",
    ],
    cwd: process.cwd(),
    environment: process.env,
  });
  await session.ready(AbortSignal.timeout(2000));
  const controller = new AbortController();
  const request = session.request({ action: "run" }, controller.signal);
  controller.abort(new Error("cancelled"));
  await expect(request).rejects.toThrow("cancelled");
  await session.close();
});
