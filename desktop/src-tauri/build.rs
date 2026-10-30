fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "discover_servers",
            "connect_server",
            "start_server",
            "stop_server",
            "switch_server",
            "list_remote_servers",
            "add_remote_server",
            "remove_remote_server",
            "connect_remote_server",
            "notify",
            "desktop_info",
        ]),
    ))
    .expect("build desktop permissions")
}
