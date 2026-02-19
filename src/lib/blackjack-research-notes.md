## Blackjack Engine Research Notes

This project now uses an exact finite-deck expected-value (EV) core for stand/hit/double and a policy-guided split simulation. The references below are the primary sources for validating strategy logic, counting context, and rule sensitivity.

### Core references

1. Stanford Wong, *Professional Blackjack* (Pi Yee Press).
   - Canonical practical reference for true-count index departures and rule-driven variation work.
2. Peter A. Griffin, *The Theory of Blackjack*.
   - Foundational math framework for blackjack EV, composition-dependent effects, and effect-of-removal reasoning.
3. Donald Schlesinger, *Blackjack Attack*.
   - Illustrious 18 and Fab 4 prioritization, SCORE framework, and practical gain from deviations.
4. Wizard of Odds blackjack appendices and EV tables.
   - Publicly verifiable baseline tables and rule-effect checks for sanity testing.

### Implementation notes

- The solver evaluates actions from actual remaining rank counts (finite-deck composition), not just total-dependent lookup tables.
- Dealer outcomes are computed as a full probability distribution conditioned on current shoe composition and the selected S17/H17 rule.
- Hit decisions use recursive expectimax with memoization for stable deterministic EV output.
- Double EV is exact over all possible draw cards from current composition.
- Split currently uses simulation with exact-policy play for each split hand (practical compromise for performance and complexity).

### Current scope and known gaps

- This app models a no-peek style dealer hole-card flow (hole is sampled before player completion and resolved at showdown).
- Insurance, surrender, side bets, and full re-split trees are not yet included in `Action` output.
- Count-deviation tables (Wong/Schlesinger index packs) are not hard-coded yet because this engine directly optimizes EV from observed composition, which already captures many count-driven departures.

### Recommended next validation pass

- Add a strategy regression harness that compares solver recommendations vs. known benchmark charts for specific rule sets.
- Add targeted test vectors for high-value deviations (e.g., 16v10, 15v10, 12v3, 12v2, 10v10, 11vA).
- Add explicit rule toggles for peek, surrender, and re-split behavior and verify against published house-edge deltas.
