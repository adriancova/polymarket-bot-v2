/**
 * FIXTURE (remediation round 7, M7-1): a KEY-REMAPPED mapped type in the return
 * position.
 *
 * `Readonly<T>` — round 6's shape 11 — keeps each property's original
 * declaration, which is why `isOurs` said yes and `MappedFacade.mapped` was
 * enumerated. A remapping clause (`as`) does not: the compiler synthesizes a
 * fresh symbol with a new NAME and no declaration anywhere, so the `isOurs`
 * gate — which needs a declaration — skipped it. Review round 7 reproduced
 * `remappedFactory` alone, with `renamed_handler` in neither list and no
 * refusal.
 *
 * The name is real and a caller can drive it (`remappedFactory().renamed_handler(v)`),
 * so the answer is enumeration under the accessible remapped name rather than a
 * refusal. The compiler still knows the property's TYPE, and that type's call
 * signature is declared right here.
 *
 * Nothing here is production code; nothing here is imported by either package.
 */

export interface RemapSource {
  handler(value: unknown): string;
  /** A data property: remapped too, and still not a callable. */
  readonly tag: string;
}

export type Remapped<T> = { [K in keyof T as `renamed_${string & K}`]: T[K] };

export function remappedFactory(): Remapped<RemapSource> {
  return {
    renamed_handler: (value: unknown): string => typeof value,
    renamed_tag: "fixture",
  };
}
