#if os(macOS)
import Foundation
import ScreenControlCore

protocol ScreenOwnerRecoveryAtomicItems:ScreenStoreItems {
    func replaceOwnerRecovery(expectedGeneration:String?,data:Data,generation:String)throws->Bool
}
/// One bounded account in Screen's existing protected group. Local OFF is durable before any network await.
final class ScreenOwnerRecoveryStore:@unchecked Sendable {
    struct State:Codable,Sendable {
        var version=1
        var recordGeneration=UUID().uuidString.lowercased()
        var localGeneration=UUID().uuidString.lowercased()
        var enabled=false
        var pendingSetup=true
        var setupAuthorization:ScreenCommunityEnvelope?
        var minimumRevision:Int64=0
        var positiveRequest:ScreenCommunityEnvelope?
        var policy:ScreenCommunityEnvelope?
        var pending:CommunityAccessJournal?
        var pendingDisable:CommunityAccessJournal?
        var archive:[CommunityAccessJournal]=[]
        var effects=CommunityOwnerEffectJournal()
    }
    private let store:ScreenStore,lock=NSLock()
    private var ramOff=false
    private var mayInitialize=false
    func allowFreshInitialization(){lock.withLock{mayInitialize=true}}
    var isBlocked:Bool {lock.withLock{ramOff}}
    func invalidateInMemory() {lock.withLock{ramOff=true}}
    init(store:ScreenStore) { self.store=store }
    private func loaded()throws->State? {
        do {return try decodedState()}
        catch {ramOff=true;mayInitialize=false;throw error}
    }
    private func decodedState()throws->State? {
        guard let data=try store.ownerRecoveryData() else { return nil }
        guard data.count<=524_288 else { throw ScreenStoreError.corrupt }
        let s=try JSONDecoder().decode(State.self,from:data)
        guard s.version==1,s.archive.count<=128,s.minimumRevision>=0,UUID(uuidString:s.recordGeneration)?.uuidString.lowercased()==s.recordGeneration,UUID(uuidString:s.localGeneration)?.uuidString.lowercased()==s.localGeneration else { throw ScreenStoreError.corrupt }
        _=try CommunityOwnerEffectJournal.decode(s.effects.encoded());return s
    }
    func read()throws->State {
        try lock.withLock {
            if let state=try loaded() { return state }
            guard mayInitialize else {ramOff=true;throw ScreenCommunityError.service("OWNER_STATE_MISSING")}
            let state=State(),data=try JSONEncoder().encode(state)
            do {guard try store.replaceOwnerRecovery(expectedGeneration:nil,data:data,generation:state.recordGeneration) else {throw ScreenCommunityError.service("OWNER_STORE_CHANGED")}}
            catch {ramOff=true;mayInitialize=false;throw error}
            mayInitialize=false
            return state // Persist the initial negative generation; repeated status reads cannot invent a new subject.
        }
    }
    @discardableResult func update(releaseBlock:Bool=false,block:Bool=false,_ transform:(inout State)throws->Void)throws->State {
        try lock.withLock {
            if block {ramOff=true}
            let old=try loaded()
            guard old != nil || mayInitialize else {ramOff=true;throw ScreenCommunityError.service("OWNER_STATE_MISSING")}
            var next=old ?? State();try transform(&next)
            guard next.archive.count<=128 else { throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL") }
            next.recordGeneration=UUID().uuidString.lowercased();let data=try JSONEncoder().encode(next)
            guard data.count<=524_288 else { throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL") }
            do {guard try store.replaceOwnerRecovery(expectedGeneration:old?.recordGeneration,data:data,generation:next.recordGeneration) else {throw ScreenCommunityError.service("OWNER_STORE_CHANGED")}}
            catch {ramOff=true;mayInitialize=false;throw error}
            if releaseBlock {ramOff=false}
            mayInitialize=false
            return next
        }
    }
    func closeLocally()throws->State { try update(block:true) { $0.enabled=false;$0.pendingSetup=false;$0.localGeneration=UUID().uuidString.lowercased() } }
    func observePolicyChange()throws {
        do {_ = try update {s in s.localGeneration=UUID().uuidString.lowercased();if !s.pendingSetup {s.enabled=false} }}
        catch {invalidateInMemory();throw error}
    }
    func invalidatePending()throws {
        do {_ = try update {$0.localGeneration=UUID().uuidString.lowercased()} }
        catch {invalidateInMemory();throw error}
    }
    func archivePending(disable:Bool=false,expected:CommunityAccessJournal?=nil)throws {
        try update { state in
            let pending=disable ? state.pendingDisable:state.pending
            if let expected {
                if pending==nil,state.archive.contains(expected) {return}
                guard pending==expected else {throw ScreenCommunityError.service("OWNER_RESULT_UNKNOWN")}
            }
            if let pending {
                if let old=state.archive.first(where:{$0.id==pending.id}) {guard old==pending else {throw ScreenCommunityError.service("OWNER_EVIDENCE_CONFLICT")}}
                else {
                    let now=Int64(Date().timeIntervalSince1970*1000)
                    state.archive=try state.archive.filter {j in
                        let data=try ScreenCommunityRequest.decodeBase64(j.envelope.payload,max:32_000)
                        guard let f=try JSONSerialization.jsonObject(with:data) as? [Any],f.count==7,let at=f[3] as? Int64 else {throw ScreenStoreError.corrupt}
                        return now<at+604_800_000
                    }
                    guard state.archive.count<128 else {throw ScreenCommunityError.service("OWNER_EVIDENCE_FULL")};state.archive.append(pending)
                }
            }
            if disable {state.pendingDisable=nil} else {state.pending=nil}
        }
    }
    func perform(_ proof:CommunityDelegatedInputConfirmation,publication:CommunityOwnerEffectJournal.Publication,_ effect:()->Bool)throws->Bool {
        try lock.withLock {
            guard !ramOff,let state=try loaded(),state.enabled,state.localGeneration==publication.localGeneration,
                  state.minimumRevision==proof.delegation.body.revision,
                  let entry=state.effects.entries[publication.recordId],entry.publication==publication,
                  entry.reservationHash != nil,entry.outcome==nil,
                  publication.expiresAt>Int64(Date().timeIntervalSince1970*1000),proof.source.isCurrent(),proof.target.isCurrent() else { throw ScreenCommunityError.service("OWNER_EFFECT_SUPERSEDED") }
            return effect() // Serial with local OFF; the nested input-hold store uses its separate generation CAS.
        }
    }
}

struct ScreenDelegatedInputPermit:Sendable {
    let proof:CommunityDelegatedInputConfirmation,publication:CommunityOwnerEffectJournal.Publication
    let store:ScreenOwnerRecoveryStore
    @MainActor func perform(_ effect:()->Bool)throws->Bool { try store.perform(proof,publication:publication,effect) }
}
#endif
