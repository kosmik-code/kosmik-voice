//! Running programs, straight from Windows (no `tasklist`): lets the app notice Discord starting.

use std::collections::HashSet;

/// Discord's stable, PTB, Canary and development builds.
pub const DISCORD_PROGRAMS: [&str; 4] = ["discord.exe", "discordptb.exe", "discordcanary.exe", "discorddevelopment.exe"];

/// Lower-case executable names of every running process.
pub fn list_processes() -> std::io::Result<HashSet<String>> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS};
    let mut names = HashSet::new();
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return Err(std::io::Error::last_os_error());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut ok = Process32FirstW(snap, &mut entry) != 0;
        while ok {
            let w = &entry.szExeFile;
            let end = w.iter().position(|c| *c == 0).unwrap_or(w.len());
            let name = String::from_utf16_lossy(&w[..end]).to_lowercase();
            if !name.is_empty() {
                names.insert(name);
            }
            ok = Process32NextW(snap, &mut entry) != 0;
        }
        CloseHandle(snap);
    }
    Ok(names)
}

pub fn discord_running(running: &HashSet<String>) -> bool {
    DISCORD_PROGRAMS.iter().any(|p| running.contains(*p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_real_process_list_includes_this_program_and_spots_discord_builds() {
        let names = list_processes().unwrap();
        let me = std::env::current_exe().unwrap().file_name().unwrap().to_string_lossy().to_lowercase();
        assert!(names.contains(&me), "{me} not in the list");
        assert!(discord_running(&["discordptb.exe".to_string()].into()));
        assert!(!discord_running(&["obs64.exe".to_string()].into()));
    }
}
