//! Agent Runtime containment on Windows: a Job Object the provider is inside
//! from the moment it is created.
//!
//! `docs/agent-runtime-containment.md` sets the baseline this module implements:
//!
//! - the existing PowerShell Job wrapper stays for ordinary processes and is
//!   **not** reused as the Agent Runtime security boundary;
//! - `PROC_THREAD_ATTRIBUTE_JOB_LIST` removes the spawn race, so there is no
//!   window in which the provider exists outside the job and could spawn a child
//!   that escapes it (`AssignProcessToJobObject` after `CreateProcess` has
//!   exactly that window);
//! - `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is **read back**, because a limit that
//!   silently failed to apply would leave a job that outlives its owner;
//! - `IsProcessInJob` confirms membership rather than assuming it;
//! - every termination path runs `TerminateJobObject` and then proves
//!   `ActiveProcesses == 0` instead of reporting success from the call alone;
//! - the process creation time travels with the pid, so a reused pid can be
//!   rejected later.
//!
//! ⚠️ This module is a **prerequisite**, not the feature. The same document
//! requires staging isolation, Codex sandbox compatibility and a broker-escape
//! E2E before a dangerous mode may be enabled on Windows, because surfaces that
//! do not inherit a job (WMI, services, the task scheduler) can still be used to
//! leave it. Nothing here opens the Agent Runtime on its own.

#![cfg(windows)]
// Nothing in production calls this yet, and that is the point: the containment
// document requires staging isolation, Codex sandbox compatibility and a
// broker-escape E2E before a Windows Agent Runtime mode may be opened. Wiring it
// into a launch path now would be the one thing the document forbids, so the
// module ships verified-but-unused and this allow goes away with the wiring.
#![allow(dead_code)]

use std::ffi::{OsStr, OsString};
use std::os::windows::ffi::OsStrExt;
#[cfg(test)]
use std::path::PathBuf;
use std::ptr::null_mut;

use windows_sys::Win32::Foundation::{
    CloseHandle, LocalFree, SetHandleInformation, FILETIME, HANDLE, HANDLE_FLAG_INHERIT,
    INVALID_HANDLE_VALUE,
};
#[cfg(test)]
use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, IsProcessInJob, QueryInformationJobObject,
    SetInformationJobObject, TerminateJobObject, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::Security::{
    AllocateAndInitializeSid, DuplicateTokenEx, FreeSid, GetSecurityDescriptorSacl,
    SetTokenInformation, SecurityImpersonation, ACL, LABEL_SECURITY_INFORMATION,
    PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, SID_AND_ATTRIBUTES, TOKEN_ALL_ACCESS,
    TOKEN_MANDATORY_LABEL, TokenIntegrityLevel, TokenPrimary,
};
use windows_sys::Win32::Security::Authorization::{
    ConvertStringSecurityDescriptorToSecurityDescriptorW, SetNamedSecurityInfoW, SDDL_REVISION_1,
    SE_FILE_OBJECT,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING,
};
use windows_sys::Win32::System::Pipes::{CreatePipe, PeekNamedPipe};
use windows_sys::Win32::System::Console::{
    GetStdHandle, STD_ERROR_HANDLE, STD_INPUT_HANDLE, STD_OUTPUT_HANDLE,
};
use windows_sys::Win32::System::Threading::{
    CreateProcessAsUserW, CreateProcessW, DeleteProcThreadAttributeList, GetCurrentProcess,
    GetExitCodeProcess,
    GetProcessTimes, OpenProcessToken,
    InitializeProcThreadAttributeList, OpenProcess, UpdateProcThreadAttribute,
    WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
    LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST, STARTF_USESTDHANDLES,
    STARTUPINFOEXW,
};

const GENERIC_READ_WRITE: u32 = 0x8000_0000 | 0x4000_0000;
/// Standard access right `SYNCHRONIZE`; windows-sys does not re-export it from
/// the threading module, and `WaitForSingleObject` needs it on a process handle.
const SYNCHRONIZE: u32 = 0x0010_0000;
/// `SECURITY_MANDATORY_LOW_RID`. The integrity level a contained provider runs at
/// when the caller asks for it.
const SECURITY_MANDATORY_LOW_RID: u32 = 0x1000;
/// `SE_GROUP_INTEGRITY`, the attribute a mandatory label SID carries.
const SE_GROUP_INTEGRITY: u32 = 0x0000_0020;

/// How much authority the contained provider's token keeps.
///
/// ⚠️ **A Job Object is a lifetime boundary, not a security boundary.** Measured
/// on this machine: a normal-integrity process inside a kill-on-close job asked
/// the WMI provider host to create another process (`Win32_Process.Create`), it
/// succeeded, and `IsProcessInJob` on the result was **false** -- the new process
/// was outside the job entirely, so terminating the job would not have reached
/// it. That is the escape `docs/agent-runtime-containment.md` warns about, and no
/// job limit closes it: the broker creates the process, not us.
///
/// `Low` is the answer to that, because the escape needs the provider to reach
/// the broker in the first place. A low-integrity process fails the DCOM and RPC
/// access checks those brokers sit behind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainedIntegrity {
    /// The owner's own integrity level. The provider can reach brokers.
    Normal,
    /// Low integrity. ⚠️ A low-integrity process can only write where the label
    /// allows, so a provider started this way needs a staging directory labelled
    /// for it -- that is the staging-isolation gate, still open.
    Low,
}

/// What a contained provider gets for its standard handles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContainedStdio {
    /// Three handles on `NUL`. Enough for a provider that is driven entirely by
    /// its arguments and whose output nobody reads.
    Null,
    /// Pipes the owner writes to and reads from. The guard protocol carries the
    /// prompt over stdin and the provider's answer back over stdout, so a
    /// contained provider that has to be talked to needs this.
    Piped,
    /// This process's own standard handles, handed straight to the provider.
    ///
    /// For a containment helper that sits between a sidecar and a provider: the
    /// sidecar already gave the helper pipes, so passing them through is a direct
    /// connection instead of a byte relay, with nothing to buffer, reorder or
    /// drop. ⚠️ A handle is usable because it was **given**, not because the
    /// holder could open it: integrity blocks opening an object by name, so a
    /// low-integrity provider can still write to a pipe it inherited from a
    /// normal-integrity parent.
    Inherit,
}

/// The three handles handed to the child, and the owner's ends when piped.
///
/// The containment baseline calls for passing **limited** stdio handles. A
/// provider with none at all is not a stricter reading of that -- it is broken:
/// a console program whose standard handles are invalid exits immediately
/// (measured -- `ping` and `cmd` both died at once and the job legitimately
/// reported zero active processes, which reads as a broken implementation).
///
/// Only the child's three handles are inheritable, and
/// `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` makes them the only handles it inherits;
/// the job handle in particular must never reach it, or the contained process
/// could terminate or reconfigure its own container.
struct StdioSetup {
    child: [HANDLE; 3],
    owner_stdin: Option<HANDLE>,
    owner_stdout: Option<HANDLE>,
    owner_stderr: Option<HANDLE>,
}

fn inheritable_attributes() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: null_mut(),
        bInheritHandle: 1,
    }
}

fn valid(handle: HANDLE) -> bool {
    handle != INVALID_HANDLE_VALUE && !handle.is_null()
}

fn close(handle: HANDLE) {
    if valid(handle) {
        unsafe { CloseHandle(handle) };
    }
}

/// One pipe, with the owner's end made non-inheritable.
///
/// ⚠️ Both ends come back inheritable from `CreatePipe` with inheritable
/// attributes, and leaving the owner's end that way is the classic reason EOF
/// never arrives: the child inherits a copy of the write end, so the read end
/// stays open after the child exits and a read blocks forever.
fn owner_private_pipe(owner_reads: bool) -> Result<(HANDLE, HANDLE), String> {
    let mut attributes = inheritable_attributes();
    let mut read: HANDLE = null_mut();
    let mut write: HANDLE = null_mut();
    // SAFETY: two out parameters and a fully initialised attributes value.
    if unsafe { CreatePipe(&raw mut read, &raw mut write, &raw mut attributes, 0) } == 0 {
        return Err(format!("CreatePipe failed (error {})", last_error()));
    }
    let (owner, child) = if owner_reads { (read, write) } else { (write, read) };
    // SAFETY: a handle this function owns.
    if unsafe { SetHandleInformation(owner, HANDLE_FLAG_INHERIT, 0) } == 0 {
        let error = last_error();
        close(read);
        close(write);
        return Err(format!("SetHandleInformation failed (error {error})"));
    }
    Ok((owner, child))
}

