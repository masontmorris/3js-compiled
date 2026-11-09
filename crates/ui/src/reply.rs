// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

use serde_json::Value;
use std::borrow::Cow;

/// Most events one reply contributes; the rest count as dropped.
pub const MAX_REPLY_EVENTS: usize = 4096;

/// A page's answer to `__bridge.tick`, reduced to what the host uses.
#[derive(Debug, Default, PartialEq)]
pub struct Reply {
    /// Each event as JSON text.
    pub events: Vec<String>,
    pub dropped: usize,
    /// Interactive rects, when the reply lists them.
    pub rects: Option<Vec<[f64; 4]>>,
    pub rejected: Vec<String>,
}

pub fn parse(json: &str) -> Reply {
    let mut reply = Reply::default();
    let value = match serde_json::from_str::<Value>(&well_formed(json)) {
        Ok(Value::Object(value)) => value,
        Ok(_) => {
            reply.rejected.push("reply is not a JSON object".into());
            return reply;
        }
        Err(error) => {
            reply.rejected.push(format!("reply is not JSON: {error}"));
            return reply;
        }
    };
    match value.get("events") {
        None => {}
        Some(Value::Array(items)) => {
            reply.dropped = items.len().saturating_sub(MAX_REPLY_EVENTS);
            reply.events = items
                .iter()
                .take(MAX_REPLY_EVENTS)
                .map(Value::to_string)
                .collect();
        }
        Some(_) => reply.rejected.push("events is not an array".into()),
    }
    match value.get("rects") {
        None => {}
        Some(Value::Array(items)) => {
            reply.rects = Some(
                items
                    .iter()
                    .enumerate()
                    .filter_map(|(index, item)| {
                        let rect = rect(item);
                        if rect.is_none() {
                            reply
                                .rejected
                                .push(format!("rects[{index}] is not [x, y, width, height]"));
                        }
                        rect
                    })
                    .collect(),
            )
        }
        Some(_) => reply.rejected.push("rects is not an array".into()),
    }
    reply
}

fn rect(item: &Value) -> Option<[f64; 4]> {
    let items = item.as_array().filter(|items| items.len() == 4)?;
    let mut rect = [0.0; 4];
    for (out, value) in rect.iter_mut().zip(items) {
        *out = value.as_f64().filter(|value| value.is_finite())?;
    }
    Some(rect)
}

/// Replaces each `\u` escape of an unpaired UTF-16 surrogate with `\ufffd`. `JSON.stringify`
/// writes a lone surrogate as such an escape and `JSON.parse` accepts it; serde_json does not.
fn well_formed(json: &str) -> Cow<'_, str> {
    let bytes = json.as_bytes();
    let surrogate = |at: usize| {
        let hex = bytes.get(at + 2..at + 6)?;
        let value = u16::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
        (bytes[at + 1] == b'u' && (0xD800..=0xDFFF).contains(&value)).then_some(value)
    };
    let mut out = String::new();
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        match surrogate(at) {
            Some(0xD800..=0xDBFF)
                if bytes.get(at + 6) == Some(&b'\\')
                    && matches!(surrogate(at + 6), Some(0xDC00..=0xDFFF)) =>
            {
                at += 12
            }
            Some(_) => {
                out.push_str(&json[copied..at]);
                out.push_str("\\ufffd");
                at += 6;
                copied = at;
            }
            None => at += 2,
        }
    }
    if copied == 0 {
        return Cow::Borrowed(json);
    }
    out.push_str(&json[copied..]);
    Cow::Owned(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_every_reply_json_parse_accepts() {
        let reply = parse(
            r#"{"events":[{"type":"echo","tail":"\ud83d"},{"type":"after","tail":"\ud83d\ude00 \\ud83d"},{"lone":"\udc00x"}],"rects":[[1,2,3,4]]}"#,
        );
        assert_eq!(
            reply.events,
            [
                r#"{"type":"echo","tail":"�"}"#,
                r#"{"type":"after","tail":"😀 \\ud83d"}"#,
                r#"{"lone":"�x"}"#,
            ]
        );
        assert_eq!(reply.rects, Some(vec![[1.0, 2.0, 3.0, 4.0]]));
        assert!(reply.rejected.is_empty());
    }

    #[test]
    fn keeps_good_items_and_names_bad_ones() {
        let reply = parse(r#"{"events":[1,"two"],"rects":[[0,0,10,10],[1,2],"x",[0,0,5,null]]}"#);
        assert_eq!(reply.events, ["1", r#""two""#]);
        assert_eq!(reply.rects, Some(vec![[0.0, 0.0, 10.0, 10.0]]));
        assert_eq!(
            reply.rejected,
            [
                "rects[1] is not [x, y, width, height]",
                "rects[2] is not [x, y, width, height]",
                "rects[3] is not [x, y, width, height]",
            ]
        );
        let reply = parse(r#"{"events":{},"rects":[[0,0,1,1]]}"#);
        assert_eq!(reply.rects, Some(vec![[0.0, 0.0, 1.0, 1.0]]));
        assert_eq!(reply.rejected, ["events is not an array"]);
        assert_eq!(parse("[]").rejected, ["reply is not a JSON object"]);
        assert!(parse("{").rejected[0].starts_with("reply is not JSON"));
        assert_eq!(parse("{}"), Reply::default());
    }

    #[test]
    fn counts_events_past_the_reply_limit_as_dropped() {
        let events = vec!["0"; MAX_REPLY_EVENTS + 5].join(",");
        let reply = parse(&format!(r#"{{"events":[{events}]}}"#));
        assert_eq!(reply.events.len(), MAX_REPLY_EVENTS);
        assert_eq!(reply.dropped, 5);
    }
}
