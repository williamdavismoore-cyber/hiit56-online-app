# NDYRA PR Checklist (This is law)

## Gates
- [ ] Gate A passed: Anti-Drift Audit (CI)
- [ ] Gate B passed: RLS Tests (CI)
- [ ] QA passed: Smoke + E2E + Lighthouse (CI)

## Blueprint / Drift Control
- [ ] I did NOT introduce a new framework/pattern without updating the Blueprint first
- [ ] If I added new DB tables/migrations, I updated the Blueprint before code (same PR)
- [ ] If I added new routes/pages, I updated the Blueprint before code (same PR)

## Notes for reviewers
- What changed:
- Any migrations included:
- Any env vars required:
