# Agent Run Streaming Transport Research

Research date: 2026-07-14. Sources are limited to official documentation, web standards, and the installed source of the repository's declared dependencies.

## Recommendation

For the first Agent Run endpoint, use one **`POST /api/agent-runs` request whose response body is streamed and consumed with `fetch`**. Encode a small, versioned application event protocol as newline-delimited JSON (NDJSON) or another explicitly framed format; do not expose raw LangGraph events as the public wire contract.

For the TS-to-Python runtime boundary, use the same design principle internally: HTTP `POST` with a
streaming response, preferably `application/x-ndjson` while the worker protocol is already NDJSON.
That internal API is service-to-service and must carry worker protocol events, not the
browser-facing product stream.

Create the Agent Run before committing the response headers, then return its opaque ID in `X-Agent-Run-Id` and as the first `run.started` body event. `fetch()` fulfills when headers arrive, before the whole body is received, so the frontend can record the ID and begin rendering chunks immediately. The existing repository-owned assistant-ui `ChatModelAdapter` already receives an `AbortSignal`; pass it directly to `fetch` and iterate the decoded response body. assistant-ui requires each adapter yield to contain the cumulative message content, rather than a token delta.

This is a transport decision for the development-only Telemetry Harness, not a promise about product graph events or durable reconnect/resume.

## Why This Fits The Repository

