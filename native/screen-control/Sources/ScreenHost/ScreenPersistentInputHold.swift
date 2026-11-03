#if os(macOS)
import Foundation
import CryptoKit
import ScreenControlCore

/// One bounded negative record in Screen's existing access-grouped store. No channel or remote RPC can clear it.
struct ScreenInputHoldRecord:Codable,Equatable,Sendable {
    let version:Int
    let held:Bool
    let generation:String
    let ownerConfirmed:Bool
    let instance:String?
    /// A delegated application confirmation is deliberately distinct from a local OS-owner confirmation.
    let delegatedConfirmationHash:String?
    init(held:Bool,ownerConfirmed:Bool,instance:String?,delegatedConfirmationHash:String?=nil) {
        version=2;self.held=held;generation=UUID().uuidString.lowercased();self.ownerConfirmed=ownerConfirmed;self.instance=instance;self.delegatedConfirmationHash=delegatedConfirmationHash
    }
    private enum CodingKeys:String,CodingKey { case version,held,generation,ownerConfirmed,instance,delegatedConfirmationHash }
    func encode(to encoder:any Encoder)throws {
        var c=encoder.container(keyedBy:CodingKeys.self)
        try c.encode(version,forKey:.version);try c.encode(held,forKey:.held);try c.encode(generation,forKey:.generation);try c.encode(ownerConfirmed,forKey:.ownerConfirmed)
        if let instance { try c.encode(instance,forKey:.instance) } else { try c.encodeNil(forKey:.instance) }
        if let delegatedConfirmationHash { try c.encode(delegatedConfirmationHash,forKey:.delegatedConfirmationHash) } else { try c.encodeNil(forKey:.delegatedConfirmationHash) }
    }
    static func decode(_ data:Data)throws->Self {
        guard data.count<=4096,let object=try JSONSerialization.jsonObject(with:data) as? [String:Any] else { throw ScreenStoreError.corrupt }
        let keys:Set<String>=["version","held","generation","ownerConfirmed","instance"]
        guard Set(object.keys)==((object["version"] as? Int)==1 ? keys:keys.union(["delegatedConfirmationHash"])) else { throw ScreenStoreError.corrupt }
        let value=try JSONDecoder().decode(Self.self,from:data)
        func id(_ v:String)->Bool { UUID(uuidString:v)?.uuidString.lowercased()==v }
        guard [1,2].contains(value.version),id(value.generation),value.instance.map(id) ?? true,
              value.delegatedConfirmationHash.map({$0.range(of:"^[0-9a-f]{64}$",options:.regularExpression) != nil}) ?? true,
              value.version != 1 || value.delegatedConfirmationHash==nil,
              value.held || value.ownerConfirmed || value.delegatedConfirmationHash != nil else { throw ScreenStoreError.corrupt }
        return value
    }
}

/// Backends implement one conditional store transaction, never a read-then-unconditional-write clear.
protocol ScreenInputHoldAtomicItems:ScreenStoreItems {
    func replaceInputHold(expectedGeneration:String?,data:Data,generation:String)throws->Bool
}

