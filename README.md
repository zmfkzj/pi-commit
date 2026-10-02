# pi-commit

pi coding-agent의 `/commit` 확장입니다. **변경 분석 → 단일/분할 커밋 계획 → 전체 미리보기 → 명시적 승인 → Git 커밋**을 제공합니다.

- 하나의 파일도 서로 다른 diff hunk를 여러 커밋으로 나눌 수 있습니다.
- 의존성 순서, 전체 변경의 정확히 한 번 선택, manifest/lockfile 묶음을 검증합니다.
- 선택적으로 Keep-a-Changelog `Unreleased` 항목을 생성·병합합니다.
- 실제 Git hook과 서명 설정을 사용하며, 실패 시 임의의 대체 커밋을 만들지 않습니다.

## 실행 / 로컬 설치

확인한 환경: **pi-coding-agent 1.0.0, pi-ai 1.0.0**, Node ≥22.19, Git, Bun 1.4.2.
런타임 TS는 pi가 로드하므로 빌드가 필요 없습니다. Bun은 개발/테스트용입니다.

먼저 원하는 Git 프로젝트 디렉터리에서 일회성으로 사용하세요:

```sh
pi -e /home/arthur/Code/pi-commit/src/index.ts
```

원하는 프로젝트에 로컬 등록하려면 (이 저장소 구현 과정에서는 실행하지 않았습니다):

```sh
pi install --local /home/arthur/Code/pi-commit
```

또는 해당 프로젝트의 `.pi/settings.json`에 설정합니다. 기존 설정은 병합하세요:

```json
{ "packages": ["/home/arthur/Code/pi-commit"] }
```

프로젝트 리소스는 pi의 프로젝트 신뢰 승인이 필요합니다. `/reload` 후 `/commit`을 사용합니다.
호스트 제공 pi 패키지는 peer dependency이며 번들에 포함하지 않습니다.

## 사용법

```text
/commit
/commit --dry-run
/commit --context "인증 수정과 문서 변경을 별도 커밋으로 나눠 주세요"
/commit --model provider/model-id --no-changelog
/commit --push
/commit --help
```

| 인자 | 의미 |
|---|---|
| `--dry-run` | 계획과 changelog diff만 표시. index/worktree/HEAD/remote를 변경하지 않음 |
| `--model provider/id` | 등록된 정확한 모델 선택. 생략하면 현재 `ctx.model` 사용 |
| `--context "내용"` | 분석·분할·메시지 작성에 추가 지시. 여러 단어는 따옴표 사용 |
| `--no-changelog` | 생성 changelog 비활성화. 기존 사용자 changelog 변경은 일반 변경으로 취급 |
| `--push` | 모든 계획 커밋 성공 후 현재 브랜치만 설정된 upstream으로 non-force push. 태그 포함 안 함 |
| `--yes` | 승인 대화상자를 건너뜀 (TUI/RPC/print 모두). 전체 미리보기는 먼저 출력하며, `--dry-run`과 함께 써도 쓰기는 없음 |
| `--help` | 도움말 |

`--model`은 pi 세션의 모델을 변경하지 않습니다. 인증/OAuth/header 처리는
`ctx.modelRegistry.streamSimple()`에 위임하며 키를 보관·출력하지 않습니다.
`/login`, `/model`, `models.json` 등 기존 pi 모델 설정을 사용하세요.

`--yes`가 없으면 TUI 및 RPC에서는 승인 대화상자가 필요하며, 취소/Escape/거절하면
저장소를 변경하지 않습니다. UI가 없는 print/JSON 모드에서는 `--yes` 없이 쓰기를 거부합니다.
`--yes`는 모든 모드에서 승인 대화상자를 건너뛰고 전체 미리보기 출력 직후 바로 실행합니다
(미리보기는 항상 먼저 표시되며, `--dry-run`은 `--yes`가 있어도 절대 쓰지 않음):

