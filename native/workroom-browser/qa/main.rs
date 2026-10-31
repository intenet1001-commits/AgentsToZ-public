use serde_json::{json,Value};
use std::io::{Read,Write};
use tauri::Manager;
mod workroom_popout{pub fn is_workroom_popout_label(_: &str)->bool{false}}
#[path="../../../src-tauri/src/workroom_browser.rs"] mod workroom_browser;
#[tauri::command]
fn qa_context()->Result<Value,String>{eprintln!("ATZ_NATIVE_QA_CONTEXT_REQUESTED");let data=std::env::var("ATZ_QA_CONTEXT").map_err(|e|e.to_string())?;serde_json::from_str(&data).map_err(|e|e.to_string())}
#[tauri::command]
async fn agent_runtime_request(path:String,method:String,body:Option<Value>)->Result<Value,String>{
 if method!="POST"||!matches!(path.as_str(),"/api/agent-runtime/workroom-browser"|"/api/agent-runtime/terminals"|"/api/agent-runtime/workroom-teams"|"/qa-agent"|"/qa-human"|"/qa-end-workroom"){return Err("QA route refused".into());}
 tauri::async_runtime::spawn_blocking(move||{
  let port:u16=std::env::var("ATZ_QA_PORT").unwrap().parse().unwrap();let mut socket=std::net::TcpStream::connect(("127.0.0.1",port)).map_err(|e|e.to_string())?;socket.set_read_timeout(Some(std::time::Duration::from_secs(25))).unwrap();
  let body=serde_json::to_string(&body.unwrap_or(json!({}))).unwrap();write!(socket,"POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).map_err(|e|e.to_string())?;
  let mut response=String::new();socket.read_to_string(&mut response).map_err(|e|e.to_string())?;let (headers,data)=response.split_once("\r\n\r\n").ok_or("Invalid QA response")?;let status=headers.split_whitespace().nth(1).unwrap().parse::<u16>().unwrap();let data:Value=serde_json::from_str(data).map_err(|e|e.to_string())?;Ok(json!({"status":status,"body":data}))
 }).await.map_err(|e|e.to_string())?
}
#[tauri::command]
fn qa_finish(app:tauri::AppHandle,report:Value){let pass=report["passed"]==true;println!("ATZ_WORKROOM_NATIVE_QA:{}",report);app.exit(if pass{0}else{1});}
// The fixture's geometry probes, one bounded line each: WKWebView does not forward console output, and the runner copies
// these lines into report.json whether the run passes or fails.
#[tauri::command]
fn qa_log(line:String){let line:String=line.chars().filter(|c|!c.is_control()).take(16000).collect();println!("ATZ_NATIVE_QA_PROBE:{line}");}
// An occluded or hidden WKWebView suspends requestAnimationFrame, and a launch from a terminal cannot count on macOS
// activating it: a preceding run or browser test may leave another app in front. Float the window above normal
// windows on every Space, then show and focus it. Focus is best effort (cooperative activation may refuse it), so the
// fixture reports document.visibilityState and hasFocus() alongside this window state when frames stall.
// The float lasts only while the window is being reclaimed: at launch until the viewport calibration has its frames,
// and after a stall until frames return. qa_lower then makes it a normal window again, still in front, so the run does
// not keep covering the person's other windows on every Space.
fn float(window:&tauri::WebviewWindow,on:bool)->tauri::Result<()>{window.set_visible_on_all_workspaces(on)?;window.set_always_on_top(on)}
fn raise(app:&tauri::AppHandle,window:&tauri::WebviewWindow)->tauri::Result<()>{
 float(window,true)?;window.unminimize()?;window.show()?;
 #[cfg(target_os="macos")] app.show()?;
 window.set_focus()
}
#[tauri::command]
fn qa_raise(app:tauri::AppHandle,window:tauri::WebviewWindow)->Result<Value,String>{
 raise(&app,&window).map_err(|e|e.to_string())?;let state=|r:tauri::Result<bool>|r.map_err(|e|e.to_string());
 Ok(json!({"visible":state(window.is_visible())?,"focused":state(window.is_focused())?,"minimized":state(window.is_minimized())?}))
}
#[tauri::command]
fn qa_lower(window:tauri::WebviewWindow)->Result<(),String>{float(&window,false).map_err(|e|e.to_string())}
fn main(){
 let root=std::path::PathBuf::from(std::env::var("ATZ_QA_ROOT").expect("explicit temporary QA root required"));
 assert!(root.is_absolute()&&root.starts_with(std::env::temp_dir())&&root.exists());
 let holder=std::sync::Arc::new(std::sync::Mutex::new(None));let setup=holder.clone();
 let app=tauri::Builder::default().invoke_handler(tauri::generate_handler![qa_context,agent_runtime_request,qa_finish,qa_log,qa_raise,qa_lower,workroom_browser::workroom_browser_native]).setup(move |app|{
  let window=app.get_webview_window("main").unwrap();window.set_zoom(0.625)?;
  // The rendered native check requires an on-screen window (see raise): start centred on the main display, in front,
  // floating until the fixture's calibration lowers it.
  window.center()?;raise(app.handle(),&window)?;
  let engine=agentstoz_workroom_browser::initialize(&root).map_err(std::io::Error::other)?;*setup.lock().unwrap()=Some(engine);
  eprintln!("ATZ_NATIVE_QA_SETUP_READY");Ok(())
 }).build(tauri::generate_context!()).unwrap();
 let code=app.run_return(|_,event|{if matches!(event,tauri::RunEvent::Exit){agentstoz_workroom_browser::before_exit();}});
 if let Some(engine)=holder.lock().unwrap().take(){engine.shutdown();}println!("ATZ_WORKROOM_NATIVE_CLEAN_EXIT:{code}");std::process::exit(code);
}
