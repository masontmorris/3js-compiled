//! The platform shims that let browser game code run in the host: the JavaScript modules under
//! `packages/three-native/src/platform`, which the host serves as `threejsc:/platform/`, and the ops they
//! call to read files, decode images and persist `localStorage`.

pub mod events;
pub mod gamepads;
pub mod images;
pub mod storage;

use deno_core::{
    FastString, FsModuleLoader, JsBuffer, ModuleLoadOptions, ModuleLoadReferrer,
    ModuleLoadResponse, ModuleLoader, ModuleResolveResponse, ModuleSource, ModuleSourceCode,
    ModuleSpecifier, ModuleType, OpState, ResolutionKind, ToJsBuffer, op2, resolve_import,
};
use deno_error::JsErrorBox;
use serde::Serialize;

/// The module that installs the shims, which the host evaluates before the entry module.
pub const ENTRY: &str = "threejsc:/platform/index.js";

macro_rules! modules {
    ($($name:literal),*) => {
        &[$(($name, include_str!(concat!("../../../../packages/three-native/src/platform/", $name)))),*]
    };
}
const MODULES: &[(&str, &str)] = modules!(
    "index.js",
    "events.js",
    "dom.js",
    "dom-methods.js",
    "gamepad.js",
    "storage.js",
    "images.js"
);

/// Loads the platform modules from the host binary and every other module from the file system.
pub struct Loader(FsModuleLoader);

impl Loader {
    pub fn new() -> Self {
        Self(FsModuleLoader)
    }
}

impl Default for Loader {
    fn default() -> Self {
        Self::new()
    }
}

impl ModuleLoader for Loader {
    fn resolve(
        &self,
        specifier: &str,
        referrer: &str,
        _kind: ResolutionKind,
    ) -> ModuleResolveResponse {
        resolve_import(specifier, referrer).map_err(JsErrorBox::from_err)
    }

    fn load(
        &self,
        specifier: &ModuleSpecifier,
        referrer: Option<&ModuleLoadReferrer>,
        options: ModuleLoadOptions,
    ) -> ModuleLoadResponse {
        if specifier.scheme() != "threejsc" {
            return self.0.load(specifier, referrer, options);
        }
        let name = specifier.path().strip_prefix("/platform/").unwrap_or("");
        ModuleLoadResponse::Sync(
            MODULES
                .iter()
                .find(|(module, _)| *module == name)
                .map(|(_, code)| {
                    ModuleSource::new(
                        ModuleType::JavaScript,
                        ModuleSourceCode::String(FastString::from_static(code)),
                        specifier,
                        None,
                    )
                })
                .ok_or_else(|| JsErrorBox::type_error(format!("No platform module {specifier}"))),
        )
    }
}

#[derive(Serialize)]
struct Decoded {
    width: u32,
    height: u32,
    data: ToJsBuffer,
}

/// Decodes a PNG, JPEG or WebP image to straight-alpha RGBA8 on the blocking pool.
#[op2]
#[serde]
async fn op_image_decode(#[buffer] bytes: JsBuffer) -> Result<Decoded, JsErrorBox> {
    let pixels = tokio::task::spawn_blocking(move || images::decode(&bytes))
        .await
        .map_err(|error| JsErrorBox::generic(error.to_string()))?
        .map_err(|error| JsErrorBox::generic(error.to_string()))?;
    Ok(Decoded {
        width: pixels.width,
        height: pixels.height,
        data: pixels.data.into(),
    })
}

/// Reads a file on the blocking pool, or answers `null` when it does not exist.
#[op2]
#[serde]
async fn op_read_file(#[string] path: String) -> Result<Option<ToJsBuffer>, JsErrorBox> {
    match tokio::task::spawn_blocking(move || std::fs::read(path)).await {
        Ok(Ok(bytes)) => Ok(Some(bytes.into())),
        Ok(Err(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Ok(Err(error)) => Err(JsErrorBox::generic(error.to_string())),
        Err(error) => Err(JsErrorBox::generic(error.to_string())),
    }
}

fn change(state: &OpState, change: storage::Change) {
    if let Some(store) = state.try_borrow::<storage::Store>() {
        store.change(change);
    }
}
#[op2(fast)]
fn op_storage_set(state: &mut OpState, #[string] key: String, #[string] value: String) {
    change(state, storage::Change::Set(key, value));
}
#[op2(fast)]
fn op_storage_remove(state: &mut OpState, #[string] key: String) {
    change(state, storage::Change::Remove(key));
}
#[op2(fast)]
fn op_storage_clear(state: &mut OpState) {
    change(state, storage::Change::Clear);
}

deno_core::extension!(
    platform_ext,
    ops = [
        op_image_decode,
        op_read_file,
        op_storage_set,
        op_storage_remove,
        op_storage_clear
    ]
);
pub use platform_ext as extension;
