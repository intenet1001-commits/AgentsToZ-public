fn main() {
    use cef::build_util::mac::{bundle, BundleInfo};
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    std::env::set_current_dir(&root).unwrap();
    let info = BundleInfo::new("agentstoz-browser-spike", "com.agentstoz.browser-spike", "AgentsToZ Browser Experiment", "English", "0.1.0".parse().unwrap());
    let path = bundle(&root.join("bundle"), &root.join("target/debug"), "agentstoz-browser-spike", "agentstoz-browser-helper", None, info).unwrap();
    println!("{}", path.display());
}
