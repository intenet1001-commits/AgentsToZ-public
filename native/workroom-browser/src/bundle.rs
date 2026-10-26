//! Assemble a local, unpublished test app. Does not install, sign for distribution or publish it.
fn main(){
 use cef::build_util::mac::{bundle,BundleInfo};
 let root=std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().parent().unwrap().to_path_buf();
 let qa=std::env::args().any(|x|x=="--qa");
 let app_target=if qa{root.join("experiments/owned-browser-native/target/debug")}else{root.join("src-tauri/target/debug")};let native_target=root.join("native/workroom-browser/target/debug");
 std::fs::copy(native_target.join("agentstoz-browser-helper"),app_target.join("agentstoz-browser-helper")).unwrap();
 let info=BundleInfo::new("app","com.agentstoz.workroom-browser-local-test","AgentsToZ Browser Local Test","English","0.1.0".parse().unwrap());
 let path=bundle(&root.join(if qa{"output/workroom-browser-native-qa/bundle"}else{"output/workroom-browser-native"}),&app_target,"app","agentstoz-browser-helper",None,info).unwrap();
 let resources=path.join("Contents/Resources/resources");std::fs::create_dir_all(&resources).unwrap();
 fn copy(from:&std::path::Path,to:&std::path::Path){for entry in std::fs::read_dir(from).unwrap(){let entry=entry.unwrap();let target=to.join(entry.file_name());if entry.path().is_dir(){std::fs::create_dir_all(&target).unwrap();copy(&entry.path(),&target);}else{std::fs::copy(entry.path(),target).unwrap();}}}
 if !qa{copy(&root.join("src-tauri/resources"),&resources);}
 println!("Local test only: {}",path.display());
}
