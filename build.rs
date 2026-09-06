use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=BTMUX_UPDATE_PROTOCOL");
    // Protocol generation must not depend on compiling a frontend that still
    // imports the previous generated contract. rust_embed only needs a folder
    // to exist for this test-only build; the next normal build fills it.
    if std::env::var_os("BTMUX_UPDATE_PROTOCOL").is_some() {
        std::fs::create_dir_all("frontend/dist").expect("create frontend asset directory");
        return;
    }
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
