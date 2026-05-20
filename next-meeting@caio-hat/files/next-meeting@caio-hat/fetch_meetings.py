#!/usr/bin/env python3
"""Fetch upcoming meetings from one or more ICS/iCal calendar URLs.

Works with any RFC 5545 compliant feed: Google Calendar, Outlook,
Apple Calendar, Nextcloud, Fastmail, Proton Calendar, etc.

Reads JSON array of calendars from stdin:
  [{"name": "...", "url": "https://...", "color": "#1e88e5", "enabled": true}, ...]

Outputs JSON to stdout:
  {"meetings": [{"subject", "start", "end", "location", "join_url",
                  "status", "is_all_day", "calendar_name", "calendar_color",
                  "uid"}, ...]}
  or {"error": "..."}

status values: "accepted" | "tentative" | "free"

is_all_day: bool. When true, "start" and "end" are ISO dates ("YYYY-MM-DD")
            and the event spans whole days (no time component).

Translations: gettext domain "next-meeting@caio-hat" loaded from
~/.local/share/locale. See po/next-meeting@caio-hat.pot.
"""

import gettext
import json
import os
import re
import sys
import urllib.request
from datetime import date, datetime, timedelta, timezone

UUID = "next-meeting@caio-hat"
LOCALE_DIR = os.path.expanduser("~/.local/share/locale")

try:
    _t = gettext.translation(UUID, LOCALE_DIR, fallback=True)
    _ = _t.gettext
except Exception:
    _ = lambda s: s

LEGACY_CONFIG_FILE = os.path.expanduser(
    "~/.config/outlook-calendar-applet/config.json"
)

JOIN_URL_RE = re.compile(
    r'https?://(?:'
    r'teams\.microsoft\.com/l/meetup-join/[^\s<>"\'\\\.\]\)]+|'
    r'teams\.microsoft\.com/meet/[^\s<>"\'\\\.\]\)]+|'
    r'teams\.live\.com/meet/[^\s<>"\'\\\.\]\)]+|'
    r'meet\.google\.com/[a-z0-9\-]+|'
    r'(?:[a-z0-9\-]+\.)?zoom\.us/(?:j|my)/[^\s<>"\'\\\.\]\)]+|'
    r'whereby\.com/[^\s<>"\'\\\.\]\)]+'
    r')',
    re.IGNORECASE,
)


def _to_utc(value):
    if isinstance(value, datetime):
        return value.replace(tzinfo=timezone.utc) if value.tzinfo is None \
               else value.astimezone(timezone.utc)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day, tzinfo=timezone.utc)
    return None


def _extract_join_url(*texts):
    for t in texts:
        if not t:
            continue
        m = JOIN_URL_RE.search(str(t))
        if m:
            return m.group(0)
    return ""


def _fetch_ics(url, timeout=20):
    req = urllib.request.Request(url)
    req.add_header("User-Agent", "NextMeetingCinnamonApplet/2.5")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _event_status_icalendar(component):
    busy = str(component.get("X-MICROSOFT-CDO-BUSYSTATUS", "") or "").strip().upper()
    if busy == "TENTATIVE":
        return "tentative"
    if busy in ("BUSY", "OOF"):
        return "accepted"
    if busy == "FREE":
        return "free"
    std = str(component.get("STATUS", "") or "").strip().upper()
    if std == "TENTATIVE":
        return "tentative"
    return "accepted"


def _event_status_builtin(get_fn):
    busy = get_fn("X-MICROSOFT-CDO-BUSYSTATUS").upper()
    if busy == "TENTATIVE":
        return "tentative"
    if busy in ("BUSY", "OOF"):
        return "accepted"
    if busy == "FREE":
        return "free"
    std = get_fn("STATUS").upper()
    if std == "TENTATIVE":
        return "tentative"
    return "accepted"


def _is_all_day(dt):
    """True iff dt is a plain datetime.date (no time component)."""
    return isinstance(dt, date) and not isinstance(dt, datetime)


