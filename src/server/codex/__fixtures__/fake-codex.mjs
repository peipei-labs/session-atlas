import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  process.stdout.write(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.148.7"}\n`);
  process.exit(0);
}

const now = Math.floor(Date.now() / 1_000);
const thread = {
  id: "thread-1",
  sessionId: "session-1",
  preview: "Fixture thread",
  createdAt: now,
  updatedAt: now,
  recencyAt: now,
  status: { type: "idle" },
  cwd: "/tmp/fixture-project",
  cliVersion: process.env.FAKE_CODEX_VERSION ?? "0.148.7",
  source: "appServer",
  canAcceptDirectInput: true,
  gitInfo: { sha: null, branch: "main", originUrl: null },
  name: null,
  turns: [],
};

const turn = {
  id: "turn-1",
  items: [{ type: "userMessage", id: "item-1", clientId: null, content: [] }],
  itemsView: "full",
  status: "inProgress",
  error: null,
  startedAt: now,
  completedAt: null,
  durationMs: null,
};

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
if (process.env.FAKE_STUBBORN === "1") {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 1_000);
}
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        userAgent: `codex_app_server/${process.env.FAKE_CODEX_VERSION ?? "0.148.7"}`,
        codexHome: "/tmp/fake-codex-home",
        platformFamily: "unix",
        platformOs: "macos",
      },
    });
    return;
  }
  if (message.method === "initialized") {
    if (process.env.FAKE_MALFORMED === "1") {
      process.stdout.write("{malformed\n");
    }
    if (process.env.FAKE_SERVER_REQUEST === "question") {
      setTimeout(() => {
        send({
          id: "server-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: "item-1",
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: true,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
            isBlocking: true,
            autoResolutionMs: null,
          },
        });
      }, 5);
    }
    if (process.env.FAKE_SERVER_REQUEST === "permission") {
      setTimeout(() => {
        send({
          id: "server-1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: thread.id,
            turnId: turn.id,
            itemId: "permission-1",
            environmentId: null,
            startedAtMs: Date.now(),
            cwd: thread.cwd,
            reason: "Need build output access",
            permissions: {
              network: null,
              fileSystem: { read: null, write: ["/tmp/build"], entries: [] },
            },
          },
        });
      }, 5);
    }
    return;
  }
  if (message.method === "thread/list") {
    setTimeout(
      () => send({ id: message.id, result: { data: [thread], nextCursor: null, backwardsCursor: null } }),
      15,
    );
    return;
  }
  if (message.method === "thread/loaded/list") {
    send({ id: message.id, result: { data: [thread.id], nextCursor: null } });
    return;
  }
  if (message.method === "thread/read") {
    send({ id: message.id, result: { thread } });
    return;
  }
  if (message.method === "thread/turns/list") {
    send({
      id: message.id,
      result: { data: [turn], nextCursor: null, backwardsCursor: null },
    });
    return;
  }
  if (message.method === "thread/items/list") {
    send({
      id: message.id,
      result: {
        data: turn.items.map((item) => ({ turnId: turn.id, item })),
        nextCursor: null,
        backwardsCursor: null,
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread, model: "fixture", modelProvider: "fixture", cwd: thread.cwd },
    });
    return;
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn } });
    return;
  }
  if (message.method === "turn/steer") {
    send({ id: message.id, result: { turnId: message.params.expectedTurnId } });
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id === "server-1" && Object.hasOwn(message, "result")) {
    send({ method: "test/serverResponse", params: message.result });
  }
});
