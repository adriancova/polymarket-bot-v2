# `btc-15m-updown` settlement spec: review checklist

- **Series:** Polymarket "BTC Up or Down 15m" (Gamma series `10192`, slug
  `btc-up-or-down-15m`).
- **Spec under review:** `db/seeds/settlement-specs/specs/btc-15m-updown.settlement-spec.json`,
  as drafted by VENUE-SETL-1 (revised after its first review round).
- **Rules text under review:** sha256
  `485ceb1dabc4aa12fb42c76184563b7378f01e5de9ded73df049c0d191cd5ad1`.
- **Evidence read:** 2026-10-04 UTC.
- **Evidence:** [review](./btc-15m-updown-review.md) and
  [venue report](../venue/verified-2026-10-04.md).

**How to use this page.**

- **Confirmations (lines 1-9).** Tick **Yes** or **No** on each line of the
  first table. A **No** or a blank line in that table keeps the spec
  `UNVERIFIED`.
- **Blocker, whatever you tick: U-24.** Which stream report gives each
  boundary value is undocumented, and the spec names none (review
  [§3.4 Q3](./btc-15m-updown-review.md#34-answers)). The spec cannot be marked
  reviewed until Polymarket or new documentation states it and a redraft
  records it.
- **Decisions (D1, D2).** Each is a separate choice, with its consequences
  stated on its line. The confirmation rule above does not apply to them.
- Signing this page records nothing in the system yet: today no command can
  record a review, and the trader does not read one (review
  [§5](./btc-15m-updown-review.md#53-gaps-nothing-below-exists-yet), gaps
  G-1 … G-7).
- The repository is public. Commit only what you are willing to publish.

| # | Confirm that … | Yes | No | Evidence |
| - | - | - | - | - |
| 1 | **Rules text and hash.** The text quoted in review §1.1 is the rules text being reviewed, and its sha256 is `485ceb1d…` | [x] | [ ] | [review §1](./btc-15m-updown-review.md#11-the-current-text); report F-22, F-23 |
| 2 | **Reading.** The settlement value is the Chainlink BTC/USD **60-second** TWAP stream's value for the window **close**, and the "price at the beginning" is the same stream's value for the window **open** (reading R2). It is not an average over the whole 15 minutes (R1), nor an average of the stream's values over the range (R3a). Documentation establishes the 60 s TWAP feed for both prices; that each is read at its boundary is an inference, which the undocumented `eventMetadata` agrees with | [x] | [ ] | [review §3.3-§3.4](./btc-15m-updown-review.md#33-the-evidence); C-15, U-32 |
| 3 | **Comparison.** Up wins when the close value is **greater than or equal to** the open value (`GTE`), so an exact tie resolves Up | [x] | [ ] | [review §3.4 Q4](./btc-15m-updown-review.md#34-answers); rules text |
| 4 | **Precision.** The spec's own evaluation compares the two values as exact decimals at the stream's published precision, with no rounding (its `roundingRule`). Polymarket does not document the precision of its own comparison (U-25), and rounding can flip a near-tie: open 100.004 against close 100.003 is Down exactly, but a tie, so Up, at 2 decimal places (a constructed example) | [x] | [ ] | [review §3.4 Q4](./btc-15m-updown-review.md#34-answers); U-25 |
| 5 | **Window.** The window is the title's ET range read in America/New_York time, 900 s long. Gamma `eventStartTime` and `endDate` equal it by observation only, and `startDate` (about 24 h earlier) is not the open (U-29). A title that does not convert to exactly one 900 s interval, such as the repeated 1:00-2:00 AM hour on 2026-11-01 (U-34), halts entries for that window. Whether the instants are inclusive is undocumented (U-24) | [x] | [ ] | [review §3.4 Q3](./btc-15m-updown-review.md#34-answers); report F-14 … F-16, U-24, U-29, U-34 |
| 6 | **Resolution source.** The source is the Chainlink Data Streams BTC/USD 60-second TWAP stream the rules name (`btc-usd-twap-60s-streams`). Chainlink's public directory lists a live `BTC/USD-Streams-TWAP-60s-mainnet-production` stream (schema v2, feed ID `0x0002ee67…d95f`); that it is the rules' stream is an inference, because the rules' own page could not be read (U-31) | [x] | [ ] | [review §1.4](./btc-15m-updown-review.md#14-the-resolution-source); report F-25 … F-27, F-32 |
| 7a | **Fallback policy.** There is no fallback: if either value is unavailable or ambiguous, entries halt and the operator is called; nothing is substituted or interpolated | [x] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); U-26 |
| 7b | **Dispute policy.** Entries halt while a dispute is open. Whether these automatic resolutions can be disputed is undocumented | [x] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); report F-17, F-30, U-27 |
| 7c | **Clarification policy.** An "Additional context" update, or any change in the rules text or its hash, halts entries for the series until a fresh review. Nothing watches for this yet (G-8) | [x] | [ ] | [review §4.1](./btc-15m-updown-review.md#41-field-by-field); report F-31 |
| 8 | **Rules version.** The rules version this review names is the rules text with sha256 `485ceb1d…`. The spec cannot record it until gaps G-2 and G-3 are closed | [x] | [ ] | [review §2](./btc-15m-updown-review.md#2-what-a-rules-version-is-here-and-how-to-identify-one-for-these-markets) |
| 9 | **Published-window check (ADR-009 §6).** `windowSeconds: 60` is a window the resolution feed publishes. The rules' stream has one window length, 60 s, by its name (Chainlink: one window length per stream). Every candidate list contains 60: PolyBolt's resolution channel ("Only 60"); Chainlink's live BTC/USD TWAP streams (30 s and 60 s); the dated RTDS list in code (30 and 60). Which feed's list the check must use is gap G-4 | [x] | [ ] | [review §5.1 step 5](./btc-15m-updown-review.md#51-what-the-code-does-step-by-step); report F-25, F-26, F-32 |

**Decisions.**

| # | Decide … | Yes | No | Consequence | Evidence |
| - | - | - | - | - | - |
| D1 | Send the clarification question to Polymarket before a review is recorded | [ ] | [x] | **Yes:** the review waits for the answer, and every line the answer bears on is read again against it. **No:** nothing is sent; the U-24 blocker then clears only if new documentation settles it | [review §3.5](./btc-15m-updown-review.md#35-recommendation-and-the-question-to-ask-polymarket) |
| D2 | Mark the spec reviewed once the gaps allow a review to be recorded | [x] | [ ] | **Yes:** takes effect only when lines 1-9 are all Yes and the U-24 blocker is cleared; until then the spec stays `UNVERIFIED`. **No:** the spec stays `UNVERIFIED` whatever the lines say | [review §5.2](./btc-15m-updown-review.md#52-what-a-review-unblocks-and-what-makes-the-veto-pass-in-paper-today) |

Reviewer: the repository owner. The orchestrator recorded the owner's answers, given in the session on 2026-10-05.  Date (UTC): 2026-10-05

**What the answers do (2026-10-05).**
- Lines 1-9 (with 7a-7c) are confirmed.
- D1 is No, so no clarification was sent. U-24 clears only if new documentation settles it, and until then no review can be recorded.
- D2 is Yes, so the spec is marked reviewed once gaps G-1 to G-10 allow a review to be recorded and U-24 has cleared.
- Until then the spec stays `UNVERIFIED`.
- Separately, the owner ruled that PAPER configurations may set `settlementReadiness.modelDependentActivationAllowed: true` for `btc-15m-updown`. That is an operator assertion, for PAPER only; it is not a recorded review.
