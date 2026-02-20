# ADR 0001 — Blueprint v7.3.1 is LOCKED

Date: 2026-02-20

## Decision

Blueprint **v7.3.1 (LOCKED + Corrected)** is the *only* source of truth for NDYRA.

It includes:

- The scaling patch
- The system-of-record amendment

And it explicitly forbids:

- New frontend frameworks
- New routing frameworks
- New one-off patterns that are not captured in the Blueprint

## Consequences

- If routes / DB schema / RLS / RPCs / serverless functions change, the Blueprint must be updated first.
- No merges unless gates pass (Audit + RLS + E2E + Lighthouse).

## Reference

`docs/ndyra/NDYRA_SoupToNuts_Blueprint_v7.3.1_LOCKED_CORRECTED.pdf`
