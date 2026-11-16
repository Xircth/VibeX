use super::*;
// The write-behind tests assert against the reader, since "does merging
// change what the user sees" is the only question that matters about it.
use crate::conversation::{ContentBlock, MessageTurn, TurnRole};
use crate::parsers::acp_native::project_turns;

fn temp_root() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "codeg-acp-transcript-test-{}-{:?}",
        std::process::id(),
        std::thread::current().id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn header_line(session: &str) -> String {
    serde_json::to_string(&TranscriptHeader::new(
        "custom:goose",
        session,
        "/repo",
        1_750_000_000_000,
    ))
    .unwrap()
}

fn entry_line(kind: EntryKind, payload: serde_json::Value) -> String {
    serde_json::to_string(&TranscriptEntry {
        t: 1_750_000_000_001,
        k: kind,
        steer: false,
        p: payload,
    })
    .unwrap()
}

#[test]
fn round_trips_header_and_entries() {
    let root = temp_root();
    append_line_in(&root, "goose", "s1", &header_line("s1"));
    append_line_in(
        &root,
        "goose",
        "s1",
        &entry_line(
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"hi"}]),
        ),
    );
    append_line_in(
        &root,
        "goose",
        "s1",
        &entry_line(
            EntryKind::Update,
            serde_json::json!({"sessionUpdate":"agent_message_chunk"}),
        ),
    );

    let t = read_transcript_in(&root, "goose", "s1");
    assert!(!t.is_empty());
    let header = t.header.clone().expect("header parsed");
    assert_eq!(header.agent, "custom:goose");
    assert_eq!(header.cwd, "/repo");
    assert_eq!(t.entries.len(), 2);
    assert_eq!(t.entries[0].k, EntryKind::Prompt);
    assert_eq!(t.entries[1].k, EntryKind::Update);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn skips_malformed_lines_without_losing_the_rest() {
    let root = temp_root();
    append_line_in(&root, "goose", "s2", &header_line("s2"));
    // A truncated write (hard kill mid-append) plus outright garbage.
    append_line_in(&root, "goose", "s2", "{\"t\":123,\"k\":\"pro");
    append_line_in(&root, "goose", "s2", "not json at all");
    append_line_in(
        &root,
        "goose",
        "s2",
        &entry_line(EntryKind::Update, serde_json::json!({"a":1})),
    );

    let t = read_transcript_in(&root, "goose", "s2");
    assert!(t.header.is_some());
    assert_eq!(t.entries.len(), 1, "only the well-formed entry survives");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn missing_file_reads_as_empty() {
    let root = temp_root();
    let t = read_transcript_in(&root, "goose", "never-written");
    assert!(t.header.is_none());
    assert!(t.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn rejects_unsafe_path_components() {
    let root = temp_root();
    assert!(transcript_path_in(&root, "..", "s").is_none());
    assert!(transcript_path_in(&root, "a/b", "s").is_none());
    assert!(transcript_path_in(&root, "goose", "../escape").is_none());
    assert!(transcript_path_in(&root, ".hidden", "s").is_none());
    assert!(transcript_path_in(&root, "goose", "s1").is_some());
    // An unsafe component must not create anything on disk.
    append_line_in(&root, "..", "s", &header_line("s"));
    assert!(read_transcript_in(&root, "..", "s").is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn lists_and_removes_session_transcripts() {
    let root = temp_root();
    append_line_in(&root, "goose", "beta", &header_line("beta"));
    append_line_in(&root, "goose", "alpha", &header_line("alpha"));
    assert_eq!(list_session_ids_in(&root, "goose"), vec!["alpha", "beta"]);

    remove_agent_transcripts_in(&root, "goose").unwrap();
    assert!(list_session_ids_in(&root, "goose").is_empty());
    // Removing a directory that never existed is a no-op, not an error.
    remove_agent_transcripts_in(&root, "goose").unwrap();
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn continuation_chain_reads_as_one_conversation() {
    let root = temp_root();
    // Two restarts: s0 → s1 → s2, each continuing the previous.
    append_line_in(&root, "goose", "s0", &header_line("s0"));
    append_line_in(
        &root,
        "goose",
        "s0",
        &entry_line(
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"first"}]),
        ),
    );
    for (id, prev, text) in [("s1", "s0", "second"), ("s2", "s1", "third")] {
        let header =
            TranscriptHeader::new("custom:goose", id, "/elsewhere", 9_999).continuing(prev);
        append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
        append_line_in(
            &root,
            "goose",
            id,
            &entry_line(
                EntryKind::Prompt,
                serde_json::json!([{"type":"text","text":text}]),
            ),
        );
    }

    let merged = read_chain_in(&root, "goose", "s2");
    assert_eq!(
        merged.entries.len(),
        3,
        "every link contributes its entries"
    );
    let header = merged.header.expect("oldest header survives");
    assert_eq!(header.session_id, "s0", "the root header wins");
    assert_eq!(
        header.cwd, "/repo",
        "start time and cwd come from where the conversation actually began"
    );
    assert_eq!(header.started_at_ms, 1_750_000_000_000);

    // Reading a mid-chain id yields only its own prefix.
    assert_eq!(read_chain_in(&root, "goose", "s1").entries.len(), 2);
    assert_eq!(read_chain_in(&root, "goose", "s0").entries.len(), 1);

    // The superseded links are exactly the ones another transcript continues.
    let superseded = superseded_session_ids_in(&root, "goose");
    assert_eq!(superseded.len(), 2);
    assert!(superseded.contains("s0") && superseded.contains("s1"));
    assert!(!superseded.contains("s2"), "the head is never superseded");
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn continuation_ancestors_lists_what_a_session_carries_forward() {
    // The session-binding guard reads this to tell "same conversation, new
    // agent session" from "an unrelated session landed on this row". Get it
    // wrong in the first direction and every restart of a memory-only
    // custom agent clones the conversation in the sidebar; wrong in the
    // second and the history it was supposed to protect is lost.
    let root = temp_root();
    append_line_in(&root, "goose", "s0", &header_line("s0"));
    for (id, prev) in [("s1", "s0"), ("s2", "s1")] {
        let header =
            TranscriptHeader::new("custom:goose", id, "/elsewhere", 9_999).continuing(prev);
        append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
    }

    assert_eq!(
        continuation_ancestors_in(&root, "goose", "s2"),
        vec!["s1".to_string(), "s0".to_string()],
        "the whole chain, newest first — a bind may skip a link"
    );
    assert_eq!(
        continuation_ancestors_in(&root, "goose", "s1"),
        vec!["s0".to_string()]
    );
    assert!(
        continuation_ancestors_in(&root, "goose", "s0").is_empty(),
        "the root of a chain carries nothing forward"
    );
    assert!(
        continuation_ancestors_in(&root, "goose", "never-recorded").is_empty(),
        "an unknown session carries nothing forward — the caller must then \
         treat a rebind as unrelated and preserve the old history"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn continuation_ancestors_survives_a_cycle() {
    // Same guards as `read_chain_in`: a hand-edited or corrupted pair of
    // headers must not hang the bind path.
    let root = temp_root();
    for (id, prev) in [("a", "b"), ("b", "a")] {
        let header = TranscriptHeader::new("custom:goose", id, "/repo", 1).continuing(prev);
        append_line_in(&root, "goose", id, &serde_json::to_string(&header).unwrap());
    }
    assert_eq!(
        continuation_ancestors_in(&root, "goose", "a"),
        vec!["b".to_string()],
        "the walk stops when it revisits the session it started from"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn continuation_walk_survives_a_cycle_and_a_missing_link() {
    let root = temp_root();
    // A hand-edited file pointing at itself must not hang the reader.
    let looped = TranscriptHeader::new("custom:goose", "loop", "/repo", 1).continuing("loop");
    append_line_in(
        &root,
        "goose",
        "loop",
        &serde_json::to_string(&looped).unwrap(),
    );
    append_line_in(
        &root,
        "goose",
        "loop",
        &entry_line(EntryKind::Update, serde_json::json!({"a":1})),
    );
    assert_eq!(read_chain_in(&root, "goose", "loop").entries.len(), 1);

    // Pointing at a transcript the user deleted degrades to "no prefix",
    // never to an error or an empty result.
    let orphan =
        TranscriptHeader::new("custom:goose", "orphan", "/repo", 2).continuing("deleted");
    append_line_in(
        &root,
        "goose",
        "orphan",
        &serde_json::to_string(&orphan).unwrap(),
    );
    append_line_in(
        &root,
        "goose",
        "orphan",
        &entry_line(EntryKind::Update, serde_json::json!({"b":2})),
    );
    let merged = read_chain_in(&root, "goose", "orphan");
    assert_eq!(merged.entries.len(), 1);
    assert_eq!(
        merged.header.expect("own header stands in").session_id,
        "orphan"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn header_only_read_agrees_with_the_whole_file_parser() {
    let root = temp_root();
    // Normal file: header first, then entries.
    append_line_in(&root, "goose", "h1", &header_line("h1"));
    append_line_in(
        &root,
        "goose",
        "h1",
        &entry_line(EntryKind::Update, serde_json::json!({"a": 1})),
    );
    assert_eq!(
        read_header_in(&root, "goose", "h1"),
        read_transcript_in(&root, "goose", "h1").header
    );

    // A header preceded by junk is still found, exactly as the whole-file
    // parser finds it.
    append_line_in(&root, "goose", "h2", "not json at all");
    append_line_in(&root, "goose", "h2", &header_line("h2"));
    assert_eq!(
        read_header_in(&root, "goose", "h2"),
        read_transcript_in(&root, "goose", "h2").header
    );
    assert!(read_header_in(&root, "goose", "h2").is_some());

    // Headerless and missing files both yield nothing, not an error.
    append_line_in(
        &root,
        "goose",
        "h3",
        &entry_line(EntryKind::Prompt, serde_json::json!([])),
    );
    assert_eq!(read_header_in(&root, "goose", "h3"), None);
    assert_eq!(read_header_in(&root, "goose", "never-written"), None);
    // An unsafe component must not read anything.
    assert_eq!(read_header_in(&root, "..", "h1"), None);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn has_entries_sees_past_the_header_and_stops_at_the_first_entry() {
    let root = temp_root();
    // A session whose ACP header was written but which was closed before
    // the user sent anything: no entries.
    append_line_in(&root, "goose", "e1", &header_line("e1"));
    assert!(!has_entries_in(&root, "goose", "e1"));

    append_line_in(
        &root,
        "goose",
        "e1",
        &entry_line(
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"hi"}]),
        ),
    );
    assert!(has_entries_in(&root, "goose", "e1"));

    // Garbage alone is not an entry, and a missing file is not either.
    append_line_in(&root, "goose", "e2", "not json at all");
    assert!(!has_entries_in(&root, "goose", "e2"));
    assert!(!has_entries_in(&root, "goose", "never-written"));
    assert!(!has_entries_in(&root, "..", "e1"));

    // Agrees with the whole-file parser on every file written above.
    for id in ["e1", "e2", "never-written"] {
        assert_eq!(
            has_entries_in(&root, "goose", id),
            !read_transcript_in(&root, "goose", id).is_empty(),
            "streaming and whole-file emptiness must agree for {id}"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_line_torn_mid_character_costs_only_that_line() {
    // `append_line_in` writes a line with a single `write_all`, so a hard
    // kill can cut it inside a multi-byte character — which is easy to hit
    // with CJK content. That must cost the torn line, not the whole
    // history, and every reader must agree on what survives.
    let root = temp_root();
    let path = transcript_path_in(&root, "goose", "torn").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut raw = Vec::new();
    raw.extend_from_slice(header_line("torn").as_bytes());
    raw.push(b'\n');
    raw.extend_from_slice(
        entry_line(
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"你好"}]),
        )
        .as_bytes(),
    );
    raw.push(b'\n');
    // A prompt line cut in the middle of a 3-byte character.
    let torn = entry_line(
        EntryKind::Prompt,
        serde_json::json!([{"type":"text","text":"世界"}]),
    );
    let cut = torn.find('世').unwrap() + 2;
    raw.extend_from_slice(&torn.as_bytes()[..cut]);
    std::fs::write(&path, &raw).unwrap();

    let transcript = read_transcript_in(&root, "goose", "torn");
    assert!(
        transcript.header.is_some(),
        "the header must survive a torn line later in the file"
    );
    assert_eq!(transcript.entries.len(), 1, "the intact prompt survives");

    // The streaming readers must reach the same conclusions, since they
    // return before ever seeing the torn bytes.
    assert_eq!(read_header_in(&root, "goose", "torn"), transcript.header);
    assert_eq!(
        has_entries_in(&root, "goose", "torn"),
        !transcript.is_empty()
    );

    // The same tear in the FIRST line: no header, and the readers still agree.
    let path2 = transcript_path_in(&root, "goose", "torn2").unwrap();
    let header = header_line("torn2");
    let cut2 = header.find("custom").unwrap() + 3;
    std::fs::write(&path2, &header.as_bytes()[..cut2]).unwrap();
    let t2 = read_transcript_in(&root, "goose", "torn2");
    assert_eq!(read_header_in(&root, "goose", "torn2"), t2.header);
    assert_eq!(has_entries_in(&root, "goose", "torn2"), !t2.is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_corrupt_link_cannot_hide_the_conversation_it_continues() {
    // `superseded_session_ids_in` reads headers only. If it could see a
    // header that the full read does not, it would hide `old` while `new`
    // read as empty — losing both from the listing.
    let root = temp_root();
    let path = transcript_path_in(&root, "goose", "new").unwrap();
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let header = serde_json::to_string(
        &TranscriptHeader::new("custom:goose", "new", "/repo", 1).continuing("old"),
    )
    .unwrap();
    let mut raw = Vec::from(header.as_bytes());
    raw.push(b'\n');
    raw.extend_from_slice(&[0xff, 0xfe, b'\n']);
    std::fs::write(&path, &raw).unwrap();

    append_line_in(&root, "goose", "old", &header_line("old"));
    append_line_in(
        &root,
        "goose",
        "old",
        &entry_line(
            EntryKind::Prompt,
            serde_json::json!([{"type":"text","text":"hi"}]),
        ),
    );

    // `new` is readable despite the garbage line, so `old` is legitimately
    // superseded and its turns are reachable through the chain.
    assert!(superseded_session_ids_in(&root, "goose").contains("old"));
    assert_eq!(read_chain_in(&root, "goose", "new").entries.len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn headers_written_before_continuation_existed_still_parse() {
    // A v1 header from before `continues_from` was added: the field is
    // absent, not null, and must not fail the parse.
    let legacy = r#"{"v":1,"kind":"header","agent":"custom:glm-acp-agent","session_id":"8e73","cwd":"/repo","started_at_ms":1785023133723}"#;
    let parsed = parse_transcript(legacy);
    let header = parsed.header.expect("legacy header parses");
    assert_eq!(header.session_id, "8e73");
    assert_eq!(header.continues_from, None);
}

#[tokio::test]
async fn header_is_written_once_per_session() {
    let root = temp_root();
    let first = TranscriptHeader::new("custom:goose", "s3", "/repo", 1);
    record_header_in(&root, "goose", &first).await.unwrap();

    // A reconnect, and — the case the old filesystem probe could not see —
    // a second attempt racing one that has not been written yet.
    let second = TranscriptHeader::new("custom:goose", "s3", "/other", 2);
    let third = TranscriptHeader::new("custom:goose", "s3", "/elsewhere", 3);
    let (a, b) = (
        record_header_in(&root, "goose", &second),
        record_header_in(&root, "goose", &third),
    );
    a.await.unwrap();
    b.await.unwrap();

    let raw =
        std::fs::read_to_string(transcript_path_in(&root, "goose", "s3").unwrap()).unwrap();
    assert_eq!(
        raw.lines()
            .filter(|l| parse_header_line(l).is_some())
            .count(),
        1,
        "exactly one header, no matter how many reconnects raced"
    );
    assert_eq!(
        read_transcript_in(&root, "goose", "s3").header.unwrap().cwd,
        "/repo",
        "a reconnect must not overwrite the original header"
    );
    let _ = std::fs::remove_dir_all(&root);
}

// ---- write-behind ----------------------------------------------------
//
// The invariant every one of these defends: whatever `compact_batch`
// writes, `project_turns` must read back as though nothing had been
// merged. Cases 1 and 3 are the two paths where an earlier design of this
// silently shifted a turn's timing.

/// Run a script of records through the writer's batching and return what
/// the reader would make of the file, both ways.
fn projected_both_ways(
    records: Vec<PendingRecord>,
    batches: &[usize],
) -> (Vec<MessageTurn>, Vec<MessageTurn>) {
    let verbatim: Vec<TranscriptEntry> = records
        .iter()
        .filter_map(|r| match r {
            PendingRecord::Entry(e) => Some(e.clone()),
            PendingRecord::Header(_) | PendingRecord::Flush | PendingRecord::Replace(_) => None,
        })
        .collect();

    // Serialize through `compact_batch` exactly as the writer does, split
    // across flush windows at the given boundaries.
    let mut compactable = false;
    let mut written = String::new();
    let mut rest: Vec<Queued> = records.into_iter().map(queued).collect();
    let mut cuts: Vec<usize> = batches.to_vec();
    cuts.push(usize::MAX);
    for cut in cuts {
        if rest.is_empty() {
            break;
        }
        let take = cut.min(rest.len());
        let batch: Vec<Queued> = rest.drain(..take).collect();
        let (lines, next) = compact_batch(&batch, compactable);
        compactable = next;
        written.push_str(&lines);
    }
    let compacted = parse_transcript(&written).entries;
    (project_turns(&verbatim), project_turns(&compacted))
}

/// A record as the writer holds it. The tests exercise `compact_batch`,
/// which never touches the ack or the gate guard, so both are inert here.
fn queued(record: PendingRecord) -> Queued {
    Queued {
        record,
        ack: tokio::sync::oneshot::channel().0,
        _prompt_guard: None,
    }
}

fn chunk(t: u64, kind: &str, text: &str) -> PendingRecord {
    PendingRecord::Entry(TranscriptEntry {
        t,
        k: EntryKind::Update,
        steer: false,
        p: serde_json::json!({
            "sessionUpdate": kind,
            "content": { "type": "text", "text": text }
        }),
    })
}

fn prompt_record(t: u64, text: &str) -> PendingRecord {
    PendingRecord::Entry(TranscriptEntry {
        t,
        k: EntryKind::Prompt,
        steer: false,
        p: serde_json::json!([{ "type": "text", "text": text }]),
    })
}

fn turn_end(t: u64) -> PendingRecord {
    PendingRecord::Entry(TranscriptEntry {
        t,
        k: EntryKind::TurnEnd,
        steer: false,
        p: serde_json::json!({ "stopReason": "end_turn" }),
    })
}

/// Compared as serialized turns rather than field by field: the claim being
/// defended is that NOTHING the frontend receives changes, so leaving a
/// field out of the comparison would be leaving a hole in the claim.
fn assert_same_projection(records: Vec<PendingRecord>, batches: &[usize], what: &str) {
    let (verbatim, compacted) = projected_both_ways(records, batches);
    assert_eq!(
        serde_json::to_value(&verbatim).unwrap(),
        serde_json::to_value(&compacted).unwrap(),
        "merging changed the projection: {what}"
    );
}

#[test]
fn merging_streamed_text_leaves_the_projection_identical() {
    let tool = |t: u64, id: &str, status: &str| {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": "tool_call", "toolCallId": id,
                "title": "Bash", "kind": "execute", "status": status
            }),
        })
    };
    let image = |t: u64| {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "image", "data": "AAA", "mimeType": "image/png"}
            }),
        })
    };
    let link = |t: u64| {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "resource_link", "uri": "file:///a", "name": "a"}
            }),
        })
    };

    assert_same_projection(vec![prompt_record(1, "hi"), turn_end(9)], &[], "empty turn");
    assert_same_projection(
        vec![
            prompt_record(1, "hi"),
            chunk(2, "agent_message_chunk", "he"),
            chunk(3, "agent_message_chunk", "ll"),
            chunk(4, "agent_message_chunk", "o"),
            turn_end(9),
        ],
        &[],
        "plain streamed text",
    );
    assert_same_projection(
        vec![
            prompt_record(1, "hi"),
            chunk(2, "agent_thought_chunk", "let me "),
            chunk(3, "agent_thought_chunk", "think"),
            chunk(4, "agent_message_chunk", "a"),
            tool(5, "c1", "pending"),
            chunk(6, "agent_message_chunk", "b"),
            chunk(7, "agent_message_chunk", "c"),
            turn_end(9),
        ],
        &[],
        "text and tools interleaved (a tool ends a run)",
    );
    assert_same_projection(
        vec![
            prompt_record(1, "hi"),
            chunk(2, "agent_message_chunk", "a"),
            image(3),
            chunk(4, "agent_message_chunk", "b"),
            link(5),
            chunk(6, "agent_message_chunk", "c"),
            turn_end(9),
        ],
        &[],
        "image and resource-link chunks are never folded into text",
    );
    // Split across flush windows at every boundary: a run cut in half must
    // still read back as one block with the same end time.
    for cut in 1..=6 {
        assert_same_projection(
            vec![
                prompt_record(1, "hi"),
                chunk(2, "agent_message_chunk", "a"),
                chunk(3, "agent_message_chunk", "b"),
                chunk(4, "agent_message_chunk", "c"),
                chunk(5, "agent_message_chunk", "d"),
                turn_end(9),
            ],
            &[cut],
            "run split across flush windows",
        );
    }
    assert_same_projection(
        vec![
            prompt_record(1, "one"),
            chunk(2, "agent_message_chunk", "a"),
            turn_end(3),
            prompt_record(4, "two"),
            chunk(5, "agent_message_chunk", "b"),
            turn_end(6),
        ],
        &[3],
        "consecutive turns",
    );
}

