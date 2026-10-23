# October 23 PR follow-up

All six existing PR branches were rebased onto upstream 3.40.0-beta.2 (`9b43a2a8c3d5172be3f5552f244c2bde0c7e8723`) and published. #38 is stacked on the corrected #32; parked #31 is stacked on #37. GitHub reports all six mergeable. Their existing titles and draft states were retained. Old heads are preserved under `backup/review-v340/prNN`.

## Reply drafts

These are new comments for Pedro to post; none were submitted automatically.

- [PR #31 reply](PR-31.md)
- [PR #32 reply](PR-32.md)
- [PR #36 reply](PR-36.md)
- [PR #37 reply](PR-37.md)
- [PR #38 reply](PR-38.md)
- [PR #39 reply](PR-39.md)

For #37, also replace the first-post description using [this updated text](PR-37-description.md), which includes the explicit ten-second wait Mathias requested. The current GitHub connection cannot edit PR descriptions. No title changes are needed.

## Extracted PR

[Create the small lastEligibleRead PR](new-pr-last-eligible-read.md). The source-only branch `mqtt-last-eligible-read` is already published and tested. The prefilled link leaves submission to Pedro.

Mathias also suggested extracting the per-request transport tag. That is already present in 3.40.0-beta.2 for both cloud and local pending requests, so a second PR would duplicate upstream code.

## Why #31 is parked

In [his review](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/31#pullrequestreview-5629769661), Mathias explains that 3.40 now creates a fresh MQTT client and random ID on every connection, including health restarts, with a ten-second reconnect backoff multiplied by 1.5 on subsequent attempts. The broader optional lifecycle overlaps that implementation and adds roughly 1,700 lines and two settings.

His account continued receiving Q7 traffic while the a70 was quiet for 2.3 days. That points to a robot-specific problem rather than proving the whole account session failed. The prior health counter could also be reset by Q7 replies; 3.40 now counts V1 cloud requests and adds LAN keepalive plus immediate cloud retry. A session restart cannot force an otherwise silent robot to publish.

His suggested condition for revisiting the larger design is concrete evidence from the beta's hourly transport logs that the extra lifecycle recovers a case the new default does not. The broader implementation remains available in the draft PR; it was not discarded. Its explicit opt-in recovery still takes its own immediate replacement path, while ordinary reconnection uses the upstream backoff. That difference remains experimental.

## Changes and remaining requests

| PR | Completed | Remaining |
| --- | --- | --- |
| #31 | Ported and retained the full experimental lifecycle; independent historical diagnostic prepared. | Parked pending evidence of added recovery value. |
| #32 | Own-source confirmation precedes unrelated throttling; both requested regressions covered; 2.5-second HomeKit response retained; summary emitted from finally. | Mathias's optional refinement to fallbackSent accounting was not included. |
| #36 | First live offline report warns; first online report is not labeled recovery; LAN wording is capability/configuration dependent; series reference removed. | Maintainer review. |
| #37 | Connected/unsubscribed expiry healing shares the existing cooldown; disconnected waits and method breaker remain separate; new client lifecycle retained; frame built after wait. | Live reconnect/outage observations for Matter and HAP before leaving draft; apply the prepared description. |
| #38 | Rebased on fixed #32; confirmed writes no longer become unknown because the other source is throttled; persistence/rollback behavior retained. | Live Apple Home observations; Mathias will write the changelog. |
| #39 | Rebased, including upstream REST timeouts, with momentary action behavior retained. | Find and Routine success/failure observations and logs; Mathias requested the isolated branch. |

Pedro's available live setup is the combined build with pause/delay controls. Any observations from that setup should say so explicitly; they do not meet an isolated-branch test requirement. No physical robot or Apple Home validation was performed in this task. `SCHEDULE_PAUSE_DELAY` remains at `465ff53012d6b3f2904356dd8b29f5f8f64a2428`.

## Automated validation

All listed jobs passed dependency installation, formatting, lint, type checks, build, and the complete Jest suite on Node 22. A passing matrix job can belong to an earlier overall run that failed on a different PR; links below go directly to the relevant job.

| Branch | Published commit | Suites | Tests | Validation |
| --- | --- | ---: | ---: | --- |
| #31 | `0da198a` | 241 | 2,589 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39982463922/job/120512996974) |
| #32 | `5a27d0e` | 241 | 2,568 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39978430460/job/120499065328) |
| #36 | `2280cab` | 240 | 2,549 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39978430460/job/120499065979) |
| #37 | `5d022ab` | 240 | 2,556 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39981679083/job/120510291957) |
| #38 | `46dee78` | 241 | 2,577 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39981679083/job/120510292470) |
| #39 | `bb38227` | 240 | 2,554 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39980221941/job/120505271334) |
| New diagnostic | `b4b52a9` | 239 | 2,542 | [Passed](https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39980221941/job/120505270885) |

For #31 and #38, the final published commit uses the exact validated source tree with its parent adjusted to the corresponding dependency PR. [validation.json](validation.json) records both source and published SHAs and their trees. PR source diffs contain no generated dist, validation result files, or review-only workflow changes.