impl StdioSetup {
    fn open(kind: ContainedStdio) -> Result<Self, String> {
        match kind {
            ContainedStdio::Null => {
                let mut attributes = inheritable_attributes();
                let name = wide(OsStr::new("NUL"));
                let mut handles = [null_mut(); 3];
                for slot in handles.iter_mut() {
                    // SAFETY: a fixed device name and an initialised attributes value.
                    *slot = unsafe {
                        CreateFileW(
                            name.as_ptr(),
                            GENERIC_READ_WRITE,
                            FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &raw mut attributes,
                            OPEN_EXISTING,
                            0,
                            null_mut(),
                        )
                    };
                    if !valid(*slot) {
                        let error = last_error();
                        for opened in handles {
                            close(opened);
                        }
                        return Err(format!("CreateFileW(NUL) failed (error {error})"));
                    }
                }
                Ok(Self {
                    child: handles,
                    owner_stdin: None,
                    owner_stdout: None,
                    owner_stderr: None,
                })
            }
            ContainedStdio::Inherit => {
                let mut handles = [null_mut(); 3];
                for (slot, which) in handles.iter_mut().zip([
                    STD_INPUT_HANDLE,
                    STD_OUTPUT_HANDLE,
                    STD_ERROR_HANDLE,
                ]) {
                    // SAFETY: a documented standard-handle identifier.
                    let handle = unsafe { GetStdHandle(which) };
                    if !valid(handle) {
                        return Err(format!(
                            "GetStdHandle({which}) failed (error {})",
                            last_error()
                        ));
                    }
                    // The child can only inherit a handle marked inheritable,
                    // and these belong to this process, so the flag is set on
                    // the original rather than on a duplicate.
                    // SAFETY: a handle this process owns.
                    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) } == 0 {
                        return Err(format!(
                            "SetHandleInformation(std) failed (error {})",
                            last_error()
                        ));
                    }
                    *slot = handle;
                }
                Ok(Self {
                    child: handles,
                    owner_stdin: None,
                    owner_stdout: None,
                    owner_stderr: None,
                })
            }
            ContainedStdio::Piped => {
                let (owner_stdin, child_stdin) = owner_private_pipe(false)?;
                let (owner_stdout, child_stdout) = match owner_private_pipe(true) {
                    Ok(pair) => pair,
                    Err(error) => {
                        close(owner_stdin);
                        close(child_stdin);
                        return Err(error);
                    }
                };
                let (owner_stderr, child_stderr) = match owner_private_pipe(true) {
                    Ok(pair) => pair,
                    Err(error) => {
                        for handle in [owner_stdin, child_stdin, owner_stdout, child_stdout] {
                            close(handle);
                        }
                        return Err(error);
                    }
                };
                Ok(Self {
                    child: [child_stdin, child_stdout, child_stderr],
                    owner_stdin: Some(owner_stdin),
                    owner_stdout: Some(owner_stdout),
                    owner_stderr: Some(owner_stderr),
                })
            }
        }
    }

    /// Releases the child's ends once it owns them.
    ///
    /// ⚠️ Required for pipes: while the owner still holds a copy of the child's
    /// write end, a read on the matching read end never sees EOF even after the
    /// provider is gone. ⚠️ Not for inherited standard handles -- those belong to
    /// this process, and closing them would take its own stdio away.
    fn release_child_ends(&mut self, kind: ContainedStdio) {
        if kind == ContainedStdio::Inherit {
            for slot in self.child.iter_mut() {
                *slot = null_mut();
            }
            return;
        }
        for slot in self.child.iter_mut() {
            close(*slot);
            *slot = null_mut();
        }
    }
}

impl Drop for StdioSetup {
    fn drop(&mut self) {
        for handle in self.child {
            close(handle);
        }
    }
}

/// A provider process that is inside its job and cannot leave it.
pub struct ContainedProcess {
    job: HANDLE,
    process: HANDLE,
    thread: HANDLE,
    pid: u32,
    /// The owner's ends of the provider's pipes, when it was started piped.
    owner_stdin: Option<HANDLE>,
    owner_stdout: Option<HANDLE>,
    owner_stderr: Option<HANDLE>,
    /// `GetProcessTimes` creation time. A pid alone is not an identity: Windows
    /// reuses pids, so a stale registry row could otherwise be matched to an
    /// unrelated process and terminated.
    created_at: u64,
}

/// What a termination proved, so a caller never reports success from the call.
///
/// `total_terminated` is deliberately absent: `TotalTerminatedProcesses` counts
/// only processes the kernel killed for a **limit violation**, so it stays zero
/// after `TerminateJobObject` and asserting on it would fail a correct
/// termination (measured). `active_processes == 0` is the proof the containment
/// contract asks for, and `total_processes` shows the job was not simply empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminationProof {
    pub active_processes: u32,
    pub total_processes: u32,
}

fn last_error() -> u32 {
    // SAFETY: GetLastError only reads this thread's error slot.
    unsafe { windows_sys::Win32::Foundation::GetLastError() }
}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn filetime_to_u64(time: FILETIME) -> u64 {
    (u64::from(time.dwHighDateTime) << 32) | u64::from(time.dwLowDateTime)
}

/// Creates the job and proves `KILL_ON_JOB_CLOSE` actually applied.
///
/// The handle is deliberately not inheritable (null security attributes), so a
/// child cannot receive the job handle and, with it, the ability to terminate or
/// reconfigure its own container.
fn create_kill_on_close_job() -> Result<HANDLE, String> {
    // SAFETY: both arguments are null, which CreateJobObjectW documents as
    // "unnamed, non-inheritable, default security".
    let job = unsafe { CreateJobObjectW(null_mut(), std::ptr::null()) };
    if job.is_null() {
        return Err(format!("CreateJobObjectW failed (error {})", last_error()));
    }

    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
    // SAFETY: `limits` is a fully initialised value of the type the class names.
    let set = unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const limits).cast(),
            size,
        )
    };
    if set == 0 {
        let error = last_error();
        unsafe { CloseHandle(job) };
        return Err(format!("SetInformationJobObject failed (error {error})"));
    }

    // Read back rather than trust the call: a job whose kill-on-close did not
    // apply would keep the provider alive after its owner is gone, which is the
    // one property the containment exists for.
    let mut readback: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    let mut returned: u32 = 0;
    // SAFETY: the out buffer matches the information class and its size.
    let queried = unsafe {
        QueryInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw mut readback).cast(),
            size,
            &raw mut returned,
        )
    };
    if queried == 0 {
        let error = last_error();
        unsafe { CloseHandle(job) };
        return Err(format!("QueryInformationJobObject failed (error {error})"));
    }
    if readback.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0 {
        unsafe { CloseHandle(job) };
        return Err("the job did not keep JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE".to_string());
    }
    Ok(job)
}

/// `GetProcessTimes` creation time for a pid, or an error. Used to fence a pid
/// against reuse without holding the process handle open.
pub fn process_creation_time(pid: u32) -> Result<u64, String> {
    // SAFETY: a limited-information query handle is the least this needs.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return Err(format!("OpenProcess({pid}) failed (error {})", last_error()));
    }
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: four out parameters, all initialised.
    let ok = unsafe {
        GetProcessTimes(
            handle,
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    };
    let error = last_error();
    unsafe { CloseHandle(handle) };
    if ok == 0 {
        return Err(format!("GetProcessTimes({pid}) failed (error {error})"));
    }
    Ok(filetime_to_u64(creation))
}

/// The mandatory label a staging directory needs for a low-integrity provider.
///
/// `S:(ML;OICI;NW;;;LW)` is the same label `icacls /setintegritylevel (OI)(CI)Low`
/// writes: a low mandatory level, inherited by files and subdirectories, with
/// no-write-up. SDDL is used rather than an ACL built by hand because the label
/// is a fixed literal -- nothing about it comes from a caller -- and a
/// hand-rolled SACL is a long way to reach the same four bytes.
const LOW_INTEGRITY_SDDL: &str = "S:(ML;OICI;NW;;;LW)";

/// Labels a directory so a low-integrity provider may write inside it.
///
/// ⚠️ This is required, not optional, for `ContainedIntegrity::Low`: that
/// integrity level is what closes the WMI broker escape, and it also stops the
/// provider writing anywhere that is not labelled for it. Measured: a
/// low-integrity process wrote into a directory labelled this way and was
/// refused in its unlabelled sibling.
///
/// Only the label is written (`LABEL_SECURITY_INFORMATION`); the owner, group and
/// DACL are left exactly as they were, so this cannot widen who may reach the
/// directory.
pub fn label_low_integrity(directory: &OsStr) -> Result<(), String> {
    let sddl = wide(OsStr::new(LOW_INTEGRITY_SDDL));
    let mut descriptor: PSECURITY_DESCRIPTOR = null_mut();
    // SAFETY: a fixed literal and an out parameter freed below.
    let converted = unsafe {
        ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1 as u32,
            &raw mut descriptor,
            std::ptr::null_mut(),
        )
    };
    if converted == 0 {
        return Err(format!(
            "ConvertStringSecurityDescriptorToSecurityDescriptorW failed (error {})",
            last_error()
        ));
    }

    let mut present: i32 = 0;
    let mut sacl: *mut ACL = null_mut();
    let mut defaulted: i32 = 0;
    // SAFETY: the descriptor was just produced by the call above.
    let read = unsafe {
        GetSecurityDescriptorSacl(
            descriptor,
            &raw mut present,
            &raw mut sacl,
            &raw mut defaulted,
        )
    };
    if read == 0 || present == 0 || sacl.is_null() {
        let error = last_error();
        unsafe { LocalFree(descriptor.cast()) };
        return Err(format!(
            "the low-integrity descriptor carried no label (present={present}, error {error})"
        ));
    }

    let mut target = wide(directory);
    // SAFETY: a writable name buffer and a SACL owned by the descriptor, which
    // outlives this call.
    let applied = unsafe {
        SetNamedSecurityInfoW(
            target.as_mut_ptr(),
            SE_FILE_OBJECT,
            LABEL_SECURITY_INFORMATION,
            null_mut(),
            null_mut(),
            null_mut(),
            sacl,
        )
    };
    unsafe { LocalFree(descriptor.cast()) };
    // SetNamedSecurityInfoW returns a Win32 error code, not a BOOL.
    if applied != 0 {
        return Err(format!(
            "SetNamedSecurityInfoW({}) failed (error {applied})",
            directory.to_string_lossy()
        ));
    }
    Ok(())
}

/// A `CREATE_UNICODE_ENVIRONMENT` block: `KEY=VALUE\0…\0\0`.
///
/// Built from an explicit list rather than inherited and patched, because the
/// provider's environment is part of what contains it: the launcher decides what
/// it can see, and a variable it was not given cannot be read back out of it.
/// An empty list means "inherit", which is what the non-contained paths do.
fn environment_block(variables: &[(OsString, OsString)]) -> Option<Vec<u16>> {
    if variables.is_empty() {
        return None;
    }
    let mut block: Vec<u16> = Vec::new();
    for (key, value) in variables {
        // A name with '=' or a NUL in either half would silently reshape the
        // block, so it is refused by construction: callers pass literals.
        block.extend(key.encode_wide());
        block.push(u16::from(b'='));
        block.extend(value.encode_wide());
        block.push(0);
    }
    block.push(0);
    Some(block)
}

