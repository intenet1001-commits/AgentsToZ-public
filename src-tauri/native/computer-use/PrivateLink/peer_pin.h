#ifndef AGENTSTOZ_COMPUTER_USE_PEER_PIN_H
#define AGENTSTOZ_COMPUTER_USE_PEER_PIN_H

#include <stdbool.h>
#include <string.h>
#include <bsm/libbsm.h>

/* One prepare attempt per addon instance. A failed first proof can never be repinned. */
typedef struct {
    bool prepared;
    bool finalized;
    bool pinned;
    int descriptor;
    audit_token_t token;
} peer_pin;

static bool peer_pin_begin(peer_pin *pin, int descriptor) {
    if (pin->prepared) return false;
    pin->prepared = true;
    pin->descriptor = descriptor;
    return true;
}
static void peer_pin_commit(peer_pin *pin, const audit_token_t *token, bool verified) {
    if (!pin->prepared || pin->finalized) return;
    pin->finalized = true;
    if (!verified) return;
    pin->token = *token;
    pin->pinned = true;
}
static bool peer_pin_matches(const peer_pin *pin, int descriptor, const audit_token_t *token) {
    return pin->prepared && pin->pinned && pin->descriptor == descriptor &&
        memcmp(&pin->token, token, sizeof(*token)) == 0;
}
#endif