```sh
# 계획만 확인 (print의 확장 출력은 stderr)
pi -e /home/arthur/Code/pi-commit/src/index.ts -p '/commit --dry-run'

# 승인 대화상자 없이 쓰기를 의도적으로 승인한 경우만 사용 (비대화식 포함)
pi -e /home/arthur/Code/pi-commit/src/index.ts -p '/commit --yes --no-changelog'
```

JSON/RPC stdout에는 임의 텍스트를 쓰지 않으며, 미리보기·결과는 `pi-commit`
custom message로 전달합니다. print 모드는 stderr에도 출력합니다.
네이티브 `pi commit` 하위 명령은 제공하지 않습니다.

## 선택 및 안전 모델

1. staged 변경이 하나라도 있으면 **HEAD→index만** 계획합니다. 해당 파일의 unstaged
   수정이나 다른 untracked 파일을 몰래 포함하지 않습니다.
2. staged 변경이 없으면 tracked 수정과 nonignored untracked 파일을 읽기만 합니다.
   분석·미리보기에서 `git add`를 실행하지 않습니다.
3. 모든 계획 변경/hunk를 정확히 한 번 포함해야 합니다. 누락, 중복, 알 수 없는
   경로/hunk, 경로 탈출, 순환/알 수 없는 의존성, 잘못된 메시지를 거부합니다.
4. lockfile은 변경된 manifest와 같은 그룹에 포함합니다. 먼저 동일 디렉터리의
   manifest를 매핑 순서로, 없으면 매핑 이름·경로 정렬로 찾습니다. 대응 manifest가
   없으면 lockfile만 있는 별도 deps 그룹이 필요합니다. 대응 manifest 자체를 여러
   그룹으로 나누면 거부합니다. 자동으로 선택을 몰래 재배치하지 않습니다.
5. 전체 메시지/본문, 의존성 순서, 경로, 선택 hunk와 diff, 생성 changelog diff를
   표시한 뒤 승인받습니다. 모델이 커밋을 임의 실행할 수 없습니다.
6. HEAD, 실제 index bytes, 변경 diff와 tracked/nonignored worktree 내용의 fingerprint를
   실행 직전에 비교합니다. 생성 changelog 내용도 따로 재검사합니다.
7. 커밋별 임시 `GIT_INDEX_FILE`에 선택 내용만 구성하여 일반 `git commit`을 실행합니다.
   동일 파일의 다음 hunk는 이전 커밋의 위치 변화를 반영합니다. 실제 index의 아직
   커밋하지 않은 staged 내용과 worktree의 unstaged/제외 변경은 보존합니다.
8. 첫 커밋 이전 실패 시 원래 index와 생성 changelog를 복원합니다. hook/사용자가
   새로 수정한 changelog는 덮어쓰지 않습니다. 일부 커밋 성공 후 실패하면 즉시 중단하고
   성공 OID, 실패 그룹, 남은 그룹을 보고합니다. history reset/checkout/fallback 없음.
9. push는 `--push`가 있고 모든 계획 커밋이 성공했을 때만 수행합니다. 현재 브랜치를
   설정된 upstream remote/branch에 명시적인 non-force `HEAD:<upstream ref>`로 전송합니다.
   태그 follow, matching/mirror/force refspec 등 주변 push 설정은 비활성화합니다.
   서브모듈은 `--recurse-submodules=check`로 검사하여 참조한 커밋이 서브모듈 remote에 없으면
   거부하며, 서브모듈을 자동으로 push하지 않습니다. detached HEAD, 누락/모호/안전하지 않은 upstream이면 거부하며,
   non-fast-forward도 거부합니다. push 거부/실패를 보고하고 성공한 로컬 커밋은 그대로
   남겨 둡니다. history reset이나 자동 재시도는 하지 않습니다.

확장은 프로세스 내부에서 사용자 권한으로 동작합니다. Git hooks, signing 프로그램,
필터와 외부 프로세스는 신뢰한 사용자 코드이며 샌드박스가 아닙니다. hook이 파일/tree를
바꾸면 추가 그룹 실행을 중단할 수 있지만 그 사용자 변경을 강제 삭제하지 않습니다.
실행 중 crash/전원 장애까지 원자적인 다중 커밋 트랜잭션을 보장하지 않습니다.

