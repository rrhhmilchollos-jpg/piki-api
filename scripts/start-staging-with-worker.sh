#!/bin/sh
set -eu

node dist/dispatch-worker.js &
worker_pid=$!
npm start &
api_pid=$!

cleanup() {
  kill "$worker_pid" "$api_pid" 2>/dev/null || true
  wait "$worker_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true
}
trap cleanup INT TERM EXIT

while kill -0 "$worker_pid" 2>/dev/null && kill -0 "$api_pid" 2>/dev/null; do
  sleep 2
done

if ! kill -0 "$api_pid" 2>/dev/null; then
  wait "$api_pid" || exit $?
fi
if ! kill -0 "$worker_pid" 2>/dev/null; then
  wait "$worker_pid" || exit $?
fi
