import { describe, expect, it } from "vitest";
import { changedContractPaths, contractSignatures } from "./compatibility-contract.js";

import { fixtureBundle } from "./__fixtures__/compatibility-bundle.js";

describe("Codex structural compatibility", () => {
  it("ignores documentation and new methods, definitions and optional properties", () => {
    const before = fixtureBundle();
    const after = structuredClone(before);
    after.definitions.Payload.description = "New documentation";
    after.definitions.Payload.properties.newField = { type: "number" };
    after.definitions.Nested.properties.newNestedField = { type: "boolean" };
    after.definitions.Unused = { type: "boolean" };
    after.definitions.ClientRequest.oneOf.push({ properties: { method: { enum: ["new/method"] } } });
    expect(changedContractPaths(contractSignatures(before), contractSignatures(after))).toEqual([]);
  });

  it.each([
    ["field type", (b: ReturnType<typeof fixtureBundle>) => { b.definitions.Payload.properties.threadId.type = "integer"; }],
    ["required field", (b: ReturnType<typeof fixtureBundle>) => { b.definitions.Payload.required.push("newRequired"); }],
    ["optional field removal", (b: ReturnType<typeof fixtureBundle>) => { delete b.definitions.Payload.properties.optional; }],
    ["new approval field", (b: ReturnType<typeof fixtureBundle>) => { b.definitions.ApprovalPayload.properties.extraGrant = { type: "string" }; }],
    ["approval decisions", (b: ReturnType<typeof fixtureBundle>) => { b.definitions.ApprovalPayload.properties.decision.enum = ["accept"]; }],
    ["nested return data", (b: ReturnType<typeof fixtureBundle>) => { b.definitions.Nested.properties.value.type = "number"; }],
  ])("rejects changes to %s", (_, mutate) => {
    const before = fixtureBundle();
    const after = structuredClone(before);
    mutate(after);
    expect(changedContractPaths(contractSignatures(before), contractSignatures(after)).length).toBeGreaterThan(0);
  });

  it("reports a missing method even when other methods remain", () => {
    const bundle = fixtureBundle();
    bundle.definitions.ClientRequest.oneOf = bundle.definitions.ClientRequest.oneOf.filter(
      (entry: any) => !entry.properties.method.enum.includes("turn/start"),
    );
    expect(() => contractSignatures(bundle)).toThrow("Missing method: turn/start");
  });

  it("rejects unresolved references and handles recursive definitions", () => {
    const bundle = fixtureBundle();
    bundle.definitions.Nested.properties.child = { $ref: "#/definitions/Nested" };
    expect(() => contractSignatures(bundle)).not.toThrow();
    bundle.definitions.Nested.properties.child = { $ref: "#/definitions/Absent" };
    expect(() => contractSignatures(bundle)).toThrow("Missing schema");
  });
});
