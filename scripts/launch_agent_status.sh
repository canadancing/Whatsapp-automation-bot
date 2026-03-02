#!/usr/bin/env bash
set -euo pipefail

launchctl print "gui/$(id -u)/com.whatsappauto.dailyrunner" | rg "state =|last exit code|path =|Program|StartCalendarInterval|next scheduled" || true
