#import <AppKit/AppKit.h>
#import <objc/runtime.h>

// Host-owned native popup windows. CEF is a child view, just like the main pane.
extern BOOL atz_popup_requested_close(void *windowPointer);
@interface ATZPopupDelegate : NSObject <NSWindowDelegate>
@end
@implementation ATZPopupDelegate
- (BOOL)windowShouldClose:(NSWindow *)window {
    return atz_popup_requested_close((__bridge void *)window);
}
- (void)windowWillClose:(NSNotification *)notification {
    NSWindow *window = notification.object;
    // CEF's child view owns its browser lifetime. AppKit may retain a closed
    // window, so remove its children after the native close stack unwinds.
    dispatch_async(dispatch_get_main_queue(), ^{
        for (NSView *child in window.contentView.subviews.copy) [child removeFromSuperview];
    });
}
@end
static char popupDelegateKey;
static NSString *atz_page_host(const char *url) {
    NSString *value=[NSString stringWithUTF8String:url];
    return value ? [NSURLComponents componentsWithString:value].host ?: @"" : @"";
}
void *atz_create_popup(void *containerPointer, const char *host) {
    NSWindow *owner = ((__bridge NSView *)containerPointer).window;
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(100,100,600,680)
        styleMask:(NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskResizable)
        backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    window.animationBehavior = NSWindowAnimationBehaviorNone;
    window.title = atz_page_host(host);
    NSRect parent = owner.frame;
    NSRect frame = window.frame;
    frame.size.width = MIN(frame.size.width, parent.size.width);
    frame.size.height = MIN(frame.size.height, parent.size.height);
    frame.origin = NSMakePoint(NSMidX(parent)-frame.size.width/2, NSMidY(parent)-frame.size.height/2);
    [window setFrame:frame display:NO];
    [owner addChildWindow:window ordered:NSWindowAbove];
    ATZPopupDelegate *delegate = [ATZPopupDelegate new];
    objc_setAssociatedObject(window, &popupDelegateKey, delegate, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    window.delegate = delegate;
    [window makeKeyAndOrderFront:nil];
    return (__bridge_retained void *)window;
}
void atz_popup_host(void *windowPointer, const char *host) {
    ((__bridge NSWindow *)windowPointer).title = atz_page_host(host);
}
void *atz_popup_content(void *windowPointer) {
    return (__bridge void *)((__bridge NSWindow *)windowPointer).contentView;
}
void atz_destroy_popup(void *windowPointer) {
    NSWindow *window = (__bridge NSWindow *)windowPointer;
    [window.parentWindow removeChildWindow:window];
    window.delegate = nil;
    [window orderOut:nil];
    window.contentView = nil;
    dispatch_async(dispatch_get_main_queue(), ^{ [window close]; CFRelease(windowPointer); });
}
void atz_detach_browser_view(void *viewPointer) {
    NSView *view = (__bridge NSView *)viewPointer;
    dispatch_async(dispatch_get_main_queue(), ^{ [view removeFromSuperview]; });
}

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
@property uint64_t blockedInputs;
@end
@implementation ATZBrowserContainer
- (NSView *)hitTest:(NSPoint)point {
    // A hidden/closed tab must never mask the active tab, even while locked.
    if (self.hiddenOrHasHiddenAncestor) return nil;
    if (!NSPointInRect([self convertPoint:point fromView:self.superview], self.bounds)) return nil;
    return self.humanInput ? [super hitTest:point] : self;
}
- (BOOL)acceptsFirstResponder { return self.humanInput; }
- (void)mouseDown:(NSEvent *)event { (void)event; if (!self.humanInput && self.blockedInputs<UINT64_MAX) self.blockedInputs++; }
- (void)scrollWheel:(NSEvent *)event { (void)event; if (!self.humanInput && self.blockedInputs<UINT64_MAX) self.blockedInputs++; }
- (void)resetCursorRects { if (!self.humanInput) [self addCursorRect:self.bounds cursor:NSCursor.operationNotAllowedCursor]; }
@end

static NSView *atz_trusted_webview(NSView *view) {
    Class webKit = NSClassFromString(@"WKWebView");
    if (webKit && [view isKindOfClass:webKit]) return view;
    for (NSView *child in view.subviews) {
        if ([child isKindOfClass:[ATZBrowserContainer class]]) continue;
        NSView *found = atz_trusted_webview(child);
        if (found) return found;
    }
    return nil;
}
static double atz_webview_zoom(NSView *view) {
    double zoom=[view respondsToSelector:NSSelectorFromString(@"pageZoom")] ? [[view valueForKey:@"pageZoom"] doubleValue] : 1.;
    return zoom>0. && zoom<=5. ? zoom : 1.;
}
static NSRect atz_document_viewport(NSView *webview) {
    // WKWebView automatically insets its document below the window's titlebar.
    // After wrapping the content view its bounds can extend above that document.
    // Use AppKit's live layout area, including resize/fullscreen changes, not a
    // titlebar-height constant or the inverse of our own frame calculation.
    return NSIntersectionRect(webview.bounds,
        [webview convertRect:webview.window.contentLayoutRect fromView:nil]);
}
// Read the actual native pane back in the trusted document's CSS coordinates.
void atz_container_rect(void *pointer, double *out) {
    NSView *view = (__bridge NSView *)pointer;
    NSView *webview = atz_trusted_webview(view.superview);
    if (!webview) { out[0]=-1;out[1]=-1;out[2]=0;out[3]=0;return; }
    double zoom=atz_webview_zoom(webview);
    NSRect viewport=atz_document_viewport(webview);
    NSRect r=[view convertRect:view.bounds toView:webview];
    out[0]=(NSMinX(r)-NSMinX(viewport))/zoom;
    out[1]=(webview.flipped?NSMinY(r)-NSMinY(viewport):NSMaxY(viewport)-NSMaxY(r))/zoom;
    out[2]=r.size.width/zoom;out[3]=r.size.height/zoom;
}
// Independent physical measurement relative to AppKit's unobscured window area.
// Unlike rect above this does not invert the frame-setting coordinate conversion.
void atz_container_window_rect(void *pointer, double *out) {
    NSView *view = (__bridge NSView *)pointer;
    NSView *webview = atz_trusted_webview(view.superview);
    NSRect r=[view convertRect:view.bounds toView:nil];
    NSRect layout=view.window.contentLayoutRect;
    out[0]=NSMinX(r)-NSMinX(layout);out[1]=NSMaxY(layout)-NSMaxY(r);
    out[2]=r.size.width;out[3]=r.size.height;out[4]=webview?atz_webview_zoom(webview):0.;
}

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
    [container.window invalidateCursorRectsForView:container];
}
BOOL atz_container_frame(void *pointer, double x, double y, double width, double height) {
    NSView *view = (__bridge NSView *)pointer;
    NSView *webview = atz_trusted_webview(view.superview);
    if (!webview) { view.hidden=YES;return NO; }
    double zoom=atz_webview_zoom(webview);
    NSRect viewport=atz_document_viewport(webview);
    if (NSIsEmptyRect(viewport)) { view.hidden=YES;return NO; }
    NSRect r=NSMakeRect(NSMinX(viewport)+x*zoom,
        webview.flipped?NSMinY(viewport)+y*zoom:NSMaxY(viewport)-(y+height)*zoom,
        width*zoom,height*zoom);
    view.frame=[webview convertRect:r toView:view.superview];
    for (NSView *child in view.subviews) child.frame = view.bounds;
    return YES;
}
void atz_container_hidden(void *pointer, BOOL hidden) { [(__bridge NSView *)pointer setHidden:hidden]; }
BOOL atz_container_visible(void *pointer) { NSView *view = (__bridge NSView *)pointer; return view.window.visible && !view.hiddenOrHasHiddenAncestor && view.bounds.size.width > 1 && view.bounds.size.height > 1; }
void atz_release_container(void *pointer) {
    NSView *view = CFBridgingRelease(pointer);
    [view removeFromSuperview];
}

