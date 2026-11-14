#!/bin/sh
# Starts as root only long enough to hand the data folder to a normal user, then
# runs the status page as that user (F-36). Existing installs keep working: their
# root-owned files are handed over on the first start. If that isn't possible
# (e.g. a network share that refuses chown), it runs as root like before.
set -e
PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DIRS="$(dirname "${STATE_FILE:-/data/state.json}") $(dirname "${DB_FILE:-/data/statuspage.db}")"

if [ "$(id -u)" = "0" ]; then
  ok=1
  for d in $DIRS; do
    mkdir -p "$d" && chown -R "$PUID:$PGID" "$d" 2>/dev/null \
      && setpriv --reuid="$PUID" --regid="$PGID" --clear-groups test -w "$d" || ok=0
  done
  if [ "$ok" = "1" ]; then
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
  fi
  echo "boltarr-status: WARNING: couldn't hand the data folder to user $PUID:$PGID" \
       "(e.g. a network share) — running as root, as before." >&2
fi
exec "$@"
