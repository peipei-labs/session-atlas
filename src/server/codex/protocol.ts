/**
 * Narrow Codex App Server 0.148.x–0.154.x and 0.162.1 protocol surface used by Session Atlas.
 *
 * These declarations intentionally cover only the read and interaction methods this
 * provider calls. The generated schema remains the source of truth and is not vendored.
 */

export type RpcId = string | number;

export interface RpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: RpcErrorBody;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcServerRequest extends RpcNotification {
  id: RpcId;
}

export interface InitializeResponse {
  userAgent: string;
  codexHome: string;
  platformFamily: string;
  platformOs: string;
}

export type CodexThreadSource =
  | "cli"
  | "vscode"
  | "exec"
  | "appServer"
  | "unknown"
  | { custom: string }
  | { subAgent: unknown };

export type CodexThreadActiveFlag = "waitingOnApproval" | "waitingOnUserInput";

export type CodexThreadStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | { type: "active"; activeFlags: CodexThreadActiveFlag[] };

export type CodexTurnStatus = "completed" | "interrupted" | "failed" | "inProgress";

export interface CodexTurnError {
  message: string;
  codexErrorInfo: unknown | null;
  additionalDetails: string | null;
}

export type CodexUserInput =
  | { type: "text"; text: string; text_elements: unknown[] }
  | { type: string; [key: string]: unknown };

export interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  command?: string;
  cwd?: string;
  server?: string;
  tool?: string;
  status?: string;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  itemsView: unknown;
  status: CodexTurnStatus;
  error: CodexTurnError | null;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
}

export interface CodexThread {
  id: string;
  sessionId: string;
  preview: string;
  createdAt: number;
  updatedAt: number;
  recencyAt: number | null;
  status: CodexThreadStatus;
  cwd: string;
  cliVersion: string;
  source: CodexThreadSource;
  canAcceptDirectInput: boolean | null;
  gitInfo: { sha: string | null; branch: string | null; originUrl: string | null } | null;
  name: string | null;
  turns: CodexTurn[];
  [key: string]: unknown;
}

export interface ThreadStartParams {
  cwd?: string | null;
  [key: string]: unknown;
}

export interface ThreadStartResponse {
  thread: CodexThread;
  model: string;
  modelProvider: string;
  cwd: string;
  [key: string]: unknown;
}

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: "created_at" | "updated_at" | "recency_at" | "section_position" | null;
  sortDirection?: "asc" | "desc" | null;
  sourceKinds?: Array<
    | "cli"
    | "vscode"
    | "exec"
    | "appServer"
    | "subAgent"
    | "subAgentReview"
    | "subAgentCompact"
    | "subAgentThreadSpawn"
    | "subAgentOther"
    | "unknown"
  > | null;
  archived?: boolean | null;
  useStateDbOnly?: boolean;
}

export interface ThreadListResponse {
  data: CodexThread[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadReadResponse {
  thread: CodexThread;
}

export interface ThreadTurnsListParams {
  threadId: string;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
  itemsView?: "notLoaded" | "summary" | "full" | null;
}

export interface ThreadTurnsListResponse {
  data: CodexTurn[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadItemsListParams {
  threadId: string;
  turnId?: string | null;
  cursor?: string | null;
  limit?: number | null;
  sortDirection?: "asc" | "desc" | null;
}

export interface ThreadItemEntry {
  turnId: string;
  item: CodexThreadItem;
}

export interface ThreadItemsListResponse {
  data: ThreadItemEntry[];
  nextCursor: string | null;
  backwardsCursor: string | null;
}

export interface ThreadLoadedListResponse {
  data: string[];
  nextCursor: string | null;
}

export interface TurnStartResponse {
  turn: CodexTurn;
}

export interface TurnSteerResponse {
  turnId: string;
}

export interface TurnPlanStep {
  step: string;
  status: "pending" | "inProgress" | "completed";
}

export type CommandApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";
export type FileChangeApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export interface CommandApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  approvalId?: string | null;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  availableDecisions?: Array<CommandApprovalDecision | Record<string, unknown>> | null;
}

export interface FileChangeApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  startedAtMs: number;
  reason?: string | null;
  grantRoot?: string | null;
}

export interface AdditionalNetworkPermissions {
  enabled: boolean | null;
}

export interface AdditionalFileSystemPermissions {
  read: string[] | null;
  write: string[] | null;
  globScanMaxDepth?: number;
  entries?: Array<{
    path:
      | { type: "path"; path: string }
      | { type: "glob_pattern"; pattern: string }
      | { type: "special"; value: string };
    access: "read" | "write" | "deny";
  }>;
}

export interface RequestPermissionProfile {
  network: AdditionalNetworkPermissions | null;
  fileSystem: AdditionalFileSystemPermissions | null;
}

export interface PermissionsApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  environmentId: string | null;
  startedAtMs: number;
  cwd: string;
  reason: string | null;
  permissions: RequestPermissionProfile;
}

export interface UserInputOption {
  label: string;
  description: string;
}

export interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: UserInputOption[] | null;
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: UserInputQuestion[];
  isBlocking: boolean;
  autoResolutionMs: number | null;
}

export interface ThreadStatusChangedParams {
  threadId: string;
  status: CodexThreadStatus;
}

export interface TurnLifecycleParams {
  threadId: string;
  turn: CodexTurn;
}

export interface TurnPlanUpdatedParams {
  threadId: string;
  turnId: string;
  explanation: string | null;
  plan: TurnPlanStep[];
}

export interface TurnDiffUpdatedParams {
  threadId: string;
  turnId: string;
  diff: string;
}

export interface ItemLifecycleParams {
  item: CodexThreadItem;
  threadId: string;
  turnId: string;
  startedAtMs?: number;
  completedAtMs?: number;
}

export interface ErrorNotificationParams {
  error: CodexTurnError;
  willRetry: boolean;
  threadId: string;
  turnId: string;
}

export interface ServerRequestResolvedParams {
  threadId: string;
  requestId: RpcId;
}

export function textInput(text: string): CodexUserInput {
  return { type: "text", text, text_elements: [] };
}

export function rpcKey(id: RpcId): string {
  return `${typeof id}:${String(id)}`;
}
