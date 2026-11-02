/* Node-API v1. This addon protects the inherited socket and verifies its Main peer; it grants no input or keychain authority. */
#define NAPI_VERSION 1
#include <node_api.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <bsm/libbsm.h>
#include <libproc.h>
#include <string.h>
#include <sys/un.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#include <pthread.h>
#include "peer_pin.h"

/* This sidecar has one inherited link. Serialize even if the addon is loaded by another JS environment. */
static peer_pin main_pin = {0};
static pthread_mutex_t main_pin_lock = PTHREAD_MUTEX_INITIALIZER;
static bool verified_main(int descriptor, const peer_pin *expected, audit_token_t *verified);

static int socket_descriptor(napi_env env, napi_callback_info info) {
    size_t count = 1; napi_value value; int32_t descriptor = -1; struct stat status;
    if (napi_get_cb_info(env, info, &count, &value, NULL, NULL) != napi_ok || count != 1 ||
        napi_get_value_int32(env, value, &descriptor) != napi_ok || descriptor < 3 ||
        fstat(descriptor, &status) != 0 || !S_ISSOCK(status.st_mode)) {
        napi_throw_error(env, "invalid-private-socket", "A live inherited socket is required."); return -1;
    }
    return descriptor;
}
static napi_value prepare(napi_env env, napi_callback_info info) {
    int descriptor = socket_descriptor(env, info); if (descriptor < 0) return NULL;
    int flags = fcntl(descriptor, F_GETFD);
    if (flags < 0 || fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) < 0) {
        napi_throw_error(env, "private-socket-unsafe", "Cannot prevent private socket inheritance."); return NULL;
    }
    flags = fcntl(descriptor, F_GETFD);
    if (flags < 0 || (flags & FD_CLOEXEC) == 0) {
        napi_throw_error(env, "private-socket-unsafe", "Cannot prevent private socket inheritance."); return NULL;
    }
    pthread_mutex_lock(&main_pin_lock);
    if (!peer_pin_begin(&main_pin, descriptor)) {
        pthread_mutex_unlock(&main_pin_lock);
        napi_throw_error(env, "private-socket-already-prepared", "The private socket was already prepared."); return NULL;
    }
    audit_token_t token = {0};
    bool valid = verified_main(descriptor, NULL, &token);
    peer_pin_commit(&main_pin, &token, valid);
    pthread_mutex_unlock(&main_pin_lock);
    napi_value result; napi_get_boolean(env, true, &result); return result;
}
/* LOCAL_PEERTOKEN reflects the peer socket's last accessor, not an immutable socket owner.
 * Pin only after the first Security check; compare with that token on all subsequent checks.
 * This cannot prove who held or transferred the endpoint before the first check. */
static bool verified_main(int descriptor, const peer_pin *expected_pin, audit_token_t *verified) {
    audit_token_t token = {0}, after = {0}; socklen_t len = sizeof(token), after_len = sizeof(after);
    if (getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &len) != 0 || len != sizeof(token)) return false;
    if (expected_pin && !peer_pin_matches(expected_pin, descriptor, &token)) return false;
    pid_t pid = audit_token_to_pid(token);
    char path[PROC_PIDPATHINFO_MAXSIZE] = {0}, after_path[PROC_PIDPATHINFO_MAXSIZE] = {0};
    const char *expected = "/Applications/AgentsToZ_byCS.app/Contents/MacOS/app";
    if (pid <= 1 || proc_pidpath(pid, path, sizeof(path)) <= 0 || strcmp(path, expected) != 0) return false;
    CFDataRef data = CFDataCreate(kCFAllocatorDefault, (const UInt8 *)&token, sizeof(token));
    if (!data) return false;
    const void *keys[] = {kSecGuestAttributeAudit}; const void *values[] = {data};
    CFDictionaryRef attrs = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL; SecRequirementRef requirement = NULL;
    OSStatus result = attrs ? SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code) : errSecAllocate;
    if (result == errSecSuccess) result = SecRequirementCreateWithString(CFSTR("anchor apple generic and identifier \"com.intenet.agentstozbycs\" and certificate leaf[subject.OU] = \"DA8QKAQ2C9\" and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"), kSecCSDefaultFlags, &requirement);
    if (result == errSecSuccess) result = SecCodeCheckValidity(code, kSecCSStrictValidate, requirement);
    if (requirement) CFRelease(requirement); if (code) CFRelease(code); if (attrs) CFRelease(attrs); CFRelease(data);
    if (result != errSecSuccess || proc_pidpath(pid, after_path, sizeof(after_path)) <= 0 || strcmp(after_path, expected) != 0 ||
        getsockopt(descriptor, SOL_LOCAL, LOCAL_PEERTOKEN, &after, &after_len) != 0 || after_len != sizeof(after) || memcmp(&token, &after, sizeof(token)) != 0) return false;
    if (verified) *verified = token;
    return true;
}
static napi_value verify_main(napi_env env, napi_callback_info info) {
    int descriptor = socket_descriptor(env, info); if (descriptor < 0) return NULL;
    pthread_mutex_lock(&main_pin_lock);
    bool valid = main_pin.pinned && main_pin.descriptor == descriptor &&
        verified_main(descriptor, &main_pin, NULL);
    pthread_mutex_unlock(&main_pin_lock);
    napi_value result; napi_get_boolean(env, valid, &result); return result;
}
static napi_value stop(napi_env env, napi_callback_info info) {
    int descriptor = socket_descriptor(env, info); if (descriptor < 0) return NULL;
    /* Wakes a pending async read before JS closes the descriptor. No retry and no replacement connection. */
    (void)shutdown(descriptor, SHUT_RDWR);
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "verifiedMain", NAPI_AUTO_LENGTH, verify_main, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "verifiedMain", fn) != napi_ok ||
        napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, prepare, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "prepare", fn) != napi_ok ||
        napi_create_function(env, "stop", NAPI_AUTO_LENGTH, stop, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "stop", fn) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
