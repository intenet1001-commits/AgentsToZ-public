#import "RuntimeBrokerClientBridge.h"

#import <Foundation/Foundation.h>
#import <Security/Security.h>
#import <ServiceManagement/ServiceManagement.h>
#import <stdatomic.h>
#import <sys/stat.h>

static NSString *const AgentsToZApplicationIdentifier = @"com.intenet.agentstozbycs";
static NSString *const AgentsToZApplicationPath = @"/Applications/AgentsToZ_byCS.app";
static NSString *const AgentsToZBrokerIdentifier = @"com.intenet.agentstozbycs.runtime-broker";
static NSString *const AgentsToZBrokerPlistName = @"com.intenet.agentstozbycs.runtime-broker.plist";
static NSString *const AgentsToZClientEntitlement = @"com.intenet.agentstozbycs.runtime-broker.client";
static NSString *const AgentsToZClientEntitlementValue = @"client-v1";
static NSString *const AgentsToZServiceEntitlement = @"com.intenet.agentstozbycs.runtime-broker.service";
static NSString *const AgentsToZServiceEntitlementValue = @"service-v1";

// A production packaging step must generate this value from the signing
// identity into both native products. An environment variable, plist value,
// command argument, or caller-provided value is intentionally never accepted.
static NSString *const AgentsToZProductionTeamIdentifier = nil;

static const size_t AgentsToZProbeChallengeByteCount = 32;
static const int64_t AgentsToZProbeTimeoutNanoseconds = 3LL * NSEC_PER_SEC;
static const int64_t AgentsToZDedicatedFixtureTimeoutNanoseconds = 15LL * NSEC_PER_SEC;
static const int32_t AgentsToZProbePending = INT32_MAX;

@protocol AgentsToZRuntimeBrokerXPC
- (void)probe:(NSData *)challenge withReply:(void (^)(NSData *reply))reply;
- (void)runDedicatedIdentityFixture:(NSData *)challenge
  withReply:(void (^)(NSData *reply))reply;
- (void)provisionDedicatedIdentity:(NSData *)challenge
  withReply:(void (^)(NSData *reply))reply;
@end

static BOOL AgentsToZValidTeamIdentifier(NSString *candidate) {
  if (candidate == nil || candidate.length != 10) {
    return NO;
  }
  static NSCharacterSet *allowed = nil;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowed = [NSCharacterSet characterSetWithCharactersInString:@"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"];
  });
  if ([[candidate stringByTrimmingCharactersInSet:allowed] length] != 0) {
    return NO;
  }
  NSSet<NSString *> *placeholders = [NSSet setWithArray:@[
    @"ABCDEFGHIJ", @"1234567890", @"TEAMID1234", @"YOURTEAMID", @"XXXXXXXXXX"
  ]];
  if ([placeholders containsObject:candidate]) {
    return NO;
  }
  unichar first = [candidate characterAtIndex:0];
  for (NSUInteger index = 1; index < candidate.length; index += 1) {
    if ([candidate characterAtIndex:index] != first) {
      return YES;
    }
  }
  return NO;
}

static NSString *AgentsToZSigningRequirement(
  NSString *identifier,
  NSString *teamIdentifier,
  NSString *entitlement,
  NSString *entitlementValue
) {
  return [NSString stringWithFormat:
    @"anchor apple generic"
     " and certificate 1[field.1.2.840.113635.100.6.2.6] exists"
     " and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
     " and certificate leaf[subject.OU] = \"%@\""
     " and identifier \"%@\""
     " and entitlement[\"%@\"] = \"%@\"",
    teamIdentifier, identifier, entitlement, entitlementValue
  ];
}

static BOOL AgentsToZCurrentProcessSatisfiesRequirement(NSString *requirementText) {
  SecRequirementRef requirement = NULL;
  if (SecRequirementCreateWithString(
        (__bridge CFStringRef)requirementText,
        kSecCSDefaultFlags,
        &requirement
      ) != errSecSuccess || requirement == NULL) {
    return NO;
  }
  SecCodeRef code = NULL;
  OSStatus copyStatus = SecCodeCopySelf(kSecCSDefaultFlags, &code);
  BOOL valid = copyStatus == errSecSuccess
    && code != NULL
    && SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) == errSecSuccess;
  if (code != NULL) {
    CFRelease(code);
  }
  CFRelease(requirement);
  return valid;
}

static BOOL AgentsToZExactRegularFile(NSString *path) {
  struct stat metadata;
  if (lstat(path.fileSystemRepresentation, &metadata) != 0) {
    return NO;
  }
  return S_ISREG(metadata.st_mode) && !S_ISLNK(metadata.st_mode) && metadata.st_nlink == 1;
}

