#!/usr/bin/env bash
# Desktop smoke test for Linux/X11 (runs headless under Xvfb):
#   1. opens two drawings -> expects one window per file
#   2. drags the second window's tab onto the first window's tab bar -> one window, two tabs
#   3. drags that tab out of the tab bar -> a new window again
#
# Needs: Xvfb, openbox, xdotool, ImageMagick (import), and a built app.
# Debug builds load the UI from the Vite dev server, so start `npm run dev` first
# or pass a binary built with `npm run tauri build -- --debug --no-bundle`.
#
#   scripts/desktop-smoke.sh [path/to/dxf-viewer]
set -euo pipefail
cd "$(dirname "$0")/.."
# The single-instance hand-off uses the D-Bus session bus on Linux.
if [ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && command -v dbus-run-session >/dev/null; then
  exec dbus-run-session -- "$0" "$@"
fi
# Window titles contain non-ASCII characters (an em dash).
export LC_ALL=C.UTF-8

BIN=${1:-src-tauri/target/debug/dxf-viewer}
OUT=${OUT:-${TMPDIR:-/tmp}/dxf-viewer-smoke}
DISPLAY_NUM=${DISPLAY_NUM:-:77}
mkdir -p "$OUT"

cleanup() {
  kill "${APP_PID:-}" "${WM_PID:-}" "${X_PID:-}" 2>/dev/null || true
}
trap cleanup EXIT

Xvfb "$DISPLAY_NUM" -screen 0 1920x1080x24 >/dev/null 2>&1 &
X_PID=$!
export DISPLAY=$DISPLAY_NUM
sleep 1
openbox >/dev/null 2>&1 &
WM_PID=$!
sleep 1

# Software rendering for WebKitGTK inside Xvfb.
export WEBKIT_DISABLE_DMABUF_RENDERER=1 LIBGL_ALWAYS_SOFTWARE=1
"$BIN" samples/plate-mm.dxf samples/bracket-r12.dxf >"$OUT/app.log" 2>&1 &
APP_PID=$!

wait_windows() { # count timeout-seconds
  for _ in $(seq 1 $(( $2 * 10 ))); do
    n=$( (xdotool search --onlyvisible --name 'DXF Viewer' 2>/dev/null || true) | wc -l)
    [ "$n" -eq "$1" ] && return 0
    sleep 0.1
  done
  echo "expected $1 windows, found $n" >&2
  return 1
}

# Drag with the left button in small steps, like a hand would.
drag() { # x1 y1 x2 y2
  local steps=40
  xdotool mousemove "$1" "$2" mousedown 1
  sleep 0.2
  for i in $(seq 1 $steps); do
    xdotool mousemove $(( $1 + ($3 - $1) * i / steps )) $(( $2 + ($4 - $2) * i / steps ))
    sleep 0.03
  done
  sleep 0.3
  xdotool mouseup 1
  sleep 1
}

# Window id by title regex; waits for the page to load and set its title.
win() {
  for _ in $(seq 1 300); do
    id=$( (xdotool search --onlyvisible --name "$1" 2>/dev/null || true) | head -1)
    [ -n "$id" ] && { echo "$id"; return 0; }
    sleep 0.1
  done
  echo "no window titled $1" >&2
  return 1
}
# Top-left of a window's content in root coordinates (xdotool's geometry is off by the frame under some WMs).
geom() { xwininfo -id "$1" | awk '/Absolute upper-left X/ {x=$4} /Absolute upper-left Y/ {y=$4} END {print x, y}'; }

echo "1) one window per file"
wait_windows 2 30
W1=$(win 'plate-mm.dxf')
W2=$(win 'bracket-r12.dxf')
xdotool windowsize "$W1" 900 620 windowmove "$W1" 40 80
xdotool windowsize "$W2" 900 620 windowmove "$W2" 980 80
sleep 1
import -window root "$OUT/1-two-windows.png"

echo "2) drag the second window's tab onto the first window's tab bar"
read -r X2 Y2 < <(geom "$W2")
read -r X1 Y1 < <(geom "$W1")
drag $(( X2 + 80 )) $(( Y2 + 20 )) $(( X1 + 400 )) $(( Y1 + 20 ))
wait_windows 1 10
sleep 1
import -window root "$OUT/2-merged.png"
MERGED=$(win 'DXF Viewer')
xdotool getwindowname "$MERGED"

echo "3) drag a tab out of the tab bar to tear it off"
read -r XM YM < <(geom "$MERGED")
# The second tab (the adopted one) is centred about 200 px from the left edge.
drag $(( XM + 200 )) $(( YM + 20 )) $(( XM + 1100 )) $(( YM + 380 ))
wait_windows 2 10
sleep 1
import -window root "$OUT/3-torn-off.png"
for w in $(xdotool search --onlyvisible --name 'DXF Viewer'); do xdotool getwindowname "$w"; done

echo "4) a second launch opens its file in the running instance"
"$BIN" samples/plate-mm.dxf >"$OUT/second.log" 2>&1 &
SECOND=$!
wait_windows 3 30
for _ in $(seq 1 100); do kill -0 "$SECOND" 2>/dev/null || break; sleep 0.1; done
if kill -0 "$SECOND" 2>/dev/null; then echo "second instance kept running" >&2; exit 1; fi
import -window root "$OUT/4-single-instance.png"

echo "desktop smoke test passed; screenshots in $OUT"
