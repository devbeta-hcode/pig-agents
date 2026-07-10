#!/bin/bash
# Register menu launcher (shell script), not the raw Electron binary.
set -e

APP="/opt/Pig Agents/pig-agents-desktop"

if type update-alternatives 2>/dev/null >&1; then
  if [ -L '/usr/bin/pig-agents-desktop' ] && [ "$(readlink '/usr/bin/pig-agents-desktop')" != '/etc/alternatives/pig-agents-desktop' ]; then
    rm -f '/usr/bin/pig-agents-desktop'
  fi
  update-alternatives --install '/usr/bin/pig-agents-desktop' 'pig-agents-desktop' "$APP" 100 \
    || ln -sf "$APP" '/usr/bin/pig-agents-desktop'
else
  ln -sf "$APP" '/usr/bin/pig-agents-desktop'
fi

if hash update-desktop-database 2>/dev/null; then
  update-desktop-database /usr/share/applications || true
fi

if hash gtk-update-icon-cache 2>/dev/null; then
  gtk-update-icon-cache -f /usr/share/icons/hicolor || true
fi
