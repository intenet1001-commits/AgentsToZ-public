//! Native computer-use control stays in the signed sibling app. This module never posts input or grants TCC.
use serde_json::{json, Value};

const MAX_REQUEST: usize = 16_384;
const MAX_RESPONSE: usize = 524_288;
const AGENT_OPERATIONS: &[&str] = &["status", "open-grant", "observe", "capture", "click", "press", "set-value", "receipt", "revoke", "revoke-session", "approval-status", "request-approval"];
const MANAGEMENT_OPERATIONS: &[&str] = &["status", "catalog", "approvals", "request-approval", "approval-status", "cancel-approval", "revoke", "revoke-session", "show-review", "disconnect-owner"];
const SCOPE_AGENT_OPERATIONS: &[&str] = &["scope-status", "scope-request-approval", "scope-approval-status", "scope-open-grant", "scope-observe", "scope-capture", "scope-click", "scope-type-text", "scope-key", "scope-scroll", "scope-drag", "scope-focus-app", "scope-receipt", "scope-revoke", "scope-revoke-session", "scope-disconnect-owner", "scope-standing-off"];
const SCOPE_MANAGEMENT_OPERATIONS: &[&str] = &["scope-status", "scope-catalog", "scope-request-approval", "scope-approval-status", "scope-revoke", "scope-revoke-session", "scope-disconnect-owner"];


fn native_request(mut value: Value, management: bool) -> Result<Vec<u8>, &'static str> {
    let object = value.as_object_mut().ok_or("invalid-request")?;
    if ["surface", "version", "v", "channel", "op"].iter().any(|key| object.contains_key(*key)) { return Err("reserved-field"); }
    let operation = object.get("operation").and_then(Value::as_str).ok_or("invalid-operation")?;
    let allowed = if management { MANAGEMENT_OPERATIONS } else { AGENT_OPERATIONS };
    let scoped_allowed = if management { SCOPE_MANAGEMENT_OPERATIONS } else { SCOPE_AGENT_OPERATIONS };
    let scoped = scoped_allowed.contains(&operation);
    if !allowed.contains(&operation) && !scoped { return Err("operation-not-allowed"); }
    let operation = operation.to_owned();
    object.remove("operation");
    object.insert("op".into(), json!(operation));
    object.insert("v".into(), json!(if scoped { 2 } else { 1 }));
    object.insert("channel".into(), json!(if management { "management" } else { "agent" }));
    let encoded = serde_json::to_vec(&value).map_err(|_| "invalid-request")?;
    if encoded.len() > MAX_REQUEST { return Err("request-too-large"); }
    Ok(encoded)
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn agentstoz_control_request(request: *const u8, length: usize, response: *mut *mut u8, response_length: *mut usize) -> i32;
    fn agentstoz_control_open() -> i32;
    fn agentstoz_control_response_free(response: *mut u8);
}

/// Native dispatch can have happened even when foreground coordination or the reply fails.
#[cfg(any(target_os = "macos", test))]
fn native_failure(result: i32) -> Value {
    let code = match result {
        -1 => "signed-main-required", -2 => "invalid-request", -3 => "helper-unavailable",
        -4 => "invalid-native-response", -5 => "native-outcome-unknown",
        -8 => "review-visibility-unconfirmed", _ => "unsupported-platform",
    };
    json!({"success":false,"code":code,"notDispatched":matches!(result,-1|-2|-6)})
}

pub(crate) fn request(value: Value, management: bool) -> Value {
    let encoded = match native_request(value, management) {
        Ok(value) => value,
        Err(code) => return json!({"success":false,"notDispatched":true,"code":code}),
    };
    #[cfg(target_os = "macos")]
    {
        let mut bytes = std::ptr::null_mut(); let mut length = 0;
        let result = unsafe { agentstoz_control_request(encoded.as_ptr(), encoded.len(), &mut bytes, &mut length) };
        if result != 0 {
            // A timeout, lost connection or failed review activation may follow dispatch.
            return native_failure(result);
        }
        if bytes.is_null() || !(2..=MAX_RESPONSE).contains(&length) {
            if !bytes.is_null() { unsafe { agentstoz_control_response_free(bytes); } }
            return json!({"success":false,"code":"invalid-native-response","notDispatched":false});
        }
        let parsed = serde_json::from_slice::<Value>(unsafe { std::slice::from_raw_parts(bytes, length) });
        unsafe { agentstoz_control_response_free(bytes); }
        return match parsed {
            Ok(value) if value.is_object() => value,
            _ => json!({"success":false,"code":"invalid-native-response","notDispatched":false}),
        };
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = encoded; json!({"success":false,"code":"unsupported-platform","notDispatched":true}) }
}

