/* Node-API v1 only. This addon gives no input, keychain or XPC authority: it only protects an inherited socket. */
#define NAPI_VERSION 1
#include <node_api.h>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

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
    if (flags < 0 || fcntl(descriptor, F_SETFD, flags | FD_CLOEXEC) < 0 ||
        (fcntl(descriptor, F_GETFD) & FD_CLOEXEC) == 0) {
        napi_throw_error(env, "private-socket-unsafe", "Cannot prevent private socket inheritance."); return NULL;
    }
    napi_value result; napi_get_boolean(env, true, &result); return result;
}
static napi_value stop(napi_env env, napi_callback_info info) {
    int descriptor = socket_descriptor(env, info); if (descriptor < 0) return NULL;
    /* Wakes a pending async read before JS closes the descriptor. No retry and no replacement connection. */
    (void)shutdown(descriptor, SHUT_RDWR);
    napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value initialize(napi_env env, napi_value exports) {
    napi_value fn;
    if (napi_create_function(env, "prepare", NAPI_AUTO_LENGTH, prepare, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "prepare", fn) != napi_ok ||
        napi_create_function(env, "stop", NAPI_AUTO_LENGTH, stop, NULL, &fn) != napi_ok ||
        napi_set_named_property(env, exports, "stop", fn) != napi_ok) return NULL;
    return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
