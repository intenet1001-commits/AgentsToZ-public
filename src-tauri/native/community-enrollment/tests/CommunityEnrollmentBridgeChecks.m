#import <Foundation/Foundation.h>
#include <assert.h>
#include <stdint.h>
extern NSData *ATZCommunityEnrollmentRequest(NSData *data, NSString *agentDeviceId);
// Deterministic protocol checks never call XPC, launch the listener, touch Keychain, approve or install anything.
int32_t agentstoz_control_request(const uint8_t *request, size_t length, uint8_t **response, size_t *size) { (void)request; (void)length; (void)response; (void)size; abort(); }
void agentstoz_control_response_free(uint8_t *response) { (void)response; abort(); }
static NSData *Translated(NSData *data) { return ATZCommunityEnrollmentRequest(data, @"33333333-3333-4333-8333-333333333333"); }
static NSData *Encoded(id value) { return [NSJSONSerialization dataWithJSONObject:value options:0 error:nil]; }
int main(void) {
    @autoreleasepool {
        NSString *profile = @"11111111-1111-4111-8111-111111111111", *device = @"22222222-2222-4222-8222-222222222222";
        NSDictionary *prepare = @{@"operation":@"prepare",@"profileId":profile,@"deviceId":device};
        NSData *request = Translated(Encoded(prepare)); assert(request);
        NSDictionary *native = [NSJSONSerialization JSONObjectWithData:request options:0 error:nil];
        assert([native[@"agentDeviceId"] isEqual:@"33333333-3333-4333-8333-333333333333"]);
        assert([native[@"v"] isEqual:@3] && [native[@"channel"] isEqual:@"management"] && [native[@"op"] isEqual:@"community-prepare"]);
        assert(!Translated(Encoded(@{@"operation":@1,@"profileId":profile,@"deviceId":device})));
        assert(!ATZCommunityEnrollmentRequest(Encoded(prepare), nil));
        NSMutableDictionary *spoofed = [prepare mutableCopy]; spoofed[@"agentDeviceId"] = profile;
        assert(!Translated(Encoded(spoofed)));
        NSMutableDictionary *forged = [prepare mutableCopy]; forged[@"channel"] = @"management";
        assert(!Translated(Encoded(forged)));
        for (NSString *operation in @[@"screen-start",@"input",@"sign",@"community-disable",@"community-authorize"]) {
            assert(!Translated(Encoded(@{@"operation":operation,@"profileId":profile,@"deviceId":device})));
        }
        NSData *disabled = Translated(Encoded(@{@"operation":@"disable"})); assert(disabled);
        NSDictionary *disableNative = [NSJSONSerialization JSONObjectWithData:disabled options:0 error:nil];
        assert(disableNative.count == 3 && [disableNative[@"op"] isEqual:@"community-disable"]);
        assert(!Translated(Encoded(@{@"operation":@"disable",@"deviceId":device})));
        NSString *signature = [@"" stringByPaddingToLength:86 withString:@"a" startingAtIndex:0];
        NSDictionary *install = @{@"operation":@"install",@"requestId":device,@"envelope":@{@"payload":@"fixture",@"signature":signature}};
        assert(Translated(Encoded(install)));
        assert(!Translated(Encoded(@{@"operation":@"install",@"requestId":device,@"envelope":@{@"payload":@"fixture",@"signature":signature,@"hostSignature":signature}})));
        assert(!Translated(Encoded(@{@"operation":@"prepare",@"profileId":@"not-a-uuid",@"deviceId":device})));
        puts("community enrollment bridge protocol: PASS");
    }
    return 0;
}