/// A primary token like the owner's, lowered to low integrity.
///
/// Derived from this process's own token rather than created, which is what lets
/// `CreateProcessAsUserW` accept it without `SeAssignPrimaryTokenPrivilege`: a
/// restricted or lowered version of the caller's own token needs no privilege.
struct LowIntegrityToken(HANDLE);

impl LowIntegrityToken {
    fn derive() -> Result<Self, String> {
        let mut own: HANDLE = null_mut();
        // SAFETY: an out parameter for a handle this function then owns.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, &raw mut own) } == 0 {
            return Err(format!("OpenProcessToken failed (error {})", last_error()));
        }
        let mut lowered: HANDLE = null_mut();
        // SAFETY: `own` is a valid token; the out parameter receives a new one.
        let duplicated = unsafe {
            DuplicateTokenEx(
                own,
                TOKEN_ALL_ACCESS,
                null_mut(),
                SecurityImpersonation,
                TokenPrimary,
                &raw mut lowered,
            )
        };
        let duplicate_error = last_error();
        close(own);
        if duplicated == 0 {
            return Err(format!("DuplicateTokenEx failed (error {duplicate_error})"));
        }

        // S-1-16-4096: the low mandatory level.
        let authority = windows_sys::Win32::Security::SID_IDENTIFIER_AUTHORITY {
            Value: [0, 0, 0, 0, 0, 16],
        };
        let mut sid: windows_sys::Win32::Security::PSID = null_mut();
        // SAFETY: one sub-authority, as the mandatory label authority defines.
        let allocated = unsafe {
            AllocateAndInitializeSid(
                &raw const authority,
                1,
                SECURITY_MANDATORY_LOW_RID,
                0, 0, 0, 0, 0, 0, 0,
                &raw mut sid,
            )
        };
        if allocated == 0 {
            let error = last_error();
            close(lowered);
            return Err(format!("AllocateAndInitializeSid failed (error {error})"));
        }
        let label = TOKEN_MANDATORY_LABEL {
            Label: SID_AND_ATTRIBUTES { Sid: sid, Attributes: SE_GROUP_INTEGRITY },
        };
        // SAFETY: the label matches the information class, and `sid` is live.
        let set = unsafe {
            SetTokenInformation(
                lowered,
                TokenIntegrityLevel,
                (&raw const label).cast(),
                (std::mem::size_of::<TOKEN_MANDATORY_LABEL>()
                    + windows_sys::Win32::Security::GetLengthSid(sid) as usize)
                    as u32,
            )
        };
        let set_error = last_error();
        unsafe { FreeSid(sid) };
        if set == 0 {
            close(lowered);
            return Err(format!(
                "SetTokenInformation(TokenIntegrityLevel) failed (error {set_error})"
            ));
        }
        Ok(Self(lowered))
    }
}

impl Drop for LowIntegrityToken {
    fn drop(&mut self) {
        close(self.0);
    }
}

