import type {
  AttentionReason,
  CreateThreadInput,
  SessionAtlasSnapshot,
  SessionCapabilities,
  SessionSummary,
} from "../shared/types";

const managedCapabilities: SessionCapabilities = {
  open: true,
  focus: false,
  send: true,
  steer: true,
  interrupt: true,
  approve: true,
  answer: true,
};

const legacyCapabilities: SessionCapabilities = {
  open: true,
  focus: true,
  send: false,
  steer: false,
  interrupt: false,
  approve: false,
  answer: false,
};

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function createSession(
  id: string,
  overrides: Partial<SessionSummary> &
    Pick<SessionSummary, "projectKey" | "projectName" | "title">,
): SessionSummary {
  const legacy = overrides.surface === "legacy";
  const attentionReason: AttentionReason = overrides.attentionReason ?? null;
  const { title, projectKey, projectName, ...sessionOverrides } = overrides;

  return {
    id,
    provider: "codex",
    conversationId: legacy ? undefined : `thread-${id}`,
    runtimeId: legacy ? undefined : `turn-${id}`,
    terminalSessionId: legacy ? `w0t${id}` : undefined,
    surface: legacy ? "legacy" : "managed",
    title,
    cwd: `/Users/demo/Code/${projectName}`,
    projectKey,
    projectName,
    branch: "main",
    activityState: "idle",
    attentionReason,
    lastActivityAt: ago(12),
    observedAt: ago(0),
    stale: false,
    activities: [],
    capabilities: legacy ? legacyCapabilities : managedCapabilities,
    pinned: false,
    parked: false,
    ...sessionOverrides,
  };
}