static void AgentsToZCompleteProbe(
  _Atomic(int32_t) *result,
  dispatch_semaphore_t completion,
  int32_t candidate
) {
  int32_t pending = AgentsToZProbePending;
  if (atomic_compare_exchange_strong(result, &pending, candidate)) {
    dispatch_semaphore_signal(completion);
  }
}

static BOOL AgentsToZIsJSONInteger(id value, NSInteger expected) {
  if (![value isKindOfClass:[NSNumber class]]
      || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  NSNumber *number = value;
  return number.doubleValue == (double)expected
    && number.integerValue == expected;
}

static BOOL AgentsToZIsJSONIntegerInRange(id value, NSInteger minimum, NSInteger maximum) {
  if (![value isKindOfClass:[NSNumber class]]
      || CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()) {
    return NO;
  }
  NSNumber *number = value;
  NSInteger integer = number.integerValue;
  return number.doubleValue == (double)integer
    && integer >= minimum
    && integer <= maximum;
}

static BOOL AgentsToZIsJSONFalse(id value) {
  return value != nil
    && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
    && [value isEqual:@NO];
}

static BOOL AgentsToZIsJSONTrue(id value) {
  return value != nil
    && CFGetTypeID((__bridge CFTypeRef)value) == CFBooleanGetTypeID()
    && [value isEqual:@YES];
}

static BOOL AgentsToZValidateDedicatedFixtureProof(NSData *wire, NSData *challenge) {
  if (wire == nil || wire.length < 2 || wire.length > 4096) {
    return NO;
  }
  const uint8_t *bytes = wire.bytes;
  if (bytes[wire.length - 1] != '\n') {
    return NO;
  }
  for (NSUInteger index = 0; index + 1 < wire.length; index += 1) {
    if (bytes[index] == '\n') {
      return NO;
    }
  }
  NSData *json = [wire subdataWithRange:NSMakeRange(0, wire.length - 1)];
  id decoded = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
  if (![decoded isKindOfClass:[NSDictionary class]]) {
    return NO;
  }
  NSDictionary<NSString *, id> *object = decoded;
  NSSet<NSString *> *expectedKeys = [NSSet setWithArray:@[
    @"schemaVersion", @"kind", @"mode", @"result", @"accountName",
    @"effectiveUserIdentifier", @"effectiveGroupIdentifier", @"managerName",
    @"challenge", @"networkTouched", @"fileMutationPerformed", @"containerInvoked",
    @"authoritative", @"reusable", @"ready"
  ]];
  if (![expectedKeys isEqualToSet:[NSSet setWithArray:object.allKeys]]) {
    return NO;
  }
  id userIdentifier = object[@"effectiveUserIdentifier"];
  id groupIdentifier = object[@"effectiveGroupIdentifier"];
  NSString *challengeValue = [challenge base64EncodedStringWithOptions:0];
  return AgentsToZIsJSONInteger(object[@"schemaVersion"], 1)
    && [object[@"kind"] isEqual:@"macos-runtime-dedicated-worker-fixture"]
    && [object[@"mode"] isEqual:@"dedicated-uid-launchd-user-domain"]
    && [object[@"result"] isEqual:@"passed"]
    && [object[@"accountName"] isEqual:@"_agentstoz"]
    && AgentsToZIsJSONIntegerInRange(userIdentifier, 400, 499)
    && AgentsToZIsJSONIntegerInRange(groupIdentifier, 400, 499)
    && [object[@"managerName"] isEqual:@"Background"]
    && [object[@"challenge"] isEqual:challengeValue]
    && AgentsToZIsJSONFalse(object[@"networkTouched"])
    && AgentsToZIsJSONFalse(object[@"fileMutationPerformed"])
    && AgentsToZIsJSONFalse(object[@"containerInvoked"])
    && AgentsToZIsJSONFalse(object[@"authoritative"])
    && AgentsToZIsJSONFalse(object[@"reusable"])
    && AgentsToZIsJSONFalse(object[@"ready"]);
}

static int32_t AgentsToZValidateDedicatedProvisioningProof(
  NSData *wire,
  NSData *challenge
) {
  if (wire == nil || wire.length < 2 || wire.length > 4096) {
    return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
  }
  const uint8_t *bytes = wire.bytes;
  if (bytes[wire.length - 1] != '\n') {
    return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
  }
  for (NSUInteger index = 0; index + 1 < wire.length; index += 1) {
    if (bytes[index] == '\n') {
      return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
    }
  }
  NSData *json = [wire subdataWithRange:NSMakeRange(0, wire.length - 1)];
  id decoded = [NSJSONSerialization JSONObjectWithData:json options:0 error:nil];
  if (![decoded isKindOfClass:[NSDictionary class]]) {
    return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
  }
  NSDictionary<NSString *, id> *object = decoded;
  NSSet<NSString *> *expectedKeys = [NSSet setWithArray:@[
    @"schemaVersion", @"kind", @"result", @"accountName",
    @"effectiveUserIdentifier", @"effectiveGroupIdentifier", @"challenge",
    @"passwordLoginDisabled", @"adminMembership", @"authoritative",
    @"executionAuthorized", @"reusable", @"ready"
  ]];
  if (![expectedKeys isEqualToSet:[NSSet setWithArray:object.allKeys]]) {
    return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
  }
  NSString *result = object[@"result"];
  NSString *challengeValue = [challenge base64EncodedStringWithOptions:0];
  BOOL valid = AgentsToZIsJSONInteger(object[@"schemaVersion"], 1)
    && [object[@"kind"] isEqual:@"macos-runtime-dedicated-account-provisioning"]
    && ([result isEqual:@"provisioned"] || [result isEqual:@"already-provisioned"])
    && [object[@"accountName"] isEqual:@"_agentstoz"]
    && AgentsToZIsJSONIntegerInRange(object[@"effectiveUserIdentifier"], 400, 499)
    && AgentsToZIsJSONIntegerInRange(object[@"effectiveGroupIdentifier"], 400, 499)
    && [object[@"effectiveUserIdentifier"] isEqual:object[@"effectiveGroupIdentifier"]]
    && [object[@"challenge"] isEqual:challengeValue]
    && AgentsToZIsJSONTrue(object[@"passwordLoginDisabled"])
    && AgentsToZIsJSONFalse(object[@"adminMembership"])
    && AgentsToZIsJSONFalse(object[@"authoritative"])
    && AgentsToZIsJSONFalse(object[@"executionAuthorized"])
    && AgentsToZIsJSONFalse(object[@"reusable"])
    && AgentsToZIsJSONFalse(object[@"ready"]);
  if (!valid) {
    return AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected;
  }
  return [result isEqual:@"provisioned"]
    ? AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioned
    : AgentsToZRuntimeBrokerClientDedicatedIdentityAlreadyProvisioned;
}

static BOOL AgentsToZIsServiceManagementError(NSError *error, NSInteger code) {
  if (@available(macOS 15.0, *)) {
    return error != nil
      && [error.domain isEqualToString:SMAppServiceErrorDomain]
      && error.code == code;
  }
  return NO;
}

static int32_t AgentsToZProductionPreflight(void) {
  if (@available(macOS 26.0, *)) {
    if (!AgentsToZValidTeamIdentifier(AgentsToZProductionTeamIdentifier)) {
      return AgentsToZRuntimeBrokerClientProductionIdentityUnavailable;
    }
    NSString *bundlePath = NSBundle.mainBundle.bundleURL.path;
    if (![bundlePath isEqualToString:AgentsToZApplicationPath]) {
      return AgentsToZRuntimeBrokerClientAppLocationRejected;
    }
    if (![NSBundle.mainBundle.bundleIdentifier isEqualToString:AgentsToZApplicationIdentifier]) {
      return AgentsToZRuntimeBrokerClientBundleIdentityRejected;
    }
    NSString *clientRequirement = AgentsToZSigningRequirement(
      AgentsToZApplicationIdentifier,
      AgentsToZProductionTeamIdentifier,
      AgentsToZClientEntitlement,
      AgentsToZClientEntitlementValue
    );
    if (!AgentsToZCurrentProcessSatisfiesRequirement(clientRequirement)) {
      return AgentsToZRuntimeBrokerClientSignatureRejected;
    }
    NSString *plistPath = [bundlePath stringByAppendingPathComponent:
      [@"Contents/Library/LaunchDaemons" stringByAppendingPathComponent:AgentsToZBrokerPlistName]
    ];
    NSString *brokerPath = [bundlePath stringByAppendingPathComponent:
      [@"Contents/Library/LaunchServices" stringByAppendingPathComponent:AgentsToZBrokerIdentifier]
    ];
    if (!AgentsToZExactRegularFile(plistPath) || !AgentsToZExactRegularFile(brokerPath)) {
      return AgentsToZRuntimeBrokerClientEmbeddedServiceMissing;
    }
    return 0;
  }
  return AgentsToZRuntimeBrokerClientUnsupportedOS;
}

static SMAppService *AgentsToZBrokerService(void) API_AVAILABLE(macos(13.0)) {
  return [SMAppService daemonServiceWithPlistName:AgentsToZBrokerPlistName];
}

int32_t agentstoz_runtime_broker_service_status(void) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (@available(macOS 26.0, *)) {
      switch (AgentsToZBrokerService().status) {
        case SMAppServiceStatusNotRegistered:
          return AgentsToZRuntimeBrokerClientNotRegistered;
        case SMAppServiceStatusEnabled:
          return AgentsToZRuntimeBrokerClientEnabled;
        case SMAppServiceStatusRequiresApproval:
          return AgentsToZRuntimeBrokerClientRequiresApproval;
        case SMAppServiceStatusNotFound:
          return AgentsToZRuntimeBrokerClientNotFound;
      }
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}

int32_t agentstoz_runtime_broker_register(void) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (@available(macOS 26.0, *)) {
      NSError *error = nil;
      if ([AgentsToZBrokerService() registerAndReturnError:&error]) {
        return AgentsToZRuntimeBrokerClientRegistered;
      }
      if (AgentsToZIsServiceManagementError(error, kSMErrorAlreadyRegistered)) {
        return AgentsToZRuntimeBrokerClientAlreadyRegistered;
      }
      if (AgentsToZIsServiceManagementError(error, kSMErrorLaunchDeniedByUser)) {
        return AgentsToZRuntimeBrokerClientRegistrationDenied;
      }
      return AgentsToZRuntimeBrokerClientRegistrationFailed;
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}

int32_t agentstoz_runtime_broker_unregister(void) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (@available(macOS 26.0, *)) {
      NSError *error = nil;
      if ([AgentsToZBrokerService() unregisterAndReturnError:&error]) {
        return AgentsToZRuntimeBrokerClientUnregistered;
      }
      if (AgentsToZIsServiceManagementError(error, kSMErrorJobNotFound)) {
        return AgentsToZRuntimeBrokerClientNotRegistered;
      }
      return AgentsToZRuntimeBrokerClientUnregistrationFailed;
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}

int32_t agentstoz_runtime_broker_probe(const uint8_t *challenge, size_t challengeLength) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (challenge == NULL || challengeLength != AgentsToZProbeChallengeByteCount) {
      return AgentsToZRuntimeBrokerClientInvalidChallenge;
    }
    if (@available(macOS 26.0, *)) {
      dispatch_semaphore_t completion = dispatch_semaphore_create(0);
      __block _Atomic(int32_t) result = AgentsToZProbePending;
      NSString *brokerRequirement = AgentsToZSigningRequirement(
        AgentsToZBrokerIdentifier,
        AgentsToZProductionTeamIdentifier,
        AgentsToZServiceEntitlement,
        AgentsToZServiceEntitlementValue
      );
      NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:AgentsToZBrokerIdentifier
        options:NSXPCConnectionPrivileged
      ];
      connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:
        @protocol(AgentsToZRuntimeBrokerXPC)
      ];
      [connection setCodeSigningRequirement:brokerRequirement];
      connection.interruptionHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      connection.invalidationHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      [connection resume];

      NSData *challengeData = [NSData dataWithBytes:challenge length:challengeLength];
      id<AgentsToZRuntimeBrokerXPC> proxy = [connection remoteObjectProxyWithErrorHandler:
        ^(NSError *error) {
          (void)error;
          AgentsToZCompleteProbe(
            &result,
            completion,
            AgentsToZRuntimeBrokerClientConnectionRejected
          );
        }
      ];
      [proxy probe:challengeData withReply:^(NSData *reply) {
        int32_t replyResult = [reply isEqualToData:challengeData]
          ? AgentsToZRuntimeBrokerClientProbePassed
          : AgentsToZRuntimeBrokerClientProbeMismatch;
        AgentsToZCompleteProbe(&result, completion, replyResult);
      }];

      dispatch_time_t deadline = dispatch_time(
        DISPATCH_TIME_NOW,
        AgentsToZProbeTimeoutNanoseconds
      );
      if (dispatch_semaphore_wait(completion, deadline) != 0) {
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientProbeTimedOut
        );
      }
      int32_t finalResult = atomic_load(&result);
      [connection invalidate];
      return finalResult;
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}

