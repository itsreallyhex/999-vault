// Release builds open no console window behind the app. Debug builds keep
// one, because it is where the Rust side prints the archive root it
// resolved and anything the Python scripts write.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    vault999_lib::run()
}