export function createDemoSnapshot(): SessionAtlasSnapshot {
  const sessions: SessionSummary[] = [
    createSession("archive-approval", {
      projectKey: "notes-indexer",
      projectName: "notes-indexer",
      title: "实现本地笔记归档：导出与索引",
      branch: "feature/local-archive",
      activityState: "awaiting_approval",
      attentionReason: "needs_approval",
      currentActivity: "等待批准创建导出任务表",
      lastActivityAt: ago(2),
      plan: {
        done: 3,
        total: 5,
        steps: [
          { id: "1", label: "设计归档数据模型与存储结构", status: "completed" },
          { id: "2", label: "实现笔记导入与标准化", status: "completed" },
          { id: "3", label: "实现导出功能（JSON / CSV）", status: "in_progress" },
          { id: "4", label: "构建全文索引（SQLite FTS5）", status: "pending" },
          { id: "5", label: "编写集成测试与文档", status: "pending" },
        ],
      },
      activities: [
        { id: "a1", at: ago(2), label: "修改导出模块，支持按时间范围过滤" },
        { id: "a2", at: ago(3), label: "运行测试：tests/export.test.ts 通过 (24.3s)", tone: "success" },
        { id: "a3", at: ago(5), label: "创建文件：src/export/exporter.ts" },
        { id: "a4", at: ago(7), label: "更新文件：src/export/types.ts" },
        { id: "a5", at: ago(9), label: "步骤 2 完成：实现笔记导入与标准化", tone: "success" },
      ],
      pendingRequest: {
        requestId: "approval-export-table",
        threadId: "thread-archive-approval",
        turnId: "turn-archive-approval",
        kind: "approval",
        title: "创建本地导出任务表",
        detail: "需要新增一个数据库表 export_tasks，用于记录导出任务历史。",
        command:
          "CREATE TABLE export_tasks (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  type TEXT NOT NULL,\n  status TEXT NOT NULL,\n  created_at DATETIME DEFAULT CURRENT_TIMESTAMP\n);",
        cwd: "/Users/demo/Code/notes-indexer",
        choices: [
          { id: "accept", label: "批准" },
          { id: "decline", label: "拒绝" },
          { id: "revise", label: "提出修改建议" },
        ],
        receivedAt: ago(2),
      },
    }),
    createSession("atlas-question", {
      projectKey: "project-catalog",
      projectName: "Workstation/project-catalog",
      title: "整理 Project Catalog 卡片索引",
      activityState: "awaiting_input",
      attentionReason: "needs_input",
      currentActivity: "等待你选择默认排序方式",
      lastActivityAt: ago(39),
      plan: {
        done: 2,
        total: 4,
        steps: [
          { id: "1", label: "检查卡片数据源", status: "completed" },
          { id: "2", label: "整理分类字段", status: "completed" },
          { id: "3", label: "确定默认排序", status: "in_progress" },
          { id: "4", label: "生成并验证页面", status: "pending" },
        ],
      },
      activities: [{ id: "q1", at: ago(39), label: "提出问题：默认按什么字段排序", tone: "warning" }],
      pendingRequest: {
        requestId: "question-sort",
        threadId: "thread-atlas-question",
        turnId: "turn-atlas-question",
        kind: "question",
        title: "选择默认排序方式",
        detail: "这个选择会影响首页第一次打开时的项目顺序。",
        choices: [
          { id: "recent", label: "最近活动", description: "优先显示刚刚有变化的项目。" },
          { id: "pinned", label: "置顶优先", description: "先显示人工置顶，再按最近活动排序。" },
          { id: "name", label: "项目名称", description: "保持稳定的字母顺序。" },
        ],
        receivedAt: ago(39),
      },
    }),
    createSession("bilibili-done", {
      projectKey: "subtitle-worker",
      projectName: "subtitle-worker",
      title: "校验直播字幕管线",
      activityState: "idle",
      attentionReason: "newly_completed",
      currentActivity: "测试全部通过",
      lastActivityAt: ago(6),
      plan: {
        done: 5,
        total: 5,
        steps: [
          { id: "1", label: "检查输入源", status: "completed" },
          { id: "2", label: "修复分段边界", status: "completed" },
          { id: "3", label: "运行字幕测试", status: "completed" },
          { id: "4", label: "验证回放结果", status: "completed" },
          { id: "5", label: "整理结果", status: "completed" },
        ],
      },
      activities: [{ id: "d1", at: ago(6), label: "测试全部通过", tone: "success" }],
    }),
    createSession("report-builder-running", {
      projectKey: "report-builder",
      projectName: "report-builder",
      title: "整理测试报告",
      activityState: "running",
      currentActivity: "正在比对工作表字段",
      lastActivityAt: ago(14),
      plan: {
        done: 4,
        total: 6,
        steps: [
          { id: "1", label: "读取材料", status: "completed" },
          { id: "2", label: "整理字段", status: "completed" },
          { id: "3", label: "检查口径", status: "completed" },
          { id: "4", label: "汇总差异", status: "completed" },
          { id: "5", label: "生成交付物", status: "in_progress" },
          { id: "6", label: "最终检查", status: "pending" },
        ],
      },
      activities: [{ id: "i1", at: ago(14), label: "正在比对工作表字段" }],
    }),
    createSession("atlas-running", {
      projectKey: "project-catalog",
      projectName: "Workstation/project-catalog",
      title: "检查演示页面一致性",
      activityState: "running",
      currentActivity: "正在运行页面检查",
      lastActivityAt: ago(51),
      plan: {
        done: 3,
        total: 5,
        steps: [
          { id: "1", label: "读取生成规则", status: "completed" },
          { id: "2", label: "构建页面", status: "completed" },
          { id: "3", label: "检查桌面布局", status: "completed" },
          { id: "4", label: "检查移动布局", status: "in_progress" },
          { id: "5", label: "整理结果", status: "pending" },
        ],
      },
      activities: [{ id: "ar1", at: ago(51), label: "开始检查移动布局" }],
    }),
    createSession("archive-running", {
      projectKey: "notes-indexer",
      projectName: "notes-indexer",
      title: "修复索引增量刷新",
      activityState: "running",
      currentActivity: "正在运行索引测试",
      lastActivityAt: ago(85),
      plan: {
        done: 2,
        total: 5,
        steps: [
          { id: "1", label: "复现问题", status: "completed" },
          { id: "2", label: "定位索引边界", status: "completed" },
          { id: "3", label: "修改刷新逻辑", status: "in_progress" },
          { id: "4", label: "运行回归", status: "pending" },
          { id: "5", label: "记录结果", status: "pending" },
        ],
      },
      activities: [{ id: "wr1", at: ago(85), label: "开始运行索引测试" }],
    }),
  ];

  const visibleTabs = [
    ["test-runner", "test-runner (codex)", "test-runner", "/Users/demo/Code/test-runner", "ttys000", "codex"],
    [
      "windows-remote",
      "integration-tests (codex)",
      "integration-tests",
      "/Users/demo/Code/integration-tests",
      "ttys030",
      "codex",
    ],
    [
      "tool-index-a",
      "project-catalog (codex)",
      "project-catalog",
      "/Users/demo/Code/Workstation/project-catalog",
      "ttys010",
      "codex",
    ],
    [
      "tool-index-b",
      "⠹ project-catalog (codex)",
      "project-catalog",
      "/Users/demo/Code/Workstation/project-catalog",
      "ttys019",
      "esbuild",
    ],
    [
      "code-atlas",
      "Code (codex)",
      "session-atlas",
      "/Users/demo/Code/Workstation/session-atlas",
      "ttys027",
      "codex",
    ],
    [
      "code-report-builder",
      "⠋ Code (codex)",
      "report-builder",
      "/Users/demo/Code/report-builder",
      "ttys011",
      "codex",
    ],
    [
      "code-archive",
      "codex",
      "notes-indexer",
      "/Users/demo/Code/notes-indexer",
      "ttys003",
      "codex",
    ],
    [
      "tool-index-live",
      "⠙ project-catalog (codex)",
      "project-catalog",
      "/Users/demo/Code/Workstation/project-catalog",
      "ttys012",
      "codex",
    ],
    [
      "code-bilibili",
      "Code (codex)",
      "subtitle-worker",
      "/Users/demo/Code/subtitle-worker",
      "ttys009",
      "codex",
    ],
    [
      "shell",
      "session-atlas (-zsh)",
      "session-atlas",
      "/Users/demo/Code/Workstation/session-atlas",
      "ttys017",
      "zsh",
    ],
  ] as const;
  sessions.push(
    ...visibleTabs.map(([id, title, projectName, cwd, tty, jobName], index) =>
      createSession(`legacy-${id}`, {
        projectKey: projectName,
        projectName,
        title,
        cwd,
        surface: "legacy",
        focused: false,
        activityState: "idle",
        rawState: jobName === "zsh" ? "shell-visible" : "agent-visible",
        currentActivity: jobName === "zsh" ? "Shell ready (zsh)" : "Agent process detected in iTerm2",
        lastActivityAt: ago(120 + index),
        terminal: {
          tty: `/dev/${tty}`,
          jobName,
          jobPid: 52_000 + index,
          windowId: "demo-window-1",
          tabId: `demo-tab-${index + 1}`,
          windowIndex: 1,
          tabIndex: index + 1,
          paneIndex: 1,
          tabCount: visibleTabs.length,
          paneCount: index === 7 ? 2 : 1,
          currentWindow: true,
        },
        activities: [
          {
            id: `visible-${index + 1}`,
            at: ago(120 + index),
            label: jobName === "zsh" ? "Shell ready (zsh)" : "Agent process detected in iTerm2",
          },
        ],
      }),
    ),
  );

  sessions.push(
    createSession("legacy-tool-index-live-pane-2", {
      projectKey: "project-catalog",
      projectName: "project-catalog",
      title: "project-catalog (codex)",
      cwd: "/Users/demo/Code/Workstation/project-catalog",
      surface: "legacy",
      focused: true,
      activityState: "idle",
      rawState: "agent-visible",
      currentActivity: "Agent process detected in iTerm2",
      lastActivityAt: ago(128),
      terminal: {
        tty: "/dev/ttys013",
        jobName: "codex",
        jobPid: 52_013,
        windowId: "demo-window-1",
        tabId: "demo-tab-8",
        windowIndex: 1,
        tabIndex: 8,
        paneIndex: 2,
        tabCount: visibleTabs.length,
        paneCount: 2,
        currentWindow: true,
      },
      activities: [
        {
          id: "visible-8-pane-2",
          at: ago(128),
          label: "Agent process detected in iTerm2",
        },
      ],
    }),
  );

  const buriedSessions = [
    ["report-builder-position", "api-migration (codex)", "api-migration", "ttys001"],
    ["xhsmcp", "browser-tests (codex)", "browser-tests", "ttys037"],
  ] as const;
  sessions.push(
    ...buriedSessions.map(([id, title, projectName, tty], index) =>
      createSession(`buried-${id}`, {
        projectKey: projectName,
        projectName,
        title,
        cwd: `/Users/demo/Code/${projectName}`,
        surface: "legacy",
        buried: true,
        activityState: "idle",
        currentActivity: "iTerm Buried Session",
        lastActivityAt: ago(260 + index),
        terminal: {
          tty: `/dev/${tty}`,
          jobName: "codex",
          jobPid: 53_000 + index,
        },
        activities: [
          {
            id: `buried-${index + 1}`,
            at: ago(260 + index),
            label: "iTerm Buried Session",
          },
        ],
      }),
    ),
  );

  sessions.push(
    createSession("legacy-other-window-stale", {
      projectKey: "other-window",
      projectName: "other-window",
      title: "Code (codex)",
      cwd: "/Users/demo/Code/other-window",
      surface: "legacy",
      stale: true,
      activityState: "unknown",
      currentActivity: "状态已过期",
      lastActivityAt: ago(300),
      terminal: {
        tty: "/dev/ttys088",
        jobName: "codex",
        jobPid: 54_000,
        windowId: "demo-window-2",
        tabId: "demo-window-2-tab-1",
        windowIndex: 2,
        tabIndex: 1,
        paneIndex: 1,
        tabCount: 1,
        paneCount: 1,
        currentWindow: false,
      },
      activities: [
        { id: "other-window-stale", at: ago(300), label: "状态已过期" },
      ],
    }),
  );

  return {
    revision: 1,
    generatedAt: new Date().toISOString(),
    health: {
      controller: "online",
      codex: "online",
      iterm: "online",
      codexVersion: "0.148.0",
    },
    sessions,
    recoveries: [
      {
        sessionId: "00000000-0000-4000-8000-000000000001",
        cwd: "/Users/demo/Code/Workstation/session-atlas", title: "终端恢复排查笔记",
        projectName: "session-atlas", status: "closed", firstSeenAt: ago(400), lastSeenAt: ago(50), closedAt: ago(49),
        resumeCommand: "codex resume -C '/Users/demo/Code/Workstation/session-atlas' '00000000-0000-4000-8000-000000000001'",
        handoff: {
          summary: "终端恢复排查笔记", source: "user", updatedAt: ago(49), items: [],
          reference: { title: "终端恢复排查笔记", reason: "以后遇到窗口恢复问题，可以参考这段对话中的检查方法。" },
        },
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000002",
        cwd: "/Users/demo/Code/Workstation/session-atlas",
        title: "Session Atlas recovery",
        projectName: "session-atlas",
        terminalSessionId: "w0tlegacy-shell",
        status: "closed",
        firstSeenAt: ago(180),
        lastSeenAt: ago(28),
        closedAt: ago(27),
        resumeCommand:
          "codex resume -C '/Users/demo/Code/Workstation/session-atlas' '00000000-0000-4000-8000-000000000002'",
        handoff: {
          summary: "暂存关闭已完成，等待 24 小时后核验恢复记录与本机内存。",
          source: "thread", updatedAt: ago(27),
          items: [
            { id: "demo-verify", kind: "time", title: "检查次日恢复", nextAction: "恢复原线程，检查会话 ID 和待续记录是否完整。", status: "pending", anchorLabel: "本机版本安装完成", anchorAt: ago(1500), delayHours: 24, dueAt: ago(60) },
            { id: "demo-condition", kind: "condition", title: "验证实际使用反馈", condition: "完成一次真实的暂存与恢复", nextAction: "核对关闭撤销后的待续卡状态。", status: "pending" },
          ],
        },
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000003",
        cwd: "/Users/demo/Code/Workstation/project-catalog",
        title: "Project Catalog 条目展示", projectName: "project-catalog", status: "closed",
        firstSeenAt: ago(200), lastSeenAt: ago(40), closedAt: ago(39),
        resumeCommand: "codex resume -C '/Users/demo/Code/Workstation/project-catalog' '00000000-0000-4000-8000-000000000003'",
        handoff: {
          summary: "卡片样式已经完成，等待补充首页需要优先显示的项目。",
          source: "user", updatedAt: ago(39),
          items: [{ id: "demo-input", kind: "input", title: "补充置顶项目", condition: "用户提供首页置顶的项目名称", nextAction: "将确认的项目置顶并检查首页。", status: "pending" }],
        },
      },
      {
        sessionId: "00000000-0000-4000-8000-000000000004",
        cwd: "/Users/demo/Code/subtitle-worker",
        title: "直播字幕后续检查", projectName: "subtitle-worker", status: "closed",
        firstSeenAt: ago(300), lastSeenAt: ago(15), closedAt: ago(14),
        resumeCommand: "codex resume -C '/Users/demo/Code/subtitle-worker' '00000000-0000-4000-8000-000000000004'",
        handoff: {
          summary: "字幕测试通过，保留下一次开播时的回放检查。",
          source: "thread", updatedAt: ago(14),
          items: [
            { id: "demo-later", kind: "later", title: "检查真实回放", nextAction: "选一段真实回放，核对断句与时间轴。", status: "pending" },
            { id: "demo-upcoming", kind: "time", title: "复核首播字幕质量", nextAction: "恢复原线程，抽查首播录像的字幕时间轴。", status: "pending", anchorLabel: "首播结束", anchorAt: ago(30), delayHours: 4, dueAt: ago(-210) },
            { id: "demo-unknown-time", kind: "time", title: "开播后检查", anchorLabel: "下一次直播开始，时间尚未确定", delayHours: 1, nextAction: "确认开播时间后再安排字幕检查。", status: "pending" },
          ],
        },
      },
    ],
    windowLayouts: [
      {
        windowId: "demo-layout-closed-1",
        windowIndex: 3,
        status: "closed",
        firstSeenAt: ago(400),
        lastSeenAt: ago(95),
        closedAt: ago(90),
        tabs: [
          {
            tabId: "demo-layout-1-tab-1",
            tabIndex: 1,
            panes: [
              {
                sessionId: "demo-layout-1-pane-1",
                title: "session-atlas (codex)",
                cwd: "/Users/demo/Code/Workstation/session-atlas",
                profileName: "Default",
                jobName: "codex",
                conversationId: "00000000-0000-4000-8000-000000000002",
                resumeCommand:
                  "codex resume -C '/Users/demo/Code/Workstation/session-atlas' '00000000-0000-4000-8000-000000000002'",
                splitPath: [],
              },
            ],
          },
          {
            tabId: "demo-layout-1-tab-2",
            tabIndex: 2,
            panes: [
              {
                sessionId: "demo-layout-1-pane-2",
                title: "project-catalog (codex)",
                cwd: "/Users/demo/Code/Workstation/project-catalog",
                jobName: "codex",
                splitPath: [{ vertical: true, index: 0 }],
              },
              {
                sessionId: "demo-layout-1-pane-3",
                title: "-zsh",
                cwd: "/Users/demo/Code/Workstation",
                jobName: "zsh",
                splitPath: [{ vertical: true, index: 1 }],
              },
            ],
          },
        ],
      },
      {
        windowId: "demo-layout-closed-2",
        windowIndex: 4,
        status: "closed",
        firstSeenAt: ago(500),
        lastSeenAt: ago(200),
        closedAt: ago(190),
        restoreStatus: "partial",
        restoreAttemptedAt: ago(60),
        restoreMessage: "部分分屏未能恢复",
        tabs: [
          {
            tabId: "demo-layout-2-tab-1",
            tabIndex: 1,
            panes: [
              {
                sessionId: "demo-layout-2-pane-1",
                title: "subtitle-worker (codex)",
                cwd: "/Users/demo/Code/subtitle-worker",
                jobName: "codex",
                splitPath: [],
              },
            ],
          },
        ],
      },
    ],
  };
}

export function createDemoManagedSession(input: CreateThreadInput): SessionSummary {
  const now = new Date().toISOString();
  const projectName = input.cwd.split("/").filter(Boolean).at(-1) ?? "Codex";
  const id = `managed-${Date.now()}`;
  return createSession(id, {
    projectKey: projectName,
    projectName,
    title: input.title?.trim() || projectName,
    cwd: input.cwd,
    branch: undefined,
    activityState: input.prompt?.trim() ? "running" : "idle",
    currentActivity: input.prompt?.trim() || "等待首条任务",
    lastActivityAt: now,
    observedAt: now,
    activities: input.prompt?.trim()
      ? [{ id: `${id}-prompt`, at: now, label: `已发送：${input.prompt.trim()}` }]
      : [],
  });
}
