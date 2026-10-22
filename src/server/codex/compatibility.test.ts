import { mkdtemp, writeFile, readFile, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fixtureBundle } from "./__fixtures__/compatibility-bundle.js";
import { probeCodexCompatibility } from "./compatibility.js";

vi.mock("./compatibility-baseline.js", async () => {
  const { fixtureBundle } = await import("./__fixtures__/compatibility-bundle.js");
  const { contractSignatures } = await import("./compatibility-contract.js");
  return { baseline: contractSignatures(fixtureBundle()) };
});
const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function fakeExecutable() {
  const directory = await mkdtemp(join(tmpdir(), "atlas-compat-test-"));
  directories.push(directory);
  const executable = join(directory, "codex");
  const bundle = fixtureBundle();
  await writeFile(join(directory, "bundle.json"), JSON.stringify(bundle));
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  console.log('codex-cli ' + (process.env.TEST_CODEX_VERSION || '0.999.0'));
} else {
  fs.appendFileSync(path.join(__dirname, 'calls'), 'schema\\n');
  if (process.env.TEST_FAIL === '1') { console.error('private diagnostic must not escape'); process.exit(1); }
  const out = process.argv[process.argv.indexOf('--out') + 1];
  fs.copyFileSync(path.join(__dirname, 'bundle.json'), path.join(out, 'codex_app_server_protocol.schemas.json'));
}
`, { mode: 0o700 });
  return { directory, executable, bundle, calls: async () => (await readFile(join(directory, "calls"), "utf8")).trim().split("\n").length };
}

describe("Codex compatibility trigger and cache", () => {
  it("reuses a successful check, then invalidates it for a new version or replaced binary", async () => {
    const fake = await fakeExecutable();
    const options = { executable: fake.executable };
    expect((await probeCodexCompatibility(options)).compatible).toBe(true);
    expect((await probeCodexCompatibility(options)).compatible).toBe(true);
    expect(await fake.calls()).toBe(1);
    const updated = { ...options, env: { TEST_CODEX_VERSION: "1.0.0" } };
    expect((await probeCodexCompatibility(updated)).compatible).toBe(true);
    expect(await fake.calls()).toBe(2);
    await appendFile(fake.executable, "\n// binary replacement\n");
    expect((await probeCodexCompatibility(updated)).compatible).toBe(true);
    expect(await fake.calls()).toBe(3);
  });

  it("does not cache failures or expose subprocess output", async () => {
    const fake = await fakeExecutable();
    const failed = await probeCodexCompatibility({ executable: fake.executable, env: { TEST_FAIL: "1" } });
    expect(failed.compatible).toBe(false);
    expect(failed.reason).toContain("schema generation failed");
    expect(JSON.stringify(failed)).not.toContain("private diagnostic");
    expect((await probeCodexCompatibility({ executable: fake.executable })).compatible).toBe(true);
    expect(await fake.calls()).toBe(2);
  });

  it("reports changed field paths and retries after the contract is repaired", async () => {
    const fake = await fakeExecutable();
    fake.bundle.definitions.Payload.properties.threadId.type = "number";
    await writeFile(join(fake.directory, "bundle.json"), JSON.stringify(fake.bundle));
    const result = await probeCodexCompatibility({ executable: fake.executable });
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("Payload/properties/threadId");
    fake.bundle.definitions.Payload.properties.threadId.type = "string";
    await writeFile(join(fake.directory, "bundle.json"), JSON.stringify(fake.bundle));
    expect((await probeCodexCompatibility({ executable: fake.executable })).compatible).toBe(true);
  });

  it("fails closed when the executable is absent", async () => {
    const result = await probeCodexCompatibility({ executable: "/nonexistent/session-atlas-codex" });
    expect(result.compatible).toBe(false);
    expect(result.reason).toContain("executable lookup");
  });
});
