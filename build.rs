use std::process::Command;

fn main() {
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/package.json");

    let status = Command::new("bun")
        .args(["run", "build"])
        .current_dir("frontend")
        .status()
        .expect("failed to run `bun run build` — is bun installed?");

    if !status.success() {
        panic!("`bun run build` failed");
    }
}