/// The path that broke an earlier design of this: a `user_message_chunk`
/// arriving mid-turn flushes the assistant turn BEFORE any `TurnEnd`, so
/// that turn's end time can only come from its last chunk. Taking the first
/// chunk's timestamp instead silently compressed the reported duration.
#[test]
fn a_turn_flushed_by_a_mid_turn_user_chunk_keeps_its_end_time() {
    let records = vec![
        prompt_record(1_000, "hi"),
        chunk(1_100, "agent_message_chunk", "wor"),
        chunk(1_900, "agent_message_chunk", "king"),
        chunk(2_500, "user_message_chunk", "wait"),
        turn_end(3_000),
    ];
    assert_same_projection(records, &[], "mid-turn user chunk");

    // And pin the value itself, so "identical to verbatim" cannot become
    // "identically wrong".
    let (verbatim, _) = projected_both_ways(
        vec![
            prompt_record(1_000, "hi"),
            chunk(1_100, "agent_message_chunk", "wor"),
            chunk(1_900, "agent_message_chunk", "king"),
            chunk(2_500, "user_message_chunk", "wait"),
            turn_end(3_000),
        ],
        &[],
    );
    let assistant = verbatim
        .iter()
        .find(|t| matches!(t.role, TurnRole::Assistant))
        .expect("assistant turn");
    assert_eq!(assistant.duration_ms, Some(900), "1_900 - 1_000");
}

