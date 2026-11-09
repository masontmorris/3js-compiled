use std::{path::Path, process::Command};

#[test]
fn spike_manifests_remain_independent_workspaces() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    for manifest in [
        "spikes/host/Cargo.toml",
        "spikes/host/grafting-servo/Cargo.toml",
    ] {
        let output = Command::new(env!("CARGO"))
            .current_dir(&root)
            .args([
                "metadata",
                "--no-deps",
                "--format-version",
                "1",
                "--manifest-path",
                manifest,
            ])
            .output()
            .expect("run cargo metadata");
        assert!(
            output.status.success(),
            "{manifest}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let metadata: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        let workspace_root = metadata["workspace_root"].as_str().unwrap();
        assert_ne!(
            std::fs::canonicalize(workspace_root).unwrap(),
            std::fs::canonicalize(&root).unwrap()
        );
    }
}
