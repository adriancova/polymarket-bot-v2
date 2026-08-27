/**
 * Dev-only test helpers.
 *
 * Exported through the `./testing` subpath so the integration suite under
 * `test/integration/event-bus/` can reach Testcontainers and the envelope
 * fixtures through one import that resolves inside this package. Nothing here
 * is imported by a production code path.
 */

export * from "./container.js";
export * from "./envelopes.js";
