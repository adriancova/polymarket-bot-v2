/**
 * FIXTURE: the `StrategyInstanceRuntime` shape — a class whose VALUE is never
 * exported and whose TYPE is. Instances escape through the factory, so the
 * instance members are publicly callable while `new` is not reachable.
 */

class TypeOnlyExportedClass {
  private readonly seed: string;

  constructor(seed: string) {
    this.seed = seed;
  }

  describe(value: unknown): string {
    return `${this.seed}:${typeof value}`;
  }
}

export type { TypeOnlyExportedClass };

export function makeTypeOnly(seed: string): TypeOnlyExportedClass {
  return new TypeOnlyExportedClass(seed);
}
