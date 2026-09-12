use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
pub(crate) enum RuntimeBrokerClientResult {
    NotRegistered = 0,
    Enabled = 1,
    RequiresApproval = 2,
    NotFound = 3,
    Registered = 10,
    Unregistered = 11,
    AlreadyRegistered = 12,
    RegistrationDenied = 13,
    ProbePassed = 20,
    DedicatedIdentityFixturePassed = 21,
    DedicatedIdentityProvisioned = 22,
    DedicatedIdentityAlreadyProvisioned = 23,
    UnsupportedOs = -100,
    ProductionIdentityUnavailable = -101,
    AppLocationRejected = -102,
    BundleIdentityRejected = -103,
    SignatureRejected = -104,
    EmbeddedServiceMissing = -105,
    InvalidChallenge = -106,
    ConnectionRejected = -107,
    ProbeMismatch = -108,
    ProbeTimedOut = -109,
    RegistrationFailed = -110,
    UnregistrationFailed = -111,
    DedicatedIdentityFixtureRejected = -112,
    DedicatedIdentityProvisioningRejected = -113,
    Unknown = i32::MIN,
}

impl RuntimeBrokerClientResult {
    fn from_raw(value: i32) -> Self {
        match value {
            0 => Self::NotRegistered,
            1 => Self::Enabled,
            2 => Self::RequiresApproval,
            3 => Self::NotFound,
            10 => Self::Registered,
            11 => Self::Unregistered,
            12 => Self::AlreadyRegistered,
            13 => Self::RegistrationDenied,
            20 => Self::ProbePassed,
            21 => Self::DedicatedIdentityFixturePassed,
            22 => Self::DedicatedIdentityProvisioned,
            23 => Self::DedicatedIdentityAlreadyProvisioned,
            -100 => Self::UnsupportedOs,
            -101 => Self::ProductionIdentityUnavailable,
            -102 => Self::AppLocationRejected,
            -103 => Self::BundleIdentityRejected,
            -104 => Self::SignatureRejected,
            -105 => Self::EmbeddedServiceMissing,
            -106 => Self::InvalidChallenge,
            -107 => Self::ConnectionRejected,
            -108 => Self::ProbeMismatch,
            -109 => Self::ProbeTimedOut,
            -110 => Self::RegistrationFailed,
            -111 => Self::UnregistrationFailed,
            -112 => Self::DedicatedIdentityFixtureRejected,
            -113 => Self::DedicatedIdentityProvisioningRejected,
            _ => Self::Unknown,
        }
    }