/// `user_message_chunk` is excluded from merging because its first and last
/// timestamps mean different things: the first fixes the user turn's own
/// timestamp, the last fixes where the NEXT assistant turn starts. One
/// merged record cannot carry both.
#[test]
fn consecutive_user_chunks_keep_both_of_their_timestamps() {
    let records = vec![
        prompt_record(1_000, "hi"),
        chunk(1_100, "agent_message_chunk", "a"),
        chunk(2_000, "user_message_chunk", "one "),
        chunk(2_100, "user_message_chunk", "two "),
        chunk(2_200, "user_message_chunk", "three"),
        chunk(2_400, "agent_message_chunk", "b"),
        turn_end(3_000),
    ];
    assert_same_projection(records, &[], "consecutive user chunks");
}

/// A `session/load` replay has no prompts and no turn ends, so it is never
/// compactable and must land byte-for-byte. (It is already merged — the
/// replay of a 32-record turn is one record — so there is nothing to gain.)
#[test]
fn a_replay_is_recorded_verbatim() {
    let records = vec![
        chunk(1, "user_message_chunk", "hello"),
        chunk(2, "agent_message_chunk", "hi"),
        chunk(3, "agent_message_chunk", " there"),
        chunk(4, "user_message_chunk", "more"),
        chunk(5, "agent_message_chunk", "ok"),
    ];
    let pending: Vec<Queued> = records
        .iter()
        .map(|r| match r {
            PendingRecord::Entry(e) => queued(PendingRecord::Entry(e.clone())),
            PendingRecord::Header(_) | PendingRecord::Flush | PendingRecord::Replace(_) => {
                unreachable!()
            }
        })
        .collect();
    let (lines, compactable) = compact_batch(&pending, false);
    assert!(!compactable, "a replay never turns compaction on");
    assert_eq!(
        parse_transcript(&lines).entries.len(),
        5,
        "every replayed record survives"
    );
    assert_same_projection(records, &[], "replay");
}