- The frontend already has a repository-owned `ChatModelAdapter` in `apps/web/src/lib/assistant-runtime.ts`; its `run` method receives an `AbortSignal` and already stops its local generator when it is aborted. The installed assistant-ui definition confirms that `abortSignal` is part of `ChatModelRunOptions`; its official LocalRuntime guide demonstrates forwarding it to a streaming provider and yielding cumulative content ([assistant-ui LocalRuntime](https://www.assistant-ui.com/docs/runtimes/custom/local-runtime)).
- `fetch` supports a JSON request body with `POST`; its `Response.body` is a `ReadableStream`, which can be decoded and consumed incrementally with `for await...of`. The initial `Response` is available as soon as headers arrive, so a server-generated Agent Run Identifier can be read before body events ([MDN Fetch: request bodies](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#setting_a_body), [response streaming](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch#streaming_the_response_body)).
- Hono provides `stream()` for a streaming `Response` and exposes `stream.onAbort()` to observe client disconnect. Its `streamSSE()` helper is also available, but its own example uses a `GET` stream ([Hono streaming helper](https://hono.dev/docs/helpers/streaming)).
- LangGraph exposes in-process async streams for token messages, state updates, tools, and application-defined events. A server adapter can map only safe, UI-relevant projections to the public protocol: `messages` for user-visible output, `tools` for lifecycle status, and `custom` only for deliberately defined application events ([LangGraph streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming)).

## Transport Comparison

| Option                         | Streamed agent output                                                          | Stop and disconnect                                                                                  | Error model                                                                                                                                                         | Early Agent Run Identifier                                                                      | Verdict                                                                                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Ordinary `POST` then JSON      | No; response arrives after the work completes.                                 | `AbortController` can cancel the HTTP request, but no partial output is available.                   | Use HTTP status and JSON error body.                                                                                                                                | In a normal response header/body, but only when work completes unless the API becomes two-step. | Keep for short, non-streaming commands. Not the primary Agent Run interaction.                                                                                                                               |
| **Streaming `POST` + `fetch`** | Yes; browser code reads `Response.body` incrementally.                         | The adapter's `AbortSignal` cancels `fetch`; Hono observes a disconnect with `stream.onAbort()`.     | Validate and return ordinary HTTP errors before streaming starts. After it starts, send a terminal `run.failed` event because the HTTP status can no longer change. | Return `X-Agent-Run-Id` in the initial headers and duplicate it in `run.started`.               | **Choose for the first endpoint.** One request, JSON input, one cancellation path, no second connection.                                                                                                     |
| Browser `EventSource` SSE      | Yes, server to browser only.                                                   | `.close()` aborts the EventSource fetch. Browsers reconnect by default and can send `Last-Event-ID`. | Errors surface through `onerror`, which does not by itself convey a structured terminal run error.                                                                  | Natural after a prior creation request, or in a URL query.                                      | Do not choose for the first endpoint: the standard constructor accepts a URL and options, not a JSON `POST` body. It therefore pushes the design toward separate create and subscribe requests.              |
| WebSocket                      | Yes, bidirectional messages.                                                   | Explicit close events on both sides; Hono offers `onClose` and `onError`.                            | Define application error/close frames.                                                                                                                              | Send a server frame immediately after connection or after a `start` message.                    | Defer. It is warranted for genuine bidirectional work while a run is live, such as user interrupts or collaboration, but that is not yet in scope. The browser's stable `WebSocket` API has no backpressure. |
| Polling                        | No token-by-token output unless the server persists chunks for repeated reads. | Cancel needs another endpoint or a final request.                                                    | Each poll uses ordinary HTTP semantics.                                                                                                                             | Creation response can return it immediately.                                                    | Defer. Useful later for durable status/recovery, not for the interactive first run.                                                                                                                          |

The browser APIs behind the table are intentionally different: SSE is a one-way server-to-client connection with automatic reconnection ([MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events), [HTML Standard EventSource processing](https://html.spec.whatwg.org/multipage/server-sent-events.html)); WebSocket is a two-way interactive session but its established `WebSocket` interface lacks backpressure ([MDN WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)); and `fetch` permits a `POST` body while exposing an incrementally readable response ([MDN Fetch](https://developer.mozilla.org/en-US/docs/Web/API/Fetch_API/Using_Fetch)).

## Proposed First Wire Contract

```text
POST /api/agent-runs
Content-Type: application/json
Accept: application/x-ndjson

{"message":"..."}

200 OK
Content-Type: application/x-ndjson
X-Agent-Run-Id: ar_opaque

{"version":1,"type":"run.started","agentRunId":"ar_opaque"}
{"version":1,"type":"message.delta","text":"..."}
{"version":1,"type":"run.completed"}
```

The concrete event names and payload schema remain to be specified. The invariant is smaller: one Agent Run ID in headers and the first event; only metadata-safe diagnostic fields in telemetry; and exactly one terminal event of `run.completed`, `run.failed`, or `run.cancelled` when the server can determine it.

Use an HTTP error response for failures detected before the stream starts, such as malformed input. Once a Hono stream has started, Hono cannot replace the response through its normal `onError` hook, so the application protocol must carry an in-stream terminal failure event ([Hono streaming error handling](https://hono.dev/docs/helpers/streaming#error-handling)).

## Cancellation Is A Separate Contract

`AbortController.abort()` cancels `fetch`, response-body consumption, and streams ([MDN AbortController](https://developer.mozilla.org/en-US/docs/Web/API/AbortController)). Hono's `stream.onAbort()` then lets the API observe that the client disconnected. These facts do **not** guarantee that an in-process graph, model request, or tool call has stopped: the API must propagate a server-side cancellation signal to every cancellable boundary and wait for its terminal result before recording `cancelled`.

For the Telemetry Harness, make cancellation deterministic: the fixture should observe this signal, stop its controlled work, emit/record `cancelled`, and close the response. A disconnect that cannot stop already-running work needs an explicit future policy; it must not silently be represented as a confirmed cancellation.

## Deferred Concerns

- **Reconnect and resume:** a one-shot fetch stream is intentionally transient. Add a persisted event sequence and a `GET` run-events endpoint only when the product needs reconnectable runs. SSE's `Last-Event-ID` mechanism becomes useful at that point.
- **Cross-origin deployment:** if the web app and API are placed on different origins, expose `X-Agent-Run-Id` through CORS before the browser can read it.
- **Concurrent user input, human approvals, or collaboration:** reconsider WebSocket or a durable event protocol when the client must send meaningful messages during a live run.
- **Business graph design:** this transport can map the current generic LangGraph wrapper's stream, but must not define future graph nodes, prompts, tools, or state.
