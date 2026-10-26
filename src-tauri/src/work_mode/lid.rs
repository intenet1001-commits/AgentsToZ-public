//! Closed-lid work (Mac only). Assertions cannot outlast the lid switch; only the undocumented, system-wide
//! `pmset disablesleep` can, and unlike an assertion it survives a crash and a reboot. So the app owns it
//! through a marker file whose mtime is a heartbeat, a per-user LaunchAgent restores normal sleep when the
//! owner dies or goes quiet, and the app only ever turns off what it turned on (the marker says so).
//! Root comes from a one-time sudoers grant for exactly `pmset -a disablesleep 0` and `1`.
#[cfg(target_os = "macos")]
use std::{path::{Path, PathBuf}, process::{Command, Stdio}};

/** The guard restores once the heartbeat is this old; the worker rewrites the marker every `HEARTBEAT`. */
pub(super) const STALE_SECS: u64 = 90;
pub(super) const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(15);
#[cfg(target_os = "macos")]
const SUDOERS: &str = "/private/etc/sudoers.d/agentstoz-lid-awake";
#[cfg(target_os = "macos")]
const GUARD_LABEL: &str = "com.intenet.agentstozbycs.lid-awake-guard";
#[cfg(target_os = "macos")]
const BUNDLE_ID: &str = "com.intenet.agentstozbycs";

/// The machine side of closed-lid work, so the worker's rules can be tested without root or a lid.
pub(crate) trait Host: Send + Sync {
    fn supported(&self) -> bool;
    /** The sudoers grant lets this user run both pmset commands without a password. */
    fn granted(&self) -> bool;
    /** Running on the battery with little left: the one power reason to let the Mac sleep again. */
    fn battery_low(&self) -> bool;
    /** Thermal pressure is heavy or worse (`ProcessInfo.thermalState` serious/critical). */
    fn hot(&self) -> bool;
    /** `SleepDisabled` is currently on, whoever set it. */
    fn disabled(&self) -> Result<bool, String>;
    /** Marker first, then the switch, then a read-back: a crash in between still leaves the guard a marker. */
    fn hold(&self) -> Result<(), String>;
    fn beat(&self);
    /** Switch off, drop the marker, and sleep now if the lid is shut where Apple would have slept anyway. */
    fn release(&self) -> Result<(), String>;
    /** A marker left by an earlier app run means that run turned the switch on: restore it. */
    fn recover(&self) -> Result<(), String>;
    fn grant(&self, prompt: &str) -> Result<(), String>;
    fn revoke(&self, prompt: &str) -> Result<(), String>;
}

