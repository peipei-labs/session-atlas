import { AttentionStore } from "./attention-store.js";
import { CodexProvider } from "./codex/index.js";
import { DaemonTitleClient } from "./codex/daemon-titles.js";
import { loadConfig } from "./config.js";
import { SessionAtlasController } from "./controller.js";
import {
  createSessionAtlasHttpApplication,
  type SessionAtlasHttpApplication,
} from "./http-server.js";
import { ItermBridgeAdapter } from "./iterm/index.js";
import { SessionRegistry } from "./session-registry.js";
import { RecoveryStore } from "./recovery-store.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const attentionStore = new AttentionStore(config.attentionStateFile);
  const recoveryStore = new RecoveryStore(config.recoveryStateFile);
  const registry = new SessionRegistry(attentionStore, recoveryStore, config.staleAfterMs);
  const codex = new CodexProvider();
  const iterm = new ItermBridgeAdapter({
    socketPath: config.itermSocketPath,
    staleAfterMs: config.staleAfterMs,
  });
  const controller = new SessionAtlasController({ config, registry, codex, iterm, bookmarkTitleClient: new DaemonTitleClient({ timeoutMs: 1_000 }) });
  await controller.start();
  let application: SessionAtlasHttpApplication | undefined;
  try {
    application = await createSessionAtlasHttpApplication(controller, config);
    await application.listen();
  } catch (error) {
    await application?.close().catch(() => undefined);
    await controller.stop();
    throw error;
  }
  if (!application) {
    throw new Error("Session Atlas HTTP application was not created.");
  }
  console.log(`Session Atlas listening at http://${config.host}:${config.port}`);

  let stopping = false;
  const stop = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    console.log(`Session Atlas received ${signal}; shutting down.`);
    await application.close();
    await controller.stop();
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void stop(signal).then(
        () => process.exit(0),
        (error) => {
          console.error("Session Atlas shutdown failed:", error);
          process.exit(1);
        },
      );
    });
  }
}

main().catch((error) => {
  console.error("Session Atlas could not start:", error);
  process.exitCode = 1;
});
