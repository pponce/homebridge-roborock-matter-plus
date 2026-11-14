"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MATTER_HIDEABLE_CLEAN_MODE_KEYS = exports.HOMEKIT_STATE_SENSOR_KEYS = exports.HOMEKIT_ACTION_KEYS = void 0;
exports.isHomeKitActionKey = isHomeKitActionKey;
exports.isHomeKitStateSensorKey = isHomeKitStateSensorKey;
exports.isMatterHideableCleanModeKey = isMatterHideableCleanModeKey;
/**
 * The actions the optional HAP switches can perform.
 *
 * Apple Home does not offer the Matter vacuum's own commands as automation
 * actions — measured by pponce in issue #3 for docking. A plain HomeKit switch
 * is an automation action everywhere, so one switch per action is the way an
 * automation reaches these commands at all.
 *
 * Declared here, not next to the switch, so the accessory and the vacuum can
 * both name the same keys without importing each other.
 */
exports.HOMEKIT_ACTION_KEYS = [
    "clean",
    "dock",
    "empty",
    "pause",
    "locate",
];
function isHomeKitActionKey(value) {
    return (typeof value === "string" &&
        exports.HOMEKIT_ACTION_KEYS.includes(value));
}
/**
 * The robot states the optional read-only HAP sensors mirror.
 *
 * The switches above are inputs an automation *presses*. Apple Home will not
 * accept a Matter vacuum as an automation *trigger* at all — measured by
 * pponce in issue #3 and confirmed by him a second time — so nothing the robot
 * does can start an automation. A contact sensor is a trigger source in every
 * Home client, so mirroring the state onto one is the only way this works.
 *
 * The order is the order pponce ranked them in when asked which state he would
 * actually trigger on: docked first ("I'd use the docked feature on its own for
 * sure"), cleaning second. He also named the pair he wants them for — not
 * docked AND not cleaning means the robot is probably stuck somewhere — which
 * is why both ship together and why no third "stuck" sensor is guessed at: that
 * one is a timeout over these two, and it belongs in his automation where he
 * can pick the timeout, not in a plugin that would pick it for him.
 */
exports.HOMEKIT_STATE_SENSOR_KEYS = [
    "docked",
    "cleaning",
    "waterTankEmpty",
    "dirtyWaterTankFull",
    "cleaningFluidEmpty",
];
function isHomeKitStateSensorKey(value) {
    return (typeof value === "string" &&
        exports.HOMEKIT_STATE_SENSOR_KEYS.includes(value));
}
/**
 * The clean modes a user may leave out of the list Apple Home is offered
 * (`matterHiddenCleanModes`).
 *
 * Asked for in #50: Siri picks a clean mode by itself — the plugin's log shows
 * the mode request arriving just before the start — and on one German Q Revo it
 * picked Vacuum + Mop whatever was said. A mode that is not offered cannot be
 * picked. Vacuum is not on the list: it is the mode everything falls back to,
 * and Matter needs at least one.
 */
exports.MATTER_HIDEABLE_CLEAN_MODE_KEYS = ["mop", "vacuumAndMop"];
function isMatterHideableCleanModeKey(value) {
    return (typeof value === "string" &&
        exports.MATTER_HIDEABLE_CLEAN_MODE_KEYS.includes(value));
}
//# sourceMappingURL=types.js.map