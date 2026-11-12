//! The fonts canvas text draws with: faces a page loads through `FontFace`, and the Windows fonts that Edge falls
//! back to, which the host reads from the system's font folder when a page first needs them.

use anyhow::{Context, Result};
use harfrust::ShaperData;
use skrifa::{FontRef, MetadataProvider, Tag, raw::TableProvider};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

pub type FaceId = u32;

pub struct Face {
    /// The font file, decompressed from WOFF or WOFF2.
    pub data: Arc<Vec<u8>>,
    pub shaper: ShaperData,
    /// The `wght` axis's range, for a variable font.
    pub weight_axis: Option<(f32, f32)>,
    /// Whether the font draws glyphs in color, from COLR or bitmap tables.
    pub color: bool,
    /// Whether the font is a Windows font, which Edge measures through DirectWrite rather than as a web font.
    pub system: bool,
}

impl Face {
    pub fn font(&self) -> FontRef<'_> {
        FontRef::new(&self.data).expect("a face parses, as `load` checked")
    }
}

/// The Windows fonts Edge uses for the generic families, for its standard font and for characters a page's fonts
/// lack, by family name. Each entry is the regular, bold, italic and bold italic file.
const SYSTEM: &[(&str, [&str; 4])] = &[
    ("arial", ["arial.ttf", "arialbd.ttf", "ariali.ttf", "arialbi.ttf"]),
    ("times new roman", ["times.ttf", "timesbd.ttf", "timesi.ttf", "timesbi.ttf"]),
    ("consolas", ["consola.ttf", "consolab.ttf", "consolai.ttf", "consolaz.ttf"]),
    ("comic sans ms", ["comic.ttf", "comicbd.ttf", "comici.ttf", "comicz.ttf"]),
    ("impact", ["impact.ttf", "impact.ttf", "impact.ttf", "impact.ttf"]),
    ("segoe ui", ["segoeui.ttf", "segoeuib.ttf", "segoeuii.ttf", "segoeuiz.ttf"]),
    ("segoe ui emoji", ["seguiemj.ttf", "seguiemj.ttf", "seguiemj.ttf", "seguiemj.ttf"]),
    ("segoe ui symbol", ["seguisym.ttf", "seguisym.ttf", "seguisym.ttf", "seguisym.ttf"]),
];

/// Edge's generic families on Windows.
pub fn generic(family: &str) -> Option<&'static str> {
    Some(match family {
        "sans-serif" => "arial",
        "serif" => "times new roman",
        "monospace" => "consolas",
        "cursive" => "comic sans ms",
        "fantasy" => "impact",
        "system-ui" => "segoe ui",
        _ => return None,
    })
}

/// The family Edge draws with when none of a font's families is available.
pub const STANDARD: &str = "times new roman";
/// The families Windows falls back to, in this order, for a character no family in the font has.
pub const FALLBACK: &[&str] = &["segoe ui", "segoe ui symbol", "arial"];
/// The family Windows falls back to for an emoji.
pub const EMOJI: &str = "segoe ui emoji";

pub struct Fonts {
    faces: Vec<Face>,
    system: HashMap<String, Option<FaceId>>,
    system_dir: Option<PathBuf>,
}

impl Default for Fonts {
    fn default() -> Self {
        let system_dir = std::env::var_os("WINDIR").map(|dir| PathBuf::from(dir).join("Fonts"));
        Self { faces: Vec::new(), system: HashMap::new(), system_dir }
    }
}

impl Fonts {
    /// Loads a TrueType, OpenType, WOFF or WOFF2 file.
    pub fn load(&mut self, bytes: &[u8]) -> Result<FaceId> {
        self.add(bytes, false)
    }

    fn add(&mut self, bytes: &[u8], system: bool) -> Result<FaceId> {
        let data = match bytes.get(..4) {
            Some(b"wOFF") => wuff::decompress_woff1(bytes).map_err(|error| anyhow::anyhow!("WOFF: {error:?}"))?,
            Some(b"wOF2") => wuff::decompress_woff2(bytes).map_err(|error| anyhow::anyhow!("WOFF2: {error:?}"))?,
            _ => bytes.to_vec(),
        };
        let font = FontRef::new(&data).context("not a font file")?;
        let weight_axis = font.axes().iter().find(|axis| axis.tag() == Tag::new(b"wght")).map(|axis| (axis.min_value(), axis.max_value()));
        let color = font.colr().is_ok() || font.cbdt().is_ok() || font.sbix().is_ok();
        let shaper = ShaperData::new(&harfrust::FontRef::new(&data).context("not a font file")?);
        self.faces.push(Face { data: Arc::new(data), shaper, weight_axis, color, system });
        Ok((self.faces.len() - 1) as FaceId)
    }

    pub fn get(&self, id: FaceId) -> &Face {
        &self.faces[id as usize]
    }

    /// The system font with this family name, at this weight and style, loaded on first use. `None` when the
    /// family is not one Edge falls back to or its file is missing.
    pub fn system(&mut self, family: &str, bold: bool, italic: bool) -> Option<FaceId> {
        let (_, files) = SYSTEM.iter().find(|(name, _)| *name == family)?;
        let file = files[bold as usize + 2 * italic as usize];
        if let Some(id) = self.system.get(file) {
            return *id;
        }
        let id = self.system_dir.as_ref().and_then(|dir| std::fs::read(dir.join(file)).ok()).and_then(|bytes| self.add(&bytes, true).ok());
        self.system.insert(file.to_string(), id);
        id
    }
}
