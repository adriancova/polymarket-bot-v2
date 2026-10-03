/**
 * TEST-ONLY: a user-stream manager over the fake port and the manual clock,
 * with every output recorded. The run-mode gate still runs: the tests pass a
 * live-SHAPED literal context, which only ever reaches the fake port (the
 * same convention as WP-260's `createSecureVenueClientForTesting` tests).
 */

import {
  createUserStreamManager,
  type CreateUserStreamManagerOptions,
  type UserStreamManager,
  type UserStreamOutput,
  type UserStreamReconciliationRequest,
} from "../manager.js";

import { FakeUserSocketPort, ManualTimers, type FakeUserSocketPortOptions } from "./fake-socket-port.js";

export const LIVE_SHAPED_CONTEXT = Object.freeze({ runMode: "LIVE_MICRO", maximumRunMode: "LIVE_MICRO", allowRealOrders: true });

/** The sanitised zero-UUID API-key placeholder every fixture owner carries (`test/fixtures/venue/README.md`). */
export const FIXTURE_OWNER = "00000000-0000-0000-0000-000000000000";

/** The fixtures' condition id (`test/fixtures/venue/user-ws/*.json`). */
export const FIXTURE_MARKET = "0x747dc809fb79e1b05be09c42d6179459a58de2ef3e40f02484a4e1260f741f75";
export const OTHER_MARKET = `0x${"ab".repeat(32)}`;

export interface UserStreamHarness {
  readonly manager: UserStreamManager;
  readonly port: FakeUserSocketPort;
  readonly timers: ManualTimers;
  readonly outputs: UserStreamOutput[];
  /** Every reconciliation request emitted so far, in order. */
  requests(): readonly UserStreamReconciliationRequest[];
  /** Every STATE output so far, as `from→to`. */
  transitions(): readonly string[];
  /** Start, open the first connection, and clear the record. */
  subscribe(): void;
}

export function openUserStream(
  overrides: Partial<Omit<CreateUserStreamManagerOptions, "transport" | "timers" | "onOutput">> & {
    readonly port?: FakeUserSocketPortOptions;
    readonly onOutput?: (output: UserStreamOutput, harness: UserStreamHarness) => void;
  } = {},
): UserStreamHarness {
  const port = new FakeUserSocketPort({ accountOwner: FIXTURE_OWNER, ...overrides.port });
  const timers = new ManualTimers();
  const outputs: UserStreamOutput[] = [];
  const { port: _port, onOutput, ...rest } = overrides;
  void _port;
  const self: { harness?: UserStreamHarness } = {};
  const manager = createUserStreamManager({
    runModeContext: LIVE_SHAPED_CONTEXT,
    markets: [FIXTURE_MARKET],
    ...rest,
    transport: port,
    timers,
    onOutput: (output) => {
      outputs.push(output);
      if (onOutput !== undefined && self.harness !== undefined) onOutput(output, self.harness);
    },
  });
  const harness: UserStreamHarness = {
    manager,
    port,
    timers,
    outputs,
    requests: () => outputs.flatMap((output) => (output.kind === "RECONCILIATION_REQUESTED" ? [output.request] : [])),
    transitions: () => outputs.flatMap((output) => (output.kind === "STATE" ? [`${output.from}→${output.to}`] : [])),
    subscribe: () => {
      manager.start();
      port.latest.open();
      outputs.length = 0;
    },
  };
  self.harness = harness;
  return harness;
}
