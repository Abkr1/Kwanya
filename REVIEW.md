# Code Review: Kwanya - Hausa Conversational AI

**Reviewer**: Claude
**Date**: 2026-02-07
**Scope**: Full-stack review (backend, frontend, tests)

## Overview

Kwanya is a full-stack conversational AI application for Hausa language speakers, built with a React Native (Expo) frontend and FastAPI backend. It integrates Hausa ASR (Abkrs1/Hausa-ASR-copy), Google Gemini for chat, and TWB Voice TTS (CLEAR-Global/TWB-Voice-Hausa-TTS-1.0).

The concept is strong and addresses a real need for Hausa-language AI tools. However, there are significant issues across security, correctness, and code quality that need to be addressed before production use.

---

## Critical Issues

### 1. User identity is not persistent
**File**: `frontend/app/index.tsx:74`

```ts
const [userId] = useState('user-' + Date.now());
```

A new `userId` is generated on every app launch. Users lose all conversation history when they restart the app. This should use `AsyncStorage` or a proper auth system to persist identity.

### 2. TTS playback is commented out
**File**: `frontend/app/index.tsx:488-491`

```ts
// if (!isCancelled) {
//   await playTextToSpeech(response.data.response);
// }
```

The text-to-speech response feature is entirely disabled. The TTS infrastructure exists but the call is commented out, meaning users never hear audio responses.

### 3. Text messages are never saved to the database

The `sendTextMessage` function adds the user message to local UI state but never calls an API to persist it. Only voice messages get saved (via the `/speech-to-text` endpoint). The `/chat` endpoint only saves the assistant's response. Text conversation history is lost on reload.

### 4. No authentication or authorization

All API endpoints are completely open. Anyone can read, create, or delete any user's conversations by guessing or enumerating user IDs. There is no auth middleware, JWT validation, or session management.

### 5. CORS allows all origins
**File**: `backend/server.py:649`

```python
allow_origins=["*"]
```

Permits any website to make requests to the API. Should be restricted to known frontend origins.

---

## Backend Issues

### 6. Deprecated FastAPI lifecycle events
**File**: `backend/server.py:621, 655`

`@app.on_event("startup")` and `@app.on_event("shutdown")` are deprecated. Use the `lifespan` context manager pattern.

### 7. Deprecated Python APIs
- `datetime.utcnow()` deprecated as of Python 3.12 — use `datetime.now(timezone.utc)` (server.py:223, 232, etc.)
- `.dict()` deprecated in Pydantic v2 — use `.model_dump()` (server.py:363, 425, 538)
- `asyncio.get_event_loop()` deprecated — use `asyncio.get_running_loop()` (server.py:342, 483, 627)

### 8. Bare except clause
**File**: `backend/server.py:353`

```python
except:
    pass
```

Swallows all exceptions including `KeyboardInterrupt` and `SystemExit`. Use `except OSError:` for file cleanup.

### 9. Temp file resource leak
**File**: `backend/server.py:149`

`twb_temp_config` is created with `delete=False` but never cleaned up on shutdown.

### 10. Health check MongoDB status is misleading
**File**: `backend/server.py:598`

`"connected" if client else "disconnected"` always shows "connected" because `client` is always a truthy `AsyncIOMotorClient` object, even if the database is unreachable.

### 11. No input validation on TTS text length

Users can submit extremely long text to `/text-to-speech`, consuming significant compute resources.

### 12. No rate limiting

All endpoints can be called without limits.

### 13. Audio cache grows unboundedly

No TTL index or eviction policy on the `audio_cache` MongoDB collection.

### 14. Inline import
**File**: `backend/server.py:320`

`import subprocess` is inside the endpoint handler instead of at the top of the file.

---

## Frontend Issues

### 15. Stale closure bug on cancellation check
**File**: `frontend/app/index.tsx:475`

```ts
if (isCancelled) return;
```

References a stale closure value because `isCancelled` is React state. Inside an async function, it captures the value at call time, not the current value. Should use a `useRef` instead.

### 16. AnimatedTouchableOpacity recreated every render
**File**: `frontend/app/index.tsx:91`

```ts
const AnimatedTouchableOpacity = Animated.createAnimatedComponent(TouchableOpacity);
```

Called inside the component body, creating a new component type on every render. Causes React to unmount/remount the element each time. Move outside the component.

### 17. StyleSheet.create() called every render
**File**: `frontend/app/index.tsx:629`

All styles are recreated on every render because `StyleSheet.create` is inside the component function. Move outside or memoize.

### 18. Duplicate style keys
**File**: `frontend/app/index.tsx:876-897` vs `1080-1097`

`emptyContainer`, `emptyText`, and `emptySubtext` are defined twice in the same `StyleSheet.create()` call. The second definitions silently overwrite the first.

### 19. Duplicated input area JSX
**Lines**: 1286-1335 and 1404-1454

The entire input area (text input + mic button + send button + recording indicator) is copy-pasted between the empty state and the messages state. Extract into a reusable component.

### 20. Stale refs in useEffect cleanup
**File**: `frontend/app/index.tsx:112-125`

The cleanup function references `recording` and `sound` state variables, but the `useEffect` has an empty dependency array `[]`. The cleanup always captures the initial `null` values.

### 21. Excessive `any` type usage
**Lines**: 365, 401, 494, 545

TypeScript type safety is bypassed in several places: audio file object, error handlers, and playback status.

### 22. Monolithic single-file frontend

All 1,460 lines of UI, state, API calls, audio handling, and styling live in one file. Decompose into components, hooks, and service modules.

---

## Test Issues

### 23. Tests are out of sync with the backend

`backend_test.py` checks for 3 TTS speakers and a `tts_speakers` field in the health response, but the backend was refactored to use a single fixed speaker (`spk_f_1`). Tests will fail.

### 24. Missing test coverage

No tests for the `/chat` endpoint, `DELETE` conversation endpoint, or the `GET` messages endpoint in the actual test run.

### 25. Hardcoded test URL

Base URL points to a specific preview environment rather than being configurable via environment variable.

---

## Architecture Observations

- No error boundaries in the frontend — unhandled errors crash the entire app
- No offline support or graceful degradation when the backend is unreachable
- No pagination — conversations capped at 100, messages at 1000, loaded all at once
- No retry logic on network requests from the frontend
- Global mutable state for ML models in the backend is not thread-safe

---

## What's Done Well

- Clean, minimal UI design with proper dark/light theme support and system preference detection
- Proper audio mode configuration for iOS/Android differences
- Good use of thread pool executors to avoid blocking the async event loop with ML inference
- TTS audio caching in MongoDB to avoid redundant synthesis
- `torch.inference_mode()` and `torch.compile()` optimizations for TTS performance
- Animated sidebar with proper mount/unmount lifecycle
- Model warmup on startup to avoid cold-start latency
- Well-structured REST API with clear endpoint naming

---

## Summary

| Category | Issues |
|----------|--------|
| Critical | 5 |
| Backend | 9 |
| Frontend | 8 |
| Tests | 3 |
| **Total** | **25** |

The app has a solid foundation and a compelling use case. The primary focus should be on: (1) fixing user identity persistence, (2) re-enabling TTS playback, (3) persisting text messages to the database, and (4) adding basic authentication before any production deployment.
