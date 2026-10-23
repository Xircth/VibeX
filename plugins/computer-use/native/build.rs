fn main() {
    fingerprint_helper_sources();
}

fn fingerprint_helper_sources() {
    use std::path::{Path, PathBuf};

    fn collect(path: &Path, files: &mut Vec<PathBuf>) {
        if path.is_dir() {
            if let Ok(entries) = std::fs::read_dir(path) {
                for entry in entries.flatten() {
                    collect(&entry.path(), files);
                }
            }
        } else if path.is_file() {
            files.push(path.to_path_buf());
        }
    }

    let mut files = Vec::new();
    for source in ["src/computer", "src/main.rs"] {
        println!("cargo:rerun-if-changed={source}");
        collect(Path::new(source), &mut files);
    }
    files.sort();
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    let mut feed = |bytes: &[u8]| {
        for byte in bytes {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
    };
    for file in &files {
        feed(file.to_string_lossy().replace('\\', "/").as_bytes());
        feed(&[0]);
        feed(&std::fs::read(file).unwrap_or_default());
        feed(&[0]);
    }
    println!("cargo:rustc-env=VIBEX_COMPUTER_SOURCE={hash:016x}");
}
