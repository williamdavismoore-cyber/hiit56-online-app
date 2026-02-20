@echo off
setlocal enabledelayedexpansion

REM NDYRA DB Gates runner (Windows)
REM Required env vars:
REM   SUPABASE_DB_URL_STAGING
REM   RLS_TEST_ALICE_UUID
REM   RLS_TEST_BOB_UUID
REM
REM You must have psql installed (PostgreSQL client). If you installed Postgres, you already have it.

if "%SUPABASE_DB_URL_STAGING%"=="" (
  echo Missing env var: SUPABASE_DB_URL_STAGING
  exit /b 1
)

if "%RLS_TEST_ALICE_UUID%"=="" (
  echo Missing env var: RLS_TEST_ALICE_UUID
  exit /b 1
)

if "%RLS_TEST_BOB_UUID%"=="" (
  echo Missing env var: RLS_TEST_BOB_UUID
  exit /b 1
)

echo == Gate A: Anti-Drift Audit (v7) ==
psql "%SUPABASE_DB_URL_STAGING%" -v ON_ERROR_STOP=1 -f supabase/gates/NDYRA_CP27_AntiDrift_Audit_v7.sql
if errorlevel 1 exit /b 1

echo.
echo == Gate B: RLS Tests (v7, rollback) ==
psql "%SUPABASE_DB_URL_STAGING%" -v ON_ERROR_STOP=1 -c "set ndyra.alice_uuid='%RLS_TEST_ALICE_UUID%';" -c "set ndyra.bob_uuid='%RLS_TEST_BOB_UUID%';" -f supabase/gates/NDYRA_CP27_RLS_Tests_v7.sql
if errorlevel 1 exit /b 1

echo.
echo DB Gates passed.