@MainActor final class ScreenPersistentInputHold {
    let instance=UUID().uuidString.lowercased()
    private let store:ScreenStore
    private(set) var record:ScreenInputHoldRecord?
    private(set) var armed=false
    private(set) var closed=false
    private var poisoned=false
    private(set) var issue:String?
    var held:Bool { !armed || poisoned || record?.held != false }
    init(store:ScreenStore) { self.store=store }
    private func commit(_ next:ScreenInputHoldRecord,expected:ScreenInputHoldRecord?)throws {
        guard try store.replaceInputHold(expectedGeneration:expected?.generation,data:JSONEncoder().encode(next),generation:next.generation) else { throw ScreenStoreError.corrupt }
        record=next
    }
    /// Missing or unclean state is never an unheld migration. Arming completes before input can be admitted.
    func arm() {
        guard !closed,!armed else { return }
        do {
            let previous=try store.inputHoldData().map(ScreenInputHoldRecord.decode)
            let next=ScreenInputHoldRecord(held:previous?.held != false || previous?.instance != nil || previous==nil,ownerConfirmed:previous?.ownerConfirmed ?? false,instance:instance,delegatedConfirmationHash:previous?.delegatedConfirmationHash)
            try commit(next,expected:previous);armed=true;poisoned=false
            issue=next.held ? "입력 보류 유지 · 처음 이행했거나 정상 종료를 확인하지 못했습니다. 이 Mac의 계정 소유자 확인으로 해제할 수 있습니다." : nil
        } catch { armed=false;poisoned=true;issue="입력 보호 상태의 지속 준비를 확인하지 못해 보기만 허용합니다. 보류 저장 결과를 확인할 수 없습니다." }
    }
    /// The caller pauses its live receiver first. On write failure it stays held and cannot produce a clean seal.
    func engage() {
        guard !closed else { return }
        do {
            guard armed,let previous=record,previous.instance==instance else { throw ScreenStoreError.corrupt }
            let next=ScreenInputHoldRecord(held:true,ownerConfirmed:previous.ownerConfirmed,instance:instance,delegatedConfirmationHash:previous.delegatedConfirmationHash)
            try commit(next,expected:previous);poisoned=false;issue=nil
        } catch { poisoned=true;issue="입력은 보류했지만 지속 저장을 확인하지 못했습니다. 현재 원격 입력은 계속 차단합니다. 강제 종료와 저장 실패가 겹친 경우 보류의 지속 보존은 확인되지 않습니다." }
    }
    /// Called only after fresh native owner authentication and exact live hold/session checks, without an await here.
    func clearAfterOwnerConfirmation(expectedGeneration:String)throws {
        guard !closed,armed,let previous=record,previous.generation==expectedGeneration,previous.instance==instance else { throw ScreenStoreError.corrupt }
        let next=ScreenInputHoldRecord(held:false,ownerConfirmed:true,instance:instance)
        do { try commit(next,expected:previous);poisoned=false;issue=nil }
        catch { poisoned=true;issue="계정 소유자 확인 뒤에도 보류 상태 저장을 확인하지 못해 입력 보류를 유지합니다.";throw error }
    }
    /// Only a verified delegated proof may use this path. It never marks a local OS owner as authenticated.
    func clearAfterDelegatedConfirmation(_ proof:CommunityDelegatedInputConfirmation,expectedGeneration:String)throws {
        guard !closed,armed,let previous=record,previous.held,previous.generation==expectedGeneration,previous.instance==instance,
              proof.intent.holdGeneration==expectedGeneration,proof.intent.expiresAt>Int64(Date().timeIntervalSince1970*1000) else { throw ScreenStoreError.corrupt }
        let hash=try CommunityOwnerWire.envelopeHash(proof.record.envelope)
        do { try commit(ScreenInputHoldRecord(held:false,ownerConfirmed:false,instance:instance,delegatedConfirmationHash:hash),expected:previous);poisoned=false;issue=nil }
        catch { poisoned=true;issue="위임 승인 뒤 보류 저장을 확인하지 못해 입력을 계속 차단합니다.";throw error }
    }
    /// Input admission and sessions must already be closed. A late owner result cannot clear a sealed or new instance.
    func sealAfterClosingInput() {
        guard !closed else { return };closed=true
        guard armed,!poisoned,let previous=record,previous.instance==instance else { return }
        do { try commit(ScreenInputHoldRecord(held:previous.held,ownerConfirmed:previous.ownerConfirmed,instance:nil,delegatedConfirmationHash:previous.delegatedConfirmationHash),expected:previous) }
        catch { poisoned=true;issue="정상 종료 상태를 저장하지 못했습니다. 다음 시작은 입력 보류로 처리합니다." }
    }
}
#endif
