# claude-context-sync v0.2.1 설계 리뷰 및 리팩토링

## 배경

v0.2.0 배포 후, 동작은 하지만 특정 상황에서 기능이 제대로 동작하지 않는 설계적 사이드이펙트를 발견했다. 코드 레벨이 아닌 아키텍처 레벨에서 "이 기능이 실패하는 시나리오"를 분석하고, 사전에 리팩토링을 진행했다.

---

## 1. `claude -p` 타임아웃 부재

### 문제
`generator.ts`의 `callClaude`에 타임아웃이 없었다. `claude -p`가 hang하면 MCP 도구 호출 자체가 무한 대기하며, `refreshIfNeeded`의 catch 블록에도 도달하지 못한다.

### 발생 시나리오
- 네트워크 불안정 상태에서 Haiku API 호출
- Claude CLI 업데이트 중
- 대용량 프롬프트로 인한 처리 지연

### 기존 설계
```typescript
execFile("claude", [...], { maxBuffer: 10MB }, callback);
// timeout 옵션 없음 → 무한 대기 가능
```

### 변경 설계
```typescript
execFile("claude", [...], { maxBuffer: 10MB, timeout: 30_000 }, callback);
// 30초 후 SIGTERM → error callback → refreshIfNeeded catch → 캐시된 요약 반환
```

Node.js `execFile`의 네이티브 `timeout` 옵션을 사용. 타임아웃 시 자식 프로세스가 SIGTERM으로 종료되고, error callback이 호출되어 기존 catch 로직으로 graceful fallback된다.

---

## 2. `get_all_changes`의 동시 `claude -p` 폭주

### 문제
`server.ts`의 `get_all_changes`가 `Promise.all`로 모든 stale 세션에 대해 동시에 `claude -p`를 호출했다. 세션이 많을수록 시스템 리소스 과점유 및 API rate limit 위험.

### 발생 시나리오
- 5개 이상 프로젝트에서 병렬 세션 운영 중 `get_all_changes` 호출
- 모든 세션이 stale 상태일 때 5+ 개의 `claude -p` 동시 실행

### 기존 설계
```typescript
const summaries = await Promise.all(
  filtered.map((meta) => refreshIfNeeded(...))
);
// N개 세션 → N개 claude -p 동시 실행
```

### 변경 설계
```typescript
const CONCURRENCY_LIMIT = 3;

for (let i = 0; i < filtered.length; i += CONCURRENCY_LIMIT) {
  const batch = filtered.slice(i, i + CONCURRENCY_LIMIT);
  const results = await Promise.all(
    batch.map((meta) => refreshIfNeeded(meta.sessionId, meta)),
  );
  summaries.push(...results);
}
// 최대 3개씩 배치 처리
```

외부 라이브러리 없이 단순 배치 루프로 동시성을 3개로 제한. 시스템 부하를 예측 가능한 수준으로 유지하면서도 병렬 처리의 이점은 보존.

---

## 3. Scheduler 인메모리 상태 손실

### 문제
`scheduler.ts`의 `states` Map이 메모리에만 존재. MCP 서버 재시작(Claude Code 재실행) 시 모든 세션이 `lastMessageCount: 0`에서 시작하여 기존 Store에 요약이 있어도 무시하고 불필요한 full 요약을 재생성하거나, 반대로 한번도 요약되지 않은 세션에 대해 "cached"를 반환하여 null이 나올 수 있다.

### 발생 시나리오
1. Claude Code 종료 후 재실행 → MCP 서버 재시작
2. 이미 요약된 세션 → Scheduler가 모르므로 비용 낭비
3. 한번도 요약 안 된 세션 → `isStale: false`로 생성되어 "cached" 반환 → null

### 기존 설계
```typescript
// Scheduler.getOrCreate: 새 세션 → isStale: false, lastMessageCount: 0
// refreshIfNeeded: getStrategy 직접 호출 → Scheduler 상태에만 의존
```

### 변경 설계
```typescript
// Scheduler에 seedState 메서드 추가
seedState(sessionId, messageCount, incrementalCount): void

// refreshIfNeeded에서 첫 접근 시 Store에서 복구
if (!scheduler.getState(sessionId)) {
  const existing = await store.readSummary(sessionId);
  if (existing) {
    scheduler.seedState(sessionId, messageCount, existing.incrementalCount);
  }
  scheduler.markStale(sessionId);
}
```

첫 접근 시 Store에 기존 요약이 있으면 Scheduler 상태를 복원(seed)한다.
- 기존 요약 있음 → `lastMessageCount = 현재 수`로 seed → `newMessages = 0` → "cached" → 기존 요약 반환 (비용 0)
- 기존 요약 없음 → `markStale` → 정상 요약 생성 흐름

