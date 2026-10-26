use serde_json::{json,Value};
#[tauri::command]
pub async fn workroom_browser_native(app:tauri::AppHandle,window:tauri::WebviewWindow,session_id:String,operation:String,url:Option<String>,rect:Option<[f64;4]>,profile_key:Option<String>,tab:Option<String>)->Result<Value,String>{
 let page=window.url().map_err(|e|e.to_string())?;
 if !(window.label()=="main"||super::workroom_popout::is_workroom_popout_label(window.label()))||!(page.scheme()=="tauri"||page.scheme()=="http"&&page.host_str()==Some("localhost")&&page.port()==Some(9000)) {return Err("Trusted local Workroom required.".into());}
 if operation=="availability"{return Ok(json!({"available":cfg!(all(target_os="macos",feature="embedded-browser"))}));}
 #[cfg(all(target_os="macos",feature="embedded-browser"))]{
  let (tx,rx)=std::sync::mpsc::sync_channel(1);
  app.run_on_main_thread(move||{let result=window.ns_window().map_err(|e|e.to_string()).and_then(|native|agentstoz_workroom_browser::action(native,window.label(),&session_id,&operation,url.as_deref(),rect,profile_key.as_deref(),tab.as_deref()));let _=tx.send(result);}).map_err(|e|e.to_string())?;
  return tauri::async_runtime::spawn_blocking(move||rx.recv_timeout(std::time::Duration::from_secs(10)).map_err(|e|e.to_string())?).await.map_err(|e|e.to_string())?;
 }
 #[cfg(not(all(target_os="macos",feature="embedded-browser")))]{let _=(app,session_id,url,rect,profile_key,tab);Err("This app was built without embedded Chromium.".into())}
}