/// A turn the agent runs on its own between prompts (issue #903) has no
/// prompt to fix its start, so it starts at its FIRST chunk — and must land
/// unmerged like a replay: a merged record carries the run's last
/// timestamp, which would start the turn where it ended.
#[test]
fn a_turn_the_agent_runs_between_prompts_keeps_its_start_time() {
    let records = || {
        vec![
            prompt_record(1_000, "start the job"),
            chunk(1_100, "agent_message_chunk", "Started."),
            turn_end(1_200),
            chunk(5_000, "agent_message_chunk", "The job "),
            chunk(5_400, "agent_message_chunk", "finished."),
            prompt_record(9_000, "thanks"),
            chunk(9_100, "agent_message_chunk", "Welcome."),
            turn_end(9_200),
        ]
    };
    // All in one flush window: the batch a merge could reach.
    assert_same_projection(records(), &[], "a turn of the agent's own");

    let (verbatim, _) = projected_both_ways(records(), &[]);
    let own = &verbatim[2];
    assert!(matches!(own.role, TurnRole::Assistant));
    assert_eq!(own.timestamp.timestamp_millis(), 5_000);
    assert_eq!(own.duration_ms, Some(400));
}

/// Chunks carrying different `_meta` are opaque extension data; merging
/// them would silently keep one and discard the rest.
#[test]
fn chunks_with_differing_meta_are_not_merged() {
    let with_meta = |t: u64, meta: serde_json::Value| {
        PendingRecord::Entry(TranscriptEntry {
            t,
            k: EntryKind::Update,
            steer: false,
            p: serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "x"},
                "_meta": meta
            }),
        })
    };
    let pending: Vec<Queued> = vec![
        prompt_record(1, "hi"),
        with_meta(2, serde_json::json!({"a": 1})),
        with_meta(3, serde_json::json!({"a": 1})),
        with_meta(4, serde_json::json!({"a": 2})),
    ]
    .into_iter()
    .map(queued)
    .collect();
    let (lines, _) = compact_batch(&pending, false);
    let entries = parse_transcript(&lines).entries;
    assert_eq!(
        entries.len(),
        3,
        "prompt + the merged equal-meta pair + the differing one"
    );
    assert_eq!(entries[1].p["_meta"], serde_json::json!({"a": 1}));
    assert_eq!(entries[2].p["_meta"], serde_json::json!({"a": 2}));
}