## Changelog

모델이 사용자 영향이 있는 그룹에 `changelogEntry`를 제안한 경우에만 생성합니다.
root의 `CHANGELOG.md`/대소문자·하이픈 변형을 감지하며, 없으면 `CHANGELOG.md`를
미리보기로 제안합니다. `Added:`, `Fixed:` 등의 접두사를 지원하며 기본 카테고리는
`Changed`입니다. `Unreleased` 내 중복을 제거하고 기존 본문/버전 기록/개행 방식을
삽입 영역 밖에서 그대로 보존합니다. **최종 의존성 순서 그룹**에 전체 생성 항목을 포함합니다.

변경 중인 changelog (staged 모드에서 제외된 unstaged 수정 포함), ignored 대상,
symlink/non-UTF8 changelog는 자동 병합을 거부합니다. `--no-changelog`를 사용하거나
사용자 변경을 먼저 마무리하세요. dry-run에는 파일 생성·수정이 없습니다.

## 제약 및 검증 범위

- 새 파일/삭제/이름 변경/바이너리/모드 변경/서브모듈은 보수적으로 전체 파일 선택만 허용합니다.
  비UTF8 파일 내용도 whole-file-only입니다. 비UTF8 경로와 역슬래시 경로는 거부합니다.
- 계획 대상 내부에서는 전체 변경을 커버해야 합니다. 일부 hunk만 제외하려면 먼저 원하는
  내용만 사용자가 stage하세요. GUI식 체크박스 선택/메시지 편집기는 없으며 모델 계획을
  검토·취소 후 `--context`로 다시 생성합니다.
- 서브모듈 포인터 변경은 지원하지만 dirty-only 서브모듈은 먼저 내부 커밋을 요구합니다.
  index conflict는 먼저 해결해야 합니다.
- read-only 스냅샷에는 전체 tracked/nonignored 내용 hash 비용이 있습니다. 계획 증거는
  최대 1 MB, 모델 응답 검증은 최대 3회, 전체 모델 작업 제한은 기본 120초입니다.
- 단일 root changelog만 처리하며 monorepo 여러 changelog/release 배포는 지원하지 않습니다.
- legacy llm-git/backend/cache 및 upstream 전체 8400 LOC vendoring은 포함하지 않습니다.
- **실제 터미널 UI 조작, live LLM provider/OAuth 호출은 검증하지 않았습니다.**
  모델 응답은 deterministic mock으로 검사했습니다. public pi API 타입 검사 및
  실제 Node+jiti `DefaultResourceLoader` source-only 로딩은 통과했습니다.

## 개발 / 테스트

```sh
cd /home/arthur/Code/pi-commit
bun install --ignore-scripts
bun run typecheck
bun test
```

테스트는 `mkdtemp` Git 저장소와 로컬 bare remote만 사용합니다. 사용자의 프로젝트에
커밋하거나 push하지 않습니다. 주요 검증: staged/unstaged 보존, 빈 index 분석,
동일 파일 순방향/역방향 hunk 분할, 의존성/cycle/lockfile, 특수 경로, 신설/삭제/rename/
binary/mode/submodule, drift, dry-run/cancel/no-confirm, hook 첫/후속 실패,
changelog 보존·merge, 모델 실패/재시도, 공개 pi loader smoke.

주요 코드: `src/git/`, `src/plan/`, `src/changelog/`, `src/command/`, `src/ui/`.

## 라이선스 / 출처

MIT. oh-my-pi의 일부 프롬프트/분할 검증/changelog 개념을 고정 revision
`2a7db746ff9774180e2f81cc1f3fdd8c925269be`에서 선택적으로 재사용·적응했습니다.
독립적으로 원본 LICENSE를 조회·검증했습니다. 전체 upstream MIT 고지, 원본 경로,
license hash는 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)에 있습니다.
Git 엔진은 Rust backend 대신 별도로 작성한 안전한 TypeScript 구현입니다.
