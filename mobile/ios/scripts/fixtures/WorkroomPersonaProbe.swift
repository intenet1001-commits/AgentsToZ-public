import SwiftUI
import WebKit
import AgentsToZCore

@MainActor final class WorkroomPersonaProbe: ObservableObject {
    @Published var session: LANWorkroomSession?
    var fingerprint = "unknown"
    var nativeInput = false
    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    func js(_ code:String) async throws -> Any { try await session!.webView!.evaluateJavaScript(code) }
    func wait(_ code:String) async throws {
        for _ in 0..<150 { if (try? await js(code)) as? Bool == true { return }; try await Task.sleep(for:.milliseconds(100)) }
        throw NSError(domain:"Persona",code:2,userInfo:[NSLocalizedDescriptionKey:"조건을 확인하지 못했습니다: "+code])
    }
    func report(_ stage:String,done:Bool=false,error:String?=nil) async throws {
        let web=session!.webView!
        let geometry=try await js("JSON.stringify({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,scale:visualViewport?.scale,secure:isSecureContext,randomUUID:typeof crypto.randomUUID,subtle:typeof crypto.subtle,state:window.__nativePersona,nativeInput:window.__nativeInputProof,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),body:document.body.innerText.slice(-6000)})") as! String
        var result:[String:Any] = ["sourceFingerprint":fingerprint,"stage":stage,"actualIPhone":true,"deviceModel":UIDevice.current.model,"osVersion":UIDevice.current.systemVersion,"applicationActive":UIApplication.shared.applicationState == .active,"nativeTouch":nativeInput,"done":done,"geometry":geometry,"realAI":false,"productionData":false]
        if let error { result["failed"]=true;result["error"]=error }
        try JSONSerialization.data(withJSONObject:result).write(to:documents.appendingPathComponent("persona-result.json"),options:.atomic)
        try JSONSerialization.data(withJSONObject:result).write(to:documents.appendingPathComponent("persona-"+stage+".json"),options:.atomic)
        if let window=web.window { let image=UIGraphicsImageRenderer(bounds:window.bounds).image{_ in window.drawHierarchy(in:window.bounds,afterScreenUpdates:true)};try image.pngData()?.write(to:documents.appendingPathComponent("persona-"+stage+".png")) }
    }
    func journey() async throws {
        _ = try await js("window.personaButton=(text)=>[...document.querySelectorAll('button,summary')].find(e=>e.getClientRects().length&&e.textContent.replace(/\\s/g,'')===text.replace(/\\s/g,''));window.personaClick=(text)=>{const e=window.personaButton(text);if(!e)throw Error('Missing '+text);e.scrollIntoView({block:'center'});e.click();};window.personaFill=(label,value)=>{const field=[...document.querySelectorAll('label')].find(e=>e.textContent.trim().startsWith(label))?.querySelector('input,textarea,select');if(!field)throw Error('Missing field '+label);Object.getOwnPropertyDescriptor(field.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,value);field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));};true")
        try await wait("Boolean(document.querySelector('.community-list-empty')||document.querySelector('[role=alert]'))")
        try await report("initial")
        if (try await js("Boolean(document.querySelector('[role=alert]'))")) as? Bool == true { throw NSError(domain:"Persona",code:3,userInfo:[NSLocalizedDescriptionKey:"첫 업무 목록 조회에서 오류 안내가 표시됐습니다."]) }
        _ = try await js("personaClick('새 업무');true")
        try await wait("document.querySelector('.community-thread-view')?.dataset.writingNew==='true'")
        _ = try await js("const e=document.querySelector('textarea[aria-label=\"프로젝트에 맡길 업무\"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'첫 업무 연결을 확인해 주세요.');e.dispatchEvent(new Event('input',{bubbles:true}));true")
        try await wait("Boolean(personaButton('업무 맡기기')&&!personaButton('업무 맡기기').disabled)")
        _ = try await js("personaClick('업무 맡기기');true")
        try await wait("Boolean(document.querySelector('[data-testid=community-task-thread]'))")
        try await report("task-created")
        _ = try await js("personaClick('지난 워크룸');true")
        try await wait("Boolean(document.querySelector('[data-testid=remote-workroom-history]'))")
        _ = try await js("document.querySelector('[data-testid=remote-workroom-history] summary').click();true")
        try await wait("document.querySelector('[data-testid=remote-workroom-history-message]')?.textContent.includes('권한')===true")
        try await report("permission-required")
        _ = try await js("personaClick('검증 권한 허용');true")
        try await Task.sleep(for:.milliseconds(200))
        _ = try await js("personaClick('불러오기');true")
        try await wait("Boolean(document.querySelector('[data-testid=remote-workroom-history-resume]'))")
        _ = try await js("personaClick('이어 열기');true")
        try await Task.sleep(for:.milliseconds(700))
        _ = try await js("personaClick('이 Mac에서 열기');true")
        try await wait("window.__nativePersona?.selected==='native_resumed_session_01'")
        try await report("resumed")
        _ = try await js("personaClick('개선 기록');true")
        try await wait("Boolean(document.querySelector('[data-testid=tester-improvement-journal]'))")
        _ = try await js("document.querySelector('[data-testid=tester-improvement-journal] summary').click();true")
        try await wait("Boolean([...document.querySelectorAll('label')].find(e=>e.textContent.startsWith('확인한 상황')))")
        for (label,value) in [("확인한 상황","LAN에서 첫 업무와 지난 워크룸 열기"),("기대했던 동작","첫 업무를 한 번 보내고 저장 대화를 한 번 이어 연다"),("확인한 버전","working-source native iOS 26.3"),("핵심 내용","실제 iPhone WKWebView에서 첫 업무 전송과 허용 뒤 대화 이어 열기를 확인했다. native touch는 별도 확인 필요"),("기기","iphone13"),("검증 환경","native-fixture")] {
            let args=try String(data:JSONSerialization.data(withJSONObject:[label,value]),encoding:.utf8)!
            _ = try await js("personaFill(..."+args+");true")
            try await Task.sleep(for:.milliseconds(50))
        }
        _ = try await js("personaClick('관측 기록 저장');true")
        try await wait("document.body.innerText.includes('개선 기록을 저장했습니다')")
        try await report("observation-saved")
        _ = try await js("personaClick('기록 새로 고침');document.querySelector('[data-testid=tester-improvement-item] summary').click();true")
        try await wait("document.body.innerText.includes('LAN에서 첫 업무와 지난 워크룸 열기')&&document.body.innerText.includes('관측 1')")
        try await report("record-reloaded",done:true)
    }
    func run() async {
        do {
            let data = try Data(contentsOf: Bundle.main.url(forResource: "bootstrap", withExtension: "json")!)
            let config = try JSONSerialization.jsonObject(with: data) as! [String: String]
            fingerprint = config["sourceFingerprint"] ?? "unknown"
            session = LANWorkroomSession(pairing: try LANPairing(scanned: config["pairingURL"]!))
            session?.webView?.isInspectable = true
            try await wait("Boolean(document.querySelector('[data-testid=native-persona-root]'))")
            if config["interactionMode"] == "native-touch" {
                _ = try await js("window.__nativeInputProof={pointer:0,text:0};document.addEventListener('pointerdown',e=>{if(e.isTrusted)window.__nativeInputProof.pointer++;},true);document.addEventListener('beforeinput',e=>{if(e.isTrusted&&e.target.matches('textarea[aria-label=\"프로젝트에 맡길 업무\"]'))window.__nativeInputProof.text++;},true);true")
                try await report("ready-for-native-touch")
                for _ in 0..<6000 {
                    if (try? await js("Boolean(window.__nativeInputProof.pointer>0&&window.__nativeInputProof.text>0&&document.querySelector('[data-testid=community-task-thread]'))")) as? Bool == true {
                        nativeInput=true;try await report("manual-task-created",done:true);return
                    }
                    try await Task.sleep(for:.milliseconds(100))
                }
                try await report("manual-input-unconfirmed");return
            }
            try await journey()
        } catch {
            if session?.webView != nil { try? await report("failed",error:String(describing:error)) }
        }
    }
}
@main struct WorkroomPersonaProbeApp: App {
    @StateObject var probe = WorkroomPersonaProbe()
    var body: some Scene { WindowGroup {
        Group { if let session=probe.session { LANWorkroomView(session:session,onReconnect:{},onDone:{}) } else { Text("실기 페르소나 준비") } }.task { await probe.run() }
    } }
}
