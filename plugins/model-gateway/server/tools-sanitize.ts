// Tool-type sanitisation for protocol passthrough.
//
// Codex-family agents emit tool entries the OpenAI spec allows but many
// OpenAI-compatible upstreams reject at JSON-deserialise time (e.g. Agnes:
// "tools[8].type: unknown variant namespace"). Vendors that speak real
// Responses endpoints accept the full set; the ones behind generic OpenAI
// compat layers only know function / web_search_preview / code_interpreter /
// mcp. Rather than hard-failing per upstream we normalise the payload:
//   - unwrap wrapper entries (namespace / custom / local_shell / …) that
//     carry a `function` inside
//   - drop wrapper entries without an inner function
//   - keep known spec types untouched

// Folded tool text is clamped to this budget. Some agents inline binary
// payloads into tool results — codex's view_image stuffs whole images into
// function_call_output as base64 (~1.6MB for a 1.3MB PNG). Strict upstreams
// (Agnes/litellm) accept the JSON but die mid-stream with
// "Response API in-stream error" (in-stream 500, no response.completed) on
// megabyte-scale message text, poisoning every retry of that session.
const MAX_FOLDED_TOOL_TEXT = 8000;

const clampText = (s: string): string =>
  s.length <= MAX_FOLDED_TOOL_TEXT
    ? s
    : `${s.slice(0, MAX_FOLDED_TOOL_TEXT)}…[truncated, ${s.length} chars total]`;

const KNOWN_TOOL_TYPES = new Set([
  "function",
  "web_search_preview",
  "web_search",
  "code_interpreter",
  "mcp",
  "computer_use_preview",
  "bash",
]);

export function sanitizeResponsesTools(body: Record<string, unknown>): { tools: unknown[]; removed: string[] } {
  const tools = body.tools;
  if (!Array.isArray(tools)) return { tools: [], removed: [] };
  const out: unknown[] = [];
  const removed: string[] = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (KNOWN_TOOL_TYPES.has(type)) {
      out.push(t);
      continue;
    }
    if (typeof o.function === "object" && o.function) {
      // Wrapper entry: surface the inner function definition instead.
      const inner = o.function as Record<string, unknown>;
      const fn = typeof inner.function === "object" && inner.function
        ? (inner.function as Record<string, unknown>)
        : inner;
      out.push({
        type: "function",
        name: fn.name ?? o.name,
        description: fn.description ?? "",
        parameters: fn.parameters ?? { type: "object", properties: {} },
      });
      removed.push(`unwrap:${type || "(none)"}`);
      continue;
    }
    removed.push(`drop:${type || "(none)"}`);
  }
  return { tools: out, removed };
}

// Anthropic Messages tools are always {name, description, input_schema}; the
// only foreign shape that can leak in is OpenAI-style {type:"function",
// function:{…}} from clients that conflate the two — normalise those.
export function sanitizeAnthropicTools(body: Record<string, unknown>): { tools: unknown[]; changed: boolean } {
  const tools = body.tools;
  if (!Array.isArray(tools)) return { tools: [], changed: false };
  const out: unknown[] = [];
  let changed = false;
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    if (o.type === "function" && o.function && typeof o.function === "object") {
      const fn = o.function as Record<string, unknown>;
      out.push({
        name: fn.name ?? o.name,
        description: fn.description ?? "",
        input_schema: fn.parameters ?? { type: "object", properties: {} },
      });
      changed = true;
      continue;
    }
    out.push(t);
  }
  return { tools: out, changed };
}


