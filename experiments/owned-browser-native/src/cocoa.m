#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Preserve Tao's sendEvent implementation, including its Cmd-key fix.
static IMP originalSendEvent;
static BOOL handlingEvent;
static BOOL isHandling(id app, SEL cmd) { (void)app; (void)cmd; return handlingEvent; }
static void setHandling(id app, SEL cmd, BOOL value) { (void)app; (void)cmd; handlingEvent = value; }
static void sendEvent(id app, SEL cmd, NSEvent *event) {
    BOOL previous = handlingEvent;
    handlingEvent = YES;
    @try { ((void (*)(id, SEL, NSEvent *))originalSendEvent)(app, cmd, event); }
    @finally { handlingEvent = previous; }
}

void atz_install_cef_protocol(void) {
    NSCAssert([NSThread isMainThread], @"CEF must initialize on the main thread");
    Class cls = [NSApp class];
    NSCAssert(![NSApp respondsToSelector:@selector(isHandlingSendEvent)], @"unexpected existing CEF protocol");
    class_addMethod(cls, @selector(isHandlingSendEvent), (IMP)isHandling, "B@:");
    class_addMethod(cls, @selector(setHandlingSendEvent:), (IMP)setHandling, "v@:B");
    Protocol *protocol = objc_getProtocol("CefAppProtocol");
    if (protocol) class_addProtocol(cls, protocol);
    originalSendEvent = method_setImplementation(class_getInstanceMethod(cls, @selector(sendEvent:)), (IMP)sendEvent);
}

// When the agent owns the page, human clicks and keyboard focus cannot enter it.
@interface ATZHostRoot : NSView
@end
@implementation ATZHostRoot
@end

@interface ATZBrowserContainer : NSView
@property BOOL humanInput;
@end
@implementation ATZBrowserContainer
- (NSView *)hitTest:(NSPoint)point { return self.humanInput ? [super hitTest:point] : nil; }
@end

void *atz_create_container(void *windowPointer, double x, double y, double width, double height) {
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    NSView *root = window.contentView;
    if (![root isKindOfClass:[ATZHostRoot class]]) {
        // Siblings, not children of WKWebView: WebKit's AX tree otherwise hides CEF.
        NSView *trustedView = root;
        ATZHostRoot *wrapper = [[ATZHostRoot alloc] initWithFrame:root.frame];
        wrapper.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        window.contentView = wrapper;
        trustedView.frame = wrapper.bounds;
        trustedView.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
        [wrapper addSubview:trustedView];
        root = wrapper;
    }
    ATZBrowserContainer *container = [[ATZBrowserContainer alloc] initWithFrame:NSMakeRect(x, root.bounds.size.height-y-height, width, height)];
    container.humanInput = YES;
    [root addSubview:container];
    return (__bridge_retained void *)container;
}
void atz_container_input(void *pointer, BOOL enabled) {
    ATZBrowserContainer *container = (__bridge ATZBrowserContainer *)pointer;
    if (!enabled && [container.window.firstResponder isKindOfClass:[NSView class]] && [(NSView *)container.window.firstResponder isDescendantOf:container]) {
        [container.window makeFirstResponder:nil];
    }
    container.humanInput = enabled;
}
void atz_container_frame(void *pointer, double x, double y, double width, double height) {
    NSView *view = (__bridge NSView *)pointer;
    view.frame = NSMakeRect(x, view.superview.bounds.size.height-y-height, width, height);
    for (NSView *child in view.subviews) child.frame = view.bounds;
}
void atz_container_hidden(void *pointer, BOOL hidden) { [(__bridge NSView *)pointer setHidden:hidden]; }
void atz_release_container(void *pointer) {
    NSView *view = CFBridgingRelease(pointer);
    [view removeFromSuperview];
}

// Prototype timer only. Production must use CEF's scheduled external pump.
static NSTimer *pump;
void atz_start_pump(void (*callback)(void)) {
    pump = [NSTimer timerWithTimeInterval:0.016 repeats:YES block:^(NSTimer *timer) { (void)timer; callback(); }];
    [[NSRunLoop mainRunLoop] addTimer:pump forMode:NSRunLoopCommonModes];
}
void atz_stop_pump(void) { [pump invalidate]; pump = nil; }
