# `btc-15m-updown` settlement spec: review checklist

- **Series:** Polymarket "BTC Up or Down 15m" (Gamma series `10192`, slug
  `btc-up-or-down-15m`).
- **Spec under review:** `db/seeds/settlement-specs/specs/btc-15m-updown.settlement-spec.json`,
  as drafted by VENUE-SETL-1.
- **Rules text under review:** sha256
  `485ceb1dabc4aa12fb42c76184563b7378f01e5de9ded73df049c0d191cd5ad1`.
- **Evidence read:** 2026-10-04 UTC.
- **Evidence:** [review](./btc-15m-updown-review.md) and
  [venue report](../venue/verified-2026-10-04.md).

**How to use this page.** Tick **Yes** or **No** on every line.

- A **No** or a blank line keeps the spec `UNVERIFIED`.
- Signing this page records nothing in the system yet: today no command can
  record a review, and the trader does not read one (review
  [§5](./btc-15m-updown-review.md#53-gaps-nothing-below-exists-yet), gaps
  G-1 … G-7).
- The repository is public. Commit only what you are willing to publish.

| # | Confirm that … | Yes | No | Evidence |
| - | - | - | - | - |
| 1 | **Rules text and hash.** The text quoted in review §1.1 is the rules text being reviewed, and its sha256 is `485ceb1d…` | [ ] | [ ] | [review §1](./btc-15m-updown-review.md#11-the-current-text); report F-22, F-23 |
| 2 | **Reading.** The settlement value is the Chainlink BTC/USD **60-second** TWAP stream's value at the window **close**, and the "price at the beginning" is the same stream's value at the window **open** (reading R2). It is not an average over the whole 15 minutes (R1) | [ ] | [ ] | [review §3.3-§3.4](./btc-15m-updown-review.md#33-the-evidence); conflict C-15 |
| 3 | **Comparison.** Up wins when the close value is **greater than or equal to** the open value (`GTE`), so an exact tie resolves Up | [ ] | [ ] | [review §3.4 Q4](./btc-15m-updown-review.md#34-answers); rules text |
| 4 | **Window and boundaries.** Open = Gamma `eventStartTime` = the start of the ET title range. Close = `endDate` = open + 900 s. Each value is the 60 s TWAP ending at its instant. Which Chainlink report applies at an instant, and whether instants are inclusive, is undocumented; the spec's prose fails closed on it | [ ] | [ ] | [review §3.4 Q3](./btc-15m-updown-review.md#34-answers); report F-14 … F-16, U-24 |
| 5 | **Resolution source.** The source is the Chainlink Data Streams BTC/USD 60-second TWAP stream (`btc-usd-twap-60s-streams`) that the rules name. Its public page could not be read (U-31) | [ ] | [ ] | [review §1.4](./btc-15m-updown-review.md#14-the-resolution-source); report F-25 … F-27 |
| 6a | **Fallback policy.** There is no fallback: if either value is unavailable or ambiguous, entries halt and the operator is called; nothing is substituted or interpolated | [ ] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); U-26 |
| 6b | **Dispute policy.** Entries halt while a dispute is open. Whether these automatic resolutions can be disputed is undocumented | [ ] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); report F-17, F-30, U-27 |
| 6c | **Clarification policy.** An "Additional context" update, or any change in the rules text or its hash, halts entries for the series until a fresh review. Nothing watches for this yet (G-8) | [ ] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); report F-31 |
| 7 | **Rules version.** The rules version this review names is the rules text with sha256 `485ceb1d…`. The spec cannot record it until gaps G-2 and G-3 are closed | [ ] | [ ] | [review §2](./btc-15m-updown-review.md#2-what-a-rules-version-is-here-and-how-to-identify-one-for-these-markets) |
| 8 | **Published-window check (ADR-009 §6).** The resolution feed publishes a 60-second window today (Polymarket: "Only 60 exists today"; Chainlink: the stream's name), so `windowSeconds: 60` passes. The code has no current list yet (G-4) | [ ] | [ ] | [review §5.1 step 5](./btc-15m-updown-review.md#51-what-the-code-does-step-by-step); report F-25, F-26 |

**Decisions.**

| # | Decide … | Yes | No | Evidence |
| - | - | - | - | - |
| D1 | Send the clarification question to Polymarket before this review is recorded | [ ] | [ ] | [review §3.5](./btc-15m-updown-review.md#35-recommendation-and-the-question-to-ask-polymarket) |
| D2 | If lines 1-8 are all Yes, mark the spec reviewed once the gaps allow it to be recorded (until then it stays `UNVERIFIED`) | [ ] | [ ] | [review §5.2](./btc-15m-updown-review.md#52-what-a-review-unblocks-and-what-makes-the-veto-pass-in-paper-today) |

Reviewer: ____________________  Date (UTC): ____________________