// Sanitize the Responses `input` array for upstreams that only accept
// message entries. Conversation-history artifacts Codex sends back
// (reasoning traces, function_call / function_call_output pairs,
// item_reference) crash strict deserialisers with json_parse_error.
// Strategy per entry type:
//   message      → keep (normalise foreign content parts to text)
//   function_call_output → fold into a user message "tool result" so the
//                          model still sees the outcome
//   function_call → fold into an assistant message describing the call
//   reasoning     → drop (thinking traces are not actionable upstream)
//   anything else → drop
export function sanitizeResponsesInput(body: Record<string, unknown>): { input: unknown; changed: boolean; removed: string[] } {
  const input = body.input;
  const removed: string[] = [];
  if (typeof input === "string") return { input, changed: false, removed };
  if (!Array.isArray(input)) return { input, changed: false, removed };

  const out: Array<Record<string, unknown>> = [];
  let dirty = false;
  const pushText = (role: string, text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      (last.content as Array<Record<string, unknown>>).push({ type: role === "assistant" ? "output_text" : "input_text", text });
    } else {
      out.push({ type: "message", role, content: [{ type: role === "assistant" ? "output_text" : "input_text", text }] });
    }
  };

  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const type = typeof o.type === "string" ? o.type : "";
    if (type === "message") {
      // Normalise content parts: keep input_text / output_text, stringify
      // anything else (input_image etc. become "[image]" placeholders).
      // Strict upstreams also reject messages without an explicit role and
      // content arrays containing bare strings — patch both shapes.
      const rawRole = o.role;
      let role = typeof rawRole === "string" ? rawRole : "user";
      // OpenAI's `developer` role (newer synonym for system) is rejected by
      // strict/GLM upstreams that only accept user/assistant/system/root —
      // normalise it to `system` so the request is portable across providers.
      if (role === "developer") role = "system";
      if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
        role = "user";
      }
      if (rawRole !== role) dirty = true;
      if (o.content === null || o.content === undefined) {
        dirty = true;
        continue; // empty message would also fail deserialisation
      }
      if (typeof o.content === "string") {
        dirty = true;
        pushText(role, o.content);
        continue;
      }
      if (Array.isArray(o.content)) {
        // An empty content array is rejected by strict /v1/responses upstreams
        // in *every* form ("non-empty array" / "text is required" / "must not
        // be empty"). A plain empty message carries no information, so drop it;
        // keep it with a non-empty placeholder only if it also carries payload
        // fields (tool calls).
        if (o.content.length === 0) {
          const hasPayload = o.tool_calls != null || o.function_call != null;
          dirty = true;
          if (hasPayload) out.push({ ...o, content: " " });
          continue;
        }
        const parts: Array<Record<string, unknown>> = [];
        let foreign = false;
        for (const c of o.content) {
          if (typeof c === "string") {
            parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: c });
            foreign = true;
            continue;
          }
          if (c && typeof c === "object") {
            const ct = (c as Record<string, unknown>).type;
            if (ct === "input_text" || ct === "output_text" || ct === "text") {
              parts.push({ type: ct === "text" ? "input_text" : ct, text: (c as Record<string, unknown>).text ?? "" });
            } else {
              parts.push({ type: role === "assistant" ? "output_text" : "input_text", text: `[${String(ct ?? "content")}]` });
              foreign = true;
            }
          }
        }
        if (foreign) {
          dirty = true;
          out.push({ type: "message", role, content: parts });
        } else {
          // Keep the entry but ensure the normalised role is present on it —
          // strict upstreams reject role-less messages.
          out.push(rawRole === role ? (item as Record<string, unknown>) : { ...item, role });
        }
        continue;
      }
      out.push(item as Record<string, unknown>);
      continue;
    }
    if (type === "function_call_output") {
      pushText("user", `tool result (${String(o.call_id ?? "")}): ${clampText(typeof o.output === "string" ? o.output : JSON.stringify(o.output ?? ""))}`);
      removed.push("function_call_output");
      continue;
    }
    if (type === "function_call") {
      pushText("assistant", `tool call ${String(o.name ?? "")}(${clampText(String(o.arguments ?? ""))})`);
      removed.push("function_call");
      continue;
    }
    // reasoning / item_reference / anything unrecognized
    removed.push(type || "unknown");
  }
  if (out.length === 0) {
    out.push({ type: "message", role: "user", content: [{ type: "input_text", text: "" }] });
    dirty = true;
  }
  return { input: out, changed: dirty || out.length !== input.length || removed.length > 0, removed };
}

// Lightweight, semantics-preserving normalisation of a Responses `input`.
// Strict /v1/responses upstreams reject a `message` item whose `content` is
// empty in *any* form:
//   - `content: []`   -> "message content must be a string or non-empty array"
//   - `content: ""`   -> "message content must not be empty"
//   - empty text part -> "text is required"
// A plain message with empty content carries no information, so it is dropped;
// a message that also carries payload fields (tool_calls / function_call) is
// kept with a non-empty placeholder. Native function_call / function_call_output
// / reasoning items are untouched. Unlike sanitizeResponsesInput (which folds
// reasoning/function items into text and destroys continuity on strict
// OpenAI-compatible upstreams), this pass only touches empty `message` items,
// so it is safe to run up front on every Responses provider.
export function ensureInputContentValid(input: unknown): { input: unknown; changed: boolean } {
  if (typeof input === "string") return { input, changed: false };
  if (!Array.isArray(input)) return { input, changed: false };
  let changed = false;
  const out: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (!item || typeof item !== "object") {
      out.push(item as Record<string, unknown>);
      continue;
    }
    const o = item as Record<string, unknown>;
    if (o.type === "message") {
      const c = o.content;
      const contentEmpty =
        c == null ||
        (typeof c === "string" && c.length === 0) ||
        (Array.isArray(c) && c.length === 0);
      if (contentEmpty) {
        const hasPayload = o.tool_calls != null || o.function_call != null;
        changed = true;
        if (hasPayload) out.push({ ...o, content: " " });
        // else: drop the empty plain message
      } else {
        out.push(o);
      }
    } else {
      out.push(o);
    }
  }
  return { input: changed ? out : input, changed };
}
