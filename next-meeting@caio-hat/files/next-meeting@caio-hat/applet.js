// Next Meeting - Cinnamon Applet
// Works with any standard ICS/iCal URL: Google Calendar, Outlook, Apple Calendar,
// Nextcloud, Fastmail, Proton Calendar, or any RFC 5545 compliant feed.
// Cinnamon API compatibility: SpiderMonkey 102 / 115 / 128 / 140.

const Applet    = imports.ui.applet;
const Gettext   = imports.gettext;
const Gio       = imports.gi.Gio;
const GLib      = imports.gi.GLib;
const Mainloop  = imports.mainloop;
const PopupMenu = imports.ui.popupMenu;
const Settings  = imports.ui.settings;
const Util      = imports.misc.util;

const UUID           = "next-meeting@caio-hat";
const NOTIFY_CHECK_S = 30;
const LEGACY_CONFIG  = GLib.get_home_dir() + "/.config/outlook-calendar-applet/config.json";

Gettext.bindtextdomain(UUID, GLib.get_home_dir() + "/.local/share/locale");
function _(s) { return Gettext.dgettext(UUID, s); }
function _f(s) {
    let args = Array.prototype.slice.call(arguments, 1);
    let i = 0;
    return Gettext.dgettext(UUID, s).replace(/%[sd]/g, function () { return String(args[i++]); });
}
function _np(singular, plural, n) {
    return Gettext.dngettext(UUID, singular, plural, n).replace("%d", String(n));
}

class NextMeetingApplet extends Applet.TextIconApplet {

    constructor(metadata, orientation, panelHeight, instanceId) {
        super(orientation, panelHeight, instanceId);

        this._metadata          = metadata;
        this._instanceId        = instanceId;
        this._appletDir         = metadata.path;
        this._allMeetings       = [];
        this._nextMeeting       = null;
        this._inProgress        = null;
        this._panelMeeting      = null;
        this._hasFutureMeetings = false;
        this._conflictKeys      = new Set();
        this._notifiedIds       = new Set();
        this._notifiedConflicts = new Set();
        this._snoozeUntil       = {};   // meetingKey → unix ms; suppress notify until then
        this._pendingNotifs     = {};   // dbus notification id → meetingKey
        this._notifSignalId     = 0;    // ActionInvoked signal subscription
        this._notifProxy        = null; // org.freedesktop.Notifications proxy
        this._lastError         = null;
        this._suppressToggle    = false;
        this._refreshTimer      = 0;
        this._notifyTimer       = 0;
        this._marqueeTimer      = 0;
        this._marqueePxOffset   = 0;
        this._marqueeCopyWidth  = 0;
        this._marqueeText       = "";

        this.settings = new Settings.AppletSettings(this, UUID, instanceId);
        this.settings.bind("calendars",        "calendars",       this._onCalendarsChanged.bind(this));
        this.settings.bind("show-in-panel",    "showInPanel",     this._onShowInPanelChanged.bind(this));
        this.settings.bind("hidden-mode",      "hiddenMode",      this._onHiddenModeChanged.bind(this));
        this.settings.bind("label-max-chars",  "labelMaxChars",   this._updateDisplay.bind(this));
        this.settings.bind("timer-position",   "timerPosition",   this._updateDisplay.bind(this));
        this.settings.bind("marquee-enabled",  "marqueeEnabled",  this._updateDisplay.bind(this));
        this.settings.bind("marquee-speed",    "marqueeSpeed",    this._onMarqueeSpeedChanged.bind(this));
        this.settings.bind("notify-enabled",   "notifyEnabled");
        this.settings.bind("notify-before",    "notifyBefore");
        this.settings.bind("notify-conflicts", "notifyConflicts");
        this.settings.bind("refresh-interval", "refreshInterval", this._startRefreshTimer.bind(this));
        this.settings.bind("show-tentative",   "showTentative",   this._onShowTentativeChanged.bind(this));
        this.settings.bind("show-tentative-in-panel", "showTentativeInPanel", this._onShowTentativeInPanelChanged.bind(this));
        this.settings.bind("hide-subject",     "hideSubject",     this._onHideSubjectChanged.bind(this));

        this._migrateLegacyConfig();
        this._setupNotifications();

        this.set_applet_icon_symbolic_name("x-office-calendar");
        this.set_applet_label(_("%s").replace("%s", "..."));
        this.set_applet_tooltip(_("Next Meeting - loading..."));

        this._buildMenu();
        this._startRefreshTimer();
        this._startNotifyTimer();
        this._fetchMeetings();
    }

    _migrateLegacyConfig() {
        try {
            if (this.calendars && this.calendars.length > 0) return;
            if (!GLib.file_test(LEGACY_CONFIG, GLib.FileTest.EXISTS)) return;
            let [ok, raw] = GLib.file_get_contents(LEGACY_CONFIG);
            if (!ok) return;
            let text = (raw instanceof Uint8Array) ? imports.byteArray.toString(raw) : String(raw);
            let legacy = JSON.parse(text);
            if (legacy && legacy.ics_url) {
                this.calendars = [{ name: "Calendar", url: legacy.ics_url, color: "#1e88e5", enabled: true }];
                this.settings.setValue("calendars", this.calendars);
                global.log("[" + UUID + "] Legacy config migrated.");
            }
        } catch (e) {
            global.logError("[" + UUID + "] Migration failed: " + e);
        }
    }

