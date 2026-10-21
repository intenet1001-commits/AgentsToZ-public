use std::sync::Mutex;
use std::sync::atomic::{AtomicBool,Ordering};
use tauri::{Emitter,Manager};

pub(crate) const LABEL:&str="voice-dock";
/// Tells the main window that the 「아젠투지 호출」 window is gone, so it can offer a way to reopen it
/// (VOC 2026-10-15: closing it used to leave no way back short of quitting the app).
pub(crate) const CLOSED_EVENT:&str="voice-dock:closed";
static OPEN:Mutex<()>=Mutex::new(());
/// Cleared in the Destroyed handler before main is told, so a state query never sees a dying window as open.
static ALIVE:AtomicBool=AtomicBool::new(false);
static CONTEXT:Mutex<Option<VoiceContext>>=Mutex::new(None);

#[derive(Clone,Default,serde::Serialize,serde::Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
pub(crate) struct VoiceContext {device_name:String,ops_available:bool,devices:Vec<VoiceDevice>}
#[derive(Clone,serde::Serialize,serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct VoiceDevice {key:String,name:String}
fn bounded(value:&str,max:usize)->bool {value.chars().count()<=max&&!value.chars().any(char::is_control)}
fn validate_context(context:&VoiceContext)->bool {
    context.devices.len()<=64&&bounded(&context.device_name,100)&&context.devices.iter().all(|d|!d.key.is_empty()&&bounded(&d.key,1000)&&bounded(&d.name,100))
}
pub(crate) fn allows_runtime(label:&str,path:&str,method:&str)->bool {
    if label==LABEL {return path=="/api/agent-runtime/voice"&&method=="POST";}
    label=="main"||crate::workroom_popout::is_workroom_popout_label(label)
}
fn main_window(label:&str)->Result<(),String> {
    if label=="main" {Ok(())}else{Err("메인 앱에서 음성 창을 열어 주세요.".into())}
}
fn notifies_main(event:&tauri::WindowEvent)->bool {matches!(event,tauri::WindowEvent::Destroyed)}
/// The voice window's event handler: on Destroyed, mark it gone first, then tell main.
fn on_voice_window_event(event:&tauri::WindowEvent,notify:impl FnOnce()) {
    if notifies_main(event) {ALIVE.store(false,Ordering::SeqCst);notify();}
}
fn voice_window(window:&tauri::Window)->Result<(),String> {
    if window.label()==LABEL {Ok(())}else{Err("음성 독립 창에서만 사용할 수 있습니다.".into())}
}
#[tauri::command]
pub(crate) async fn open_voice_window(app:tauri::AppHandle,window:tauri::Window,panel:bool)->Result<(),String> {
    main_window(window.label())?;
    let _guard=OPEN.lock().map_err(|_|"음성 창 상태를 확인하지 못했습니다.")?;
    if let Some(existing)=app.get_webview_window(LABEL) {
        if !ALIVE.load(Ordering::SeqCst) {return Err("음성 창을 닫는 중입니다. 잠시 뒤 다시 열어 주세요.".into());}
        if panel {existing.show().map_err(|e|e.to_string())?;let _=existing.unminimize();let _=existing.set_focus();let _=existing.emit("voice-dock:open-panel",());}
        // 「아젠투지 호출 열기」 on a window that still exists but was minimized or hidden must bring it back, not
        // silently succeed. No focus here: the main window also calls this at mount and must not lose focus.
        else {existing.show().map_err(|e|e.to_string())?;let _=existing.unminimize();}
        return Ok(());
    }
    let query=if panel {"index.html?voice-popout=1&panel=1"}else{"index.html?voice-popout=1"};
    let mut builder=tauri::WebviewWindowBuilder::new(&app,LABEL,tauri::WebviewUrl::App(query.into()))
        .title("아젠투지 호출").inner_size(420.0,if panel {700.0}else{200.0})
        .min_inner_size(280.0,116.0).resizable(true).always_on_top(true).skip_taskbar(true).focused(panel);
    if let Some(monitor)=window.current_monitor().ok().flatten() {
        let area=monitor.work_area();let scale=monitor.scale_factor();
        let origin=area.position.to_logical::<f64>(scale);let size=area.size.to_logical::<f64>(scale);
        let height=if panel {700.0_f64.min(size.height-64.0)}else{200.0};
        builder=builder.position(origin.x+(size.width-440.0).max(16.0),origin.y+(size.height-height-48.0).max(16.0));
    }
    #[cfg(target_os="macos")]
    { builder=builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true); }
    let voice=builder.build().map_err(|e|format!("음성 독립 창을 열지 못했습니다: {e}"))?;
    ALIVE.store(true,Ordering::SeqCst);
    // Every way the window ends (our close command, the native close button, app teardown) reaches Destroyed.
    let handle=app.clone();
    voice.on_window_event(move|event|on_voice_window_event(event,||{let _=handle.emit_to("main",CLOSED_EVENT,());}));
    Ok(())
}
/// Whether the 「아젠투지 호출」 window exists — the main window asks at start and when it comes forward.
#[tauri::command]
pub(crate) fn voice_window_open(app:tauri::AppHandle,window:tauri::Window)->Result<bool,String> {
    main_window(window.label())?;Ok(ALIVE.load(Ordering::SeqCst)&&app.get_webview_window(LABEL).is_some())
}
#[tauri::command]
pub(crate) fn set_voice_dock_context(app:tauri::AppHandle,window:tauri::Window,context:VoiceContext)->Result<(),String> {
    if window.label()!="main"||!validate_context(&context) {return Err("음성 창 문맥을 확인하세요.".into());}
    *CONTEXT.lock().map_err(|_|"음성 문맥을 확인하지 못했습니다.")?=Some(context.clone());
    if let Some(voice)=app.get_webview_window(LABEL) {let _=voice.emit("voice-dock:context",context);}Ok(())
}
#[tauri::command]
pub(crate) fn get_voice_dock_context(window:tauri::Window)->Result<VoiceContext,String> {
    voice_window(&window)?;Ok(CONTEXT.lock().map_err(|_|"음성 문맥을 확인하지 못했습니다.")?.clone().unwrap_or_default())
}
fn action_allowed(context:&VoiceContext,kind:&str,key:Option<&str>)->bool {
    match kind {
        "helpdesk"=>key.is_none(),
        "ops"=>key.is_none()&&context.ops_available,
        "device"=>key.is_some_and(|k|context.devices.iter().any(|d|d.key==k)),
        _=>false,
    }
}
#[tauri::command]
pub(crate) async fn voice_dock_action(app:tauri::AppHandle,window:tauri::Window,kind:String,key:Option<String>)->Result<(),String> {
    voice_window(&window)?;
    let context=CONTEXT.lock().map_err(|_|"음성 문맥을 확인하지 못했습니다.")?.clone().unwrap_or_default();
    let allowed=action_allowed(&context,&kind,key.as_deref());
    if !allowed {return Err("현재 음성 창에서 선택할 수 없는 워크룸입니다.".into());}
    if kind=="helpdesk" {
        let main=app.get_webview_window("main").ok_or("본창을 찾지 못했습니다.")?;
        main.show().map_err(|e|e.to_string())?;let _=main.unminimize();
        main.set_focus().map_err(|e|e.to_string())?;
    }
    app.emit_to("main","voice-dock:action",serde_json::json!({"kind":kind,"key":key})).map_err(|e|e.to_string())
}
#[tauri::command]
pub(crate) fn resize_voice_window(app:tauri::AppHandle,window:tauri::Window,height:f64,viewport_height:Option<f64>)->Result<(),String> {
    voice_window(&window)?;
    let Some(voice)=app.get_webview_window(LABEL)else{return Ok(())};let scale=voice.scale_factor().map_err(|e|e.to_string())?;
    let size=voice.inner_size().map_err(|e|e.to_string())?.to_logical::<f64>(scale);
    let height=fitted_window_height(height,viewport_height,size.height)?;
    if (size.height-height).abs()<2.0 {return Ok(());}
    if let Some(monitor)=voice.current_monitor().ok().flatten() {
        let area=monitor.work_area();let origin=area.position.to_logical::<f64>(scale);let available=area.size.to_logical::<f64>(scale);
        let height=height.min(available.height-64.0).max(116.0);
        if let Ok(position)=voice.outer_position() {let position=position.to_logical::<f64>(scale);let y=(position.y+size.height-height).clamp(origin.y+16.0,(origin.y+available.height-height-48.0).max(origin.y+16.0));let _=voice.set_position(tauri::LogicalPosition::new(position.x,y));}
        voice.set_size(tauri::LogicalSize::new(size.width,height)).map_err(|e|e.to_string())?;
    }else{voice.set_size(tauri::LogicalSize::new(size.width,height)).map_err(|e|e.to_string())?;}Ok(())
}
/// WKWebView's visible viewport can be shorter than the native inner size.
/// Preserve that observed inset instead of treating CSS content pixels as the entire window.
fn fitted_window_height(height:f64,viewport:Option<f64>,native_inner:f64)->Result<f64,String> {
    if !height.is_finite()||!(116.0..=760.0).contains(&height)||!native_inner.is_finite()||native_inner<=0.0||viewport.is_some_and(|v|!v.is_finite()||v<=0.0) {
        return Err("음성 창 크기를 확인하세요.".into());
    }
    let inset=(native_inner-viewport.unwrap_or(native_inner)).clamp(0.0,96.0);
    Ok((height+inset).min(760.0))
}
#[tauri::command]
pub(crate) fn close_voice_window(app:tauri::AppHandle,window:tauri::Window)->Result<(),String> {
    voice_window(&window)?;if let Some(voice)=app.get_webview_window(LABEL) {voice.destroy().map_err(|e|e.to_string())?;}Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]fn content_height_preserves_the_observed_native_viewport_inset() {
        assert_eq!(fitted_window_height(188.0,Some(116.0),148.0).unwrap(),220.0);
        assert_eq!(fitted_window_height(188.0,Some(188.0),220.0).unwrap(),220.0);
        assert_eq!(fitted_window_height(116.0,Some(188.0),220.0).unwrap(),148.0);
        assert_eq!(fitted_window_height(188.0,Some(188.0),188.0).unwrap(),188.0);
        assert_eq!(fitted_window_height(188.0,None,188.0).unwrap(),188.0);
        assert_eq!(fitted_window_height(740.0,Some(100.0),600.0).unwrap(),760.0);
        for viewport in [Some(f64::NAN),Some(0.0),Some(-1.0)] {assert!(fitted_window_height(188.0,viewport,188.0).is_err());}
        assert!(fitted_window_height(f64::NAN,None,188.0).is_err());
        assert!(fitted_window_height(761.0,None,188.0).is_err());
    }
    #[test]fn helpdesk_needs_no_ops_setup_but_carries_no_arbitrary_action() {
        let context=VoiceContext::default();
        assert!(action_allowed(&context,"helpdesk",None));
        assert!(!action_allowed(&context,"helpdesk",Some("/tmp/project")));
        for kind in ["install","shell","helpdesk?x=1","ops","device"] {assert!(!action_allowed(&context,kind,None));}
        assert!(!allows_runtime(LABEL,"/api/agent-runtime/helpdesk","POST"));
        let cap:serde_json::Value=serde_json::from_str(include_str!("../capabilities/voice-popout.json")).unwrap();
        assert_eq!(cap["permissions"],serde_json::json!(["core:event:allow-listen","core:event:allow-unlisten","core:window:allow-set-title","core:window:allow-start-dragging"]));
    }
    #[test]fn voice_runtime_is_limited_to_voice_posts() {
        assert!(allows_runtime(LABEL,"/api/agent-runtime/voice","POST"));
        for path in ["/api/agent-runtime/tester","/api/agent-runtime/terminals","/api/agent-runtime/voice?x=1","/api/agent-runtime/voice/history"] {assert!(!allows_runtime(LABEL,path,"POST"));}
        assert!(!allows_runtime(LABEL,"/api/agent-runtime/voice","GET"));assert!(!allows_runtime("voice-dock-2","/api/agent-runtime/voice","POST"));
    }
    #[test]fn reopen_state_is_main_window_only() {
        assert!(main_window("main").is_ok());
        for label in [LABEL,"workroom-1","voice-dock-2",""] {assert!(main_window(label).is_err());}
    }
    #[test]fn only_destroying_the_voice_window_tells_main() {
        assert!(notifies_main(&tauri::WindowEvent::Destroyed));
        assert!(!notifies_main(&tauri::WindowEvent::Focused(false)));
        assert!(!notifies_main(&tauri::WindowEvent::Focused(true)));
        assert_eq!(CLOSED_EVENT,"voice-dock:closed");
    }
    #[test]fn destroying_marks_the_window_gone_before_main_is_told() {
        ALIVE.store(true,Ordering::SeqCst);
        let mut told=0;
        on_voice_window_event(&tauri::WindowEvent::Focused(false),||told+=1);
        assert_eq!(told,0);assert!(ALIVE.load(Ordering::SeqCst),"other window events leave the window alive");
        let mut alive_when_told=None;
        on_voice_window_event(&tauri::WindowEvent::Destroyed,||{told+=1;alive_when_told=Some(ALIVE.load(Ordering::SeqCst));});
        assert_eq!(told,1);
        assert_eq!(alive_when_told,Some(false),"a state query answered after the event never sees the dying window as open");
        assert!(!ALIVE.load(Ordering::SeqCst));
    }
    #[test]fn context_refuses_oversize_and_control_characters() {
        assert!(validate_context(&VoiceContext::default()));
        let mut c=VoiceContext::default();c.device_name="a\n".into();assert!(!validate_context(&c));c.device_name="".into();c.devices=(0..65).map(|i|VoiceDevice{key:i.to_string(),name:"Mac".into()}).collect();assert!(!validate_context(&c));
    }
}