/// The frontend refetches conversation detail the moment a turn completes,
/// so everything buffered during the turn has to be on disk by the time the
/// turn end's ack resolves — that ack is exactly what `record_turn_end`
/// bound-waits on. This drives the real writer end to end: fire-and-forget
/// chunks, one awaited boundary, then read it back.
#[tokio::test]
async fn a_completed_turn_is_whole_as_soon_as_its_turn_end_lands() {
    let root = temp_root();
    record_header_in(
        &root,
        "goose",
        &TranscriptHeader::new("custom:goose", "turn", "/repo", 1),
    )
    .await
    .unwrap();
    record_entry_in(
        &root,
        "goose",
        "turn",
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "hi" }]),
    )
    .await
    .unwrap();
    // Streamed chunks are fire-and-forget, exactly as the live path records
    // them — the read loop must never wait on the disk.
    let mut expected = String::new();
    for i in 0..50 {
        let word = format!("w{i} ");
        expected.push_str(&word);
        drop(record_entry_in(
            &root,
            "goose",
            "turn",
            EntryKind::Update,
            serde_json::json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "type": "text", "text": word }
            }),
        ));
    }
    record_entry_in(
        &root,
        "goose",
        "turn",
        EntryKind::TurnEnd,
        serde_json::json!({ "stopReason": "end_turn" }),
    )
    .await
    .unwrap();

    let path = transcript_path_in(&root, "goose", "turn").unwrap();
    let written = std::fs::read_to_string(&path).unwrap();
    assert!(
        written.lines().count() <= 4,
        "50 chunks should have been merged, not written one per line; got:\n{written}"
    );

    let turns = project_turns(&read_transcript_in(&root, "goose", "turn").entries);
    assert_eq!(turns.len(), 2, "one user turn and one assistant turn");
    match &turns[1].blocks[0] {
        ContentBlock::Text { text } => {
            assert_eq!(*text, expected, "no chunk was lost to the merge")
        }
        other => panic!("expected text, got {other:?}"),
    }
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn flush_and_replace_operate_synchronously_through_the_writer_thread() {
    let root = temp_root();
    record_header_in(
        &root,
        "goose",
        &TranscriptHeader::new("custom:goose", "flush-test", "/repo", 1),
    )
    .await
    .unwrap();
    record_entry_in(
        &root,
        "goose",
        "flush-test",
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "hi" }]),
    )
    .await
    .unwrap();
    drop(record_entry_in(
        &root,
        "goose",
        "flush-test",
        EntryKind::Update,
        serde_json::json!({
            "sessionUpdate": "agent_message_chunk",
            "content": { "type": "text", "text": "in-flight reply" }
        }),
    ));
    flush_in(&root, "goose", "flush-test").await.unwrap();
    let turns = project_turns(&read_transcript_in(&root, "goose", "flush-test").entries);
    assert_eq!(
        turns.len(),
        2,
        "flush_in writes buffered in-flight chunks immediately"
    );

    let replacement = format!(
        "{}\n{}\n",
        header_line("flush-test"),
        entry_line(
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": "truncated" }])
        )
    );
    replace_in(&root, "goose", "flush-test", replacement)
        .await
        .unwrap();
    let after_replace =
        project_turns(&read_transcript_in(&root, "goose", "flush-test").entries);
    assert_eq!(after_replace.len(), 1);
    let _ = std::fs::remove_dir_all(&root);
}