int32_t agentstoz_runtime_broker_run_dedicated_identity_fixture(
  const uint8_t *challenge,
  size_t challengeLength
) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (challenge == NULL || challengeLength != AgentsToZProbeChallengeByteCount) {
      return AgentsToZRuntimeBrokerClientInvalidChallenge;
    }
    if (@available(macOS 26.0, *)) {
      dispatch_semaphore_t completion = dispatch_semaphore_create(0);
      __block _Atomic(int32_t) result = AgentsToZProbePending;
      NSString *brokerRequirement = AgentsToZSigningRequirement(
        AgentsToZBrokerIdentifier,
        AgentsToZProductionTeamIdentifier,
        AgentsToZServiceEntitlement,
        AgentsToZServiceEntitlementValue
      );
      NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:AgentsToZBrokerIdentifier
        options:NSXPCConnectionPrivileged
      ];
      connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:
        @protocol(AgentsToZRuntimeBrokerXPC)
      ];
      [connection setCodeSigningRequirement:brokerRequirement];
      connection.interruptionHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      connection.invalidationHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      [connection resume];
      NSData *challengeData = [NSData dataWithBytes:challenge length:challengeLength];
      id<AgentsToZRuntimeBrokerXPC> proxy = [connection remoteObjectProxyWithErrorHandler:
        ^(NSError *error) {
          (void)error;
          AgentsToZCompleteProbe(
            &result,
            completion,
            AgentsToZRuntimeBrokerClientConnectionRejected
          );
        }
      ];
      [proxy runDedicatedIdentityFixture:challengeData withReply:^(NSData *reply) {
        int32_t replyResult = AgentsToZValidateDedicatedFixtureProof(reply, challengeData)
          ? AgentsToZRuntimeBrokerClientDedicatedIdentityFixturePassed
          : AgentsToZRuntimeBrokerClientDedicatedIdentityFixtureRejected;
        AgentsToZCompleteProbe(&result, completion, replyResult);
      }];
      dispatch_time_t deadline = dispatch_time(
        DISPATCH_TIME_NOW,
        AgentsToZDedicatedFixtureTimeoutNanoseconds
      );
      if (dispatch_semaphore_wait(completion, deadline) != 0) {
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientProbeTimedOut
        );
      }
      int32_t finalResult = atomic_load(&result);
      [connection invalidate];
      return finalResult;
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}

