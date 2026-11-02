#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import "../computer-use/ClientBridge/ComputerUseClientBridge.h"
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <sys/types.h>
#include <unistd.h>
#include <fcntl.h>
#include <errno.h>
#include <pthread.h>
#include <arpa/inet.h>

// Only a public Control candidate, an issuer-signed lease, or local authority reduction. No sign/input/session API.
static NSString * const ATZMainRequirement = @"anchor apple generic and identifier \"com.intenet.agentstozbycs\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
static NSString * const ATZViewerRequirement = @"anchor apple generic and identifier \"com.intenet.agentstozbycs.viewer\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
static BOOL ATZValidSelf(void) {
    if (![NSBundle.mainBundle.bundleIdentifier isEqualToString:@"com.intenet.agentstozbycs"] ||
        ![NSBundle.mainBundle.bundleURL.URLByResolvingSymlinksInPath.path isEqualToString:@"/Applications/AgentsToZ_byCS.app"]) return NO;
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    OSStatus result = SecCodeCopySelf(kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)ATZMainRequirement, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (code) CFRelease(code); if (requirement) CFRelease(requirement); return result == errSecSuccess;
}
static BOOL ATZValidViewer(int fd) {
    uid_t uid = 0; gid_t gid = 0; audit_token_t token = {}; socklen_t length = sizeof(token);
    if (getpeereid(fd, &uid, &gid) != 0 || uid != getuid() ||
        getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) != 0 || length != sizeof(token)) return NO;
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    NSData *audit = [NSData dataWithBytes:&token length:sizeof(token)];
    OSStatus result = SecCodeCopyGuestWithAttributes(NULL, (__bridge CFDictionaryRef)@{(__bridge id)kSecGuestAttributeAudit:audit}, kSecCSDefaultFlags, &code);
    if (result == errSecSuccess) result = SecRequirementCreateWithString((__bridge CFStringRef)ATZViewerRequirement, kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (code) CFRelease(code); if (requirement) CFRelease(requirement); return result == errSecSuccess;
}
static BOOL ATZUUID(id value) {
    return [value isKindOfClass:NSString.class] && [[[NSUUID alloc] initWithUUIDString:value].UUIDString.lowercaseString isEqualToString:value];
}
// Exported for a deterministic protocol check; it has no native dispatch or authority side effect.
NSData *ATZCommunityEnrollmentRequest(NSData *data, NSString *agentDeviceId) {
    if (data.length < 2 || data.length > 16384) return nil;
    id raw = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![raw isKindOfClass:NSDictionary.class]) return nil;
    NSDictionary *object = raw;
    if (![object[@"operation"] isKindOfClass:NSString.class]) return nil;
    NSString *operation = object[@"operation"];
    NSMutableDictionary *native = [@{@"v":@3,@"channel":@"management"} mutableCopy];
    if ([operation isEqualToString:@"prepare"] && object.count == 3 && ATZUUID(object[@"profileId"]) && ATZUUID(object[@"deviceId"])) {
        if (!ATZUUID(agentDeviceId)) return nil;
        native[@"op"] = @"community-prepare"; native[@"profileId"] = object[@"profileId"]; native[@"deviceId"] = object[@"deviceId"];
        native[@"agentDeviceId"] = agentDeviceId; // Never read from the Viewer's request.

    } else if ([operation isEqualToString:@"disable"] && object.count == 1) {
        native[@"op"] = @"community-disable";
    } else if ([operation isEqualToString:@"install"] && object.count == 3 && ATZUUID(object[@"requestId"]) && [object[@"envelope"] isKindOfClass:NSDictionary.class]) {
        NSDictionary *envelope = object[@"envelope"];
        if (envelope.count != 2 || ![envelope[@"payload"] isKindOfClass:NSString.class] || ![envelope[@"signature"] isKindOfClass:NSString.class] ||
            [envelope[@"payload"] length] > 12000 || [envelope[@"signature"] length] != 86) return nil;
        native[@"op"] = @"community-install"; native[@"requestId"] = object[@"requestId"]; native[@"envelope"] = envelope;
    } else return nil;
    return [NSJSONSerialization dataWithJSONObject:native options:0 error:nil];
}
static BOOL ATZRead(int fd, void *bytes, size_t size) {
    size_t offset = 0;
    while (offset < size) { ssize_t n = recv(fd, (uint8_t *)bytes + offset, size - offset, 0); if (n < 0 && errno == EINTR) continue; if (n <= 0) return NO; offset += (size_t)n; }
    return YES;
}
static BOOL ATZWrite(int fd, const void *bytes, size_t size) {
    size_t offset = 0;
    while (offset < size) { ssize_t n = send(fd, (const uint8_t *)bytes + offset, size - offset, 0); if (n < 0 && errno == EINTR) continue; if (n <= 0) return NO; offset += (size_t)n; }
    return YES;
}
static void ATZConfigure(int fd) {
    int yes = 1; struct timeval timeout = {.tv_sec=12,.tv_usec=0};
    (void)setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
    (void)setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    (void)setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
}
static NSString *ATZCurrentAgentDeviceId(void) {
    NSString *path = [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/com.portmanager.portmanager/portal.json"];
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return nil;
    struct stat info = {};
    if (fstat(fd, &info) != 0 || info.st_uid != getuid() || !S_ISREG(info.st_mode) || (info.st_mode & 022) != 0 || info.st_size < 2 || info.st_size > 1048576) { close(fd); return nil; }
    NSMutableData *data = [NSMutableData dataWithLength:(NSUInteger)info.st_size];
    size_t offset = 0;
    while (offset < data.length) {
        ssize_t amount = read(fd, (uint8_t *)data.mutableBytes + offset, data.length - offset);
        if (amount < 0 && errno == EINTR) continue;
        if (amount <= 0) { close(fd); return nil; }
        offset += (size_t)amount;
    }
    close(fd);
    id value = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class] || !ATZUUID(value[@"deviceId"])) return nil;
    return value[@"deviceId"]; // Only the installation UUID leaves this loader; no portal settings or credentials.
}
static void ATZServe(int client) {
    @autoreleasepool {
        ATZConfigure(client);
        if (!ATZValidViewer(client)) { close(client); return; }
        uint32_t count = 0;
        if (!ATZRead(client, &count, sizeof(count))) { close(client); return; }
        count = ntohl(count); if (count < 2 || count > 16384) { close(client); return; }
        NSMutableData *request = [NSMutableData dataWithLength:count];
        if (!ATZRead(client, request.mutableBytes, count)) { close(client); return; }
        id intent = [NSJSONSerialization JSONObjectWithData:request options:0 error:nil];
        if (![intent isKindOfClass:NSDictionary.class]) { close(client); return; }
        NSString *agentDeviceId = [intent[@"operation"] isEqual:@"prepare"] ? ATZCurrentAgentDeviceId() : nil;
        NSData *native = ATZCommunityEnrollmentRequest(request, agentDeviceId);
        if (!native) { close(client); return; }
        uint8_t *response = NULL; size_t length = 0;
        int32_t code = agentstoz_control_request(native.bytes, native.length, &response, &length);
        NSData *reply = nil;
        if (code == 0 && response && length >= 2 && length <= 16384) reply = [NSData dataWithBytes:response length:length];
        if (response) agentstoz_control_response_free(response);
        if (!reply) reply = [NSJSONSerialization dataWithJSONObject:@{@"success":@NO,@"code":@"control-unavailable"} options:0 error:nil];
        uint32_t frame = htonl((uint32_t)reply.length);
        if (ATZWrite(client, &frame, sizeof(frame))) (void)ATZWrite(client, reply.bytes, reply.length);
        close(client);
    }
}
static NSString *ATZSocketPath(void) {
    return [NSHomeDirectory() stringByAppendingPathComponent:@"Library/Application Support/AgentsToZ Enrollment/main.sock"];
}
int32_t agentstoz_community_enrollment_start(void) {
    if (!ATZValidSelf()) return -1;
    NSString *path = ATZSocketPath(), *directory = path.stringByDeletingLastPathComponent;
    if (mkdir(directory.fileSystemRepresentation, 0700) != 0 && errno != EEXIST) return -2;
    struct stat info = {};
    if (lstat(directory.fileSystemRepresentation, &info) != 0 || info.st_uid != getuid() || !S_ISDIR(info.st_mode) || (info.st_mode & 077) != 0) return -2;
    struct sockaddr_un address = {}; address.sun_family = AF_UNIX; address.sun_len = sizeof(address);
    if (strlen(path.fileSystemRepresentation) >= sizeof(address.sun_path)) return -2;
    strlcpy(address.sun_path, path.fileSystemRepresentation, sizeof(address.sun_path));
    if (lstat(path.fileSystemRepresentation, &info) == 0) {
        if (info.st_uid != getuid() || !S_ISSOCK(info.st_mode)) return -2;
        int probe = socket(AF_UNIX, SOCK_STREAM, 0); if (probe < 0) return -2;
        int result = connect(probe, (struct sockaddr *)&address, sizeof(address)), failure = errno; close(probe);
        if (result == 0 || failure != ECONNREFUSED) return -3;
        struct stat again = {};
        if (lstat(path.fileSystemRepresentation, &again) != 0 || again.st_ino != info.st_ino || unlink(path.fileSystemRepresentation) != 0) return -2;
    } else if (errno != ENOENT) return -2;
    int fd = socket(AF_UNIX, SOCK_STREAM, 0); if (fd < 0) return -2;
    (void)fcntl(fd, F_SETFD, FD_CLOEXEC);
    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) != 0 || chmod(path.fileSystemRepresentation, 0600) != 0 || listen(fd, 4) != 0) { close(fd); return -2; }
    // One bounded request at a time, at most four queued sockets. A signed client cannot grow an unbounded work queue.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
        while (YES) {
            int client = accept(fd, NULL, NULL);
            if (client < 0) { if (errno == EINTR) continue; break; }
            ATZServe(client);
        }
        close(fd);
    });
    return 0;
}
