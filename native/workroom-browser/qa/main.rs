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
fn main(){
 let root=std::path::PathBuf::from(std::env::var("ATZ_QA_ROOT").expect("explicit temporary QA root required"));
 assert!(root.is_absolute()&&root.starts_with(std::env::temp_dir())&&root.exists());
 let holder=std::sync::Arc::new(std::sync::Mutex::new(None));let setup=holder.clone();
 let app=tauri::Builder::default().invoke_handler(tauri::generate_handler![qa_context,agent_runtime_request,qa_finish,workroom_browser::workroom_browser_native]).setup(move |app|{
  let window=app.get_webview_window("main").unwrap();window.set_zoom(0.625)?;
  // The rendered native check requires an on-screen window. A preceding browser test may leave another app in front;
  // an occluded WKWebView can suspend requestAnimationFrame during the fixture's viewport calibration.
  window.show()?;window.set_focus()?;
  let engine=agentstoz_workroom_browser::initialize(&root).map_err(std::io::Error::other)?;*setup.lock().unwrap()=Some(engine);
  eprintln!("ATZ_NATIVE_QA_SETUP_READY");Ok(())
 }).build(tauri::generate_context!()).unwrap();
 let code=app.run_return(|_,event|{if matches!(event,tauri::RunEvent::Exit){agentstoz_workroom_browser::before_exit();}});
 if let Some(engine)=holder.lock().unwrap().take(){engine.shutdown();}println!("ATZ_WORKROOM_NATIVE_CLEAN_EXIT:{code}");std::process::exit(code);
}
