# Warp Cloud Factory Demo 분석

참고 저장소: https://github.com/warpdotdev-demos/cloud-factory-demo

확인 기준: 2026-10-01, commit `ab21d0c5b70e38abe1a53ff6e2934d2637415c5b`. 아래 내용은 해당 소스·문서의 정적 분석이며 Oz 실행·유료 API·workflow 결과를 직접 검증하지 않았다.

## 확인한 구조

| 근거 | 확인 내용 |
| --- | --- |
| [README](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/README.md) | triage, spec, implementation, review, verification와 일일 리뷰 개선 흐름 설명. monitoring은 후속 단계 |
| [triage Skill](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.agents/skills/triage/SKILL.md) | ready-to-implement/spec, needs-info, wait-to-implement 중 하나를 구조화 반환, 호출자가 게시 |
| [spec Skill](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.agents/skills/spec/SKILL.md) | common-skills에 제품·기술 명세를 위임하고 PRODUCT.md·TECH.md의 PR을 작성 |
| [review workflow](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.github/workflows/review-pull-requests.yml) | trusted revision 기반 분석, annotated diff, review.json, 별도 publish job, base/head 변경 재확인 |
| [improve-review-pr Skill](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.agents/skills/improve-review-pr/SKILL.md) | 사람 피드백을 validated/corrected/refined/ambiguous로 분류, 지속 가능한 지식만 core/local review Skill PR로 제안 |
| [improvement workflow](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.github/workflows/improve-review-pr.yml) | 일일 schedule과 수동 실행, feedback corpus 수집, Oz 실행, 직접 자동 병합하지 않음 |
| [feedback collector](https://github.com/warpdotdev-demos/cloud-factory-demo/blob/ab21d0c5b70e38abe1a53ff6e2934d2637415c5b/.agents/skills/improve-review-pr/scripts/collect_review_feedback.py) | bot login·review marker·답변과reaction·키워드 기반 분류 도우미. 확정적 사용자 의도 판별로 간주하면 안 됨 |

## 질문했던 “Skill을 바꾸는 흐름”의 정확한 의미

이 데모에는 **자동 리뷰에 대한 사람의 반응을 모아 리뷰 Skill 개선 PR을 제안하는 외부 루프**가 있다. 모든 코드 코멘트를 자동으로 학습하거나 모든 작업 Skill을 변경하는 시스템이라고 확대 해석할 수는 없다. 변경이 일회성이면 no_changes로 끝낼 수 있고, 저장소별 지식은 local companion에 둔다. 변경 PR은 사람의 검토를 거친다.

이 자동화는 저장소의 Skill·GitHub Actions·Oz 실행 플랫폼이 함께 구성한 결과다. Codex 모델이 기본적으로 동일한 이벤트 감시와 영속적 자기 개선을 수행한다는 근거는 아니다.

## ArkWork에 반영할 패턴

- 단계와 결과 계약을 분리한다. 분류·리뷰 모델의 분석과 실제 GitHub 게시 권한을 나눈다.
- 명세가 큰 작업의 입력 계약이 되고 사용자 흐름별 검증 증거와 연결된다.
- 사람의 리뷰가 현재 구현 수정과 후속 규칙 개선에 모두 활용된다.
- core/local 규칙을 분리하고 no_changes를 정상 결과로 인정한다.
- 최신 커밋에 대한 리뷰·게시 검증을 수행한다.

## ArkWork에서 추가할 제품 기능

영속 작업·승인 상태, 모바일 웹 화면, 비용 예약과 상한, 재시도·취소·중복 방지, 공급자 adapter, 권한 있는 피드백과 실행 승인, 고정 Skill 버전·평가·복구, 접근 가능한 미리보기 상태를 앱의 책임으로 둔다. 데모 문서에서 이 기능을 모두 제공한다고 주장하지 않는다.

참고 저장소의 vision.md와 roadmap.md에는 텍스트 기반 이미지 편집기 방향도 포함되어 있다. 이것은 ArkWork의 제품 범위로 가져오지 않는다. 참고 대상은 Factory의 자동화 구조다.

## 라이선스와 적용 범위

원 저장소는 MIT License(Copyright 2026 Warp)다. 이번 문서는 동작 패턴을 분석하고 ArkWork 설계를 새로 작성했으며 원 Skill·workflow 코드를 복사하거나 설치하지 않았다. 후속 작업에서 코드를 가져오면 해당 코드의 라이선스 고지와 의존 플랫폼 조건을 확인한다.
