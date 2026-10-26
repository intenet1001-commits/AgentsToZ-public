// A separate, sandboxed CEF subprocess. Never loads the trusted Tauri host.
use cef::{args::Args, *};

fn main() {
    let args = Args::new();
    let mut sandbox = cef::sandbox::Sandbox::new();
    sandbox.initialize(args.as_main_args());
    let loader = library_loader::LibraryLoader::new(&std::env::current_exe().unwrap(), true);
    assert!(loader.load());
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let code = execute_process(Some(args.as_main_args()), None::<&mut App>, std::ptr::null_mut());
    std::process::exit(code);
}