def _parse_icalendar(ics_bytes, calendar, now, window_end):
    from icalendar import Calendar
    cal = Calendar.from_ical(ics_bytes)

    try:
        import recurring_ical_events
        components = recurring_ical_events.of(cal).between(now, window_end)
        recurring_ok = True
    except ImportError:
        components = list(cal.walk("VEVENT"))
        recurring_ok = False

    today = now.date()
    window_end_date = window_end.date()

    events = []
    for component in components:
        if str(component.get("STATUS", "")).upper() == "CANCELLED":
            continue
        dtstart = component.get("DTSTART")
        if not dtstart:
            continue

        is_all_day = _is_all_day(dtstart.dt)

        if is_all_day:
            start_date = dtstart.dt
            dtend = component.get("DTEND")
            # iCal all-day DTEND is exclusive (the day AFTER the last day).
            # We store inclusive end = DTEND - 1 day, or start_date if missing.
            if dtend and _is_all_day(dtend.dt):
                end_date = dtend.dt - timedelta(days=1)
            else:
                end_date = start_date
            if end_date < today or start_date > window_end_date:
                continue
            start_iso = start_date.isoformat()
            end_iso = end_date.isoformat()
            uid_suffix = start_iso
        else:
            start_dt = _to_utc(dtstart.dt)
            dtend = component.get("DTEND")
            end_dt = _to_utc(dtend.dt) if dtend else None
            if start_dt > window_end:
                continue
            if end_dt and end_dt <= now:
                continue
            if not end_dt and start_dt + timedelta(minutes=30) <= now:
                continue
            start_iso = start_dt.isoformat().replace("+00:00", "Z")
            end_iso = end_dt.isoformat().replace("+00:00", "Z") if end_dt else ""
            uid_suffix = start_dt.isoformat()

        desc = str(component.get("DESCRIPTION", "") or "")
        loc  = str(component.get("LOCATION", "") or "").replace("\\n", " ").replace("\n", " ").strip()

        events.append({
            "uid":            str(component.get("UID", "")) + "@" + uid_suffix,
            "subject":        str(component.get("SUMMARY", "") or _("Untitled")),
            "start":          start_iso,
            "end":            end_iso,
            "location":       loc,
            "join_url":       _extract_join_url(desc, loc),
            "status":         _event_status_icalendar(component),
            "is_all_day":     is_all_day,
            "calendar_name":  calendar.get("name", ""),
            "calendar_color": calendar.get("color", "#1e88e5"),
        })
    return events, recurring_ok


