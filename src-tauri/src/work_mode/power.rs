//! OS-owned requests disappear on process exit, including a crash. No shell or global power-setting edits.
pub(super) fn supported() -> bool { cfg!(any(target_os = "macos", windows)) }

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::{c_char, c_void};
    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(allocator: *const c_void, value: *const c_char, encoding: u32) -> *const c_void;
        fn CFRelease(value: *const c_void);
    }
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: *const c_void, level: u32, name: *const c_void, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    pub(crate) struct Lease(Vec<u32>);
    impl Lease {
        pub(crate) fn acquire(display: bool) -> Result<Self, String> {
            let mut lease = Self(Vec::new());
            let kinds: &[&[u8]] = if display {
                &[b"PreventUserIdleSystemSleep\0", b"PreventUserIdleDisplaySleep\0"]
            } else { &[b"PreventUserIdleSystemSleep\0"] };
            for kind in kinds {
                // CF strings are released on every path; the RAII lease unwinds partial acquisitions.
                unsafe {
                    let kind = CFStringCreateWithCString(std::ptr::null(), kind.as_ptr().cast(), 0x08000100);
                    let name = CFStringCreateWithCString(std::ptr::null(), b"AgentsToZ Work Mode\0".as_ptr().cast(), 0x08000100);
                    if kind.is_null() || name.is_null() {
                        if !kind.is_null() { CFRelease(kind); } if !name.is_null() { CFRelease(name); }
                        return Err("근무 모드 전원 요청을 준비하지 못했습니다.".into());
                    }
                    let mut id = 0;
                    let result = IOPMAssertionCreateWithName(kind, 255, name, &mut id);
                    CFRelease(kind); CFRelease(name);
                    if result != 0 { return Err(format!("macOS가 근무 모드 요청을 거절했습니다 ({result}).")); }
                    lease.0.push(id);
                }
            }
            Ok(lease)
        }
    }
    impl Drop for Lease { fn drop(&mut self) { for id in self.0.drain(..) { unsafe { IOPMAssertionRelease(id); } } } }
}

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::{Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE},
        System::{Power::{PowerCreateRequest, PowerSetRequest, PowerClearRequest, PowerRequestSystemRequired, PowerRequestDisplayRequired},
            Threading::{REASON_CONTEXT, REASON_CONTEXT_0}}};
    // Store the owned handle as an integer so the mutex-owned lease can move between threads.
    pub(crate) struct Lease { handle: isize, system: bool, display: bool }
    impl Lease {
        pub(crate) fn acquire(display: bool) -> Result<Self, String> {
            let mut reason: Vec<u16> = "AgentsToZ Work Mode\0".encode_utf16().collect();
            let context = REASON_CONTEXT { Version: 0, Flags: 1, Reason: REASON_CONTEXT_0 { SimpleReasonString: reason.as_mut_ptr() } };
            unsafe {
                let handle = PowerCreateRequest(&context);
                if handle.is_null() || handle == INVALID_HANDLE_VALUE { return Err(format!("전원 요청 생성 실패: {}", std::io::Error::last_os_error())); }
                let mut lease = Self { handle: handle as isize, system: false, display: false };
                if PowerSetRequest(handle, PowerRequestSystemRequired) == 0 { return Err(format!("절전 방지 요청 실패: {}", std::io::Error::last_os_error())); }
                lease.system = true;
                if display {
                    if PowerSetRequest(handle, PowerRequestDisplayRequired) == 0 { return Err(format!("화면 유지 요청 실패: {}", std::io::Error::last_os_error())); }
                    lease.display = true;
                }
                Ok(lease)
            }
        }
    }
    impl Drop for Lease {
        fn drop(&mut self) { unsafe {
            let handle = self.handle as HANDLE;
            if self.display { PowerClearRequest(handle, PowerRequestDisplayRequired); }
            if self.system { PowerClearRequest(handle, PowerRequestSystemRequired); }
            CloseHandle(handle);
        } }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    pub(crate) struct Lease;
    impl Lease { pub(crate) fn acquire(_: bool) -> Result<Self, String> { Err("근무 모드는 Mac·Windows 데스크톱 앱에서 지원합니다.".into()) } }
}
pub(super) use platform::Lease;
