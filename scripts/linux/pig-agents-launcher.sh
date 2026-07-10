#!/bin/sh
DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
exec "$DIR/pig-agents-desktop-bin" --no-sandbox "$@"
