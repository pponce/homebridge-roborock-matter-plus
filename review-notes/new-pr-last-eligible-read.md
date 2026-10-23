# New diagnostic PR extracted from #31

[Open the prefilled pull request](https://github.com/mathiashornbek/homebridge-roborock-matter/compare/main...pponce:homebridge-roborock-matter-plus:mqtt-last-eligible-read?expand=1&title=Preserve%20the%20last%20eligible%20MQTT%20read%20timeout%20across%20sessions&body=A%20reconnect%20currently%20clears%20the%20read-timeout%20observation.%20This%20keeps%20a%20separate%20%60lastEligibleRead%60%20with%20its%20original%20generation%2C%20raw-silence%20result%20and%20age%20so%20a%20report%20can%20distinguish%20historical%20evidence%20from%20the%20current%20session.%0A%0AExtracted%20from%20%2331%20as%20requested.%20Based%20directly%20on%203.40.0-beta.2.%20This%20is%20diagnostic%20only%3A%20it%20adds%20no%20settings%20and%20does%20not%20change%20reconnect%2C%20breaker%20or%20recovery%20decisions.%20The%20per-request%20transport%20tag%20requested%20in%20the%20same%20review%20is%20already%20in%20this%20base.%0A%0ATests%20cover%20retention%20across%20reconnect%2C%20replacement%20by%20a%20current-generation%20eligible%20timeout%2C%20and%20exclusion%20of%20writes%20and%20old-generation%20timeouts.%20Formatting%2C%20type%20checks%2C%20build%20and%20all%202%2C542%20tests%20(239%20suites)%20pass%20on%20Node%2022.%0A%0AValidation%3A%20https%3A%2F%2Fgithub.com%2Fpponce%2Fhomebridge-roborock-matter-plus%2Factions%2Fruns%2F39980221941%2Fjob%2F120505270885)

The branch is published and validated. The link opens GitHub's creation form; it does not submit the PR.

Base: `mathiashornbek/homebridge-roborock-matter:main`

Head: `pponce/homebridge-roborock-matter-plus:mqtt-last-eligible-read`

## Title

Preserve the last eligible MQTT read timeout across sessions

## Description

A reconnect currently clears the read-timeout observation. This keeps a separate `lastEligibleRead` with its original generation, raw-silence result and age so a report can distinguish historical evidence from the current session.

Extracted from #31 as requested. Based directly on 3.40.0-beta.2. This is diagnostic only: it adds no settings and does not change reconnect, breaker or recovery decisions. The per-request transport tag requested in the same review is already in this base.

Tests cover retention across reconnect, replacement by a current-generation eligible timeout, and exclusion of writes and old-generation timeouts. Formatting, type checks, build and all 2,542 tests (239 suites) pass on Node 22.

Validation: https://github.com/pponce/homebridge-roborock-matter-plus/actions/runs/39980221941/job/120505270885

## Why there is only one new PR

The requested per-request `transport` tag is already in [the 3.40.0-beta.2 queue](https://github.com/mathiashornbek/homebridge-roborock-matter/blob/9b43a2a8c3d5172be3f5552f244c2bde0c7e8723/roborockLib/lib/messageQueueHandler.js): cloud and local pending entries set it explicitly. There is no missing transport-tag change to propose against this base.