    fn code(self) -> &'static str {
        match self {
            Self::NotRegistered => "not-registered",
            Self::Enabled => "enabled",
            Self::RequiresApproval => "requires-approval",
            Self::NotFound => "not-found",
            Self::Registered => "registered",
            Self::Unregistered => "unregistered",
            Self::AlreadyRegistered => "already-registered",
            Self::RegistrationDenied => "registration-denied",
            Self::ProbePassed => "probe-passed",
            Self::DedicatedIdentityFixturePassed => "dedicated-identity-fixture-passed",
            Self::DedicatedIdentityProvisioned => "dedicated-identity-provisioned",
            Self::DedicatedIdentityAlreadyProvisioned => "dedicated-identity-already-provisioned",
            Self::UnsupportedOs => "unsupported-os",
            Self::ProductionIdentityUnavailable => "production-identity-unavailable",
            Self::AppLocationRejected => "app-location-rejected",
            Self::BundleIdentityRejected => "bundle-identity-rejected",
            Self::SignatureRejected => "signature-rejected",
            Self::EmbeddedServiceMissing => "embedded-service-missing",
            Self::InvalidChallenge => "invalid-challenge",
            Self::ConnectionRejected => "connection-rejected",
            Self::ProbeMismatch => "probe-mismatch",
            Self::ProbeTimedOut => "probe-timed-out",
            Self::RegistrationFailed => "registration-failed",
            Self::UnregistrationFailed => "unregistration-failed",
            Self::DedicatedIdentityFixtureRejected => "dedicated-identity-fixture-rejected",
            Self::DedicatedIdentityProvisioningRejected => {
                "dedicated-identity-provisioning-rejected"
            }
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RuntimeBrokerClientDiagnostic {
    schema_version: u8,
    kind: &'static str,
    operation: &'static str,
    result: &'static str,
    execution_authorized: bool,
    reusable: bool,
    ready: bool,
}

fn diagnostic(
    operation: &'static str,
    result: RuntimeBrokerClientResult,
) -> RuntimeBrokerClientDiagnostic {
    RuntimeBrokerClientDiagnostic {
        schema_version: 1,
        kind: "macos-runtime-broker-client-diagnostic",
        operation,
        result: result.code(),
        // Registration and a successful probe prove only the native channel.
        // The dedicated UID, container TCB and escape canary remain separate
        // authorization gates.
        execution_authorized: false,
        reusable: false,
        ready: false,
    }
}

unsafe extern "C" {
    fn agentstoz_runtime_broker_service_status() -> i32;
    fn agentstoz_runtime_broker_register() -> i32;
    fn agentstoz_runtime_broker_unregister() -> i32;
    fn agentstoz_runtime_broker_probe(challenge: *const u8, challenge_length: usize) -> i32;
    fn agentstoz_runtime_broker_run_dedicated_identity_fixture(
        challenge: *const u8,
        challenge_length: usize,
    ) -> i32;
    fn agentstoz_runtime_broker_provision_dedicated_identity(
        challenge: *const u8,
        challenge_length: usize,
    ) -> i32;
}

pub(crate) fn service_status() -> RuntimeBrokerClientResult {
    // The native bridge performs production identity, app location, bundle
    // identity, live code-signing and embedded service checks before touching
    // ServiceManagement.
    RuntimeBrokerClientResult::from_raw(unsafe {
        agentstoz_runtime_broker_service_status()
    })
}

pub(crate) fn register() -> RuntimeBrokerClientResult {
    RuntimeBrokerClientResult::from_raw(unsafe { agentstoz_runtime_broker_register() })
}

pub(crate) fn unregister() -> RuntimeBrokerClientResult {
    RuntimeBrokerClientResult::from_raw(unsafe { agentstoz_runtime_broker_unregister() })
}

pub(crate) fn probe(challenge: &[u8; 32]) -> RuntimeBrokerClientResult {
    RuntimeBrokerClientResult::from_raw(unsafe {
        agentstoz_runtime_broker_probe(challenge.as_ptr(), challenge.len())
    })
}

pub(crate) fn run_dedicated_identity_fixture(
    challenge: &[u8; 32],
) -> RuntimeBrokerClientResult {
    RuntimeBrokerClientResult::from_raw(unsafe {
        agentstoz_runtime_broker_run_dedicated_identity_fixture(
            challenge.as_ptr(),
            challenge.len(),
        )
    })
}

pub(crate) fn provision_dedicated_identity(challenge: &[u8; 32]) -> RuntimeBrokerClientResult {
    RuntimeBrokerClientResult::from_raw(unsafe {
        agentstoz_runtime_broker_provision_dedicated_identity(challenge.as_ptr(), challenge.len())
    })
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_status() -> RuntimeBrokerClientDiagnostic {
    diagnostic("status", service_status())
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_register(
    confirmed: bool,
) -> Result<RuntimeBrokerClientDiagnostic, String> {
    if !confirmed {
        return Err("런타임 서비스 등록 확인이 필요합니다.".to_string());
    }
    Ok(diagnostic("register", register()))
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_unregister(
    confirmed: bool,
) -> Result<RuntimeBrokerClientDiagnostic, String> {
    if !confirmed {
        return Err("런타임 서비스 등록 해제 확인이 필요합니다.".to_string());
    }
    Ok(diagnostic("unregister", unregister()))
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_probe() -> RuntimeBrokerClientDiagnostic {
    let mut challenge = [0u8; 32];
    if getrandom::fill(&mut challenge).is_err() {
        return diagnostic("probe", RuntimeBrokerClientResult::ConnectionRejected);
    }
    diagnostic("probe", probe(&challenge))
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_dedicated_identity_fixture(
    confirmed: bool,
) -> Result<RuntimeBrokerClientDiagnostic, String> {
    if !confirmed {
        return Err("전용 런타임 계정 시험 확인이 필요합니다.".to_string());
    }
    let mut challenge = [0u8; 32];
    if getrandom::fill(&mut challenge).is_err() {
        return Ok(diagnostic(
            "dedicated-identity-fixture",
            RuntimeBrokerClientResult::ConnectionRejected,
        ));
    }
    Ok(diagnostic(
        "dedicated-identity-fixture",
        run_dedicated_identity_fixture(&challenge),
    ))
}

#[tauri::command]
pub(crate) fn agent_runtime_native_broker_provision_dedicated_identity(
    confirmed: bool,
) -> Result<RuntimeBrokerClientDiagnostic, String> {
    if !confirmed {
        return Err("전용 비로그인 런타임 계정 생성 확인이 필요합니다.".to_string());
    }
    let mut challenge = [0u8; 32];
    if getrandom::fill(&mut challenge).is_err() {
        return Ok(diagnostic(
            "provision-dedicated-identity",
            RuntimeBrokerClientResult::ConnectionRejected,
        ));
    }
    Ok(diagnostic(
        "provision-dedicated-identity",
        provision_dedicated_identity(&challenge),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_build_fails_before_service_management_mutation() {
        assert_eq!(
            service_status(),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
        assert_eq!(
            register(),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
        assert_eq!(
            unregister(),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
        assert_eq!(
            probe(&[0x5a; 32]),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
        assert_eq!(
            run_dedicated_identity_fixture(&[0x5a; 32]),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
        assert_eq!(
            provision_dedicated_identity(&[0x5a; 32]),
            RuntimeBrokerClientResult::ProductionIdentityUnavailable
        );
    }

    #[test]
    fn unknown_native_values_fail_closed() {
        assert_eq!(
            RuntimeBrokerClientResult::from_raw(999),
            RuntimeBrokerClientResult::Unknown
        );
    }

    #[test]
    fn diagnostics_are_never_execution_capabilities() {
        let value = diagnostic("probe", RuntimeBrokerClientResult::ProbePassed);
        assert_eq!(value.schema_version, 1);
        assert_eq!(value.operation, "probe");
        assert_eq!(value.result, "probe-passed");
        assert!(!value.execution_authorized);
        assert!(!value.reusable);
        assert!(!value.ready);
    }

    #[test]
    fn mutating_commands_require_an_exact_confirmation() {
        assert!(agent_runtime_native_broker_register(false).is_err());
        assert!(agent_runtime_native_broker_unregister(false).is_err());
        assert!(agent_runtime_native_broker_dedicated_identity_fixture(false).is_err());
        assert!(agent_runtime_native_broker_provision_dedicated_identity(false).is_err());
    }
}
