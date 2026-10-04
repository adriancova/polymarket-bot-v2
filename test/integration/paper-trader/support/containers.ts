/**
 * The trader suite's container start-up (`FLAKES-1`, `TC-LOCAL-FLAKE`). TEST
 * SETUP ONLY.
 *
 * Every container file starts its containers through these, so a container is
 * handed to a test only once a real protocol exchange has crossed its mapped
 * port, and a start that fails only on testcontainers' reaper connection is
 * tried again. Why, and the bounds: `../../data-gateway/support/containers.ts`,
 * which this suite already shares support files with.
 */

import { startPostgresContainer } from "@polymarket-bot/storage-postgres/testing";

import {
  postgresAnswersSslRequest,
  startRetryingReaperConnect,
  waitUntilAnswering,
} from "../../data-gateway/support/containers.js";

export { startReadyRedisContainer } from "../../data-gateway/support/containers.js";

type StartedPostgres = Awaited<ReturnType<typeof startPostgresContainer>>;

/**
 * A throwaway PostgreSQL container (`startPostgresContainer`, the pinned image)
 * that has answered an `SSLRequest` through its mapped port. A container that
 * never answers is stopped before the failure is thrown.
 */
export async function startReadyPostgresContainer(): Promise<StartedPostgres> {
  const container = await startRetryingReaperConnect(startPostgresContainer);
  const host = container.getHost();
  const port = container.getPort();
  try {
    await waitUntilAnswering(`the fresh PostgreSQL container at ${host}:${String(port)}`, () =>
      postgresAnswersSslRequest(host, port),
    );
  } catch (failure) {
    await container.stop().catch(() => undefined);
    throw failure;
  }
  return container;
}