/// Only status/catalog and an explicit human app-open action reach this management entry. No input method exists.
pub(crate) fn manage(operation: &str) -> Value {
    match operation {
        "status" | "catalog" | "scope-status" | "scope-catalog" => request(json!({"operation":operation}), true),
        "review" => request(json!({"operation":"show-review"}), true),
        "open" => {
            #[cfg(target_os = "macos")]
            { let code=unsafe {agentstoz_control_open()};
              json!({"success":code==0,"opened":code==0,"code":match code {0=>"opened",-1=>"signed-main-required",-7=>"signed-helper-required",-5=>"open-unconfirmed",_=>"helper-unavailable"}}) }
            #[cfg(not(target_os = "macos"))]
            {json!({"success":false,"code":"unsupported-platform"})}
        },
        _ => json!({"success":false,"code":"operation-not-allowed","notDispatched":true}),
    }
}

#[cfg(target_os = "macos")]
mod private_link {
    use super::*;
    use std::io::{Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::UnixStream;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::time::Duration;

    /// No socket path or authority secret exists in argv, environment or app data. The child receives only its
    /// inherited endpoint number and must mark it close-on-exec before starting any agent children.
    pub(crate) struct ChildLink { parent: UnixStream, child: UnixStream }
    impl ChildLink {
        pub(crate) fn new() -> std::io::Result<Self> { let (parent, child) = UnixStream::pair()?; Ok(Self { parent, child }) }
        pub(crate) fn configure(&self, command: &mut Command) {
            let descriptor = self.child.as_raw_fd();
            command.env("PORTMGR_COMPUTER_USE_FD", descriptor.to_string());
            unsafe { command.pre_exec(move || {
                let flags = libc::fcntl(descriptor, libc::F_GETFD);
                if flags < 0 || libc::fcntl(descriptor, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 { return Err(std::io::Error::last_os_error()); }
                Ok(())
            }); }
        }
        pub(crate) fn start(self) {
            drop(self.child);
            let _ = std::thread::Builder::new().name("computer-use-private-link".into())
                .spawn(move || {
                    serve(self.parent, |value| request(value, false));
                    // Sidecar death retires its authority even while the main app remains alive. This call only
                    // revokes the audited main owner; no PID or credential can select somebody else.
                    retire_owner(|value| request(value, true));
                });
        }
    }
    fn retire_owner(mut invoke: impl FnMut(Value) -> Value) {
        let _ = invoke(json!({"operation":"disconnect-owner"}));
        // An older helper's v2 refusal must not prevent the existing v1 retirement above.
        let _ = invoke(json!({"operation":"scope-disconnect-owner"}));
    }
    fn valid_id(id: &str) -> bool {
        id.len() == 36 && id.bytes().enumerate().all(|(i,b)| if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() })
    }
    /// One outstanding operation, bounded frames, no retry or unbounded queue. EOF retires this private channel.
    fn serve(mut stream: UnixStream, invoke: impl Fn(Value) -> Value) {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(8)));
        loop {
            let _ = stream.set_read_timeout(None);
            let mut length = [0u8;4];
            if stream.read_exact(&mut length[..1]).is_err() { return; }
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            if stream.read_exact(&mut length[1..]).is_err() { return; }
            let size = u32::from_be_bytes(length) as usize;
            if !(2..=MAX_REQUEST).contains(&size) { return; }
            let mut body = vec![0;size]; if stream.read_exact(&mut body).is_err() { return; }
            let value: Value = match serde_json::from_slice(&body) { Ok(value) => value, Err(_) => return };
            let Some(object) = value.as_object() else { return; };
            if object.len() != 3 || object.get("version") != Some(&json!(1)) || !object.contains_key("request") { return; }
            let Some(id) = object.get("id").and_then(Value::as_str).filter(|id| valid_id(id)) else { return; };
            let reply = invoke(object["request"].clone());
            let bytes = match serde_json::to_vec(&json!({"version":1,"id":id,"response":reply})) { Ok(bytes) if bytes.len() <= MAX_RESPONSE => bytes, _ => return };
            if stream.write_all(&(bytes.len() as u32).to_be_bytes()).is_err() || stream.write_all(&bytes).is_err() { return; }
        }
    }
    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn eof_retirement_covers_both_scope_generations_even_if_one_is_refused() {
            let mut calls=Vec::new();
            retire_owner(|value| { calls.push(value); json!({"success":false}) });
            assert_eq!(calls,vec![json!({"operation":"disconnect-owner"}),json!({"operation":"scope-disconnect-owner"})]);
        }
        #[test]
        fn private_channel_preserves_id_and_never_accepts_extra_envelope_authority() {
            let (server,mut client)=UnixStream::pair().unwrap();
            let worker=std::thread::spawn(move||serve(server,|request|json!({"success":request["operation"]=="status"})));
            let input=json!({"version":1,"id":"01234567-0123-0123-0123-0123456789ab","request":{"operation":"status"}});
            let bytes=serde_json::to_vec(&input).unwrap();
            client.write_all(&(bytes.len() as u32).to_be_bytes()).unwrap();client.write_all(&bytes).unwrap();
            let mut size=[0;4];client.read_exact(&mut size).unwrap();let mut out=vec![0;u32::from_be_bytes(size)as usize];client.read_exact(&mut out).unwrap();
            let reply:Value=serde_json::from_slice(&out).unwrap();assert_eq!(reply["id"],input["id"]);assert_eq!(reply["response"]["success"],true);
            drop(client);worker.join().unwrap();
        }
        #[test]
        fn oversized_private_frame_never_invokes_native_code() {
            let (server,mut client)=UnixStream::pair().unwrap();
            let worker=std::thread::spawn(move||serve(server,|_|panic!("must not dispatch")));
            client.write_all(&((MAX_REQUEST+1)as u32).to_be_bytes()).unwrap();drop(client);worker.join().unwrap();
        }
    }
}
#[cfg(target_os = "macos")]
pub(crate) use private_link::ChildLink;

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn review_activation_failure_is_unconfirmed_not_a_safe_to_replay_refusal() {
        assert_eq!(native_failure(-8), json!({"success":false,"code":"review-visibility-unconfirmed","notDispatched":false}));
        assert_eq!(native_failure(-5), json!({"success":false,"code":"native-outcome-unknown","notDispatched":false}));
        assert_eq!(native_failure(-1), json!({"success":false,"code":"signed-main-required","notDispatched":true}));
        assert_eq!(native_failure(-6)["notDispatched"], true);
    }
    #[test] fn agent_cannot_catalog_or_promote_its_surface() {
        assert_eq!(native_request(json!({"operation":"catalog"}),false),Err("operation-not-allowed"));
        assert_eq!(native_request(json!({"operation":"status","surface":"management"}),false),Err("reserved-field"));
        assert_eq!(native_request(json!({"operation":"status","version":1}),false),Err("reserved-field"));
        let parsed:Value=serde_json::from_slice(&native_request(json!({"operation":"status"}),false).unwrap()).unwrap();
        assert_eq!(parsed["channel"],"agent");assert_eq!(parsed["v"],1);assert_eq!(parsed["op"],"status");
        assert!(parsed.get("operation").is_none());
        for key in ["v","channel","op"] { assert_eq!(native_request(json!({"operation":"status",(key):"management"}),false),Err("reserved-field")); }
        assert_eq!(native_request(json!({"operation":"show-review"}),false),Err("operation-not-allowed"));
        assert!(native_request(json!({"operation":"show-review"}),true).is_ok());
        assert_eq!(native_request(json!({"operation":"disconnect-owner"}),false),Err("operation-not-allowed"));
        assert!(native_request(json!({"operation":"disconnect-owner"}),true).is_ok());
    }
    #[test] fn scoped_envelopes_are_v2_and_keep_management_off_the_agent_channel() {
        for operation in SCOPE_AGENT_OPERATIONS {
            let parsed:Value=serde_json::from_slice(&native_request(json!({"operation":operation}),false).unwrap()).unwrap();
            assert_eq!(parsed["v"],2);assert_eq!(parsed["op"],*operation);assert_eq!(parsed["channel"],"agent");
            if !SCOPE_MANAGEMENT_OPERATIONS.contains(operation) { assert_eq!(native_request(json!({"operation":operation}),true),Err("operation-not-allowed")); }
        }
        for operation in SCOPE_MANAGEMENT_OPERATIONS {
            let parsed:Value=serde_json::from_slice(&native_request(json!({"operation":operation}),true).unwrap()).unwrap();
            assert_eq!(parsed["v"],2);assert_eq!(parsed["channel"],"management");
            if !SCOPE_AGENT_OPERATIONS.contains(operation) { assert_eq!(native_request(json!({"operation":operation}),false),Err("operation-not-allowed")); }
        }
        for key in ["v","channel","op","version","surface"] {
            assert_eq!(native_request(json!({"operation":"scope-status",(key):"spoof"}),false),Err("reserved-field"));
        }
    }
    #[test] fn only_closed_operations_fit_the_native_budget() {
        assert!(native_request(json!({"operation":"catalog"}),true).is_ok());
        assert!(native_request(json!({"operation":"shell","command":"ignored"}),true).is_err());
        assert_eq!(native_request(json!({"operation":"set-value","value":"x".repeat(MAX_REQUEST)}),false),Err("request-too-large"));
    }
    #[test] fn capture_and_click_are_agent_only_and_keep_request_identity() {
        for operation in ["capture", "click"] {
            let input = json!({"operation":operation,"requestId":"request-1","x":12,"y":34});
            let parsed: Value = serde_json::from_slice(&native_request(input.clone(),false).unwrap()).unwrap();
            assert_eq!(parsed["channel"],"agent"); assert_eq!(parsed["op"],operation);
            assert_eq!(parsed["requestId"],"request-1");
            assert_eq!(native_request(input,true),Err("operation-not-allowed"));
        }
    }
    /// The TypeScript adapter's request shapes (tests/computer-use-control-hooks.test.ts) come out of this bridge as
    /// exactly the samples AgentsToZ Control decodes, capture and click included; what a channel may not send stays out.
    #[test] fn the_shared_contract_samples_are_exactly_what_the_bridge_sends() {
        let contract: Value = serde_json::from_str(include_str!("../../native/computer-use/Tests/ControlContract/requests.json")).unwrap();
        for (channel, management) in [("agent", false), ("management", true)] {
            let allowed = if management { MANAGEMENT_OPERATIONS } else { AGENT_OPERATIONS };
            for (op, sample) in contract["valid"][channel].as_object().unwrap() {
                let mut input = sample.as_object().unwrap().clone();
                for key in ["v", "channel", "op"] { input.remove(key); }
                input.insert("operation".into(), json!(op));
                match native_request(Value::Object(input), management) {
                    Ok(bytes) => { assert!(allowed.contains(&op.as_str())); assert_eq!(&serde_json::from_slice::<Value>(&bytes).unwrap(), sample, "{channel} {op}"); }
                    Err(code) => { assert_eq!((code, allowed.contains(&op.as_str())), ("operation-not-allowed", false), "{channel} {op}"); }
                }
            }
        }
        for op in ["capture", "click"] {
            assert!(AGENT_OPERATIONS.contains(&op) && contract["valid"]["agent"].get(op).is_some());
            assert!(!MANAGEMENT_OPERATIONS.contains(&op) && contract["valid"]["management"].get(op).is_none());
        }
        // Only the Rust teardown sends disconnect-owner; the sidecar's agent channel never can.
        assert!(!AGENT_OPERATIONS.contains(&"disconnect-owner"));
    }
    #[test] fn a_test_binary_has_no_signed_application_authority() {
        let response=request(json!({"operation":"status"}),false);
        assert_eq!(response["success"],false);assert_eq!(response["notDispatched"],true);
    }
}
