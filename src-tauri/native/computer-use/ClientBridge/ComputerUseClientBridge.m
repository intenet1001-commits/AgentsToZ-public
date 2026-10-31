#import <Foundation/Foundation.h>
#import <AppKit/AppKit.h>
#import <Security/Security.h>
#import "ComputerUseClientBridge.h"
#include <stdlib.h>
#include <string.h>
#include <sys/sysctl.h>
#include <time.h>
#include <unistd.h>

@protocol AgentsToZControlXPC
- (void)request:(NSData *)data reply:(void (^)(NSData *data))reply;
- (void)reviewIdentity:(void (^)(int32_t pid, uint64_t start))reply;
@end

static NSString * const MainRequirement = @"anchor apple generic and identifier \"com.intenet.agentstozbycs\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
static NSString * const HelperRequirement = @"anchor apple generic and identifier \"com.intenet.agentstozbycs.control\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";

@interface ATZControlReply : NSObject
@property(nonatomic, strong) NSLock *lock;
@property(nonatomic, strong) NSData *data;
@property(nonatomic) int32_t code;
@property(nonatomic) BOOL finished;
@property(nonatomic, strong) dispatch_semaphore_t signal;
- (void)finish:(NSData *)data code:(int32_t)code;
@end
@implementation ATZControlReply
- (instancetype)init {
    self = [super init];
    if (self) { _lock = [NSLock new]; _signal = dispatch_semaphore_create(0); }
    return self;
}
- (void)finish:(NSData *)data code:(int32_t)code {
    [self.lock lock];
    if (!self.finished) { self.data = [data copy]; self.code = code; self.finished = YES; dispatch_semaphore_signal(self.signal); }
    [self.lock unlock];
}
@end

static BOOL ValidMainIdentity(void) {
    NSString *path = NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath.path;
    if (![NSBundle.mainBundle.bundleIdentifier isEqualToString:@"com.intenet.agentstozbycs"] ||
        ![path isEqualToString:@"/Applications/AgentsToZ_byCS.app"]) return NO;
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    OSStatus result = SecCodeCopySelf(kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)MainRequirement, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (requirement) CFRelease(requirement); if (code) CFRelease(code);
    return result == errSecSuccess;
}

// Exact kernel process generation; a recycled PID is never an activation target.
static uint64_t ProcessStart(pid_t pid) {
    if (pid <= 0) return 0;
    int mib[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
    struct kinfo_proc info = {0}; size_t size = sizeof(info);
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size != sizeof(info) || info.kp_proc.p_pid != pid ||
        info.kp_proc.p_starttime.tv_sec <= 0 || info.kp_proc.p_starttime.tv_usec < 0) return 0;
    return (uint64_t)info.kp_proc.p_starttime.tv_sec * 1000000ULL + (uint64_t)info.kp_proc.p_starttime.tv_usec;
}

static BOOL ValidReviewPeer(NSXPCConnection *connection, pid_t pid, uint64_t start) {
    if (pid <= 0 || start == 0 || connection.processIdentifier != pid || ProcessStart(pid) != start) return NO;
    NSRunningApplication *app = [NSRunningApplication runningApplicationWithProcessIdentifier:pid];
    if (!app || app.isTerminated || ![app.bundleIdentifier isEqualToString:@"com.intenet.agentstozbycs.control"]) return NO;
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    NSDictionary *attributes = @{(__bridge id)kSecGuestAttributePid: @(pid)};
    OSStatus result = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)attributes, kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)HelperRequirement, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (requirement) CFRelease(requirement); if (code) CFRelease(code);
    return result == errSecSuccess && ProcessStart(pid) == start && connection.processIdentifier == pid;
}

static BOOL IsExplicitReviewRequest(NSData *data) {
    id raw = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![raw isKindOfClass:NSDictionary.class]) return NO;
    NSDictionary *object = raw;
    id version = object[@"v"];
    return object.count == 3 && [version isKindOfClass:NSNumber.class] &&
        CFGetTypeID((__bridge CFTypeRef)version) != CFBooleanGetTypeID() && [version isEqual:@1] &&
        [object[@"channel"] isEqual:@"management"] &&
        [object[@"op"] isEqual:@"show-review"];
}

// Verification may be slow. A timed-out caller can cancel while verify runs; the last deadline and state checks
// are serialized with cancellation so a queued main-thread task never yields after it has been cancelled.
static void RunActivationGate(ATZControlReply *result, uint64_t deadline, BOOL (^verify)(void),
                              BOOL (^ready)(void), void (^action)(void)) {
    BOOL verified = verify();
    BOOL isReady = verified && ready();
    [result.lock lock];
    if (!result.finished) {
        BOOL allowed = isReady && clock_gettime_nsec_np(CLOCK_UPTIME_RAW) < deadline;
        if (allowed) { action(); result.code = 0; }
        else { result.code = -8; }
        result.finished = YES; dispatch_semaphore_signal(result.signal);
    }
    [result.lock unlock];
}

