# `core/providers/`: subscription and API connections

The Start page has a subscription/API section in addition to the existing nine service presets. This fork keeps Cortico's agent, memory and tool loop. Connecting a model does not add Codex shell tools, grant filesystem access, or change computer-use permissions.

## ChatGPT subscriptions

1. Choose **ChatGPT subscription** and **Sign in with ChatGPT**. The app opens the system browser. Review and authorize the requested access there.
2. Return to Coopanion, choose a model from that account's catalog, then select **Test & activate**. The test consumes a small amount of plan usage; successful sign-in alone does not verify model access.
3. Use **Sign out**, **Use selected account**, or **Use another account** to manage accounts. Declining plan usage leaves identity sign-in available but inference disabled. **Enable subscription usage** explicitly asks for consent again.

This uses Coopanion's own dynamic registration and the public OpenAI Responses endpoint, not a copied Codex/OpenCode client identity or ChatGPT's private backend endpoints. Account eligibility, models and allowances are determined by OpenAI. The current documented public flow is for eligible open-source/local integrations; paid or remotely hosted distributions must use OpenAI's applicable registration route. It is a preview and may change.

Calls always stream with local history and `store:false`. Supported local function tools are namespaced; model text and image support follow the account catalog. Hosted tools and unsupported generation controls are not enabled. A failed, interrupted or incomplete response is not a successful connectivity test. Authentication and plan-limit failures pause the active connection. An explicit successful retest can enable it again; the app never switches to a paid API key automatically. Inspect the provider's usage page for allowance and billing details.

OAuth access/refresh/ID tokens and account mapping are encrypted at rest with Electron `safeStorage` in `<app data>/credentials`. Only private Core-to-main IPC can access this broker; the renderer receives account labels and status. macOS uses Keychain, Windows uses DPAPI, and Linux requires a supported secret store. Linux `basic_text` and unavailable encryption fail closed. This protection does not sandbox arbitrary code running as the same OS user; Windows DPAPI in particular is not protection from other processes under that user. This fork is ad-hoc signed on macOS, so different builds may trigger a Keychain access prompt. API-key connections retain Cortico's existing endpoint `.env` storage.

Sign-out removes this account's local tokens and attempts remote revocation. If revocation cannot be confirmed, the UI reports that; revoke access in the provider account as needed. The app retains the non-token registration/account mapping for reauthentication. Canceling a sign-in or closing its settings page invalidates that pending callback; shutdown drains pending secure writes.

## xAI and custom API connections

The xAI tab uses the official xAI API endpoint with an API key. API billing is separate from a Grok subscription. Grok subscription sign-in remains disabled until Coopanion has a supported own-application registration; another project's OAuth client ID is not used.

The custom tab supports:

- OpenAI Responses
- OpenAI Chat Completions
- Anthropic Messages

Enter the provider's documented base URL, API key and model. Remote endpoints require HTTPS; loopback HTTP is allowed. Select the correct protocol rather than changing only a URL path. Enable custom image input only when the selected model documents it. Some endpoints do not implement a model catalog; a failed catalog request does not prevent manually entering a model for an explicit connection test.

Protocols share cancellation, complete-tool-call validation and usage reporting. Requests reject redirects to avoid forwarding keys or conversation content to another endpoint. SIWC inference is single-attempt; it does not automatically replay quota, entitlement or stream errors. Ordinary API connections can renew credentials once before any output, but no failed generation silently changes providers or billing modes.

## OpenCode Go

Go is intended for coding-agent tasks. This app currently runs a continuous companion loop, so Go configuration, testing and activation are disabled in that loop. The code includes Go's documented model-to-protocol routing for a future isolated coding-task integration; this is preparation, not usable Go support. A checkbox cannot make ambient companionship traffic a coding task.

Go has service-managed allowances and billing settings, including potential use of a separate balance. Do not assume unlimited or permanently free usage. No automatic Go-to-Zen fallback is implemented here.

## Verification

Offline tests mock OAuth discovery, signed ID tokens, callback handling, model catalogs and inference streams. They cover wrong/replayed state, token validation, grant denial, refresh rotation/concurrency, cancel/logout/account-switch races, OS-store rejection, all three protocols, incomplete tool calls, screenshot inputs, stream cancellation, UI repeated actions, and hidden/unmounted polling. Existing pet and computer-use tests remain part of the regression suite.

Before release, perform user-authorized native smoke tests on each supported OS: first sign-in and denied consent; restart with protected credentials; refresh and logout; switch accounts; a complete tool loop with a screenshot; cancel during streaming; reject a computer-use permission request. Real OAuth registration, account entitlement, provider compatibility and macOS/Windows keychain dialogs have not been verified by the offline tests.

Current reference documents (checked 2026-10-08):

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
- [Errors and recovery](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)
- [OpenCode Go](https://opencode.ai/docs/en/go/)
- [Anthropic Messages streaming](https://platform.claude.com/docs/en/build-with-claude/streaming)
- [Electron protected storage](https://www.electronjs.org/docs/latest/api/safe-storage)
