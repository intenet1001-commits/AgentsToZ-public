#include <ApplicationServices/ApplicationServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <errno.h>
#include <libproc.h>
#include <limits.h>
#include <math.h>
#include <signal.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_PROMPT_BYTES 4096
#define MAX_AX_NODES 4096
#define MAX_AX_DEPTH 64

typedef struct {
  CFStringRef expected_prompt;
  AXUIElementRef composer;
  AXUIElementRef send_button;
  size_t node_count;
  size_t composer_matches;
  size_t send_matches;
  bool limit_exceeded;
} SearchState;

static void emit(const char *value) {
  fputs(value, stdout);
  fputc('\n', stdout);
}

static bool process_path_allowed(pid_t pid) {
  char path[PROC_PIDPATHINFO_MAXSIZE] = {0};
  if (proc_pidpath(pid, path, sizeof(path)) <= 0) return false;
  const char *allowed[] = {
    "/ChatGPT.app/Contents/MacOS/ChatGPT",
    "/Codex.app/Contents/MacOS/Codex",
  };
  const size_t length = strlen(path);
  for (size_t index = 0; index < sizeof(allowed) / sizeof(allowed[0]); index += 1) {
    const size_t suffix_length = strlen(allowed[index]);
    if (length >= suffix_length
      && strcmp(path + length - suffix_length, allowed[index]) == 0) return true;
  }
  return false;
}

static CFTypeRef copy_attribute(AXUIElementRef element, CFStringRef name) {
  CFTypeRef value = NULL;
  if (AXUIElementCopyAttributeValue(element, name, &value) != kAXErrorSuccess) return NULL;
  return value;
}

static bool string_attribute_equals(
  AXUIElementRef element,
  CFStringRef attribute,
  CFStringRef expected
) {
  CFTypeRef value = copy_attribute(element, attribute);
  const bool matches = value != NULL
    && CFGetTypeID(value) == CFStringGetTypeID()
    && CFEqual(value, expected);
  if (value != NULL) CFRelease(value);
  return matches;
}

static bool boolean_attribute(AXUIElementRef element, CFStringRef attribute, bool fallback) {
  CFTypeRef value = copy_attribute(element, attribute);
  if (value == NULL) return fallback;
  const bool result = CFGetTypeID(value) == CFBooleanGetTypeID()
    ? CFBooleanGetValue((CFBooleanRef)value)
    : fallback;
  CFRelease(value);
  return result;
}

static bool element_frame(AXUIElementRef element, CGRect *frame) {
  CFTypeRef position_value = copy_attribute(element, kAXPositionAttribute);
  CFTypeRef size_value = copy_attribute(element, kAXSizeAttribute);
  CGPoint position = CGPointZero;
  CGSize size = CGSizeZero;
  const bool valid = position_value != NULL
    && size_value != NULL
    && CFGetTypeID(position_value) == AXValueGetTypeID()
    && CFGetTypeID(size_value) == AXValueGetTypeID()
    && AXValueGetType((AXValueRef)position_value) == kAXValueCGPointType
    && AXValueGetType((AXValueRef)size_value) == kAXValueCGSizeType
    && AXValueGetValue((AXValueRef)position_value, kAXValueCGPointType, &position)
    && AXValueGetValue((AXValueRef)size_value, kAXValueCGSizeType, &size)
    && isfinite(position.x)
    && isfinite(position.y)
    && isfinite(size.width)
    && isfinite(size.height)
    && size.width > 0
    && size.height > 0;
  if (position_value != NULL) CFRelease(position_value);
  if (size_value != NULL) CFRelease(size_value);
  if (!valid) return false;
  *frame = CGRectMake(position.x, position.y, size.width, size.height);
  return true;
}

