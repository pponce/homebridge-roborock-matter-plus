"use strict";

// The same defaults govern accessory exposure and recovery when the last
// control for a feature is hidden. Missing per-vacuum settings are opt-in.
function scheduleControlOptions(config = {}) {
  const pauseAll = config.enableSchedulePauseUntilTomorrow === true && config.schedulePauseAll !== false;
  const pausePerVacuum = config.enableSchedulePauseUntilTomorrow === true && config.schedulePausePerVacuum === true;
  const delayAll = config.enableScheduleDelay === true && config.scheduleDelayAll !== false;
  const delayPerVacuum = config.enableScheduleDelay === true && config.scheduleDelayPerVacuum === true;
  return { pauseAll, pausePerVacuum, delayAll, delayPerVacuum,
    pauseEnabled: pauseAll || pausePerVacuum, delayEnabled: delayAll || delayPerVacuum };
}

module.exports = { scheduleControlOptions };