---

## 4. `refreshIfNeeded` 동시 호출 Race Condition

### 문제
동일 세션에 대해 `get_session_context`와 `get_all_changes`가 동시 호출되면 같은 세션을 두 번 요약하고 `writeSummary`의 read-modify-write가 race한다.

### 발생 시나리오
- Claude Agent가 `list_sessions` 후 여러 세션에 대해 `get_session_context`를 빠르게 연속 호출
- `get_all_changes`와 `get_session_context`가 같은 세션을 동시에 refresh

### 기존 설계
```typescript
// refreshIfNeeded는 독립 함수, 호출 간 조율 없음
async function refreshIfNeeded(sessionId, meta, scheduler, store, watcher) { ... }
```

### 변경 설계
```typescript
// createServer 클로저 내부에 per-session lock
const refreshLocks = new Map<string, Promise<SessionSummary | null>>();

function refreshIfNeeded(sessionId, meta) {
  const inflight = refreshLocks.get(sessionId);
  if (inflight) return inflight;  // 진행 중이면 같은 Promise 재사용

  const promise = doRefresh(sessionId, meta);
  refreshLocks.set(sessionId, promise);
  return promise.finally(() => refreshLocks.delete(sessionId));
}
```

같은 세션에 대한 동시 호출은 첫 번째 호출의 Promise를 공유. 중복 `claude -p` 호출과 write race를 원천 방지. `finally`로 완료 후 lock 해제.

---

## 5. `parseSummaryJson`의 Greedy Regex

### 문제
`/\{[\s\S]*\}/` regex가 greedy라서 응답에 JSON이 여러 개 포함되면 첫 `{`부터 마지막 `}`까지 매칭하여 깨진 JSON을 파싱할 수 있다.

### 발생 시나리오
- Haiku가 "JSON만 출력하세요" 지시를 무시하고 설명 + JSON을 출력
- JSON 값 내부에 중괄호가 포함된 경우 (예: `"task": "fix {bug}"`)

### 기존 설계
```typescript
const jsonMatch = raw.match(/\{[\s\S]*\}/);
// greedy → 첫 { 부터 마지막 } 까지 전부 매칭
```

### 변경 설계
```typescript
function findFirstJsonObject(raw: string): string {
  let depth = 0, inString = false, escape = false;
  for (let i = start; i < raw.length; i++) {
    // 문자열 내부 중괄호 무시
    // depth 카운팅으로 첫 번째 완전한 JSON 객체 추출
    if (depth === 0) return raw.slice(start, i + 1);
  }
}
```

Balanced brace counting + 문자열 인식. JSON 값 내부의 `{}`를 무시하고, 정확히 첫 번째 완전한 JSON 객체만 추출한다.

---

## 6. `resolvePath`의 `~username` 오매칭

### 문제
`store.ts`의 `resolvePath`가 `startsWith("~")`로 체크하므로 `~admin/foo` 같은 경로도 매칭하여 현재 유저의 homedir로 치환한다.

### 발생 시나리오
- 설정 경로가 외부 입력으로 제공될 때
- 현재 기본값(`~/.claude/...`)에서는 미발생, 향후 설정 확장 시 위험

### 기존 설계
```typescript
path.startsWith("~") ? path.replace("~", homedir()) : path
// ~admin/foo → /Users/current-user/admin/foo (잘못된 경로)
```

### 변경 설계
```typescript
if (path === "~") return homedir();
return path.startsWith("~/") ? path.replace("~/", `${homedir()}/`) : path;
// ~admin/foo → ~admin/foo (변환하지 않음, 정확한 동작)
```

POSIX 표준의 `~/` 패턴만 매칭하도록 변경.

---

## 변경 파일 요약

| 파일 | 변경 내용 |
|------|----------|
| `src/summarizer/generator.ts` | callClaude에 30s timeout 추가, parseSummaryJson을 balanced brace 방식으로 교체 |
| `src/mcp/server.ts` | refreshIfNeeded를 createServer 클로저 내부로 이동, per-session lock 추가, scheduler 복구 로직 추가, get_all_changes 동시성 3개 제한 |
| `src/watcher/scheduler.ts` | seedState 메서드 추가 |
| `src/store/store.ts` | resolvePath를 `~/` 패턴만 매칭하도록 수정 |
| `tests/scheduler.test.ts` | seedState 테스트 2개 추가 |
| `tests/generator.test.ts` | parseSummaryJson 엣지케이스 테스트 2개 추가 |

## 검증

- TypeScript 타입체크 통과
- 45개 테스트 전부 통과 (기존 41 + 신규 4)
