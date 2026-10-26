fn main() {
    use sha2::{Digest, Sha256};
    use std::path::{Path, PathBuf};
    fn files(path: &Path, out: &mut Vec<PathBuf>) {
        let mut entries: Vec<_> = std::fs::read_dir(path).unwrap().map(|e|e.unwrap().path()).collect();
        entries.sort();
        for entry in entries { if entry.is_dir() { files(&entry,out); } else { out.push(entry); } }
    }
    let mut paths: Vec<PathBuf> = ["Cargo.toml","Cargo.lock","build.rs","tauri.conf.json","verify.py"].iter().map(PathBuf::from).collect();
    files(Path::new("src"),&mut paths); files(Path::new("ui"),&mut paths);
    let mut digest=Sha256::new();
    for path in paths {
        println!("cargo:rerun-if-changed={}",path.display());
        digest.update(path.to_str().unwrap().as_bytes()); digest.update([0]); digest.update(std::fs::read(path).unwrap());
    }
    println!("cargo:rustc-env=ATZ_SOURCE_DIGEST={:x}",digest.finalize());
    println!("cargo:rustc-check-cfg=cfg(atz_control_standalone)");
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos", "macOS feasibility experiment only");
    cc::Build::new().file("src/cocoa.m").flag("-fobjc-arc").warnings_into_errors(true).compile("browser_spike_cocoa");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rerun-if-changed=src/cocoa.m");
    tauri_build::build();
}