/// `pmset -g` lists `SleepDisabled 1` under the system-wide settings only while the switch is on.
pub(super) fn parse_sleep_disabled(pmset: &str) -> bool {
    pmset.lines().any(|line| { let mut words = line.split_whitespace(); words.next() == Some("SleepDisabled") && words.next() == Some("1") })
}
/** Below this, closed-lid work lets go so macOS can still sleep by itself instead of cutting out at 0%. */
pub(super) const LOW_BATTERY_PERCENT: u8 = 5;
/// `pmset -g batt` names the live source, then one line per battery ("\t73%; discharging; 4:33 remaining").
/// Only a Mac actually drawing from its battery can run out, so AC - and a desktop with none - is None.
pub(super) fn parse_battery_percent(pmset: &str) -> Option<u8> {
    if !pmset.contains("'Battery Power'") { return None; }
    pmset.split_whitespace().find_map(|word| word.strip_suffix("%;").and_then(|percent| percent.parse().ok()))
}
/// The lid is shut and Apple's clamshell policy (no external display on power) would sleep for it.
pub(super) fn parse_lid_sleeps(ioreg: &str) -> bool {
    ioreg.contains("\"AppleClamshellState\" = Yes") && ioreg.contains("\"AppleClamshellCausesSleep\" = Yes")
}
/// A macOS short name the rule can carry verbatim; anything else is refused rather than escaped.
pub(super) fn valid_user(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64 && name != "ALL" && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}
/// Exactly two commands with literal arguments: sudoers matches arguments verbatim, so the grant cannot widen.
pub(super) fn sudoers_rule(user: &str) -> String {
    format!("{user} ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1")
}
/// Runs as root. The rule is written by root into a dotted temp name (sudo ignores names with a dot), checked by
/// visudo and only then renamed into place, so no user-writable file is ever read with root rights.
#[cfg(target_os = "macos")]
fn install_script(user: &str) -> String {
    format!("umask 077; t=$(/usr/bin/mktemp /private/etc/sudoers.d/.agentstoz-lid-awake.XXXXXX) || exit 1; \
/usr/bin/printf '%s\\n' '{}' > \"$t\" && /usr/sbin/visudo -cqf \"$t\" && /usr/sbin/chown root:wheel \"$t\" && /bin/chmod 0440 \"$t\" \
&& /bin/mv -f \"$t\" {SUDOERS} || {{ /bin/rm -f \"$t\"; exit 1; }}", sudoers_rule(user))
}
/// Run by launchd at login and every 30 seconds. Exits at once without a marker; otherwise restores when the
/// owner pid is gone or its heartbeat is older than `STALE_SECS` (a frozen worker also freezes its guards).
pub(super) fn guard_script() -> String {
    format!(r#"m="$1"; [ -f "$m" ] || exit 0
p=$(/usr/bin/head -n 1 "$m" 2>/dev/null); case "$p" in ''|*[!0-9]*) p=0;; esac
t=$(/usr/bin/stat -f %m "$m" 2>/dev/null) || t=0; age=$(( $(/bin/date +%s) - t ))
if [ "$p" -gt 0 ] && /bin/kill -0 "$p" 2>/dev/null && [ "$age" -lt {STALE_SECS} ]; then exit 0; fi
/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 >/dev/null || exit 1
/bin/rm -f "$m"
s=$(/usr/sbin/ioreg -r -k AppleClamshellState -d 1)
case "$s" in *'"AppleClamshellState" = Yes'*) case "$s" in *'"AppleClamshellCausesSleep" = Yes'*) /usr/bin/pmset sleepnow >/dev/null;; esac;; esac
exit 0"#)
}
/// `do shell script … with administrator privileges` shows macOS's own password sheet; the app never sees it.
#[cfg(target_os = "macos")]
fn admin_source(script: &str, prompt: &str) -> String {
    let prompt: String = prompt.chars().filter(|c| !c.is_control()).take(300).collect();
    format!("do shell script {} with administrator privileges with prompt {}", applescript_text(script), applescript_text(&prompt))
}
#[cfg(target_os = "macos")]
fn applescript_text(text: &str) -> String { format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\"")) }
#[cfg(target_os = "macos")]
fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}
#[cfg(target_os = "macos")]
fn guard_plist(marker: &Path) -> String {
    format!(r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>{GUARD_LABEL}</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>{}</string><string>agentstoz-lid-guard</string><string>{}</string></array>
<key>RunAtLoad</key><true/>
<key>StartInterval</key><integer>30</integer>
<key>ProcessType</key><string>Background</string>
<key>AssociatedBundleIdentifiers</key><array><string>{BUNDLE_ID}</string></array>
</dict></plist>
"#, xml(&guard_script()), xml(&marker.to_string_lossy()))
}

#[cfg(target_os = "macos")]
mod ffi {
    use std::ffi::c_char;
    extern "C" {
        pub fn notify_register_check(name: *const c_char, token: *mut i32) -> u32;
        pub fn notify_get_state(token: i32, state: *mut u64) -> u32;
        pub fn notify_cancel(token: i32) -> u32;
    }
}

#[cfg(target_os = "macos")]
pub(crate) struct Native { marker: PathBuf }
#[cfg(target_os = "macos")]
impl Native {
    pub(crate) fn new(marker: PathBuf) -> Self { Self { marker } }
    fn run(program: &str, args: &[&str]) -> Result<std::process::Output, String> {
        Command::new(program).args(args).stdin(Stdio::null()).output().map_err(|e| format!("{program}: {e}"))
    }
    fn pmset(on: bool) -> Result<(), String> {
        let out = Self::run("/usr/bin/sudo", &["-n", "/usr/bin/pmset", "-a", "disablesleep", if on { "1" } else { "0" }])?;
        if out.status.success() { Ok(()) } else { Err(format!("sudo pmset 실패: {}", String::from_utf8_lossy(&out.stderr).trim())) }
    }
    fn user() -> Result<String, String> {
        // SAFETY: getpwuid returns a pointer into static storage or null; the name is copied out immediately.
        let name = unsafe {
            let entry = libc::getpwuid(libc::getuid());
            if entry.is_null() || (*entry).pw_name.is_null() { return Err("현재 사용자 이름을 찾지 못했습니다.".into()); }
            std::ffi::CStr::from_ptr((*entry).pw_name).to_string_lossy().into_owned()
        };
        if valid_user(&name) { Ok(name) } else { Err(format!("이 사용자 이름({name})은 허용 규칙에 쓸 수 없습니다.")) }
    }
    fn as_admin(script: &str, prompt: &str) -> Result<(), String> {
        let out = Self::run("/usr/bin/osascript", &["-e", &admin_source(script, prompt)])?;
        let error = String::from_utf8_lossy(&out.stderr);
        if out.status.success() { Ok(()) }
        else if error.contains("-128") { Err("허용을 취소했어요.".into()) }
        else { Err(format!("관리자 권한 작업 실패: {}", error.trim())) }
    }
    fn uid() -> String { unsafe { libc::getuid() }.to_string() }
    fn guard_path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").ok_or("HOME을 찾지 못했습니다.")?;
        Ok(PathBuf::from(home).join("Library/LaunchAgents").join(format!("{GUARD_LABEL}.plist")))
    }
    fn ensure_guard(&self) -> Result<(), String> {
        let path = Self::guard_path()?; let plist = guard_plist(&self.marker);
        let target = format!("gui/{}/{GUARD_LABEL}", Self::uid());
        let current = std::fs::read_to_string(&path).ok().as_deref() == Some(plist.as_str());
        if current && Self::run("/bin/launchctl", &["print", &target]).is_ok_and(|o| o.status.success()) { return Ok(()); }
        if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| format!("LaunchAgents 폴더: {e}"))?; }
        let temp = path.with_extension("plist.tmp");
        std::fs::write(&temp, &plist).and_then(|_| std::fs::rename(&temp, &path)).map_err(|e| format!("감시 항목 저장 실패: {e}"))?;
        let _ = Self::run("/bin/launchctl", &["bootout", &target]);
        let out = Self::run("/bin/launchctl", &["bootstrap", &format!("gui/{}", Self::uid()), &path.to_string_lossy()])?;
        if out.status.success() { Ok(()) } else { Err(format!("감시 항목을 켜지 못했습니다: {}", String::from_utf8_lossy(&out.stderr).trim())) }
    }
    fn remove_guard() -> Result<(), String> {
        let _ = Self::run("/bin/launchctl", &["bootout", &format!("gui/{}/{GUARD_LABEL}", Self::uid())]);
        match std::fs::remove_file(Self::guard_path()?) { Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(format!("감시 항목 삭제 실패: {e}")), _ => Ok(()) }
    }
    fn write_marker(&self) -> std::io::Result<()> {
        if let Some(dir) = self.marker.parent() { std::fs::create_dir_all(dir)?; }
        std::fs::write(&self.marker, format!("{}\n", std::process::id()))
    }
}
#[cfg(target_os = "macos")]
impl Host for Native {
    fn supported(&self) -> bool { true }
    fn granted(&self) -> bool {
        ["1", "0"].into_iter().all(|value| Self::run("/usr/bin/sudo", &["-n", "-l", "/usr/bin/pmset", "-a", "disablesleep", value]).is_ok_and(|o| o.status.success()))
    }
    /** A reading we cannot take never releases a held switch: heat and the guard still cover that Mac. */
    fn battery_low(&self) -> bool {
        Self::run("/usr/bin/pmset", &["-g", "batt"]).is_ok_and(|out| out.status.success()
            && parse_battery_percent(&String::from_utf8_lossy(&out.stdout)).is_some_and(|percent| percent <= LOW_BATTERY_PERCENT))
    }
    fn hot(&self) -> bool {
        let (mut token, mut level) = (0i32, 0u64);
        unsafe {
            if ffi::notify_register_check(c"com.apple.system.thermalpressurelevel".as_ptr(), &mut token) != 0 { return false; }
            let read = ffi::notify_get_state(token, &mut level); ffi::notify_cancel(token);
            read == 0 && level >= 2
        }
    }
    fn disabled(&self) -> Result<bool, String> {
        let out = Self::run("/usr/bin/pmset", &["-g"])?;
        if out.status.success() { Ok(parse_sleep_disabled(&String::from_utf8_lossy(&out.stdout))) } else { Err("pmset -g 실패".into()) }
    }
    fn hold(&self) -> Result<(), String> {
        self.ensure_guard()?;
        self.write_marker().map_err(|e| format!("근무 표식 저장 실패: {e}"))?;
        if let Err(error) = Self::pmset(true) { let _ = std::fs::remove_file(&self.marker); return Err(error); }
        if self.disabled()? { Ok(()) } else { let _ = self.release(); Err("macOS가 덮개 닫힘 근무를 받아들이지 않았어요.".into()) }
    }
    fn beat(&self) { let _ = self.write_marker(); }
    fn release(&self) -> Result<(), String> {
        Self::pmset(false)?;
        let _ = std::fs::remove_file(&self.marker);
        if Self::run("/usr/sbin/ioreg", &["-r", "-k", "AppleClamshellState", "-d", "1"]).is_ok_and(|o| parse_lid_sleeps(&String::from_utf8_lossy(&o.stdout))) {
            let _ = Self::run("/usr/bin/pmset", &["sleepnow"]);
        }
        Ok(())
    }
    fn recover(&self) -> Result<(), String> { if self.marker.exists() { self.release() } else { Ok(()) } }
    fn grant(&self, prompt: &str) -> Result<(), String> {
        Self::as_admin(&install_script(&Self::user()?), prompt)?;
        self.ensure_guard()?;
        if self.granted() { Ok(()) } else { Err("규칙을 설치했지만 sudo가 읽지 않습니다 (/etc/sudoers의 includedir 확인).".into()) }
    }
    fn revoke(&self, prompt: &str) -> Result<(), String> {
        self.recover()?;
        Self::as_admin(&format!("/bin/rm -f {SUDOERS}"), prompt)?;
        Self::remove_guard()
    }
}

