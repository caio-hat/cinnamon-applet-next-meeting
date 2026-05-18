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
        this._lastError         = null;
        this._suppressToggle    = false;
        this._refreshTimer      = 0;
        this._notifyTimer       = 0;
        this._marqueeTimer      = 0;
        this._marqueeOffset     = 0;
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

        this._migrateLegacyConfig();

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

        this._buildHelpSubmenu();

        let refresh = new PopupMenu.PopupMenuItem(_("Refresh now"));
        refresh.connect("activate", () => this._fetchMeetings());
        this._menu.addMenuItem(refresh);

        let configure = new PopupMenu.PopupMenuItem(_("Settings"));
        configure.connect("activate", () => this._openSettings());
        this._menu.addMenuItem(configure);
    }

    _buildHelpSubmenu() {
        let help = new PopupMenu.PopupSubMenuMenuItem(_("Help / Legend"));
        this._menu.addMenuItem(help);

        let line = (markup) => {
            let item = new PopupMenu.PopupMenuItem("", { reactive: false });
            item.label.clutter_text.set_line_wrap(true);
            item.label.clutter_text.set_markup(markup);
            help.menu.addMenuItem(item);
        };
        let header = (text) => line("<b>" + this._esc(text) + "</b>");
        let plain  = (text) => line(this._esc(text));

        header(_("Status icons"));
        line("<span foreground=\"#f44336\" font_weight=\"bold\">◎</span>  " + this._esc(_("Live meeting (in progress)")));
        line("<span foreground=\"#1e88e5\" font_weight=\"bold\">●</span>  " + this._esc(_("Accepted meeting (uses calendar color)")));
        line("<span foreground=\"#ffa726\" font_weight=\"bold\">?</span>  " + this._esc(_("Tentative / pending response")));
        line("<span foreground=\"#ff7043\" font_weight=\"bold\">⚠</span>  " + this._esc(_("Time conflict")));
        line("🔗  " + this._esc(_("Has join link — click the meeting to open in browser")));

        header(_("Panel indicators"));
        line("✓  " + this._esc(_("All today's meetings are done — next one is on another day")));
        line("⏱  " + this._esc(_("Hidden Mode — countdown only")));
        line("—  " + this._esc(_("Hidden Mode + no meetings in the next 7 days")));
        line("⚠  " + this._esc(_("Prefix on panel label marks an active time conflict")));

        header(_("Tips"));
        plain(_("Click the applet to open this menu."));
        plain(_("Right-click → Configure → add an ICS/iCal URL (Google, Outlook, Apple, Nextcloud...)."));
        plain(_("Hidden Mode shows only the countdown — useful for screen sharing or recording."));
        plain(_("Marquee scrolls long meeting names in the panel without moving the icon."));
        plain(_("Tentative meetings: use 'Show tentative meetings in panel' to control panel behavior."));
        plain(_("Notifications fire before a meeting starts (configurable in Settings → Advanced)."));

        header(_("About"));
        plain(_("Works with any RFC 5545 ICS/iCal feed."));
        line("<i>" + this._esc(_("github.com/caio-hat/cinnamon-applet-next-meeting")) + "</i>");
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
                let aS = new Date(a.start).getTime(), aE = a.end ? new Date(a.end).getTime() : aS + 30 * 60 * 1000;
                let bS = new Date(b.start).getTime(), bE = b.end ? new Date(b.end).getTime() : bS + 30 * 60 * 1000;
                if (aS < bE && bS < aE) { keys.add(this._mkey(a)); keys.add(this._mkey(b)); }
            }
        }
        return keys;
    }

    _renderMenu() {
        let now  = Date.now();
        let h24  = now + 24 * 3600 * 1000;
        let h72  = now + 3 * 24 * 3600 * 1000;
        let h168 = now + 7 * 24 * 3600 * 1000;

        this._inProgress = null;
        let future = [];
        for (let m of this._allMeetings) {
            let s = new Date(m.start).getTime();
            let e = m.end ? new Date(m.end).getTime() : s + 30 * 60 * 1000;
            if (e <= now) continue;
            if (s <= now && now < e) { if (!this._inProgress) this._inProgress = m; }
            else if (s <= h168)      { future.push(m); }
        }

        this._nextMeeting = this._inProgress || (future.length > 0 ? future[0] : null);

        // Panel only shows today's meetings — never shows next-day meetings.
        // When today's meetings are done, _panelMeeting = null → panel shows ✓.
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

        this._sub24.label.set_text(_("Next 24 hours") + " (" + b24.length + ")");
        this._sub3d.label.set_text(_("Next 3 days")   + " (" + b3d.length + ")");
        this._sub7d.label.set_text(_("Next 7 days")   + " (" + b7d.length + ")");

        this._fillSection(this._sub24, b24, false, this._conflictKeys);
        this._fillSection(this._sub3d, b3d, true,  this._conflictKeys);
        this._fillSection(this._sub7d, b7d, true,  this._conflictKeys);
    }

    _updateNextItem() {
        if (this._lastError) return;
        let m = this._nextMeeting;
        if (!m) { this._nextItem.label.set_text(_("No meetings in the next 7 days")); return; }

        let now     = Date.now();
        let startMs = new Date(m.start).getTime();
        let isLive  = !!(this._inProgress && this._inProgress.start === m.start);
        let color   = this._color(m.calendar_color);
        let isConflict = this._conflictKeys.has(this._mkey(m));

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
        let now     = Date.now();
        let startMs = new Date(m.start).getTime();
        let endMs   = m.end ? new Date(m.end).getTime() : startMs + 30 * 60 * 1000;
        let isLive  = startMs <= now && now < endMs;
        let hasConflict = conflictKeys && conflictKeys.has(this._mkey(m));

        let color = this._color(m.calendar_color);
        let dot, dotColor;
        if (isLive)                        { dot = "◎"; dotColor = "#f44336"; }
        else if (m.status === "tentative") { dot = "?";      dotColor = "#ffa726"; }
        else                               { dot = "●"; dotColor = color;     }

        let item = new PopupMenu.PopupMenuItem("");
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

    // ── Marquee (scrolling panel label) ─────────────────────────────────────
    // Uses a stable label (no countdown) so the scroll doesn't reset every 30s.
    // Locks panel-label min-width + monospace font while active so the icon
    // doesn't shift as the proportional-width text scrolls.
    _startMarquee() {
        if (this._marqueeTimer) return;
        let speedMs = Math.max(80, (this.marqueeSpeed || 2) * 100);
        if (this._applet_label) {
            let approxPx = (this.labelMaxChars || 40) * 8;
            this._applet_label.set_style("min-width: " + approxPx + "px; font-family: monospace;");
            this._applet_label.add_style_class_name("next-meeting-marquee");
        }
        this._marqueeTimer = Mainloop.timeout_add(speedMs, () => {
            this._tickMarquee();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopMarquee() {
        if (this._marqueeTimer) {
            Mainloop.source_remove(this._marqueeTimer);
            this._marqueeTimer = 0;
        }
        if (this._applet_label) {
            this._applet_label.set_style(null);
            this._applet_label.remove_style_class_name("next-meeting-marquee");
        }
        this._marqueeText   = "";
        this._marqueeOffset = 0;
    }

    _tickMarquee() {
        if (!this._marqueeText) { this._stopMarquee(); return; }
        let max    = this.labelMaxChars || 40;
        let padded = this._marqueeText + "   ";
        let slice  = (padded + this._marqueeText).slice(this._marqueeOffset, this._marqueeOffset + max);
        this.set_applet_label(slice);
        this._marqueeOffset = (this._marqueeOffset + 1) % padded.length;
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
                this._marqueeText   = staticLabel;
                this._marqueeOffset = 0;
            }
            if (!this._marqueeTimer) this._startMarquee();
            return; // marquee tick calls set_applet_label
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

    _checkUpcomingNotification() {
        if (!this.notifyEnabled || this._inProgress) return;
        let m = this._panelMeeting;
        if (!m) return;
        let key = this._mkey(m);
        if (this._notifiedIds.has(key)) return;
        let diff   = new Date(m.start).getTime() - Date.now();
        let window = (this.notifyBefore || 30) * 60 * 1000 + 60 * 1000;
        if (diff > 0 && diff <= window) {
            let mins  = Math.max(1, Math.round(diff / 60000));
            let title = _np("Meeting in %d minute", "Meeting in %d minutes", mins);
            let body  = (m.status === "tentative" ? _("[TENTATIVE]") + " " : "") + m.subject + "\n" + this._fmtFull(m.start);
            if (m.location) body += "\n" + m.location;
            Util.spawn(["notify-send", "--icon=x-office-calendar", "--urgency=normal",
                        "--app-name=Next Meeting", title, body]);
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
        Util.spawn(["notify-send", "--icon=appointment-missed", "--urgency=critical",
                    "--app-name=Next Meeting", title, body]);
        this._notifiedConflicts.add(gKey);
    }

    on_applet_removed_from_panel() {
        if (this._refreshTimer) { Mainloop.source_remove(this._refreshTimer); this._refreshTimer = 0; }
        if (this._notifyTimer)  { Mainloop.source_remove(this._notifyTimer);  this._notifyTimer  = 0; }
        this._stopMarquee();
        if (this.settings) this.settings.finalize();
    }
}

function main(metadata, orientation, panelHeight, instanceId) {
    return new NextMeetingApplet(metadata, orientation, panelHeight, instanceId);
}