static bool post_bounded_click(AXUIElementRef window, AXUIElementRef button) {
  CGRect window_frame = CGRectZero;
  CGRect button_frame = CGRectZero;
  if (!element_frame(window, &window_frame) || !element_frame(button, &button_frame)) return false;
  if (button_frame.size.width < 12 || button_frame.size.width > 160
    || button_frame.size.height < 12 || button_frame.size.height > 160
    || !CGRectContainsRect(window_frame, button_frame)) return false;
  const CGPoint point = CGPointMake(CGRectGetMidX(button_frame), CGRectGetMidY(button_frame));
  CGEventRef current = CGEventCreate(NULL);
  if (current == NULL) return false;
  const CGPoint original = CGEventGetLocation(current);
  CFRelease(current);
  CGEventRef move = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, point, kCGMouseButtonLeft);
  CGEventRef down = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseDown, point, kCGMouseButtonLeft);
  CGEventRef up = CGEventCreateMouseEvent(NULL, kCGEventLeftMouseUp, point, kCGMouseButtonLeft);
  if (move == NULL || down == NULL || up == NULL) {
    if (move != NULL) CFRelease(move);
    if (down != NULL) CFRelease(down);
    if (up != NULL) CFRelease(up);
    return false;
  }
  CGEventPost(kCGHIDEventTap, move);
  CGEventPost(kCGHIDEventTap, down);
  usleep(50000);
  CGEventPost(kCGHIDEventTap, up);
  CFRelease(move);
  CFRelease(down);
  CFRelease(up);
  usleep(50000);
  CGEventRef restore = CGEventCreateMouseEvent(NULL, kCGEventMouseMoved, original, kCGMouseButtonLeft);
  if (restore != NULL) {
    CGEventPost(kCGHIDEventTap, restore);
    CFRelease(restore);
  }
  return true;
}

static bool send_label(AXUIElementRef element) {
  return string_attribute_equals(element, kAXDescriptionAttribute, CFSTR("Send"))
    || string_attribute_equals(element, kAXDescriptionAttribute, CFSTR("보내기"));
}

static void inspect_tree(AXUIElementRef element, size_t depth, SearchState *state) {
  if (state->limit_exceeded) return;
  state->node_count += 1;
  if (state->node_count > MAX_AX_NODES || depth > MAX_AX_DEPTH) {
    state->limit_exceeded = true;
    return;
  }

  CFTypeRef role = copy_attribute(element, kAXRoleAttribute);
  if (role != NULL && CFGetTypeID(role) == CFStringGetTypeID()) {
    if (CFEqual(role, kAXTextAreaRole)
      && boolean_attribute(element, kAXFocusedAttribute, false)
      && string_attribute_equals(element, kAXValueAttribute, state->expected_prompt)) {
      state->composer_matches += 1;
      if (state->composer == NULL) state->composer = (AXUIElementRef)CFRetain(element);
    } else if (CFEqual(role, kAXButtonRole)
      && boolean_attribute(element, kAXEnabledAttribute, false)
      && send_label(element)) {
      state->send_matches += 1;
      if (state->send_button == NULL) state->send_button = (AXUIElementRef)CFRetain(element);
    }
  }
  if (role != NULL) CFRelease(role);

  CFTypeRef children_value = copy_attribute(element, kAXChildrenAttribute);
  if (children_value == NULL) return;
  if (CFGetTypeID(children_value) == CFArrayGetTypeID()) {
    CFArrayRef children = (CFArrayRef)children_value;
    const CFIndex count = CFArrayGetCount(children);
    for (CFIndex index = 0; index < count && !state->limit_exceeded; index += 1) {
      AXUIElementRef child = (AXUIElementRef)CFArrayGetValueAtIndex(children, index);
      if (child != NULL) inspect_tree(child, depth + 1, state);
    }
  }
  CFRelease(children_value);
}

static bool read_prompt(char *buffer, size_t capacity, size_t *length) {
  *length = 0;
  while (*length < capacity) {
    const size_t count = fread(buffer + *length, 1, capacity - *length, stdin);
    *length += count;
    if (count == 0) break;
  }
  if (ferror(stdin) || *length == 0 || *length >= capacity) return false;
  const int extra = fgetc(stdin);
  return extra == EOF;
}

static bool parse_pid(const char *value, pid_t *pid) {
  if (value == NULL || *value == '\0') return false;
  errno = 0;
  char *end = NULL;
  const long parsed = strtol(value, &end, 10);
  if (errno != 0 || end == NULL || *end != '\0' || parsed <= 1 || parsed > INT_MAX) return false;
  *pid = (pid_t)parsed;
  return true;
}

