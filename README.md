# Paseo Plugins

![Paseo](https://img.shields.io/badge/Paseo-%E2%89%A50.9.2-5B67F2?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=for-the-badge&logo=typescript&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-22C55E?style=for-the-badge)

Production-grade extensions for [Paseo](https://paseo.sh): a command center for your agent
workspace and a local model gateway that keeps provider traffic on your machine.

```text
┌──────────────────────────────────────────────────────────────────────┐
│                            Paseo Client                             │
└──────────────┬───────────────────────────────────────┬───────────────┘
               │                                       │
       ┌───────▼────────┐                     ┌────────▼─────────┐
       │    Paseo Hub   │                     │  Model Gateway   │
       │  control panel │                     │  provider panel  │
       └───────┬────────┘                     └────────┬─────────┘
               │ daemon RPC                            │ loopback HTTP
       ┌───────▼────────────────────────┐      ┌───────▼─────────────────┐
       │ Workspaces · Agents · Cron     │      │ OpenAI / Anthropic /    │
       │ Tokens · AI news               │      │ Google / Ollama / GLM   │
       └────────────────────────────────┘      └─────────────────────────┘
```

## Plugins

| Plugin | Purpose | Best for |
| --- | --- | --- |
| [`paseo-hub`](plugins/paseo-hub) | Mission control for workspaces, agents, schedules, token activity, and AI news. | Staying oriented across many Paseo workspaces. |
| [`model-gateway`](plugins/model-gateway) | OpenAI-compatible local gateway with routing, streaming, failover, caching, and telemetry. | Unifying multiple model providers behind one local endpoint. |

Both plugins are TypeScript-first, split client and daemon entries, use Paseo RPC with
Zod contracts, and target **Paseo 0.9.2 or newer**.

## Quick Start

Install from this repository:

```bash
paseo plugin install github:nillikechatchat/Paseo-plugins --subdir plugins/paseo-hub --ref main
paseo plugin install github:nillikechatchat/Paseo-plugins --subdir plugins/model-gateway --ref main
paseo plugin ls
```

Confirm each plugin is running, then open its surface from the Paseo sidebar:

```bash
paseo plugin logs paseo-hub
paseo plugin logs model-gateway
```

> Paseo plugins are trusted local code and can access files, processes, and the network.
> Review the source before installing it.

### Optional Integration

Paseo Hub news and host-guard panels stay dormant until explicitly configured:

| Plugin | Variable | Purpose |
| --- | --- | --- |
| Paseo Hub | `AIHOT_BASE_URL` | AIHOT-compatible REST endpoint for the news panel. |
| Paseo Hub | `AIHOT_ACTOR` | Optional user-agent suffix. |
| Paseo Hub | `HOST_GUARD_DB`, `HOST_GUARD_UNIT`, `HOST_GUARD_IPSET` | Enable read-only host guard state. |
| Paseo Hub | `HOST_GUARD_CONFIG`, `HOST_GUARD_CONTROL` | Enable explicit ban/unban actions. |
| Model Gateway | `MODEL_GATEWAY_HOST`, `MODEL_GATEWAY_PORT` | Override the daemon-side loopback listener. |

## Security Model

- Provider credentials are configured at runtime and stored under your local Paseo cache.
- The model gateway binds to loopback by default; provider keys are represented as boolean
  availability in UI state rather than returned in plaintext.
- No provider key, token, password, personal path, or private data is committed.
- Review plugin source before installation and keep the gateway bind address private unless
  you add your own access control.

## Repository Layout

```text
plugins/
  paseo-hub/
    index.client.tsx       # Paseo client entry
    index.server.ts        # Paseo daemon entry
    client/                # UI surfaces and sections
    server/                # RPC handlers and integrations
    shared/                # Zod RPC contracts
  model-gateway/
    index.client.tsx       # Paseo client entry
    index.server.ts        # Gateway daemon server
    client/                # Provider and telemetry UI
    server/                # Routing, adapters, cache, persistence
    shared/                # RPC and transport contracts
```

## Development

Each plugin is self-contained:

```bash
cd plugins/paseo-hub
npm install
npm run typecheck

cd ../model-gateway
npm install
npm run typecheck
npm test
```

After changing plugin source, use Paseo's plugin reload workflow rather than restarting the
daemon:

```bash
paseo plugin reload <plugin-id>
paseo plugin logs <plugin-id>
```

## Publishing Contract

- `paseo-plugin.json` declares the runtime ID and minimum Paseo version.
- Client entries run inside the Paseo application.
- Server entries run in a daemon subprocess.
- `files` in each `package.json` limits npm-package content to source and manifests.
- Dependency versions align with Paseo 0.9.2.

## License

[MIT](LICENSE)