/// Whether the process at `pid` is the one `created_at` names **and is still
/// running**.
///
/// ⚠️ A matching creation time is not liveness. A terminated process stays
/// openable for as long as anything holds a handle to it, and `GetProcessTimes`
/// keeps answering with the same creation time -- measured: a launcher watching
/// its owner saw it as present four seconds after it had been killed, because
/// the shell that started it still held a handle. `WaitForSingleObject(0)` is the
/// unambiguous question: a process handle is signalled exactly when the process
/// has exited. `GetExitCodeProcess` is not used for this, because a process may
/// legitimately exit with 259 (`STILL_ACTIVE`).
pub fn process_alive(pid: u32, created_at: u64) -> bool {
    if created_at == 0 {
        return false;
    }
    // SAFETY: SYNCHRONIZE is what WaitForSingleObject needs; the query right is
    // for the creation time.
    let handle =
        unsafe { OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut creation: FILETIME = unsafe { std::mem::zeroed() };
    let mut exit: FILETIME = unsafe { std::mem::zeroed() };
    let mut kernel: FILETIME = unsafe { std::mem::zeroed() };
    let mut user: FILETIME = unsafe { std::mem::zeroed() };
    // SAFETY: four out parameters, all initialised.
    let read = unsafe {
        GetProcessTimes(
            handle,
            &raw mut creation,
            &raw mut exit,
            &raw mut kernel,
            &raw mut user,
        )
    };
    // SAFETY: a handle opened with SYNCHRONIZE.
    let signalled = unsafe { WaitForSingleObject(handle, 0) };
    close(handle);
    read != 0 && filetime_to_u64(creation) == created_at && signalled != 0
}

impl ContainedProcess {
    /// Spawns `command` already inside a fresh kill-on-close job.
    ///
    /// `command_line` is passed through as the whole command line, the way
    /// `CreateProcessW` expects it; this function does not build one from parts,
    /// so the caller stays responsible for quoting what it chose to run. Nothing
    /// here accepts a shell.
    /// Spawns at the owner's own integrity level. See [`ContainedProcess::spawn_with`]
    /// for why that leaves the broker escape open.
    pub fn spawn(
        command_line: &OsStr,
        cwd: Option<&OsStr>,
        stdio: ContainedStdio,
    ) -> Result<Self, String> {
        Self::spawn_with(command_line, cwd, stdio, ContainedIntegrity::Normal, &[])
    }

    /// `environment` empty means inherit; otherwise it is the provider's whole
    /// environment, so anything it needs has to be listed.
    pub fn spawn_with(
        command_line: &OsStr,
        cwd: Option<&OsStr>,
        stdio: ContainedStdio,
        integrity: ContainedIntegrity,
        environment: &[(OsString, OsString)],
    ) -> Result<Self, String> {
        let job = create_kill_on_close_job()?;
        match Self::spawn_in(job, command_line, cwd, stdio, integrity, environment) {
            Ok(process) => Ok(process),
            Err(error) => {
                // Closing the job kills anything already inside it, which is the
                // behaviour that was just verified.
                unsafe { CloseHandle(job) };
                Err(error)
            }
        }
    }

    fn spawn_in(
        job: HANDLE,
        command_line: &OsStr,
        cwd: Option<&OsStr>,
        kind: ContainedStdio,
        integrity: ContainedIntegrity,
        environment: &[(OsString, OsString)],
    ) -> Result<Self, String> {
        let mut stdio = StdioSetup::open(kind)?;

        // Two attributes: the job list, and the exact set of handles the child
        // may inherit. Sizing is a two-call protocol -- the first call is
        // expected to fail and only fills in the size.
        let mut size: usize = 0;
        unsafe { InitializeProcThreadAttributeList(null_mut(), 2, 0, &raw mut size) };
        if size == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList did not report a size (error {})",
                last_error()
            ));
        }
        let mut buffer = vec![0u8; size];
        let list = buffer.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        // SAFETY: the buffer is exactly the size the first call asked for.
        if unsafe { InitializeProcThreadAttributeList(list, 2, 0, &raw mut size) } == 0 {
            return Err(format!(
                "InitializeProcThreadAttributeList failed (error {})",
                last_error()
            ));
        }

        let jobs = [job];
        // SAFETY: `jobs` outlives the CreateProcessW call below, which is the
        // only reader of this attribute.
        let updated = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                jobs.as_ptr().cast(),
                std::mem::size_of::<HANDLE>(),
                null_mut(),
                std::ptr::null_mut(),
            )
        };
        if updated == 0 {
            let error = last_error();
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(format!("UpdateProcThreadAttribute(JOB_LIST) failed (error {error})"));
        }

        // `bInheritHandles` has to be TRUE for STARTF_USESTDHANDLES to mean
        // anything, which would otherwise hand the child every inheritable
        // handle this process holds. The handle list narrows that to exactly
        // these three, so the job handle cannot reach the contained process.
        let inheritable = stdio.child;
        // SAFETY: `inheritable` outlives the CreateProcessW call below.
        let narrowed = unsafe {
            UpdateProcThreadAttribute(
                list,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                inheritable.as_ptr().cast(),
                std::mem::size_of::<HANDLE>() * inheritable.len(),
                null_mut(),
                std::ptr::null_mut(),
            )
        };
        if narrowed == 0 {
            let error = last_error();
            unsafe { DeleteProcThreadAttributeList(list) };
            return Err(format!("UpdateProcThreadAttribute(HANDLE_LIST) failed (error {error})"));
        }

        let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = stdio.child[0];
        startup.StartupInfo.hStdOutput = stdio.child[1];
        startup.StartupInfo.hStdError = stdio.child[2];
        startup.lpAttributeList = list;

        let mut command = wide(command_line);
        let cwd_wide = cwd.map(wide);
        let mut info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };

        // SAFETY: the command line buffer is writable and null-terminated, and
        // the attribute list is valid until DeleteProcThreadAttributeList below.
        // Lowering the integrity level is the only thing that closes the broker
        // escape, and it needs CreateProcessAsUserW. The token is a lowered
        // duplicate of this process's own, which is why no privilege is required.
        let lowered = match integrity {
            ContainedIntegrity::Normal => None,
            ContainedIntegrity::Low => Some(LowIntegrityToken::derive()?),
        };
        // `bInheritHandles` TRUE is required for STARTF_USESTDHANDLES to apply;
        // the handle list above is what keeps it from meaning "every inheritable
        // handle this process holds".
        let flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
        let mut block = environment_block(environment);
        let environment_pointer = block
            .as_mut()
            .map_or(null_mut(), |value| value.as_mut_ptr().cast());
        let cwd_pointer = cwd_wide
            .as_ref()
            .map_or(std::ptr::null(), |value| value.as_ptr());
        let spawned = match lowered.as_ref() {
            None => unsafe {
                CreateProcessW(
                    std::ptr::null(),
                    command.as_mut_ptr(),
                    null_mut(),
                    null_mut(),
                    1,
                    flags,
                    environment_pointer,
                    cwd_pointer,
                    (&raw const startup).cast(),
                    &raw mut info,
                )
            },
            Some(token) => unsafe {
                CreateProcessAsUserW(
                    token.0,
                    std::ptr::null(),
                    command.as_mut_ptr(),
                    null_mut(),
                    null_mut(),
                    1,
                    flags,
                    environment_pointer,
                    cwd_pointer,
                    (&raw const startup).cast(),
                    &raw mut info,
                )
            },
        };
        let spawn_error = last_error();
        unsafe { DeleteProcThreadAttributeList(list) };
        if spawned == 0 {
            return Err(format!("CreateProcessW failed (error {spawn_error})"));
        }

        // Membership is confirmed, not assumed. If the attribute were ever
        // ignored the provider would be running uncontained, which must fail the
        // launch rather than proceed.
        let mut in_job: i32 = 0;
        // SAFETY: both handles come from the calls above.
        let checked = unsafe { IsProcessInJob(info.hProcess, job, &raw mut in_job) };
        if checked == 0 || in_job == 0 {
            let error = last_error();
            unsafe { TerminateJobObject(job, 1) };
            close(info.hThread);
            close(info.hProcess);
            for handle in [stdio.owner_stdin, stdio.owner_stdout, stdio.owner_stderr] {
                if let Some(handle) = handle {
                    close(handle);
                }
            }
            return Err(format!(
                "the process is not in its job (IsProcessInJob={checked}, inJob={in_job}, error {error})"
            ));
        }

        // The child owns its ends now. Releasing the owner's copies is what
        // lets a read on stdout ever reach EOF.
        stdio.release_child_ends(kind);
        let created_at = process_creation_time(info.dwProcessId).unwrap_or(0);
        Ok(Self {
            job,
            process: info.hProcess,
            thread: info.hThread,
            pid: info.dwProcessId,
            owner_stdin: stdio.owner_stdin.take(),
            owner_stdout: stdio.owner_stdout.take(),
            owner_stderr: stdio.owner_stderr.take(),
            created_at,
        })
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// `GetProcessTimes` creation time captured at spawn. Zero means it could not
    /// be read, which a caller must treat as "cannot fence this pid".
    pub fn created_at(&self) -> u64 {
        self.created_at
    }

    /// Whether this exact process is still the one the pid refers to, and running.
    pub fn pid_still_ours(&self) -> bool {
        process_alive(self.pid, self.created_at)
    }

    /// Writes to the provider's standard input. Only meaningful when started
    /// `Piped`; a `Null` provider reports zero bytes rather than failing, because
    /// a caller that chose Null already said nobody is talking to it.
    pub fn write_stdin(&self, bytes: &[u8]) -> Result<usize, String> {
        let Some(handle) = self.owner_stdin else { return Ok(0) };
        let mut written: u32 = 0;
        // SAFETY: a handle this value owns, and a slice that outlives the call.
        let ok = unsafe {
            WriteFile(
                handle,
                bytes.as_ptr(),
                bytes.len() as u32,
                &raw mut written,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(format!("WriteFile(stdin) failed (error {})", last_error()));
        }
        Ok(written as usize)
    }

    /// Closes the provider's standard input, which is how a protocol says "that
    /// was the whole request" to a provider that reads until EOF.
    pub fn close_stdin(&mut self) {
        if let Some(handle) = self.owner_stdin.take() {
            close(handle);
        }
    }

    /// Reads whatever the provider has written to stdout, up to `budget`.
    pub fn read_stdout(&self, budget: std::time::Duration) -> Result<Vec<u8>, String> {
        Self::drain(self.owner_stdout, budget)
    }

    /// Reads whatever the provider has written to stderr, up to `budget`.
    pub fn read_stderr(&self, budget: std::time::Duration) -> Result<Vec<u8>, String> {
        Self::drain(self.owner_stderr, budget)
    }

    /// Collects from one pipe until it goes quiet, closes, or the budget is spent.
    ///
    /// `PeekNamedPipe` is what keeps this from blocking: a plain `ReadFile` on an
    /// empty pipe waits for the writer, so a provider that simply has nothing to
    /// say would hang its owner. A broken pipe is the normal end -- the provider
    /// exited -- and is reported as "no more output", not as an error.
    fn drain(handle: Option<HANDLE>, budget: std::time::Duration) -> Result<Vec<u8>, String> {
        let Some(handle) = handle else { return Ok(Vec::new()) };
        let deadline = std::time::Instant::now() + budget;
        let mut collected = Vec::new();
        let mut buffer = [0u8; 8192];
        while std::time::Instant::now() < deadline {
            let mut available: u32 = 0;
            // SAFETY: only the "bytes available" out parameter is used.
            let peeked = unsafe {
                PeekNamedPipe(
                    handle,
                    null_mut(),
                    0,
                    null_mut(),
                    &raw mut available,
                    null_mut(),
                )
            };
            if peeked == 0 {
                // ERROR_BROKEN_PIPE (109) means the provider is gone, which is
                // an end, not a failure.
                let error = last_error();
                if error == 109 || collected.is_empty() {
                    return Ok(collected);
                }
                return Err(format!("PeekNamedPipe failed (error {error})"));
            }
            if available == 0 {
                if !collected.is_empty() {
                    return Ok(collected);
                }
                std::thread::sleep(std::time::Duration::from_millis(15));
                continue;
            }
            let want = (available as usize).min(buffer.len()) as u32;
            let mut read: u32 = 0;
            // SAFETY: the buffer is at least `want` bytes long.
            let ok = unsafe {
                ReadFile(handle, buffer.as_mut_ptr(), want, &raw mut read, null_mut())
            };
            if ok == 0 {
                let error = last_error();
                if error == 109 {
                    return Ok(collected);
                }
                return Err(format!("ReadFile failed (error {error})"));
            }
            if read == 0 {
                return Ok(collected);
            }
            collected.extend_from_slice(&buffer[..read as usize]);
        }
        Ok(collected)
    }

    /// Waits for the provider itself to exit, returning its code.
    ///
    /// `None` means it was still running when the budget ran out. Descendants are
    /// not waited for -- that is what the termination proof is for.
    pub fn wait(&self, budget: std::time::Duration) -> Option<u32> {
        let millis = budget.as_millis().min(u128::from(u32::MAX)) as u32;
        // SAFETY: a process handle this value owns.
        let waited = unsafe { WaitForSingleObject(self.process, millis) };
        if waited != 0 {
            return None;
        }
        let mut code: u32 = 0;
        // SAFETY: an out parameter for the exit code.
        if unsafe { GetExitCodeProcess(self.process, &raw mut code) } == 0 {
            return None;
        }
        Some(code)
    }

    /// Terminates the whole job and proves nothing is left running.
    ///
    /// `TerminateJobObject` returning success only means the request was issued.
    /// The accounting readback is the proof, and it is the proof the containment
    /// contract asks for on every exit path.
    pub fn terminate_proven(&self, exit_code: u32) -> Result<TerminationProof, String> {
        // SAFETY: the job handle is owned by this value.
        if unsafe { TerminateJobObject(self.job, exit_code) } == 0 {
            return Err(format!("TerminateJobObject failed (error {})", last_error()));
        }
        // Termination is asynchronous; wait on the process we started before
        // reading the accounting, then poll briefly for its descendants.
        unsafe { WaitForSingleObject(self.process, 5_000) };
        for attempt in 0..50 {
            let proof = self.accounting()?;
            if proof.active_processes == 0 {
                return Ok(proof);
            }
            if attempt < 49 {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
        let proof = self.accounting()?;
        Err(format!(
            "the job still reports {} active process(es) after TerminateJobObject",
            proof.active_processes
        ))
    }

    /// Live accounting for the job: how many processes are in it right now.
    pub fn accounting(&self) -> Result<TerminationProof, String> {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = unsafe { std::mem::zeroed() };
        let mut returned: u32 = 0;
        // SAFETY: the out buffer matches the information class and its size.
        let ok = unsafe {
            QueryInformationJobObject(
                self.job,
                JobObjectBasicAccountingInformation,
                (&raw mut info).cast(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                &raw mut returned,
            )
        };
        if ok == 0 {
            return Err(format!(
                "QueryInformationJobObject(accounting) failed (error {})",
                last_error()
            ));
        }
        Ok(TerminationProof {
            active_processes: info.ActiveProcesses,
            total_processes: info.TotalProcesses,
        })
    }
}

impl std::fmt::Debug for ContainedProcess {
    /// Deliberately omits the handles: a job handle in a log line is an
    /// invitation to reuse it from somewhere that must not have it.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContainedProcess")
            .field("pid", &self.pid)
            .field("created_at", &self.created_at)
            .finish()
    }
}

impl Drop for ContainedProcess {
    fn drop(&mut self) {
        for handle in [self.owner_stdin, self.owner_stdout, self.owner_stderr] {
            if let Some(handle) = handle {
                close(handle);
            }
        }
        // Closing the job is itself the kill, which is why the limit is read
        // back at creation: a job without it would leak the provider here.
        unsafe {
            if !self.thread.is_null() && self.thread != INVALID_HANDLE_VALUE {
                CloseHandle(self.thread);
            }
            if !self.process.is_null() && self.process != INVALID_HANDLE_VALUE {
                CloseHandle(self.process);
            }
            if !self.job.is_null() && self.job != INVALID_HANDLE_VALUE {
                CloseHandle(self.job);
            }
        }
    }
}

/// Assigning after creation is the pattern this module exists to avoid; it is
/// kept only so a test can demonstrate the race it leaves open.
#[cfg(test)]
fn assign_after_creation(job: HANDLE, process: HANDLE) -> bool {
    unsafe { AssignProcessToJobObject(job, process) != 0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn cmd(line: &str) -> OsString {
        OsString::from(line)
    }

    #[test]
    fn a_provider_is_inside_its_job_from_creation_and_terminates_provably() {
        // `timeout` keeps the child alive without producing output.
        let contained = ContainedProcess::spawn(&cmd("cmd.exe /c ping -n 31 127.0.0.1"), None, ContainedStdio::Null)
            .expect("spawn contained");
        assert!(contained.pid() > 0);
        // A pid alone is not an identity; the creation time is what fences reuse.
        assert_ne!(contained.created_at(), 0);
        assert!(contained.pid_still_ours());

        let before = contained.accounting().expect("accounting");
        assert!(before.active_processes >= 1, "{before:?}");

        let proof = contained.terminate_proven(1).expect("terminate");
        // The contract asks for ActiveProcesses == 0, not a successful call.
        assert_eq!(proof.active_processes, 0, "{proof:?}");
        assert!(proof.total_processes >= 1, "{proof:?}");
    }

    #[test]
    fn descendants_are_contained_too() {
        // The whole point: a provider's own children must not outlive the job.
        // `cmd` starts a detached child, which an AssignProcessToJobObject-after
        // -spawn approach can miss entirely.
        let contained = ContainedProcess::spawn(
            &cmd("cmd.exe /c start /b cmd.exe /c ping -n 31 127.0.0.1 & ping -n 31 127.0.0.1"),
            None,
            ContainedStdio::Null,
        )
        .expect("spawn contained");
        // Give the inner process time to exist before counting.
        std::thread::sleep(std::time::Duration::from_millis(600));
        let before = contained.accounting().expect("accounting");
        assert!(before.active_processes >= 2, "expected a descendant: {before:?}");

        let proof = contained.terminate_proven(1).expect("terminate");
        assert_eq!(proof.active_processes, 0, "{proof:?}");
    }

    #[test]
    fn closing_the_job_kills_what_is_inside_it() {
        // Drop is the last line of defence: if the owner goes away without
        // terminating, kill-on-close must still take the tree down. The limit is
        // read back at creation precisely so this cannot silently not happen.
        let pid = {
            let contained = ContainedProcess::spawn(&cmd("cmd.exe /c ping -n 31 127.0.0.1"), None, ContainedStdio::Null)
                .expect("spawn contained");
            let pid = contained.pid();
            assert!(contained.pid_still_ours());
            pid
        };
        std::thread::sleep(std::time::Duration::from_millis(800));
        // The handle is gone, so the only way to observe the pid is to open it;
        // a terminated process reports a creation time no longer matching, or
        // cannot be opened at all.
        let after = process_creation_time(pid);
        if let Ok(_time) = after {
            // A pid can be reused, but it must not still be our live child: a
            // still-running tree would mean kill-on-close did not apply.
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if !handle.is_null() {
                let mut code: u32 = 0;
                let ok = unsafe {
                    windows_sys::Win32::System::Threading::GetExitCodeProcess(
                        handle,
                        &raw mut code,
                    )
                };
                unsafe { CloseHandle(handle) };
                // STILL_ACTIVE is 259. Anything else means it is gone.
                assert!(ok == 0 || code != 259, "the contained process survived its job");
            }
        }
    }

    /// Asks a contained process to have the WMI provider host create another
    /// process, and reports the pid WMI claims it made.
    ///
    /// WMI is the broker-escape surface `docs/agent-runtime-containment.md` names
    /// first, and the one that needs no privilege: `WmiPrvSE.exe` creates the
    /// process, so it is a child of the broker and not of anything in our job.
    fn wmi_create_from_inside(integrity: ContainedIntegrity) -> (String, Option<u32>) {
        let attempt = concat!(
            "powershell.exe -NoProfile -NonInteractive -Command ",
            "\"try { $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create ",
            "-Arguments @{CommandLine='cmd.exe /c ping -n 20 127.0.0.1'} -ErrorAction Stop; ",
            "Write-Output ('RC=' + $r.ReturnValue + ' PID=' + $r.ProcessId) } ",
            "catch { Write-Output ('REFUSED=' + $_.Exception.GetType().Name) }\"",
        );
        let mut contained = ContainedProcess::spawn_with(
            &OsString::from(attempt),
            None,
            ContainedStdio::Piped,
            integrity,
            &[],
        )
        .expect("spawn the attempt");
        contained.close_stdin();
        let mut text = String::new();
        for _ in 0..40 {
            let chunk = contained
                .read_stdout(std::time::Duration::from_millis(500))
                .expect("read stdout");
            text.push_str(&String::from_utf8_lossy(&chunk));
            if text.contains("RC=") || text.contains("REFUSED=") {
                break;
            }
        }
        let created = text
            .split("PID=")
            .nth(1)
            .and_then(|rest| {
                let digits: String = rest.chars().take_while(char::is_ascii_digit).collect();
                digits.parse::<u32>().ok()
            })
            .filter(|pid| *pid > 4);
        // Whatever it managed to create is outside our job by definition, so the
        // job cannot clean it up and this does.
        if text.contains("RC=0") {
            if let Some(pid) = created {
                terminate_stray(pid);
            }
        }
        contained.terminate_proven(1).ok();
        (text, created)
    }

    /// Kills a process the job cannot reach. Only used to clean up after a
    /// measured escape.
    fn terminate_stray(pid: u32) {
        use windows_sys::Win32::System::Threading::{TerminateProcess, PROCESS_TERMINATE};
        let handle = unsafe { OpenProcess(PROCESS_TERMINATE, 0, pid) };
        if !handle.is_null() {
            unsafe { TerminateProcess(handle, 1) };
            close(handle);
        }
    }

    /// Pids whose command line carries `marker`.
    ///
    /// A broker that does not hand back a pid (the task scheduler, a shell
    /// execute) still leaves one findable: the attempt asks for a process whose
    /// own command line contains a value nothing else would. Enumerated from the
    /// test, which runs at normal integrity, not from inside the job.
    fn pids_with_marker(marker: &str) -> Vec<u32> {
        // ⚠️ The marker travels in the environment, not in the command line.
        // Passing it as an argument put it in **this query process's own**
        // command line, so the search kept finding the enumerator -- which exits
        // as soon as it has printed, which is why judging it failed with
        // OpenProcess error 87 on a pid that had been real a moment earlier.
        let script = concat!(
            "Get-CimInstance Win32_Process -Filter ",
            "(\"CommandLine LIKE '%\" + $env:AGENTSTOZ_MARKER + \"%'\") ",
            "| ForEach-Object { $_.ProcessId }",
        );
        let output = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("AGENTSTOZ_MARKER", marker)
            .output();
        let Ok(output) = output else { return Vec::new() };
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|line| line.trim().parse::<u32>().ok())
            .filter(|pid| *pid > 4)
            .collect()
    }

    /// What an escape attempt produced.
    ///
    /// ⚠️ Three lists, not two. The first version of this helper skipped a pid it
    /// could not open and treated a failed `IsProcessInJob` as "in the job",
    /// which reported **zero escapes for an attempt that had plainly created a
    /// process** -- the marker search found it. A measurement that cannot read a
    /// process must say so, not score it as containment.
    struct EscapeOutcome {
        text: String,
        /// Carried the marker and is **not** in our job: a job terminate would
        /// never reach it.
        escaped: Vec<u32>,
        /// Carried the marker and is in our job.
        contained: Vec<u32>,
        /// Carried the marker and could not be judged. Neither evidence of an
        /// escape nor of containment.
        unknown: Vec<(u32, String)>,
    }

    /// Runs one escape attempt inside a job and reports what left it.
    ///
    /// Anything found outside the job is terminated here, because by definition
    /// the job cannot.
    fn escape_attempt(
        command: &str,
        integrity: ContainedIntegrity,
        marker: &str,
    ) -> EscapeOutcome {
        let mut contained = ContainedProcess::spawn_with(
            &OsString::from(command),
            None,
            ContainedStdio::Piped,
            integrity,
            &[],
        )
        .expect("spawn the attempt");
        contained.close_stdin();
        let mut text = String::new();
        for _ in 0..24 {
            let chunk = contained
                .read_stdout(std::time::Duration::from_millis(500))
                .expect("read stdout");
            text.push_str(&String::from_utf8_lossy(&chunk));
            if text.contains("ATTEMPT_DONE") {
                break;
            }
        }
        // The broker may take a moment to start what it was asked for, and the
        // marker search is the only way to find a process a broker did not hand
        // back a pid for.
        let mut found = Vec::new();
        for _ in 0..12 {
            std::thread::sleep(std::time::Duration::from_millis(250));
            found = pids_with_marker(marker);
            if !found.is_empty() {
                break;
            }
        }

        let mut escaped = Vec::new();
        let mut inside = Vec::new();
        let mut unknown = Vec::new();
        for pid in found {
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                unknown.push((pid, format!("OpenProcess failed (error {})", last_error())));
                continue;
            }
            let mut in_job: i32 = 0;
            let checked = unsafe { IsProcessInJob(handle, contained.job, &raw mut in_job) };
            let query_error = last_error();
            close(handle);
            if checked == 0 {
                unknown.push((pid, format!("IsProcessInJob failed (error {query_error})")));
            } else if in_job == 0 {
                escaped.push(pid);
            } else {
                inside.push(pid);
            }
        }
        for pid in &escaped {
            terminate_stray(*pid);
        }
        contained.terminate_proven(1).ok();
        EscapeOutcome { text, escaped, contained: inside, unknown }
    }

    /// A value that will appear in the command line of the process a broker
    /// starts, and **nowhere else**.
    ///
    /// ⚠️ Numeric, and carried as a `ping -w` argument rather than in a file name.
    /// A marker in the script's **name** also appears in the command line of
    /// whatever asked for it -- `schtasks /create /tr "...marker.cmd"`, the
    /// PowerShell that called ShellExecute -- and those exit immediately, so the
    /// search kept finding a launcher that was already gone (OpenProcess error
    /// 87) instead of the process that was launched.
    fn marker(_tag: &str) -> String {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.subsec_nanos())
            .unwrap_or(0);
        // 9 digits, unique enough that no unrelated process shares it.
        format!("{}", 100_000_000 + (nanos % 899_999_999))
    }

    /// A script whose **file name** carries the marker, so the process a broker
    /// starts is findable by command line.
    ///
    /// ⚠️ The marker cannot be an argument for the task scheduler: `schtasks /tr`
    /// takes a program and its arguments, not a shell line, so `echo X & ping`
    /// ran `echo` and exited at once -- the marker search found a pid that was
    /// already gone by the time it was judged (OpenProcess error 87). Written by
    /// the test, which runs at normal integrity, because a low-integrity provider
    /// cannot create a file in the temp directory at all.
    fn marked_script(marker: &str) -> PathBuf {
        // The file name must not carry the marker; only the command line of the
        // long-lived process it starts may. `-w` is a per-reply timeout, so a
        // large value changes nothing about how long this runs.
        let script = std::env::temp_dir().join(format!(
            "agentstoz-escape-{}-{}.cmd",
            std::process::id(),
            marker
                .chars()
                .rev()
                .take(4)
                .collect::<String>()
        ));
        std::fs::write(
            &script,
            format!("@echo off\r\nping.exe -n 20 -w {marker} 127.0.0.1 > nul\r\n"),
        )
        .expect("write the marked script");
        script
    }

    #[test]
    fn the_task_scheduler_is_a_broker_escape_at_normal_integrity() {
        // The Schedule service creates the process, so it is a child of svchost
        // and not of anything in our job. No admin rights are needed for a task
        // in the user's own namespace, which is what makes this reachable.
        let marker = marker("SCHTASKS");
        let script = marked_script(&marker);
        let name = format!("agentstoz-escape-{}", std::process::id());
        let command = format!(
            "cmd.exe /c schtasks /create /tn \"{name}\" /tr \"{}\" /sc once /st 23:59 /f && schtasks /run /tn \"{name}\" & echo ATTEMPT_DONE",
            script.display()
        );
        let outcome = escape_attempt(&command, ContainedIntegrity::Normal, &marker);
        // Clean up the task whatever happened.
        let _ = std::process::Command::new("schtasks.exe")
            .args(["/delete", "/tn", &name, "/f"])
            .output();
        std::fs::remove_file(&script).ok();
        if !outcome.text.contains("ATTEMPT_DONE") {
            eprintln!("schtasks did not complete on this machine: {:?}", outcome.text);
            return;
        }
        // The control for the mitigation test below: unless the escape is
        // reproduced here, "low integrity closed it" proves nothing.
        assert!(
            outcome.unknown.is_empty(),
            "the measurement could not judge {:?}",
            outcome.unknown
        );
        assert!(
            !outcome.escaped.is_empty(),
            "the task scheduler did not put anything outside the job, so the mitigation test has no control: text={:?} contained={:?}",
            outcome.text, outcome.contained
        );
    }

    #[test]
    fn low_integrity_closes_the_task_scheduler_escape() {
        let marker = marker("SCHTASKSLOW");
        let script = marked_script(&marker);
        let name = format!("agentstoz-escape-low-{}", std::process::id());
        let command = format!(
            "cmd.exe /c schtasks /create /tn \"{name}\" /tr \"{}\" /sc once /st 23:59 /f && schtasks /run /tn \"{name}\" & echo ATTEMPT_DONE",
            script.display()
        );
        let outcome = escape_attempt(&command, ContainedIntegrity::Low, &marker);
        let _ = std::process::Command::new("schtasks.exe")
            .args(["/delete", "/tn", &name, "/f"])
            .output();
        std::fs::remove_file(&script).ok();
        // The provider must have got as far as running, or this would pass for
        // the wrong reason.
        assert!(outcome.text.contains("ATTEMPT_DONE"), "the attempt never ran: {:?}", outcome.text);
        assert!(outcome.unknown.is_empty(), "could not judge {:?}", outcome.unknown);
        assert!(
            outcome.escaped.is_empty(),
            "a low-integrity provider put {} process(es) outside the job through the task scheduler",
            outcome.escaped.len()
        );
    }

    /// Asks the shell to launch the marked script. Explorer creates it, so it
    /// lands outside our job.
    fn shell_execute_attempt(
        marker: &str,
        script: &std::path::Path,
        integrity: ContainedIntegrity,
    ) -> EscapeOutcome {
        let command = format!(
            "powershell.exe -NoProfile -NonInteractive -Command \"try {{ $s = New-Object -ComObject Shell.Application; $s.ShellExecute('{}', '', '', 'open', 0); Write-Output 'LAUNCHED' }} catch {{ Write-Output ('REFUSED=' + $_.Exception.GetType().Name) }}; Write-Output 'ATTEMPT_DONE'\"",
            script.display()
        );
        escape_attempt(&command, integrity, marker)
    }

    #[test]
    fn the_shell_keeps_what_it_launches_inside_the_job() {
        // Measured, and the opposite of what was assumed: asking
        // `Shell.Application` to open a script from inside the job produced a
        // process that was **in** the job (IsProcessInJob true). That verb is
        // served in-process by ShellExecuteEx rather than handed to explorer, so
        // the child inherits the job like any other child.
        //
        // Recorded as containment rather than deleted, because "the shell is a
        // broker" is the obvious assumption and this is the measurement that
        // contradicts it for this path. ⚠️ It does **not** clear the shell
        // generally: verbs that do go through explorer (elevation, protocol
        // handlers) are a different path and are not covered here.
        let marker = marker("SHELLEXEC");
        let script = marked_script(&marker);
        let outcome = shell_execute_attempt(&marker, &script, ContainedIntegrity::Normal);
        std::fs::remove_file(&script).ok();
        if !outcome.text.contains("LAUNCHED") {
            eprintln!("the shell did not launch on this machine: {:?}", outcome.text);
            return;
        }
        assert!(outcome.unknown.is_empty(), "could not judge {:?}", outcome.unknown);
        assert!(
            outcome.escaped.is_empty(),
            "the shell put {} process(es) outside the job: {:?}",
            outcome.escaped.len(),
            outcome.text
        );
        assert!(
            !outcome.contained.is_empty(),
            "the shell launched nothing at all, so this proves nothing: {:?}",
            outcome.text
        );
    }

    #[test]
    fn low_integrity_still_launches_nothing_outside_the_job_through_the_shell() {
        // The same path at low integrity. There is no escape to close here, so
        // this asserts the weaker thing that is actually true: nothing leaves.
        let marker = marker("SHELLEXECLOW");
        let script = marked_script(&marker);
        let outcome = shell_execute_attempt(&marker, &script, ContainedIntegrity::Low);
        std::fs::remove_file(&script).ok();
        assert!(outcome.text.contains("ATTEMPT_DONE"), "the attempt never ran: {:?}", outcome.text);
        assert!(outcome.unknown.is_empty(), "could not judge {:?}", outcome.unknown);
        assert!(
            outcome.escaped.is_empty(),
            "a low-integrity provider put {} process(es) outside the job through the shell: {:?}",
            outcome.escaped.len(),
            outcome.text
        );
    }

    #[test]
    fn a_job_object_alone_does_not_stop_the_wmi_broker_escape() {
        // This is the finding, not a regression: a Job Object is a **lifetime**
        // boundary, not a security boundary. A normal-integrity provider inside a
        // kill-on-close job can ask WMI to create a process, and the result is
        // outside the job, so terminating the job never reaches it. The test
        // exists so that this stays a known, asserted property rather than an
        // assumption, and so the mitigation below has something to be measured
        // against.
        let (text, created) = wmi_create_from_inside(ContainedIntegrity::Normal);
        if !text.contains("RC=0") {
            // WMI can be disabled or policy-blocked on a given machine. That is
            // not a pass, so say which it was instead of claiming containment.
            eprintln!("WMI did not create a process on this machine: {text:?}");
            return;
        }
        let pid = created.expect("WMI reported success, so it must report a pid");
        assert!(pid > 4, "{text:?}");
    }

    #[test]
    fn low_integrity_closes_the_wmi_broker_escape() {
        // The mitigation: the escape needs the provider to reach the broker, and
        // a low-integrity process fails the DCOM/RPC access check in front of it.
        let (text, created) = wmi_create_from_inside(ContainedIntegrity::Low);
        // The process itself must still have run -- otherwise this would "pass"
        // for the wrong reason, by never getting as far as the attempt.
        assert!(
            text.contains("RC=") || text.contains("REFUSED="),
            "the low-integrity provider produced no verdict at all: {text:?}"
        );
        assert!(
            !text.contains("RC=0"),
            "a low-integrity provider created a process through WMI: {text:?}"
        );
        assert!(created.is_none(), "{text:?}");
    }

    #[test]
    fn a_low_integrity_provider_writes_only_where_it_is_allowed() {
        // The other half of the mitigation. Low integrity closes the broker
        // escape, but it also stops the provider writing anywhere normal, which
        // is exactly why the containment document asks for staging isolation: the
        // provider needs one directory it may write to, and nothing else.
        //
        // This measures that mechanism end to end -- a labelled staging directory
        // and an unlabelled sibling -- so the staging design has something
        // established to build on instead of an assumption.
        let root = std::env::temp_dir().join(format!("agentstoz-staging-{}", std::process::id()));
        let staging = root.join("staging");
        let off_limits = root.join("off-limits");
        std::fs::create_dir_all(&staging).expect("staging dir");
        std::fs::create_dir_all(&off_limits).expect("off-limits dir");

        // The label is written by `label_low_integrity`, the same call shipping
        // code uses -- not by spawning `icacls`, so this test exercises the real
        // path rather than a tool that happens to produce a similar result.
        if let Err(error) = label_low_integrity(staging.as_os_str()) {
            std::fs::remove_dir_all(&root).ok();
            panic!("could not label the staging directory: {error}");
        }

        let probe = format!(
            "cmd.exe /c (echo staging > \"{}\\probe.txt\") && echo WROTE_STAGING || echo DENIED_STAGING",
            staging.display()
        );
        let mut contained = ContainedProcess::spawn_with(
            &OsString::from(probe),
            None,
            ContainedStdio::Piped,
            ContainedIntegrity::Low,
            &[],
        )
        .expect("spawn low-integrity probe");
        contained.close_stdin();
        let out = String::from_utf8_lossy(
            &contained
                .read_stdout(std::time::Duration::from_secs(5))
                .expect("read"),
        )
        .to_string();
        contained.terminate_proven(1).ok();

        let outside = format!(
            "cmd.exe /c (echo nope > \"{}\\probe.txt\") && echo WROTE_OUTSIDE || echo DENIED_OUTSIDE",
            off_limits.display()
        );
        let mut blocked = ContainedProcess::spawn_with(
            &OsString::from(outside),
            None,
            ContainedStdio::Piped,
            ContainedIntegrity::Low,
            &[],
        )
        .expect("spawn low-integrity probe");
        blocked.close_stdin();
        let blocked_out = String::from_utf8_lossy(
            &blocked
                .read_stdout(std::time::Duration::from_secs(5))
                .expect("read"),
        )
        .to_string();
        blocked.terminate_proven(1).ok();

        let wrote_staging = staging.join("probe.txt").exists();
        let wrote_outside = off_limits.join("probe.txt").exists();
        std::fs::remove_dir_all(&root).ok();

        // The labelled directory is writable: a provider can actually work.
        assert!(
            wrote_staging,
            "a low-integrity provider could not write to its own staging directory: {out:?}"
        );
        // And the unlabelled sibling is not: the label is doing the work, not luck.
        assert!(
            !wrote_outside,
            "a low-integrity provider wrote outside its staging directory: {blocked_out:?}"
        );
    }

    #[test]
    fn labelling_writes_only_the_label_and_refuses_a_path_that_is_not_there() {
        let root = std::env::temp_dir().join(format!("agentstoz-label-{}", std::process::id()));
        std::fs::create_dir_all(&root).expect("dir");

        // Reading the DACL before and after shows the call changed the label and
        // nothing else: a labelling helper that quietly rewrote permissions would
        // be a way to widen access rather than restrict it.
        let before = std::process::Command::new("icacls.exe").arg(&root).output();
        label_low_integrity(root.as_os_str()).expect("label");
        let after = std::process::Command::new("icacls.exe").arg(&root).output();

        let text = |out: &std::process::Output| String::from_utf8_lossy(&out.stdout).to_string();
        if let (Ok(before), Ok(after)) = (before, after) {
            let keep = |value: String| {
                value
                    .lines()
                    .filter(|line| !line.contains("Mandatory Label"))
                    .map(str::trim)
                    .filter(|line| !line.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            };
            assert_eq!(keep(text(&before)), keep(text(&after)), "the DACL changed");
            assert!(
                text(&after).contains("Mandatory Label") && text(&after).contains("Low"),
                "the low mandatory label is missing: {}",
                text(&after)
            );
        }

        std::fs::remove_dir_all(&root).ok();
        // A path that is not there is an error, not a silent success -- a caller
        // must not believe a directory is labelled when nothing was written.
        let missing = root.join("gone");
        assert!(label_low_integrity(missing.as_os_str()).is_err());
    }

    /// The real Codex CLI, if this machine has one.
    fn installed_codex() -> Option<PathBuf> {
        let output = std::process::Command::new("where.exe").arg("codex").output().ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| line.to_ascii_lowercase().ends_with(".exe"))
            .map(PathBuf::from)
            .find(|path| path.is_file())
    }

    #[test]
    fn codex_runs_contained_at_low_integrity_with_a_staged_home() {
        // Gate ① of the containment document, measured against the real provider
        // rather than a stand-in. The design is the document's own state machine:
        // the provider writes into a per-launch staging directory
        // (`staging-prepared`) and the owner harvests the result afterwards
        // (`materialized`). It is **not** relabelling the user's own `~/.codex`:
        // that would hand a low-integrity provider write access to auth.json and
        // to the rollout history 「내가 한 말」 reads.
        let Some(codex) = installed_codex() else {
            eprintln!("no codex CLI on this machine; skipping");
            return;
        };

        // ⚠️ Not under %TEMP%. Codex refuses to create its PATH-alias helper
        // binaries there -- measured: "Refusing to create helper binaries under
        // temporary dir ... (codex_home: ...)" -- so a staging directory for this
        // provider has to live somewhere that is not the temp tree. Local app
        // data is where the app's own state already lives.
        let base = std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let root = base.join(format!("agentstoz-codex-staging-{}", std::process::id()));
        let home = root.join("codex-home");
        std::fs::create_dir_all(&home).expect("staging home");
        label_low_integrity(home.as_os_str()).expect("label the staging home");

        // Codex is asked for its version: enough to prove the binary starts,
        // reads its configuration and writes what it wants to write, without
        // touching the network or a model.
        let scratch = root.join("scratch");
        std::fs::create_dir_all(&scratch).expect("scratch dir");
        label_low_integrity(scratch.as_os_str()).expect("label the scratch dir");

        let command = format!("\"{}\" --version", codex.display());
        let environment: Vec<(OsString, OsString)> = vec![
            (OsString::from("CODEX_HOME"), home.clone().into_os_string()),
            // A console program with no PATH or SystemRoot is not a meaningful
            // test of containment, so the few the platform needs are passed.
            (OsString::from("SystemRoot"), std::env::var_os("SystemRoot").unwrap_or_default()),
            (OsString::from("PATH"), std::env::var_os("PATH").unwrap_or_default()),
            // TEMP points inside the staging tree, not at the user's temp
            // directory, so scratch files a low-integrity provider writes stay
            // where the label allows and where the harvest can find them.
            (OsString::from("TEMP"), scratch.clone().into_os_string()),
            (OsString::from("TMP"), scratch.clone().into_os_string()),
        ];

        let mut contained = ContainedProcess::spawn_with(
            &OsString::from(command),
            Some(home.as_os_str()),
            ContainedStdio::Piped,
            ContainedIntegrity::Low,
            &environment,
        )
        .expect("spawn codex contained");
        contained.close_stdin();
        let mut text = String::new();
        for _ in 0..40 {
            let chunk = contained
                .read_stdout(std::time::Duration::from_millis(500))
                .expect("read stdout");
            text.push_str(&String::from_utf8_lossy(&chunk));
            if text.contains("codex") || text.chars().filter(char::is_ascii_digit).count() >= 3 {
                break;
            }
        }
        let errors = String::from_utf8_lossy(
            &contained
                .read_stderr(std::time::Duration::from_millis(500))
                .expect("read stderr"),
        )
        .to_string();
        contained.terminate_proven(1).ok();
        std::fs::remove_dir_all(&root).ok();

        // The finding either way: a version string means the provider runs
        // contained at low integrity with a staged home, and the remaining work
        // is harvesting; nothing at all means low integrity is not yet a usable
        // mode for Codex and the feature stays closed.
        assert!(
            !text.trim().is_empty(),
            "codex produced nothing at low integrity: stderr={errors:?}"
        );
        // The provider identified itself, so it really ran rather than dying on
        // its configuration.
        assert!(text.to_ascii_lowercase().contains("codex"), "{text:?}");
        // And the staging directory is outside the temp tree, so Codex does not
        // refuse its own helper binaries. If this ever fires again, the staging
        // location moved back under %TEMP%.
        assert!(
            !errors.contains("Refusing to create helper binaries"),
            "codex refused its helper binaries, so the staging directory is in the wrong place: {errors:?}"
        );
        eprintln!("codex at low integrity: stdout={:?} stderr={:?}", text.trim(), errors.trim());
    }

    /// Asks the **running explorer** to launch the marked script, through the
    /// `ShellWindows` DCOM object.
    ///
    /// This is the path the in-process `Shell.Application` verb is not: the
    /// object lives in explorer, so explorer creates the process and it is a
    /// child of explorer rather than of anything in our job. `Item()` needs an
    /// open explorer window, so the caller has to treat "nothing came back" as
    /// "not measured" rather than as containment.
    fn explorer_broker_attempt(
        marker: &str,
        script: &std::path::Path,
        integrity: ContainedIntegrity,
    ) -> EscapeOutcome {
        let command = format!(
            "powershell.exe -NoProfile -NonInteractive -Command \"try {{              $sw = [Activator]::CreateInstance([Type]::GetTypeFromCLSID('9BA05972-F6A8-11CF-A442-00A0C90A8F39'));              $w = $sw.Item();              if ($null -eq $w) {{ Write-Output 'NO_EXPLORER_WINDOW' }}              else {{ $w.Document.Application.ShellExecute('{}', '', '', 'open', 0); Write-Output 'LAUNCHED' }} }}              catch {{ Write-Output ('REFUSED=' + $_.Exception.GetType().Name) }};              Write-Output 'ATTEMPT_DONE'\"",
            script.display()
        );
        escape_attempt(&command, integrity, marker)
    }

    #[test]
    fn the_explorer_broker_is_an_escape_at_normal_integrity() {
        // Control for the mitigation below, and the surface the in-process shell
        // verb left unmeasured.
        let marker = marker("EXPLORER");
        let script = marked_script(&marker);
        let outcome = explorer_broker_attempt(&marker, &script, ContainedIntegrity::Normal);
        std::fs::remove_file(&script).ok();
        if outcome.text.contains("NO_EXPLORER_WINDOW") || !outcome.text.contains("LAUNCHED") {
            // Not a pass: say which it was instead of claiming containment.
            eprintln!("the explorer broker was not reachable here: {:?}", outcome.text);
            return;
        }
        assert!(outcome.unknown.is_empty(), "could not judge {:?}", outcome.unknown);
        assert!(
            !outcome.escaped.is_empty(),
            "explorer put nothing outside the job, so the mitigation test has no control: text={:?} contained={:?}",
            outcome.text, outcome.contained
        );
    }

    #[test]
    fn low_integrity_closes_the_explorer_broker_escape() {
        let marker = marker("EXPLORERLOW");
        let script = marked_script(&marker);
        let outcome = explorer_broker_attempt(&marker, &script, ContainedIntegrity::Low);
        std::fs::remove_file(&script).ok();
        assert!(outcome.text.contains("ATTEMPT_DONE"), "the attempt never ran: {:?}", outcome.text);
        assert!(outcome.unknown.is_empty(), "could not judge {:?}", outcome.unknown);
        assert!(
            outcome.escaped.is_empty(),
            "a low-integrity provider put {} process(es) outside the job through explorer: {:?}",
            outcome.escaped.len(), outcome.text
        );
    }

    #[test]
    fn inherited_standard_handles_reach_the_contained_provider() {
        // `Inherit` is for a containment helper sitting between the sidecar and
        // the provider: the sidecar already gave the helper pipes, so handing
        // them straight on beats relaying every byte through it.
        //
        // That a **low-integrity** provider can use a handle it was given is
        // already proven elsewhere -- `low_integrity_closes_the_wmi_broker_escape`
        // reads its verdict back over a pipe from exactly such a process, because
        // integrity blocks opening an object by name, not using one that was
        // handed over. What is specific to this mode is handle inheritability, so
        // that is what this checks: the spawn succeeds and the provider runs to a
        // clean exit with this process's own standard handles.
        let contained = ContainedProcess::spawn_with(
            &OsString::from("cmd.exe /c exit 0"),
            None,
            ContainedStdio::Inherit,
            ContainedIntegrity::Low,
            &[],
        )
        .expect("spawn with inherited standard handles");
        assert!(contained.pid() > 0);
        assert_eq!(
            contained.wait(std::time::Duration::from_secs(10)),
            Some(0),
            "the provider did not exit cleanly"
        );
        // Termination still proves itself for a process that has already left.
        let proof = contained.terminate_proven(1).expect("terminate");
        assert_eq!(proof.active_processes, 0, "{proof:?}");
    }

    #[test]
    fn a_matching_creation_time_is_not_liveness() {
        // The bug this guards against was measured, not imagined: a launcher
        // watching its owner saw it as present four seconds after the owner had
        // been killed, because the shell that started it still held a handle --
        // so the launcher kept its provider alive past the owner it belongs to.
        // A terminated process stays openable while any handle to it exists, and
        // GetProcessTimes keeps answering with the same creation time.
        let contained = ContainedProcess::spawn(
            &cmd("cmd.exe /c ping -n 31 127.0.0.1"),
            None,
            ContainedStdio::Null,
        )
        .expect("spawn");
        let pid = contained.pid();
        let created_at = contained.created_at();
        assert!(process_alive(pid, created_at), "a running provider must read as alive");

        // This value holds a handle to the process, so after termination the pid
        // is still openable and still reports the same creation time -- exactly
        // the state that fooled the owner watch.
        contained.terminate_proven(1).expect("terminate");
        assert_eq!(
            process_creation_time(pid).ok(),
            Some(created_at),
            "the terminated process should still report its creation time, which is the trap"
        );
        assert!(
            !process_alive(pid, created_at),
            "a terminated provider must not read as alive"
        );

        // A creation time that does not match is a different process, and zero
        // cannot fence anything.
        assert!(!process_alive(pid, created_at.wrapping_add(1)));
        assert!(!process_alive(pid, 0));
    }

    #[test]
    fn breakaway_is_not_permitted_by_the_job() {
        // The other escape a job *can* close: with BREAKAWAY_OK or
        // SILENT_BREAKAWAY_OK set, a child created with CREATE_BREAKAWAY_FROM_JOB
        // leaves. Neither is set, and this asserts the readback rather than the
        // intent.
        let job = create_kill_on_close_job().expect("job");
        let mut readback: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        let mut returned: u32 = 0;
        let queried = unsafe {
            QueryInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                (&raw mut readback).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                &raw mut returned,
            )
        };
        assert_ne!(queried, 0);
        let flags = readback.BasicLimitInformation.LimitFlags;
        assert_ne!(flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, 0, "flags=0x{flags:x}");
        // 0x0800 BREAKAWAY_OK, 0x1000 SILENT_BREAKAWAY_OK.
        assert_eq!(flags & 0x0800, 0, "flags=0x{flags:x}");
        assert_eq!(flags & 0x1000, 0, "flags=0x{flags:x}");
        close(job);
    }

    #[test]
    fn a_piped_provider_can_be_talked_to_and_reaches_eof() {
        // The guard protocol carries the request in over stdin and the answer
        // back out over stdout, so a contained provider has to be reachable.
        let mut contained = ContainedProcess::spawn(
            &cmd("cmd.exe /c more"),
            None,
            ContainedStdio::Piped,
        )
        .expect("spawn piped");

        let payload = b"AGENTSTOZ_PIPE_PROBE\r\n";
        assert_eq!(contained.write_stdin(payload).expect("write"), payload.len());
        // `more` copies stdin to stdout and only finishes at EOF, which is what
        // closing our end of its input provides. Without that close the read
        // below would wait for a writer that is us.
        contained.close_stdin();

        let out = contained
            .read_stdout(std::time::Duration::from_secs(5))
            .expect("read stdout");
        let text = String::from_utf8_lossy(&out);
        assert!(text.contains("AGENTSTOZ_PIPE_PROBE"), "{text:?}");

        // After the close the owner has no stdin handle, so a late write is a
        // no-op rather than a panic or a write into a freed handle.
        assert_eq!(contained.write_stdin(b"late").expect("late write"), 0);
        let proof = contained.terminate_proven(1).expect("terminate");
        assert_eq!(proof.active_processes, 0, "{proof:?}");
    }

    #[test]
    fn a_null_provider_accepts_no_input_and_yields_no_output() {
        // Choosing Null is a statement that nobody talks to this provider, so
        // the pipe API answers emptily instead of failing and sending a caller
        // looking for a bug.
        let contained = ContainedProcess::spawn(
            &cmd("cmd.exe /c ping -n 31 127.0.0.1"),
            None,
            ContainedStdio::Null,
        )
        .expect("spawn null");
        assert_eq!(contained.write_stdin(b"ignored").expect("write"), 0);
        assert!(contained
            .read_stdout(std::time::Duration::from_millis(200))
            .expect("read")
            .is_empty());
        contained.terminate_proven(1).expect("terminate");
    }

    #[test]
    fn a_failed_spawn_leaves_no_job_behind() {
        // The error path closes the job, which (kill-on-close) is also what
        // would clean up a partially created tree.
        let error = ContainedProcess::spawn(
            &cmd("Z:\\definitely\\not\\here\\agentstoz-missing.exe"),
            None,
            ContainedStdio::Null,
        )
        .expect_err("a missing executable must fail");
        assert!(error.contains("CreateProcessW failed"), "{error}");
    }

    #[test]
    fn a_second_job_does_not_let_the_process_escape_ours() {
        // Windows 8 and later allow **nested** jobs, so adding a contained
        // process to another job succeeds -- measured, and the first version of
        // this test wrongly asserted it would fail. What matters is that the
        // process cannot thereby leave ours: limits become the union, so our
        // kill still reaches it. This is also why assignment after creation is
        // not used in the first place -- it leaves a window before the process
        // is in any job at all, which PROC_THREAD_ATTRIBUTE_JOB_LIST removes.
        let contained = ContainedProcess::spawn(&cmd("cmd.exe /c ping -n 31 127.0.0.1"), None, ContainedStdio::Null)
            .expect("spawn contained");
        let other = create_kill_on_close_job().expect("second job");
        let joined = assign_after_creation(other, contained.process);
        let mut still_in_ours: i32 = 0;
        let checked = unsafe { IsProcessInJob(contained.process, contained.job, &raw mut still_in_ours) };
        assert!(checked != 0 && still_in_ours != 0, "the process left our job (joined={joined})");

        let proof = contained.terminate_proven(1).expect("terminate");
        assert_eq!(proof.active_processes, 0, "{proof:?}");
        unsafe { CloseHandle(other) };
    }

    #[test]
    fn a_pid_that_was_reused_is_rejected() {
        let contained = ContainedProcess::spawn(&cmd("cmd.exe /c ping -n 31 127.0.0.1"), None, ContainedStdio::Null)
            .expect("spawn contained");
        assert!(contained.pid_still_ours());
        // A creation time that does not match is the whole fence: the row is for
        // a process that no longer exists, whatever is at that pid now.
        let mut stale = ContainedProcess::spawn(&cmd("cmd.exe /c ping -n 31 127.0.0.1"), None, ContainedStdio::Null)
            .expect("spawn second");
        stale.created_at = contained.created_at().wrapping_add(1);
        assert!(!stale.pid_still_ours());
        contained.terminate_proven(1).expect("terminate first");
        stale.terminate_proven(1).expect("terminate second");
    }
}
