//! Zero-dependency RFC 8259 JSON parser/serializer and FIPS 180-4 SHA-256 digest
//! (`sha256:<hex>`) for `dimo-workflow-mcp`.

use std::fmt::Write as _;

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

impl Json {
    pub fn obj<'a>(entries: impl IntoIterator<Item = (&'a str, Json)>) -> Self {
        Self::Obj(
            entries
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect(),
        )
    }

    pub fn arr(items: impl IntoIterator<Item = Json>) -> Self {
        Self::Arr(items.into_iter().collect())
    }

    pub fn str(s: impl Into<String>) -> Self {
        Self::Str(s.into())
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    pub fn is_obj(&self) -> bool {
        matches!(self, Self::Obj(_))
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(n) => Some(*n),
            Self::Float(f)
                if f.fract() == 0.0 && *f >= i64::MIN as f64 && *f <= i64::MAX as f64 =>
            {
                Some(*f as i64)
            }
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Self::Arr(items) => Some(items.as_slice()),
            _ => None,
        }
    }

    pub fn as_arr_mut(&mut self) -> Option<&mut Vec<Json>> {
        match self {
            Self::Arr(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_obj(&self) -> Option<&[(String, Json)]> {
        match self {
            Self::Obj(entries) => Some(entries.as_slice()),
            _ => None,
        }
    }

    pub fn as_obj_mut(&mut self) -> Option<&mut Vec<(String, Json)>> {
        match self {
            Self::Obj(entries) => Some(entries),
            _ => None,
        }
    }

    pub fn get(&self, key: &str) -> Option<&Json> {
        self.as_obj()?
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> {
        self.as_obj_mut()?
            .iter_mut()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v)
    }

    pub fn set(&mut self, key: impl Into<String>, val: Json) {
        let key = key.into();
        if let Self::Obj(entries) = self {
            if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| *k == key) {
                *existing = val;
            } else {
                entries.push((key, val));
            }
        }
    }

    pub fn remove(&mut self, key: &str) -> Option<Json> {
        if let Self::Obj(entries) = self
            && let Some(pos) = entries.iter().position(|(k, _)| k == key)
        {
            return Some(entries.remove(pos).1);
        }
        None
    }

    pub fn parse(input: &str) -> Result<Self, String> {
        let mut parser = Parser {
            bytes: input.as_bytes(),
            pos: 0,
        };
        let value = parser.parse_value(0)?;
        parser.skip_ws();
        if parser.pos != parser.bytes.len() {
            return Err(format!("trailing characters at byte {}", parser.pos));
        }
        Ok(value)
    }

    pub fn to_compact_string(&self) -> String {
        let mut out = String::new();
        self.write_fmt(&mut out, None, 0);
        out
    }

    pub fn to_pretty_string(&self) -> String {
        let mut out = String::new();
        self.write_fmt(&mut out, Some(2), 0);
        out
    }

    fn write_fmt(&self, out: &mut String, indent: Option<usize>, depth: usize) {
        match self {
            Self::Null => out.push_str("null"),
            Self::Bool(true) => out.push_str("true"),
            Self::Bool(false) => out.push_str("false"),
            Self::Int(n) => {
                let _ = write!(out, "{n}");
            }
            Self::Float(f) => {
                if f.is_finite() {
                    let _ = write!(out, "{f}");
                } else {
                    out.push_str("null");
                }
            }
            Self::Str(s) => write_escaped_str(out, s),
            Self::Arr(items) => {
                if items.is_empty() {
                    out.push_str("[]");
                    return;
                }
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if let Some(spaces) = indent {
                        out.push('\n');
                        for _ in 0..spaces * (depth + 1) {
                            out.push(' ');
                        }
                    }
                    item.write_fmt(out, indent, depth + 1);
                }
                if let Some(spaces) = indent {
                    out.push('\n');
                    for _ in 0..spaces * depth {
                        out.push(' ');
                    }
                }
                out.push(']');
            }
            Self::Obj(entries) => {
                if entries.is_empty() {
                    out.push_str("{}");
                    return;
                }
                out.push('{');
                for (i, (k, v)) in entries.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    if let Some(spaces) = indent {
                        out.push('\n');
                        for _ in 0..spaces * (depth + 1) {
                            out.push(' ');
                        }
                    }
                    write_escaped_str(out, k);
                    out.push(':');
                    if indent.is_some() {
                        out.push(' ');
                    }
                    v.write_fmt(out, indent, depth + 1);
                }
                if let Some(spaces) = indent {
                    out.push('\n');
                    for _ in 0..spaces * depth {
                        out.push(' ');
                    }
                }
                out.push('}');
            }
        }
    }
}