#[cfg(not(target_os = "macos"))]
pub(crate) struct Native;
#[cfg(not(target_os = "macos"))]
impl Native { pub(crate) fn new(_marker: std::path::PathBuf) -> Self { Self } }
#[cfg(not(target_os = "macos"))]
impl Host for Native {
    fn supported(&self) -> bool { false }
    fn granted(&self) -> bool { false }
    fn battery_low(&self) -> bool { false }
    fn hot(&self) -> bool { false }
    fn disabled(&self) -> Result<bool, String> { Ok(false) }
    fn hold(&self) -> Result<(), String> { Err("덮개 닫힘 근무는 Mac에서만 지원합니다.".into()) }
    fn beat(&self) {}
    fn release(&self) -> Result<(), String> { Ok(()) }
    fn recover(&self) -> Result<(), String> { Ok(()) }
    fn grant(&self, _: &str) -> Result<(), String> { Err("덮개 닫힘 근무는 Mac에서만 지원합니다.".into()) }
    fn revoke(&self, _: &str) -> Result<(), String> { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_switch_lid_and_user() {
        let off = "System-wide power settings:\nCurrently in use:\n standby              1\n sleep                1\n";
        assert!(!parse_sleep_disabled(off));
        assert!(parse_sleep_disabled("System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n sleep 1\n"));
        assert!(!parse_sleep_disabled(" SleepDisabled\t\t0\n"));
        assert!(parse_lid_sleeps("  |   \"AppleClamshellCausesSleep\" = Yes\n  |   \"AppleClamshellState\" = Yes\n"));
        assert!(!parse_lid_sleeps("  |   \"AppleClamshellCausesSleep\" = No\n  |   \"AppleClamshellState\" = Yes\n"), "external display on power: Apple keeps it awake");
        assert!(!parse_lid_sleeps("  |   \"AppleClamshellCausesSleep\" = Yes\n  |   \"AppleClamshellState\" = No\n"));
        for name in ["gwanli", "_svc", "a.b-c_1"] { assert!(valid_user(name), "{name}"); }
        for name in ["", "1abc", "-x", "a b", "a'b", "a,b", "ALL", "a\\b", "a".repeat(65).as_str()] { assert!(!valid_user(name), "{name}"); }
        assert_eq!(sudoers_rule("gwanli"), "gwanli ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1");
    }
    /// The guard's decisions, with the privileged and lid commands swapped for a log so the test never touches power.
    #[cfg(unix)]
    #[test]
    fn guard_restores_only_for_a_dead_or_silent_owner() {
        let dir = std::env::temp_dir().join(format!("lid-guard-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        std::fs::create_dir_all(&dir).unwrap();
        let (marker, log) = (dir.join("owner"), dir.join("log"));
        let script = guard_script()
            .replace("/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0 >/dev/null", &format!("echo restore >> '{}'", log.display()))
            .replace("/usr/sbin/ioreg -r -k AppleClamshellState -d 1", "echo '\"AppleClamshellState\" = Yes \"AppleClamshellCausesSleep\" = Yes'")
            .replace("/usr/bin/pmset sleepnow >/dev/null", &format!("echo sleep >> '{}'", log.display()));
        assert!(!script.contains("sudo") && !script.contains("pmset"), "test script must not reach real power commands");
        let run = || std::process::Command::new("/bin/sh").arg("-c").arg(&script).arg("guard").arg(&marker).status().unwrap();
        let logged = || std::fs::read_to_string(&log).unwrap_or_default();
        assert!(run().success()); assert_eq!(logged(), "", "no marker: nothing to restore");
        std::fs::write(&marker, format!("{}\n", std::process::id())).unwrap();
        assert!(run().success()); assert_eq!(logged(), "", "live owner with a fresh heartbeat is left alone");
        std::fs::write(&marker, "999999\n").unwrap();
        assert!(run().success()); assert_eq!(logged(), "restore\nsleep\n", "dead owner: restore, then sleep for the shut lid");
        assert!(!marker.exists());
        std::fs::write(&marker, format!("{}\n", std::process::id())).unwrap();
        assert!(std::process::Command::new("/usr/bin/touch").args(["-t", "202001010000"]).arg(&marker).status().unwrap().success());
        assert!(run().success()); assert_eq!(logged(), "restore\nsleep\nrestore\nsleep\n", "silent owner past the heartbeat bound: restore");
        std::fs::write(&marker, "not-a-pid\n").unwrap();
        assert!(run().success()); assert!(!marker.exists(), "an unreadable marker counts as a dead owner");
        let _ = std::fs::remove_dir_all(dir);
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn plist_and_install_script_keep_the_grant_exact() {
        let plist = guard_plist(Path::new("/Users/x/Library/Application Support/app/lid.owner"));
        assert!(plist.contains("<string>/Users/x/Library/Application Support/app/lid.owner</string>"));
        assert!(plist.contains("<key>StartInterval</key><integer>30</integer>") && plist.contains("<key>RunAtLoad</key><true/>"));
        assert!(!plist.contains("2>/dev") && plist.contains("2&gt;/dev"), "script is XML-escaped");
        let install = install_script("gwanli");
        assert!(install.contains("'gwanli ALL=(root) NOPASSWD: /usr/bin/pmset -a disablesleep 0, /usr/bin/pmset -a disablesleep 1'"));
        assert!(install.contains("/usr/sbin/visudo -cqf") && install.contains("/private/etc/sudoers.d/.agentstoz-lid-awake.XXXXXX"));
        assert!(install.find("visudo").unwrap() < install.find("/bin/mv").unwrap(), "only a checked rule is moved into place");
    }
    /// The real validators parse what the grant and the guard install; none of them needs root or runs it.
    #[cfg(target_os = "macos")]
    #[test]
    fn macos_tools_accept_the_rule_plist_and_scripts() {
        let dir = std::env::temp_dir().join(format!("lid-tools-{}", std::process::id())); std::fs::create_dir_all(&dir).unwrap();
        let ok = |program: &str, args: &[&str]| std::process::Command::new(program).args(args).output().map(|o| (o.status.success(), String::from_utf8_lossy(&o.stderr).into_owned())).unwrap();
        let rule = dir.join("rule"); std::fs::write(&rule, sudoers_rule("gwanli") + "\n").unwrap();
        assert_eq!(ok("/usr/sbin/visudo", &["-cqf", &rule.to_string_lossy()]).0, true, "sudoers rule parses");
        let plist = dir.join("guard.plist"); std::fs::write(&plist, guard_plist(Path::new("/Users/x/Library/Application Support/a & b/lid.owner"))).unwrap();
        assert_eq!(ok("/usr/bin/plutil", &["-lint", &plist.to_string_lossy()]).0, true, "guard plist is valid");
        for script in [install_script("gwanli"), guard_script()] { let (valid, error) = ok("/bin/sh", &["-n", "-c", &script]); assert!(valid, "{error}"); }
        let compiled = dir.join("admin.scpt");
        let source = admin_source(&install_script("gwanli"), "AgentsToZ \"따옴표\" \\ 경로\u{7}");
        let (valid, error) = ok("/usr/bin/osacompile", &["-o", &compiled.to_string_lossy(), "-e", &source]); assert!(valid, "{error}");
        // AppleScript hands the shell exactly the script we built (backslashes and quotes included).
        let echoed = std::process::Command::new("/usr/bin/osascript").arg("-e").arg(format!("return {}", applescript_text(&install_script("gwanli")))).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&echoed.stdout).trim_end_matches('\n'), install_script("gwanli"));
        let _ = std::fs::remove_dir_all(dir);
    }
    #[test]
    fn reads_the_charge_only_while_the_battery_is_the_source() {
        let flat = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t4%; discharging; 0:21 remaining present: true\n";
        let full = "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t73%; discharging; 4:33 remaining present: true\n";
        assert_eq!(parse_battery_percent(flat), Some(4));
        assert_eq!(parse_battery_percent(full), Some(73));
        assert_eq!(parse_battery_percent("Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t4%; charging; 0:21 remaining present: true\n"), None);
        assert_eq!(parse_battery_percent("Now drawing from 'AC Power'\n"), None, "a desktop never runs out");
        assert!(parse_battery_percent(flat).is_some_and(|percent| percent <= LOW_BATTERY_PERCENT));
        assert!(!parse_battery_percent(full).is_some_and(|percent| percent <= LOW_BATTERY_PERCENT), "a charged battery keeps working");
    }
    /// Read-only probes on the real Mac: never changes the switch.
    #[cfg(target_os = "macos")]
    #[test]
    fn native_probes_read_without_side_effects() {
        let host = Native::new(std::env::temp_dir().join("agentstoz-lid-probe-never-written"));
        let _ = (host.battery_low(), host.hot());
        assert!(host.disabled().is_ok());
        assert!(host.recover().is_ok(), "no marker: recover must not run sudo");
    }
}
