use chardetng::EncodingDetector;

pub(crate) fn decode_text_bytes(bytes: &[u8], file_context: &str) -> Result<String, String> {
    if bytes.contains(&0) {
        return Err(format!("{file_context} appears to be binary"));
    }

    if let Ok(content) = String::from_utf8(bytes.to_vec()) {
        return Ok(content);
    }

    let mut detector = EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (decoded, _, had_errors) = encoding.decode(bytes);

    if had_errors {
        return Err(format!("{file_context} is not valid text"));
    }

    Ok(decoded.into_owned())
}

#[cfg(test)]
mod tests {
    use super::decode_text_bytes;

    #[test]
    fn decodes_utf8_text_without_changes() {
        let decoded = decode_text_bytes("hello，世界".as_bytes(), "file").expect("utf8 text");
        assert_eq!(decoded, "hello，世界");
    }

    #[test]
    fn decodes_gb18030_text() {
        let (encoded, _, had_errors) = encoding_rs::GB18030.encode("usb异常断开");
        assert!(!had_errors, "encode should succeed");

        let decoded = decode_text_bytes(&encoded, "file").expect("gb18030 text");
        assert_eq!(decoded, "usb异常断开");
    }

    #[test]
    fn rejects_binary_like_bytes() {
        let error = decode_text_bytes(&[0x66, 0x00, 0x6f, 0x00], "file").expect_err("binary");
        assert!(error.contains("appears to be binary"));
    }
}