// CEF may schedule from any thread. Keep only the earliest pending wake-up; never a polling timer.
static NSTimer *pump;
static BOOL stopped;
static BOOL pumping;
static BOOL rerun;
static void (*pumpCallback)(void);
void atz_start_pump(void (*callback)(void)) { stopped = NO; pumpCallback = callback; }
void atz_schedule_pump(long long delay) {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (stopped || !pumpCallback) return;
        NSTimeInterval interval = MAX(0, MIN(delay, 1000)) / 1000.0;
        NSDate *date = [NSDate dateWithTimeIntervalSinceNow:interval];
        if (pump && [pump.fireDate compare:date] != NSOrderedDescending) return;
        [pump invalidate];
        pump = [NSTimer timerWithTimeInterval:interval repeats:NO block:^(NSTimer *timer) {
            if (timer != pump) return;
            pump = nil;
            if (stopped || !pumpCallback) return;
            if (pumping) { rerun = YES; return; }
            pumping = YES;
            pumpCallback();
            pumping = NO;
            if (rerun && !stopped) { rerun = NO; atz_schedule_pump(0); }
        }];
        [[NSRunLoop mainRunLoop] addTimer:pump forMode:NSRunLoopCommonModes];
        [[NSRunLoop mainRunLoop] addTimer:pump forMode:NSEventTrackingRunLoopMode];
    });
}
void atz_stop_pump(void) { stopped = YES; [pump invalidate]; pump = nil; pumpCallback = NULL; }
void atz_drain_close_events(void) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.002]];
}