/// A write that cannot even begin must cost nothing: the batch and its acks
/// stay pending, the retry writes them in order, and no caller is told a
/// record landed when it did not.
#[tokio::test]
async fn records_survive_a_failing_writer_and_land_in_order_once_it_recovers() {
    let root = temp_root();
    // Block the agent's directory with a regular file, so `create_dir_all`
    // — the first thing a flush does — fails.
    std::fs::write(root.join("goose"), b"in the way").unwrap();

    let mut acks = Vec::new();
    for i in 0..4 {
        acks.push(record_entry_in(
            &root,
            "goose",
            "wedged",
            EntryKind::Prompt,
            serde_json::json!([{ "type": "text", "text": format!("p{i}") }]),
        ));
    }
    // Nothing may be acked while the writes cannot happen.
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    for ack in &mut acks {
        assert!(
            ack.try_recv().is_err(),
            "a record still buffered must not report as landed"
        );
    }

    std::fs::remove_file(root.join("goose")).unwrap();
    for ack in acks {
        tokio::time::timeout(std::time::Duration::from_secs(10), ack)
            .await
            .expect("retry happens within a few flush windows")
            .expect("and reports success");
    }

    let entries = read_transcript_in(&root, "goose", "wedged").entries;
    assert_eq!(
        entries.len(),
        4,
        "every buffered record landed exactly once"
    );
    for (i, entry) in entries.iter().enumerate() {
        assert_eq!(
            entry.p[0]["text"],
            format!("p{i}"),
            "and in the order they were recorded"
        );
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// The replay gate must not depend on how fast the disk is.
///
/// A prompt that is queued but not yet written is invisible to the FILE, so
/// a gate reading only the file would decide this conversation has no
/// transcript, record the agent's `session/load` replay, and leave two
/// copies of the same history — permanently, since the gate reads non-empty
/// forever after. Awaiting the ack shrinks that window but cannot close it,
/// because the wait is bounded so a wedged disk can never hang a turn.
///
/// The writer is held up here by occupying its directory with a regular
/// file, so every flush fails at `create_dir_all`. That stands in for the
/// real causes (a slow disk, a queue backed up behind another session) and
/// makes a microseconds-wide window deterministic.
#[tokio::test]
async fn the_replay_gate_counts_a_queued_prompt_as_history() {
    let root = temp_root();
    std::fs::write(root.join("goose"), b"in the way").unwrap();

    assert!(
        !has_recorded_history_in(&root, "goose", "race"),
        "nothing recorded yet, so a replay would be this conversation's \
         only history and must be allowed"
    );

    let ack = record_entry_in(
        &root,
        "goose",
        "race",
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "hi" }]),
    );
    tokio::time::sleep(std::time::Duration::from_millis(150)).await;
    assert!(
        !has_entries_in(&root, "goose", "race"),
        "the file really is still empty — this is the window the gate has \
         to survive, not a hypothetical"
    );
    assert!(
        has_recorded_history_in(&root, "goose", "race"),
        "and the gate must refuse the replay anyway: this prompt is going \
         to land, and a replay recorded now would duplicate it"
    );

    std::fs::remove_file(root.join("goose")).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), ack)
        .await
        .expect("the retry lands within a few flush windows")
        .expect("and reports success");
    assert!(
        has_entries_in(&root, "goose", "race"),
        "the prompt is now in the file"
    );
    assert!(
        has_recorded_history_in(&root, "goose", "race"),
        "and the gate still says so once the guard is gone"
    );
    let _ = std::fs::remove_dir_all(&root);
}

