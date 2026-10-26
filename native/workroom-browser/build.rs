fn main() {
    assert_eq!(std::env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
    cc::Build::new().file("src/cocoa.m").flag("-fobjc-arc").warnings_into_errors(true).compile("workroom_browser_cocoa");
    println!("cargo:rustc-link-lib=framework=AppKit");
    println!("cargo:rustc-link-lib=framework=CoreGraphics");
    println!("cargo:rerun-if-changed=src/cocoa.m");
}
