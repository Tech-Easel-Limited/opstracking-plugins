// Stands in for @modelcontextprotocol/sdk's dist/esm/validation/ajv-provider.js,
// so the server ships without Ajv and the four packages Ajv needs. The SDK
// uses this validator only to check what a user types into an elicitation
// form, and the OpsTracking server never shows one. Asked for a validator
// anyway, it refuses rather than let data through unchecked.
export class AjvJsonSchemaValidator {
    getValidator() {
        throw new Error("The OpsTracking server does not validate elicitation forms: it never shows one.");
    }
}
