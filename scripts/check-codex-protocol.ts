import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const requiredRequestMethods = [
  "initialize",
  "thread/start",
  "thread/list",
  "thread/read",
  "thread/turns/list",
  "thread/items/list",
  "thread/loaded/list",
  "turn/start",
  "turn/steer",
  "turn/interrupt",
];

const requiredServerMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
];

const requiredNotifications = [
  "thread/status/changed",
  "turn/started",
  "turn/completed",
  "turn/plan/updated",
  "item/started",
  "item/completed",
  "serverRequest/resolved",
];

async function main() {
  const { stdout } = await execFileAsync("codex", ["--version"]);
  const version = stdout.trim();
  if (!/codex-cli 0\.(?:148|149|150|151|152|153|154|155|157)\./.test(version)) {
    throw new Error(`Expected Codex 0.148.x–0.155.x or 0.157.x, received: ${version}`);
  }

  const outputDirectory = await mkdtemp(join(tmpdir(), "session-atlas-protocol-"));
  try {
    await execFileAsync("codex", [
      "app-server",
      "generate-ts",
      "--experimental",
      "--out",
      outputDirectory,
    ]);

    const [client, server, notifications] = await Promise.all([
      readFile(join(outputDirectory, "ClientRequest.ts"), "utf8"),
      readFile(join(outputDirectory, "ServerRequest.ts"), "utf8"),
      readFile(join(outputDirectory, "ServerNotificationEnvelope.ts"), "utf8"),
    ]);

    const missing = [
      ...requiredRequestMethods.filter((method) => !client.includes(`\"${method}\"`)),
      ...requiredServerMethods.filter((method) => !server.includes(`\"${method}\"`)),
      ...requiredNotifications.filter((method) => !notifications.includes(`\"${method}\"`)),
    ];

    if (missing.length > 0) {
      throw new Error(`Codex App Server contract is missing: ${missing.join(", ")}`);
    }

    process.stdout.write(`${version}: required Session Atlas protocol surface is present.\n`);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

await main();