int main(int argc, char **argv) {
  if (argc != 3 || strcmp(argv[1], "--pid") != 0) return 64;
  pid_t pid = 0;
  if (!parse_pid(argv[2], &pid) || kill(pid, 0) != 0 || !process_path_allowed(pid)) {
    emit("CODEX_DESKTOP_PROCESS_NOT_FOUND");
    return 3;
  }
  if (!AXIsProcessTrusted()) {
    emit("CODEX_DESKTOP_AUTOMATION_PERMISSION_DENIED");
    return 4;
  }

  char prompt[MAX_PROMPT_BYTES + 1] = {0};
  size_t prompt_length = 0;
  if (!read_prompt(prompt, MAX_PROMPT_BYTES, &prompt_length)) {
    emit("CODEX_DESKTOP_COMPOSER_NOT_READY");
    return 5;
  }
  CFStringRef expected = CFStringCreateWithBytes(
    kCFAllocatorDefault,
    (const UInt8 *)prompt,
    (CFIndex)prompt_length,
    kCFStringEncodingUTF8,
    false
  );
  if (expected == NULL) {
    emit("CODEX_DESKTOP_COMPOSER_NOT_READY");
    return 5;
  }

  AXUIElementRef app = AXUIElementCreateApplication(pid);
  CFTypeRef windows_value = copy_attribute(app, kAXWindowsAttribute);
  AXUIElementRef main_window = NULL;
  size_t main_window_count = 0;
  if (windows_value != NULL && CFGetTypeID(windows_value) == CFArrayGetTypeID()) {
    CFArrayRef windows = (CFArrayRef)windows_value;
    const CFIndex count = CFArrayGetCount(windows);
    for (CFIndex index = 0; index < count; index += 1) {
      AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, index);
      if (window != NULL
        && string_attribute_equals(window, kAXSubroleAttribute, kAXStandardWindowSubrole)
        && boolean_attribute(window, kAXMainAttribute, false)
        && !boolean_attribute(window, kAXModalAttribute, true)) {
        main_window_count += 1;
        if (main_window == NULL) main_window = (AXUIElementRef)CFRetain(window);
      }
    }
  }
  if (windows_value != NULL) CFRelease(windows_value);

  SearchState state = {
    .expected_prompt = expected,
    .composer = NULL,
    .send_button = NULL,
    .node_count = 0,
    .composer_matches = 0,
    .send_matches = 0,
    .limit_exceeded = false,
  };
  if (main_window_count == 1 && main_window != NULL) inspect_tree(main_window, 0, &state);

  int exit_code = 5;
  if (!state.limit_exceeded
    && state.composer_matches == 1
    && state.send_matches == 1
    && state.composer != NULL
    && state.send_button != NULL) {
    (void)AXUIElementSetAttributeValue(main_window, kAXMainAttribute, kCFBooleanTrue);
    (void)AXUIElementSetAttributeValue(main_window, kAXFocusedAttribute, kCFBooleanTrue);
    (void)AXUIElementPerformAction(main_window, kAXRaiseAction);
    (void)AXUIElementSetAttributeValue(state.composer, kAXFocusedAttribute, kCFBooleanTrue);
    usleep(100000);
    // The click is global input, so re-check ownership and the exact prompt
    // immediately after raising the target window. A foreground change fails
    // closed instead of clicking a different application's coordinates.
    if (process_path_allowed(pid)
      && boolean_attribute(app, kAXFrontmostAttribute, false)
      && boolean_attribute(main_window, kAXMainAttribute, false)
      && !boolean_attribute(main_window, kAXModalAttribute, true)
      && boolean_attribute(state.composer, kAXFocusedAttribute, false)
      && string_attribute_equals(state.composer, kAXValueAttribute, state.expected_prompt)
      && boolean_attribute(state.send_button, kAXEnabledAttribute, false)
      && send_label(state.send_button)
      && post_bounded_click(main_window, state.send_button)) {
      bool prompt_cleared = false;
      for (size_t attempt = 0; attempt < 20; attempt += 1) {
        usleep(100000);
        if (!string_attribute_equals(state.composer, kAXValueAttribute, state.expected_prompt)) {
          prompt_cleared = true;
          break;
        }
      }
      if (prompt_cleared) {
        emit("accessibility-project-composer-send-button");
        exit_code = 0;
      } else {
        emit("CODEX_DESKTOP_SUBMISSION_UNCERTAIN");
        exit_code = 6;
      }
    } else {
      emit("CODEX_DESKTOP_SUBMISSION_UNCERTAIN");
      exit_code = 6;
    }
  } else {
    emit("CODEX_DESKTOP_COMPOSER_NOT_READY");
  }

  if (state.composer != NULL) CFRelease(state.composer);
  if (state.send_button != NULL) CFRelease(state.send_button);
  if (main_window != NULL) CFRelease(main_window);
  CFRelease(app);
  CFRelease(expected);
  return exit_code;
}
