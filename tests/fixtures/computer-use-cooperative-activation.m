#import "../../src-tauri/native/computer-use/ClientBridge/ComputerUseClientBridge.m"
#include <assert.h>

static NSData *json(const char *text) { return [[NSString stringWithUTF8String:text] dataUsingEncoding:NSUTF8StringEncoding]; }
int main(void) {
    @autoreleasepool {
        assert(IsExplicitReviewRequest(json("{\"v\":1,\"channel\":\"management\",\"op\":\"show-review\"}")));
        assert(!IsExplicitReviewRequest(json("{\"v\":1,\"channel\":\"agent\",\"op\":\"show-review\"}")));
        assert(!IsExplicitReviewRequest(json("{\"v\":1,\"channel\":\"management\",\"op\":\"status\"}")));
        assert(!IsExplicitReviewRequest(json("{\"v\":1,\"channel\":\"management\",\"op\":\"show-review\",\"extra\":true}")));
        assert(!IsExplicitReviewRequest(json("{\"v\":true,\"channel\":\"management\",\"op\":\"show-review\"}")));
        assert(!IsExplicitReviewRequest(json("[]")));
        assert(ProcessStart(getpid()) != 0 && ProcessStart(0) == 0);
        assert(!ValidReviewPeer(nil, getpid(), ProcessStart(getpid())));

        __block int actions = 0;
        uint64_t future = clock_gettime_nsec_np(CLOCK_UPTIME_RAW) + 5 * NSEC_PER_SEC;
        ATZControlReply *success = [ATZControlReply new];
        RunActivationGate(success, future, ^BOOL{ return YES; }, ^BOOL{ return YES; }, ^{ actions++; });
        assert(success.finished && success.code == 0 && actions == 1);
        ATZControlReply *switched = [ATZControlReply new];
        RunActivationGate(switched, future, ^BOOL{ return YES; }, ^BOOL{ return NO; }, ^{ actions++; });
        assert(switched.finished && switched.code == -8 && actions == 1);
        ATZControlReply *expired = [ATZControlReply new];
        RunActivationGate(expired, 0, ^BOOL{ return YES; }, ^BOOL{ return YES; }, ^{ actions++; });
        assert(expired.finished && expired.code == -8 && actions == 1);

        // A slow verification must not hold the cancellation lock; a timeout must prevent late activation.
        ATZControlReply *cancelled = [ATZControlReply new];
        dispatch_semaphore_t started = dispatch_semaphore_create(0), proceed = dispatch_semaphore_create(0), done = dispatch_semaphore_create(0);
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_DEFAULT, 0), ^{
            RunActivationGate(cancelled, future, ^BOOL{
                dispatch_semaphore_signal(started);
                return dispatch_semaphore_wait(proceed, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0;
            }, ^BOOL{ return YES; }, ^{ actions++; });
            dispatch_semaphore_signal(done);
        });
        assert(dispatch_semaphore_wait(started, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0);
        [cancelled finish:nil code:-8];
        dispatch_semaphore_signal(proceed);
        assert(dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC)) == 0);
        assert(cancelled.finished && cancelled.code == -8 && actions == 1);
        puts("cooperative activation gate passed");
    }
    return 0;
}