/// A prompt that can never land must not block the session forever.
///
/// The gate is conservative while a prompt is in flight, so a count leaked
/// on any of the paths where a record is discarded would permanently deny
/// that session a replay it may genuinely need. The count is held by an
/// RAII guard precisely so every such path releases it.
#[tokio::test]
async fn a_discarded_prompt_stops_counting_as_history() {
    let root = temp_root();
    let path = transcript_path_in(&root, "goose", "dropped").unwrap();
    // Never enqueued anywhere: taking and dropping the guard is exactly
    // what the discard paths do.
    {
        let _guard = PendingPromptGuard::new(&path);
        assert!(has_recorded_history_in(&root, "goose", "dropped"));
    }
    assert!(
        !has_recorded_history_in(&root, "goose", "dropped"),
        "a record that will never land must release its claim"
    );

    // Nested guards for one session unwind independently.
    {
        let _a = PendingPromptGuard::new(&path);
        {
            let _b = PendingPromptGuard::new(&path);
        }
        assert!(
            has_recorded_history_in(&root, "goose", "dropped"),
            "one prompt still outstanding"
        );
    }
    assert!(!has_recorded_history_in(&root, "goose", "dropped"));
    let _ = std::fs::remove_dir_all(&root);
}

/// The gate that keeps a `session/load` replay from appending a second copy
/// of history codeg already has. It reads the file, so a prompt sitting in
/// the writer's buffer would make it answer "empty" and let the replay in.
#[tokio::test]
async fn a_continuation_link_is_readable_as_soon_as_its_ack_resolves() {
    // The session-binding guard reads the chain from disk to decide whether
    // a new agent session continues an existing conversation or is
    // unrelated. Headers are written by a background thread, so the
    // recovery path AWAITS this ack before emitting `SessionStarted` —
    // otherwise a subscriber can read an empty chain, call the sessions
    // unrelated, and split the conversation into a duplicate row that
    // nothing ever removes.
    //
    // This pins the half that makes that await meaningful: once the ack
    // resolves, the link IS visible to the reader.
    let root = temp_root();
    record_header_in(
        &root,
        "goose",
        &TranscriptHeader::new("custom:goose", "s0", "/repo", 1),
    )
    .await
    .unwrap();
    record_header_in(
        &root,
        "goose",
        &TranscriptHeader::new("custom:goose", "s1", "/repo", 2).continuing("s0"),
    )
    .await
    .unwrap();

    assert_eq!(
        continuation_ancestors_in(&root, "goose", "s1"),
        vec!["s0".to_string()],
        "an acked continuation header must be readable immediately"
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test]
async fn a_prompt_is_on_disk_before_its_ack_resolves() {
    let root = temp_root();
    record_header_in(
        &root,
        "goose",
        &TranscriptHeader::new("custom:goose", "gate", "/repo", 1),
    )
    .await
    .unwrap();
    assert!(
        !has_entries_in(&root, "goose", "gate"),
        "a header alone is not history"
    );

    record_entry_in(
        &root,
        "goose",
        "gate",
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "hi" }]),
    )
    .await
    .unwrap();
    assert!(
        has_entries_in(&root, "goose", "gate"),
        "a sent prompt must be visible to the replay gate immediately"
    );
    let _ = std::fs::remove_dir_all(&root);
}


