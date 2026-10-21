import AppKit
import WebKit

@MainActor final class PersonaMac: NSObject, NSApplicationDelegate, WKNavigationDelegate {
    var window:NSWindow!
    var web:WKWebView!
    var config:[String:String]=[:]
    func applicationDidFinishLaunching(_ notification:Notification) {
        do {
            let data=try Data(contentsOf:Bundle.main.url(forResource:"bootstrap",withExtension:"json")!)
            config=try JSONSerialization.jsonObject(with:data) as! [String:String]
            window=NSWindow(contentRect:NSRect(x:120,y:80,width:1100,height:850),styleMask:[.titled,.closable,.resizable,.miniaturizable],backing:.buffered,defer:false)
            window.title="AgentsToZ · 실기 페르소나"
            let container=NSView(frame:window.contentView!.bounds);container.autoresizingMask=[.width,.height]
            web=WKWebView(frame:NSRect(x:0,y:0,width:1100,height:800));web.autoresizingMask=[.width,.height];web.navigationDelegate=self
            if #available(macOS 13.3,*) { web.isInspectable=true }
            let capture=NSButton(title:"증거 저장",target:self,action:#selector(captureEvidence));capture.frame=NSRect(x:16,y:810,width:130,height:30);capture.autoresizingMask=[.minYMargin]
            container.addSubview(web);container.addSubview(capture);window.contentView=container;window.makeKeyAndOrderFront(nil)
            web.load(URLRequest(url:URL(string:config["url"]!)!));NSApp.activate(ignoringOtherApps:true)
        } catch { NSLog("Persona Mac preparation failed: %@",String(describing:error)) }
    }
    func webView(_ webView:WKWebView,decidePolicyFor navigationAction:WKNavigationAction,decisionHandler:@escaping(WKNavigationActionPolicy)->Void){
        let original=URL(string:config["url"]!)!,candidate=navigationAction.request.url
        decisionHandler(candidate?.host==original.host&&candidate?.port==original.port ? .allow:.cancel)
    }
    @objc func captureEvidence(){
        let folder=URL(fileURLWithPath:config["evidence"]!);try? FileManager.default.createDirectory(at:folder,withIntermediateDirectories:true)
        web.evaluateJavaScript("JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scale:visualViewport?.scale,secure:isSecureContext,randomUUID:typeof crypto.randomUUID,state:window.__nativePersona,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),body:document.body.innerText.slice(-8000)})"){value,error in
            guard let value=value as? String else { return }
            let result:[String:Any]=["sourceFingerprint":self.config["sourceFingerprint"] ?? "unknown","actualMac":true,"nativeInteraction":true,"realAI":false,"productionData":false,"geometry":value,"error":error.map(String.init(describing:)) ?? ""]
            try? JSONSerialization.data(withJSONObject:result).write(to:folder.appendingPathComponent("mac-result.json"),options:.atomic)
        }
        web.takeSnapshot(with:nil){image,_ in guard let tiff=image?.tiffRepresentation,let bitmap=NSBitmapImageRep(data:tiff),let png=bitmap.representation(using:.png,properties:[:]) else {return};try? png.write(to:folder.appendingPathComponent("mac-result.png"),options:.atomic)}
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool { true }
}
@main struct WorkroomPersonaMacApp {
    @MainActor static func main() {
        let app=NSApplication.shared
        let delegate=PersonaMac()
        app.delegate=delegate
        app.setActivationPolicy(.regular)
        app.run()
    }
}
