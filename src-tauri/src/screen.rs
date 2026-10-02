//! 화면 잠금 감지 & 잠그기 (Windows / macOS / Linux)
//!
//! OS는 사용자가 단축키(Win+L, ⌃⌘Q 등)로 잠그는 순간을 앱이 가로채거나 취소하는 걸
//! 허용하지 않는다. 그래서 2초마다 잠금 상태를 확인해 '잠김/풀림' 변화를 프런트로 보내고,
//! 앱 안의 [화면 잠금] 버튼은 확인을 받은 뒤 직접 잠근다.

use std::{thread, time::Duration};

use tauri::{AppHandle, Emitter, Runtime};

#[derive(Clone, serde::Serialize)]
struct LockEvent {
    locked: bool,
}

pub fn spawn_monitor<R: Runtime>(app: AppHandle<R>) {
    thread::spawn(move || {
        let mut last = is_locked().unwrap_or(false);
        loop {
            thread::sleep(Duration::from_secs(2));
            if let Some(now) = is_locked() {
                if now != last {
                    last = now;
                    let _ = app.emit("screen-lock", LockEvent { locked: now });
                }
            }
        }
    });
}

// ── Windows ────────────────────────────────────────────
#[cfg(target_os = "windows")]
pub fn is_locked() -> Option<bool> {
    use windows_sys::Win32::System::StationsAndDesktops::{CloseDesktop, OpenInputDesktop, SwitchDesktop, DESKTOP_SWITCHDESKTOP};
    unsafe {
        // 잠금 화면(Winlogon 데스크톱)일 때는 입력 데스크톱을 열거나 전환할 수 없다.
        let desk = OpenInputDesktop(0, 0, DESKTOP_SWITCHDESKTOP);
        if desk.is_null() {
            return Some(true);
        }
        let ok = SwitchDesktop(desk);
        CloseDesktop(desk);
        Some(ok == 0)
    }
}

#[cfg(target_os = "windows")]
pub fn lock_now() -> Result<(), String> {
    use windows_sys::Win32::System::Shutdown::LockWorkStation;
    if unsafe { LockWorkStation() } != 0 {
        Ok(())
    } else {
        Err("LockWorkStation 실패".into())
    }
}

// ── macOS ──────────────────────────────────────────────
#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::{c_char, c_void};
    pub type CFTypeRef = *const c_void;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFDictionaryGetValue(dict: CFTypeRef, key: CFTypeRef) -> CFTypeRef;
        pub fn CFStringCreateWithCString(alloc: CFTypeRef, s: *const c_char, encoding: u32) -> CFTypeRef;
        pub fn CFBooleanGetValue(b: CFTypeRef) -> u8;
        pub fn CFGetTypeID(cf: CFTypeRef) -> usize;
        pub fn CFBooleanGetTypeID() -> usize;
        pub fn CFRelease(cf: CFTypeRef);
    }

    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        pub fn CGSessionCopyCurrentDictionary() -> CFTypeRef;
    }

    pub const UTF8: u32 = 0x0800_0100;
}

#[cfg(target_os = "macos")]
pub fn is_locked() -> Option<bool> {
    use mac::*;
    unsafe {
        let dict = CGSessionCopyCurrentDictionary();
        if dict.is_null() {
            return None;
        }
        let key = CFStringCreateWithCString(std::ptr::null(), c"CGSSessionScreenIsLocked".as_ptr(), UTF8);
        let value = CFDictionaryGetValue(dict, key);
        let locked = !value.is_null() && CFGetTypeID(value) == CFBooleanGetTypeID() && CFBooleanGetValue(value) != 0;
        CFRelease(key);
        CFRelease(dict);
        Some(locked)
    }
}

#[cfg(target_os = "macos")]
pub fn lock_now() -> Result<(), String> {
    // 1) 시스템 '화면 잠금'과 같은 동작 (login.framework)
    unsafe {
        let path = c"/System/Library/PrivateFrameworks/login.framework/Versions/Current/login";
        let handle = libc::dlopen(path.as_ptr(), libc::RTLD_LAZY);
        if !handle.is_null() {
            let sym = libc::dlsym(handle, c"SACLockScreenImmediate".as_ptr());
            if !sym.is_null() {
                let f: extern "C" fn() -> i32 = std::mem::transmute(sym);
                f();
                return Ok(());
            }
        }
    }
    // 2) 대체: 디스플레이 잠자기 (암호 즉시 요구 설정 시 잠김)
    std::process::Command::new("pmset")
        .arg("displaysleepnow")
        .status()
        .map_err(|e| e.to_string())
        .map(|_| ())
}

// ── Linux ──────────────────────────────────────────────
#[cfg(target_os = "linux")]
pub fn is_locked() -> Option<bool> {
    let session = std::env::var("XDG_SESSION_ID").unwrap_or_else(|_| "auto".into());
    let out = std::process::Command::new("loginctl")
        .args(["show-session", &session, "-p", "LockedHint", "--value"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim() == "yes")
}

#[cfg(target_os = "linux")]
pub fn lock_now() -> Result<(), String> {
    let ok = std::process::Command::new("loginctl")
        .arg("lock-session")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        return Ok(());
    }
    std::process::Command::new("xdg-screensaver")
        .arg("lock")
        .status()
        .map_err(|e| e.to_string())
        .map(|_| ())
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn is_locked() -> Option<bool> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
pub fn lock_now() -> Result<(), String> {
    Err("지원하지 않는 OS".into())
}
