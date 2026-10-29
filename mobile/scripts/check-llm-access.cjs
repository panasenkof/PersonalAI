"use strict";
/**
 * One-request live LLM connectivity check. No npm, Android, Jest or local data.
 * Never print credentials, request/response bodies or provider error messages.
 * Explicit manual and paid consent is mandatory even when invoked directly.
 */
const https = require("node:https");

function authorize(config) {
  if (config.trigger !== "workflow_dispatch" ||
      config.liveApproved !== "true") {
    throw Error("MANUAL_LLM_OPT_IN_REQUIRED");
  }
  if (!config.key || !config.baseUrl || !config.model) {
    throw Error("LLM_CONFIGURATION_MISSING");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/.test(config.model)) {
    throw Error("INVALID_MODEL_NAME");
  }
  let url;
  try { url = new URL(config.baseUrl); }
  catch { throw Error("INVALID_API_URL"); }
  if (url.protocol !== "https:" || !url.hostname || url.username ||
      url.password || url.search || url.hash || url.port ||
      /^(?:localhost|.*\.local|.*\.internal)$/i.test(url.hostname) ||
      /^(?:\d{1,3}\.){3}\d{1,3}$/.test(url.hostname) ||
      url.hostname.includes(":")) {
    throw Error("PUBLIC_HTTPS_API_REQUIRED");
  }
  if (url.pathname !== "/" && url.pathname !== "/v1" && url.pathname !== "/v1/") {
    throw Error("API_BASE_PATH_UNSUPPORTED");
  }
  return new URL(url.origin + (url.pathname.startsWith("/v1") ? "/v1" : "") +
    "/chat/completions");
}

function postOnce(url, headers, body) {
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: "POST",
      headers: {...headers, "Content-Length": Buffer.byteLength(body)},
      timeout: 25000,
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 262144) {
          request.destroy(Object.assign(Error("RESPONSE_TOO_LARGE"), {code:"RESPONSE_TOO_LARGE"}));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve({
        status: response.statusCode || 0,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.on("timeout", () => request.destroy(Object.assign(
      Error("API_TIMEOUT"), {code:"API_TIMEOUT"})));
    request.on("error", reject);
    request.end(body);
  });
}

function statusReason(status) {
  if (status === 400) return "BAD_REQUEST_OR_MODEL_PARAMETERS";
  if (status === 401) return "API_KEY_REJECTED";
  if (status === 402) return "BILLING_OR_BALANCE";
  if (status === 403) return "ACCESS_FORBIDDEN";
  if (status === 404) return "MODEL_OR_ENDPOINT_NOT_FOUND";
  if (status === 429) return "QUOTA_OR_RATE_LIMIT";
  if (status >= 500) return "PROVIDER_ERROR";
  return "UNEXPECTED_HTTP_STATUS";
}

async function check(config, post = postOnce) {
  const url = authorize(config);
  const payload = {
    model: config.model,
    messages: [{role:"user", content:"Ответь только словом OK."}],
    max_tokens: 64,
    // DeepSeek's default thinking mode may consume all 64 tokens without an answer.
    ...(url.hostname === "api.deepseek.com" ? {thinking:{type:"disabled"}} : {}),
  };
  const response = await post(url, {
    "Content-Type":"application/json",
    "Authorization":"Bearer " + config.key,
  }, JSON.stringify(payload));
  if (response.status !== 200) throw Error("HTTP_" + response.status +
    "_" + statusReason(response.status));
  let parsed;
  try { parsed=JSON.parse(response.body); }
  catch { throw Error("INVALID_PROVIDER_JSON"); }
  if (!parsed || !Array.isArray(parsed.choices) ||
      typeof parsed.choices[0]?.message?.content !== "string" ||
      !parsed.choices[0].message.content.trim()) {
    throw Error("EMPTY_OR_INVALID_MODEL_RESPONSE");
  }
  return {status:"PASS",host:url.hostname,model:config.model,
    promptTokens: Number.isInteger(parsed.usage?.prompt_tokens) ? parsed.usage.prompt_tokens : null,
    completionTokens: Number.isInteger(parsed.usage?.completion_tokens) ? parsed.usage.completion_tokens : null};
}

if (require.main === module) {
  const config={
    trigger:process.env.PERSAI_EVAL_MANUAL_TRIGGER,
    liveApproved:process.env.PERSAI_EVAL_LIVE_LLM_APPROVED,
    key:process.env.PERSAI_EVAL_LLM_API_KEY,
    baseUrl:process.env.PERSAI_EVAL_LLM_BASE_URL,
    model:process.env.PERSAI_EVAL_LLM_MODEL,
  };
  check(config).then(result=>{
    const line="LLM connectivity: PASS; host="+result.host+"; model="+result.model+
      "; response=nonempty; prompt_tokens="+(result.promptTokens??"unknown")+
      "; output_tokens="+(result.completionTokens??"unknown")+"; paid_API_calls=1";
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      require("node:fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY,line+"\n");
  }).catch(error=>{
    // Never echo network/provider body or sensitive strings from exception messages.
    const reason=/^(?:MANUAL_LLM_OPT_IN_REQUIRED|LLM_CONFIGURATION_MISSING|INVALID_MODEL_NAME|INVALID_API_URL|PUBLIC_HTTPS_API_REQUIRED|API_BASE_PATH_UNSUPPORTED|INVALID_PROVIDER_JSON|EMPTY_OR_INVALID_MODEL_RESPONSE|HTTP_\d+_[A-Z_]+)$/.test(error?.message)
      ? error.message : (typeof error?.code==="string" && /^[A-Z_]{3,40}$/.test(error.code)
        ? "NETWORK_"+error.code : "NETWORK_OR_TLS_ERROR");
    const line="LLM connectivity: FAIL ("+reason+"). No Android build or memory acceptance performed.";
    console.error(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      require("node:fs").appendFileSync(process.env.GITHUB_STEP_SUMMARY,line+"\n");
    process.exitCode=1;
  });
}
module.exports={authorize,statusReason,check};
