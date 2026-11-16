// Stands in for zod's v4/classic/from-json-schema.js. z.fromJSONSchema() turns
// a JSON Schema into a zod schema; nothing in the OpsTracking server or the MCP
// SDK calls it, so the server ships this instead of the converter.
export function fromJSONSchema() {
    throw new Error("z.fromJSONSchema() is not part of the OpsTracking server.");
}
