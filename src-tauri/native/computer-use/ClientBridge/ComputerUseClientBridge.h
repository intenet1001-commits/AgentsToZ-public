#include <stdint.h>
#include <stddef.h>
int32_t agentstoz_control_request(const uint8_t *request, size_t length, uint8_t **response, size_t *response_length);
void agentstoz_control_response_free(uint8_t *response);

int32_t agentstoz_control_open(void);
