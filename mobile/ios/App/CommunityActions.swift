import Foundation
import Observation
import ScreenControlCore
import Security

/// Separate journal account. No session key, biometric result, target path or endpoint is serialized.
private final class MobileActionJournalBackend: CommunityMobileControlJournalBackend, @unchecked Sendable {
    private let lock = NSLock()
    private var query: [String:Any] { [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"com.intenet.agentstoz.mobile.community-actions",kSecAttrAccount as String:"original-effects-v2",kSecAttrSynchronizable as String:false] }
    func read() throws -> Data? { try lock.withLock { try bytes() } }
    private func bytes() throws -> Data? {
        var q = query; q[kSecReturnData as String] = true; q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?; let code = SecItemCopyMatching(q as CFDictionary,&item)
        if code == errSecItemNotFound { return nil }
        guard code == errSecSuccess, let data = item as? Data else { throw ScreenCommunityError.service("CONTROL_JOURNAL_UNAVAILABLE") }; return data
    }
    func write(_ bytes: Data) throws {
        try lock.withLock {
            let code: OSStatus
            if try self.bytes() == nil {
                var q = query; q[kSecValueData as String] = bytes; q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
                code = SecItemAdd(q as CFDictionary,nil)
            } else { code = SecItemUpdate(query as CFDictionary,[kSecValueData as String:bytes] as CFDictionary) }
            guard code == errSecSuccess else { throw ScreenCommunityError.service("CONTROL_JOURNAL_UNAVAILABLE") }
        }
    }
}
typealias MobileActionChoice = CommunityMobileControlChoice
struct MobileAgentPage: Sendable { let text: String, nextOffset: Int?, totalChars: Int }
struct MobileActionCommand: Sendable { let op: String, mode: String, label: String }
struct MobileBrowserElement: Identifiable, Sendable {
    var id: String { "\(frame ?? "main"):\(selector)" }
    let selector: String, role: String, name: String, frame: String?, options: [String]
}
private enum ActionJSON {
    static func object(_ bytes: Data) throws -> [String:Any] { guard bytes.count <= 16_000, let value = try JSONSerialization.jsonObject(with: bytes) as? [String:Any] else { throw ScreenCommunityError.malformed }; return value }
    static func exact(_ value: [String:Any], _ keys: Set<String>) throws { guard Set(value.keys) == keys else { throw ScreenCommunityError.malformed } }
    static func text(_ value: Any?, maximum: Int = 4000) throws -> String { guard let s = value as? String, s.utf8.count <= maximum, !s.unicodeScalars.contains(where: { $0.value < 32 && $0.value != 9 && $0.value != 10 && $0.value != 13 }) else { throw ScreenCommunityError.malformed }; return s }
    static func bool(_ value: Any?) throws -> Bool { guard let n = value as? NSNumber, CFGetTypeID(n) == CFBooleanGetTypeID() else { throw ScreenCommunityError.malformed }; return n.boolValue }
    static func id(_ value: Any?) throws -> String { let id = try text(value,maximum:36); guard UUID(uuidString:id)?.uuidString.lowercased() == id else { throw ScreenCommunityError.malformed }; return id }
    static func data(_ value: [String:Any]) throws -> Data { try JSONSerialization.data(withJSONObject:value,options:.withoutEscapingSlashes) }
}

