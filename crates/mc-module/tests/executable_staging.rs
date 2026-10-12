#[path = "support/executable.rs"]
mod executable_staging;

#[test]
fn staged_executable_is_content_named_private_and_reused() {
    use sha2::{Digest, Sha256};
    use std::fs;
    #[cfg(target_os = "macos")]
    use std::path::Path;

    let scratch = tempfile::tempdir().expect("create binary fixture directory");
    #[cfg(not(target_os = "macos"))]
    let first_source = {
        let path = scratch.path().join("ck-mc");
        fs::write(&path, b"first binary contents").unwrap();
        path
    };
    #[cfg(target_os = "macos")]
    let first_source = std::env::current_exe().expect("test executable");

    let first = executable_staging::stage_executable(&first_source, "ckdev-mc", "ck-mc")
        .expect("stage first binary");
    let second = executable_staging::stage_executable(&first_source, "ckdev-mc", "ck-mc")
        .expect("reuse first binary");
    assert_eq!(first, second, "identical bytes reuse the same staged file");
    let first_digest = format!("{:x}", Sha256::digest(fs::read(&first_source).unwrap()));
    assert_eq!(
        first
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        first_digest
    );
    assert!(first.starts_with("/tmp/magic-context-exec"));
    assert!(!first.starts_with(scratch.path()));

    #[cfg(not(target_os = "macos"))]
    let changed_source = {
        let path = scratch.path().join("changed-ck-mc");
        fs::write(&path, b"changed binary contents").unwrap();
        path
    };
    #[cfg(target_os = "macos")]
    let changed_source = Path::new("/bin/ls").to_path_buf();

    let changed = executable_staging::stage_executable(&changed_source, "ckdev-mc", "ck-mc")
        .expect("stage changed binary");
    let changed_digest = format!("{:x}", Sha256::digest(fs::read(&changed_source).unwrap()));
    assert_eq!(
        changed
            .parent()
            .unwrap()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap(),
        changed_digest
    );
    assert_ne!(
        first.parent(),
        changed.parent(),
        "different bytes use a different SHA-256 directory"
    );
    #[cfg(not(target_os = "macos"))]
    assert_eq!(
        fs::read(&changed).unwrap(),
        fs::read(&changed_source).unwrap()
    );

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(first.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(changed.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&first).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&changed).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(first.parent().unwrap().parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
