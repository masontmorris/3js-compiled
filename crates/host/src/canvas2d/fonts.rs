//! The fonts canvas text draws with: faces a page loads through `FontFace`, and installed Windows fonts, which
//! DirectWrite finds by family name or picks for characters a page's fonts lack, as Edge's do.

use anyhow::{Context, Result};
use harfrust::ShaperData;
use skrifa::{FontRef, MetadataProvider, Tag, raw::TableProvider};
use std::{collections::HashMap, path::PathBuf, sync::Arc};

pub type FaceId = u32;

pub struct Face {
    /// The font file, decompressed from WOFF or WOFF2. A collection keeps all its faces.
    pub data: Arc<Vec<u8>>,
    /// The face's index in a font collection, else 0.
    pub index: u32,
    pub shaper: ShaperData,
    /// The `wght` axis's range, for a variable font.
    pub weight_axis: Option<(f32, f32)>,
    /// Whether the font draws glyphs in color, from COLR or bitmap tables.
    pub color: bool,
    /// Whether the font is a Windows font, which Edge measures through DirectWrite rather than as a web font.
    pub system: bool,
    /// Whether DirectWrite emboldens this Windows face, because its family has no face as bold as asked.
    pub simulated_bold: bool,
}

impl Face {
    pub fn font(&self) -> FontRef<'_> {
        FontRef::from_index(&self.data, self.index).expect("a face parses, as `add` checked")
    }
}

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

/// The Windows family Chromium substitutes for a family name Windows lacks.
fn alias(family: &str) -> Option<&'static str> {
    Some(match family {
        "helvetica" => "arial",
        "times" => "times new roman",
        "courier" => "courier new",
        _ => return None,
    })
}

/// The family Edge draws with when none of a font's families is available.
pub const STANDARD: &str = "times new roman";

#[derive(Default)]
pub struct Fonts {
    faces: Vec<Face>,
    /// Windows font files by path, so the faces of one collection share their bytes.
    files: HashMap<PathBuf, Arc<Vec<u8>>>,
    /// Windows faces by file, index and bold simulation.
    installed: HashMap<(PathBuf, u32, bool), FaceId>,
    families: HashMap<(String, u16, bool), Option<FaceId>>,
    fallbacks: HashMap<(char, u16, bool), Option<FaceId>>,
    #[cfg(windows)]
    system: Option<super::dwrite::System>,
}

impl Fonts {
    /// Loads a TrueType, OpenType, WOFF or WOFF2 file.
    pub fn load(&mut self, bytes: &[u8]) -> Result<FaceId> {
        let data = match bytes.get(..4) {
            Some(b"wOFF") => {
                wuff::decompress_woff1(bytes).map_err(|error| anyhow::anyhow!("WOFF: {error:?}"))?
            }
            Some(b"wOF2") => wuff::decompress_woff2(bytes)
                .map_err(|error| anyhow::anyhow!("WOFF2: {error:?}"))?,
            _ => bytes.to_vec(),
        };
        self.add(Arc::new(data), 0, false, false)
    }

    fn add(
        &mut self,
        data: Arc<Vec<u8>>,
        index: u32,
        system: bool,
        simulated_bold: bool,
    ) -> Result<FaceId> {
        let font = FontRef::from_index(&data, index).context("not a font file")?;
        let weight_axis = font
            .axes()
            .iter()
            .find(|axis| axis.tag() == Tag::new(b"wght"))
            .map(|axis| (axis.min_value(), axis.max_value()));
        let color = font.colr().is_ok() || font.cbdt().is_ok() || font.sbix().is_ok();
        let shaper = ShaperData::new(
            &harfrust::FontRef::from_index(&data, index).context("not a font file")?,
        );
        self.faces.push(Face {
            data,
            index,
            shaper,
            weight_axis,
            color,
            system,
            simulated_bold,
        });
        Ok((self.faces.len() - 1) as FaceId)
    }

    pub fn get(&self, id: FaceId) -> &Face {
        &self.faces[id as usize]
    }

    /// The installed face for a family name or one of Chromium's aliases, at this weight and style, loaded on
    /// first use. `None` when Windows has no such family.
    pub fn family(&mut self, name: &str, weight: f32, italic: bool) -> Option<FaceId> {
        self.family_cached(&name.to_lowercase(), weight, italic)
    }

    /// The installed face for a generic family keyword, which Edge maps to a named Windows family.
    pub fn generic(&mut self, name: &str, weight: f32, italic: bool) -> Option<FaceId> {
        let name = generic(name).unwrap_or(name).to_lowercase();
        self.family_cached(&name, weight, italic)
    }

    fn family_cached(&mut self, name: &str, weight: f32, italic: bool) -> Option<FaceId> {
        let key = (name.to_string(), weight.round() as u16, italic);
        if let Some(id) = self.families.get(&key) {
            return *id;
        }
        let found = self
            .lookup(name, weight, italic)
            .or_else(|| alias(name).and_then(|other| self.lookup(other, weight, italic)));
        self.families.insert(key, found);
        found
    }

    /// The installed face Windows' font fallback picks for a character, loaded on first use.
    pub fn fallback(&mut self, c: char, weight: f32, italic: bool) -> Option<FaceId> {
        let key = (c, weight.round() as u16, italic);
        if let Some(id) = self.fallbacks.get(&key) {
            return *id;
        }
        #[cfg(windows)]
        let found = self
            .system()
            .fallback(c, weight, italic)
            .and_then(|found| self.install(found));
        #[cfg(not(windows))]
        let found = None;
        self.fallbacks.insert(key, found);
        found
    }

    #[cfg(windows)]
    fn system(&mut self) -> &super::dwrite::System {
        self.system.get_or_insert_with(super::dwrite::System::new)
    }

    #[cfg(windows)]
    fn lookup(&mut self, family: &str, weight: f32, italic: bool) -> Option<FaceId> {
        let found = self.system().family(family, weight, italic)?;
        self.install(found)
    }

    #[cfg(not(windows))]
    fn lookup(&mut self, _family: &str, _weight: f32, _italic: bool) -> Option<FaceId> {
        None
    }

    #[cfg(windows)]
    fn install(&mut self, found: super::dwrite::Found) -> Option<FaceId> {
        let key = (found.path.clone(), found.index, found.simulated_bold);
        if let Some(id) = self.installed.get(&key) {
            return Some(*id);
        }
        let data = match self.files.get(&found.path) {
            Some(data) => data.clone(),
            None => {
                let data = Arc::new(std::fs::read(&found.path).ok()?);
                self.files.insert(found.path.clone(), data.clone());
                data
            }
        };
        let id = self
            .add(data, found.index, true, found.simulated_bold)
            .ok()?;
        self.installed.insert(key, id);
        Some(id)
    }
}
