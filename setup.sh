#!/usr/bin/env bash
# setup.sh - installs the Next Meeting Cinnamon applet locally.
# Works with Google Calendar, Outlook, Apple Calendar, Nextcloud,
# and any RFC 5545 ICS/iCal feed.
# Layout follows cinnamon-spices-applets conventions:
#   ./next-meeting@caio-hat/files/next-meeting@caio-hat/<files>
set -euo pipefail

APPLET_UUID="next-meeting@caio-hat"
APPLET_INSTALL_DIR="$HOME/.local/share/cinnamon/applets/$APPLET_UUID"
LOCALE_BASE_DIR="$HOME/.local/share/locale"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/$APPLET_UUID/files/$APPLET_UUID"

if [ ! -d "$SOURCE_DIR" ]; then
    echo "ERROR: source directory not found: $SOURCE_DIR"
    echo "Make sure you are running setup.sh from the repository root."
    exit 1
fi

echo "================================================"
echo "  Next Meeting Applet - Setup"
echo "================================================"
echo ""

# ── 1) Python deps ─────────────────────────────────────────────────────────────
have_py_deps() {
    python3 -c "import icalendar, recurring_ical_events" 2>/dev/null
}

if have_py_deps; then
    echo "STEP 1: Python deps already installed. Skipping."
else
    echo "STEP 1: Installing Python deps..."
    installed=0
    if command -v apt-get >/dev/null 2>&1; then
        echo "  Trying via apt (recommended on Mint/Ubuntu); may prompt for sudo:"
        if sudo apt-get install -y python3-icalendar python3-recurring-ical-events python3-dateutil 2>/dev/null; then
            if have_py_deps; then
                echo "  OK - installed via apt."
                installed=1
            fi
        fi
    fi
    if [ "$installed" -eq 0 ]; then
        echo "  Trying pip3 --user..."
        if pip3 install --user --break-system-packages icalendar recurring-ical-events 2>/dev/null \
           || pip3 install --user icalendar recurring-ical-events 2>/dev/null; then
            if have_py_deps; then
                echo "  OK - installed via pip."
                installed=1
            fi
        fi
    fi
    if [ "$installed" -eq 0 ]; then
        echo ""
        echo "  WARNING: could not install icalendar/recurring-ical-events automatically."
        echo "  The applet will work, but RECURRING meetings will NOT appear."
        echo "  Manual install:  sudo apt install python3-icalendar python3-recurring-ical-events"
        echo ""
    fi
fi
echo ""

# ── 2) Compile translations (po/*.po → .mo) ─────────────────────────────────────────────────
echo "STEP 2: Compiling translations..."
if [ -d "$SOURCE_DIR/po" ]; then
    if command -v msgfmt >/dev/null 2>&1; then
        compiled=0
        for po in "$SOURCE_DIR"/po/*.po; do
            [ -f "$po" ] || continue
            lang="$(basename "$po" .po)"
            mo_dir="$LOCALE_BASE_DIR/$lang/LC_MESSAGES"
            mkdir -p "$mo_dir"
            if msgfmt "$po" -o "$mo_dir/$APPLET_UUID.mo" 2>/dev/null; then
                echo "  → $lang installed at $mo_dir/$APPLET_UUID.mo"
                compiled=$((compiled + 1))
            else
                echo "  ! Failed to compile $lang"
            fi
        done
        if [ "$compiled" -eq 0 ]; then
            echo "  (no .po files found)"
        fi
    else
        echo "  WARNING: msgfmt not found. Install with:  sudo apt install gettext"
        echo "  Translations skipped (applet will use English source strings)."
    fi
else
    echo "  (no po/ directory in source)"
fi
echo ""

# ── 3) Install applet files ─────────────────────────────────────────────────────────────────
echo "STEP 3: Installing applet to $APPLET_INSTALL_DIR..."
mkdir -p "$APPLET_INSTALL_DIR"
for f in metadata.json applet.js stylesheet.css settings-schema.json fetch_meetings.py; do
    cp "$SOURCE_DIR/$f" "$APPLET_INSTALL_DIR/"
done
if [ -d "$SOURCE_DIR/po" ]; then
    rm -rf "$APPLET_INSTALL_DIR/po"
    cp -r "$SOURCE_DIR/po" "$APPLET_INSTALL_DIR/"
fi
chmod +x "$APPLET_INSTALL_DIR/fetch_meetings.py"
echo "  OK."
echo ""

# ── 4) Instructions ─────────────────────────────────────────────────────────────────────
echo "================================================"
echo "  Setup complete!"
echo "================================================"
echo ""
echo "To apply changes:  cinnamon --replace &"
echo ""
echo "Add the applet:"
echo "  Right-click panel -> 'Add applets to the panel' -> find 'Next Meeting' -> +"
echo ""
echo "Configure:"
echo "  Right-click the applet -> 'Configure...' (or click the applet -> Settings)"
echo ""
echo "Debug logs (Cinnamon does NOT use journalctl --user by default):"
echo "  tail -f ~/.xsession-errors                # X11 sessions"
echo "  journalctl _COMM=cinnamon -f              # newer systems"
echo "  cinnamon-looking-glass                    # GUI (Alt+F2 'lg')"
echo ""
echo "Translations:"
echo "  Auto-detected via \$LANG. Contribute new ones via po/*.pot (see header)."
echo ""
echo "Compatible with: Google Calendar, Outlook, Apple Calendar, Nextcloud,"
echo "Fastmail, Proton Calendar, and any RFC 5545 ICS/iCal feed."
echo ""
