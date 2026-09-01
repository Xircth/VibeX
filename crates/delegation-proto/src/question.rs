//! Shared `ask_user_question` argument contract used by the companion and Host.

use serde_json::Value;

pub const MAX_QUESTIONS: usize = 4;
pub const MIN_OPTIONS: usize = 2;
pub const MAX_OPTIONS: usize = 4;
pub const MAX_HEADER_CHARS: usize = 12;
pub const MAX_QUESTION_TEXT_CHARS: usize = 4096;

/// Validate MCP `ask_user_question` arguments. Returns the questions array on
/// success so callers can forward a cleaned payload. Failures are messages the
/// model can act on.
pub fn parse_questions(arguments: &Value) -> Result<Value, String> {
    let owned;
    let arguments = if arguments.get("questions").is_some() {
        arguments
    } else if arguments.is_array() {
        owned = serde_json::json!({ "questions": arguments });
        &owned
    } else {
        return Err("ask_user_question requires a `questions` array".to_string());
    };
    let arr = arguments
        .get("questions")
        .and_then(Value::as_array)
        .ok_or_else(|| "ask_user_question requires a `questions` array".to_string())?;
    if arr.is_empty() {
        return Err("ask_user_question requires at least one question".to_string());
    }
    if arr.len() > MAX_QUESTIONS {
        return Err(format!(
            "ask_user_question supports at most {MAX_QUESTIONS} questions per call"
        ));
    }
    let mut out = Vec::with_capacity(arr.len());
    for (qi, question) in arr.iter().enumerate() {
        let prompt = question
            .get("question")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `question`"))?;
        if prompt.chars().count() > MAX_QUESTION_TEXT_CHARS {
            return Err(format!(
                "questions[{qi}] `question` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
            ));
        }
        let header = question
            .get("header")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("questions[{qi}] is missing a non-empty `header`"))?;
        if header.chars().count() > MAX_HEADER_CHARS {
            return Err(format!(
                "questions[{qi}] `header` exceeds {MAX_HEADER_CHARS} characters"
            ));
        }
        let options = question
            .get("options")
            .and_then(Value::as_array)
            .ok_or_else(|| format!("questions[{qi}] is missing an `options` array"))?;
        if options.len() < MIN_OPTIONS || options.len() > MAX_OPTIONS {
            return Err(format!(
                "questions[{qi}] must have between {MIN_OPTIONS} and {MAX_OPTIONS} options"
            ));
        }
        for (oi, option) in options.iter().enumerate() {
            let label = option
                .get("label")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    format!("questions[{qi}].options[{oi}] is missing a non-empty `label`")
                })?;
            if label.chars().count() > MAX_QUESTION_TEXT_CHARS {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `label` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
            if let Some(description) = option.get("description").and_then(Value::as_str)
                && description.chars().count() > MAX_QUESTION_TEXT_CHARS
            {
                return Err(format!(
                    "questions[{qi}].options[{oi}] `description` exceeds {MAX_QUESTION_TEXT_CHARS} characters"
                ));
            }
        }
        out.push(question.clone());
    }
    Ok(Value::Array(out))
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::parse_questions;

    fn valid() -> serde_json::Value {
        json!({
            "questions": [{
                "question": "Which approach?",
                "header": "Approach",
                "multiSelect": false,
                "options": [
                    { "label": "Patch (Recommended)", "description": "Small change." },
                    { "label": "Rewrite", "description": "Broader change." }
                ]
            }]
        })
    }

    #[test]
    fn accepts_a_well_formed_question_set() {
        assert!(parse_questions(&valid()).is_ok());
    }

    #[test]
    fn rejects_too_few_options_and_missing_header() {
        let mut value = valid();
        value["questions"][0]["options"] = json!([{ "label": "Only one" }]);
        assert!(
            parse_questions(&value)
                .unwrap_err()
                .contains("between 2 and 4")
        );
        value = valid();
        value["questions"][0]
            .as_object_mut()
            .unwrap()
            .remove("header");
        assert!(parse_questions(&value).unwrap_err().contains("header"));
    }
}