#[tokio::test]
async fn online_jsonl_writes_are_disabled_by_default_while_preserving_replay_gate() {
    if legacy_jsonl_shadow_write_enabled() {
        return;
    }
    let sid = format!("offline-default-{}", uuid::Uuid::new_v4().simple());
    let header = TranscriptHeader::new("custom:goose", &sid, "/repo", 42);

    record_header("goose", &header).await.unwrap();
    let root = dimo_acp_transcripts_root();
    let path = transcript_path_in(&root, "goose", &sid).unwrap();
    assert!(
        !path.exists(),
        "online record_header must not create a JSONL file when shadow write is off"
    );

    assert!(
        claim_replay_for_session(None, "goose", &sid, &header).await,
        "first replay claim for an unrecorded session succeeds in memory"
    );
    assert!(
        !claim_replay_for_session(None, "goose", &sid, &header).await,
        "concurrent/duplicate replay claim must be rejected"
    );

    release_unrecorded_replay_for_session(None, "goose", &sid).await;
    assert!(
        claim_replay_for_session(None, "goose", &sid, &header).await,
        "releasing an unrecorded failed load allows retry"
    );
    release_unrecorded_replay_for_session(None, "goose", &sid).await;

    record_entry(
        "goose",
        &sid,
        EntryKind::Prompt,
        serde_json::json!([{ "type": "text", "text": "hello" }]),
    )
    .await
    .unwrap();
    assert!(
        !path.exists(),
        "online record_entry must not touch disk when shadow write is off"
    );
    assert!(
        has_recorded_history("goose", &sid),
        "in-memory replay gate records live session history without disk JSONL"
    );
    assert!(
        !claim_replay_for_session(None, "goose", &sid, &header).await,
        "replay gate blocks session/load duplicate replay once live history exists"
    );
}

#[tokio::test]
async fn sqlite_recorded_history_probe_blocks_replay_across_restarts() {
    let cid = uuid::Uuid::new_v4();
    let sid = format!("sqlite-probe-{}", cid.simple());
    let header = TranscriptHeader::new("codex", &sid, "/repo", 100);

    let expected_cid = cid;
    register_recorded_history_probe(std::sync::Arc::new(move |conv_id, _dir, _session_id| {
        Box::pin(async move { conv_id == Some(expected_cid) })
    }));

    assert!(
        has_recorded_history_for_session(Some(cid), "codex", &sid).await,
        "SQLite probe reports authoritative recorded history"
    );
    assert!(
        !claim_replay_for_session(Some(cid), "codex", &sid, &header).await,
        "session/load replay claim must be rejected when SQLite already holds turns/events"
    );
}
