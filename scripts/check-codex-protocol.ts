import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexAppServerClient } from "../src/server/codex/client.js";

const directory = await mkdtemp(join(tmpdir(), "session-atlas-handshake-"));
const client = new CodexAppServerClient({
  cwd: directory,
  env: { CODEX_HOME: directory },
  appServerArgs: ["app-server", "--stdio", "-c", "check_for_update_on_startup=false"],
});
try {
  await client.start();
  if (!client.writable) throw new Error(client.compatibilityReason ?? "Codex compatibility check failed.");
  const loaded = await client.threadLoadedList();
  if (!Array.isArray(loaded.data) || loaded.data.length !== 0) throw new Error("Isolated Codex inventory check failed.");
  process.stdout.write(`Codex ${client.version}: protocol contract, isolated initialize handshake and inventory passed. No model turn was sent.\n`);
} finally {
  try { await client.stop(); } finally { await rm(directory, { recursive: true, force: true }); }
}