def _parse_builtin(ics_bytes, calendar, now, window_end):
    text = ics_bytes.decode("utf-8", errors="replace")
    text = re.sub(r"\r?\n[ \t]", "", text)
    events = []
    has_rrule = False
    today = now.date()
    window_end_date = window_end.date()

    for block in re.split(r"BEGIN:VEVENT", text)[1:]:
        block = block.split("END:VEVENT")[0]

        def get(prop):
            pat = rf"^{re.escape(prop)}(?:;[^:\n]*)?:(.+)$"
            m = re.search(pat, block, re.MULTILINE)
            return m.group(1).strip() if m else ""

        if "RRULE" in block:
            has_rrule = True
        if get("STATUS").upper() == "CANCELLED":
            continue

        raw_start = get("DTSTART")
        raw_end   = get("DTEND")
        if not raw_start:
            continue

        def parse_date_only(s):
            s = re.sub(r"[^0-9]", "", s)
            try:
                return datetime.strptime(s, "%Y%m%d").date()
            except ValueError:
                return None

        def parse_dt(s):
            s = s.rstrip("Z")
            s = re.sub(r"[^0-9T]", "", s)
            try:
                return datetime.strptime(s, "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
            except ValueError:
                return None

        # Detect VALUE=DATE (all-day): DTSTART of 8 digits (YYYYMMDD).
        clean_start = re.sub(r"[^0-9T]", "", raw_start.rstrip("Z"))
        is_all_day = len(clean_start) == 8

        if is_all_day:
            start_date = parse_date_only(raw_start)
            end_date = parse_date_only(raw_end) if raw_end else None
            if not start_date:
                continue
            # iCal exclusive DTEND for dates → store inclusive end
            if end_date:
                end_date = end_date - timedelta(days=1)
            else:
                end_date = start_date
            if end_date < today or start_date > window_end_date:
                continue
            start_iso = start_date.isoformat()
            end_iso = end_date.isoformat()
            uid_suffix = start_iso
        else:
            start_dt = parse_dt(raw_start)
            end_dt   = parse_dt(raw_end) if raw_end else None
            if not start_dt or start_dt > window_end:
                continue
            if end_dt and end_dt <= now:
                continue
            start_iso = start_dt.isoformat().replace("+00:00", "Z")
            end_iso = end_dt.isoformat().replace("+00:00", "Z") if end_dt else ""
            uid_suffix = start_dt.isoformat()

        desc = get("DESCRIPTION").replace("\\n", " ").replace("\\,", ",")
        loc  = get("LOCATION").replace("\\n", " ").replace("\\,", ",")

        events.append({
            "uid":            get("UID") + "@" + uid_suffix,
            "subject":        get("SUMMARY") or _("Untitled"),
            "start":          start_iso,
            "end":            end_iso,
            "location":       loc,
            "join_url":       _extract_join_url(desc, loc),
            "status":         _event_status_builtin(get),
            "is_all_day":     is_all_day,
            "calendar_name":  calendar.get("name", ""),
            "calendar_color": calendar.get("color", "#1e88e5"),
        })
    return events, has_rrule


def _load_calendars():
    raw = ""
    if not sys.stdin.isatty():
        try:
            raw = sys.stdin.read().strip()
        except Exception:
            raw = ""
    if raw:
        try:
            data = json.loads(raw)
            if isinstance(data, list):
                return data
        except json.JSONDecodeError:
            pass
    if os.path.exists(LEGACY_CONFIG_FILE):
        try:
            with open(LEGACY_CONFIG_FILE) as fh:
                legacy = json.load(fh)
            if isinstance(legacy, dict) and legacy.get("ics_url"):
                return [{"name": "Calendar", "url": legacy["ics_url"],
                         "color": "#1e88e5", "enabled": True}]
        except Exception:
            pass
    return []


def main():
    calendars = _load_calendars()
    if not calendars:
        print(json.dumps({"error": _("No calendar configured. Right-click the applet -> Configure -> add an ICS URL.")}))
        return

    try:
        import icalendar  # noqa: F401
        has_ical = True
    except ImportError:
        has_ical = False

    now = datetime.now(timezone.utc)
    window_end = now + timedelta(days=7, hours=1)
    all_events = []
    errors = []
    rrule_warning = False

    for cal in calendars:
        if not cal.get("enabled", True):
            continue
        url = (cal.get("url") or "").strip()
        if not url:
            continue
        name = cal.get("name") or _("calendar")
        try:
            ics_bytes = _fetch_ics(url)
        except Exception as exc:
            errors.append(_("%(name)s: fetch error (%(error)s)") % {"name": name, "error": exc})
            continue
        try:
            if has_ical:
                events, recurring_ok = _parse_icalendar(ics_bytes, cal, now, window_end)
                if not recurring_ok:
                    rrule_warning = True
            else:
                events, has_rrule = _parse_builtin(ics_bytes, cal, now, window_end)
                if has_rrule:
                    rrule_warning = True
            all_events.extend(events)
        except Exception as exc:
            errors.append(_("%(name)s: parse error (%(error)s)") % {"name": name, "error": exc})

    all_events.sort(key=lambda e: e["start"])

    if errors and not all_events:
        print(json.dumps({"error": "; ".join(errors)}))
        return

    out = {"meetings": all_events}
    warnings = list(errors)
    if rrule_warning:
        warnings.append(_("Recurring events may not appear. Install: sudo apt install python3-icalendar python3-recurring-ical-events"))
    if warnings:
        out["warnings"] = warnings
    print(json.dumps(out))


if __name__ == "__main__":
    main()
