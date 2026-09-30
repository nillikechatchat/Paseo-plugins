# Model Gateway

An OpenAI-compatible local gateway for Paseo. Route one provider endpoint across
OpenAI, Anthropic, Google, Ollama, Z.ai, Volcengine, or any OpenAI-compatible
upstream while keeping credentials and traffic on your machine.

## Highlights

- Local OpenAI-compatible API for chat completions, embeddings, models, and health checks.
- Model, priority, and weighted routing across multiple configured upstreams.
- Streaming translation and pass-through between OpenAI, Anthropic, and Google formats.
- Response caching, token-bucket rate limiting, retry/failover, and upstream sanitization.
- Per-request telemetry for latency, time-to-first-byte, token use, cache hits, and failures.
- Native Paseo panel for provider setup, model catalog, request inspection, cache control, and metrics.

## Install

```bash
paseo plugin install github:nillikechatchat/Paseo-plugins --subdir plugins/model-gateway --ref main
paseo plugin ls
paseo plugin logs model-gateway
```

Paseo plugins are trusted local code. Review source before installing it.

## Configuration

The daemon-side server starts automatically. Data is stored locally under
`~/.paseo/cache/model-gateway/`.

| Variable | Default | Description |
| --- | --- | --- |
| `MODEL_GATEWAY_HOST` | `127.0.0.1` | Bind address. Keep the loopback default unless you understand the network exposure. |
| `MODEL_GATEWAY_PORT` | dynamic | Fixed listening port. A fixed port is useful after wiring Paseo providers to the gateway. |

## Development

```bash
npm install
npm run typecheck
npm test
```
