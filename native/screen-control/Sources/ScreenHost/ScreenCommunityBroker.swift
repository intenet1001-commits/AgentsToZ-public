#if os(macOS)
import CryptoKit
import Foundation
import CoreFoundation
import ScreenControlCore

/// Native Screen owns its key. The signed Viewer may request only a community-protocol proof bound to this exact
/// device/profile/viewer key and fixed authority. There is no arbitrary signing, session/capture/input RPC.
public actor ScreenCommunityBroker {
    public struct SafetyActivation:Codable,Sendable,Equatable {
        public let id:String,since:Int64
        var enabled:Bool
    }
    struct SafetyStoredResult:Codable { let envelope:ScreenCommunityEnvelope,retireAt:Int64 }
    struct SafetyReservation:Codable { let activationId:String,expiresAt:Int64 }
    struct State: Codable {
        let deviceID: String
        let hostKey: Data
        var viewerKey: Data?
        var certificate: ScreenCommunityEnvelope?
        var minimumRevision: Int64 = 0
        var held = false
        var withdrawnEnrollmentIDs: [String]?
        var accessCertificate: ScreenCommunityEnvelope?
        var minimumAccessRevision: Int64?
        var safetyActivation:SafetyActivation?
        var safetyDeniedEnrollmentIDs:[String]?
        var safetyPendingCommands:[String:SafetyReservation]?
        var safetyResults:[SafetyStoredResult]?
        var safetyObservationSequence:Int64?
        var ownerRecoveryInitialized:Bool?
    }
    private let store: ScreenStore
    private let identity: SecureEnclaveTranscriptSigner
    private let authority: ScreenCommunityAuthority
    private var state: State
    private var directory: ScreenCommunityDirectory?
    private var metadataSaved = false
    private let didChange: @Sendable (ScreenCommunityDirectory?, Bool) -> Void
    private let didAccessChange: @Sendable (CommunityAuthorization?, [CommunityAuthorization], Bool) -> Void
    private var accessDirectory: [CommunityAuthorization] = []
    private var ownerTarget:ScreenOwnerRecoveryTarget?
    private let ownerProtectedStore:ScreenOwnerRecoveryStore
    private var viewerTargetHandoff:CommunityViewerHandoff?

    /// Called only by Screen's real list button. No IPC operation accepts a selected target or creates a handoff.
    func chooseViewerTarget(_ selection:CommunityDesktopScreenTrust)throws->String {
        let own=try accessIdentity()
        guard own.isCurrent(),own.body==selection.controller,
              let peer=accessDirectory.first(where:{$0.body==selection.receiver}),peer.isCurrent() else {throw ScreenCommunityError.expired}
        _=try CommunityDesktopScreenTrust.verified(authority:authority,controller:own,receiver:peer)
        viewerTargetHandoff=try CommunityViewerHandoff(selection:selection)
        return viewerTargetHandoff!.nonce
    }
    func cancelViewerTarget(_ nonce:String) {if viewerTargetHandoff?.nonce==nonce {viewerTargetHandoff=nil}}
    func cancelViewerTargetHint(){viewerTargetHandoff=nil}
    private func consumeViewerTarget()throws->ScreenCommunityBrokerReply {
        let hint=viewerTargetHandoff;viewerTargetHandoff=nil
        guard let hint,hint.expiresAt>Int64(Date().timeIntervalSince1970*1000) else {return ScreenCommunityBrokerReply()}
        return ScreenCommunityBrokerReply(values:[.string(ScreenCommunityRequest.base64(try JSONEncoder().encode(hint)))])
    }

    func ownerRecoveryTarget()throws->ScreenOwnerRecoveryTarget {
        if let ownerTarget {return ownerTarget}
        if state.ownerRecoveryInitialized != true {
            state.ownerRecoveryInitialized=true;try save() // Presence marker first: interrupted/lost state never becomes a fresh bootstrap.
            ownerProtectedStore.allowFreshInitialization()
        }
        _=try ownerProtectedStore.read()
        let value=ScreenOwnerRecoveryTarget(store:ownerProtectedStore,authority:authority,signer:identity,context:{ [weak self] qualifying in
            guard let self else {throw ScreenCommunityError.expired};return try await self.ownerRecoveryContext(qualifying:qualifying)
        });ownerTarget=value;return value
    }
    private func ownerRecoveryContext(qualifying:Bool)async throws->ScreenOwnerRecoveryTarget.Context {
        if qualifying {try await refreshAccess()}
        return .init(own:try accessIdentity(),peers:accessDirectory,receivingHeld:state.held)
    }

    /// Native lifecycle only. None of these operations is exposed by the automatic `.prepare` IPC signer.
    public func beginSafetyActivation(resuming:Bool) throws -> SafetyActivation {
        if resuming,let old=state.safetyActivation,old.enabled { return old }
        let next=SafetyActivation(id:UUID().uuidString.lowercased(),since:Int64(Date().timeIntervalSince1970*1000),enabled:true)
        state.safetyActivation=next;state.safetyPendingCommands=[:];try save();return next
    }
    public func endSafetyActivation(_ id:String) throws {
        guard var current=state.safetyActivation,current.id==id else { return }
        current.enabled=false;state.safetyActivation=current;try save()
    }
    public func permitsSafetyPeer(_ enrollmentId:String) -> Bool { !(state.safetyDeniedEnrollmentIDs ?? []).contains(enrollmentId) }
    public func denySafetyPeer(_ enrollmentId:String,activationId:String) throws {
        guard state.safetyActivation?.id==activationId,state.safetyActivation?.enabled==true,!state.held else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
        guard UUID(uuidString:enrollmentId)?.uuidString.lowercased()==enrollmentId else { throw ScreenCommunityError.malformed }
        var denied=state.safetyDeniedEnrollmentIDs ?? []
        if !denied.contains(enrollmentId) { guard denied.count<1024 else { throw ScreenCommunityError.service("SAFETY_DENY_LIMIT") };denied.append(enrollmentId);state.safetyDeniedEnrollmentIDs=denied;try save() }
    }
    public func safetyPoll(activation:SafetyActivation,afterSequence:Int64,snapshot:CommunitySafetyHostState) async throws -> CommunitySafetyRound {
        let own=try await receiverAuthorization()
        guard state.safetyActivation==activation,activation.enabled,!state.held,snapshot.power != .off,!snapshot.held else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
        state.safetyResults=(state.safetyResults ?? []).filter{$0.retireAt>Int64(Date().timeIntervalSince1970*1000)}
        let carried=Array((state.safetyResults ?? []).prefix(16)).map(\.envelope)
        let results=try carried.map { try JSONSerialization.jsonObject(with:JSONEncoder().encode($0)) }
        let observed=try nextSafetyObservation(snapshot)
        let value=observed.value()
        let request=try CommunityAccessRequest(operation:.safetyPoll,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,activation.id,afterSequence,results,value],options:.withoutEscapingSlashes))
        let reply=try await CommunityAccessHTTP(authority:authority).send(request.signed(by:identity),requestId:request.id)
        let round=try CommunitySafetyRound.verify(reply.envelope,authority:authority,own:own,activationId:activation.id,request:request)
        let current=try accessIdentity()
        guard state.safetyActivation==activation,!state.held,state.safetyObservationSequence==observed.observationSequence,current.isCurrent(),
              try CommunityMobileControlPolicy.authorizationDigest(current)==CommunityMobileControlPolicy.authorizationDigest(own) else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
        for watcher in round.watchers {
            guard let peer=accessDirectory.first(where:{$0.body.enrollmentId==watcher.enrollmentId}),peer.isCurrent(),
                  try CommunityMobileControlPolicy.authorizationDigest(peer)==watcher.policyDigest else { throw ScreenCommunityError.service("SAFETY_WATCHER_CHANGED") }
        }
        if !carried.isEmpty {
            let ids=Set(carried.map(\.payload));state.safetyResults=(state.safetyResults ?? []).filter { !ids.contains($0.envelope.payload) };try save()
        }
        return round
    }
    public func performSafetyCommand(_ command:CommunitySafetyCommand,activation:SafetyActivation,apply:@Sendable () async throws -> CommunitySafetyOutcome) async throws {
        let ownNow=try accessIdentity()
        guard state.safetyActivation?.id==activation.id,state.safetyActivation?.enabled==true,!state.held,ownNow.isCurrent(),
              try CommunityMobileControlPolicy.authorizationDigest(ownNow)==command.receiverPolicyDigest,
              let watcher=accessDirectory.first(where:{$0.body.enrollmentId==command.authorization.body.enrollmentId}),watcher.isCurrent(),
              try CommunityMobileControlPolicy.authorizationDigest(watcher)==CommunityMobileControlPolicy.authorizationDigest(command.authorization) else { throw ScreenCommunityError.service("SAFETY_INACTIVE") }
        // A crash after reservation is an unknown outcome, never permission to execute a second time.
        if state.safetyPendingCommands?[command.commandId] != nil {
            if (state.safetyResults ?? []).contains(where:{ item in
                let envelope=item.envelope
                guard let bytes=try? ScreenCommunityRequest.decodeBase64(envelope.payload,max:4096),let fields=(try? JSONSerialization.jsonObject(with:bytes)) as? [Any],fields.count==7 else { return false }
                return fields[4] as? String==command.commandId
            }) { return }
            throw ScreenCommunityError.service("SAFETY_COMMAND_UNKNOWN")
        }
        var pending=(state.safetyPendingCommands ?? [:]).filter{$0.value.expiresAt>Int64(Date().timeIntervalSince1970*1000)}
        guard pending.count<256 else { throw ScreenCommunityError.service("SAFETY_RECEIPT_LIMIT") }
        pending[command.commandId] = .init(activationId:activation.id,expiresAt:command.expiresAt);state.safetyPendingCommands=pending;try save()
        let outcome=try await apply(),own=try accessIdentity()
        if outcome == .turnedOff,var current=state.safetyActivation,current.id==activation.id { current.enabled=false;state.safetyActivation=current;try save() }
        let result=try await CommunitySafetyHostResult.make(communityId:own.body.communityId,receiverEnrollmentId:own.body.enrollmentId,activationId:activation.id,commandId:command.commandId,outcome:outcome,signer:identity)
        var results=state.safetyResults ?? []
        guard results.count<256 else { throw ScreenCommunityError.service("SAFETY_RECEIPT_LIMIT") }
        results.append(.init(envelope:result.envelope,retireAt:command.acceptedAt+604_800_000));state.safetyResults=results
        // Retain the reservation after receipt delivery. The command may recur, but its effect may not.
        try save()
        if outcome == .turnedOff {
            // Turning off cancels the regular polling task. Only this bounded negative-result delivery outlives it.
            Task.detached { [weak self] in try? await self?.flushSafetyResults(activation:activation) }
        }
    }
    private func flushSafetyResults(activation:SafetyActivation) async throws {
        guard state.safetyActivation?.id==activation.id,state.safetyActivation?.enabled==false else { return }
        let own=try accessIdentity();guard own.isCurrent() else { throw ScreenCommunityError.expired }
        state.safetyResults=(state.safetyResults ?? []).filter{$0.retireAt>Int64(Date().timeIntervalSince1970*1000)}
        let carried=Array((state.safetyResults ?? []).prefix(16)).map(\.envelope);guard !carried.isEmpty else { return }
        let results=try carried.map { try JSONSerialization.jsonObject(with:JSONEncoder().encode($0)) }
        let snapshot=try nextSafetyObservation(CommunitySafetyHostState(power:.off,held:state.held,session:nil))
        let request=try CommunityAccessRequest(operation:.safetyPoll,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,activation.id,0,results,snapshot.value()],options:.withoutEscapingSlashes))
        let reply=try await CommunityAccessHTTP(authority:authority).send(request.signed(by:identity),requestId:request.id)
        try CommunitySafetyRound.verifyAcknowledgement(reply.envelope,authority:authority,own:own,activationId:activation.id,request:request)
        let ids=Set(carried.map(\.payload));state.safetyResults=(state.safetyResults ?? []).filter { !ids.contains($0.envelope.payload) };try save()
    }
    private func nextSafetyObservation(_ snapshot:CommunitySafetyHostState) throws -> CommunitySafetyHostState {
        let old=state.safetyObservationSequence ?? 0
        guard old>=0,old<9_007_199_254_740_990 else { throw ScreenCommunityError.service("SAFETY_OBSERVATION_EXHAUSTED") }
        state.safetyObservationSequence=old+1;try save() // Never reset on activation, policy change or restart.
        return .init(power:snapshot.power,held:snapshot.held,session:snapshot.session,observationSequence:old+1)
    }
    public func safetyEvent(activationId:String,kind:String,actor:String?) async throws {
        guard ["connection","enrollment","security"].contains(kind),let current=state.safetyActivation,current.id==activationId else { throw ScreenCommunityError.malformed }
        let own=try accessIdentity(),request=try CommunityAccessRequest(operation:.safetyEvent,actor:own.body.enrollmentId,argumentsJSON:JSONSerialization.data(withJSONObject:[own.body.communityId,activationId,UUID().uuidString.lowercased(),kind,actor as Any? ?? NSNull()]))
        _ = try await CommunityAccessHTTP(authority:authority).send(request.signed(by:identity),requestId:request.id)
    }

    public init(didAccessChange: @escaping @Sendable (CommunityAuthorization?, [CommunityAuthorization], Bool) -> Void = { _, _, _ in },
                didChange: @escaping @Sendable (ScreenCommunityDirectory?, Bool) -> Void = { _, _ in }) throws {
        guard let authority = ScreenCommunityAuthority.configured else { throw ScreenCommunityError.notConfigured }
        let store = ScreenStore(), saved = try store.read("community-membership")
        if saved != nil, try store.read("identity") == nil { throw ScreenStoreError.corrupt }
        let identity = try store.identity()
        if let saved {
            state = try JSONDecoder().decode(State.self, from: saved)
            metadataSaved = true
            guard state.hostKey == identity.publicKey.x963Representation else { throw ScreenStoreError.corrupt }
        } else {
            state = State(deviceID: UUID().uuidString.lowercased(), hostKey: identity.publicKey.x963Representation)
            // An existing explicit local off survives a new community certificate.
            if try store.read("controllers") != nil { state.held = try !store.controllers().allowMacControllers }
        }
        self.store = store; self.identity = identity; self.authority = authority; self.didChange = didChange; self.didAccessChange = didAccessChange
        ownerProtectedStore=ScreenOwnerRecoveryStore(store:store)
    }
    private func save() throws { try store.write("community-membership", JSONEncoder().encode(state)); metadataSaved = true }
    private func certificate() throws -> ScreenCommunityCertificate {
        guard let envelope = state.certificate, let viewer = state.viewerKey else { throw ScreenCommunityError.service("NOT_ENROLLED") }
        return try ScreenCommunityResponse.verify(envelope, issuer: authority.issuer)
            .certificate(profileID: authority.profileID, deviceID: state.deviceID, hostKey: state.hostKey, viewerKey: viewer)
    }
    public func handle(_ data: Data) async -> Data {
        let reply: ScreenCommunityBrokerReply
        do {
            let command = try JSONDecoder().decode(ScreenCommunityCommand.self, from: data)
            reply = try await execute(command)
        } catch ScreenCommunityError.service(let code) { reply = ScreenCommunityBrokerReply(error: code) }
        catch { reply = ScreenCommunityBrokerReply(error: "REGISTRATION_UNAVAILABLE") }
        return (try? JSONEncoder().encode(reply)) ?? Data("{}".utf8)
    }
    private func execute(_ command: ScreenCommunityCommand) async throws -> ScreenCommunityBrokerReply {
        let a = command.arguments
        guard [.commit, .accessCommit,.ownerDelegationCommit,.viewerDirectoryCommit].contains(command.operation) || command.certificate == nil else { throw ScreenCommunityError.malformed }
        switch command.operation {
        case .identity:
            guard a.isEmpty else { throw ScreenCommunityError.malformed }
            if !metadataSaved { try save() }
            let name = Host.current().localizedName.flatMap { RegistrationInvite.isShowableName($0) ? $0 : nil } ?? "Mac"
            return ScreenCommunityBrokerReply(values: [.string(authority.profileID), .string(state.deviceID), .string(name),
                .string(ScreenCommunityRequest.base64(state.hostKey)), state.viewerKey.map { .string(ScreenCommunityRequest.base64($0)) } ?? .null])
        case .bind:
            guard a.count == 1, let value = a[0].string else { throw ScreenCommunityError.malformed }
            let key = try ScreenCommunityRequest.decodeBase64(value, max: 87)
            _ = try P256.Signing.PublicKey(x963Representation: key)
            guard key != state.hostKey, state.viewerKey == nil || state.viewerKey == key else { throw ScreenCommunityError.wrongCommunity }
            state.viewerKey = key; try save()
            // Public provisioning material only; never a credential or grant. Modifying it cannot change this keychain.
            let publicRecord: [String: String] = ["profileID": authority.profileID, "deviceID": state.deviceID,
                "hostKey": ScreenCommunityRequest.base64(state.hostKey), "viewerKey": value]
            let path = URL(fileURLWithPath: ScreenCommunitySocket.path).deletingLastPathComponent().appending(path: "community-public-creator.json")
            try JSONSerialization.data(withJSONObject: publicRecord, options: [.sortedKeys]).write(to: path, options: [.atomic])
            try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: path.path)
            return ScreenCommunityBrokerReply()
        case .prepare:
            guard a.count == 1, let encoded = a[0].string else { throw ScreenCommunityError.malformed }
            let transcript = try ScreenCommunityRequest.decodeBase64(encoded)
            try validateAutomaticProof(transcript)
            let signature = try await identity.signature(for: transcript)
            return ScreenCommunityBrokerReply(values: [.string(ScreenCommunityRequest.base64(signature.rawRepresentation))])
        case .commit:
            guard a.isEmpty, let certificate = command.certificate else { throw ScreenCommunityError.malformed }
            try await commitCertificate(certificate)
            return ScreenCommunityBrokerReply(envelopes: [state.certificate, directory?.envelope].compactMap { $0 })
        case .status:
            guard a.isEmpty else { throw ScreenCommunityError.malformed }
            try await refresh()
            return ScreenCommunityBrokerReply(envelopes: [state.certificate, directory?.envelope].compactMap { $0 })
        case .withdraw:
            guard a.isEmpty else { throw ScreenCommunityError.malformed }
            try withdrawMembership()
            return ScreenCommunityBrokerReply()
        case .accessCommit:
            guard a.isEmpty, let envelope = command.certificate else { throw ScreenCommunityError.malformed }
            let current = try verifiedAccess(envelope, historical: false)
            try persistAccess(current)
            if current.body.capabilities.contains(.receiveView) { try await refreshAccess() }
            return ScreenCommunityBrokerReply(envelopes: [state.accessCertificate].compactMap { $0 })
        case .accessStatus:
            guard a.isEmpty else { throw ScreenCommunityError.malformed }
            try await refreshAccess()
            return ScreenCommunityBrokerReply(envelopes: [state.accessCertificate].compactMap { $0 })
        case .ownerDelegationStatus:
            guard a.isEmpty else {throw ScreenCommunityError.malformed}
            let status=try await ownerRecoveryTarget().status()
            return ScreenCommunityBrokerReply(values:[.string(status.localGeneration),.bool(status.enabled),.number(status.revision)],envelopes:status.round.map{[$0.envelope]} ?? [])
        case .ownerDelegationCommit:
            guard a.count==2,let generation=a[0].string,let original=a[1].string,let policy=command.certificate else {throw ScreenCommunityError.malformed}
            let request=try JSONDecoder().decode(ScreenCommunityEnvelope.self,from:ScreenCommunityRequest.decodeBase64(original,max:32_000))
            try await ownerRecoveryTarget().commit(policy:policy,original:request,expectedLocalGeneration:generation)
            return ScreenCommunityBrokerReply()
        case .ownerDelegationDisable:
            guard a.isEmpty else {throw ScreenCommunityError.malformed};try await ownerRecoveryTarget().disable();return ScreenCommunityBrokerReply()
        case .viewerDirectoryCommit:
            guard a.isEmpty,let envelope=command.certificate else {throw ScreenCommunityError.malformed}
            let own=try accessIdentity()
            guard own.isCurrent(),own.body.capabilities.contains(.screenView),own.body.capabilities.contains(.desktopTrust) else {throw ScreenCommunityError.expired}
            let peers=try CommunityAccessReply.verify(envelope,authority:authority).directory(authority:authority,communityId:own.body.communityId)
            accessDirectory=peers;didAccessChange(own,peers,state.held);return ScreenCommunityBrokerReply()
        case .viewerTargetConsume:
            guard a.isEmpty else {throw ScreenCommunityError.malformed}
            return try consumeViewerTarget()
        }
    }
    /// Strictly validates the complete automatic-proof domain and scope before touching the Secure Enclave key.
    private func validateAutomaticProof(_ transcript: Data) throws {
        if transcript.starts(with: Data("agentstoz.community-access.request/v2\0".utf8)) {
            try CommunityAccessRequest.validateHostProof(transcript, profileId: authority.profileID, deviceId: state.deviceID,
                hostKey: state.hostKey, biometricKey: state.viewerKey, certificate: try? certificate(), authorization: try? accessIdentity())
            return
        }
        let domain = Data("agentstoz.screen-community.request/v1\0".utf8)
        guard transcript.starts(with: domain), transcript.count <= 24_000,
              let a = try JSONSerialization.jsonObject(with: transcript.dropFirst(domain.count)) as? [Any], a.count == 7,
              let version = a[0] as? NSNumber, version.intValue == 1, CFGetTypeID(version) != CFBooleanGetTypeID(), let operation = a[1] as? String,
              let id = a[2] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id,
              let at = a[3] as? Double, abs(at / 1000 - Date().timeIntervalSince1970) <= 60,
              let nonce = a[4] as? String, try ScreenCommunityRequest.decodeBase64(nonce, max: 43).count == 32,
              let args = a[6] as? [Any] else { throw ScreenCommunityError.malformed }
        let host = ScreenCommunityRequest.base64(state.hostKey), viewer = state.viewerKey.map(ScreenCommunityRequest.base64)
        switch operation {
        case "discover":
            guard a[5] is NSNull, args.count == 2, args[0] as? String == host, args[1] as? String == authority.profileID else { throw ScreenCommunityError.wrongCommunity }
        case "bootstrap", "join", "entry":
            guard a[5] is NSNull, args.count == 8, args[0] as? String == authority.profileID, args[1] as? String == state.deviceID,
                  args[3] as? String == host, let viewer, args[4] as? String == viewer, args[7] as? String == "mac",
                  let name = args[2] as? String, RegistrationInvite.isShowableName(name),
                  let grant = args[5] as? String, ScreenCommunityGrant(rawValue: grant) != nil,
                  let code = args[6] as? String, !code.isEmpty, code.utf8.count <= 120 else { throw ScreenCommunityError.wrongCommunity }
            guard state.certificate == nil else { throw ScreenCommunityError.service("ALREADY_ENROLLED") }
        case "recover":
            guard a[5] is NSNull, args.count == 4, args[0] as? String == authority.profileID, args[1] as? String == state.deviceID,
                  args[2] as? String == host, let viewer, args[3] as? String == viewer else { throw ScreenCommunityError.wrongCommunity }
        case "receipt":
            guard a[5] is NSNull, args.count == 1, let id = args[0] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ScreenCommunityError.malformed }
        case "directory", "lookup", "review", "invite", "route", "leave":
            let certificate = try certificate()
            guard a[5] as? String == certificate.member.enrollmentID, args.first as? String == certificate.communityID else { throw ScreenCommunityError.wrongCommunity }
            if ["lookup", "review", "invite"].contains(operation), !certificate.member.admin { throw ScreenCommunityError.service("ADMIN_REQUIRED") }
            switch operation {
            case "directory", "lookup", "invite", "leave": guard args.count == 1 else { throw ScreenCommunityError.malformed }
            case "review": guard args.count == 2, let id = args[1] as? String, UUID(uuidString: id)?.uuidString.lowercased() == id else { throw ScreenCommunityError.malformed }
            case "route": guard args.count == 2, args[1] is NSNull || (args[1] as? String).flatMap({ try? ScreenPrivateNetworkRoute(address: $0) }) != nil else { throw ScreenCommunityError.malformed }
            default: throw ScreenCommunityError.malformed
            }
        default: throw ScreenCommunityError.malformed // Never signs approve/revoke/push-register; leave only lowers own authority.
        }
    }
    public func commitCertificate(_ envelope: ScreenCommunityEnvelope) async throws {
        guard let viewer = state.viewerKey else { throw ScreenCommunityError.wrongCommunity }
        let new = try ScreenCommunityResponse.verify(envelope, issuer: authority.issuer)
            .certificate(profileID: authority.profileID, deviceID: state.deviceID, hostKey: state.hostKey, viewerKey: viewer)
        guard !(state.withdrawnEnrollmentIDs ?? []).contains(new.member.enrollmentID) else { throw ScreenCommunityError.service("REGISTRATION_REVOKED") }
        if let old = try? certificate() {
            guard old.communityID == new.communityID, old.member.enrollmentID == new.member.enrollmentID,
                  new.member.keyEpoch >= old.member.keyEpoch else { throw ScreenCommunityError.wrongCommunity }
        }
        if state.certificate != envelope { state.certificate = envelope; try save() }
        if directory?.isCurrent(at: Date()) != true { try await refresh() }
    }
    public func refresh() async throws {
        let certificate = try certificate()
        let request = try ScreenCommunityRequest(operation: .directory, actor: certificate.member.enrollmentID, arguments: [.string(certificate.communityID)])
        do {
            let response = try await ScreenCommunityHTTP(authority: authority).send(request.signed(by: identity), expectedRequestID: request.id)
            let current = try response.directory(for: certificate, minimumRevision: state.minimumRevision)
            if current.revision != state.minimumRevision { state.minimumRevision = current.revision; try save() }
            directory = current; didChange(current, state.held)
        } catch {
            let revoked: Bool
            if case ScreenCommunityError.service(let code) = error { revoked = ["NOT_ENROLLED", "REGISTRATION_REVOKED"].contains(code) } else { revoked = false }
            if revoked { try withdrawMembership() }
            else if directory?.isCurrent(at: Date()) != true { directory = nil; didChange(nil, state.held) }
            throw error
        }
    }
    private func withdrawMembership() throws {
        _ = try? ownerRecoveryTarget()
        ownerProtectedStore.invalidateInMemory();_ = try? ownerProtectedStore.closeLocally();viewerTargetHandoff=nil
        let old = try? certificate()
        if let old {
            let previous = state.withdrawnEnrollmentIDs ?? []
            // Do not forget old revoked identities to fit a cache budget.
            guard previous.count < 1024 || previous.contains(old.member.enrollmentID) else { throw ScreenCommunityError.service("MEMBERSHIP_HISTORY_FULL") }
            if !previous.contains(old.member.enrollmentID) { state.withdrawnEnrollmentIDs = previous + [old.member.enrollmentID] }
        }
        state.certificate = nil; directory = nil; state.accessCertificate = nil; accessDirectory = []
        try save(); didChange(nil, state.held); didAccessChange(nil, [], state.held)
    }
    public func hold(_ held: Bool) throws {
        state.held=held
        if held {try? ownerProtectedStore.invalidatePending()}
        try save();didChange(directory,held);didAccessChange(try? accessIdentity(),accessDirectory,held)
    }
    private func verifiedAccess(_ envelope: ScreenCommunityEnvelope, historical: Bool) throws -> CommunityAuthorization {
        let reply = try CommunityAccessReply.verify(envelope, authority: authority)
        let date = historical ? Date(timeIntervalSince1970: Double(reply.issuedAt) / 1000) : Date()
        let access = try reply.authorization(authority: authority, now: date), body = access.body
        guard body.deviceKind == .desktop, body.deviceId == state.deviceID, body.hostPublicKey == ScreenCommunityRequest.base64(state.hostKey),
              body.biometricPublicKey == state.viewerKey.map(ScreenCommunityRequest.base64), body.revision >= (state.minimumAccessRevision ?? 0),
              !(state.withdrawnEnrollmentIDs ?? []).contains(body.enrollmentId) else { throw ScreenCommunityError.wrongCommunity }
        return access
    }
    private func accessIdentity() throws -> CommunityAuthorization {
        guard let envelope = state.accessCertificate else { throw ScreenCommunityError.service("NOT_AUTHORIZED") }
        return try verifiedAccess(envelope, historical: true) // Identity for renewal only; never a current execution lease.
    }
    private func persistAccess(_ access: CommunityAuthorization) throws {
        let body = access.body
        if let old = try? accessIdentity() {
            guard old.body.communityId == body.communityId, old.body.enrollmentId == body.enrollmentId,
                  body.keyEpoch >= old.body.keyEpoch else { throw ScreenCommunityError.wrongCommunity }
            if try CommunityMobileControlPolicy.authorizationDigest(old) != CommunityMobileControlPolicy.authorizationDigest(access) {
                if state.ownerRecoveryInitialized==true {try? ownerProtectedStore.observePolicyChange()};viewerTargetHandoff=nil
            }
        }
        let changed = state.minimumAccessRevision != body.revision || state.accessCertificate == nil
        state.accessCertificate = access.envelope; state.minimumAccessRevision = body.revision
        if changed { try save() }
    }
    private func receiverRequest(_ operation: CommunityAccessRequest.Operation, _ extra: [String] = []) async throws -> CommunityAccessReply {
        let own = try accessIdentity()
        let request = try CommunityAccessRequest(operation: operation, actor: own.body.enrollmentId,
            argumentsJSON: JSONSerialization.data(withJSONObject: [own.body.communityId] + extra))
        return try await CommunityAccessHTTP(authority: authority).send(request.signed(by: identity), requestId: request.id)
    }
    public func refreshAccess() async throws {
        let old = try accessIdentity()
        guard old.body.capabilities.contains(.receiveView) else { didAccessChange(nil, [], state.held); return }
        do {
            let own = try await receiverRequest(.receiverStatus).authorization(authority: authority)
            _ = try verifiedAccess(own.envelope, historical: false); try persistAccess(own)
            let peers = try await receiverRequest(.receiverDirectory).directory(authority: authority, communityId: own.body.communityId)
            accessDirectory = peers; didAccessChange(own, peers, state.held)
        } catch {
            if !old.isCurrent() { accessDirectory = []; didAccessChange(nil, [], state.held) }
            throw error
        }
    }
    public func receiverAuthorization() async throws -> CommunityAuthorization {
        let current = try accessIdentity()
        if !current.isCurrent(at: Date().addingTimeInterval(20)) { try await refreshAccess() }
        let own = try accessIdentity()
        guard own.isCurrent(), !state.held, own.body.capabilities.contains(.receiveView) else { throw ScreenCommunityError.expired }
        return own
    }
    public func consentForTurningOn() async throws -> CommunityAuthorization {
        try await refreshAccess()
        let own = try accessIdentity()
        guard own.isCurrent(), own.body.capabilities.contains(.receiveView) else { throw ScreenCommunityError.expired }
        return own // A hardware action at Screen must still request turning on. This function does not enable it.
    }
    public func trustedConsentForTurningOn() async throws -> CommunityDesktopReceiveTrust {
        try await refreshAccess()
        guard !state.held else { throw ScreenCommunityError.service("RECEIVING_HELD") }
        return try CommunityDesktopReceiveTrust.verified(authority:authority,authorization:accessIdentity(),deviceID:state.deviceID,hostKey:ScreenCommunityRequest.base64(state.hostKey))
    }
    public func receiverTicket(connectionId: String) async throws -> CommunityRelayTicket {
        let own = try await receiverAuthorization()
        return try await receiverRequest(.receiverTicket, [connectionId]).relayTicket(for: own, connectionId: connectionId, purpose: .screen, role: .host)
    }
    public func relayProof(_ proof: CommunityRelayBindProof) async throws -> Data {
        let own = try await receiverAuthorization()
        guard proof.ticket.body.deviceId == own.body.deviceId, proof.ticket.body.enrollmentId == own.body.enrollmentId,
              proof.ticket.body.communityId == own.body.communityId, proof.ticket.body.role == .host,
              proof.ticket.body.purpose == .screen, proof.ticket.body.revision == own.body.revision else { throw ScreenCommunityError.wrongCommunity }
        return try await proof.signed(by: identity)
    }
    /// Refreshes authorization from the issuer, including the one common mobile idle session, without asking a person
    /// again. An expired/revoked session never becomes valid because video or a receiver poll is active.
    public func admitted(_ controller: CommunityAuthorization, session: CommunityUseSession?) async throws -> (CommunityAuthorization, CommunityAuthorization, CommunityUseSession?) {
        let own = try await receiverAuthorization()
        guard permitsSafetyPeer(controller.body.enrollmentId) else { throw ScreenCommunityError.service("SAFETY_PEER_REVOKED") }
        guard let current = accessDirectory.first(where: { $0.body.deviceId == controller.body.deviceId }), current.isCurrent(),
              current.body.enrollmentId == controller.body.enrollmentId, current.body.publicKey == controller.body.publicKey,
              current.body.hostPublicKey == controller.body.hostPublicKey, current.body.deviceKind == controller.body.deviceKind,
              current.body.revision == controller.body.revision, current.body.capabilities.contains(.screenView) else { throw ScreenCommunityError.wrongCommunity }
        if current.body.deviceKind == .mobile {
            guard let session else { throw ScreenCommunityError.malformed }
            let fresh = try await receiverRequest(.receiverSession, [current.body.enrollmentId, session.body.sessionId]).session(for: current)
            guard fresh.body.publicKey == session.body.publicKey, fresh.body.revision == session.body.revision else { throw ScreenCommunityError.wrongCommunity }
            return (own, current, fresh)
        }
        guard session == nil else { throw ScreenCommunityError.malformed }
        return (own, current, nil)
    }
    public func receiverHandshake(replay: NonceReplayCache) async throws -> CommunityScreenHostHandshake {
        let own = try await receiverAuthorization()
        return try CommunityScreenHostHandshake(authority: authority, own: own, signer: identity, replay: replay) { [weak self] controller, session in
            guard let self else { throw ScreenCommunityError.expired }
            _ = try await self.admitted(controller, session: session)
        }
    }
}
#endif
