# Changelog

All notable changes to **Next Meeting** are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versioning: [Semantic Versioning](https://semver.org/).

## [2.5.3] — 2026-05-19

### Fixed
- Marquee fully reverted to character-stepped scrolling (`set_applet_label` with a sliding window). The pixel-based attempts via `clutter_text.set_translation` and `set_x` were unreliable on GJS/Cinnamon — either the text wouldn't paint until hover, or St.Label's own allocate overwrote the position and the scroll froze entirely.
- Tick interval lowered from a minimum of 80 ms to ~50 ms and tied to `marquee-speed` as `550 / speed` ms (1 = slow, 20 = fast); `set_applet_label` triggers an unconditional repaint so frames never skip. The icon next to the label still stays put thanks to `min-width + monospace` on the panel label.

### Changed
- `marquee-speed` units field in the schema changed from `px/frame` to `level` to match the new semantics.

## [2.5.2] — 2026-05-19

### Fixed
- Marquee text now advances on every tick instead of waiting for a hover-triggered repaint. The tick handler uses `clutter_text.set_x(-px)` plus explicit `queue_redraw()` on the text and the parent St.Label, so the panel paints at every frame regardless of pointer activity.

## [2.5.1] — 2026-05-19

### Changed
- **Calendars list**: column order is now `Active` (checkbox) → `Name` → `ICS URL` → `Color`, so the active toggle is at the start of each row. The URL column has `ellipsize: end` and `max-width: 280` to keep long URLs from blowing up the row width.
- **Smooth marquee**: scrolling now moves pixel-by-pixel via Pango layout measurement and `clutter_text.set_translation` at ~30 fps, instead of stepping one character per tick. The parent label is clipped to its allocation so the duplicated text never leaks past the panel slot.
- `marquee-speed` semantics flipped to pixels-per-frame (1 = slow, 20 = fast). Default raised from 2 to 4 (≈ 2 px/frame). Units in the schema updated from `x100 ms` to `px/frame`.

## [2.5.0] — 2026-05-19

### Added
- **All-day events** — `VALUE=DATE` events (PTO, holidays, focus blocks) now flow through the feed. They appear at the top of each bucket in the popup with a `◼ All day` badge and never compete for the panel slot.
- **Snooze notifications** — desktop notifications now carry `Snooze 5 min`, `Snooze 15 min`, and `Dismiss` actions, dispatched via `org.freedesktop.Notifications` D-Bus.
- **Hide-subject privacy mode** — new privacy level between full display and Hidden Mode. Keeps the time and countdown visible, hides the meeting subject. Toggle in the popup and in Settings → Privacy.
- **Multiple instances** — `max-instances` raised to unlimited. Run several Next Meeting applets side by side with different calendars (e.g. work / personal).

### Changed
- Notifications now use D-Bus directly instead of `notify-send`. `notify-send` remains as fallback when the D-Bus proxy fails to initialise.
- `_detectConflicts` skips all-day events (they don't conflict with timed meetings).
- Popup buckets (Next 24 hours / 3 days / 7 days) now show all-day events prepended above timed ones, and their counts include both.

## [2.4.1] — 2026-05-18

### Changed
- Moved the Help / Legend content out of the popup submenu into a dedicated **Help** page in Settings (alongside *General* and *Advanced*), so the popup stays compact.

## [2.4.0] — 2026-05-18

### Added
- New setting `show-tentative-in-panel`: ON shows the next meeting by time regardless of status; OFF skips tentatives and only shows accepted ones.
- Help / Legend submenu in the popup (reverted in 2.4.1 — see above).

### Changed
- The Agenda icon stays put during marquee scrolling. The panel label gets a `min-width` and `font-family: monospace` while the marquee is active.
- Marquee feels smoother: minimum tick interval lowered (150 ms → 80 ms), default `marquee-speed` changed from 4 to 2 (~5 chars/s).

## [2.3.0] — 2026-05-16

### Added
- Generic ICS support — works with any RFC 5545 compliant feed (Google, Outlook, Apple, Nextcloud, Fastmail, Proton).
- Day boundary: panel never shows next-day meetings. After today's last meeting, the panel shows `✓`.
- `timer-position` setting: place the time before or after the meeting name.
- Marquee toggle for long meeting names.

### Changed
- Project renamed `outlook-calendar@caio-hat` → `next-meeting@caio-hat`. Old config (`~/.config/outlook-calendar-applet/config.json`) is auto-migrated on first launch.
- Repo layout reorganized to follow `linuxmint/cinnamon-spices-applets` conventions (`<UUID>/info.json` + `<UUID>/files/<UUID>/…`).

## [2.2.x] — earlier

### Fixed
- Settings page now opens correctly. `xlet-settings applet UUID --id <id>` (instance_id is a flag, not a positional argument).

### Changed
- Adopted the cinnamon-spices-applets directory layout in preparation for community submission.

## [2.0.0]

### Changed
- Removed OAuth/MSAL Azure AD flow. The applet now pulls events from a plain ICS URL — no Microsoft sign-in or app registration required.
