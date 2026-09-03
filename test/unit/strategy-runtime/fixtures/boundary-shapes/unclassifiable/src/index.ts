/**
 * FIXTURE: the fail-closed case. A value with a CONSTRUCT signature that is not
 * a class declaration — the walk cannot tell what its instances are without
 * guessing, so it must refuse loudly rather than treat the boundary as
 * internal. Round 5's whole lesson is that silence is the dangerous answer.
 */

export const ConstructibleValue: { new (value: unknown): { readonly value: unknown } } = class {
  readonly value: unknown;

  constructor(value: unknown) {
    this.value = value;
  }
};
