const { existsSync } = require("node:fs");
const { isMainThread } = require("node:worker_threads");

const entryPath = process.argv[1] ?? "";
const secret = process.env.SYMNAV_TEST_DAEMON_OUTPUT_SECRET;
const crashTrigger = process.env.SYMNAV_TEST_DAEMON_CRASH_TRIGGER;
if (isMainThread && entryPath.endsWith("daemon-entry.js") && secret && crashTrigger) {
  process.stdout.write(`${secret}:stdout\n`);
  process.stderr.write(`${secret}:stderr:${"x".repeat(10 * 1024 * 1024 + 1024)}\n`);
  process.emitWarning(new Error(`${secret}:warning`));
  const trigger = setInterval(() => {
    if (!existsSync(crashTrigger)) return;
    clearInterval(trigger);
    setImmediate(() => {
      throw new Error(`${secret}:uncaught`);
    });
  }, 10);
  trigger.unref();
}
