//! Native Workroom Chromium. Trusted state lives in the host; no page title/main-world variable can acknowledge control.
use cef::*;
mod shortcut;
use serde_json::{json,Value};
use std::{cell::RefCell,collections::HashMap,ffi::c_void,path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}}};
extern "C" {
 fn atz_install_cef_protocol();fn atz_create_container(window:*mut c_void,x:f64,y:f64,w:f64,h:f64)->*mut c_void;
 fn atz_container_frame(view:*mut c_void,x:f64,y:f64,w:f64,h:f64)->bool;fn atz_container_hidden(view:*mut c_void,hidden:bool);fn atz_container_input(view:*mut c_void,enabled:bool);fn atz_release_container(view:*mut c_void);
 fn atz_container_visible(view:*mut c_void)->bool;
 fn atz_container_rect(view:*mut c_void,out:*mut f64);
 fn atz_container_window_rect(view:*mut c_void,out:*mut f64);
 fn atz_popup_host(window:*mut c_void,host:*const std::ffi::c_char);
 fn atz_create_popup(container:*mut c_void,host:*const std::ffi::c_char)->*mut c_void;
 fn atz_container_blocked(view:*mut c_void)->u64;fn atz_container_focused(view:*mut c_void)->bool;fn atz_forward_shortcut(view:*mut c_void,event:*mut u8,payload:*const std::ffi::c_char)->bool;
 #[cfg(feature="fixtures")]fn atz_qa_input(view:*mut c_void,kind:i32);
 #[cfg(feature="fixtures")]fn atz_popup_geometry(window:*mut c_void,out:*mut f64);fn atz_popup_content(window:*mut c_void)->*mut c_void;fn atz_destroy_popup(window:*mut c_void);fn atz_detach_browser_view(view:*mut c_void);
 fn atz_start_pump(callback:extern "C" fn());fn atz_schedule_pump(delay:i64);fn atz_stop_pump();fn atz_drain_close_events();
}
static READY:AtomicBool=AtomicBool::new(false);
static PUMPS:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
static SCHEDULES:std::sync::atomic::AtomicU64=std::sync::atomic::AtomicU64::new(0);
#[cfg(feature="fixtures")]static QA_DROP_USED:AtomicBool=AtomicBool::new(false);
thread_local!{static RUNTIME:RefCell<Option<Runtime>>=const{RefCell::new(None)};}
#[derive(Default)]struct Shared{session:String,tab:String,title:String,progress:f64,load_error:Option<Value>,console_errors:u64,container:usize,target:Option<String>,human:bool,closed:bool,closing:bool,popups:HashMap<i32,Browser>,pending_windows:HashMap<(i32,i32),usize>,notice:Option<String>,downloads:u32,uploads:u32,target_results:u32,target_failures:u32,last_target_error:Option<i64>,devtools_attaches:u32,devtools_detaches:u32,#[cfg(feature="fixtures")]qa_drop_target:bool}
struct View{browser:Browser,container:*mut c_void,context:RequestContext,registration:Registration,shared:Arc<Mutex<Shared>>,window:String,session:String,profile_key:String,target_probes:u8,target_sends:u8,last_target_probe:Option<std::time::Instant>,created:std::time::Instant,navigations:u32}
struct Runtime{root:PathBuf,port:u16,views:HashMap<String,View>,pending:HashMap<String,(RequestContext,Arc<AtomicBool>,String)>}
pub struct Engine{loader:library_loader::LibraryLoader}
wrap_browser_process_handler!{struct Process;impl BrowserProcessHandler{
 fn on_context_initialized(&self){READY.store(true,Ordering::SeqCst);}
 fn on_schedule_message_pump_work(&self,delay_ms:i64){SCHEDULES.fetch_add(1,Ordering::Relaxed);unsafe{atz_schedule_pump(delay_ms);}}
}}
wrap_app!{struct CefApp;impl App{
 fn browser_process_handler(&self)->Option<BrowserProcessHandler>{Some(Process::new())}
 #[cfg(feature="fixtures")]
 fn on_before_command_line_processing(&self,_process_type:Option<&CefString>,line:Option<&mut CommandLine>){if let Some(line)=line{line.append_switch(Some(&CefString::from("use-mock-keychain")));}}
}}
wrap_request_context_handler!{struct ProfileReady{ready:Arc<AtomicBool>,}impl RequestContextHandler{
 fn on_request_context_initialized(&self,_context:Option<&mut RequestContext>){self.ready.store(true,Ordering::SeqCst);}
}}
wrap_focus_handler!{struct Focus{shared:Arc<Mutex<Shared>>,}impl FocusHandler{
 fn on_set_focus(&self,_browser:Option<&mut Browser>,source:FocusSource)->i32{i32::from(source==FocusSource::NAVIGATION||!self.shared.lock().unwrap().human)}
}}
wrap_request_handler!{struct RequestGuard;impl RequestHandler{
 fn on_before_browse(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,request:Option<&mut Request>,_user_gesture:i32,_is_redirect:i32)->i32{
  let url=request.map(|r|CefString::from(&r.url()).to_string()).unwrap_or_default();
  i32::from(!(url.starts_with("https://")||url.starts_with("http://")||url=="about:blank"))
 }
 fn on_open_urlfrom_tab(&self,_browser:Option<&mut Browser>,_frame:Option<&mut Frame>,_target_url:Option<&CefString>,_target_disposition:WindowOpenDisposition,_user_gesture:i32)->i32{1}
}}
thread_local!{static POPUP_BROWSERS:RefCell<HashMap<usize,Browser>>=RefCell::new(HashMap::new());}
#[no_mangle]
pub extern "C" fn atz_popup_requested_close(window:*mut c_void)->bool{
 let browser=POPUP_BROWSERS.with(|map|map.borrow().get(&(window as usize)).cloned());
 browser.and_then(|browser|browser.host()).is_none_or(|host|host.try_close_browser()!=0)
}
wrap_life_span_handler!{struct Life{shared:Arc<Mutex<Shared>>,popup_window:usize,}impl LifeSpanHandler{
 fn on_before_popup(&self,browser:Option<&mut Browser>,_frame:Option<&mut Frame>,popup_id:i32,target_url:Option<&CefString>,_target_frame_name:Option<&CefString>,_target_disposition:WindowOpenDisposition,_user_gesture:i32,_popup_features:Option<&PopupFeatures>,window_info:Option<&mut WindowInfo>,client:Option<&mut Option<Client>>,_settings:Option<&mut BrowserSettings>,_extra_info:Option<&mut Option<DictionaryValue>>,_no_javascript_access:Option<&mut i32>)->i32{
  let url=target_url.map(|u|u.to_string()).unwrap_or_default();let mut state=self.shared.lock().unwrap();
  if !state.human||state.closing||_user_gesture==0||state.popups.len()+state.pending_windows.len()>=3||!(url.is_empty()||url=="about:blank"||url.starts_with("https://")||url.starts_with("http://")){state.notice=Some("popup-needs-human".into());return 1;}
  let (Some(info),Some(client))=(window_info,client)else{return 1;};
  let mut host=popup_url(&url);if host.as_bytes().is_empty(){host=popup_url(&browser.as_ref().and_then(|b|b.main_frame()).map(|f|CefString::from(&f.url()).to_string()).unwrap_or_default());}
  let window=unsafe{atz_create_popup(state.container as *mut c_void,host.as_ptr())};if window.is_null(){return 1;}
  let key=(browser.map(|b|b.identifier()).unwrap_or_default(),popup_id);state.pending_windows.insert(key,window as usize);drop(state);
  *info=WindowInfo{runtime_style:RuntimeStyle::ALLOY,..Default::default()}.set_as_child(unsafe{atz_popup_content(window)},&Rect{x:0,y:0,width:600,height:680});
  *client=Some(PageClient::new(self.shared.clone(),window as usize));0
 }
 fn on_before_popup_aborted(&self,browser:Option<&mut Browser>,popup_id:i32){let key=(browser.map(|b|b.identifier()).unwrap_or_default(),popup_id);let window=self.shared.lock().unwrap().pending_windows.remove(&key);if let Some(window)=window{unsafe{atz_destroy_popup(window as *mut c_void);}}}
 fn on_after_created(&self,browser:Option<&mut Browser>){if self.popup_window!=0{if let Some(browser)=browser{let mut state=self.shared.lock().unwrap();state.pending_windows.retain(|_,window|*window!=self.popup_window);state.popups.insert(browser.identifier(),browser.clone());let closing=state.closing;drop(state);POPUP_BROWSERS.with(|map|map.borrow_mut().insert(self.popup_window,browser.clone()));if closing{if let Some(host)=browser.host(){host.close_browser(1);}}}}}
 fn do_close(&self,browser:Option<&mut Browser>)->i32{
  if self.popup_window!=0{return 0;} // Native popup delegate follows TryCloseBrowser's two-phase close.
  // The Workroom window contains trusted UI as well. Destroy only CEF's child
  // view; its deallocator notifies CEF's WindowDestroyed, then OnBeforeClose.
  if let Some(host)=browser.and_then(|browser|browser.host()){unsafe{atz_detach_browser_view(host.window_handle());}}1
 }
 fn on_before_close(&self,browser:Option<&mut Browser>){let mut state=self.shared.lock().unwrap();if self.popup_window!=0{if let Some(browser)=browser{state.popups.remove(&browser.identifier());}drop(state);POPUP_BROWSERS.with(|map|map.borrow_mut().remove(&self.popup_window));unsafe{atz_destroy_popup(self.popup_window as *mut c_void);}}else{state.closed=true;}}
}}
wrap_dialog_handler!{struct Files{shared:Arc<Mutex<Shared>>,}impl DialogHandler{
 fn on_file_dialog(&self,_browser:Option<&mut Browser>,_mode:FileDialogMode,_title:Option<&CefString>,_default_file_path:Option<&CefString>,_accept_filters:Option<&mut CefStringList>,_accept_extensions:Option<&mut CefStringList>,_accept_descriptions:Option<&mut CefStringList>,callback:Option<&mut FileDialogCallback>)->i32{
  let mut state=self.shared.lock().unwrap();if !state.human{state.notice=Some("file-needs-human".into());if let Some(cb)=callback{cb.cancel();}return 1;}state.uploads+=1;drop(state);
  #[cfg(feature="fixtures")]{if let Some(cb)=callback{if let Ok(root)=std::env::var("ATZ_QA_ROOT"){let mut paths=CefStringList::new();paths.append(&Path::new(&root).join("upload-probe.txt").to_string_lossy());cb.cont(Some(&mut paths));return 1;}}}
  0 // CEF's native file chooser; only the human chooses a file.
 }
}}
wrap_download_handler!{struct Downloads{shared:Arc<Mutex<Shared>>,}impl DownloadHandler{
 fn can_download(&self,_browser:Option<&mut Browser>,_url:Option<&CefString>,_request_method:Option<&CefString>)->i32{let mut state=self.shared.lock().unwrap();if !state.human{state.notice=Some("download-needs-human".into());return 0;}1}
 fn on_before_download(&self,_browser:Option<&mut Browser>,_download_item:Option<&mut DownloadItem>,_suggested_name:Option<&CefString>,callback:Option<&mut BeforeDownloadCallback>)->i32{
  let mut state=self.shared.lock().unwrap();if !state.human{return 1;}state.downloads+=1;drop(state);
  if let Some(cb)=callback{
   #[cfg(feature="fixtures")]{if let Ok(root)=std::env::var("ATZ_QA_ROOT"){cb.cont(Some(&CefString::from(Path::new(&root).join("download-probe.txt").to_string_lossy().as_ref())),0);return 1;}}
   cb.cont(None,1); // Native Save dialog; never accept a page-supplied filesystem path.
  }1
 }
}}
// Parse the host with Foundation: cef-rs 156 parse_url clones its out-parameter without copying it back.
fn popup_url(url:&str)->std::ffi::CString{std::ffi::CString::new(if url.starts_with("http://")||url.starts_with("https://"){url}else{""}).unwrap_or_default()}
wrap_display_handler!{struct PopupDisplay{window:usize,}impl DisplayHandler{
 fn on_address_change(&self,_browser:Option<&mut Browser>,frame:Option<&mut Frame>,url:Option<&CefString>){if frame.is_some_and(|f|f.is_main()!=0){let host=popup_url(&url.map(|u|u.to_string()).unwrap_or_default());if !host.as_bytes().is_empty(){unsafe{atz_popup_host(self.window as *mut c_void,host.as_ptr());}}}}
}}
// Popup clients deliberately do not publish into their owning tab's page state.
wrap_display_handler!{struct Display{shared:Arc<Mutex<Shared>>,}impl DisplayHandler{
 fn on_title_change(&self,_browser:Option<&mut Browser>,title:Option<&CefString>){self.shared.lock().unwrap().title=title.map(|t|t.to_string().chars().take(300).collect()).unwrap_or_default();}
 fn on_loading_progress_change(&self,_browser:Option<&mut Browser>,progress:f64){self.shared.lock().unwrap().progress=if progress.is_finite(){progress.clamp(0.,1.)}else{0.};}
 fn on_console_message(&self,_browser:Option<&mut Browser>,level:LogSeverity,_message:Option<&CefString>,_source:Option<&CefString>,_line:i32)->i32{if level==LogSeverity::ERROR||level==LogSeverity::FATAL{let mut s=self.shared.lock().unwrap();s.console_errors=s.console_errors.saturating_add(1);}0}
}}
wrap_load_handler!{struct Load{shared:Arc<Mutex<Shared>>,}impl LoadHandler{
 fn on_load_start(&self,_browser:Option<&mut Browser>,frame:Option<&mut Frame>,_transition_type:TransitionType){if frame.is_some_and(|f|f.is_main()!=0){let mut s=self.shared.lock().unwrap();s.load_error=None;s.console_errors=0;}}
 fn on_load_error(&self,_browser:Option<&mut Browser>,frame:Option<&mut Frame>,error_code:Errorcode,error_text:Option<&CefString>,failed_url:Option<&CefString>){if error_code!=Errorcode::ABORTED&&frame.is_some_and(|f|f.is_main()!=0){self.shared.lock().unwrap().load_error=Some(json!({"code":error_code.get_raw(),"text":error_text.map(|t|t.to_string().chars().take(300).collect::<String>()),"url":failed_url.map(|u|u.to_string())}));}}
}}
wrap_keyboard_handler!{struct Keyboard{shared:Arc<Mutex<Shared>>,}impl KeyboardHandler{
 fn on_pre_key_event(&self,_browser:Option<&mut Browser>,event:Option<&KeyEvent>,os_event:*mut u8,_is_keyboard_shortcut:Option<&mut i32>)->i32{
  let Some(e)=event else{return 0;};
  if e.type_!=KeyEventType::RAWKEYDOWN&&e.type_!=KeyEventType::KEYDOWN{return 0;}
  // Exact unshifted Command chords only; ordinary typing and system/menu chords stay with CEF/AppKit.
  let exact_command=e.modifiers & (sys::cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0|sys::cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0|sys::cef_event_flags_t::EVENTFLAG_ALT_DOWN.0|sys::cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0)==sys::cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0;
  let Some(key)=shortcut::canonical_shortcut(e.unmodified_character,e.native_key_code,exact_command)else{return 0;};
  let s=self.shared.lock().unwrap();if !s.human||s.closed||s.closing{return 0;}let container=s.container;
  let payload=json!({"source":"cef","sessionId":&s.session,"tab":&s.tab,"targetId":&s.target,"key":key.to_string()}).to_string();drop(s);
  let Ok(payload)=std::ffi::CString::new(payload)else{return 0;};
  i32::from(unsafe{atz_forward_shortcut(container as *mut c_void,os_event,payload.as_ptr())})
 }
}}
// CEF invokes this visitor synchronously on its UI thread. Refuse if the snapshot is incomplete.
#[derive(Default)]struct History{entries:Vec<(i32,bool)>,current:Option<i32>,total:i32}
wrap_navigation_entry_visitor!{struct HistoryVisitor{history:Arc<Mutex<History>>,}impl NavigationEntryVisitor{
 fn visit(&self,entry:Option<&mut NavigationEntry>,current:i32,index:i32,total:i32)->i32{let mut h=self.history.lock().unwrap();h.total=total;if current!=0{h.current=Some(index);}if let Some(entry)=entry{h.entries.push((index,entry.has_post_data()!=0));}1}
}}
fn safe_history(browser:&Browser,op:&str)->Result<(),String>{
 let host=browser.host().ok_or("Browser host unavailable")?;let history=Arc::new(Mutex::new(History::default()));let mut visitor=HistoryVisitor::new(history.clone());host.navigation_entries(Some(&mut visitor),0);
 let h=history.lock().unwrap();let current=h.current.ok_or("Navigation history unavailable")?;let target=current+match op{"back"=>-1,"forward"=>1,_=>0};
 if h.entries.len()!=h.total as usize{return Err("Navigation history unavailable".into());}
 if h.entries.iter().find(|(i,_)|*i==target).ok_or("Navigation history unavailable")?.1{return Err("reload-would-resubmit".into());}Ok(())
}
wrap_client!{struct PageClient{shared:Arc<Mutex<Shared>>,popup_window:usize,}impl Client{
 fn display_handler(&self)->Option<DisplayHandler>{Some(if self.popup_window==0{Display::new(self.shared.clone())}else{PopupDisplay::new(self.popup_window)})}
 fn load_handler(&self)->Option<LoadHandler>{(self.popup_window==0).then(||Load::new(self.shared.clone()))}
 fn keyboard_handler(&self)->Option<KeyboardHandler>{(self.popup_window==0).then(||Keyboard::new(self.shared.clone()))}
 fn focus_handler(&self)->Option<FocusHandler>{Some(Focus::new(self.shared.clone()))}
 fn request_handler(&self)->Option<RequestHandler>{Some(RequestGuard::new())}
 fn life_span_handler(&self)->Option<LifeSpanHandler>{Some(Life::new(self.shared.clone(),self.popup_window))}
 fn dialog_handler(&self)->Option<DialogHandler>{Some(Files::new(self.shared.clone()))}
 fn download_handler(&self)->Option<DownloadHandler>{Some(Downloads::new(self.shared.clone()))}
}}
wrap_dev_tools_message_observer!{struct TargetObserver{shared:Arc<Mutex<Shared>>,}impl DevToolsMessageObserver{
 fn on_dev_tools_method_result(&self,_browser:Option<&mut Browser>,message_id:i32,success:i32,result:Option<&[u8]>){
  if message_id!=1{return;}let mut state=self.shared.lock().unwrap();
  #[cfg(feature="fixtures")]{if state.qa_drop_target{return;}} // QA: the reply never arrives.
  state.target_results=state.target_results.saturating_add(1);
  let value=result.and_then(|raw|serde_json::from_slice::<Value>(raw).ok());
  if success!=1{state.target_failures=state.target_failures.saturating_add(1);state.last_target_error=value.as_ref().and_then(|v|v["code"].as_i64());return;}
  if let Some(id)=value.as_ref().and_then(|v|v["targetInfo"]["targetId"].as_str()){state.target=Some(id.to_string());}
 }
 fn on_dev_tools_agent_attached(&self,_browser:Option<&mut Browser>){let mut state=self.shared.lock().unwrap();state.devtools_attaches=state.devtools_attaches.saturating_add(1);}
 fn on_dev_tools_agent_detached(&self,_browser:Option<&mut Browser>){let mut state=self.shared.lock().unwrap();state.devtools_detaches=state.devtools_detaches.saturating_add(1);}
}}
extern "C" fn pump(){
 PUMPS.fetch_add(1,Ordering::Relaxed);do_message_loop_work();
 // CEF's official external-pump sample schedules a <=33 ms safety wake-up
 // even when Chromium posts no new schedule callback. Without it an async
 // disk-profile load can stall after only three calls. Stop this fallback
 // when the engine is ready and no profile initialization/page remains active.
 let active=!READY.load(Ordering::SeqCst)||RUNTIME.with(|r|r.try_borrow().map_or(true,|slot|slot.as_ref().is_some_and(|runtime|runtime.pending.values().any(|(_,ready,_)|!ready.load(Ordering::SeqCst))||runtime.views.values().any(|view|{let s=view.shared.lock().unwrap();!s.closed||!s.popups.is_empty()}))));
 if active{unsafe{atz_schedule_pump(33);}}
}
pub fn initialize(root:&Path)->Result<Engine,String>{
 let loader=library_loader::LibraryLoader::new(&std::env::current_exe().map_err(|e|e.to_string())?,false);
 if !loader.load(){return Err("Embedded Chromium framework is missing from this app bundle.".into());}
 let _=api_hash(sys::CEF_API_VERSION_LAST,0);
 std::fs::create_dir_all(root).map_err(|e|e.to_string())?;
 let root=root.canonicalize().map_err(|e|e.to_string())?;
 use std::os::unix::fs::PermissionsExt;
 std::fs::set_permissions(&root,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
 let listener=std::net::TcpListener::bind("127.0.0.1:0").map_err(|e|e.to_string())?;let port=listener.local_addr().unwrap().port();drop(listener);
 unsafe{atz_install_cef_protocol();atz_start_pump(pump);}
 let executable=std::env::current_exe().unwrap();let name=executable.file_name().unwrap().to_string_lossy();
 let helper=executable.parent().unwrap().parent().unwrap().join(format!("Frameworks/{name} Helper.app/Contents/MacOS/{name} Helper"));
 let settings=Settings{no_sandbox:0,external_message_pump:1,command_line_args_disabled:1,remote_debugging_port:port as i32,root_cache_path:CefString::from(root.to_string_lossy().as_ref()),browser_subprocess_path:CefString::from(helper.to_string_lossy().as_ref()),log_file:CefString::from(root.join("cef.log").to_string_lossy().as_ref()),..Default::default()};
 let args=args::Args::new();let mut app=CefApp::new();
 if initialize_cef(Some(args.as_main_args()),Some(&settings),Some(&mut app),std::ptr::null_mut())!=1{return Err("Chromium initialization failed.".into());}
 RUNTIME.with(|r|*r.borrow_mut()=Some(Runtime{root:root.to_path_buf(),port,views:HashMap::new(),pending:HashMap::new()}));unsafe{atz_schedule_pump(0);}Ok(Engine{loader})
}
// Avoid shadowing this module's initialize entry point.
fn initialize_cef(args:Option<&MainArgs>,settings:Option<&Settings>,app:Option<&mut App>,sandbox:*mut u8)->i32{cef::initialize(args,settings,app,sandbox)}
fn safe_id(s:&str)->bool{(8..=160).contains(&s.len())&&s.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'||b==b'_')}
fn safe_tab(s:&str)->bool{(1..=16).contains(&s.len())&&s.bytes().all(|b|b.is_ascii_lowercase()||b.is_ascii_digit())}
/// One Workroom's tabs are separate native views sharing its profile. Its first tab keeps the Workroom's own key, so a
/// caller that names no tab still reaches it; another tab adds its name after `~`, which no session id contains.
fn view_key(id:&str,tab:Option<&str>)->Result<String,String>{match tab{None|Some("main")=>Ok(id.to_string()),Some(t) if safe_tab(t)=>Ok(format!("{id}~{t}")),_=>Err("Invalid browser tab.".into())}}
fn tab_name(key:&str)->&str{key.split_once('~').map_or("main",|(_,t)|t)}
const TABS_PER_WORKROOM:usize=6;
/// This Workroom's own tabs, oldest first: never another Workroom's views.
fn session_tabs(runtime:&Runtime,id:&str)->Value{
 let mut mine:Vec<(&String,&View)>=runtime.views.iter().filter(|(_,v)|v.session==id).collect();mine.sort_by_key(|(_,v)|v.created);
 Value::Array(mine.into_iter().map(|(key,view)|{let s=view.shared.lock().unwrap();let url=view.browser.main_frame().map(|f|CefString::from(&f.url()).to_string());json!({"tab":tab_name(key),"title":s.title,"targetId":s.target,"url":url,"closed":s.closed,"closing":s.closing,"visible":unsafe{atz_container_visible(view.container)},"loading":view.browser.is_loading()!=0,"profileKey":view.profile_key,"popupCount":s.popups.len()})}).collect())
}
fn view_status(view:&View,id:&str,key:&str,port:u16,tabs:Value)->Value{
 let shared=view.shared.lock().unwrap();let frame=view.browser.main_frame();let url=frame.as_ref().map(|f|CefString::from(&f.url()).to_string());let mut rect=[0.;4];let mut window_rect=[0.;5];unsafe{atz_container_rect(view.container,rect.as_mut_ptr());atz_container_window_rect(view.container,window_rect.as_mut_ptr());}
 json!({"available":true,"sessionId":id,"tab":tab_name(key),"tabs":tabs,"targetId":shared.target,"port":port,"human":shared.human,"closed":shared.closed,"closing":shared.closing,"url":url,"visible":unsafe{atz_container_visible(view.container)},"rect":rect,"windowRect":window_rect,"popupCount":shared.popups.len(),"notice":shared.notice,"downloads":shared.downloads,"uploads":shared.uploads,"profileKey":view.profile_key,"loading":view.browser.is_loading()!=0,"title":shared.title,"canGoBack":view.browser.can_go_back()!=0,"canGoForward":view.browser.can_go_forward()!=0,"progress":shared.progress,"loadError":shared.load_error,"consoleErrors":shared.console_errors,"blockedInputs":unsafe{atz_container_blocked(view.container)},"focused":unsafe{atz_container_focused(view.container)},"readiness":{"ageMs":view.created.elapsed().as_millis(),"navigations":view.navigations,"frameValid":frame.as_ref().is_some_and(|f|f.is_valid()!=0),"targetProbes":view.target_probes,"targetSends":view.target_sends,"targetResults":shared.target_results,"targetFailures":shared.target_failures,"lastTargetError":shared.last_target_error,"devtoolsAttaches":shared.devtools_attaches,"devtoolsDetaches":shared.devtools_detaches,"pumps":PUMPS.load(Ordering::Relaxed),"schedules":SCHEDULES.load(Ordering::Relaxed)}})
}
/// `tab` names one view of the Workroom (`main` when omitted). Without a tab, lock/unlock/close-popups/close/hide act on
/// every tab of the Workroom (AI ownership and closing cover the whole Workroom) and `tabs` lists them.
pub fn action(window:*mut c_void,label:&str,id:&str,op:&str,url:Option<&str>,rect:Option<[f64;4]>,profile_key:Option<&str>,tab:Option<&str>)->Result<Value,String>{
 if !safe_id(id){return Err("Invalid Workroom session.".into());}
 let profile_key=profile_key.unwrap_or(id);if !safe_id(profile_key){return Err("Invalid browser profile key.".into());}
 let key=view_key(id,tab)?;
 RUNTIME.with(|slot|{let mut slot=slot.borrow_mut();let runtime=slot.as_mut().ok_or("Chromium unavailable")?;
  if op=="open"{runtime.views.retain(|_,view|{let state=view.shared.lock().unwrap();let done=state.closed&&state.popups.is_empty()&&state.pending_windows.is_empty();drop(state);if done{unsafe{atz_release_container(view.container);}}!done});}
  if tab.is_none()&&matches!(op,"tabs"|"lock"|"unlock"|"close-popups"|"close"|"hide"){
   if runtime.views.values().any(|v|v.session==id&&v.window!=label){return Err("This browser belongs to another Workroom window.".into());}
   let mine:Vec<String>=runtime.views.iter().filter(|(_,v)|v.session==id).map(|(k,_)|k.clone()).collect();
   if op=="tabs"{return Ok(json!({"available":true,"sessionId":id,"port":runtime.port,"tabs":session_tabs(runtime,id)}));}
   if mine.is_empty(){return Err("Open the embedded browser first".into());}
   // A login popup in any tab keeps the whole Workroom with the person.
   if op=="lock"&&mine.iter().any(|k|{let s=runtime.views[k].shared.lock().unwrap();!s.popups.is_empty()||!s.pending_windows.is_empty()}){return Err("Close the login popup before handing control to AI.".into());}
   for k in &mine{let view=&runtime.views[k];
    // A tab already closed or closing is not closed again.
    if op=="close"&&{let s=view.shared.lock().unwrap();s.closed||s.closing}{continue;}
    match op{
    "lock"=>{view.shared.lock().unwrap().human=false;unsafe{atz_container_input(view.container,false);}},
    "unlock"=>{let mut state=view.shared.lock().unwrap();state.human=true;state.notice=None;unsafe{atz_container_input(view.container,true);}},
    "close-popups"=>{let popups:Vec<_>=view.shared.lock().unwrap().popups.values().cloned().collect();for popup in popups{if let Some(host)=popup.host(){host.close_browser(1);}}},
    "close"=>{let popups:Vec<_>={let mut state=view.shared.lock().unwrap();state.closing=true;state.popups.values().cloned().collect()};for popup in popups{if let Some(host)=popup.host(){host.close_browser(1);}}if let Some(host)=view.browser.host(){host.close_browser(1);}unsafe{atz_container_hidden(view.container,true);}},
    _=>unsafe{atz_container_hidden(view.container,true);},
   }}
   let tabs=session_tabs(runtime,id);let first=runtime.views.get(&key).map(|_|key.clone()).unwrap_or_else(||mine[0].clone());
   return Ok(view_status(&runtime.views[&first],id,&first,runtime.port,tabs));
  }
  if op=="open"&&!runtime.views.contains_key(&key){
   // The idle engine has no safety timer. A new profile admission wakes it explicitly.
   unsafe{atz_schedule_pump(0);}
   if !READY.load(Ordering::SeqCst){return Ok(json!({"available":true,"preparing":true,"phase":"engine","pumps":PUMPS.load(Ordering::Relaxed),"schedules":SCHEDULES.load(Ordering::Relaxed)}));}
   // A live tab of this Workroom lends its profile to a new tab; one still closing does not.
   let sibling=runtime.views.values().filter(|v|v.session==id&&{let s=v.shared.lock().unwrap();!s.closed&&!s.closing}).min_by_key(|v|v.created);
   if let Some(sibling)=sibling{
    if sibling.window!=label{return Err("This browser belongs to another Workroom window.".into());}
    if sibling.profile_key!=profile_key{return Err("Close the current browser before restoring another profile.".into());}
    if runtime.views.values().filter(|v|v.session==id&&!v.shared.lock().unwrap().closed).count()>=TABS_PER_WORKROOM{return Err("This Workroom already has 6 tabs.".into());}
   }else{
    let workrooms:std::collections::HashSet<&str>=runtime.views.values().map(|v|v.session.as_str()).chain(runtime.pending.keys().map(String::as_str)).collect();
    if workrooms.len()>=4&&!workrooms.contains(id){return Err("Four embedded Workroom pages are already open.".into());}
    // A context per Workroom; never borrow the user's Chrome profile directory or cookies.
    if runtime.views.iter().any(|(_,view)|view.session!=id&&view.profile_key==profile_key&&!view.shared.lock().unwrap().closed){return Err("This saved browser profile is already open in another Workroom.".into());}
    if runtime.pending.iter().any(|(other,(_,_,key))|other!=id&&key==profile_key){return Err("This saved browser profile is preparing in another Workroom.".into());}
   }
   let shared_context=sibling.map(|v|v.context.clone());
   let mut context=if let Some(context)=shared_context{context}else{
    let cache=runtime.root.join(profile_key);std::fs::create_dir_all(&cache).map_err(|e|e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&cache,std::fs::Permissions::from_mode(0o700)).map_err(|e|e.to_string())?;
    // One admission per Workroom: a newer request for another profile replaces one an ended request left preparing.
    if runtime.pending.get(id).is_some_and(|(_,_,key)|key!=profile_key){runtime.pending.remove(id);}
    if !runtime.pending.contains_key(id){
     let ready=Arc::new(AtomicBool::new(false));let mut handler=ProfileReady::new(ready.clone());
     let context=request_context_create_context(Some(&RequestContextSettings{cache_path:CefString::from(cache.to_string_lossy().as_ref()),persist_session_cookies:1,..Default::default()}),Some(&mut handler)).ok_or("Browser profile unavailable")?;
     runtime.pending.insert(id.to_string(),(context,ready,profile_key.to_string()));
    }
    if !runtime.pending[id].1.load(Ordering::SeqCst){return Ok(json!({"available":true,"preparing":true,"phase":"profile","sessionId":id,"tab":tab_name(&key),"pumps":PUMPS.load(Ordering::Relaxed),"schedules":SCHEDULES.load(Ordering::Relaxed)}));}
    runtime.pending.remove(id).unwrap().0
   };
   let container=unsafe{atz_create_container(window,0.,0.,1.,1.)};unsafe{atz_container_hidden(container,true);}
   let info=WindowInfo{runtime_style:RuntimeStyle::ALLOY,..Default::default()}.set_as_child(container,&Rect{x:0,y:0,width:1,height:1});
   // A new tab starts as locked as its Workroom: AI ownership covers every tab.
   let human=runtime.views.values().filter(|v|v.session==id).all(|v|v.shared.lock().unwrap().human);
   let shared=Arc::new(Mutex::new(Shared{session:id.to_string(),tab:tab_name(&key).to_string(),human,container:container as usize,..Default::default()}));let mut client=PageClient::new(shared.clone(),0);if !human{unsafe{atz_container_input(container,false);}}
   // QA only: the first view of the named Workroom never hears its target replies.
   #[cfg(feature="fixtures")]{if std::env::var("ATZ_QA_DROP_TARGET_SESSION").is_ok_and(|session|session==id)&&!QA_DROP_USED.swap(true,Ordering::SeqCst){shared.lock().unwrap().qa_drop_target=true;}}
   let Some(browser)=browser_host_create_browser_sync(Some(&info),Some(&mut client),Some(&CefString::from("about:blank")),Some(&BrowserSettings::default()),None,Some(&mut context))else{unsafe{atz_release_container(container);}return Err("Browser creation failed".into());};
   let host=browser.host().ok_or("Browser host unavailable")?;let mut observer=TargetObserver::new(shared.clone());let registration=host.add_dev_tools_message_observer(Some(&mut observer)).ok_or("Browser observer unavailable")?;
   runtime.views.insert(key.clone(),View{browser,container,context,registration,shared,window:label.to_string(),session:id.to_string(),profile_key:profile_key.to_string(),target_probes:0,target_sends:0,last_target_probe:None,created:std::time::Instant::now(),navigations:0});
  }
  let port=runtime.port;
  {
  let view=runtime.views.get_mut(&key).ok_or("Open the embedded browser first")?;if view.window!=label{return Err("This browser belongs to another Workroom window.".into());}
  if op=="open"&&view.profile_key!=profile_key{return Err("Close the current browser before restoring another profile.".into());}
  // A cold renderer can lose the first discovery reply. Probe only this exact
  // browser, at most16times and no faster than twice a second. Never replay a
  // navigation or borrow another target from the browser-wide target list.
  // Only a human's explicit retry re-arms one more bounded round, and only while
  // the target is still unknown. Each tab has its own probe budget.
  if op=="retarget"&&view.shared.lock().unwrap().target.is_none(){view.target_probes=0;view.last_target_probe=None;}
  let discover=matches!(op,"open"|"status"|"retarget")&&view.target_probes<16&&view.last_target_probe.map_or(true,|last|last.elapsed()>=std::time::Duration::from_millis(500))&&{let s=view.shared.lock().unwrap();s.target.is_none()&&!s.closed&&!s.closing};
  if discover{view.target_probes+=1;view.last_target_probe=Some(std::time::Instant::now());if let Some(host)=view.browser.host(){if host.send_dev_tools_message(Some(br#"{"id":1,"method":"Target.getTargetInfo"}"#))!=0{view.target_sends+=1;}}}
  match op{
   "open"|"status"|"retarget"=>{},
   #[cfg(feature="fixtures")]
   "qa-forget-target"=>{view.shared.lock().unwrap().target=None;},
   #[cfg(feature="fixtures")]
   "qa-keep-target-replies"=>{view.shared.lock().unwrap().qa_drop_target=false;},
   "frame"=>{let r=rect.ok_or("Browser rectangle required")?;if r.iter().any(|n|!n.is_finite()||*n<0.||*n>20000.){return Err("Invalid browser rectangle".into());}unsafe{if !atz_container_frame(view.container,r[0],r[1],r[2],r[3]){return Err("Trusted Workroom viewport unavailable.".into());}atz_container_hidden(view.container,false);}},
   "hide"=>unsafe{atz_container_hidden(view.container,true);},
   "back"|"forward"|"reload"|"stop"=>{
    {let s=view.shared.lock().unwrap();if !s.human{return Err("Take control before navigating.".into());}if s.closed||s.closing{return Err("Browser is closing.".into());}}
    if op=="stop"{view.browser.stop_load();}else if !(op=="back"&&view.browser.can_go_back()==0||op=="forward"&&view.browser.can_go_forward()==0){safe_history(&view.browser,op)?;match op{"back"=>view.browser.go_back(),"forward"=>view.browser.go_forward(),_=>view.browser.reload()};view.navigations=view.navigations.saturating_add(1);}
   },
   #[cfg(feature="fixtures")]
   "qa-focus"=>{unsafe{atz_qa_input(view.container,3);}if let Some(host)=view.browser.host(){host.set_focus(1);}},
   #[cfg(feature="fixtures")]
   "qa-click"|"qa-scroll"|"qa-shortcut"|"qa-shortcut-korean"|"qa-shortcut-caps"=>unsafe{atz_qa_input(view.container,match op{"qa-click"=>0,"qa-scroll"=>1,"qa-shortcut-korean"=>4,"qa-shortcut-caps"=>5,_=>2});},
   #[cfg(feature="fixtures")]
   "qa-popup-geometry"=>{let s=view.shared.lock().unwrap();let popup=POPUP_BROWSERS.with(|map|map.borrow().iter().find(|(_,b)|s.popups.contains_key(&b.identifier())).map(|(w,_)|*w));let mut geometry=[0.;10];if let Some(w)=popup{unsafe{atz_popup_geometry(w as *mut c_void,geometry.as_mut_ptr());}}return Ok(json!({"geometry":geometry}));},
   "navigate"=>{if !view.shared.lock().unwrap().human{return Err("Take control before navigating.".into());}let url=url.ok_or("URL required")?;if url.len()>4096||!(url.starts_with("http://")||url.starts_with("https://")){return Err("HTTP(S) URL required".into());}let Some(frame)=view.browser.main_frame().filter(|frame|frame.is_valid()!=0)else{return Ok(json!({"available":true,"preparing":true,"phase":"renderer"}));};frame.load_url(Some(&CefString::from(url)));view.navigations=view.navigations.saturating_add(1);},
   "close-popups"=>{let popups:Vec<_>=view.shared.lock().unwrap().popups.values().cloned().collect();for popup in popups{if let Some(host)=popup.host(){host.close_browser(1);}}},
   "close"=>{let popups:Vec<_>={let mut state=view.shared.lock().unwrap();state.closing=true;state.popups.values().cloned().collect()};for popup in popups{if let Some(host)=popup.host(){host.close_browser(1);}}if let Some(host)=view.browser.host(){host.close_browser(1);}unsafe{atz_container_hidden(view.container,true);}},
   _=>return Err("Unknown native browser operation".into())
  }
  }
  let tabs=session_tabs(runtime,id);Ok(view_status(&runtime.views[&key],id,&key,port,tabs))
 })
}
pub fn window_has_browsers(label:&str)->bool{RUNTIME.with(|slot|slot.borrow().as_ref().is_some_and(|runtime|runtime.views.values().any(|v|{let s=v.shared.lock().unwrap();v.window==label&&(!s.closed||!s.popups.is_empty()||!s.pending_windows.is_empty())})))}
pub fn before_exit(){
 unsafe{atz_stop_pump();}
 RUNTIME.with(|slot|{if let Some(runtime)=slot.borrow_mut().take(){
  for view in runtime.views.values(){let popups:Vec<_>={let mut state=view.shared.lock().unwrap();state.closing=true;state.popups.values().cloned().collect()};for popup in popups{if let Some(host)=popup.host(){host.close_browser(1);}}if let Some(host)=view.browser.host(){host.close_browser(1);}}
  let deadline=std::time::Instant::now()+std::time::Duration::from_secs(5);
  while runtime.views.values().any(|v|{let s=v.shared.lock().unwrap();!s.closed||!s.popups.is_empty()||!s.pending_windows.is_empty()})&&std::time::Instant::now()<deadline{do_message_loop_work();unsafe{atz_drain_close_events();}}
  let remaining=runtime.views.values().filter(|v|{let s=v.shared.lock().unwrap();!s.closed||!s.popups.is_empty()||!s.pending_windows.is_empty()}).count();println!("ATZ_BROWSER_CLOSE_PENDING:{remaining}");
  for view in runtime.views.into_values(){unsafe{atz_release_container(view.container);}drop((view.browser,view.context,view.registration));}
 }});
}
impl Engine{pub fn shutdown(self){cef::shutdown();drop(self.loader);}}
