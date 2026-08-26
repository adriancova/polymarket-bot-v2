/**
 * Schema-version registry.
 *
 * Maps `(eventType, schemaVersion) → contract` and provides the lookup and
 * validation helpers every consumer of the event stream needs. Replay depends
 * on this: historical data recorded under an older version must keep validating
 * against the schema it was recorded with (§8.4, §12.5), so old versions stay
 * registered when a new one is added.
 */

import type { z } from "zod";

import { EventEnvelopeRoutingSchema, type EventEnvelope } from "./envelope.js";
import {
  DuplicateEventContractError,
  EventValidationError,
  UnknownEventContractError,
} from "./errors.js";
import { DOMAIN_EVENT_CONTRACTS } from "./events/index.js";
import type { EventContractLike } from "./events/event-contract.js";
import type { SchemaVersion } from "./schema-version.js";

function registryKey(eventType: string, schemaVersion: number): string {
  return `${eventType}@${String(schemaVersion)}`;
}

function formatIssues(error: z.ZodError): readonly string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map((segment) => String(segment)).join(".");
    return `${path === "" ? "(root)" : path}: ${issue.message}`;
  });
}

function readEventType(value: unknown): string {
  if (typeof value === "object" && value !== null && "eventType" in value) {
    const candidate = (value as { eventType: unknown }).eventType;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "(missing)";
}

export type EnvelopeParseResult =
  | { readonly ok: true; readonly envelope: EventEnvelope<unknown> }
  | { readonly ok: false; readonly error: UnknownEventContractError | EventValidationError };

export interface EventSchemaRegistry {
  /** Every registered contract, in registration order. */
  readonly contracts: readonly EventContractLike[];
  /** Every distinct registered event type, in registration order. */
  readonly eventTypes: readonly string[];

  has(eventType: string, schemaVersion: number): boolean;
  lookup(eventType: string, schemaVersion: number): EventContractLike | undefined;
  /** @throws {UnknownEventContractError} */
  require(eventType: string, schemaVersion: number): EventContractLike;
  /** Registered versions of an event type, ascending. */
  versionsOf(eventType: string): readonly SchemaVersion[];
  /** Highest registered version of an event type, or `undefined` when unknown. */
  latestVersionOf(eventType: string): SchemaVersion | undefined;

  /**
   * Routes an unparsed value by `(eventType, schemaVersion)` and validates it
   * against the pinned envelope schema for that contract.
   *
   * @throws {UnknownEventContractError} when no contract is registered.
   * @throws {EventValidationError} when the value fails the contract schema.
   */
  parseEnvelope(value: unknown): EventEnvelope<unknown>;
  /** Non-throwing variant of {@link EventSchemaRegistry.parseEnvelope}. */
  safeParseEnvelope(value: unknown): EnvelopeParseResult;
  /**
   * Validates a payload against a registered contract.
   *
   * @throws {UnknownEventContractError} when no contract is registered.
   * @throws {EventValidationError} when the payload fails the contract schema.
   */
  parsePayload(eventType: string, schemaVersion: number, payload: unknown): unknown;
}

/**
 * Builds a registry from a list of contracts.
 *
 * @throws {DuplicateEventContractError} when two contracts share a key.
 */
export function createEventSchemaRegistry(
  contracts: readonly EventContractLike[],
): EventSchemaRegistry {
  const byKey = new Map<string, EventContractLike>();
  const versionsByType = new Map<string, SchemaVersion[]>();

  for (const contract of contracts) {
    const key = registryKey(contract.eventType, contract.schemaVersion);
    if (byKey.has(key)) {
      throw new DuplicateEventContractError(contract.eventType, contract.schemaVersion);
    }
    byKey.set(key, contract);
    const versions = versionsByType.get(contract.eventType) ?? [];
    versions.push(contract.schemaVersion);
    versions.sort((left, right) => left - right);
    versionsByType.set(contract.eventType, versions);
  }

  const registry: EventSchemaRegistry = {
    contracts: [...contracts],
    eventTypes: [...versionsByType.keys()],

    has(eventType, schemaVersion) {
      return byKey.has(registryKey(eventType, schemaVersion));
    },

    lookup(eventType, schemaVersion) {
      return byKey.get(registryKey(eventType, schemaVersion));
    },

    require(eventType, schemaVersion) {
      const contract = byKey.get(registryKey(eventType, schemaVersion));
      if (contract === undefined) {
        throw new UnknownEventContractError(eventType, schemaVersion);
      }
      return contract;
    },

    versionsOf(eventType) {
      return [...(versionsByType.get(eventType) ?? [])];
    },

    latestVersionOf(eventType) {
      const versions = versionsByType.get(eventType);
      return versions === undefined ? undefined : versions[versions.length - 1];
    },

    parseEnvelope(value) {
      const routing = EventEnvelopeRoutingSchema.safeParse(value);
      if (!routing.success) {
        throw new UnknownEventContractError(readEventType(value), undefined);
      }
      const contract = registry.require(routing.data.eventType, routing.data.schemaVersion);
      const parsed = contract.envelopeSchema.safeParse(value);
      if (!parsed.success) {
        throw new EventValidationError(
          contract.eventType,
          contract.schemaVersion,
          formatIssues(parsed.error),
        );
      }
      // The pinned envelope schema is built from the shared §7.1 shape, so a
      // value that satisfies it satisfies `EventEnvelope`. The assertion only
      // recovers the static type that the widened `z.ZodType` storage erases.
      return parsed.data as EventEnvelope<unknown>;
    },

    safeParseEnvelope(value) {
      try {
        return { ok: true, envelope: registry.parseEnvelope(value) };
      } catch (error: unknown) {
        if (error instanceof UnknownEventContractError || error instanceof EventValidationError) {
          return { ok: false, error };
        }
        throw error;
      }
    },

    parsePayload(eventType, schemaVersion, payload) {
      const contract = registry.require(eventType, schemaVersion);
      const parsed = contract.payloadSchema.safeParse(payload);
      if (!parsed.success) {
        throw new EventValidationError(eventType, schemaVersion, formatIssues(parsed.error));
      }
      return parsed.data;
    },
  };

  return registry;
}

/** The frozen WP-020 registry of every §7.4 event contract. */
export const DOMAIN_EVENT_REGISTRY = createEventSchemaRegistry(DOMAIN_EVENT_CONTRACTS);
