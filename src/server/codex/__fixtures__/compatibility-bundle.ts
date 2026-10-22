import { requiredMethods, responseSchemas } from "../compatibility-contract.js";

export function fixtureBundle() {
  const payload = {
    type: "object", required: ["threadId", "decision"],
    properties: {
      threadId: { type: "string" },
      decision: { type: "string", enum: ["accept", "decline"] },
      optional: { type: ["string", "null"] },
      nested: { $ref: "#/definitions/Nested" },
    },
  };
  const definitions: Record<string, any> = {
    Payload: payload,
    Nested: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
    v2: {},
  };
  definitions.ApprovalPayload = structuredClone(payload);
  delete definitions.ApprovalPayload.properties.nested;
  for (const [envelope, methods] of Object.entries(requiredMethods)) {
    definitions[envelope] = { oneOf: methods.map((method) => ({
      type: "object", required: ["method", "params"],
      properties: { method: { type: "string", enum: [method] }, params: { $ref: envelope === "ServerRequest" ? "#/definitions/ApprovalPayload" : "#/definitions/Payload" } },
    })) };
  }
  for (const path of responseSchemas) {
    if (path.startsWith("v2/")) definitions.v2[path.slice(3)] = { $ref: "#/definitions/Payload" };
    else definitions[path] = { $ref: path === "InitializeResponse" ? "#/definitions/Payload" : "#/definitions/ApprovalPayload" };
  }
  return { definitions };
}
