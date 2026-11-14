/**
 * The response shapes this server reads, as the API sends them.
 *
 * Mirrors the zod schemas in frontend/src/services/*.ts (the client's own
 * contract with the API). Fields are optional wherever the API may omit or
 * null them, so a newer server adding fields never breaks a tool.
 */
export {};
