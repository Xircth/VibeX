// sqlx::migrate!("./migrations") embeds the migration files at compile time.
// Without this, adding a new .sql file does not rebuild the crate, so a
// running dev backend keeps the old migration set and new columns never get
// created (e.g. collaboration_members.mode_id -> "no such column" surfacing
// as conversation_control_failed when creating a member).
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
