//! `localStorage` persisted to one JSON file per game. A writer thread owns the stored map, takes each change the
//! page makes, and rewrites the file at most every 100 ms, so a change costs the game thread one channel send.

use anyhow::{Context, Result};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    thread::JoinHandle,
    time::{Duration, Instant},
};

const WRITE_INTERVAL: Duration = Duration::from_millis(100);

pub enum Change {
    Set(String, String),
    Remove(String),
    Clear,
}

pub struct Store {
    changes: Option<Sender<Change>>,
    writer: Option<JoinHandle<()>>,
}

/// The default `localStorage` file for the game whose entry module is `entry`:
/// `<local app data>/threejsc/<folder>-<hash>/localStorage.json`, where `<folder>` is the name of the entry's
/// folder and `<hash>` is 16 hex digits of FNV-1a over its absolute path, lowercased with forward slashes. Two games
/// built to folders of the same name get different files, and a rebuild in place keeps its file.
pub fn default_path(entry: &Path, local_app_data: &Path) -> PathBuf {
    let absolute = std::path::absolute(entry).unwrap_or_else(|_| entry.to_owned());
    let key = absolute.to_string_lossy().replace('\\', "/").to_lowercase();
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    });
    let folder: String = absolute
        .parent()
        .and_then(Path::file_name)
        .map_or_else(|| "game".into(), |name| name.to_string_lossy().into_owned())
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    local_app_data
        .join("threejsc")
        .join(format!("{folder}-{hash:016x}"))
        .join("localStorage.json")
}

/// Reads a store file, which holds one JSON object of string values.
pub fn read(path: &Path) -> Result<BTreeMap<String, String>> {
    match std::fs::read(path) {
        Ok(bytes) => {
            serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

/// Replaces the file in one rename, so a crash leaves the old contents or the new ones.
fn write(path: &Path, entries: &BTreeMap<String, String>) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let partial = path.with_extension("json.partial");
    std::fs::write(&partial, serde_json::to_vec(entries)?)?;
    std::fs::rename(&partial, path)?;
    Ok(())
}

fn apply(entries: &mut BTreeMap<String, String>, change: Change) {
    match change {
        Change::Set(key, value) => {
            entries.insert(key, value);
        }
        Change::Remove(key) => {
            entries.remove(&key);
        }
        Change::Clear => entries.clear(),
    }
}

fn run(
    path: &Path,
    mut entries: BTreeMap<String, String>,
    changes: &Receiver<Change>,
    log: &dyn Fn(String),
) {
    let mut last_write = Instant::now() - WRITE_INTERVAL;
    loop {
        let Ok(change) = changes.recv() else { return };
        apply(&mut entries, change);
        // Gathers the changes that arrive before the next write is due, and the rest of a closed channel's.
        let mut open = true;
        loop {
            let wait = (last_write + WRITE_INTERVAL).saturating_duration_since(Instant::now());
            match changes.recv_timeout(wait) {
                Ok(change) => apply(&mut entries, change),
                Err(RecvTimeoutError::Timeout) => break,
                Err(RecvTimeoutError::Disconnected) => {
                    open = false;
                    break;
                }
            }
        }
        if let Err(error) = write(path, &entries) {
            log(format!(
                "localStorage: could not write {}: {error:#}",
                path.display()
            ));
        }
        last_write = Instant::now();
        if !open {
            return;
        }
    }
}

impl Store {
    /// Opens the store at `path` and returns it with its entries. A file that cannot be read or parsed is logged
    /// and gives an empty store, which replaces it on the first change.
    pub fn open(
        path: PathBuf,
        log: impl Fn(String) + Send + 'static,
    ) -> Result<(Self, BTreeMap<String, String>)> {
        let entries = read(&path).unwrap_or_else(|error| {
            log(format!("localStorage: starting empty: {error:#}"));
            BTreeMap::new()
        });
        let (changes, received) = mpsc::channel();
        let initial = entries.clone();
        let writer = std::thread::Builder::new()
            .name("storage".into())
            .spawn(move || run(&path, initial, &received, &log))?;
        Ok((
            Self {
                changes: Some(changes),
                writer: Some(writer),
            },
            entries,
        ))
    }

    pub fn change(&self, change: Change) {
        if let Some(changes) = &self.changes {
            let _ = changes.send(change);
        }
    }
}

impl Drop for Store {
    /// Writes the last changes and waits for the writer to finish.
    fn drop(&mut self) {
        self.changes = None;
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn changes_reach_the_file_once_the_store_closes() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("threejsc-storage-{}", std::process::id()));
        let path = dir.join("localStorage.json");
        let _ = std::fs::remove_dir_all(&dir);
        let (store, entries) = Store::open(path.clone(), |_| {})?;
        assert!(entries.is_empty());
        for i in 0..1000 {
            store.change(Change::Set(format!("key{}", i % 10), i.to_string()));
        }
        store.change(Change::Remove("key0".into()));
        drop(store);
        let stored = read(&path)?;
        assert_eq!(stored.len(), 9);
        assert_eq!(stored["key9"], "999");
        let (store, entries) = Store::open(path.clone(), |_| {})?;
        assert_eq!(entries, stored);
        store.change(Change::Clear);
        drop(store);
        assert!(read(&path)?.is_empty());
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn each_game_gets_its_own_file_that_survives_a_rebuild() {
        let home = Path::new("C:/Users/player/AppData/Local");
        let a = default_path(Path::new("C:/games/gameA/dist/index.js"), home);
        let b = default_path(Path::new("C:/games/gameB/dist/index.js"), home);
        assert_ne!(a, b, "two games built to dist share no file");
        assert_eq!(
            a,
            default_path(Path::new("C:/games/gameA/dist/index.js"), home)
        );
        assert_eq!(
            a,
            default_path(Path::new("c:\\games\\gameA\\dist\\index.js"), home),
            "the same entry spelled another way"
        );
        let name = a
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        assert!(
            name.starts_with("dist-") && name.len() == "dist-".len() + 16,
            "{name}"
        );
        assert!(a.starts_with(home.join("threejsc")));
        assert_eq!(
            a.file_name().and_then(|name| name.to_str()),
            Some("localStorage.json")
        );
    }

    #[test]
    fn keys_keep_their_insertion_order_across_a_restart() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("threejsc-storage-order-{}", std::process::id()));
        let path = dir.join("localStorage.json");
        let _ = std::fs::remove_dir_all(&dir);
        let (store, entries) = Store::open(path.clone(), |_| {})?;
        assert!(entries.is_empty());
        for (key, value) in [("c", "3"), ("a", "1"), ("b", "2")] {
            store.change(Change::Set(key.into(), value.into()));
        }
        drop(store);
        let (store, entries) = Store::open(path.clone(), |_| {})?;
        let keys: Vec<&str> = entries.keys().map(String::as_str).collect();
        assert_eq!(keys, ["c", "a", "b"], "the file keeps the order the keys were set");
        drop(store);
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }

    #[test]
    fn a_corrupt_file_gives_an_empty_store() -> Result<()> {
        let dir = std::env::temp_dir().join(format!("threejsc-storage-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("localStorage.json");
        std::fs::write(&path, b"{not json")?;
        let logged = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = logged.clone();
        let (_store, entries) =
            Store::open(path, move |message| sink.lock().unwrap().push(message))?;
        assert!(entries.is_empty());
        assert!(logged.lock().unwrap()[0].starts_with("localStorage: starting empty"));
        std::fs::remove_dir_all(&dir)?;
        Ok(())
    }
}
