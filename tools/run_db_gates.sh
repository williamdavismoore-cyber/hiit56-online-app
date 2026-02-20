#!/usr/bin/env bash
set -euo pipefail

# NDYRA DB Gates runner (local)
# Required env vars:
#   SUPABASE_DB_URL_STAGING
#   RLS_TEST_ALICE_UUID
#   RLS_TEST_BOB_UUID

if [[ -z "${SUPABASE_DB_URL_STAGING:-}" ]]; then
  echo "Missing env var: SUPABASE_DB_URL_STAGING"
  exit 1
fi
if [[ -z "${RLS_TEST_ALICE_UUID:-}" || -z "${RLS_TEST_BOB_UUID:-}" ]]; then
  echo "Missing env vars: RLS_TEST_ALICE_UUID and/or RLS_TEST_BOB_UUID"
  exit 1
fi

echo "== Gate A: Anti-Drift Audit (v7) =="
psql "$SUPABASE_DB_URL_STAGING" -v ON_ERROR_STOP=1 -f supabase/gates/NDYRA_CP27_AntiDrift_Audit_v7.sql

echo ""
echo "== Gate B: RLS Tests (v7, rollback) =="
psql "$SUPABASE_DB_URL_STAGING" -v ON_ERROR_STOP=1 \
  -c "set ndyra.alice_uuid='${RLS_TEST_ALICE_UUID}';" \
  -c "set ndyra.bob_uuid='${RLS_TEST_BOB_UUID}';" \
  -f supabase/gates/NDYRA_CP27_RLS_Tests_v7.sql

echo ""
echo "✅ DB Gates passed."
