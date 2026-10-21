fn main() {
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
    let checked_in_bridge = std::path::PathBuf::from(
      "native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.m",
    );
    let bridge_source = match std::env::var("AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE") {
      Ok(raw) => {
        let requested = std::path::PathBuf::from(raw);
        let canonical = requested.canonicalize().unwrap_or_else(|_| {
          panic!("generated macOS runtime client bridge is unavailable")
        });
        let metadata = std::fs::symlink_metadata(&requested).unwrap_or_else(|_| {
          panic!("generated macOS runtime client bridge metadata is unavailable")
        });
        if !requested.is_absolute()
          || metadata.file_type().is_symlink()
          || !metadata.is_file()
          || canonical.file_name().and_then(|value| value.to_str())
            != Some("RuntimeBrokerClientBridge.m")
          || canonical.parent().and_then(|value| value.file_name())
            .and_then(|value| value.to_str()) != Some("Generated")
          || !canonical.parent().and_then(|value| value.parent())
            .and_then(|value| value.file_name())
            .and_then(|value| value.to_str())
            .is_some_and(|value| value.starts_with("agentstoz-runtime-production-sources-"))
        {
          panic!("generated macOS runtime client bridge path was rejected");
        }
        canonical
      }
      Err(std::env::VarError::NotPresent) => checked_in_bridge.clone(),
      Err(std::env::VarError::NotUnicode(_)) => {
        panic!("generated macOS runtime client bridge path is not UTF-8")
      }
    };
    cc::Build::new()
      .file(&bridge_source)
      .include("native/macos-runtime/ClientBridge")
      .flag("-fobjc-arc")
      .flag("-fmodules")
      .warnings(true)
      .warnings_into_errors(true)
      .compile("agentstoz_macos_runtime_client_bridge");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Security");
    println!("cargo:rustc-link-lib=framework=ServiceManagement");
    println!("cargo:rerun-if-changed=native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.h");
    println!("cargo:rerun-if-changed=native/macos-runtime/ClientBridge/RuntimeBrokerClientBridge.m");
    println!("cargo:rerun-if-env-changed=AGENTSTOZ_MACOS_RUNTIME_CLIENT_BRIDGE_SOURCE");
    if bridge_source != checked_in_bridge {
      println!("cargo:rerun-if-changed={}", bridge_source.display());
    }
  }
  tauri_build::build()
}