/// The same RAM use episode backs every purpose and target; each target/purpose owns a distinct encrypted channel.
@MainActor @Observable final class MobileCommunityActions {
    private(set) var targets: [CommunityAuthorization] = []
    private(set) var commands: [MobileActionCommand] = []
    private(set) var choices: [MobileActionChoice] = []
    private(set) var choicesHaveMore = false
    private(set) var choiceLimitReached = false
    private(set) var records: [CommunityMobileControlJournal.Record] = []
    private(set) var elements: [MobileBrowserElement] = []
    private(set) var message = "공통 기기 등록 후 사용할 기능을 고르세요. 사용 시작 때 한 번 인증합니다."
    private(set) var detail = ""
    private(set) var busy = false
    private(set) var connected = false
    private(set) var selectedTarget: String?
    private(set) var contextID: String?
    private(set) var observationID: String?
    private(set) var teamRef: String?
    private(set) var teamGeneration: String?
    private(set) var agentRef: String?
    private(set) var agentRevision: Int64?
    private(set) var agentPages: [String:MobileAgentPage] = [:]
    var purpose: CommunityMobileControlPurpose = .teams
    @ObservationIgnored private let center = MobileScreenCommunity.shared
    @ObservationIgnored private let journal = CommunityMobileControlJournal(backend:MobileActionJournalBackend())
    @ObservationIgnored private var choiceList = CommunityMobileControlChoiceList()
    @ObservationIgnored private var client: CommunityMobileControlClient?
    @ObservationIgnored private var suspension: UUID?
    @ObservationIgnored private var epoch = 0
    @ObservationIgnored private var pendingActivity: (date: Date, tick: ContinuousClock.Instant)?
    @ObservationIgnored private var lastActivity: ContinuousClock.Instant?
    var permittedPurposes: [CommunityMobileControlPurpose] { CommunityMobileControlPurpose.allCases.filter { center.unified.authorization?.body.capabilities.contains($0.capability) == true } }
    func supports(_ op: String, mode: String) -> Bool { connected && !busy && commands.contains { $0.op == op && $0.mode == mode } }
    private var kind: String { switch purpose { case .agent:"agent"; case .teams:"teams"; case .agentSettings:"agent-settings"; case .browser:"browser" } }
    private func command(_ op: String, _ fields: [String:Any] = [:]) throws -> Data { try ActionJSON.data(["kind":kind,"op":op].merging(fields){$1}) }
    private func current(_ target: String, _ selected: CommunityMobileControlPurpose) async throws -> CommunityMobileControlContext { try await center.unified.actionContext(for:selected,target:target) }
    func start() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            _ = try await center.requireUnifiedUse(for:purpose.capability)
            targets = try await center.unified.actionTargets(for:purpose,refresh:true)
            try loadRecords(); message = targets.isEmpty ? "현재 이 기능을 허용한 Mac이 없습니다. 대상 Mac의 공통 등록·기능 허용을 확인하세요." : "사용할 Mac을 선택하세요. 기기·기능 전환에는 추가 인증이 없습니다."
        } catch { message = Self.describe(error) }
    }
    func changePurpose(_ next: CommunityMobileControlPurpose) async { purpose = next; targets = []; records = []; message = "기기 목록을 확인해 사용할 Mac을 고르세요."; await disconnect() }
    func connect(_ target: String) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do { try await flushHumanActivity(); try await open(target); message = "연결됨 · Mac이 현재 제공하는 기능만 사용할 수 있습니다." }
        catch { message = Self.describe(error); await disconnect() }
    }
    private func open(_ target: String) async throws {
        await disconnect(); let generation = epoch, selected = purpose
        let context = try await current(target,selected), unified = center.unified
        let relay = try CommunityRelayContext(communityID:context.mobile.body.communityId,enrollmentID:context.mobile.body.enrollmentId,deviceID:context.mobile.body.deviceId,publicKey:context.session.body.publicKey,role:.client,sessionID:context.session.body.sessionId)
        let carrier = try await CommunityMobileControlCarrier.open(authority:context.authority,context:relay,purpose:selected,
            fence:{ _ = try await unified.liveUse(for:selected.capability) },
            ticketProvider:{ try await unified.actionTicket(for:selected,connectionID:$0) },
            proofSigner:{ proof in let signer = try await unified.useSession.signer(for:selected.capability); return try await proof.signed(by:signer) })
        do {
            let active = try await CommunityMobileControlClient.connect(context:context,wire:carrier,
                current:{ try await unified.actionContext(for:selected,target:target) }, signer:{ try await unified.useSession.signMobileControl($0) })
            guard generation == epoch else { await active.close(); throw ScreenCommunityError.service("SESSION_EXPIRED") }
            client = active; selectedTarget = target
            suspension = try unified.useSession.observeSuspension { [weak self] in self?.suspend() }
            let response = try await active.request(.capabilities(purpose:selected)); try installManifest(response.result,for:selected)
            connected = true; try loadRecords()
            let list = selected == .teams ? "projects" : selected == .agent ? "targets":"contexts"
            if commands.contains(where: { $0.op == list && $0.mode == "query" }) { _ = try await query(list) }
        } catch { await carrier.close(); throw error }
    }
    private func installManifest(_ bytes: Data, for purpose: CommunityMobileControlPurpose) throws {
        let value = try ActionJSON.object(bytes); try ActionJSON.exact(value,["outcome","purpose","commands"])
        guard value["outcome"] as? String == "capabilities", value["purpose"] as? String == purpose.rawValue, let rows = value["commands"] as? [[String:Any]], rows.count <= 32 else { throw ScreenCommunityError.malformed }
        var result: [MobileActionCommand] = [], seen: Set<String> = []
        for row in rows {
            try ActionJSON.exact(row,["op","mode","label"]); let op = try ActionJSON.text(row["op"],maximum:48), mode = try ActionJSON.text(row["mode"],maximum:7)
            guard op.range(of:"^[a-z][a-z0-9-]{0,47}$",options:.regularExpression) != nil, ["query","effect"].contains(mode), seen.insert("\(mode):\(op)").inserted else { throw ScreenCommunityError.malformed }
            result.append(.init(op:op,mode:mode,label:try ActionJSON.text(row["label"],maximum:240)))
        }
        commands = result
    }
    private func loadRecords() throws {
        guard let own = center.unified.authorization else { records = []; return }
        let owner = try CommunityMobileControlPolicy.receiptOwner(own)
        records = try journal.records(ownerHash:owner).filter { $0.purpose == purpose && (selectedTarget == nil || $0.targetDeviceID == selectedTarget) }
    }
    /// Called at the real button handler, before network work; polls and responses never invoke this entry point.
    func humanAction(at date: Date, tick: ContinuousClock.Instant) {
        guard center.unified.useSession.isUsable else { return }; pendingActivity = (date,tick)
    }
    func humanEvent(kind: MobileCommunityUseSession.HumanActivity, at date: Date, tick: ContinuousClock.Instant) {
        guard center.unified.useSession.isUsable, !center.unified.useSession.busy,
              Int64(date.timeIntervalSince1970 * 1000) > (center.unified.useSession.session?.body.lastHumanAt ?? Int64.max),
              lastActivity.map({ $0.duration(to:tick) >= .seconds(15) }) ?? true else { return }
        lastActivity = tick
        Task { [weak self] in
            guard let self else { return }
            do { try await self.center.unified.useSession.recordHumanActivity(kind,observedAt:date,observedTick:tick) }
            catch { self.message = "실제 조작을 확인하지 못했습니다. 공통 사용 상태를 확인하세요." }
        }
    }
    private func flushHumanActivity() async throws {
        guard let observed = pendingActivity else { return }; pendingActivity = nil
        guard center.unified.useSession.isUsable,
              Int64(observed.date.timeIntervalSince1970 * 1000) > (center.unified.useSession.session?.body.lastHumanAt ?? Int64.max),
              lastActivity.map({ $0.duration(to:observed.tick) >= .seconds(15) }) ?? true else { return }
        lastActivity = observed.tick
        try await center.unified.useSession.recordHumanActivity(.action,observedAt:observed.date,observedTick:observed.tick)
    }
    @discardableResult private func query(_ op: String, _ fields: [String:Any] = [:]) async throws -> Data {
        guard let client, commands.contains(where: { $0.op == op && $0.mode == "query" }) else { throw ScreenCommunityError.service("FEATURE_UNAVAILABLE") }
        do {
            let response = try await client.request(.query(purpose:purpose,command:command(op,fields)))
            _ = try parse(response.result,op:op,operation:nil,followingCursor:fields["cursor"] as? String); return response.result
        } catch { await disconnect(); throw error }
    }
    func nextChoices() async {
        guard !busy, connected, let cursor = choiceList.nextCursor, purpose != .agent else { return }
        busy = true; defer { busy = false }
        do { try await flushHumanActivity(); _ = try await query(purpose == .teams ? "projects":"contexts",["cursor":cursor]) }
        catch { message = "대상 목록이 바뀌었거나 다음 목록을 확인하지 못했습니다. Mac에 다시 연결해 처음부터 확인하세요." }
    }
    func choose(_ id: String) async {
        guard !busy, choices.contains(where: { $0.id == id }) else { return }; busy = true; defer { busy = false }
        contextID = id; observationID = nil; elements = []; detail = ""
        do { try await flushHumanActivity(); if purpose == .browser { _ = try await query("observe",["context":id]) } else if purpose == .agentSettings { _ = try await query("status",["context":id]) } }
        catch { message = Self.describe(error) }
    }
    func refreshSelection() async {
        guard !busy else { return }; busy = true; defer { busy = false }
        do {
            try await flushHumanActivity()
            if purpose == .teams, let teamRef, let teamGeneration { _ = try await query("status",["ref":teamRef,"generation":teamGeneration]) }
            else if purpose == .agent, let contextID, let agentRef { _ = try await query("status",["context":contextID,"ref":agentRef]) }
            else if let contextID { _ = try await query(purpose == .browser ? "observe":"status",["context":contextID]) }
        } catch { message = Self.describe(error) }
    }
    func submitAgent(_ text: String) async { guard let contextID else { return }; await effect("submit",["context":contextID,"text":text]) }
    func readAgent(_ field: String) async {
        guard !busy, ["result","evidence","message"].contains(field), let page = agentPages[field], let offset = page.nextOffset,
              let contextID, let agentRef, let agentRevision else { return }; busy = true; defer { busy = false }
        do { try await flushHumanActivity(); _ = try await query("read",["context":contextID,"ref":agentRef,"field":field,"offset":offset,"revision":agentRevision]) }
        catch { message = "출력의 상태가 바뀌었거나 확인을 완료하지 못했습니다. 작업 상태를 다시 확인하세요." }
    }
    func openRecordedResult(_ record: CommunityMobileControlJournal.Record) async {
        guard !busy, record.phase == .consumed, let result = record.result else { return }; busy = true; defer { busy = false }
        do {
            try await flushHumanActivity()
            if selectedTarget != record.targetDeviceID || !connected { try await open(record.targetDeviceID) }
            let context = try await current(record.targetDeviceID,purpose)
            guard try CommunityMobileControlPolicy.receiptOwner(context.mobile) == record.ownerHash,
                  context.receiver.body.enrollmentId == record.targetEnrollmentID else { throw ScreenCommunityError.wrongCommunity }
            _ = try parse(result,op:nil,operation:record.operation)
            message = "원래 작업 결과를 열었습니다. 현재 상태는 별도로 조회하세요."
        } catch { message = "현재 등록과 일치하는 원래 작업 결과를 열지 못했습니다." }
    }
    func createTeam(title: String, goal: String, agent: String, model: String, provider: String, effort: String, task: String) async {
        guard let contextID, ["codex","claude","hermes","agy"].contains(agent) else { return }
        var member: [String:Any] = ["agent":agent,"task":task]
        if !model.isEmpty { member["model"] = model }; if agent == "hermes", !provider.isEmpty { member["provider"] = provider }; if !effort.isEmpty { member["effort"] = effort }
        await effect("create",["project":contextID,"title":title,"goal":goal,"member":member])
    }
    func instruct(_ text: String) async { guard let teamRef, let teamGeneration else { return }; await effect("instruct",["ref":teamRef,"generation":teamGeneration,"text":text]) }
    func cancelTeam() async { guard let teamRef, let teamGeneration else { return }; await effect("cancel",["ref":teamRef,"generation":teamGeneration]) }
    func evaluate(_ text: String) async { guard let contextID else { return }; await effect("evaluate",["context":contextID,"text":text]) }
    func browser(_ op: String, element: MobileBrowserElement, value: String) async {
        guard ["click","fill","select"].contains(op), let contextID, let observationID, elements.contains(where: { $0.id == element.id }) else { return }
        var fields: [String:Any] = ["context":contextID,"observationId":observationID,"selector":element.selector]
        if let frame = element.frame { fields["frame"] = frame }; if op == "fill" { fields["text"] = value }; if op == "select" { guard element.options.contains(value) else { return }; fields["value"] = value }
        await effect(op,fields); self.observationID = nil; elements = [] // A new action always requires a new observation.
    }
    private func effect(_ op: String, _ fields: [String:Any]) async {
        guard !busy, supports(op,mode:"effect"), let client, let selectedTarget else { return }; busy = true; defer { busy = false }
        var record: CommunityMobileControlJournal.Record?
        do {
            try await flushHumanActivity()
            let context = try await current(selectedTarget,purpose), bytes = try command(op,fields), operation = try CommunityMobileControlOperation.make()
            record = try journal.prepare(operation:operation,context:context,command:bytes) // Before dispatch, including process loss.
            let response = try await client.request(.effect(purpose:purpose,operation:operation,command:bytes))
            let terminal = try parse(response.result,op:op,operation:operation)
            try journal.receive(operation.operationId,ownerHash:record!.ownerHash,response:response,terminal:terminal)
            if terminal { try await consume(record!,response:response) }
            try loadRecords()
        } catch {
            if let record { try? journal.markUnknown(record.id,ownerHash:record.ownerHash); try? loadRecords(); message = "실행 결과를 확정하지 못했습니다. 아래 원래 작업의 결과만 조회하세요." }
            else { message = Self.describe(error) }
        }
    }
    func recover(_ record: CommunityMobileControlJournal.Record) async {
        guard !busy, record.purpose == purpose else { return }; busy = true; defer { busy = false }
        do {
            try await flushHumanActivity()
            if selectedTarget != record.targetDeviceID || !connected { try await open(record.targetDeviceID) }
            guard let client else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
            let context = try await current(record.targetDeviceID,purpose)
            guard try CommunityMobileControlPolicy.receiptOwner(context.mobile) == record.ownerHash, context.receiver.body.enrollmentId == record.targetEnrollmentID else { throw ScreenCommunityError.wrongCommunity }
            let response = try await client.request(.receipt(operation:record.operation))
            let value = try ActionJSON.object(response.result)
            if value["outcome"] as? String == "consumed" {
                try checkReceipt(value,operation:record.operation,extra:[])
                guard let digest = record.resultDigest, record.phase == .accepted || record.phase == .consumed else { throw ScreenCommunityError.wrongRequest }
                try journal.markConsumed(record.id,ownerHash:record.ownerHash,resultDigest:digest)
            } else {
                let terminal = try parse(response.result,op:nil,operation:record.operation)
                try journal.receive(record.id,ownerHash:record.ownerHash,response:response,terminal:terminal)
                if terminal { try await consume(record,response:response) }
            }
            try loadRecords()
        } catch { message = "원래 영수증 확인을 완료하지 못했습니다. 다시 실행하지 않았습니다." }
    }
    private func consume(_ record: CommunityMobileControlJournal.Record, response: CommunityMobileControlResponse) async throws {
        guard let client else { throw ScreenCommunityError.service("SESSION_EXPIRED") }
        let ack = try await client.request(.consumed(operation:record.operation,resultDigest:response.resultDigest))
        let value = try ActionJSON.object(ack.result); try checkReceipt(value,operation:record.operation,extra:[])
        guard value["outcome"] as? String == "consumed" else { throw ScreenCommunityError.wrongRequest }
        try journal.markConsumed(record.id,ownerHash:record.ownerHash,resultDigest:response.resultDigest)
    }
    func forget(_ record: CommunityMobileControlJournal.Record) {
        do { try journal.forgetConsumed(record.id,ownerHash:record.ownerHash); try loadRecords() } catch { message = "완료를 확인한 기록만 정리할 수 있습니다." }
    }
    private func checkReceipt(_ value: [String:Any], operation: CommunityMobileControlOperation, extra: Set<String>) throws {
        try ActionJSON.exact(value,Set(["outcome","operationId","createdAt"]).union(extra))
        guard value["operationId"] as? String == operation.operationId, let n = value["createdAt"] as? NSNumber,
              CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue == Double(operation.createdAt) else { throw ScreenCommunityError.wrongRequest }
    }
    private func parse(_ bytes: Data, op: String?, operation: CommunityMobileControlOperation?, followingCursor: String? = nil) throws -> Bool {
        let v = try ActionJSON.object(bytes)
        if let outcome = v["outcome"] as? String, ["pending","unknown","expired","unseen"].contains(outcome), let operation {
            try checkReceipt(v,operation:operation,extra:v["code"] == nil ? []:["code"]); message = "작업 상태: \(outcome) · 원래 영수증만 조회할 수 있습니다."; return false
        }
        if v["outcome"] as? String == "refused" { try ActionJSON.exact(v,["outcome","code"]); _ = try ActionJSON.text(v["code"],maximum:80); message = "현재 대상 또는 기능 허용을 확인하세요."; return false }
        if op == "projects" || op == "contexts" || op == "targets" {
            let page = try CommunityMobileControlChoicePage.decode(bytes,purpose:purpose,operation:op!)
            try choiceList.accept(page,following:followingCursor)
            choices = choiceList.choices; choicesHaveMore = choiceList.nextCursor != nil; choiceLimitReached = choiceList.limitReached
            return false
        }
        switch purpose {
        case .teams:
            if v["outcome"] as? String == "accepted" {
                try ActionJSON.exact(v,["outcome","ref","generation"]); teamRef = try ActionJSON.id(v["ref"]); teamGeneration = try ActionJSON.id(v["generation"]); message = "팀 실행을 접수했습니다. 상태 조회로 진행 상황을 확인하세요."; return true
            }
            if v["outcome"] as? String == "instructed" { try ActionJSON.exact(v,["outcome","delivery"]); _ = try ActionJSON.text(v["delivery"],maximum:80); message = "팀 지시 결과를 기록했습니다."; return true }
            if v["outcome"] as? String == "cancelled" { try ActionJSON.exact(v,["outcome"]); message = "팀 중지를 확인했습니다."; return true }
            guard op == "status" else { throw ScreenCommunityError.malformed }
            let allowed: Set<String> = ["ref","generation","state","delivery","report"]
            guard Set(v.keys).isSubset(of:allowed), Set(["ref","generation","state"]).isSubset(of:Set(v.keys)), try ActionJSON.id(v["ref"]) == teamRef, try ActionJSON.id(v["generation"]) == teamGeneration else { throw ScreenCommunityError.wrongRequest }
            detail = "상태: \(try ActionJSON.text(v["state"],maximum:80))"
            if let report = v["report"] as? [String:Any] { try ActionJSON.exact(report,["status","summary"]); detail += "\n" + (try ActionJSON.text(report["summary"],maximum:16_000)) }; return false
        case .agentSettings:
            if v["outcome"] as? String == "evaluated" { try ActionJSON.exact(v,["outcome","effort"]); guard let effort = v["effort"] as? [String:Any] else { throw ScreenCommunityError.malformed }; try showEffort(effort); message = "기존 CLI 정책을 유지하며 에포트를 재평가했습니다."; return true }
            guard op == "status" else { throw ScreenCommunityError.malformed }; try showEffort(v); return false
        case .browser:
            if let outcome = v["outcome"] as? String, ["completed","applied","unknown","rejected","reviewed"].contains(outcome), Set(v.keys) == ["outcome"] { message = "브라우저 조작 결과: \(outcome)"; return true }
            guard op == "observe" else { throw ScreenCommunityError.malformed }; try ActionJSON.exact(v,["observation"])
            if v["observation"] is NSNull { observationID = nil; elements = []; detail = "현재 확인할 브라우저 화면이 없습니다."; return false }
            guard let o = v["observation"] as? [String:Any] else { throw ScreenCommunityError.malformed }; try ActionJSON.exact(o,["id","title","text","elements","truncated"])
            observationID = try ActionJSON.text(o["id"],maximum:64); detail = try ActionJSON.text(o["title"],maximum:720) + "\n" + ActionJSON.text(o["text"],maximum:16_000)
            guard try ActionJSON.bool(o["truncated"]), let rows = o["elements"] as? [[String:Any]], rows.count <= 16 else { throw ScreenCommunityError.malformed }
            elements = try rows.map { row in
                guard Set(row.keys).isSubset(of:["selector","role","name","frame","shadow","options","moreOptions"]) else { throw ScreenCommunityError.malformed }
                let selector = try ActionJSON.text(row["selector"],maximum:4096), role = try ActionJSON.text(row["role"],maximum:120), name = try ActionJSON.text(row["name"],maximum:1000)
                let frame = try row["frame"].map { try ActionJSON.text($0,maximum:4) }
                if let frame { guard frame.range(of:"^(main|f[1-9][0-9]?)$",options:.regularExpression) != nil else { throw ScreenCommunityError.malformed } }
                let options: [String]
                if let raw = row["options"] as? [String] { guard raw.count <= 100 else { throw ScreenCommunityError.malformed }; options = try raw.map { try ActionJSON.text($0,maximum:1000) } }
                else if let raw = row["options"] as? [[String:Any]] { guard raw.count <= 100 else { throw ScreenCommunityError.malformed }; options = try raw.map { try ActionJSON.text($0["value"],maximum:1000) } }
                else { options = [] }
                return .init(selector:selector,role:role,name:name,frame:frame,options:options)
            }; return false
        case .agent:
            if v["accepted"] != nil, try ActionJSON.bool(v["accepted"]) {
                try ActionJSON.exact(v,["accepted","ref","createdAt"])
                guard let operation, try ActionJSON.id(v["ref"]) == operation.operationId,
                      try integer(v["createdAt"]) == operation.createdAt else { throw ScreenCommunityError.wrongRequest }
                agentRef = operation.operationId; agentRevision = nil; agentPages = [:]
                message = "Mac의 현재 OPS에 요청을 접수했습니다. 완료 여부는 상태 조회로 확인하세요."; return true
            }
            if op == "status" {
                try ActionJSON.exact(v,["ref","state","createdAt","updatedAt","result","evidence","message"])
                guard try ActionJSON.id(v["ref"]) == agentRef else { throw ScreenCommunityError.wrongRequest }
                _ = try integer(v["createdAt"]); agentRevision = try integer(v["updatedAt"])
                detail = "OPS 요청 상태: \(try ActionJSON.text(v["state"],maximum:80))"
                for field in ["result","evidence","message"] { agentPages[field] = try agentPage(v[field]) }; return false
            }
            if op == "read" {
                try ActionJSON.exact(v,["ref","field","revision","text","nextOffset","totalChars"])
                let field = try ActionJSON.text(v["field"],maximum:8)
                guard try ActionJSON.id(v["ref"]) == agentRef, ["result","evidence","message"].contains(field),
                      try integer(v["revision"]) == agentRevision else { throw ScreenCommunityError.wrongRequest }
                agentPages[field] = try agentPage(["text":v["text"] as Any,"nextOffset":v["nextOffset"] as Any,"totalChars":v["totalChars"] as Any]); return false
            }
            throw ScreenCommunityError.malformed
        }
    }
    private func integer(_ value: Any?) throws -> Int64 {
        guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), n.doubleValue >= 0,
              n.doubleValue <= 9_007_199_254_740_991, floor(n.doubleValue) == n.doubleValue else { throw ScreenCommunityError.malformed }; return n.int64Value
    }
    private func agentPage(_ raw: Any?) throws -> MobileAgentPage {
        guard let p = raw as? [String:Any] else { throw ScreenCommunityError.malformed }; try ActionJSON.exact(p,["text","nextOffset","totalChars"])
        let total = try integer(p["totalChars"]), next: Int64?
        if p["nextOffset"] is NSNull { next = nil } else { next = try integer(p["nextOffset"]) }
        guard next == nil || next! <= total else { throw ScreenCommunityError.malformed }
        return .init(text:try ActionJSON.text(p["text"],maximum:16_000),nextOffset:next.map(Int.init),totalChars:Int(total))
    }
    private func showEffort(_ v: [String:Any]) throws {
        guard Set(v.keys).isSubset(of:["auto","mode","session"]) else { throw ScreenCommunityError.malformed }; _ = try ActionJSON.bool(v["auto"])
        let mode = try v["mode"].map { try ActionJSON.text($0,maximum:16) } ?? "기존 설정"
        guard ["auto","recommend","off","기존 설정"].contains(mode) else { throw ScreenCommunityError.malformed }
        detail = "CLI 정책: \(mode)"
        if let session = v["session"] as? [String:Any] { guard Set(session.keys).isSubset(of:["agent","mode","tier","reason","level","origin","skipped","seen","manual","runtimeStatus","advice"]) else { throw ScreenCommunityError.malformed }; if let level = session["level"] as? String { detail += " · \(try ActionJSON.text(level,maximum:80))" } }
    }
    private func suspend() { epoch &+= 1; connected = false; commands = []; choices = []; choiceList = .init(); choicesHaveMore = false; choiceLimitReached = false; elements = []; observationID = nil; let old = client; client = nil; Task { await old?.close() }; message = "앱이 비활성화되어 연결을 중지했습니다. 유효한 공통 사용 세션으로 다시 연결할 수 있습니다." }
    func disconnect() async { epoch &+= 1; if let suspension { center.unified.useSession.removeSuspensionObserver(suspension); self.suspension = nil }; let old = client; client = nil; connected = false; selectedTarget = nil; contextID = nil; commands = []; choices = []; choiceList = .init(); choicesHaveMore = false; choiceLimitReached = false; elements = []; observationID = nil; teamRef = nil; teamGeneration = nil; agentRef = nil; agentRevision = nil; agentPages = [:]; await old?.close() }
    static func describe(_ error: Error) -> String {
        if case CommunityMobileControlClientError.unknown = error { return "결과를 확정하지 못했습니다. 원래 작업의 영수증만 조회하세요." }
        if case CommunityMobileControlClientError.notDispatched = error { return "연결 상태를 확인하지 못해 보내지 않았습니다." }
        return MobileScreenCommunity.describe(error)
    }
}
