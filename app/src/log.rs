//! A small log: stderr plus a file in the data folder (replaced on each start), since the tray app
//! has no console. Never write secrets here.

use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

static FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

pub fn to_file(path: &Path) {
    if let Ok(f) = std::fs::File::create(path) {
        *FILE.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }
}

pub fn line(msg: impl std::fmt::Display) {
    let mut t: windows_sys::Win32::Foundation::SYSTEMTIME = unsafe { std::mem::zeroed() };
    unsafe { windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut t) };
    let text = format!("[{:04}-{:02}-{:02} {:02}:{:02}:{:02}] {msg}", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
    eprintln!("{text}");
    if let Some(f) = FILE.lock().unwrap_or_else(|e| e.into_inner()).as_mut() {
        let _ = writeln!(f, "{text}");
    }
}