fn write_escaped_str(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\x08' => out.push_str("\\b"),
            '\x0c' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

struct Parser<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Parser<'a> {
    fn skip_ws(&mut self) {
        while self.pos < self.bytes.len() {
            match self.bytes[self.pos] {
                b' ' | b'\t' | b'\r' | b'\n' => self.pos += 1,
                _ => break,
            }
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.pos).copied()
    }

    fn parse_value(&mut self, depth: usize) -> Result<Json, String> {
        if depth > 128 {
            return Err("JSON nesting exceeds depth 128".to_string());
        }
        self.skip_ws();
        let b = self
            .peek()
            .ok_or_else(|| "unexpected EOF in JSON".to_string())?;
        match b {
            b'n' => self.expect_kw(b"null", Json::Null),
            b't' => self.expect_kw(b"true", Json::Bool(true)),
            b'f' => self.expect_kw(b"false", Json::Bool(false)),
            b'"' => self.parse_string().map(Json::Str),
            b'[' => self.parse_array(depth + 1),
            b'{' => self.parse_object(depth + 1),
            b'-' | b'0'..=b'9' => self.parse_number(),
            other => Err(format!(
                "unexpected byte '{}' at {}",
                other as char, self.pos
            )),
        }
    }

    fn expect_kw(&mut self, kw: &[u8], val: Json) -> Result<Json, String> {
        if self.bytes.get(self.pos..self.pos + kw.len()) == Some(kw) {
            self.pos += kw.len();
            Ok(val)
        } else {
            Err(format!("invalid literal at byte {}", self.pos))
        }
    }

    fn parse_string(&mut self) -> Result<String, String> {
        if self.peek() != Some(b'"') {
            return Err(format!("expected '\"' at byte {}", self.pos));
        }
        self.pos += 1;
        let mut out = String::new();
        while self.pos < self.bytes.len() {
            let b = self.bytes[self.pos];
            if b == b'"' {
                self.pos += 1;
                return Ok(out);
            }
            if b == b'\\' {
                self.pos += 1;
                let esc = *self
                    .bytes
                    .get(self.pos)
                    .ok_or_else(|| "unterminated escape".to_string())?;
                self.pos += 1;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'b' => out.push('\x08'),
                    b'f' => out.push('\x0c'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'u' => {
                        let hi = self.parse_hex4()?;
                        if (0xD800..=0xDBFF).contains(&hi) {
                            if self.bytes.get(self.pos..self.pos + 2) != Some(b"\\u") {
                                return Err("unpaired UTF-16 high surrogate".to_string());
                            }
                            self.pos += 2;
                            let lo = self.parse_hex4()?;
                            if !(0xDC00..=0xDFFF).contains(&lo) {
                                return Err("invalid UTF-16 low surrogate".to_string());
                            }
                            let cp =
                                0x10000 + (((hi as u32 - 0xD800) << 10) | (lo as u32 - 0xDC00));
                            out.push(char::from_u32(cp).ok_or("invalid surrogate scalar")?);
                        } else {
                            out.push(
                                char::from_u32(hi as u32)
                                    .ok_or_else(|| "invalid unicode escape".to_string())?,
                            );
                        }
                    }
                    other => return Err(format!("invalid escape '\\{}'", other as char)),
                }
            } else if b < 0x20 {
                return Err("unescaped control character in JSON string".to_string());
            } else {
                let rest = std::str::from_utf8(&self.bytes[self.pos..])
                    .map_err(|_| "invalid UTF-8 in JSON string".to_string())?;
                let ch = rest.chars().next().unwrap();
                out.push(ch);
                self.pos += ch.len_utf8();
            }
        }
        Err("unterminated JSON string".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u16, String> {
        let slice = self
            .bytes
            .get(self.pos..self.pos + 4)
            .ok_or_else(|| "short \\uXXXX escape".to_string())?;
        let text = std::str::from_utf8(slice).map_err(|_| "invalid hex escape".to_string())?;
        let val = u16::from_str_radix(text, 16).map_err(|_| "invalid hex digit".to_string())?;
        self.pos += 4;
        Ok(val)
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.pos += 1;
        }
        let mut is_float = false;
        if self.peek() == Some(b'.') {
            is_float = true;
            self.pos += 1;
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            is_float = true;
            self.pos += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(b'0'..=b'9')) {
                self.pos += 1;
            }
        }
        let raw = std::str::from_utf8(&self.bytes[start..self.pos])
            .map_err(|_| "invalid number utf8".to_string())?;
        if !is_float && let Ok(i) = raw.parse::<i64>() {
            return Ok(Json::Int(i));
        }
        let f = raw
            .parse::<f64>()
            .map_err(|_| format!("invalid JSON number '{raw}'"))?;
        Ok(Json::Float(f))
    }

    fn parse_array(&mut self, depth: usize) -> Result<Json, String> {
        self.pos += 1;
        self.skip_ws();
        let mut items = Vec::new();
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(Json::Arr(items));
        }
        loop {
            items.push(self.parse_value(depth)?);
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b']') => {
                    self.pos += 1;
                    return Ok(Json::Arr(items));
                }
                _ => return Err(format!("expected ',' or ']' at byte {}", self.pos)),
            }
        }
    }

    fn parse_object(&mut self, depth: usize) -> Result<Json, String> {
        self.pos += 1;
        self.skip_ws();
        let mut entries: Vec<(String, Json)> = Vec::new();
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(Json::Obj(entries));
        }
        loop {
            self.skip_ws();
            let key = self.parse_string()?;
            self.skip_ws();
            if self.peek() != Some(b':') {
                return Err(format!("expected ':' at byte {}", self.pos));
            }
            self.pos += 1;
            let val = self.parse_value(depth)?;
            if let Some((_, existing)) = entries.iter_mut().find(|(k, _)| *k == key) {
                *existing = val;
            } else {
                entries.push((key, val));
            }
            self.skip_ws();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(Json::Obj(entries));
                }
                _ => return Err(format!("expected ',' or '}}' at byte {}", self.pos)),
            }
        }
    }
}

/// FIPS 180-4 SHA-256 returning `"sha256:<hex>"` matching `workflow-control.mjs` CAS revisions.
pub fn sha256_revision(bytes: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut state: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (bytes.len() as u64) * 8;
    let mut padded = Vec::with_capacity(((bytes.len() + 9 + 63) / 64) * 64);
    padded.extend_from_slice(bytes);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0x00);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in padded.chunks_exact(64) {
        for (i, word) in chunk.chunks_exact(4).enumerate() {
            w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = h
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            h = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        state[0] = state[0].wrapping_add(a);
        state[1] = state[1].wrapping_add(b);
        state[2] = state[2].wrapping_add(c);
        state[3] = state[3].wrapping_add(d);
        state[4] = state[4].wrapping_add(e);
        state[5] = state[5].wrapping_add(f);
        state[6] = state[6].wrapping_add(g);
        state[7] = state[7].wrapping_add(h);
    }

    let mut out = String::with_capacity(7 + 64);
    out.push_str("sha256:");
    for word in state {
        let _ = write!(out, "{word:08x}");
    }
    out
}