    _buildMenu() {
        this._menuManager = new PopupMenu.PopupMenuManager(this);
        this._menu = new Applet.AppletPopupMenu(this, this._orientation);
        this._menuManager.addMenu(this._menu);

        this._nextItem = new PopupMenu.PopupMenuItem(_("Loading..."), { reactive: false });
        this._nextItem.actor.add_style_class_name("next-meeting-next-item");
        this._nextItem.label.clutter_text.set_line_wrap(true);
        this._menu.addMenuItem(this._nextItem);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._sub24 = new PopupMenu.PopupSubMenuMenuItem(_("Next 24 hours"));
        this._sub3d = new PopupMenu.PopupSubMenuMenuItem(_("Next 3 days"));
        this._sub7d = new PopupMenu.PopupSubMenuMenuItem(_("Next 7 days"));
        this._menu.addMenuItem(this._sub24);
        this._menu.addMenuItem(this._sub3d);
        this._menu.addMenuItem(this._sub7d);
        this._sub24.menu.open(false);

        this._menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._hiddenSwitch = new PopupMenu.PopupSwitchMenuItem(_("Hidden mode (countdown only)"), this.hiddenMode === true);
        this._hiddenSwitch.connect("toggled", (item, state) => {
            if (this._suppressToggle || state === this.hiddenMode) return;
            this.hiddenMode = state;
            this.settings.setValue("hidden-mode", state);
            this._updateDisplay();
        });
        this._menu.addMenuItem(this._hiddenSwitch);

        this._hideSubjectSwitch = new PopupMenu.PopupSwitchMenuItem(_("Hide subject (show time only)"), this.hideSubject === true);
        this._hideSubjectSwitch.connect("toggled", (item, state) => {
            if (this._suppressToggle || state === this.hideSubject) return;
            this.hideSubject = state;
            this.settings.setValue("hide-subject", state);
            this._updateDisplay();
        });
        this._menu.addMenuItem(this._hideSubjectSwitch);

        this._showSwitch = new PopupMenu.PopupSwitchMenuItem(_("Show text in panel"), this.showInPanel !== false);
        this._showSwitch.connect("toggled", (item, state) => {
            if (this._suppressToggle || state === this.showInPanel) return;
            this.showInPanel = state;
            this.settings.setValue("show-in-panel", state);
            this._updateDisplay();
        });
        this._menu.addMenuItem(this._showSwitch);

        this._tentativeSwitch = new PopupMenu.PopupSwitchMenuItem(_("Show tentative meetings"), this.showTentative !== false);
        this._tentativeSwitch.connect("toggled", (item, state) => {
            if (this._suppressToggle || state === this.showTentative) return;
            this.showTentative = state;
            this.settings.setValue("show-tentative", state);
            this._renderMenu();
            this._updateDisplay();
        });
        this._menu.addMenuItem(this._tentativeSwitch);

        let refresh = new PopupMenu.PopupMenuItem(_("Refresh now"));
        refresh.connect("activate", () => this._fetchMeetings());
        this._menu.addMenuItem(refresh);

        let configure = new PopupMenu.PopupMenuItem(_("Settings"));
        configure.connect("activate", () => this._openSettings());
        this._menu.addMenuItem(configure);
    }

