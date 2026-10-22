import { createHash } from "node:crypto";

type Schema = Record<string, unknown>;
export class ContractShapeError extends Error {}
export type ContractSignatures = Record<string, string>;

export const requiredMethods: Record<string, string[]> = {
  ClientRequest: ["initialize", "thread/start", "thread/list", "thread/read", "thread/turns/list", "thread/items/list", "thread/loaded/list", "turn/start", "turn/steer", "turn/interrupt"],
  ClientNotification: ["initialized"],
  ServerRequest: ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"],
  ServerNotification: ["thread/started", "thread/status/changed", "turn/started", "turn/completed", "turn/plan/updated", "turn/diff/updated", "item/started", "item/completed", "item/agentMessage/delta", "error", "serverRequest/resolved", "thread/name/updated", "thread/deleted", "thread/archived", "thread/closed"],
};
export const responseSchemas = [
  "InitializeResponse", "CommandExecutionRequestApprovalResponse", "FileChangeRequestApprovalResponse", "PermissionsRequestApprovalResponse", "ToolRequestUserInputResponse",
  ...["ThreadStart", "ThreadList", "ThreadRead", "ThreadTurnsList", "ThreadItemsList", "ThreadLoadedList", "TurnStart", "TurnSteer", "TurnInterrupt"].map((name) => `v2/${name}Response`),
];
const annotations = new Set(["description", "title", "$schema", "$id", "examples", "$comment"]);
const escapePointer = (value: string) => value.replaceAll("~", "~0").replaceAll("/", "~1");

function record(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export function contractSignatures(bundle: Schema): ContractSignatures {
  const result: ContractSignatures = {};
  const visited = new Set<string>();
  function resolve(pointer: string): unknown {
    if (!pointer.startsWith("#/")) throw new ContractShapeError("Nonlocal schema reference");
    let value: unknown = bundle;
    for (const part of pointer.slice(2).split("/")) {
      if (!record(value)) throw new ContractShapeError(`Missing schema: ${pointer}`);
      value = value[part.replaceAll("~1", "/").replaceAll("~0", "~")];
    }
    if (!record(value) && typeof value !== "boolean") throw new ContractShapeError(`Missing schema: ${pointer}`);
    return value;
  }
  function visit(value: unknown, path: string, strict = false): void {
    const signaturePath = strict ? `approval:${path}` : path;
    if (visited.has(signaturePath)) return;
    visited.add(signaturePath);
    if (!record(value)) {
      result[signaturePath] = createHash("sha256").update(canonical(value)).digest("hex");
      return;
    }
    const shape: Schema = {};
    for (const [key, child] of Object.entries(value)) {
      if (annotations.has(key) || key === "definitions" || key === "$defs") continue;
      if (key === "properties") {
        if (!record(child)) throw new ContractShapeError(`Invalid properties: ${path}`);
        shape[key] = strict ? Object.keys(child).sort() : true;
        for (const [name, property] of Object.entries(child)) visit(property, `${path}/properties/${escapePointer(name)}`, strict);
      } else if (key === "$ref") {
        if (typeof child !== "string") throw new ContractShapeError(`Invalid reference: ${path}`);
        shape[key] = child;
        visit(resolve(child), child, strict);
      } else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(child)) {
        shape[key] = child.length;
        child.forEach((entry, index) => visit(entry, `${path}/${key}/${index}`, strict));
      } else if (["items", "additionalProperties", "not", "if", "then", "else", "contains"].includes(key)) {
        shape[key] = true;
        visit(child, `${path}/${key}`, strict);
      } else {
        shape[key] = Array.isArray(child) && ["required", "enum", "type"].includes(key)
          ? [...child].sort((a, b) => canonical(a).localeCompare(canonical(b))) : child;
      }
    }
    result[signaturePath] = createHash("sha256").update(canonical(shape)).digest("hex");
  }
  for (const [envelope, names] of Object.entries(requiredMethods)) {
    const schema = resolve(`#/definitions/${envelope}`) as Schema;
    if (!Array.isArray(schema.oneOf)) throw new ContractShapeError(`Missing envelope: ${envelope}`);
    for (const method of names) {
      const variant = schema.oneOf.find((entry: unknown) => {
        if (!record(entry) || !record(entry.properties) || !record(entry.properties.method)) return false;
        return Array.isArray(entry.properties.method.enum) && entry.properties.method.enum.includes(method);
      });
      if (!variant) throw new ContractShapeError(`Missing method: ${method}`);
      visit(variant, `${envelope}/${method}`, envelope === "ServerRequest");
    }
  }
  for (const name of responseSchemas) visit(resolve(`#/definitions/${name}`), `#/definitions/${name}`, name.includes("ApprovalResponse") || name === "ToolRequestUserInputResponse");
  return result;
}

export function changedContractPaths(expected: ContractSignatures, actual: ContractSignatures): string[] {
  return Object.keys(expected).filter((path) => expected[path] !== actual[path]).sort();
}