int32_t agentstoz_runtime_broker_provision_dedicated_identity(
  const uint8_t *challenge,
  size_t challengeLength
) {
  @autoreleasepool {
    int32_t preflight = AgentsToZProductionPreflight();
    if (preflight != 0) {
      return preflight;
    }
    if (challenge == NULL || challengeLength != AgentsToZProbeChallengeByteCount) {
      return AgentsToZRuntimeBrokerClientInvalidChallenge;
    }
    if (@available(macOS 26.0, *)) {
      dispatch_semaphore_t completion = dispatch_semaphore_create(0);
      __block _Atomic(int32_t) result = AgentsToZProbePending;
      NSString *brokerRequirement = AgentsToZSigningRequirement(
        AgentsToZBrokerIdentifier,
        AgentsToZProductionTeamIdentifier,
        AgentsToZServiceEntitlement,
        AgentsToZServiceEntitlementValue
      );
      NSXPCConnection *connection = [[NSXPCConnection alloc]
        initWithMachServiceName:AgentsToZBrokerIdentifier
        options:NSXPCConnectionPrivileged
      ];
      connection.remoteObjectInterface = [NSXPCInterface interfaceWithProtocol:
        @protocol(AgentsToZRuntimeBrokerXPC)
      ];
      [connection setCodeSigningRequirement:brokerRequirement];
      connection.interruptionHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      connection.invalidationHandler = ^{
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientConnectionRejected
        );
      };
      [connection resume];
      NSData *challengeData = [NSData dataWithBytes:challenge length:challengeLength];
      id<AgentsToZRuntimeBrokerXPC> proxy = [connection remoteObjectProxyWithErrorHandler:
        ^(NSError *error) {
          (void)error;
          AgentsToZCompleteProbe(
            &result,
            completion,
            AgentsToZRuntimeBrokerClientConnectionRejected
          );
        }
      ];
      [proxy provisionDedicatedIdentity:challengeData withReply:^(NSData *reply) {
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZValidateDedicatedProvisioningProof(reply, challengeData)
        );
      }];
      dispatch_time_t deadline = dispatch_time(
        DISPATCH_TIME_NOW,
        AgentsToZDedicatedFixtureTimeoutNanoseconds
      );
      if (dispatch_semaphore_wait(completion, deadline) != 0) {
        AgentsToZCompleteProbe(
          &result,
          completion,
          AgentsToZRuntimeBrokerClientProbeTimedOut
        );
      }
      int32_t finalResult = atomic_load(&result);
      [connection invalidate];
      return finalResult;
    }
    return AgentsToZRuntimeBrokerClientUnsupportedOS;
  }
}
