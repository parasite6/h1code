//! Loopback-only proxy for llama-server `/infill` (FIM completions + KV warm-up).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use url::Url;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfillChunk {
    pub text: String,
    pub filename: String,
    #[serde(default)]
    pub time: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfillRequest {
    pub endpoint: String,
    #[serde(default)]
    pub input_prefix: String,
    #[serde(default)]
    pub input_suffix: String,
    #[serde(default)]
    pub prompt: String,
    #[serde(default)]
    pub input_extra: Vec<InfillChunk>,
    #[serde(default = "default_n_predict")]
    pub n_predict: u32,
}

fn default_n_predict() -> u32 {
    128
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InfillWarmupRequest {
    pub endpoint: String,
    #[serde(default)]
    pub input_extra: Vec<InfillChunk>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InfillResponse {
    pub content: String,
}

/// Reject non-loopback endpoints so the webview cannot pivot through us.
pub fn assert_loopback_endpoint(endpoint: &str) -> Result<String, String> {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("autocomplete endpoint is empty".into());
    }
    let url = Url::parse(trimmed).map_err(|e| format!("invalid endpoint URL: {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("autocomplete endpoint must be http(s)".into());
    }
    let host = url.host_str().unwrap_or("");
    let loopback = matches!(host, "127.0.0.1" | "localhost" | "::1");
    if !loopback {
        return Err(format!(
            "autocomplete endpoint must target loopback (got host `{host}`)"
        ));
    }
    Ok(trimmed.to_string())
}

fn chunk_json(chunks: &[InfillChunk]) -> Vec<Value> {
    chunks
        .iter()
        .map(|c| {
            let mut map = serde_json::Map::new();
            map.insert("text".into(), Value::String(c.text.clone()));
            map.insert("filename".into(), Value::String(c.filename.clone()));
            if let Some(t) = c.time {
                map.insert("time".into(), Value::Number(t.into()));
            }
            Value::Object(map)
        })
        .collect()
}

fn post_infill(endpoint: &str, body: Value) -> Result<Value, String> {
    let url = format!("{endpoint}/infill");
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(60))
        .send_json(body)
        .map_err(|e| format!("infill request failed: {e}"))?;
    if !(200..300).contains(&resp.status()) {
        return Err(format!("infill HTTP {}", resp.status()));
    }
    resp.into_json::<Value>()
        .map_err(|e| format!("infill response JSON: {e}"))
}

pub fn infill(req: InfillRequest) -> Result<InfillResponse, String> {
    let endpoint = assert_loopback_endpoint(&req.endpoint)?;
    let body = serde_json::json!({
        "id_slot": 0,
        "input_prefix": req.input_prefix,
        "input_suffix": req.input_suffix,
        "input_extra": chunk_json(&req.input_extra),
        "prompt": req.prompt,
        "n_predict": req.n_predict,
        "top_k": 40,
        "top_p": 0.99,
        "stream": false,
        "samplers": ["top_k", "top_p", "infill"],
        "cache_prompt": true,
    });
    let data = post_infill(&endpoint, body)?;
    let content = data
        .get("content")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(InfillResponse { content })
}

/// Fire-and-forget-friendly warm-up: `n_predict: 0` to pre-fill KV with chunks.
pub fn infill_warmup(req: InfillWarmupRequest) -> Result<(), String> {
    let endpoint = assert_loopback_endpoint(&req.endpoint)?;
    let body = serde_json::json!({
        "id_slot": 0,
        "input_prefix": "",
        "input_suffix": "",
        "input_extra": chunk_json(&req.input_extra),
        "prompt": "",
        "n_predict": 0,
        "samplers": [],
        "cache_prompt": true,
        "t_max_predict_ms": 1,
    });
    let _ = post_infill(&endpoint, body)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_loopback() {
        assert!(assert_loopback_endpoint("http://example.com:8081").is_err());
        assert!(assert_loopback_endpoint("http://192.168.1.5:8081").is_err());
    }

    #[test]
    fn accepts_loopback() {
        assert!(assert_loopback_endpoint("http://127.0.0.1:8081").is_ok());
        assert!(assert_loopback_endpoint("http://localhost:8081/").is_ok());
    }

    #[test]
    fn live_infill_when_server_up() {
        let endpoint = "http://127.0.0.1:8081";
        // Skip when llama-server isn't running.
        if ureq::get(&format!("{endpoint}/health"))
            .timeout(std::time::Duration::from_secs(1))
            .call()
            .is_err()
        {
            return;
        }
        let resp = infill(InfillRequest {
            endpoint: endpoint.into(),
            input_prefix: "fn add(a: i32, b: i32) -> i32 {\n    ".into(),
            input_suffix: "\n}\n".into(),
            prompt: "    ".into(),
            input_extra: vec![],
            n_predict: 16,
        })
        .expect("infill");
        assert!(
            !resp.content.trim().is_empty(),
            "expected non-empty completion, got {:?}",
            resp.content
        );
    }
}
