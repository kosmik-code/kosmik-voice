fn main() {
    // The editor and overlay pages are built into the program.
    println!("cargo:rerun-if-changed=../public");
    tauri_build::build()
}
