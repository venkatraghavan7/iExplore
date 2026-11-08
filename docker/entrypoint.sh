#!/usr/bin/env bash
# One iExplore job: pull learned state from S3, run a session, refresh coverage + triage, push state back.
#   iexplore-job run           (default) one exploratory session
#   iexplore-job ado-sync      dry run: the ADO bugs it would create
#   iexplore-job ado-sync --apply
#   iexplore-job check         preflight: Bedrock access + computer tool + S3
#   iexplore-job cli <args>    any iexplore command
set -uo pipefail
cd "${IEXPLORE_HOME:-/app}"
CLI="node dist/cli.js"
VERTICAL="${IEXPLORE_VERTICAL:-car}"
TARGET="${IEXPLORE_TARGET:-prod}"
REG="triage/${TARGET}-${VERTICAL}.csv"
job="${1:-run}"; shift || true

case "$job" in
  check) exec $CLI check "$@" ;;
  cli)   exec $CLI "$@" ;;
  ado-sync)
    $CLI state pull knowledge triage || exit 1
    $CLI ado-sync --vertical "$VERTICAL" "$@"; rc=$?
    if [[ " $* " == *" --apply "* ]]; then $CLI state push triage; fi
    exit $rc ;;
  run)
    $CLI state pull knowledge triage || exit 1
    ARGS=(--vertical "$VERTICAL" --out runs --adaptive)
    [[ "${IEXPLORE_MODE:-dynamic}" == "dynamic" ]] && ARGS+=(--dynamic)
    [[ -n "${IEXPLORE_STRATEGY:-}" ]] && ARGS+=(--strategy "$IEXPLORE_STRATEGY")
    # shellcheck disable=SC2206
    [[ -n "${IEXPLORE_EXTRA_ARGS:-}" ]] && ARGS+=($IEXPLORE_EXTRA_ARGS)
    $CLI run "${ARGS[@]}" "$@"; rc=$?
    $CLI coverage --vertical "$VERTICAL" --out knowledge
    # Triage edits someone uploaded to S3 while this run was going win over the copy pulled at the start.
    rm -rf /tmp/latest && $CLI state pull "$REG" --out /tmp/latest >/dev/null
    $CLI triage --vertical "$VERTICAL" --runs runs seed/prod-car --human-from "/tmp/latest/$REG"
    $CLI summarize runs >/dev/null || true
    $CLI state push knowledge triage runs
    cat triage/digest.md
    exit $rc ;;
  *) echo "unknown job '$job' (run | ado-sync | check | cli)"; exit 2 ;;
esac
