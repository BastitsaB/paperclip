use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use paperclip_runner_core::durable::{DurableRunnerConfig, DurableStateStore, ProcessedCommand};
use serde_json::json;

static NEXT_TEMPORARY_DIRECTORY: AtomicU64 = AtomicU64::new(0);

fn config(state_dir: PathBuf) -> DurableRunnerConfig {
    DurableRunnerConfig {
        connect_url: "ws://127.0.0.1:3000/api/runner/v1/connect/run_1".to_owned(),
        ca_bundle_path: None,
        state_dir,
        runner_instance_id: "runner_1".to_owned(),
        environment_lease_id: "environment_1".to_owned(),
        run_id: "run_1".to_owned(),
        normalized_session_id: "session_1".to_owned(),
        turn_id: "turn_1".to_owned(),
        item_id: "item_1".to_owned(),
        runner_version: "0.0.0".to_owned(),
        runner_digest: "sha256:test".to_owned(),
        fake_harness_path: None,
        fake_harness_script_path: None,
        max_outbox_bytes: 16_384,
        p0_reserve_bytes: 4_096,
        max_frame_bytes: 65_536,
        reconnect_delay: Duration::from_millis(1),
        reconnect_grace: None,
        max_runtime: Duration::from_secs(1),
        lifecycle_mode: "per_turn".to_owned(),
        idle_timeout: None,
    }
}

fn temporary_directory() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock must follow the Unix epoch")
        .as_nanos();
    let sequence = NEXT_TEMPORARY_DIRECTORY.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "paperclip-runner-public-recovery-{}-{nonce}-{sequence}",
        std::process::id()
    ))
}

#[test]
fn public_store_preserves_the_processed_command_journal_after_recovery() {
    let directory = temporary_directory();
    let config = config(directory.clone());
    let store = DurableStateStore::new(&directory).expect("create private state store");
    let (mut state, existed) = store.load_or_create(&config).expect("create durable state");
    assert!(!existed);

    state.last_controller_command_seq = 1;
    state.processed_commands.insert(
        "command_1".to_owned(),
        ProcessedCommand {
            command_id: "command_1".to_owned(),
            controller_seq: 1,
            command_digest: "sha256:journaled".to_owned(),
            status: "completed".to_owned(),
            logical_effect_count: 1,
            result: json!({"ok": true}),
        },
    );
    store.save(&state).expect("persist processed command");

    let (recovered, existed) = store
        .load_or_create(&config)
        .expect("recover durable state");
    assert!(existed);
    assert_eq!(recovered.last_controller_command_seq, 1);
    assert_eq!(
        recovered.processed_commands["command_1"].result,
        json!({"ok": true})
    );

    fs::remove_dir_all(directory).expect("remove integration-test state");
}

#[test]
fn public_store_preserves_persisted_identity_when_reopened_with_changed_attachment_config() {
    let directory = temporary_directory();
    let initial_config = config(directory.clone());
    let store = DurableStateStore::new(&directory).expect("create private state store");
    let (state, _) = store
        .load_or_create(&initial_config)
        .expect("create durable state");
    store.save(&state).expect("persist durable state");

    let mut conflicting = config(directory.clone());
    conflicting.run_id = "run_2".to_owned();
    let (recovered, existed) = store
        .load_or_create(&conflicting)
        .expect("recover persisted attachment identity");
    assert!(existed);
    assert_eq!(recovered.run_id, "run_1");

    fs::remove_dir_all(directory).expect("remove integration-test state");
}