int32_t agentstoz_control_request(const uint8_t *request, size_t length, uint8_t **response, size_t *responseLength) {
    if (response) *response = NULL; if (responseLength) *responseLength = 0;
    if (!request || length < 2 || length > 16384 || !response || !responseLength) return -2;
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            // A CLI, ad-hoc app, renamed bundle or a development browser is never a privileged proxy.
            if (!ValidMainIdentity()) return -1;
            SecRequirementRef checked = NULL;
            if (SecRequirementCreateWithString((__bridge CFStringRef)HelperRequirement, kSecCSDefaultFlags, &checked) != errSecSuccess) return -1;
            CFRelease(checked);
            NSXPCConnection *connection = [[NSXPCConnection alloc] initWithMachServiceName:@"com.intenet.agentstozbycs.control.xpc" options:0];
            connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:@protocol(AgentsToZControlXPC)];
            [connection setCodeSigningRequirement:HelperRequirement];
            ATZControlReply *result = [ATZControlReply new];
            [connection resume];
            id<AgentsToZControlXPC> proxy = [connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
                (void)error; [result finish:nil code:-3];
            }];
            NSData *requestData = [NSData dataWithBytes:request length:length];
            if (IsExplicitReviewRequest(requestData)) {
                // Never synchronously wait for the main queue while already on it.
                if (NSThread.isMainThread) { [connection invalidate]; return -8; }
                ATZControlReply *identity = [ATZControlReply new];
                id<AgentsToZControlXPC> identityProxy = [connection remoteObjectProxyWithErrorHandler:^(NSError *error) {
                    (void)error; [identity finish:nil code:-3];
                }];
                [identityProxy reviewIdentity:^(int32_t pid, uint64_t start) {
                    NSData *data = [NSJSONSerialization dataWithJSONObject:@{@"pid": @(pid), @"start": @(start)} options:0 error:nil];
                    [identity finish:data code:data ? 0 : -4];
                }];
                if (dispatch_semaphore_wait(identity.signal, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) {
                    [identity finish:nil code:-8]; [connection invalidate]; return -8;
                }
                [identity.lock lock]; NSData *identityData = identity.data; int32_t identityCode = identity.code; [identity.lock unlock];
                id peerObject = identityData ? [NSJSONSerialization JSONObjectWithData:identityData options:0 error:nil] : nil;
                if (![peerObject isKindOfClass:NSDictionary.class] || ![peerObject[@"pid"] isKindOfClass:NSNumber.class] ||
                    ![peerObject[@"start"] isKindOfClass:NSNumber.class]) { [connection invalidate]; return -8; }
                NSDictionary *peer = peerObject;
                pid_t peerPID = [peer[@"pid"] intValue]; uint64_t peerStart = [peer[@"start"] unsignedLongLongValue];
                if (identityCode != 0 || !ValidReviewPeer(connection, peerPID, peerStart)) { [connection invalidate]; return -8; }
                ATZControlReply *activation = [ATZControlReply new];
                uint64_t activationDeadline = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 3 * NSEC_PER_SEC;
                dispatch_async(dispatch_get_main_queue(), ^{
                    __block NSRunningApplication *peerApp = nil;
                    RunActivationGate(activation, activationDeadline, ^BOOL{
                        return ValidReviewPeer(connection, peerPID, peerStart);
                    }, ^BOOL{
                        if (!NSApp.isActive || NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier != getpid() ||
                            connection.processIdentifier != peerPID || ProcessStart(peerPID) != peerStart) return NO;
                        peerApp = [NSRunningApplication runningApplicationWithProcessIdentifier:peerPID];
                        return peerApp && !peerApp.isTerminated && ProcessStart(peerPID) == peerStart;
                    }, ^{ [NSApp yieldActivationToApplication:peerApp]; });
                });
                if (dispatch_semaphore_wait(activation.signal, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) != 0) {
                    [activation finish:nil code:-8]; [connection invalidate]; return -8;
                }
                [activation.lock lock]; int32_t activationCode = activation.code; [activation.lock unlock];
                if (activationCode != 0) { [connection invalidate]; return -8; }
            }
            [proxy request:requestData reply:^(NSData *data) {
                if (![data isKindOfClass:NSData.class] || data.length < 2 || data.length > 524288) [result finish:nil code:-4];
                else [result finish:data code:0];
            }];
            if (dispatch_semaphore_wait(result.signal, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC)) != 0) {
                [connection invalidate]; return -5;
            }
            [connection invalidate];
            [result.lock lock]; NSData *data = result.data; int32_t code = result.code; [result.lock unlock];
            if (code != 0 || !data) return code == 0 ? -4 : code;
            uint8_t *bytes = malloc(data.length); if (!bytes) return -4;
            memcpy(bytes, data.bytes, data.length); *response = bytes; *responseLength = data.length; return 0;
        }
        return -6;
    }
}
void agentstoz_control_response_free(uint8_t *response) { free(response); }

// Human UI entry only. It opens a fixed, verified sibling app; it never registers a service or grants permissions.
int32_t agentstoz_control_open(void) {
    @autoreleasepool {
        if (@available(macOS 14.0, *)) {
            if (!ValidMainIdentity()) return -1;
            NSURL *url = [NSURL fileURLWithPath:@"/Applications/AgentsToZ Control.app" isDirectory:YES];
            SecStaticCodeRef code = NULL; SecRequirementRef requirement = NULL;
            OSStatus status = SecStaticCodeCreateWithPath((__bridge CFURLRef)url, kSecCSDefaultFlags, &code);
            if (status == errSecSuccess) status = SecRequirementCreateWithString((__bridge CFStringRef)HelperRequirement, kSecCSDefaultFlags, &requirement);
            if (status == errSecSuccess) status = SecStaticCodeCheckValidity(code, kSecCSStrictValidate, requirement);
            if (requirement) CFRelease(requirement); if (code) CFRelease(code);
            if (status != errSecSuccess) return -7;
            ATZControlReply *result = [ATZControlReply new];
            NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
            configuration.activates = YES;
            [[NSWorkspace sharedWorkspace] openApplicationAtURL:url configuration:configuration completionHandler:^(NSRunningApplication *app, NSError *error) {
                [result finish:nil code:(app && !error) ? 0 : -3];
            }];
            if (dispatch_semaphore_wait(result.signal, dispatch_time(DISPATCH_TIME_NOW, 8 * NSEC_PER_SEC)) != 0) return -5;
            [result.lock lock]; int32_t response = result.code; [result.lock unlock]; return response;
        }
        return -6;
    }
}
