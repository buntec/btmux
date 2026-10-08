fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "discover_servers",
            "connect_server",
            "start_server",
            "notify",
            "desktop_info",
        ]),
    ))
    .expect("build desktop permissions")
}
