# v3.39.0 review follow-up

All seven PR branches have been updated. Each is based on v3.39.0, directly or through its stated dependency. Upstream CI passes for every published revision: formatting, type checks, build and the full serial test suite. No physical Apple Home result is claimed.

| PR | Revised scope | Passing tests | CI | Copy-ready text |
| --- | --- | ---: | --- | --- |
| [#30](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/30) | Strict cross-robot breaker exemption + default recovery integration | 2,272 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833840201) | [Title, description, reply](PR-30.md) |
| [#31](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/31) | Session recreation through #37's shared gate | 2,315 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833854452) | [Title, description, reply](PR-31.md) |
| [#32](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/32) | Independent schedule reconciliation | 2,281 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833861815) | [Title, description, reply](PR-32.md) |
| [#36](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/36) | Presence logging only | 2,262 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833870794) | [Title, description, reply](PR-36.md) |
| [#37](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/37) | Event-driven readiness + working LAN fallback | 2,265 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833846516) | [Title, description, reply](PR-37.md) |
| [#38](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/38) | Persisted confirmation + unknown-outcome follow-up | 2,290 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833877470) | [Title, description, reply](PR-38.md) |
| [#39](https://github.com/mathiashornbek/homebridge-roborock-matter/pull/39) | Immediate Find/Routine acknowledgement + duplicate-run guard | 2,269 | [Green](https://github.com/mathiashornbek/homebridge-roborock-matter/actions/runs/38833883874) | [Title, description, reply](PR-39.md) |

## Finish the GitHub conversations

The connected GitHub integration rejected upstream comment creation with HTTP 403, “Resource not accessible by integration.” No review reply was posted. It also does not expose editing existing PR descriptions or changing draft status.

Open each PR's linked note above, paste the replacement description (and suggested title where useful), then post its review reply. #32's replacement explicitly removes the old MQTT stack dependency and refreshes its test counts; #39 describes the actual new behavior as Find and Routines.

#30, #32 and #36 have no outstanding requested physical-test gate. They can be marked ready for review after the text updates. Keep #37–#39 in draft until the requested live checks are recorded. #31 still depends on #30 and #37; #38 depends on #32. If a prerequisite changes during review or merge, align its dependent branch again.

## Separate TCP-probe PR

The small test-only change is published on `ui-local-probe-test-ports`, based directly on v3.39.0. Its only changed file is `__tests__/ui-server-local-probe.test.js`. Formatting, types, build and all 166 suites / 2,256 tests pass.

[Create the prefilled TCP-probe PR](https://github.com/mathiashornbek/homebridge-roborock-matter/compare/main...pponce:homebridge-roborock-matter-plus:ui-local-probe-test-ports?expand=1&title=Use%20OS-assigned%20ports%20in%20UI%20local-probe%20tests&body=Split%20from%20the%20existing%20review%20branches%20at%20Mathias's%20request.%0A%0AThe%20local%20TCP-probe%20tests%20use%20fixed%20ports%2C%20which%20can%20collide%20with%20other%20processes.%20This%20test-only%20change%20asks%20the%20OS%20for%20listening%20ports%2C%20rejects%20listener%20startup%20errors%2C%20cleans%20up%20servers%20on%20partial%20setup%20failure%2C%20and%20adds%20an%20occupied-port%20regression.%0A%0AOnly%20__tests__%2Fui-server-local-probe.test.js%20changes.%20No%20plugin%20runtime%20changes.%0A%0ABased%20directly%20on%20v3.39.0.%20Validation%3A%20formatting%2C%20type%20checks%2C%20build%2C%20and%20all%20166%20suites%20%2F%202%2C256%20tests%20pass%20with%20--runInBand.%0A%0AValidation%20run%3A%20https%3A%2F%2Fgithub.com%2Fpponce%2Fhomebridge-roborock-matter-plus%2Factions%2Fruns%2F38833069096)

The PR has not been created; the link fills its upstream base, fork branch, title and description for review and submission.

## Remaining live checks

[Install commands and observation checklist](LIVE-CHECKS.md)

- **#37:** brief MQTT reconnect and outage over ten seconds, each with a Matter command and a HAP switch, including timestamps. Also verify a working LAN route remains usable with preferCloud enabled.
- **#38:** success, visible rollback on a definite failure, a retap during reconciliation, restart during a pending change, and unknown-outcome resolution. Record what Apple Home actually shows and how long it takes.
- **#39:** Find and one Routine, each once succeeding and once failing, on its isolated build, with the corresponding logs. Check duplicate Routine presses while a request is still pending where feasible.
- **#36, optional:** note if a continuously connected robot only supplies retained presence and therefore never produces the first-live info line.

The existing `MQTT_ACCOUNT_SESSION_RECOVERY` branch remains at `42f0cc4c862d8e0307d9907f6405c71c53271417`. It was used as a reference and was not updated.
