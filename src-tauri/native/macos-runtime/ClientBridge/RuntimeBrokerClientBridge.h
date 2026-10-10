#ifndef AGENTSTOZ_RUNTIME_BROKER_CLIENT_BRIDGE_H
#define AGENTSTOZ_RUNTIME_BROKER_CLIENT_BRIDGE_H

#include <stddef.h>
#include <stdint.h>

// Stable, path-free values crossing the Objective-C/Rust boundary. Never
// return NSError descriptions: they can disclose bundle paths or mutable OS
// state and are not an authorization contract.
typedef enum AgentsToZRuntimeBrokerClientResult : int32_t {
  AgentsToZRuntimeBrokerClientNotRegistered = 0,
  AgentsToZRuntimeBrokerClientEnabled = 1,
  AgentsToZRuntimeBrokerClientRequiresApproval = 2,
  AgentsToZRuntimeBrokerClientNotFound = 3,

  AgentsToZRuntimeBrokerClientRegistered = 10,
  AgentsToZRuntimeBrokerClientUnregistered = 11,
  AgentsToZRuntimeBrokerClientAlreadyRegistered = 12,
  AgentsToZRuntimeBrokerClientRegistrationDenied = 13,
  AgentsToZRuntimeBrokerClientProbePassed = 20,
  AgentsToZRuntimeBrokerClientDedicatedIdentityFixturePassed = 21,
  AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioned = 22,
  AgentsToZRuntimeBrokerClientDedicatedIdentityAlreadyProvisioned = 23,

  AgentsToZRuntimeBrokerClientUnsupportedOS = -100,
  AgentsToZRuntimeBrokerClientProductionIdentityUnavailable = -101,
  AgentsToZRuntimeBrokerClientAppLocationRejected = -102,
  AgentsToZRuntimeBrokerClientBundleIdentityRejected = -103,
  AgentsToZRuntimeBrokerClientSignatureRejected = -104,
  AgentsToZRuntimeBrokerClientEmbeddedServiceMissing = -105,
  AgentsToZRuntimeBrokerClientInvalidChallenge = -106,
  AgentsToZRuntimeBrokerClientConnectionRejected = -107,
  AgentsToZRuntimeBrokerClientProbeMismatch = -108,
  AgentsToZRuntimeBrokerClientProbeTimedOut = -109,
  AgentsToZRuntimeBrokerClientRegistrationFailed = -110,
  AgentsToZRuntimeBrokerClientUnregistrationFailed = -111,
  AgentsToZRuntimeBrokerClientDedicatedIdentityFixtureRejected = -112,
  AgentsToZRuntimeBrokerClientDedicatedIdentityProvisioningRejected = -113,
} AgentsToZRuntimeBrokerClientResult;

int32_t agentstoz_runtime_broker_service_status(void);
int32_t agentstoz_runtime_broker_register(void);
int32_t agentstoz_runtime_broker_unregister(void);
int32_t agentstoz_runtime_broker_probe(const uint8_t *challenge, size_t challenge_length);
int32_t agentstoz_runtime_broker_run_dedicated_identity_fixture(
  const uint8_t *challenge,
  size_t challenge_length
);
int32_t agentstoz_runtime_broker_provision_dedicated_identity(
  const uint8_t *challenge,
  size_t challenge_length
);

#endif