uint64_t atz_container_blocked(void *pointer) { return ((__bridge ATZBrowserContainer *)pointer).blockedInputs; }
BOOL atz_container_focused(void *pointer) {
    NSView *view = (__bridge NSView *)pointer;
    NSResponder *responder = view.window.firstResponder;
    return [responder isKindOfClass:NSView.class] && [(NSView *)responder isDescendantOf:view];
}
// The WKWebView is resolved from the host tree, never from a CEF page. A scoped
// event cannot become a keypress in the terminal that last held DOM focus.
@protocol ATZTrustedBrowserScript <NSObject>
- (void)evaluateJavaScript:(NSString *)script completionHandler:(void (^)(id, NSError *))completion;
@end
BOOL atz_forward_shortcut(void *pointer, void *eventPointer, const char *payload) {
    ATZBrowserContainer *container = (__bridge ATZBrowserContainer *)pointer;
    NSEvent *event = (__bridge NSEvent *)eventPointer;
    NSView *webview = atz_trusted_webview(container.superview);
    NSString *json = payload ? [NSString stringWithUTF8String:payload] : nil;
    if (!event || !webview || !json || ![webview respondsToSelector:@selector(evaluateJavaScript:completionHandler:)] || !container.humanInput || !atz_container_focused(pointer)) return NO;
    // Rust canonicalizes the trusted CEF key. Reading the original NSEvent again
    // would disagree for IME characters even though Command-L was admitted.
    id detail = [NSJSONSerialization JSONObjectWithData:[json dataUsingEncoding:NSUTF8StringEncoding] options:0 error:NULL];
    if (![detail isKindOfClass:NSDictionary.class]) return NO;
    NSString *key = [(NSDictionary *)detail objectForKey:@"key"];
    if (![key isKindOfClass:NSString.class] || ![@[@"l",@"r",@"[",@"]",@"t",@"1",@"2",@"3",@"4",@"5",@"6"] containsObject:key]) return NO;
    BOOL focusAddress = [key isEqualToString:@"l"];
    NSString *dispatch = [NSString stringWithFormat:@"document.dispatchEvent(new CustomEvent('agentstoz-native-browser-shortcut',{detail:%@}));",json];
    // AppKit accepts firstResponder before WK restores document focus. Wait for that
    // restoration and its next frame so focusing the address creates one focus event.
    // Abandon promptly on new input/blur; the frontend rechecks the current binding.
    NSString *script = focusAddress ? [NSString stringWithFormat:@"(()=>{let done=false,frame=0;const deadline=performance.now()+200;const stop=()=>{if(done)return;done=true;clearTimeout(timer);if(frame)cancelAnimationFrame(frame);window.removeEventListener('focus',ready);window.removeEventListener('blur',stop);document.removeEventListener('pointerdown',stop,true);document.removeEventListener('keydown',stop,true);};const ready=()=>{if(done||frame||!document.hasFocus())return;frame=requestAnimationFrame(()=>{frame=0;if(done)return;if(performance.now()>deadline||!document.hasFocus()){stop();return;}stop();%@});};const timer=setTimeout(stop,200);window.addEventListener('focus',ready);window.addEventListener('blur',stop);document.addEventListener('pointerdown',stop,true);document.addEventListener('keydown',stop,true);ready();})();",dispatch] : dispatch;
    dispatch_async(dispatch_get_main_queue(), ^{
        if (!container.humanInput || container.hiddenOrHasHiddenAncestor || container.window != webview.window || !atz_container_focused(pointer)) return;
        if (focusAddress && ![container.window makeFirstResponder:webview]) return;
        [(id<ATZTrustedBrowserScript>)webview evaluateJavaScript:script completionHandler:nil];
    });
    return YES;
}
// Disposable native QA only; reachable solely through fixture-feature ops.
void atz_qa_input(void *pointer, int kind) {
    ATZBrowserContainer *container = (__bridge ATZBrowserContainer *)pointer;
    NSWindow *window = container.window;
    [NSApp activateIgnoringOtherApps:YES];
    [window makeKeyAndOrderFront:nil];
    if (kind==3) return;
    NSPoint point = [container convertPoint:NSMakePoint(30,30) toView:nil];
    if (kind==1) { CGEventRef cg=CGEventCreateScrollWheelEvent(NULL,kCGScrollEventUnitPixel,1,10); NSEvent *e=[NSEvent eventWithCGEvent:cg]; [container scrollWheel:e]; CFRelease(cg); return; }
    if (kind==0) {
        NSEvent *e = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDown location:point modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
        NSView *target=[window.contentView hitTest:[window.contentView convertPoint:point fromView:nil]];
        [target mouseDown:e];
        NSEvent *up=[NSEvent mouseEventWithType:NSEventTypeLeftMouseUp location:point modifierFlags:0 timestamp:0 windowNumber:window.windowNumber context:nil eventNumber:1 clickCount:1 pressure:0];
        [target mouseUp:up];
    } else {
        NSString *characters = kind==4 ? @"ㅣ" : kind==5 ? @"L" : @"l";
        NSEventModifierFlags flags = NSEventModifierFlagCommand | (kind==5 ? NSEventModifierFlagCapsLock : 0);
        NSEvent *e = [NSEvent keyEventWithType:NSEventTypeKeyDown location:point modifierFlags:flags timestamp:0 windowNumber:window.windowNumber context:nil characters:characters charactersIgnoringModifiers:characters isARepeat:NO keyCode:37];
        [window sendEvent:e];
    }
}
void atz_popup_geometry(void *pointer, double *out) {
    NSWindow *window = (__bridge NSWindow *)pointer;
    NSRect p=window.parentWindow.frame, r=window.frame;
    out[0]=r.origin.x;out[1]=r.origin.y;out[2]=r.size.width;out[3]=r.size.height;
    out[4]=p.origin.x;out[5]=p.origin.y;out[6]=p.size.width;out[7]=p.size.height;
    out[8]=[window.title isEqualToString:@"127.0.0.1"];out[9]=window.parentWindow!=nil;
}
