#include <assert.h>
#include <pthread.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include "../../src-tauri/native/computer-use/PrivateLink/peer_pin.h"

static bool token_of(int fd, audit_token_t *token) {
    socklen_t len = sizeof(*token);
    return getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, token, &len) == 0 && len == sizeof(*token);
}
static void *exchange(void *arg) {
    int fd = *(int *)arg;
    char b;
    for (int i = 0; i < 100; ++i) {
        assert(read(fd, &b, 1) == 1);
        assert(write(fd, &b, 1) == 1);
    }
    return NULL;
}
int main(void) {
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    audit_token_t first = {0}, current = {0}; assert(token_of(pair[0], &first));
    peer_pin pin = {0}, refused = {0};
    assert(peer_pin_begin(&pin, pair[0])); peer_pin_commit(&pin, &first, true);
    assert(!peer_pin_begin(&pin, pair[0]));
    assert(peer_pin_matches(&pin, pair[0], &first));
    audit_token_t changed = first; changed.val[7] ^= 1;
    assert(!peer_pin_matches(&pin, pair[0], &changed));
    peer_pin_commit(&pin, &changed, true); assert(peer_pin_matches(&pin, pair[0], &first));
    assert(peer_pin_begin(&refused, pair[0])); peer_pin_commit(&refused, &first, false);
    peer_pin_commit(&refused, &first, true); assert(!peer_pin_matches(&refused, pair[0], &first));
    int second = dup(pair[0]); assert(second >= 0);
    assert(!peer_pin_matches(&pin, second, &first));
    int peer_copy = dup(pair[1]); assert(peer_copy >= 0);
    close(pair[1]); assert(token_of(pair[0], &current));
    assert(peer_pin_matches(&pin, pair[0], &current));
    pthread_t thread; assert(pthread_create(&thread, NULL, exchange, &peer_copy) == 0);
    for (int i = 0; i < 100; ++i) {
        char b = 'x'; assert(write(pair[0], &b, 1) == 1);
        assert(token_of(pair[0], &current)); assert(peer_pin_matches(&pin, pair[0], &current));
        assert(read(pair[0], &b, 1) == 1);
    }
    assert(pthread_join(thread, NULL) == 0);
    int release[2]; assert(pipe(release) == 0);
    pid_t child = fork(); assert(child >= 0);
    if (child == 0) {
        close(release[1]); close(pair[0]); close(second);
        char byte = 'y'; if (write(peer_copy, &byte, 1) != 1 || read(release[0], &byte, 1) != 1) _exit(1);
        _exit(0);
    }
    close(release[0]);
    char byte; assert(read(pair[0], &byte, 1) == 1);
    assert(token_of(pair[0], &current)); assert(!peer_pin_matches(&pin, pair[0], &current));
    assert(write(release[1], "x", 1) == 1); close(release[1]);
    int status; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    close(peer_copy);
    assert(!token_of(pair[0], &current));
    close(second); close(pair[0]);
    return 0;
}
