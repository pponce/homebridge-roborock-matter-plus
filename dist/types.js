"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOMEKIT_ACTION_KEYS = void 0;
exports.isHomeKitActionKey = isHomeKitActionKey;
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
    "pause",
    "locate",
];
function isHomeKitActionKey(value) {
    return (typeof value === "string" &&
        exports.HOMEKIT_ACTION_KEYS.includes(value));
}
//# sourceMappingURL=types.js.map