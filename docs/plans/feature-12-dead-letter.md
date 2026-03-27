# Feature: Dead-Letter Queue (Job Retry)

## Summary

Adds retry configuration to BullMQ jobs so transient failures (OpenAI timeout,
DB blip) are retried before the job is moved to the dead-letter queue.

## Scope

**In scope:**
- Add `attempts: 2` and exponential backoff to `publishInferredMemory` job options in `queue-client.js`

**Out of scope:**
- Dead-letter queue consumer
- Alerting on failed jobs

## Acceptance Criteria

- [ ] Jobs are retried up to 2 times on failure
- [ ] Backoff is exponential starting at 5 seconds
- [ ] Failed jobs after retries move to BullMQ's built-in failed set

## Tasks

1. [x] Add `{ attempts: 2, backoff: { type: 'exponential', delay: 5000 } }` to `q.add()` in `queue-client.js`

## Dependencies

- Feature #5 — queue-client.js exists

## Open Questions

_(none)_
