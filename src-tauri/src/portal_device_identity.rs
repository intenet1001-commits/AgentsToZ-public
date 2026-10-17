//! portal.json device identity guard — the Rust half of `src/portalDeviceIdentityRecord.ts`.
//!
//! A whole-file portal.json write that omits `deviceId` used to erase this installation's
//! identity, and the app then minted a new UUID with no aliases (2026-09-27: remote control
//! showed 2 of 139 projects and could not find OPS). Both implementations follow
//! `tests/fixtures/portal-device-identity-golden.json`.

use std::path::Path;

pub const RECORD_FILE_NAME: &str = "portal-device-identity.json";

fn valid_id(value: Option<&serde_json::Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    let bytes = trimmed.as_bytes();
    let groups = [8usize, 4, 4, 4, 12];
    if bytes.len() != 36 {
        return None;
    }
    let mut offset = 0;
    for (index, length) in groups.iter().enumerate() {
        if !bytes[offset..offset + length].iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        offset += length;
        if index < groups.len() - 1 {
            if bytes[offset] != b'-' {
                return None;
            }
            offset += 1;
        }
    }
    Some(trimmed.to_string())
}

fn valid_name(value: Option<&serde_json::Value>) -> Option<String> {
    let trimmed = value?.as_str()?.trim();
    (!trimmed.is_empty() && trimmed.chars().count() <= 200).then(|| trimmed.to_string())
}

fn record_value(device_id: &str, device_name: Option<&str>) -> serde_json::Value {
    let mut record = serde_json::Map::new();
    record.insert("deviceId".into(), serde_json::Value::String(device_id.to_string()));
    if let Some(name) = device_name {
        record.insert("deviceName".into(), serde_json::Value::String(name.to_string()));
    }
    serde_json::Value::Object(record)
}

/// Normalized record, or None when it carries no valid id.
pub fn read_record(value: Option<&serde_json::Value>) -> Option<serde_json::Value> {
    let object = value?.as_object()?;
    let device_id = valid_id(object.get("deviceId"))?;
    Some(record_value(&device_id, valid_name(object.get("deviceName")).as_deref()))
}

pub struct Applied {
    pub portal: serde_json::Value,
    pub record: Option<serde_json::Value>,
    pub restored: bool,
}

pub fn apply(
    incoming: &serde_json::Value,
    current: Option<&serde_json::Value>,
    record: Option<&serde_json::Value>,
) -> Applied {
    let record = read_record(record);
    let empty = serde_json::Map::new();
    let incoming_object = incoming.as_object().unwrap_or(&empty);
    let current_object = current.and_then(|value| value.as_object()).unwrap_or(&empty);
    let incoming_id = valid_id(incoming_object.get("deviceId"));
    let current_id = valid_id(current_object.get("deviceId"));
    let record_id = record.as_ref().and_then(|value| valid_id(value.get("deviceId")));
    let Some(device_id) = incoming_id.clone().or(current_id.clone()).or(record_id.clone()) else {
        return Applied { portal: incoming.clone(), record, restored: false };
    };
    let name_for = |id: &Option<String>, name: Option<&serde_json::Value>| {
        if id.as_deref() == Some(device_id.as_str()) { valid_name(name) } else { None }
    };
    let device_name = valid_name(incoming_object.get("deviceName"))
        .or_else(|| name_for(&current_id, current_object.get("deviceName")))
        .or_else(|| name_for(&record_id, record.as_ref().and_then(|value| value.get("deviceName"))));
    let mut portal = incoming_object.clone();
    portal.insert("deviceId".into(), serde_json::Value::String(device_id.clone()));
    if let Some(name) = &device_name {
        portal.insert("deviceName".into(), serde_json::Value::String(name.clone()));
    }
    Applied {
        portal: serde_json::Value::Object(portal),
        record: Some(record_value(&device_id, device_name.as_deref())),
        restored: incoming_id.is_none(),
    }
}

/// Reads the record next to portal.json; a damaged record never blocks portal access.
pub fn read_record_file(app_data_dir: &Path) -> Option<serde_json::Value> {
    let content = std::fs::read_to_string(app_data_dir.join(RECORD_FILE_NAME)).ok()?;
    read_record(serde_json::from_str(&content).ok().as_ref())
}

/// Writes the record (0600) only when it changed. Failure is logged, never fatal: the
/// portal save it protects has already succeeded.
pub fn persist_record(app_data_dir: &Path, previous: Option<&serde_json::Value>, next: Option<&serde_json::Value>) {
    let Some(next) = next else { return };
    if previous == Some(next) {
        return;
    }
    let path = app_data_dir.join(RECORD_FILE_NAME);
    let temporary = app_data_dir.join(format!(".{}.{}.tmp", RECORD_FILE_NAME, std::process::id()));
    let result = (|| -> std::io::Result<()> {
        let content = serde_json::to_string_pretty(next).map_err(std::io::Error::other)?;
        #[cfg(unix)]
        {
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut file = std::fs::OpenOptions::new()
                .write(true).create(true).truncate(true).mode(0o600)
                .open(&temporary)?;
            file.write_all(content.as_bytes())?;
        }
        #[cfg(not(unix))]
        std::fs::write(&temporary, content)?;
        #[cfg(target_os = "windows")]
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(&temporary, &path)
    })();
    if let Err(error) = result {
        let _ = std::fs::remove_file(&temporary);
        eprintln!("[Portal] 기기 신원 기록을 저장하지 못했습니다: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn follows_shared_golden_table() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../tests/fixtures/portal-device-identity-golden.json"
        ))
        .unwrap();
        for case in golden["cases"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            let current = (!case["current"].is_null()).then(|| &case["current"]);
            let record = (!case["record"].is_null()).then(|| &case["record"]);
            let applied = apply(&case["incoming"], current, record);
            let expect = &case["expect"];
            assert_eq!(applied.portal.get("deviceId").cloned().unwrap_or(serde_json::Value::Null), expect["deviceId"], "{name}: deviceId");
            assert_eq!(applied.portal.get("deviceName").cloned().unwrap_or(serde_json::Value::Null), expect["deviceName"], "{name}: deviceName");
            assert_eq!(applied.restored, expect["restored"].as_bool().unwrap(), "{name}: restored");
            assert_eq!(applied.record.unwrap_or(serde_json::Value::Null), expect["record"], "{name}: record");
        }
    }

    #[test]
    fn record_is_written_owner_only_and_read_back() {
        let dir = std::env::temp_dir().join(format!("agentstoz-portal-identity-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let record = serde_json::json!({"deviceId": "fe3088df-1a7a-4223-b886-75b99765fe74", "deviceName": "Mac A"});
        persist_record(&dir, None, Some(&record));
        assert_eq!(read_record_file(&dir), Some(record));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(dir.join(RECORD_FILE_NAME)).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
