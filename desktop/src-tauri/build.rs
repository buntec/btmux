fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "discover_servers",
            "connect_server",
            "start_server",
            "notify",
        ]),
    ))
    .expect("build desktop permissions")
}
