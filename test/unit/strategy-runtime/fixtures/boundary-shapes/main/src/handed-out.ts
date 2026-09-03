/**
 * FIXTURE: the two directions a type can face.
 *
 * `HandedOutFacade` is RETURNED — this package constructs it, so its members
 * are this package's callables and must be enumerated. `NeverImplementedPort`
 * only ever appears as a PARAMETER — somebody else implements it, so its
 * members must NOT be enumerated: their totality is not this package's claim.
 */

export interface HandedOutFacade {
  /** A declared property function. */
  readonly compute: (value: unknown) => string;
  /** A declared method. */
  describe(value: unknown, label: string): string;
}

export interface NeverImplementedPort {
  persist(value: unknown): void;
}

export function makeFacade(): HandedOutFacade {
  return {
    compute: (value: unknown): string => typeof value,
    describe: (value: unknown, label: string): string => `${label}:${typeof value}`,
  };
}

export function usesPort(port: NeverImplementedPort, value: unknown): void {
  port.persist(value);
}