    // xlet-settings argparse: instance_id is an optional FLAG --id, NOT a positional argument.
    _openSettings() {
        let id = this.instance_id != null ? this.instance_id : this._instanceId;
        let argv = ["xlet-settings", "applet", UUID];
        if (id != null && String(id) !== "") {
            argv.push("--id", String(id));
        }
        global.log("[" + UUID + "] _openSettings argv=" + argv.join(" "));
        this._menu.close(false);

        let startedAt = GLib.get_monotonic_time();
        let success = false, pid = 0;
        try {
            [success, pid] = GLib.spawn_async(
                null, argv, GLib.get_environ(),
                GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
                null
            );
        } catch (e) {
            global.logError("[" + UUID + "] spawn_async threw: " + e);
            this._openSettingsFallback("spawn_async threw: " + e);
            return;
        }

        if (!success || !pid) {
            this._openSettingsFallback("spawn_async returned success=" + success);
            return;
        }

        GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (childPid, status) => {
            let elapsedMs = Math.round((GLib.get_monotonic_time() - startedAt) / 1000);
            global.log("[" + UUID + "] xlet-settings exit status=" + status + " in " + elapsedMs + "ms");
            GLib.spawn_close_pid(childPid);
            if (status !== 0 && elapsedMs < 1500) {
                this._openSettingsFallback("xlet-settings exit status=" + status);
            }
        });
    }

    _openSettingsFallback(reason) {
        global.log("[" + UUID + "] fallback (" + reason + ")");
        try {
            Util.spawn(["cinnamon-settings", "applets", UUID]);
        } catch (e) {
            global.logError("[" + UUID + "] cinnamon-settings fallback failed: " + e);
            try {
                Util.spawn(["notify-send", "--urgency=critical",
                            "--app-name=Next Meeting",
                            _("Settings"),
                            "Failed to open settings.\n" + reason + "\n" + e]);
            } catch (_unused) { /* ignore */ }
        }
    }

    on_applet_clicked(_e) { this._menu.toggle(); }

    _startRefreshTimer() {
        if (this._refreshTimer) { Mainloop.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        let secs = Math.max(60, (this.refreshInterval || 5) * 60);
        this._refreshTimer = Mainloop.timeout_add_seconds(secs, () => {
            this._fetchMeetings();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _startNotifyTimer() {
        if (this._notifyTimer) { Mainloop.source_remove(this._notifyTimer); this._notifyTimer = 0; }
        this._notifyTimer = Mainloop.timeout_add_seconds(NOTIFY_CHECK_S, () => {
            this._checkUpcomingNotification();
            this._checkConflictNotification();
            this._updateNextItem();
            this._updateDisplay();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onCalendarsChanged()      { this._fetchMeetings(); }
    _onShowInPanelChanged()    { this._syncSwitch(this._showSwitch,      this.showInPanel);   this._updateDisplay(); }
    _onHiddenModeChanged()     { this._syncSwitch(this._hiddenSwitch,    this.hiddenMode);    this._updateDisplay(); }
    _onShowTentativeChanged()  { this._syncSwitch(this._tentativeSwitch, this.showTentative); this._renderMenu(); this._updateDisplay(); }
    _onShowTentativeInPanelChanged() { this._renderMenu(); this._updateDisplay(); }
    _onHideSubjectChanged()    { this._syncSwitch(this._hideSubjectSwitch, this.hideSubject); this._updateDisplay(); }
    _onMarqueeSpeedChanged()   { this._stopMarquee(); this._updateDisplay(); }

    _syncSwitch(sw, value) {
        if (!sw || sw.state === value) return;
        this._suppressToggle = true;
        sw.setToggleState(value);
        this._suppressToggle = false;
    }

    _fetchMeetings() {
        let scriptPath = this._appletDir + "/fetch_meetings.py";
        try {
            let proc = Gio.Subprocess.new(
                ["python3", scriptPath],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
            proc.communicate_utf8_async(JSON.stringify(this.calendars || []), null, (p, res) => {
                try {
                    let [, stdout, stderr] = p.communicate_utf8_finish(res);
                    this._handleFetchOutput(stdout || "", stderr || "");
                } catch (e) {
                    this._setError(_("Error fetching meetings"));
                    global.logError("[" + UUID + "] communicate: " + e);
                }
            });
        } catch (e) {
            this._setError(_("python3 not found"));
            global.logError("[" + UUID + "] spawn: " + e);
        }
    }

    _handleFetchOutput(stdout, stderr) {
        let raw = stdout.trim();
        if (!raw) { this._setError(_("No response") + "\n" + stderr.slice(0, 200)); return; }
        let data;
        try { data = JSON.parse(raw); }
        catch (e) { this._setError(_("Error parsing response")); global.logError("[" + UUID + "] JSON: " + e); return; }
        if (data.error) { this._setError(data.error); return; }
        this._lastError = null;
        this._allMeetings = data.meetings || [];
        this._renderMenu();
        this._updateDisplay();
        this._checkUpcomingNotification();
        this._checkConflictNotification();
    }

    _setError(msg) {
        this._stopMarquee();
        this._lastError = msg;
        this._allMeetings = []; this._nextMeeting = null; this._inProgress = null;
        this._panelMeeting = null; this._hasFutureMeetings = false;
        this._conflictKeys = new Set();
        this.hide_applet_label(false);
        this.set_applet_label("⚠");
        this.set_applet_tooltip(msg);
        if (this._nextItem) this._nextItem.label.set_text(msg);
        for (let sub of [this._sub24, this._sub3d, this._sub7d]) {
            if (!sub) continue;
            sub.menu.removeAll();
            sub.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("(error)"), { reactive: false }));
        }
    }

    _fmtTime(iso) {
        let d = new Date(iso);
        return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
    }
    _fmtDay(iso) {
        return new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "2-digit", month: "2-digit" });
    }
    _fmtFull(iso) { return this._fmtDay(iso) + " " + this._fmtTime(iso); }
    _countdown(iso) {
        let diff = new Date(iso).getTime() - Date.now();
        if (diff <= 0) return _f("now (%d min ago)", Math.round(Math.abs(diff) / 60000));
        let mins = Math.round(diff / 60000);
        if (mins < 60) return _f("in %d min", mins);
        let h = Math.floor(mins / 60), m = mins % 60;
        if (h < 24) return m > 0 ? _f("in %dh %dmin", h, m) : _f("in %dh", h);
        return _f("in %d day(s)", Math.floor(h / 24));
    }
    _esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
    _color(c) {
        if (!c) return "#1e88e5";
        c = String(c).trim();
        if (c.startsWith("#")) return c;
        let m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        return m ? "#" + [m[1], m[2], m[3]].map(n => parseInt(n, 10).toString(16).padStart(2, "0")).join("") : "#1e88e5";
    }
    _mkey(m) { return (m.uid || "") + "|" + m.start; }

    _detectConflicts(meetings) {
        let keys = new Set();
        for (let i = 0; i < meetings.length; i++) {
            for (let j = i + 1; j < meetings.length; j++) {
                let a = meetings[i], b = meetings[j];
                if (a.status === "free" || b.status === "free") continue;
                if (a.is_all_day || b.is_all_day) continue;
                let aS = new Date(a.start).getTime(), aE = a.end ? new Date(a.end).getTime() : aS + 30 * 60 * 1000;
                let bS = new Date(b.start).getTime(), bE = b.end ? new Date(b.end).getTime() : bS + 30 * 60 * 1000;
                if (aS < bE && bS < aE) { keys.add(this._mkey(a)); keys.add(this._mkey(b)); }
            }
        }
        return keys;
    }

    _todayDateStr() {
        let d = new Date();
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }
    _addDaysStr(daysFromToday) {
        let d = new Date();
        d.setDate(d.getDate() + daysFromToday);
        return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
    }

    _renderMenu() {
        let now  = Date.now();
        let h24  = now + 24 * 3600 * 1000;
        let h72  = now + 3 * 24 * 3600 * 1000;
        let h168 = now + 7 * 24 * 3600 * 1000;
        let todayDateStr = this._todayDateStr();
        let date3Str     = this._addDaysStr(3);
        let date7Str     = this._addDaysStr(7);

        this._inProgress = null;
        let future = [];
        let futureAllDay = [];
        for (let m of this._allMeetings) {
            if (m.is_all_day) {
                // m.start / m.end are "YYYY-MM-DD" (inclusive end). Keep if end >= today.
                let endDate = m.end || m.start;
                if (endDate < todayDateStr) continue;
                if (m.start > date7Str) continue;
                futureAllDay.push(m);
                continue;
            }
            let s = new Date(m.start).getTime();
            let e = m.end ? new Date(m.end).getTime() : s + 30 * 60 * 1000;
            if (e <= now) continue;
            if (s <= now && now < e) { if (!this._inProgress) this._inProgress = m; }
            else if (s <= h168)      { future.push(m); }
        }

        // _nextMeeting prefers timed (countdownable); falls back to all-day so popup header isn't empty.
        this._nextMeeting = this._inProgress
            || (future.length > 0 ? future[0] : null)
            || (futureAllDay.length > 0 ? futureAllDay[0] : null);

        // Panel only shows today's TIMED meetings — never all-day, never next-day.
        let todayStr      = new Date().toDateString();
        let todayFuture   = future.filter(m => new Date(m.start).toDateString() === todayStr);
        let nextAccepted  = todayFuture.find(m => m.status !== "tentative") || null;
        let earliestToday = todayFuture[0] || null;
        this._panelMeeting      = this._inProgress
            || (this.showTentativeInPanel !== false ? earliestToday : nextAccepted);
        this._hasFutureMeetings = future.length > 0;

        this._conflictKeys = this._detectConflicts(this._inProgress ? [this._inProgress, ...future] : future);

        this._updateNextItem();

        let show = (m) => this.showTentative !== false || m.status !== "tentative";
        let live24 = this._inProgress && show(this._inProgress) ? [this._inProgress] : [];
        let b24 = live24.concat(future.filter(m => new Date(m.start).getTime() <= h24 && show(m)));
        let b3d = future.filter(m => { let s = new Date(m.start).getTime(); return s > h24 && s <= h72  && show(m); });
        let b7d = future.filter(m => { let s = new Date(m.start).getTime(); return s > h72  && s <= h168 && show(m); });

        // All-day events: prepend per bucket by start date.
        let ad24 = futureAllDay.filter(m => m.start <= todayDateStr && show(m));
        let ad3d = futureAllDay.filter(m => m.start > todayDateStr && m.start <= date3Str && show(m));
        let ad7d = futureAllDay.filter(m => m.start > date3Str   && m.start <= date7Str && show(m));

        let totals24 = b24.length + ad24.length;
        let totals3d = b3d.length + ad3d.length;
        let totals7d = b7d.length + ad7d.length;

        this._sub24.label.set_text(_("Next 24 hours") + " (" + totals24 + ")");
        this._sub3d.label.set_text(_("Next 3 days")   + " (" + totals3d + ")");
        this._sub7d.label.set_text(_("Next 7 days")   + " (" + totals7d + ")");

        this._fillSection(this._sub24, ad24.concat(b24), false, this._conflictKeys);
        this._fillSection(this._sub3d, ad3d.concat(b3d), true,  this._conflictKeys);
        this._fillSection(this._sub7d, ad7d.concat(b7d), true,  this._conflictKeys);
    }

    _updateNextItem() {
        if (this._lastError) return;
        let m = this._nextMeeting;
        if (!m) { this._nextItem.label.set_text(_("No meetings in the next 7 days")); return; }

        let now     = Date.now();
        let color   = this._color(m.calendar_color);
        let isConflict = this._conflictKeys.has(this._mkey(m));

        if (m.is_all_day) {
            let dotColor = m.status === "tentative" ? "#ffa726" : color;
            let dayLabel = (m.end && m.end !== m.start)
                ? this._fmtAllDayRange(m.start, m.end)
                : _("All day");
            let markup =
                "<span foreground=\"" + dotColor + "\" font_weight=\"bold\">◼</span> " +
                "<b>" + this._esc(m.subject) + "</b>" +
                (m.status === "tentative" ? "  <small><i>" + this._esc(_("(tentative)")) + "</i></small>" : "") +
                "\n<small>" + this._esc(dayLabel) + "</small>";
            this._nextItem.label.clutter_text.set_markup(markup);
            return;
        }

        let startMs = new Date(m.start).getTime();
        let isLive  = !!(this._inProgress && this._inProgress.start === m.start);
        let dot      = isLive ? "◎" : (m.status === "tentative" ? "?" : "●");
        let dotColor = isLive ? "#f44336" : (m.status === "tentative" ? "#ffa726" : color);

        let line2;
        if (isLive) {
            let mins = Math.round((now - startMs) / 60000);
            let end  = m.end ? this._fmtTime(m.end) : "?";
            line2 = _f("IN PROGRESS (%d min ago) · until %s", mins, end);
        } else {
            line2 = this._countdown(m.start) + "  ·  " + this._fmtTime(m.start) + " - " + (m.end ? this._fmtTime(m.end) : "?");
        }
        if (m.location) line2 += "  ·  " + m.location;

        let markup =
            "<span foreground=\"" + dotColor + "\" font_weight=\"bold\">" + dot + "</span> " +
            (isConflict ? "<span foreground=\"#ff7043\">⚠ </span>" : "") +
            "<b>" + this._esc(m.subject) + "</b>" +
            (m.status === "tentative" ? "  <small><i>" + this._esc(_("(tentative)")) + "</i></small>" : "") +
            "\n<small>" + this._esc(line2) + "</small>";
        this._nextItem.label.clutter_text.set_markup(markup);
    }

    _fmtAllDayRange(startDate, endDate) {
        // YYYY-MM-DD inputs
        let s = new Date(startDate + "T00:00:00");
        let e = new Date(endDate + "T00:00:00");
        let opts = { day: "2-digit", month: "2-digit" };
        return _("All day") + " (" + s.toLocaleDateString(undefined, opts) + " → " + e.toLocaleDateString(undefined, opts) + ")";
    }

    _fillSection(section, meetings, groupByDay, conflictKeys) {
        section.menu.removeAll();
        if (meetings.length === 0) {
            section.menu.addMenuItem(new PopupMenu.PopupMenuItem(_("(no meetings)"), { reactive: false }));
            return;
        }
        let lastDay = "";
        for (let m of meetings) {
            if (groupByDay) {
                let day = this._fmtDay(m.start);
                if (day !== lastDay) {
                    let sep = new PopupMenu.PopupMenuItem(day, { reactive: false });
                    sep.actor.add_style_class_name("next-meeting-day-header");
                    section.menu.addMenuItem(sep);
                    lastDay = day;
                }
            }
            section.menu.addMenuItem(this._buildMeetingItem(m, conflictKeys));
        }
    }

    _buildMeetingItem(m, conflictKeys) {
        let item = new PopupMenu.PopupMenuItem("");
        let color = this._color(m.calendar_color);

        if (m.is_all_day) {
            let dotColor = m.status === "tentative" ? "#ffa726" : color;
            let line = "<span foreground=\"" + dotColor + "\">◼</span>  ";
            line += "<b>" + this._esc(_("All day")) + "</b>  ";
            line += this._esc(m.subject);
            if (m.end && m.end !== m.start) {
                let s = new Date(m.start + "T00:00:00");
                let e = new Date(m.end   + "T00:00:00");
                let opts = { day: "2-digit", month: "2-digit" };
                line += "  <small>" + this._esc("(" + s.toLocaleDateString(undefined, opts) + " → " + e.toLocaleDateString(undefined, opts) + ")") + "</small>";
            }
            if (m.status === "tentative") line += "  <small><i>" + this._esc(_("(tentative)")) + "</i></small>";
            if (m.location) line += "  <small>· " + this._esc(m.location) + "</small>";
            item.label.clutter_text.set_markup(line);
            return item;
        }

        let now     = Date.now();
        let startMs = new Date(m.start).getTime();
        let endMs   = m.end ? new Date(m.end).getTime() : startMs + 30 * 60 * 1000;
        let isLive  = startMs <= now && now < endMs;
        let hasConflict = conflictKeys && conflictKeys.has(this._mkey(m));

        let dot, dotColor;
        if (isLive)                        { dot = "◎"; dotColor = "#f44336"; }
        else if (m.status === "tentative") { dot = "?";      dotColor = "#ffa726"; }
        else                               { dot = "●"; dotColor = color;     }

        let line = "";
        if (hasConflict) line += "<span foreground=\"#ff7043\" font_weight=\"bold\">⚠ </span>";
        line += "<span foreground=\"" + dotColor + "\">" + dot + "</span>  ";
        line += "<b>" + this._esc(this._fmtTime(m.start)) + "</b>  ";
        line += this._esc(m.subject);
        if (isLive) line += "  <small><i>" + this._esc(_f("%d min ago", Math.round((now - startMs) / 60000))) + "</i></small>";
        if (m.status === "tentative") line += "  <small><i>" + this._esc(_("(tentative)")) + "</i></small>";
        if (m.location) line += "  <small>· " + this._esc(m.location) + "</small>";
        if (m.join_url) line += "  <small>🔗</small>";
        item.label.clutter_text.set_markup(line);
        if (m.join_url) item.connect("activate", () => Util.spawn(["xdg-open", m.join_url]));
        return item;
    }

    // ── Marquee (smooth pixel-based scrolling panel label) ──────────────────
    // The text is set ONCE per marquee run (duplicated for seamless loop)
    // and only the clutter_text translation moves at ~30fps. The parent
    // St.Label is clipped to its allocation so the duplicated text never
    // leaks past the panel slot, and gets a fixed min/max width so the
    // applet icon next to it stays put.
    _startMarquee() {
        if (this._marqueeTimer) return;
        if (!this._applet_label || !this._applet_label.clutter_text) return;

        let approxPx   = (this.labelMaxChars || 40) * 8;
        let pxPerFrame = Math.max(1, Math.round((this.marqueeSpeed || 4) / 2));

        this._applet_label.set_style(
            "min-width: " + approxPx + "px; max-width: " + approxPx + "px;"
        );
        this._applet_label.add_style_class_name("next-meeting-marquee");
        try { this._applet_label.set_clip_to_allocation(true); } catch (_e) { /* ignore */ }

        // Duplicate the text with spacer so the wrap is invisible.
        let padded = this._marqueeText + "    ";
        this._applet_label.clutter_text.set_text(padded + padded);

        // Measure one copy in pixels via Pango layout.
        try {
            let layout = this._applet_label.clutter_text.get_layout();
            let [fullW, _h] = layout.get_pixel_size();
            this._marqueeCopyWidth = Math.max(1, Math.round(fullW / 2));
        } catch (_e) {
            this._marqueeCopyWidth = padded.length * 8;
        }
        this._marqueePxOffset = 0;

        this._marqueeTimer = Mainloop.timeout_add(33, () => {
            this._tickMarqueePx(pxPerFrame);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMarquee() {
        if (this._marqueeTimer) {
            Mainloop.source_remove(this._marqueeTimer);
            this._marqueeTimer = 0;
        }
        if (this._applet_label) {
            if (this._applet_label.clutter_text) {
                try { this._applet_label.clutter_text.set_translation(0, 0, 0); }
                catch (_e) { /* ignore */ }
            }
            this._applet_label.set_style(null);
            this._applet_label.remove_style_class_name("next-meeting-marquee");
            try { this._applet_label.set_clip_to_allocation(false); }
            catch (_e) { /* ignore */ }
        }
        this._marqueeText      = "";
        this._marqueePxOffset  = 0;
        this._marqueeCopyWidth = 0;
    }

    _tickMarqueePx(step) {
        if (!this._marqueeText) { this._stopMarquee(); return; }
        if (!this._applet_label || !this._applet_label.clutter_text) return;
        this._marqueePxOffset = (this._marqueePxOffset + step) % this._marqueeCopyWidth;
        try {
            this._applet_label.clutter_text.set_translation(-this._marqueePxOffset, 0, 0);
        } catch (_e) { /* ignore */ }
    }
    // ────────────────────────────────────────────────────────────────────────

    _updateDisplay() {
        if (this._lastError) {
            this._stopMarquee();
            this.hide_applet_label(false);
            this.set_applet_label("⚠");
            return;
        }

        if (!this.showInPanel) {
            this._stopMarquee();
            this.hide_applet_label(true);
            this.set_applet_tooltip(_("No Display Mode - click the icon to see meetings"));
            return;
        }

        let m    = this._panelMeeting;
        let live = this._inProgress;

        if (!m) {
            this._stopMarquee();
            this.hide_applet_label(false);
            if (this.hiddenMode) {
                this.set_applet_label("—");
                this.set_applet_tooltip(_("No meetings in the next 7 days"));
            } else if (this._hasFutureMeetings) {
                // Today's meetings are done; next ones are on another day.
                this.set_applet_label("✓");
                this.set_applet_tooltip(_("No more meetings today"));
            } else {
                this.set_applet_label(_("No meetings"));
                this.set_applet_tooltip(_("No meetings in the next 7 days"));
            }
            return;
        }

        this.hide_applet_label(false);

        if (this.hiddenMode) {
            this._stopMarquee();
            let label, tooltip;
            if (live) {
                let mins = Math.round((Date.now() - new Date(live.start).getTime()) / 60000);
                label   = "◎ " + _f("in progress (%d min ago)", mins);
                tooltip = _("Hidden Mode - meeting in progress\nClick the icon to see details");
            } else {
                let cd = this._countdown(m.start);
                label   = "⏱ " + cd;
                tooltip = _f("Hidden Mode - next meeting %s\nClick the icon to see details", cd);
            }
            if (this._conflictKeys.has(this._mkey(live || m))) {
                label   = "⚠ " + label;
                tooltip = _("Time conflict!") + "\n" + tooltip;
            }
            let max = this.labelMaxChars || 40;
            if (label.length > max) label = label.slice(0, Math.max(1, max - 1)) + "…";
            this.set_applet_label(label);
            this.set_applet_tooltip(tooltip);
            return;
        }

        if (this.hideSubject) {
            this._stopMarquee();
            let label;
            if (live) {
                let mins = Math.round((Date.now() - new Date(live.start).getTime()) / 60000);
                let endStr = live.end ? this._fmtTime(live.end) : "?";
                label = "◎ " + _f("%d min ago", mins) + "  · " + endStr;
            } else {
                label = this._fmtTime(m.start) + "  " + this._countdown(m.start);
            }
            if (this._conflictKeys.has(this._mkey(live || m))) label = "⚠ " + label;
            let max = this.labelMaxChars || 40;
            if (label.length > max) label = label.slice(0, Math.max(1, max - 1)) + "…";
            this.set_applet_label(label);
            this.set_applet_tooltip(_("Subject hidden — click the icon to see details"));
            return;
        }

        // Build tooltip with full details + countdown
        let tooltip;
        if (live) {
            let mins = Math.round((Date.now() - new Date(live.start).getTime()) / 60000);
            tooltip = _f("IN PROGRESS: %s", live.subject) + "\n" +
                      this._fmtFull(live.start) + " - " + (live.end ? this._fmtTime(live.end) : "?") + "\n" +
                      _f("%d min ago", mins);
        } else {
            tooltip = (m.status === "tentative" ? _("[TENTATIVE]") + " " : "") + m.subject + "\n" +
                      this._fmtFull(m.start) + " - " + (m.end ? this._fmtTime(m.end) : "?") + "\n" +
                      this._countdown(m.start);
        }
        if (this._conflictKeys.has(this._mkey(live || m))) tooltip = _("TIME CONFLICT!") + "\n" + tooltip;
        this.set_applet_tooltip(tooltip);

        let conflictPfx = this._conflictKeys.has(this._mkey(live || m)) ? "⚠ " : "";

        // Static label for marquee: uses fixed end-time instead of countdown
        // so the scroll position doesn't reset every 30 seconds.
        let staticLabel;
        if (live) {
            let endStr = live.end ? this._fmtTime(live.end) : "?";
            staticLabel = conflictPfx + "◎ " + live.subject + "  (~" + endStr + ")";
        } else {
            let tentPfx = m.status === "tentative" ? "? " : "";
            staticLabel = conflictPfx + tentPfx + m.subject + "  " + this._fmtTime(m.start);
        }

        let max = this.labelMaxChars || 40;
        if (this.marqueeEnabled && staticLabel.length > max) {
            if (staticLabel !== this._marqueeText) {
                this._stopMarquee();
                this._marqueeText = staticLabel;
                this._startMarquee();
            } else if (!this._marqueeTimer) {
                this._startMarquee();
            }
            return; // marquee owns the panel label
        }

        // No marquee — dynamic label with countdown, respects timerPosition setting
        this._stopMarquee();
        let timerAtStart = this.timerPosition !== "end";
        let label;
        if (live) {
            let mins    = Math.round((Date.now() - new Date(live.start).getTime()) / 60000);
            let timeTag = "(" + _f("%d min ago", mins) + ")";
            label = timerAtStart
                ? conflictPfx + "◎ " + timeTag + "  " + live.subject
                : conflictPfx + "◎ " + live.subject + "  " + timeTag;
        } else {
            let tentPfx = m.status === "tentative" ? "? " : "";
            let timeTag = this._fmtTime(m.start);
            label = timerAtStart
                ? conflictPfx + tentPfx + timeTag + "  " + m.subject
                : conflictPfx + tentPfx + m.subject + "  " + timeTag;
        }

        if (label.length > max) label = label.slice(0, Math.max(1, max - 1)) + "…";
        this.set_applet_label(label);
    }

    // ── Notifications: D-Bus org.freedesktop.Notifications with action buttons ─
    _setupNotifications() {
        try {
            this._notifProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                "org.freedesktop.Notifications",
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
                null
            );
            this._notifSignalId = this._notifProxy.get_connection().signal_subscribe(
                "org.freedesktop.Notifications",
                "org.freedesktop.Notifications",
                "ActionInvoked",
                "/org/freedesktop/Notifications",
                null,
                Gio.DBusSignalFlags.NONE,
                (conn, sender, path, iface, signal, params) => {
                    let [notifId, actionId] = params.deep_unpack();
                    this._handleNotifAction(notifId, actionId);
                }
            );
        } catch (e) {
            global.logError("[" + UUID + "] D-Bus notify setup failed: " + e);
            this._notifProxy = null;
        }
    }

    _notify(title, body, urgency, actions, meetingKey) {
        let icon = urgency === "critical" ? "appointment-missed" : "x-office-calendar";
        if (this._notifProxy) {
            try {
                let hints = { "urgency": new GLib.Variant("y", urgency === "critical" ? 2 : 1) };
                let params = new GLib.Variant("(susssasa{sv}i)", [
                    "Next Meeting", 0, icon, title, body, actions || [], hints, -1
                ]);
                let res = this._notifProxy.call_sync("Notify", params, Gio.DBusCallFlags.NONE, -1, null);
                let id = res.deep_unpack()[0];
                if (meetingKey) this._pendingNotifs[id] = meetingKey;
                return;
            } catch (e) {
                global.logError("[" + UUID + "] D-Bus Notify failed: " + e);
            }
        }
        let urgencyArg = urgency === "critical" ? "--urgency=critical" : "--urgency=normal";
        Util.spawn(["notify-send", "--icon=" + icon, urgencyArg, "--app-name=Next Meeting", title, body]);
    }

    _handleNotifAction(notifId, actionId) {
        let key = this._pendingNotifs[notifId];
        if (!key) return;
        delete this._pendingNotifs[notifId];
        let mins = 0;
        if      (actionId === "snooze-5")  mins = 5;
        else if (actionId === "snooze-15") mins = 15;
        if (mins > 0) {
            this._snoozeUntil[key] = Date.now() + mins * 60 * 1000;
            this._notifiedIds.delete(key);
            global.log("[" + UUID + "] snoozed " + key + " for " + mins + " min");
        }
    }
    // ────────────────────────────────────────────────────────────────────────

    _checkUpcomingNotification() {
        if (!this.notifyEnabled || this._inProgress) return;
        let m = this._panelMeeting;
        if (!m) return;
        let key = this._mkey(m);
        if (this._notifiedIds.has(key)) return;
        if (Date.now() < (this._snoozeUntil[key] || 0)) return;
        let diff   = new Date(m.start).getTime() - Date.now();
        let window = (this.notifyBefore || 30) * 60 * 1000 + 60 * 1000;
        if (diff > 0 && diff <= window) {
            let mins  = Math.max(1, Math.round(diff / 60000));
            let title = _np("Meeting in %d minute", "Meeting in %d minutes", mins);
            let body  = (m.status === "tentative" ? _("[TENTATIVE]") + " " : "") + m.subject + "\n" + this._fmtFull(m.start);
            if (m.location) body += "\n" + m.location;
            let actions = [
                "snooze-5",  _("Snooze 5 min"),
                "snooze-15", _("Snooze 15 min"),
                "dismiss",   _("Dismiss"),
            ];
            this._notify(title, body, "normal", actions, key);
            this._notifiedIds.add(key);
        }
    }

    _checkConflictNotification() {
        if (!this.notifyConflicts || this._conflictKeys.size === 0) return;
        let now = Date.now();
        let upcoming = this._allMeetings.filter(m => {
            let s = new Date(m.start).getTime();
            return this._conflictKeys.has(this._mkey(m)) && s > now && s <= now + 60 * 60 * 1000;
        });
        if (upcoming.length < 2) return;
        let gKey = upcoming.slice(0, 4).map(m => m.start + m.subject).join("|");
        if (this._notifiedConflicts.has(gKey)) return;
        let title = "⚠ " + _f("Conflict: %d meetings at the same time", upcoming.length);
        let body  = upcoming.map(m => (m.status === "tentative" ? "? " : "● ") +
                                       m.subject + "  " + this._fmtTime(m.start)).join("\n");
        this._notify(title, body, "critical", null, null);
        this._notifiedConflicts.add(gKey);
    }

    on_applet_removed_from_panel() {
        if (this._refreshTimer) { Mainloop.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        if (this._notifyTimer)  { Mainloop.source_remove(this._notifyTimer);  this._notifyTimer  = 0; }
        this._stopMarquee();
        if (this._notifSignalId && this._notifProxy) {
            try { this._notifProxy.get_connection().signal_unsubscribe(this._notifSignalId); }
            catch (_e) { /* ignore */ }
            this._notifSignalId = 0;
        }
        if (this.settings) this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new NextMeetingApplet(metadata, orientation, panelHeight, instanceId);
}
