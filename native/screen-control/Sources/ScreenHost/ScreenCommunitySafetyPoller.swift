#if os(macOS)
import Foundation
import ScreenControlCore

/// Actual native host polls, not subscription metadata, establish this process-only common receiving witness.
/// Failure closes immediately. A receipt never moves its original monotonic dispatch tick forward.
@MainActor
final class ScreenCommunitySafetyPoller {
    typealias Poll = @MainActor () async throws -> CommunitySafetyRound
    typealias Apply = @MainActor (CommunitySafetyCommand) async throws -> Void
    private let now: @Sendable () -> Date
    private let uptime: @Sendable () -> TimeInterval
    private let changed: @MainActor (Bool, String) -> Void
    private let pause:@Sendable () async throws -> Void
    private let waitForDeadline:@Sendable (TimeInterval) async throws -> Void
    private var task: Task<Void,Never>?, expiry: Task<Void,Never>?
    private var generation=UUID(), binding:String?, deadline:TimeInterval?
    private var dispatches:[String:TimeInterval]=[:]
    private(set) var ready=false
    init(now:@escaping @Sendable () -> Date = { Date() },uptime:@escaping @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },pause:@escaping @Sendable () async throws -> Void = { try await Task.sleep(for:.seconds(30)) },waitForDeadline:@escaping @Sendable (TimeInterval) async throws -> Void = { try await Task.sleep(for:.seconds($0)) },changed:@escaping @MainActor (Bool,String)->Void) {
        self.now=now;self.uptime=uptime;self.changed=changed;self.pause=pause;self.waitForDeadline=waitForDeadline
    }
    var isReady:Bool { ready && deadline.map { uptime() < $0 } == true }
    @discardableResult func stop() -> Task<Void,Never>? {
        let previous=task
        generation=UUID();task?.cancel();task=nil;expiry?.cancel();expiry=nil;binding=nil;dispatches=[:]
        invalidate("공통 수신 중지 · 등록 상태는 유지됩니다.")
        return previous
    }
    func invalidate(_ reason:String) {
        deadline=nil;ready=false;expiry?.cancel();expiry=nil;changed(false,reason)
    }
    func start(binding:String,poll:@escaping Poll,apply:@escaping Apply) {
        guard self.binding != binding || task == nil else { return }
        stop();self.binding=binding;let epoch=generation
        changed(false,"등록 완료 · 모바일 알림·원격 중지 통로를 확인하는 중…")
        task=Task { [weak self] in
            while !Task.isCancelled {
                guard let self,self.generation==epoch else { return }
                let started=self.uptime()
                do {
                    let round=try await poll()
                    guard self.generation==epoch,!Task.isCancelled else { return }
                    try self.accept(round,dispatchedAt:started)
                    for command in round.commands {
                        guard self.generation==epoch,self.isReady,!Task.isCancelled else { return }
                        try await apply(command)
                    }
                } catch {
                    guard self.generation==epoch else { return }
                    self.invalidate("등록 유지 · 공통 수신 안전 연결을 확인하지 못했습니다. 네트워크·관리 모바일의 알림 상태를 확인하세요.")
                }
                try? await self.pause()
            }
        }
    }
    /// Also used by software checks with a fixed clock. Does not create a task, listener or session.
    func accept(_ round:CommunitySafetyRound,dispatchedAt:TimeInterval) throws {
        let first=dispatches[round.pollRequestId] ?? dispatchedAt
        dispatches[round.pollRequestId]=first
        if dispatches.count>64 { dispatches=dispatches.filter { uptime()-$0.value<1_800 } }
        let remaining=Double(round.expiresAt)/1000-now().timeIntervalSince1970
        let end=min(first+1_800,first+remaining)
        guard remaining>0,end>uptime(),!round.watchers.isEmpty else { invalidate("공통 수신 안전 확인이 만료되었습니다.");throw ScreenCommunityError.expired }
        deadline=end;ready=true;changed(true,"공통 수신 준비됨 · 실제 화면 연결은 사용 기기에서 시작하세요.")
        expiry?.cancel();let epoch=generation,expected=end
        expiry=Task { [weak self] in
            guard let self else { return }
            try? await self.waitForDeadline(max(0,expected-self.uptime()))
            guard !Task.isCancelled,self.generation==epoch,self.deadline==expected else { return }
            self.invalidate("등록 유지 · 공통 수신 안전 확인이 만료되었습니다.")
        }
    }
}

/// A newer common connection owns the only renewal scope. Old asynchronous outcomes may not mutate its deadline.
@MainActor
final class ScreenCommunityRenewalScope {
    struct Token:Equatable,Sendable { fileprivate let id=UUID() }
    private var current:Token?
    func begin() -> Token { let token=Token();current=token;return token }
    func cancel() { current=nil }
    func permits(_ token:Token) -> Bool { current==token && !Task.isCancelled }
    @discardableResult func perform(_ token:Token,_ operation:()->Void) -> Bool {
        guard permits(token) else { return false };operation();return true
    }
}
#endif
