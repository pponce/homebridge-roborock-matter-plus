"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOME_SWITCH_SURFACE = exports.MATTER_SURFACE = void 0;
const live_message_1 = require("./live_message");
const timers_1 = require("./timers");
const MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS = 2000;
const MATTER_CLEAN_MODE_PREP_TIMEOUT_MS = 2500;
// Commands reach this class from two places now: the Matter clusters, and the
// optional HAP action switches. The surface is threaded through the command
// path rather than inferred, because the only way a user can tell a dropped
// automation from a dropped tile press is the log line that names which one
// sent the command.
exports.MATTER_SURFACE = "Matter";
exports.HOME_SWITCH_SURFACE = "Home switch";
/** "Matter" reads bare; anything else takes an article. */
function surfacePhrase(surface) {
    return surface === exports.MATTER_SURFACE ? surface : `the ${surface}`;
}
const RUN_MODE_IDLE = 0;
const RUN_MODE_CLEANING = 1;
// Live status entries older than this fall back to the HomeData snapshot.
const LIVE_STATUS_STALENESS_MS = 15 * 60 * 1000;
// The status fields a live frame can carry that the Matter publish actually
// reads. Both the gate in extractStatusUpdate and the "nothing meaningful
// arrived" check in updateMatterStateFromMessage derive from this one list, so
// the two cannot disagree about what counts as an update.
//
// They did disagree: the caller was taught that a frame carrying only
// `fan_power` or only `matter_clean_type` is meaningful — a suction or
// mop-mode change made in the Roborock app, or picked by SmartPlan, pushes
// exactly that — while the gate one level below still dropped such a frame
// before the caller ever saw it. A hand-written field list in two places is
// the same defect as a hand-written file list: adding a field to one of them
// silently leaves the other behind.
const MEANINGFUL_LIVE_STATUS_FIELDS = [
    "state",
    "charge_status",
    "battery",
    "clean_area",
    "clean_time",
    "fan_power",
    "matter_clean_type",
];
const CLEAN_MODE_VACUUM = 0;
const CLEAN_MODE_MOP = 1;
const CLEAN_MODE_VACUUM_AND_MOP = 2;
// Opt-in fan-power clean modes (enableFanPowerCleanModes, default off since
// Matter locks the announced mode set at commissioning — enabling requires
// one re-pair). Mode ids are stable and appended after the base modes.
// Fan power values are Roborock v1 codes (101-104); the B01/Q7 adapter
// translates them to its wind levels 1-4 transparently.
const CLEAN_MODE_VACUUM_QUIET = 3;
const CLEAN_MODE_VACUUM_BALANCED = 4;
const CLEAN_MODE_VACUUM_TURBO = 5;
const CLEAN_MODE_VACUUM_MAX = 6;
// Max+ (fifth suction level, v1 fan power 108) — only announced for robots
// whose protocol verifiably defines it (capabilities.canMaxPlusFanPower).
const CLEAN_MODE_VACUUM_MAX_PLUS = 7;
// Matter ModeBase common mode tags — combined with the RVC Vacuum tag.
// IMPORTANT: Apple Home ignores mode labels and renders its own localized
// names from these tags (verified in the field: a mode with only the
// Vacuum tag renders as plain "Vacuum"/"Støvsug"), so every suction level
// carries a distinct intensity tag: Auto, Quick, Quiet, Max.
const RVC_CLEAN_MODE_TAG_AUTO = 0;
const RVC_CLEAN_MODE_TAG_QUICK = 1;
const RVC_CLEAN_MODE_TAG_QUIET = 2;
const RVC_CLEAN_MODE_TAG_MAX = 7;
// RVC Clean Mode cluster tag: DeepClean — the closest semantic match for
// Roborock's Max+ boost level.
const RVC_CLEAN_MODE_TAG_DEEP_CLEAN = 16384;
const FAN_POWER_CLEAN_MODES = [
    {
        mode: CLEAN_MODE_VACUUM_QUIET,
        label: "Quiet Vacuum",
        fanPower: 101,
        extraTags: [RVC_CLEAN_MODE_TAG_QUIET],
    },
    {
        mode: CLEAN_MODE_VACUUM_BALANCED,
        label: "Balanced Vacuum",
        fanPower: 102,
        extraTags: [RVC_CLEAN_MODE_TAG_AUTO],
    },
    {
        mode: CLEAN_MODE_VACUUM_TURBO,
        label: "Turbo Vacuum",
        fanPower: 103,
        extraTags: [RVC_CLEAN_MODE_TAG_QUICK],
    },
    {
        mode: CLEAN_MODE_VACUUM_MAX,
        label: "Max Vacuum",
        fanPower: 104,
        extraTags: [RVC_CLEAN_MODE_TAG_MAX],
    },
];
const MAX_PLUS_FAN_POWER_CLEAN_MODE = {
    mode: CLEAN_MODE_VACUUM_MAX_PLUS,
    label: "Max+ Vacuum",
    fanPower: 108,
    extraTags: [RVC_CLEAN_MODE_TAG_DEEP_CLEAN],
};
const RVC_RUN_MODE_TAG_IDLE = 16384;
const RVC_RUN_MODE_TAG_CLEANING = 16385;
const RVC_CLEAN_MODE_TAG_VACUUM = 16385;
const RVC_CLEAN_MODE_TAG_MOP = 16386;
const ROBOROCK_FAN_POWER_OFF = 105;
const ROBOROCK_FAN_POWER_BALANCED = 102;
const ROBOROCK_WATER_BOX_OFF = 200;
const ROBOROCK_WATER_BOX_MILD = 201;
// Matter Service Area OperationalStatusEnum (progress list entries).
const SERVICE_AREA_PROGRESS = {
    PENDING: 0,
    OPERATING: 1,
    SKIPPED: 2,
    COMPLETED: 3,
};
const RVC_OPERATIONAL_STATE = {
    STOPPED: 0,
    RUNNING: 1,
    PAUSED: 2,
    ERROR: 3,
    SEEKING_CHARGER: 64,
    CHARGING: 65,
    DOCKED: 66,
    EMPTYING_DUST_BIN: 67,
    CLEANING_MOP: 68,
    UPDATING_MAPS: 70,
};
const RVC_OPERATIONAL_STATE_LIST = [
    RVC_OPERATIONAL_STATE.STOPPED,
    RVC_OPERATIONAL_STATE.RUNNING,
    RVC_OPERATIONAL_STATE.PAUSED,
    RVC_OPERATIONAL_STATE.ERROR,
    RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
    // Dock activities. These were the whole point of the "Extended Operational
    // States" toggle, but they were missing from this list, and Matter requires
    // operationalState to be a member of operationalStateList — so even a
    // correctly derived "emptying the dust bin" could not legally be published.
    RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN,
    RVC_OPERATIONAL_STATE.CLEANING_MOP,
    RVC_OPERATIONAL_STATE.UPDATING_MAPS,
];
// The basic (non-extended) operational state list is the first four entries
// of the full list, without SEEKING_CHARGER.
const RVC_BASIC_OPERATIONAL_STATE_LIST = RVC_OPERATIONAL_STATE_LIST.slice(0, 4);
// Dock chores: the robot is parked in its dock doing housekeeping. None of
// them starts or ends a cleaning run — whether one is in progress was decided
// before the chore began, and is decided again when it is over.
const DOCK_ACTIVITY_STATES = new Set([
    RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN,
    RVC_OPERATIONAL_STATE.CLEANING_MOP,
    RVC_OPERATIONAL_STATE.UPDATING_MAPS,
]);
// The states that the "Extended Operational States" toggle unlocks. Publishing
// any of these requires them to be advertised, which is why this set and
// RVC_OPERATIONAL_STATE_LIST must stay in agreement. Derived from the dock
// chores rather than re-listing them: a second hand-written copy of a list is
// the most repeated defect in this codebase.
const EXTENDED_OPERATIONAL_STATES = new Set([
    RVC_OPERATIONAL_STATE.SEEKING_CHARGER,
    ...DOCK_ACTIVITY_STATES,
]);
// Optional charging/docked additions. CHARGING (0x41) and DOCKED (0x42) are
// standard RVC operational state IDs (not manufacturer-range), so they are
// safe to advertise; newer Apple Home versions render them as "Charging" /
// "Docked" on the tile instead of "Ready".
const RVC_CHARGING_DOCKED_STATE_LIST = [
    RVC_OPERATIONAL_STATE.CHARGING,
    RVC_OPERATIONAL_STATE.DOCKED,
];
const POWER_SOURCE_STATUS = {
    ACTIVE: 1,
    UNAVAILABLE: 3,
};
const BATTERY_CHARGE_LEVEL = {
    OK: 0,
    WARNING: 1,
    CRITICAL: 2,
};
const BATTERY_CHARGE_STATE = {
    UNKNOWN: 0,
    IS_CHARGING: 1,
    IS_AT_FULL_CHARGE: 2,
    IS_NOT_CHARGING: 3,
};
const BATTERY_REPLACEABILITY = {
    UNSPECIFIED: 0,
};
const BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT = 180;
const SERVICE_AREA_SELECT_STATUS = {
    SUCCESS: 0,
    UNSUPPORTED_AREA: 1,
    INVALID_IN_MODE: 2,
    INVALID_SET: 3,
};
const MATTER_LOCATION_NAME_MAX_LENGTH = 64;
const MATTER_MAP_NAME_MAX_LENGTH = 64;
const MATTER_AREA_ID_MAP_MULTIPLIER = 1000000;
const MATTER_AREA_ID_MAX = 0xffffffff;
const OPTIMISTIC_STATE_TTL_MS = 2 * 60 * 1000;
// Number of consecutive contradicting live Roborock states to tolerate before
// abandoning an optimistic state, so a command the robot acknowledged but did
// not act on cannot keep Apple Home on a wrong state until the TTL expires.
const OPTIMISTIC_CONTRADICTION_LIMIT = 2;
// Window after a Matter start/resume/area-clean command during which a follow-up
// pause or dock is forwarded to the robot even if the cached state still reads
// docked/charging. Models that fall back to cloud (e.g. S8 / roborock.vacuum.a51)
// can take tens of seconds to report Cleaning, and the optimistic state may clear
// first; without this window the plugin would silently drop a real user command.
const RECENT_CLEANING_COMMAND_WINDOW_MS = 60 * 1000;
const SLOW_MATTER_COMMAND_MS = 3000;
const MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS = [2000, 15000];
const MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS = [
    0, 2000, 5000, 10000, 20000, 30000,
];
const MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS = [
    2000, 15000, 30000, 60000, 90000, 120000, 150000, 180000,
];
const MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS = 7000;
// Slow hosts (Raspberry Pi class hardware, busy child-bridge restarts) can
// keep the Homebridge Matter endpoint initializing well past 14 seconds, so
// back off further before giving up and waiting for the next live update.
const MATTER_INITIALIZATION_RETRY_DELAYS_MS = [
    1000, 3000, 10000, 30000, 60000,
];
const ROOM_CLEAN_STATE = 18;
const PAUSED_STATE = 10;
// Low-frequency safety net. Every publish is a full coherent snapshot and
// matter.js suppresses no-op writes, so this generates no Matter traffic
// unless the store actually drifted from the latest Roborock state.
const MATTER_STATE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
/**
 * Optional Homebridge 2 Matter exposure for Apple Home's native vacuum UI.
 *
 * This intentionally uses runtime `any` access instead of importing Homebridge
 * Matter types so the plugin still compiles and runs on Homebridge 1.x.
 */
class RoborockMatterVacuumAccessory {
    constructor(platform, accessory, device, isRegistered = false) {
        this.platform = platform;
        this.accessory = accessory;
        this.optimisticClusters = null;
        this.optimisticExpiresAt = 0;
        this.optimisticGeneration = 0;
        this.optimisticAction = null;
        this.contradictingLiveStateCount = 0;
        this.lastCleaningCommandAt = 0;
        this.selectedServiceAreaIds = [];
        this.roomCleaningAreaConfirmed = false;
        this.lastServiceAreaSummary = "";
        this.liveStatusUpdatedAt = 0;
        // The last "Matter publish for …" line actually written to the log. The
        // emit decision compares rendered lines rather than a hand-picked field
        // list, so every value the line names — and every value added to it later —
        // triggers it by construction.
        this.lastLoggedMatterPublishLine = null;
        this.powerSourceResyncDone = false;
        this.serviceAreaCurrentArea = null;
        // Area ids in which the robot was actually DETECTED via live map-position
        // tracking during the current run. Only detected areas are marked
        // completed when the robot moves on; the initial first-requested-room
        // guess falls back to pending instead of claiming a clean that may never
        // have happened. In-memory only: after a mid-run restart the worst case is
        // one pending-instead-of-completed entry until the run ends.
        this.liveConfirmedServiceAreaIds = new Set();
        // Per-cluster JSON of the last CONFIRMED publish. Used to skip republishing
        // identical cluster payloads on every poll/heartbeat. Safe against the
        // historical "Updating..." desync (see updateMatterState comment) because
        // (a) all publishes are serialized through matterPublishChain, (b) entries
        // are recorded only after the individual cluster write succeeded and are
        // dropped on failure, and (c) the heartbeat performs a forced full publish
        // every cycle, self-healing any residual divergence within a minute.
        this.lastPublishedClusterJson = new Map();
        this.serviceAreaProgress = [];
        this.selectedCleanMode = CLEAN_MODE_VACUUM;
        this.selectedCleanModeNeedsApply = false;
        // The run mode last decided by a state that was not a dock chore. Dock
        // chores inherit it instead of deciding one of their own — see
        // resolveRunMode(). Idle is the honest starting point: a plugin that boots
        // while the dock is emptying knows of no run in progress.
        this.lastRunMode = RUN_MODE_IDLE;
        // The suction-level clean mode last derived from a fan power the plugin
        // could actually read. Used only as the answer to "the fan power is
        // unreadable right now" while suction levels are announced; cleared by an
        // explicit Apple Home selection so the user's choice always wins.
        this.lastResolvedFanPowerCleanMode = null;
        // The base clean TYPE this plugin applied for the run in progress, held
        // until the robot's own report agrees with it once. A robot that has just
        // acknowledged "water off" keeps reporting the old water level for a while,
        // and the live derivation below reads that lagging value as vacuum+mop —
        // contradicting a command this plugin sent and had acknowledged seconds
        // earlier. Released when the robot's report catches up, when the run it was
        // applied for ends, and by an explicit Apple Home selection.
        this.appliedCleanTypePin = null;
        this.lastVacuumFanPower = null;
        this.lastWaterBoxMode = null;
        this.matterInitializationRetryAttempt = 0;
        this.matterInitializationRetryPending = false;
        this.returnToDockRetryPending = false;
        this.matterStateHeartbeatTimer = null;
        // Serializes every Matter publish so concurrent publishers (live messages,
        // refreshes, command paths) cannot land out of order. Homebridge defers each
        // updateAccessoryState via setImmediate, so without this chain an older
        // snapshot can overwrite a newer one and leave Apple Home on stale state.
        this.matterPublishChain = Promise.resolve();
        // Freshest status values seen from live Roborock messages. Preferred over the
        // slower HomeData snapshot when rebuilding clusters so registration snapshots
        // and attribute reads do not lag behind the latest push.
        this.liveStatus = new Map();
        this.registered = isRegistered;
        this.updateMetadata(device);
        this.restoreServiceAreaProgress();
    }
    get api() {
        return this.platform.roborockAPI;
    }
    getMatterCommandOptions() {
        const options = {
            waitForResult: true,
            throwOnError: true,
            preferLocal: true,
            allowOfflineCloudSend: true,
        };
        if (this.platform.platformConfig.preferCloudForMatterCommands) {
            options.preferCloud = true;
            delete options.preferLocal;
        }
        return options;
    }
    getMatterMapLoadCommandOptions() {
        const options = {
            ...this.getMatterCommandOptions(),
            // Some older Roborock models apply load_multi_map but never complete the
            // local pending request. The cloud path gives Matter room cleaning a
            // reliable acknowledgement without forcing all Matter commands to cloud.
            preferCloud: true,
        };
        delete options.preferLocal;
        return options;
    }
    getMatterCleanModePrepCommandOptions() {
        return {
            ...this.getMatterCommandOptions(),
            requestTimeoutMs: MATTER_CLEAN_MODE_COMMAND_TIMEOUT_MS,
            // Derived from the same constant the prep is raced against, so the two
            // cannot drift apart: whatever window this class enforces is the window
            // the protocol layer budgets its commands inside.
            prepWindowMs: MATTER_CLEAN_MODE_PREP_TIMEOUT_MS,
        };
    }
    /** The robot's name exactly as the log lines and Apple Home spell it. */
    getDisplayName() {
        return this.getVacuumName();
    }
    /**
     * Whether this robot can actually perform the action behind a HAP switch.
     *
     * Only `locate` is conditional: `find_me` is optional on the Roborock API
     * and absent on some models, and identifyVacuum already degrades to a debug
     * line rather than an error when it is missing. A switch that silently does
     * nothing is worse than no switch, so an unsupported action is never
     * published in the first place.
     */
    supportsHomeKitAction(action) {
        if (action === "locate") {
            return typeof this.api.find_me === "function";
        }
        return true;
    }
    /**
     * Perform an action requested by one of the optional HAP switches.
     *
     * This deliberately routes into the same private methods the Matter cluster
     * handlers use, rather than calling app_charge/app_pause directly. Those
     * methods carry every lesson the command path has already learned —
     * acknowledgement waiting and timing logs (issue #12), forwarding a command
     * the cached snapshot claims is unnecessary (issue #4), the return-to-dock
     * retry when Roborock times out but is still cleaning, and the optimistic
     * cluster write that moves the Matter tile. A switch that bypassed them
     * would be a second, worse command path that re-earns all four bugs.
     */
    async runHomeKitAction(action) {
        switch (action) {
            case "clean":
                await this.startCleaning(exports.HOME_SWITCH_SURFACE);
                return;
            case "dock":
                await this.returnToDock(exports.HOME_SWITCH_SURFACE);
                return;
            case "pause":
                await this.pauseCleaning(exports.HOME_SWITCH_SURFACE);
                return;
            case "locate":
                await this.identifyVacuum(exports.HOME_SWITCH_SURFACE);
                return;
        }
    }
    markRegistered() {
        this.registered = true;
        // Fresh registration: nothing is published on the new node yet.
        this.lastPublishedClusterJson.clear();
        // …and nothing has been stated about it either, so the evidence line is
        // restated for the new node instead of being suppressed as unchanged.
        this.lastLoggedMatterPublishLine = null;
    }
    /**
     * Stops all background work for this accessory. Called on Homebridge
     * shutdown and when the accessory is unregistered, so no timer fires into a
     * torn-down bridge and no publish races a restarting child bridge.
     */
    dispose() {
        this.registered = false;
        if (this.matterStateHeartbeatTimer) {
            (0, timers_1.clearTimer)(this.matterStateHeartbeatTimer);
            this.matterStateHeartbeatTimer = null;
        }
        this.clearOptimisticState();
    }
    scheduleMatterStateRefresh(reason, delayMs = 0) {
        if (!this.registered) {
            return;
        }
        const timer = (0, timers_1.scheduleTimer)(() => {
            void this.updateMatterStateFromRoborock().catch((error) => {
                this.platform.log.warn(`Unable to refresh Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, delayMs);
        (0, timers_1.unrefTimer)(timer);
    }
    updateMetadata(device) {
        const duid = device.duid;
        const displayName = this.api.getVacuumDeviceInfo(duid, "name") ||
            device.name ||
            "Roborock Vacuum";
        this.accessory.displayName = displayName;
        // Some Matter layers label the node from `name` rather than `displayName`;
        // set both so Apple Home is less likely to show a generic name.
        this.accessory.name = displayName;
        this.accessory.manufacturer = "Roborock";
        this.accessory.model =
            this.api.getProductAttribute(duid, "model") ||
                this.api.getVacuumDeviceInfo(duid, "model") ||
                "Roborock Vacuum";
        this.accessory.serialNumber =
            this.api.getVacuumDeviceInfo(duid, "sn") || duid;
        const firmwareRevision = this.api.getVacuumDeviceInfo(duid, "fv");
        if (firmwareRevision) {
            this.accessory.firmwareRevision = firmwareRevision;
        }
        else {
            delete this.accessory.firmwareRevision;
        }
        // Mutate the context instead of replacing it: Homebridge (and our own
        // persistence helpers) hold a reference to this object, so swapping it
        // out would silently orphan previously persisted state.
        if (!this.accessory.context) {
            this.accessory.context = {};
        }
        this.accessory.context.duid = duid;
        this.accessory.clusters = this.buildClusters();
        this.accessory.handlers = this.buildHandlers();
        this.accessory.getState = async (cluster, attribute) => {
            const clusterState = this.buildCluster(cluster);
            return clusterState ? clusterState[attribute] : undefined;
        };
    }
    async notifyDeviceUpdater(id, data) {
        if (id === "HomeData" || id === "RoomMapping") {
            if (id === "HomeData") {
                this.rememberHomeDataStatus(data);
            }
            await this.updateMatterStateFromRoborock();
            return;
        }
        if (id === "CloudMessage" || id === "LocalMessage") {
            const liveData = this.getLiveMessageForThisAccessory(data);
            if (liveData === null) {
                return;
            }
            await this.updateMatterStateFromMessage(liveData);
        }
    }
    async updateMatterStateFromRoborock() {
        if (!this.registered) {
            return;
        }
        const matter = this.platform.getMatterApi();
        if (!matter || typeof matter.updateAccessoryState !== "function") {
            return;
        }
        const updated = await this.publishRoborockSnapshot(this.buildClusters(), "Roborock state refresh");
        if (updated) {
            this.ensureMatterStateHeartbeat();
        }
    }
    /**
     * Render the publish evidence line for a full cluster snapshot.
     *
     * When a user reports "Apple Home shows nothing", this is the line that
     * says whether the plugin sent anything to show.
     */
    buildMatterPublishLogLine(clusters) {
        var _a, _b, _c;
        const power = clusters.powerSource;
        const halfPercent = power === null || power === void 0 ? void 0 : power.batPercentRemaining;
        const opState = clusters.rvcOperationalState;
        const runMode = clusters.rvcRunMode;
        const cleanMode = clusters.rvcCleanMode;
        // No fault field here on purpose. 3.4.0 published RVC OperationalError and
        // 3.4.1 withdrew it after three controlled field tests showed Apple Home
        // draws no Matter vacuum fault from a bridged accessory at all. The line
        // kept rendering `fault=…` from an attribute that is now never published,
        // so the branch was permanently dead — and worse, it read as evidence that
        // the feature still existed. If faults ever come back, this line gets the
        // field back with a test that publishes one for real.
        return `Matter publish for ${this.getVacuumName()}: battery=${typeof halfPercent === "number" ? halfPercent / 2 + "%" : "n/a"}, operationalState=${(_a = opState === null || opState === void 0 ? void 0 : opState.operationalState) !== null && _a !== void 0 ? _a : "n/a"}, runMode=${(_b = runMode === null || runMode === void 0 ? void 0 : runMode.currentMode) !== null && _b !== void 0 ? _b : "n/a"}, cleanMode=${(_c = cleanMode === null || cleanMode === void 0 ? void 0 : cleanMode.currentMode) !== null && _c !== void 0 ? _c : "n/a"}.`;
    }
    /**
     * Log the publish evidence line whenever it would read differently from the
     * last one written.
     *
     * The line's stated purpose is to make an Apple Home display problem
     * diagnosable from a single log excerpt. It was emitted only when the
     * BATTERY value changed, which defeated that: a user in issue #8 sent a log
     * spanning a whole cleaning run in which every operational-state transition
     * was invisible, because the line only appeared on the four polls where the
     * battery happened to tick down. Comparing rendered lines — rather than a
     * hand-written list of interesting fields — means any value the line names
     * triggers it, including one added to the message later. A heartbeat's
     * forced republish of unchanged values still says nothing new, so the
     * self-healing full write stays silent.
     */
    logMatterPublishIfChanged(clusters) {
        const line = this.buildMatterPublishLogLine(clusters);
        if (line === this.lastLoggedMatterPublishLine) {
            return;
        }
        this.lastLoggedMatterPublishLine = line;
        this.platform.log.info(line);
    }
    buildHandlers() {
        const handlers = {
            identify: {
                identify: async () => {
                    await this.identifyVacuum();
                },
            },
            rvcRunMode: {
                changeToMode: async (request) => {
                    await this.changeRunMode(request === null || request === void 0 ? void 0 : request.newMode);
                },
            },
            rvcOperationalState: {
                pause: async () => {
                    await this.pauseCleaning();
                },
                resume: async () => {
                    await this.resumeCleaning();
                },
                goHome: async () => {
                    await this.returnToDock();
                },
            },
        };
        if (this.isCleanModeEnabled()) {
            handlers.rvcCleanMode = {
                changeToMode: async (request) => {
                    await this.changeCleanMode(request === null || request === void 0 ? void 0 : request.newMode);
                },
            };
        }
        if (this.isServiceAreaEnabled()) {
            handlers.serviceArea = {
                selectAreas: async (request) => {
                    return await this.selectServiceAreas(request === null || request === void 0 ? void 0 : request.newAreas);
                },
            };
        }
        return handlers;
    }
    async identifyVacuum(surface = exports.MATTER_SURFACE) {
        await this.publishCurrentMatterState(`${surface} identify command`, {
            clearOptimistic: true,
        });
        const findMe = this.api.find_me;
        if (typeof findMe !== "function") {
            this.platform.log.debug(`${surface} identify requested for ${this.getVacuumName()}, but the Roborock API does not expose find_me.`);
            return;
        }
        try {
            await findMe.call(this.api, this.getDuid(), this.getMatterCommandOptions());
        }
        catch (error) {
            this.platform.log.warn(`Unable to locate ${this.getVacuumName()} from ${surfacePhrase(surface)} identify: ${this.getErrorMessage(error)}`);
        }
        await this.publishCurrentMatterState(`${surface} identify command complete`, {
            clearOptimistic: true,
        });
    }
    async changeRunMode(newMode) {
        const name = this.getVacuumName();
        const duid = this.getDuid();
        this.platform.log.info(`Matter run mode request for ${name}: ${newMode !== null && newMode !== void 0 ? newMode : "unknown"}.`);
        if (newMode === RUN_MODE_CLEANING) {
            await this.startCleaning();
            return;
        }
        if (newMode === RUN_MODE_IDLE) {
            this.platform.log.info(`Stopping ${name} from Matter. Use the Home/Dock action to dock intentionally.`);
            const state = {
                rvcRunMode: { currentMode: RUN_MODE_IDLE },
                rvcOperationalState: {
                    operationalState: RVC_OPERATIONAL_STATE.STOPPED,
                },
            };
            this.setAndScheduleOptimisticState(state, "stop");
            this.dispatchRoborockMatterCommand("stop", () => this.api.app_stop(duid, this.getMatterCommandOptions()));
            return;
        }
        this.platform.log.warn(`Ignoring unsupported Matter run mode '${newMode}' for ${name}.`);
    }
    /**
     * Start a clean.
     *
     * Shared by the Matter run-mode handler and the optional "Start Cleaning"
     * HAP switch, and deliberately so: the switch starts exactly the clean the
     * Home tile's play button would, including any rooms selected on that tile.
     * A switch with its own idea of what "start" means would be a second command
     * path, and the room selection it ignored would be the one the user is
     * looking at.
     */
    async startCleaning(surface = exports.MATTER_SURFACE) {
        var _a;
        const name = this.getVacuumName();
        const duid = this.getDuid();
        const selectedAreas = this.getSelectedServiceAreaSegments();
        if (selectedAreas.length > 0) {
            const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas);
            const targetMapId = (_a = selectedMapIds[0]) !== null && _a !== void 0 ? _a : null;
            // Roborock can only clean room segments from one map at a time. Service
            // area selection already constrains this to a single map, so this only
            // guards an unexpected multi-map selection by cleaning the first map
            // instead of throwing out of the Matter command handler.
            const areasToClean = selectedMapIds.length > 1
                ? selectedAreas.filter((area) => area.mapId === targetMapId)
                : selectedAreas;
            if (selectedMapIds.length > 1) {
                this.platform.log.warn(`Room cleaning across multiple Roborock maps was requested for ${name}; cleaning only the areas on map ${targetMapId}.`);
            }
            const selectedAreaNames = areasToClean.map((area) => this.formatServiceAreaName(area));
            this.platform.log.info(`Starting ${name} from ${surfacePhrase(surface)} for selected service area(s): ${selectedAreaNames.join(", ")}.`);
            const state = {
                rvcRunMode: { currentMode: RUN_MODE_CLEANING },
                rvcOperationalState: {
                    operationalState: RVC_OPERATIONAL_STATE.RUNNING,
                },
            };
            this.beginServiceAreaProgress(areasToClean.map((area) => area.areaId));
            this.setAndScheduleOptimisticState(state, "selected-area start");
            this.dispatchRoborockMatterCommand("service area clean", async () => {
                await this.applyCleanModeBeforeStarting();
                await this.loadMatterMapIfNeeded(duid, targetMapId);
                await this.api.app_segment_clean_by_ids(duid, areasToClean.map((area) => area.segmentId), this.getMatterCommandOptions());
            }, { surface });
            return;
        }
        this.platform.log.info(`Starting ${name} from ${surfacePhrase(surface)}.`);
        const state = {
            rvcRunMode: { currentMode: RUN_MODE_CLEANING },
            rvcOperationalState: {
                operationalState: RVC_OPERATIONAL_STATE.RUNNING,
            },
        };
        this.beginFullCleanServiceAreaProgress();
        this.setAndScheduleOptimisticState(state, "start");
        this.dispatchRoborockMatterCommand("start", async () => {
            await this.applyCleanModeBeforeStarting();
            await this.api.app_start(duid, this.getMatterCommandOptions());
        }, { surface });
    }
    async changeCleanMode(newMode) {
        const name = this.getVacuumName();
        this.platform.log.info(`Matter clean mode request for ${name}: ${newMode !== null && newMode !== void 0 ? newMode : "unknown"}.`);
        if (this.isSupportedCleanMode(newMode)) {
            this.rememberCurrentRoborockCleanModeSettings();
            this.selectedCleanMode = newMode;
            this.selectedCleanModeNeedsApply = true;
            // Discard the level remembered from the robot: from here on the user
            // has said what they want, and an unreadable fan power must fall back
            // to their choice rather than to what the robot said before it. The
            // applied-type pin goes for the same reason — it records an older
            // intent, and this selection supersedes it.
            this.lastResolvedFanPowerCleanMode = null;
            this.appliedCleanTypePin = null;
            const state = {
                rvcCleanMode: { currentMode: newMode },
            };
            this.setAndScheduleOptimisticState(state, "clean mode change");
            return;
        }
        this.platform.log.warn(`Ignoring unsupported Matter clean mode '${newMode}' for ${name}.`);
    }
    async pauseCleaning(surface = exports.MATTER_SURFACE) {
        const roborockState = this.getNumberStatus("state");
        const chargeStatus = this.getNumberStatus("charge_status");
        const currentOperationalState = this.getOperationalState(roborockState, chargeStatus);
        const looksIdle = this.isRoborockDockedOrCharging(roborockState, chargeStatus) ||
            (roborockState !== null &&
                !this.isInCleaningRunMode(currentOperationalState));
        // Always forward an explicit Matter pause to the robot. The cached snapshot
        // can lag or be overridden by a stale HomeData refresh while the robot is
        // really cleaning (issues #4 and #12), so hard-dropping the command based on
        // it silently failed real pauses. Pausing an already-stopped robot is a
        // harmless no-op, and the optimistic state self-corrects if it was idle.
        if (looksIdle) {
            this.platform.log.info(`Pausing ${this.getVacuumName()} from ${surfacePhrase(surface)} despite an idle snapshot; the cached state may be stale.`);
        }
        else {
            this.platform.log.info(`Pausing ${this.getVacuumName()} from ${surfacePhrase(surface)}.`);
        }
        const state = {
            rvcOperationalState: {
                operationalState: RVC_OPERATIONAL_STATE.PAUSED,
            },
        };
        this.setAndScheduleOptimisticState(state, "pause");
        this.dispatchRoborockMatterCommand("pause", () => this.api.app_pause(this.getDuid(), this.getMatterCommandOptions()), { surface });
    }
    async resumeCleaning() {
        this.platform.log.info(`Resuming ${this.getVacuumName()} from Matter.`);
        const state = {
            rvcRunMode: { currentMode: RUN_MODE_CLEANING },
            rvcOperationalState: {
                operationalState: RVC_OPERATIONAL_STATE.RUNNING,
            },
        };
        this.setAndScheduleOptimisticState(state, "resume");
        this.dispatchRoborockMatterCommand("resume", async () => {
            await this.applyCleanModeBeforeStarting();
            await this.api.app_start(this.getDuid(), this.getMatterCommandOptions());
        });
    }
    async returnToDock(surface = exports.MATTER_SURFACE) {
        // Always forward an explicit Matter dock to the robot. As with pause, the
        // cached snapshot can lag or be overridden by a stale HomeData refresh while
        // the robot is really cleaning (issues #4 and #12); docking an already-docked
        // robot is a harmless no-op.
        if (this.isDockedOrChargingNow()) {
            this.platform.log.info(`Sending ${this.getVacuumName()} back to dock from ${surfacePhrase(surface)} despite a docked snapshot; the cached state may be stale.`);
        }
        else {
            this.platform.log.info(`Sending ${this.getVacuumName()} back to dock from ${surfacePhrase(surface)}.`);
        }
        const returnOperationalState = this.isExtendedOperationalStateEnabled()
            ? RVC_OPERATIONAL_STATE.SEEKING_CHARGER
            : RVC_OPERATIONAL_STATE.STOPPED;
        const state = {
            rvcRunMode: {
                currentMode: this.isInCleaningRunMode(returnOperationalState)
                    ? RUN_MODE_CLEANING
                    : RUN_MODE_IDLE,
            },
            rvcOperationalState: {
                operationalState: returnOperationalState,
            },
        };
        this.setAndScheduleOptimisticState(state, "return to dock");
        this.dispatchRoborockMatterCommand("return to dock", () => this.api.app_charge(this.getDuid(), this.getMatterCommandOptions()), { retryReturnToDockIfStillActive: true, surface });
    }
    scheduleMatterStateUpdate(reason, optimisticGeneration) {
        if (!this.registered) {
            return;
        }
        const timer = (0, timers_1.scheduleTimer)(() => {
            if (optimisticGeneration !== undefined &&
                optimisticGeneration !== this.optimisticGeneration) {
                this.platform.log.debug(`Skipping stale Matter optimistic state update after ${reason} for ${this.getVacuumName()}.`);
                return;
            }
            // Build the snapshot at execution time so it reflects the freshest
            // Roborock and optimistic state instead of a stale captured copy.
            void this.updateMatterState(this.buildClusters(), reason)
                .then((updated) => {
                if (updated) {
                    this.ensureMatterStateHeartbeat();
                }
            })
                .catch((error) => {
                this.platform.log.warn(`Unable to update Matter state after ${reason} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, 0);
        (0, timers_1.unrefTimer)(timer);
    }
    setAndScheduleOptimisticState(partialClusters, reason) {
        var _a;
        if (this.getNumberFromValue((_a = partialClusters.rvcOperationalState) === null || _a === void 0 ? void 0 : _a.operationalState) === RVC_OPERATIONAL_STATE.RUNNING) {
            // Remember when a start/resume/area-clean was issued so a follow-up pause
            // or dock is not dropped while the robot is still spinning up and the
            // cached snapshot lags behind (see RECENT_CLEANING_COMMAND_WINDOW_MS).
            this.lastCleaningCommandAt = Date.now();
        }
        const optimisticGeneration = this.setOptimisticState(partialClusters, reason);
        this.scheduleMatterStateUpdate(reason, optimisticGeneration);
    }
    hasRecentlyCommandedCleaning() {
        return (Date.now() - this.lastCleaningCommandAt <
            RECENT_CLEANING_COMMAND_WINDOW_MS);
    }
    async updateMatterState(partialClusters, reason = "state update") {
        if (!this.registered) {
            return false;
        }
        const matter = this.platform.getMatterApi();
        if (!matter || typeof matter.updateAccessoryState !== "function") {
            return false;
        }
        if (Object.keys(partialClusters).length === 0) {
            return false;
        }
        // Every publish is a full snapshot and writes are serialized in submission
        // order. matter.js suppresses no-op attribute writes at its store level, so
        // no plugin-side change tracking is needed; tracking published values here
        // previously allowed racing publishers to desynchronize the plugin from the
        // Matter store, leaving Apple Home stuck on stale state ("Updating...").
        // Per-cluster fault isolation: one misbehaving cluster (bad attribute
        // shape, transient matter.js error) must never block the others — a
        // frozen battery reading because the operational-state publish failed is
        // exactly the failure mode this prevents. Only a TOTAL failure is
        // rethrown, preserving the initialization-retry semantics below.
        const clusterEntries = Object.entries(partialClusters);
        const publishTask = this.matterPublishChain.then(async () => {
            const failures = [];
            await Promise.all(clusterEntries.map(async ([cluster, attributes]) => {
                try {
                    await matter.updateAccessoryState(this.accessory.UUID, cluster, attributes);
                    this.lastPublishedClusterJson.set(cluster, JSON.stringify(attributes));
                }
                catch (error) {
                    // Drop the record so the cluster is retried on the next snapshot
                    // even if its payload is unchanged.
                    this.lastPublishedClusterJson.delete(cluster);
                    failures.push(error);
                    this.platform.log.debug(`Matter publish for cluster ${cluster} on ${this.accessory.UUID} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }));
            if (failures.length > 0) {
                if (failures.length === clusterEntries.length) {
                    throw failures[0];
                }
                // Partial failure: the surviving clusters have landed (that is the
                // isolation), but an initializing endpoint should still get its
                // retry so the failed cluster receives its value too.
                const initFailure = failures.find((failure) => this.isMatterInitializingError(failure));
                if (initFailure) {
                    this.scheduleMatterInitializationRetry(reason, initFailure);
                }
            }
        });
        this.matterPublishChain = publishTask.then(() => undefined, () => undefined);
        try {
            await publishTask;
            this.matterInitializationRetryAttempt = 0;
            this.matterInitializationRetryPending = false;
            return true;
        }
        catch (error) {
            if (this.isMatterInitializingError(error)) {
                this.scheduleMatterInitializationRetry(reason, error);
                return false;
            }
            throw error;
        }
    }
    /**
     * Publish a full Roborock cluster snapshot, performing a one-time battery
     * resync per boot first: the battery attributes are published as briefly
     * unknown and then with their real values, which makes two genuine store
     * changes and bumps the cluster data version, so a controller that reads
     * the cluster sees a new version instead of a value that has sat unchanged
     * since pairing day.
     *
     * It does NOT push the new percentage to a subscriber, and no bridge-side
     * write can. `PowerSource.batPercentRemaining` carries the Matter "changes
     * omitted" (C) quality, and the spec is explicit: such an attribute "SHALL
     * NOT have delta changes published as part of a Subscribe interaction".
     * matter.js implements that faithfully and closed the request to opt out of
     * it as works-as-intended (matter.js#4163, 28 July 2026), with the
     * maintainer noting that ecosystems are expected to poll these attributes
     * themselves. Apple Home does not, which is why the tile can hold the
     * percentage it was paired with. That is an Apple-side gap to report
     * through Apple's feedback process — do not reintroduce a workaround here.
     */
    async publishRoborockSnapshot(clusters, reason, options = {}) {
        // Skip clusters whose payload is byte-identical to the last confirmed
        // publish: every 15s poll and every heartbeat otherwise re-submits 4-6
        // unchanged clusters per robot through the Homebridge/matter.js stack.
        // The heartbeat passes force=true, keeping a periodic full write as the
        // self-healing safety net.
        // The full snapshot as built, kept across the diff below so the evidence
        // line always reports every value — not just the clusters that changed.
        const snapshot = clusters;
        if (options.force !== true) {
            const changed = {};
            for (const [cluster, attributes] of Object.entries(clusters)) {
                if (JSON.stringify(attributes) !==
                    this.lastPublishedClusterJson.get(cluster)) {
                    changed[cluster] = attributes;
                }
            }
            if (Object.keys(changed).length === 0) {
                // Everything already published: a no-op is a successful publish.
                this.logMatterPublishIfChanged(snapshot);
                return true;
            }
            clusters = changed;
        }
        const power = clusters.powerSource;
        const resyncEligible = !this.powerSourceResyncDone &&
            power !== undefined &&
            typeof power.batPercentRemaining === "number";
        if (resyncEligible) {
            await this.updateMatterState({
                powerSource: {
                    ...power,
                    batPercentRemaining: null,
                    batChargeState: 0,
                    batTimeToFullCharge: null,
                },
            }, "Battery resync nudge");
        }
        const updated = await this.updateMatterState(clusters, reason);
        if (updated) {
            this.logMatterPublishIfChanged(snapshot);
        }
        if (updated && resyncEligible) {
            this.powerSourceResyncDone = true;
            this.platform.log.debug(`Battery resync for ${this.getVacuumName()}: republished the battery attributes to bump their Matter data version (battery=${power.batPercentRemaining / 2}%).`);
        }
        return updated;
    }
    async updateMatterStateFromMessage(data) {
        if (!this.registered) {
            return;
        }
        const status = this.extractStatusUpdate(data);
        if (!status) {
            return;
        }
        const state = this.getNumberFromValue(status.state);
        const chargeStatus = this.getNumberFromValue(status.charge_status);
        const battery = this.getNumberFromValue(status.battery);
        const cleanArea = this.getNumberFromValue(status.clean_area);
        const cleanTime = this.getNumberFromValue(status.clean_time);
        const fanPower = this.getNumberFromValue(status.fan_power);
        const matterCleanType = this.getNumberFromValue(status.matter_clean_type);
        // Fan power and clean type count as meaningful updates too. A suction or
        // mop-mode change made in the Roborock app (or chosen by SmartPlan) pushes
        // a frame carrying only that field; treating it as empty meant the Apple
        // Home clean-mode picker kept showing the previous level until some other
        // event happened to arrive. The publish below resolves the operational
        // state through getNumberStatus, which falls back to the remembered state,
        // so a frame without `state` does not reset the tile.
        //
        // Derived from MEANINGFUL_LIVE_STATUS_FIELDS rather than spelled out, so
        // this check and extractStatusUpdate's gate always name the same fields.
        const meaningfulValues = {
            state,
            charge_status: chargeStatus,
            battery,
            clean_area: cleanArea,
            clean_time: cleanTime,
            fan_power: fanPower,
            matter_clean_type: matterCleanType,
        };
        if (MEANINGFUL_LIVE_STATUS_FIELDS.every((field) => meaningfulValues[field] === null)) {
            return;
        }
        // Remember the freshest live values so a later full cluster rebuild reflects
        // them instead of the slower HomeData snapshot.
        const previousState = this.getNumberStatus("state");
        if (state !== null &&
            state !== ROOM_CLEAN_STATE &&
            state !== PAUSED_STATE) {
            this.roomCleaningAreaConfirmed = false;
        }
        else if (state === ROOM_CLEAN_STATE &&
            previousState !== ROOM_CLEAN_STATE &&
            previousState !== PAUSED_STATE) {
            this.roomCleaningAreaConfirmed = false;
        }
        this.rememberLiveStatus("state", state);
        this.rememberLiveStatus("charge_status", chargeStatus);
        this.rememberLiveStatus("battery", battery);
        this.rememberLiveStatus("clean_area", cleanArea);
        this.rememberLiveStatus("clean_time", cleanTime);
        // Fan power and clean type drive the live RvcCleanMode derivation, so
        // cleans (re)configured outside Apple Home surface within one update.
        this.rememberLiveStatus("fan_power", fanPower);
        this.rememberLiveStatus("matter_clean_type", matterCleanType);
        if ((state !== null && state !== void 0 ? state : previousState) === ROOM_CLEAN_STATE &&
            cleanArea !== null &&
            cleanTime !== null) {
            this.roomCleaningAreaConfirmed = cleanArea > 0 && cleanTime > 0;
        }
        if (state !== null || chargeStatus !== null) {
            // Confirm or contradict any pending optimistic state. While optimism is
            // active the snapshot below still publishes the optimistic values, so no
            // separate suppression of the live values is needed.
            this.reconcileOptimisticStateWithLive(this.getOperationalState(state, chargeStatus), state, chargeStatus);
        }
        if (state !== null) {
            this.completeServiceAreaProgressIfDone(this.getOperationalState(state, chargeStatus));
        }
        // Live map-position room tracking: reflect the physically detected room
        // in currentArea/progress before the snapshot below is built.
        const liveOperationalState = this.getOperationalState(this.getNumberStatus("state"), this.getNumberStatus("charge_status"));
        this.applyLiveServiceAreaRoom(liveOperationalState);
        this.driveLiveRoomTracking(liveOperationalState);
        const updated = await this.publishRoborockSnapshot(this.buildClusters(), "live state");
        if (updated) {
            this.ensureMatterStateHeartbeat();
        }
    }
    buildClusters() {
        const clusters = {
            rvcRunMode: this.buildRunModeCluster(),
            rvcOperationalState: this.buildOperationalStateCluster(),
        };
        this.addCleanModeCluster(clusters);
        this.addPowerSourceCluster(clusters);
        if (this.isServiceAreaEnabled() && this.hasServiceAreasToExpose()) {
            // Publishing a Service Area cluster with an empty supportedAreas list
            // violates Matter conformance (the spec requires at least one area)
            // and makes Apple Home abort commissioning. Robots without room data
            // (e.g. B01/Q7 until the map channel lands) omit the cluster instead.
            clusters.serviceArea = this.buildServiceAreaCluster();
        }
        return this.applyOptimisticState(clusters);
    }
    buildCluster(cluster) {
        var _a;
        let clusterState;
        switch (cluster) {
            case "rvcRunMode":
                clusterState = this.buildRunModeCluster();
                break;
            case "rvcCleanMode":
                clusterState = this.isCleanModeEnabled()
                    ? this.buildCleanModeCluster()
                    : undefined;
                break;
            case "rvcOperationalState":
                clusterState = this.buildOperationalStateCluster();
                break;
            case "powerSource":
                clusterState = this.isPowerSourceEnabled()
                    ? this.buildPowerSourceCluster()
                    : undefined;
                break;
            case "serviceArea":
                clusterState =
                    this.isServiceAreaEnabled() && this.hasServiceAreasToExpose()
                        ? this.buildServiceAreaCluster()
                        : undefined;
                break;
            default:
                return undefined;
        }
        if (!clusterState) {
            return undefined;
        }
        const optimisticCluster = (_a = this.getActiveOptimisticState()) === null || _a === void 0 ? void 0 : _a[cluster];
        return optimisticCluster
            ? { ...clusterState, ...optimisticCluster }
            : clusterState;
    }
    buildRunModeCluster() {
        return {
            supportedModes: [
                {
                    label: "Idle",
                    mode: RUN_MODE_IDLE,
                    modeTags: [{ value: RVC_RUN_MODE_TAG_IDLE }],
                },
                {
                    label: "Cleaning",
                    mode: RUN_MODE_CLEANING,
                    modeTags: [{ value: RVC_RUN_MODE_TAG_CLEANING }],
                },
            ],
            currentMode: this.resolveRunMode(),
        };
    }
    /**
     * The Matter run mode to publish.
     *
     * Apple Home treats RvcRunMode as the answer to "is this robot cleaning?":
     * it announces a cleaning that started when the mode goes to Cleaning and
     * one that finished when it goes back to Idle. A dock chore is neither.
     * Emptying the dust bin while the robot sat idle in its dock published
     * Cleaning and then Idle again, so the dock's own housekeeping announced a
     * cleaning that never happened (issue #9, Q Revo). The mirror image matters
     * just as much: a robot that empties its bin in the MIDDLE of a run must not
     * announce that the run finished and started again.
     *
     * So a dock chore inherits the run mode that was published before it began,
     * instead of deciding one of its own.
     *
     * The chore is recognised from the robot's own state, not from the
     * controller-facing one: with "Extended Operational States" off, emptying
     * the dust bin is rewritten to RUNNING one level below, and reading that
     * would leave the rule working only for the users who enabled the toggle.
     */
    resolveRunMode() {
        const roborockOperationalState = this.getRoborockOperationalState(this.getNumberStatus("state"), this.getNumberStatus("charge_status"));
        if (DOCK_ACTIVITY_STATES.has(roborockOperationalState)) {
            return this.lastRunMode;
        }
        this.lastRunMode = this.isInCleaningRunMode(this.getOperationalState())
            ? RUN_MODE_CLEANING
            : RUN_MODE_IDLE;
        return this.lastRunMode;
    }
    buildCleanModeCluster() {
        return {
            supportedModes: this.getSupportedCleanModes(),
            currentMode: this.getCurrentCleanMode(),
        };
    }
    getSupportedCleanModes() {
        const supportedModes = [
            {
                label: "Vacuum",
                mode: CLEAN_MODE_VACUUM,
                modeTags: [{ value: RVC_CLEAN_MODE_TAG_VACUUM }],
            },
        ];
        const capabilities = this.getMatterCleanModeCapabilities();
        if (capabilities.canMop) {
            supportedModes.push({
                label: "Mop",
                mode: CLEAN_MODE_MOP,
                modeTags: [{ value: RVC_CLEAN_MODE_TAG_MOP }],
            }, {
                // Matter has no dedicated "vacuum then mop" tag, so combine the two
                // standard RVC Clean Mode tags instead of an undefined tag value.
                label: "Vacuum + Mop",
                mode: CLEAN_MODE_VACUUM_AND_MOP,
                modeTags: [
                    { value: RVC_CLEAN_MODE_TAG_VACUUM },
                    { value: RVC_CLEAN_MODE_TAG_MOP },
                ],
            });
        }
        // Opt-in suction-level variants, only when the robot actually exposes
        // fan-power control. NOTE: Matter fixes the announced mode set at
        // commissioning — toggling this option requires re-pairing the robot.
        if (this.isFanPowerCleanModesEnabled() &&
            capabilities.canControlFanPower === true) {
            const powerModes = capabilities.canMaxPlusFanPower === true
                ? [...FAN_POWER_CLEAN_MODES, MAX_PLUS_FAN_POWER_CLEAN_MODE]
                : FAN_POWER_CLEAN_MODES;
            for (const powerMode of powerModes) {
                supportedModes.push({
                    label: powerMode.label,
                    mode: powerMode.mode,
                    modeTags: [
                        { value: RVC_CLEAN_MODE_TAG_VACUUM },
                        ...powerMode.extraTags.map((value) => ({ value })),
                    ],
                });
            }
        }
        return supportedModes;
    }
    isFanPowerCleanModesEnabled() {
        return this.platform.platformConfig.enableFanPowerCleanModes === true;
    }
    getFanPowerCleanMode(cleanMode) {
        var _a;
        if (cleanMode === MAX_PLUS_FAN_POWER_CLEAN_MODE.mode) {
            return MAX_PLUS_FAN_POWER_CLEAN_MODE;
        }
        return ((_a = FAN_POWER_CLEAN_MODES.find((powerMode) => powerMode.mode === cleanMode)) !== null && _a !== void 0 ? _a : null);
    }
    getCurrentCleanMode() {
        let selected = this.isSupportedCleanMode(this.selectedCleanMode)
            ? this.selectedCleanMode
            : CLEAN_MODE_VACUUM;
        // Live clean-type derivation during an active run: cleans started from
        // the Roborock app or the robot's own buttons carry their own clean type
        // (vacuum / mop / vacuum+mop), so report what the robot is ACTUALLY
        // doing instead of the last Matter selection. B01/Q7 robots report the
        // type directly; classic robots are derived from the mop-only fan power
        // signature and the active water-flow setting. A pending Matter
        // selection wins until it has been applied, and outside an active run
        // the (sticky) robot-side setting must not shadow the user's selection.
        const inCleaningRun = this.isInCleaningRunMode(this.getOperationalState());
        this.trackAppliedCleanTypeRun(inCleaningRun);
        if (!this.selectedCleanModeNeedsApply && inCleaningRun) {
            const liveCleanType = this.getLiveCleanType();
            if (liveCleanType !== null &&
                this.isSupportedCleanMode(liveCleanType) &&
                this.acceptLiveCleanType(liveCleanType)) {
                if (liveCleanType !== CLEAN_MODE_VACUUM) {
                    return liveCleanType;
                }
                // Vacuum-family: fall through so the fan-power refinement below can
                // pick the matching suction variant when those modes are announced.
                selected = CLEAN_MODE_VACUUM;
            }
        }
        // Live derivation while suction-level modes are announced: report the
        // variant matching the robot's ACTUAL fan power, so suction changed in
        // the Roborock app is reflected in Apple Home's mode picker. A pending
        // Matter selection wins until it has been applied, and mop-family
        // selections are never overridden (their identity is the clean type,
        // not the fan level).
        if (this.isFanPowerCleanModesEnabled() &&
            !this.selectedCleanModeNeedsApply &&
            selected !== CLEAN_MODE_MOP &&
            selected !== CLEAN_MODE_VACUUM_AND_MOP) {
            const liveFanPower = this.getNumberStatus("fan_power");
            if (liveFanPower !== null) {
                const liveMode = liveFanPower === MAX_PLUS_FAN_POWER_CLEAN_MODE.fanPower
                    ? MAX_PLUS_FAN_POWER_CLEAN_MODE
                    : FAN_POWER_CLEAN_MODES.find((powerMode) => powerMode.fanPower === liveFanPower);
                if (liveMode && this.isSupportedCleanMode(liveMode.mode)) {
                    this.lastResolvedFanPowerCleanMode = liveMode.mode;
                    return liveMode.mode;
                }
            }
            // The fan power could not be resolved to one of the announced levels
            // (nothing readable, or a value outside them such as 105 "off"). The
            // plugin does not know which level the robot is on — and `selected`,
            // which defaults to plain Vacuum, is not that knowledge. Reporting it
            // anyway made both Q7 robots flip between "Max Vacuum" and "Vacuum" in
            // Apple Home on every battery tick while docked (measured 11 Aug 2026,
            // ten pairs of publishes one second apart). Keeping the level last
            // actually read says nothing new instead of saying something untrue;
            // an explicit Apple Home selection clears it, so a user's choice is
            // never shadowed by a level read before they made it.
            if (this.lastResolvedFanPowerCleanMode !== null &&
                this.isSupportedCleanMode(this.lastResolvedFanPowerCleanMode)) {
                return this.lastResolvedFanPowerCleanMode;
            }
        }
        return selected;
    }
    /**
     * The clean type the robot itself reports for the CURRENT run, translated
     * to the Matter clean-mode id, or null when the robot gives no signal.
     * B01/Q7: reported directly (`mode` property in every status poll).
     * Classic v1: fan power 105 ("off") is the mop-only signature; otherwise an
     * active water-flow setting on a mop-capable robot means vacuum+mop.
     */
    getLiveCleanType() {
        var _a;
        const reported = this.getNumberStatus("matter_clean_type");
        if (reported !== null) {
            return reported;
        }
        const fanPower = this.getNumberStatus("fan_power");
        if (fanPower === ROBOROCK_FAN_POWER_OFF) {
            return CLEAN_MODE_MOP;
        }
        if (!this.getMatterCleanModeCapabilities().canControlWater) {
            // Without water-flow control there is no reliable mop signal; robots
            // like mop-less models must not be guessed into a mop mode.
            return null;
        }
        const waterBoxMode = (_a = this.getNumberStatus("water_box_custom_mode")) !== null && _a !== void 0 ? _a : this.getNumberStatus("water_box_mode");
        if (waterBoxMode === null) {
            return null;
        }
        return waterBoxMode !== ROBOROCK_WATER_BOX_OFF
            ? CLEAN_MODE_VACUUM_AND_MOP
            : CLEAN_MODE_VACUUM;
    }
    /**
     * The base clean TYPE a Matter clean mode belongs to. Suction-level modes
     * are vacuum-family variants with a pinned fan power, so they reduce to
     * plain Vacuum; the three base types reduce to themselves.
     *
     * Both the settings builder and the applied-type bookkeeping need this
     * reduction. A second hand-written copy of it is how the two ends drift
     * apart — the most repeated defect in this codebase — so there is one.
     */
    getBaseCleanType(cleanMode) {
        return this.getFanPowerCleanMode(cleanMode) ? CLEAN_MODE_VACUUM : cleanMode;
    }
    /**
     * Whether a clean type derived from the robot's live status may be reported.
     *
     * It may not when it contradicts a clean type this plugin applied for the
     * run in progress and had acknowledged, and the robot has not yet caught up.
     * Measured in #8 (skmzwanke, Saros 10, 12 Aug 2026) — 114 seconds of Apple
     * Home showing a mode nobody asked for:
     *
     *   16:09:20  Applying Vacuum mode to Weebo before starting.
     *   16:09:20  ...acknowledged by Roborock in 791 ms via cloud
     *   16:09:22  Matter publish ... cleanMode=0   <- what was asked for
     *   16:09:29  Matter publish ... cleanMode=2   <- the robot's lagging water
     *   16:11:23  Matter publish ... cleanMode=0   <- it finally caught up
     *
     * The reading behind that `2` is the water-box level, and the prep path
     * already documents that this very reading lies in this very window — it
     * refuses to consult it when deciding whether to send. Publishing it as the
     * truth from the other end was the inconsistency, not the robot's lag.
     *
     * Same rule as 3.4.11: when the plugin does not know, it says nothing new
     * rather than something untrue. The pin is released the moment the robot's
     * own report agrees, so a clean type changed in the Roborock app mid-run is
     * still followed.
     */
    acceptLiveCleanType(liveCleanType) {
        const pin = this.appliedCleanTypePin;
        if (!pin) {
            return true;
        }
        if (this.getBaseCleanType(liveCleanType) === pin.cleanType) {
            this.appliedCleanTypePin = null;
            return true;
        }
        // Never silently: a robot that acknowledges the command and then ignores
        // it is a different and worse fault than a robot that lags, and the only
        // way to tell them apart is for this to be in the log without debug on.
        if (!pin.reported) {
            pin.reported = true;
            this.platform.log.warn(`Roborock still reports ${this.getCleanModeLabel(liveCleanType)} for ${this.getVacuumName()} after ${this.getCleanModeLabel(pin.cleanType)} was applied and acknowledged; Apple Home keeps showing the mode that was asked for until the robot's own report agrees.`);
        }
        return false;
    }
    /**
     * Follow the run a pinned clean type belongs to, and drop the pin when that
     * run ends so the next clean — which may be started from the Roborock app in
     * a completely different mode — is reported from the robot's own signal.
     *
     * The pin is deliberately NOT dropped before the run has been seen running:
     * a publish landing between the apply and the robot reporting that it has
     * started would otherwise release it before it had done anything at all.
     */
    trackAppliedCleanTypeRun(inCleaningRun) {
        const pin = this.appliedCleanTypePin;
        if (!pin) {
            return;
        }
        if (inCleaningRun) {
            pin.runObserved = true;
        }
        else if (pin.runObserved) {
            this.appliedCleanTypePin = null;
        }
    }
    isSupportedCleanMode(mode) {
        return this.getSupportedCleanModes().some((supportedMode) => supportedMode.mode === mode);
    }
    getMatterCleanModeCapabilities() {
        const getCapabilities = this.api.getMatterCleanModeCapabilities;
        if (typeof getCapabilities !== "function") {
            return { canVacuum: true, canMop: false };
        }
        // Guard against older/patched API builds returning undefined so cluster
        // builds (which run inside Matter attribute reads) can never throw.
        const capabilities = getCapabilities.call(this.api, this.getDuid());
        return capabilities !== null && capabilities !== void 0 ? capabilities : { canVacuum: true, canMop: false };
    }
    /**
     * Makes the robot match the clean mode Apple Home is displaying, before a
     * Matter-initiated start.
     *
     * This used to run only when the user had just CHANGED the mode — the flag
     * was set by the ChangeToMode handler and by nothing else. That left the
     * most ordinary case of all unhandled: the mode Home already shows is
     * usually the mode the user wants, so they never tap it, so no ChangeToMode
     * arrives, so nothing was sent and the robot ran in whatever mode it had
     * been left in. Measured in #8: a "Vacuum" start with no preceding mode
     * request sent no water command at all and the robot mopped, while the same
     * start one explicit tap later sent it and vacuumed.
     *
     * Starting a clean is a promise that the robot will run in the displayed
     * mode, so the mode is applied on every start, changed or not. It is
     * deliberately NOT skipped when the robot looks like it already matches:
     * the reading such a check would consult is exactly the one that lies — a
     * docked robot's water-box status read as plain Vacuum for the robot that
     * then mopped. The settings themselves preserve the user's levels (a
     * vacuum-family mode keeps the robot's current suction, a mop-family mode
     * its current water level), so applying pins the clean TYPE and nothing else.
     */
    async applyCleanModeBeforeStarting() {
        const applySettings = this.api.applyMatterCleanModeSettings;
        if (typeof applySettings !== "function") {
            this.selectedCleanModeNeedsApply = false;
            this.appliedCleanTypePin = null;
            return;
        }
        // Read the displayed mode ONCE. It is what is being promised to the user,
        // and the bookkeeping below has to record the same value that was sent.
        const cleanMode = this.getCurrentCleanMode();
        const settings = this.getRoborockCleanModeSettings(cleanMode);
        if (!settings) {
            this.selectedCleanModeNeedsApply = false;
            this.appliedCleanTypePin = null;
            return;
        }
        this.platform.log.info(`Applying ${this.getCleanModeLabel(cleanMode)} mode to ${this.getVacuumName()} before starting.`);
        try {
            await this.withCleanModePrepTimeout(applySettings.call(this.api, this.getDuid(), settings, this.getMatterCleanModePrepCommandOptions()));
            // Sent AND acknowledged, so this is known ground truth about the run
            // that is starting. It outranks a robot report that has not caught up.
            this.appliedCleanTypePin = {
                cleanType: this.getBaseCleanType(cleanMode),
                runObserved: false,
                reported: false,
            };
        }
        catch (error) {
            // Nothing was confirmed, so nothing is known: the robot's own report is
            // the only signal there is about this run, and it keeps its authority.
            this.appliedCleanTypePin = null;
            this.platform.log.warn(`Unable to apply ${this.getCleanModeLabel(cleanMode)} mode to ${this.getVacuumName()} before starting; continuing with the start command. ${this.getErrorMessage(error)}`);
        }
        finally {
            this.selectedCleanModeNeedsApply = false;
        }
    }
    async withCleanModePrepTimeout(promise) {
        let timeout;
        const timeoutPromise = new Promise((_, reject) => {
            timeout = (0, timers_1.scheduleTimer)(() => {
                reject(new Error(`Matter clean mode prep timed out after ${MATTER_CLEAN_MODE_PREP_TIMEOUT_MS} ms.`));
            }, MATTER_CLEAN_MODE_PREP_TIMEOUT_MS);
            (0, timers_1.unrefTimer)(timeout);
        });
        try {
            return await Promise.race([promise, timeoutPromise]);
        }
        finally {
            if (timeout) {
                (0, timers_1.clearTimer)(timeout);
            }
        }
    }
    getRoborockCleanModeSettings(cleanMode) {
        const capabilities = this.getMatterCleanModeCapabilities();
        // Fan-power variants are vacuum-family modes with a pinned suction
        // level: protocol layers only understand the three base clean types, so
        // translate before handing over.
        const fanPowerMode = this.getFanPowerCleanMode(cleanMode);
        const baseCleanMode = this.getBaseCleanType(cleanMode);
        // Always carry the selected Matter clean mode; protocol layers that have
        // a native clean-type concept (B01/Q7) apply it directly and ignore the
        // v1-style fan/water workarounds below.
        const settings = { cleanMode: baseCleanMode };
        if (capabilities.canControlFanPower) {
            settings.fanPower = fanPowerMode
                ? fanPowerMode.fanPower
                : baseCleanMode === CLEAN_MODE_MOP
                    ? ROBOROCK_FAN_POWER_OFF
                    : this.getPreferredVacuumFanPower();
        }
        if (capabilities.canControlWater) {
            settings.waterBoxMode =
                baseCleanMode === CLEAN_MODE_VACUUM
                    ? ROBOROCK_WATER_BOX_OFF
                    : this.getPreferredWaterBoxMode();
        }
        return Object.keys(settings).length > 0 ? settings : null;
    }
    rememberCurrentRoborockCleanModeSettings() {
        const fanPower = this.getNumberStatus("fan_power");
        if (fanPower !== null && fanPower !== ROBOROCK_FAN_POWER_OFF) {
            this.lastVacuumFanPower = fanPower;
        }
        const waterBoxMode = this.getWaterBoxModeStatus();
        if (waterBoxMode !== null && waterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
            this.lastWaterBoxMode = waterBoxMode;
        }
    }
    getPreferredVacuumFanPower() {
        var _a;
        const currentFanPower = this.getNumberStatus("fan_power");
        if (currentFanPower !== null &&
            currentFanPower !== ROBOROCK_FAN_POWER_OFF) {
            this.lastVacuumFanPower = currentFanPower;
            return currentFanPower;
        }
        return (_a = this.lastVacuumFanPower) !== null && _a !== void 0 ? _a : ROBOROCK_FAN_POWER_BALANCED;
    }
    getWaterBoxModeStatus() {
        var _a;
        return ((_a = this.getNumberStatus("water_box_custom_mode")) !== null && _a !== void 0 ? _a : this.getNumberStatus("water_box_mode"));
    }
    getPreferredWaterBoxMode() {
        var _a;
        const currentWaterBoxMode = this.getWaterBoxModeStatus();
        if (currentWaterBoxMode !== null &&
            currentWaterBoxMode !== ROBOROCK_WATER_BOX_OFF) {
            this.lastWaterBoxMode = currentWaterBoxMode;
            return currentWaterBoxMode;
        }
        return (_a = this.lastWaterBoxMode) !== null && _a !== void 0 ? _a : ROBOROCK_WATER_BOX_MILD;
    }
    getCleanModeLabel(cleanMode) {
        const fanPowerMode = this.getFanPowerCleanMode(cleanMode);
        if (fanPowerMode) {
            return fanPowerMode.label;
        }
        switch (cleanMode) {
            case CLEAN_MODE_MOP:
                return "Mop";
            case CLEAN_MODE_VACUUM_AND_MOP:
                return "Vacuum + Mop";
            default:
                return "Vacuum";
        }
    }
    buildOperationalStateCluster() {
        const operationalState = this.getOperationalState();
        const cluster = {
            // RVC Operational State requires PhaseList and CurrentPhase to be null.
            phaseList: null,
            currentPhase: null,
            // Advertise operational state IDs without labels. Apple Home stops
            // commissioning ("Connecting" forever) when the list carries labels or
            // manufacturer-range IDs, so only bare IDs are exposed here.
            operationalStateList: this.getOperationalStateList().map((operationalStateId) => ({ operationalStateId })),
            operationalState,
        };
        // The Matter fault attribute (`operationalError`) is deliberately never
        // published, in any configuration.
        //
        // Three controlled tests on an S8 Pro Ultra with an empty clean water
        // tank settled it. Apple Home drew no warning when the fault was sent
        // beside a Charging state, and drew no warning when the fault was sent
        // beside a forced Error state either — while the tile went to a stuck
        // "Updating…" that needed a manual poke. Apple does not appear to render
        // RVC OperationalError from a bridged accessory at all, so publishing it
        // is pure risk for a benefit that has never once materialised. That is
        // also why 1.4.61 removed the plugin's original write.
        //
        // The Error operational STATE is a different matter and is still
        // reported below: Apple renders operational states perfectly well (the
        // same robot shows Charging, Docked, Emptying and Washing correctly), so
        // a robot stuck under the sofa can stop claiming it is Ready without
        // touching the attribute that causes trouble.
        return cluster;
    }
    buildPowerSourceCluster(batteryValue, chargeStatusValue, stateValue) {
        const battery = batteryValue === undefined
            ? this.getNumberStatus("battery")
            : batteryValue;
        const chargeStatus = chargeStatusValue === undefined
            ? this.getNumberStatus("charge_status")
            : chargeStatusValue;
        const state = stateValue === undefined ? this.getNumberStatus("state") : stateValue;
        const normalizedBattery = battery === null ? null : Math.max(0, Math.min(100, battery));
        const batChargeState = this.getBatteryChargeState(normalizedBattery, chargeStatus, state);
        return {
            status: normalizedBattery === null
                ? POWER_SOURCE_STATUS.UNAVAILABLE
                : POWER_SOURCE_STATUS.ACTIVE,
            order: 0,
            description: "Roborock vacuum battery",
            batPresent: normalizedBattery !== null,
            batPercentRemaining: normalizedBattery === null ? null : normalizedBattery * 2,
            batChargeLevel: this.getBatteryChargeLevel(normalizedBattery),
            batChargeState,
            batReplacementNeeded: false,
            batReplaceability: BATTERY_REPLACEABILITY.UNSPECIFIED,
            batFunctionalWhileCharging: true,
            batTimeToFullCharge: this.getBatteryTimeToFullCharge(normalizedBattery, batChargeState),
            batChargingCurrent: null,
        };
    }
    addPowerSourceCluster(clusters, batteryValue, chargeStatusValue, stateValue) {
        if (!this.isPowerSourceEnabled()) {
            return;
        }
        clusters.powerSource = this.buildPowerSourceCluster(batteryValue, chargeStatusValue, stateValue);
    }
    addCleanModeCluster(clusters) {
        if (!this.isCleanModeEnabled()) {
            return;
        }
        clusters.rvcCleanMode = this.buildCleanModeCluster();
    }
    hasServiceAreasToExpose() {
        return this.getMatterServiceAreas().length > 0;
    }
    persistServiceAreaProgress() {
        // Best-effort: Homebridge persists accessory context periodically and on
        // shutdown, so a restart mid-clean restores the room display instead of
        // silently dropping back to a generic label.
        this.accessory.context.serviceAreaProgressState = {
            currentArea: this.serviceAreaCurrentArea,
            progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
        };
    }
    restoreServiceAreaProgress() {
        var _a;
        const persisted = (_a = this.accessory.context) === null || _a === void 0 ? void 0 : _a.serviceAreaProgressState;
        if (!persisted || !Array.isArray(persisted.progress)) {
            return;
        }
        this.serviceAreaCurrentArea =
            typeof persisted.currentArea === "number" ? persisted.currentArea : null;
        this.serviceAreaProgress = persisted.progress
            .filter((entry) => typeof entry === "object" &&
            entry !== null &&
            typeof entry.areaId === "number" &&
            typeof entry.status === "number")
            .map((entry) => ({ ...entry }));
    }
    beginServiceAreaProgress(areaIds) {
        if (areaIds.length === 0) {
            this.clearServiceAreaProgress();
            return;
        }
        // We know which rooms were requested; until live map-position tracking
        // reports which one the robot is actually inside, the first requested
        // area is shown as operating and the rest as pending.
        this.liveConfirmedServiceAreaIds = new Set();
        this.serviceAreaCurrentArea = areaIds[0];
        this.serviceAreaProgress = areaIds.map((areaId, index) => ({
            areaId,
            status: index === 0
                ? SERVICE_AREA_PROGRESS.OPERATING
                : SERVICE_AREA_PROGRESS.PENDING,
        }));
        this.persistServiceAreaProgress();
    }
    /**
     * A full-home clean operates on every supported area. We cannot know which
     * room the robot is physically inside (the robots do not report it), so no
     * area is marked operating and currentArea stays null — but publishing the
     * run's scope as pending -> completed gives controllers real progress data
     * instead of an empty list, which Apple Home otherwise renders as a
     * permanent "Preparing".
     */
    beginFullCleanServiceAreaProgress() {
        const areaIds = this.getMatterServiceAreas().map((area) => area.areaId);
        if (areaIds.length === 0) {
            this.clearServiceAreaProgress();
            return;
        }
        this.liveConfirmedServiceAreaIds = new Set();
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = areaIds.map((areaId) => ({
            areaId,
            status: SERVICE_AREA_PROGRESS.PENDING,
        }));
        this.persistServiceAreaProgress();
    }
    clearServiceAreaProgress() {
        this.liveConfirmedServiceAreaIds = new Set();
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = [];
        this.persistServiceAreaProgress();
    }
    completeServiceAreaProgressIfDone(operationalState) {
        if (this.serviceAreaProgress.length === 0) {
            return;
        }
        if (this.isInCleaningRunMode(operationalState)) {
            return;
        }
        // The run ended (docked, charging, stopped): everything requested is
        // reported as completed and no area is current anymore.
        this.liveConfirmedServiceAreaIds = new Set();
        this.serviceAreaCurrentArea = null;
        this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => ({
            areaId: entry.areaId,
            status: SERVICE_AREA_PROGRESS.COMPLETED,
        }));
        this.persistServiceAreaProgress();
    }
    /**
     * Apply the live map-position room (B01/Q7: SCMap currentPose ray-cast
     * against room outlines, refreshed by the Roborock API layer while the
     * robot is actively cleaning) to the Service Area state.
     *
     * currentArea always follows the physically detected room — that is the
     * honest signal controllers render as "cleaning in <room>". The progress
     * list only transitions entries that are part of the announced run scope:
     * the detected room's entry becomes operating, and a previously operating
     * scoped entry becomes completed once the robot is detected in a DIFFERENT
     * scoped room — but only if the robot was actually detected inside it at
     * some point (otherwise it was just the initial first-requested guess and
     * honestly returns to pending). Stale all-completed lists from a finished
     * run are never mutated.
     */
    /**
     * Ask the API layer to refresh the live room while a cleaning run is
     * active (it throttles and single-flights internally; B01 robots are
     * additionally driven by their own status loop), and clear the cached
     * room once the run is over so stale rooms never leak into the next one.
     */
    driveLiveRoomTracking(operationalState) {
        if (!this.isServiceAreaEnabled()) {
            return;
        }
        const apiWithLiveRoom = this.api;
        if (this.isInCleaningRunMode(operationalState)) {
            if (typeof apiWithLiveRoom.refreshLiveRoomForDevice === "function") {
                void apiWithLiveRoom.refreshLiveRoomForDevice
                    .call(this.api, this.getDuid(), {
                    v1State: this.getNumberStatus("state"),
                })
                    .catch(() => undefined);
            }
        }
        else if (typeof apiWithLiveRoom.clearLiveRoomForDevice === "function") {
            // Run over (docked/charging/stopped/error): drop the cached room.
            apiWithLiveRoom.clearLiveRoomForDevice.call(this.api, this.getDuid());
        }
    }
    applyLiveServiceAreaRoom(operationalState) {
        var _a;
        if (!this.isServiceAreaEnabled()) {
            return;
        }
        if (!this.isInCleaningRunMode(operationalState)) {
            return;
        }
        const apiWithLiveRoom = this.api;
        // Protocol-agnostic getter (B01 + classic v1); the B01-specific getter
        // remains as a fallback for older API surfaces.
        const getLiveRoom = (_a = apiWithLiveRoom.getLiveRoomForDevice) !== null && _a !== void 0 ? _a : apiWithLiveRoom.getB01LiveRoomForDevice;
        if (typeof getLiveRoom !== "function") {
            return;
        }
        const liveRoom = this.asRecord(getLiveRoom.call(this.api, this.getDuid()));
        const segmentId = this.getNumberFromValue(liveRoom === null || liveRoom === void 0 ? void 0 : liveRoom.segmentId);
        if (segmentId === null) {
            return;
        }
        const area = this.getMatterServiceAreas().find((candidate) => candidate.segmentId === segmentId);
        if (!area) {
            return;
        }
        const changedCurrentArea = this.serviceAreaCurrentArea !== area.areaId;
        const previousAreaId = this.serviceAreaCurrentArea;
        const hasActiveScope = this.serviceAreaProgress.some((entry) => entry.status !== SERVICE_AREA_PROGRESS.COMPLETED);
        const detectedEntryInScope = this.serviceAreaProgress.some((entry) => entry.areaId === area.areaId);
        let changedProgress = false;
        if (hasActiveScope && detectedEntryInScope) {
            this.serviceAreaProgress = this.serviceAreaProgress.map((entry) => {
                if (entry.areaId === area.areaId &&
                    entry.status !== SERVICE_AREA_PROGRESS.OPERATING) {
                    changedProgress = true;
                    return {
                        areaId: entry.areaId,
                        status: SERVICE_AREA_PROGRESS.OPERATING,
                    };
                }
                if (entry.areaId !== area.areaId &&
                    entry.status === SERVICE_AREA_PROGRESS.OPERATING) {
                    changedProgress = true;
                    return {
                        areaId: entry.areaId,
                        status: this.liveConfirmedServiceAreaIds.has(entry.areaId)
                            ? SERVICE_AREA_PROGRESS.COMPLETED
                            : SERVICE_AREA_PROGRESS.PENDING,
                    };
                }
                return entry;
            });
        }
        this.liveConfirmedServiceAreaIds.add(area.areaId);
        if (!changedCurrentArea && !changedProgress) {
            return;
        }
        this.serviceAreaCurrentArea = area.areaId;
        this.persistServiceAreaProgress();
        if (changedCurrentArea) {
            // The library logs the same transition one call earlier, with the
            // segment id and the count of unresolved positions. Two info lines
            // beginning "Live room for X" per room change is the busiest recurring
            // pair in a cleaning log and the second carries nothing extra.
            this.platform.log.debug(`Matter currentArea for ${this.getVacuumName()} set to ${this.formatServiceAreaName(area)}${previousAreaId !== null ? "" : " (first detection this run)"}.`);
        }
    }
    buildServiceAreaCluster() {
        var _a;
        const areas = this.getMatterServiceAreas();
        const supportedMaps = this.getMatterServiceAreaMaps(areas);
        const includeMapNamesInAreaLabels = supportedMaps.length > 1;
        const supportedAreaIds = new Set(areas.map((area) => area.areaId));
        const selectedAreas = this.selectedServiceAreaIds.filter((areaId) => supportedAreaIds.has(areaId));
        if (selectedAreas.length !== this.selectedServiceAreaIds.length) {
            this.selectedServiceAreaIds = selectedAreas;
        }
        this.logMatterServiceAreaSummary(areas, supportedMaps);
        const state = {
            // Live cleaning progress. The attributes are ALWAYS present (empty
            // list / null when idle): Homebridge derives Matter cluster features
            // from which attributes are provided at registration (see homebridge
            // #3914 for the PowerSource equivalent), so omitting progress here
            // would leave the Service Area progress feature unannounced at
            // commissioning — controllers that render a progress pill (Apple
            // Home) then sit on a generic "Preparing"/"heading to the room"
            // label for the entire run.
            progress: this.serviceAreaProgress.map((entry) => ({ ...entry })),
            estimatedEndTime: null,
            supportedAreas: areas.map((area) => ({
                areaId: area.areaId,
                mapId: area.mapId,
                areaInfo: {
                    locationInfo: {
                        locationName: this.getMatterLocationDisplayName(area, includeMapNamesInAreaLabels),
                        floorNumber: null,
                        areaType: null,
                    },
                    landmarkInfo: null,
                },
            })),
            selectedAreas,
            currentArea: (_a = this.serviceAreaCurrentArea) !== null && _a !== void 0 ? _a : this.getCurrentServiceArea(selectedAreas),
        };
        if (supportedMaps.length > 0) {
            state.supportedMaps = supportedMaps;
        }
        return state;
    }
    getCurrentServiceArea(selectedAreas) {
        if (selectedAreas.length !== 1 || !this.roomCleaningAreaConfirmed) {
            return null;
        }
        const state = this.getNumberStatus("state");
        return state === ROOM_CLEAN_STATE || state === PAUSED_STATE
            ? selectedAreas[0]
            : null;
    }
    async selectServiceAreas(newAreas) {
        const supportedAreas = new Map(this.getMatterServiceAreas().map((area) => [area.areaId, area]));
        const selectedAreas = this.normalizeMatterAreaIds(newAreas);
        const unsupportedArea = selectedAreas.find((areaId) => !supportedAreas.has(areaId));
        this.platform.log.info(`Matter service area selection request for ${this.getVacuumName()}: ${selectedAreas.join(", ") || "none"}.`);
        if (unsupportedArea !== undefined) {
            return {
                status: SERVICE_AREA_SELECT_STATUS.UNSUPPORTED_AREA,
                statusText: `Area ${unsupportedArea} is not available from the Roborock room map.`,
            };
        }
        const selectedMapIds = this.getSelectedServiceAreaMapIds(selectedAreas
            .map((areaId) => supportedAreas.get(areaId))
            .filter((area) => area !== undefined));
        if (selectedMapIds.length > 1) {
            this.platform.log.warn(`Ignoring Matter service area selection spanning multiple Roborock maps for ${this.getVacuumName()}; select areas from one map at a time.`);
            return {
                status: SERVICE_AREA_SELECT_STATUS.INVALID_SET,
                statusText: "Select service areas from only one Roborock map at a time.",
            };
        }
        this.selectedServiceAreaIds = selectedAreas;
        if (selectedAreas.length > 0) {
            const areaNames = selectedAreas
                .map((areaId) => supportedAreas.get(areaId))
                .filter((area) => area !== undefined)
                .map((area) => this.formatServiceAreaName(area));
            this.platform.log.info(`Selected Matter service area(s) for ${this.getVacuumName()}: ${areaNames.join(", ")}.`);
        }
        else {
            this.platform.log.info(`Cleared Matter service area selection for ${this.getVacuumName()}.`);
        }
        // Defer the publish so the selectAreas handler returns promptly; the
        // snapshot is rebuilt at execution time from the stored selection.
        const publishTimer = (0, timers_1.scheduleTimer)(() => {
            void this.updateMatterState(this.buildClusters(), "service area selection").catch((error) => {
                this.platform.log.warn(`Unable to update Matter service area selection for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, 0);
        (0, timers_1.unrefTimer)(publishTimer);
        return {
            status: SERVICE_AREA_SELECT_STATUS.SUCCESS,
            statusText: "",
        };
    }
    getMatterServiceAreas() {
        var _a;
        const getRoomMappingsForDevice = this.api.getRoomMappingsForDevice;
        if (typeof getRoomMappingsForDevice !== "function") {
            return [];
        }
        const rooms = getRoomMappingsForDevice.call(this.api, this.getDuid());
        if (!Array.isArray(rooms)) {
            return [];
        }
        const areas = [];
        const mapsById = new Map(this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map]));
        const seenAreaIds = new Set();
        for (const room of rooms) {
            const roomRecord = this.asRecord(room);
            const segmentId = this.getNumberFromValue(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.segmentId);
            const mapId = this.getMatterMapId(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.mapId);
            const areaId = segmentId === null
                ? null
                : this.getMatterAreaId(segmentId, mapId, seenAreaIds);
            if (areaId === null ||
                segmentId === null ||
                !Number.isInteger(segmentId) ||
                segmentId < 0 ||
                seenAreaIds.has(areaId)) {
                continue;
            }
            seenAreaIds.add(areaId);
            areas.push({
                areaId,
                segmentId,
                mapId,
                mapName: mapId === null ? null : ((_a = mapsById.get(mapId)) === null || _a === void 0 ? void 0 : _a.name) || null,
                name: this.toMatterLocationName(roomRecord === null || roomRecord === void 0 ? void 0 : roomRecord.name, segmentId),
            });
        }
        return areas;
    }
    getMatterServiceAreaMaps(areas) {
        var _a;
        // Matter controllers can hang if supportedMaps advertises maps with no
        // matching supportedAreas, or if supportedAreas reference a mapId that has
        // no supportedMaps entry. Build supportedMaps from exactly the maps that
        // have areas, preferring Roborock-reported map names and falling back to
        // the area's map name or a generated label.
        const roborockMapsById = new Map(this.getMatterServiceAreaMapsFromRoborock().map((map) => [map.mapId, map]));
        const maps = [];
        const seenMapIds = new Set();
        for (const area of areas) {
            if (area.mapId === null || seenMapIds.has(area.mapId)) {
                continue;
            }
            seenMapIds.add(area.mapId);
            maps.push({
                mapId: area.mapId,
                name: ((_a = roborockMapsById.get(area.mapId)) === null || _a === void 0 ? void 0 : _a.name) ||
                    area.mapName ||
                    `Roborock Map ${area.mapId}`,
            });
        }
        return maps;
    }
    getMatterServiceAreaMapsFromRoborock() {
        const getMapListForDevice = this.api.getMapListForDevice;
        if (typeof getMapListForDevice !== "function") {
            return [];
        }
        const maps = getMapListForDevice.call(this.api, this.getDuid());
        if (!Array.isArray(maps)) {
            return [];
        }
        const supportedMaps = [];
        const seenMapIds = new Set();
        for (const map of maps) {
            const mapRecord = this.asRecord(map);
            const mapId = this.getMatterMapId(mapRecord === null || mapRecord === void 0 ? void 0 : mapRecord.mapId);
            if (mapId === null || seenMapIds.has(mapId)) {
                continue;
            }
            seenMapIds.add(mapId);
            supportedMaps.push({
                mapId,
                name: this.toMatterMapName(mapRecord === null || mapRecord === void 0 ? void 0 : mapRecord.name, mapId),
            });
        }
        return supportedMaps;
    }
    getMatterAreaId(segmentId, mapId, usedAreaIds) {
        let areaId = mapId === null
            ? segmentId
            : mapId * MATTER_AREA_ID_MAP_MULTIPLIER + segmentId;
        if (!Number.isSafeInteger(areaId) || areaId > MATTER_AREA_ID_MAX) {
            areaId = this.getHashedMatterAreaId(mapId, segmentId);
        }
        while (usedAreaIds.has(areaId)) {
            areaId = areaId >= MATTER_AREA_ID_MAX ? 0 : areaId + 1;
        }
        return areaId;
    }
    getHashedMatterAreaId(mapId, segmentId) {
        const source = `${mapId !== null && mapId !== void 0 ? mapId : "none"}:${segmentId}`;
        let hash = 2166136261;
        for (let i = 0; i < source.length; i++) {
            hash ^= source.charCodeAt(i);
            hash = Math.imul(hash, 16777619) >>> 0;
        }
        return hash;
    }
    getMatterMapId(value) {
        const mapId = this.getNumberFromValue(value);
        return mapId !== null && Number.isInteger(mapId) && mapId >= 0
            ? mapId
            : null;
    }
    logMatterServiceAreaSummary(areas, maps) {
        const summary = [
            this.getDuid(),
            areas
                .map((area) => { var _a; return `${area.areaId}:${(_a = area.mapId) !== null && _a !== void 0 ? _a : "none"}:${area.name}`; })
                .join("|"),
            maps.map((map) => `${map.mapId}:${map.name}`).join("|"),
        ].join(";");
        if (summary === this.lastServiceAreaSummary) {
            return;
        }
        this.lastServiceAreaSummary = summary;
        if (areas.length === 0) {
            this.platform.log.info(`Matter Service Area is enabled for ${this.getVacuumName()}, but no Roborock rooms are available to expose yet.`);
            return;
        }
        this.platform.log.info(`Matter Service Area for ${this.getVacuumName()}: exposing ${areas.length} room(s)` +
            `${maps.length > 0 ? ` on ${maps.length} map(s)` : ""}: ${areas
                .map((area) => this.getMatterLocationDisplayName(area, maps.length > 1))
                .join(", ")}.`);
    }
    getSelectedServiceAreaSegments() {
        if (!this.isServiceAreaEnabled()) {
            return [];
        }
        const areasById = new Map(this.getMatterServiceAreas().map((area) => [area.areaId, area]));
        return this.selectedServiceAreaIds
            .map((areaId) => areasById.get(areaId))
            .filter((area) => area !== undefined);
    }
    normalizeMatterAreaIds(newAreas) {
        if (!Array.isArray(newAreas)) {
            return [];
        }
        const selectedAreas = [];
        const seenAreaIds = new Set();
        for (const area of newAreas) {
            const areaId = this.getNumberFromValue(area);
            if (areaId === null ||
                !Number.isInteger(areaId) ||
                areaId < 0 ||
                seenAreaIds.has(areaId)) {
                continue;
            }
            seenAreaIds.add(areaId);
            selectedAreas.push(areaId);
        }
        return selectedAreas;
    }
    clampMatterName(name, maxLength, fallback) {
        const normalizedName = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
        const value = normalizedName || fallback;
        return value.length > maxLength
            ? value.slice(0, maxLength).trim() || fallback
            : value;
    }
    toMatterLocationName(name, areaId) {
        return this.clampMatterName(name, MATTER_LOCATION_NAME_MAX_LENGTH, `Room ${areaId}`);
    }
    toMatterMapName(name, mapId) {
        return this.clampMatterName(name, MATTER_MAP_NAME_MAX_LENGTH, `Roborock Map ${mapId}`);
    }
    formatServiceAreaName(area) {
        return area.mapName ? `${area.name} (${area.mapName})` : area.name;
    }
    getMatterLocationDisplayName(area, includeMapName) {
        if (!includeMapName || !area.mapName) {
            return area.name;
        }
        const fallbackName = this.clampMatterName(`${area.mapName} - Room ${area.segmentId}`, MATTER_LOCATION_NAME_MAX_LENGTH, area.name);
        return this.clampMatterName(`${area.mapName} - ${area.name}`, MATTER_LOCATION_NAME_MAX_LENGTH, fallbackName);
    }
    getSelectedServiceAreaMapIds(selectedAreas) {
        const selectedMapIds = new Set();
        for (const area of selectedAreas) {
            if (area.mapId !== null) {
                selectedMapIds.add(area.mapId);
            }
        }
        return Array.from(selectedMapIds);
    }
    async loadMatterMapIfNeeded(duid, targetMapId) {
        if (targetMapId === null) {
            return;
        }
        const currentMapId = this.getCurrentMatterMapId();
        if (currentMapId === targetMapId) {
            return;
        }
        const loadMap = this.api.load_multi_map;
        if (typeof loadMap !== "function") {
            throw new Error(`Roborock map ${targetMapId} is not currently loaded and this plugin cannot switch maps.`);
        }
        this.platform.log.info(`Loading Roborock map ${targetMapId} for ${this.getVacuumName()} before selected-area cleaning.`);
        try {
            await loadMap.call(this.api, duid, targetMapId, this.getMatterMapLoadCommandOptions());
        }
        catch (error) {
            const currentMapIdAfterError = this.getCurrentMatterMapId();
            if (currentMapIdAfterError === targetMapId) {
                this.platform.log.warn(`Roborock map ${targetMapId} for ${this.getVacuumName()} became active even though the map-load acknowledgement failed: ${this.getErrorMessage(error)}`);
                return;
            }
            throw error;
        }
    }
    getCurrentMatterMapId() {
        const getCurrentMapIdForDevice = this.api.getCurrentMapIdForDevice;
        if (typeof getCurrentMapIdForDevice !== "function") {
            return null;
        }
        const currentMapId = getCurrentMapIdForDevice.call(this.api, this.getDuid());
        return this.getMatterMapId(currentMapId);
    }
    isServiceAreaEnabled() {
        return this.platform.platformConfig.enableMatterServiceArea !== false;
    }
    isPowerSourceEnabled() {
        return this.platform.platformConfig.enableMatterPowerSource !== false;
    }
    isCleanModeEnabled() {
        return this.platform.platformConfig.enableMatterCleanMode !== false;
    }
    isExtendedOperationalStateEnabled() {
        return (this.platform.platformConfig.enableMatterExtendedOperationalStates ===
            true);
    }
    isChargingDockedStateEnabled() {
        return (this.platform.platformConfig.enableMatterChargingDockedStates === true);
    }
    /**
     * Opt-in: report the Matter Error state when the robot has genuinely
     * halted, instead of showing Ready. Off by default because a robot in
     * Error may be refused a Start command by the controller.
     */
    isFaultReportingEnabled() {
        return this.platform.platformConfig.enableMatterFaultReporting === true;
    }
    /**
     * Battery percentage at which a docked robot switches from Charging to
     * Docked on the Matter tile. Defaults to 100 (charging until full); users
     * with worn batteries can lower it so the tile stops claiming Charging once
     * their realistic full level is reached.
     */
    getChargedBatteryThreshold() {
        const raw = this.platform.platformConfig.matterChargedBatteryThreshold;
        const value = typeof raw === "string" ? Number(raw) : raw;
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return 100;
        }
        return Math.min(100, Math.max(1, Math.round(value)));
    }
    resolveChargingDockedDisplayState(fallbackState) {
        const battery = this.getNumberStatus("battery");
        if (battery === null) {
            return fallbackState;
        }
        return battery < this.getChargedBatteryThreshold()
            ? RVC_OPERATIONAL_STATE.CHARGING
            : RVC_OPERATIONAL_STATE.DOCKED;
    }
    getOperationalStateList() {
        const baseList = this.isExtendedOperationalStateEnabled()
            ? RVC_OPERATIONAL_STATE_LIST
            : RVC_BASIC_OPERATIONAL_STATE_LIST;
        // Matter requires operationalState to be a member of operationalStateList,
        // so only advertise CHARGING/DOCKED when we may actually publish them.
        return this.isChargingDockedStateEnabled()
            ? [...baseList, ...RVC_CHARGING_DOCKED_STATE_LIST]
            : baseList;
    }
    getBatteryChargeLevel(battery) {
        if (battery !== null && battery <= 10) {
            return BATTERY_CHARGE_LEVEL.CRITICAL;
        }
        if (battery !== null && battery < 20) {
            return BATTERY_CHARGE_LEVEL.WARNING;
        }
        return BATTERY_CHARGE_LEVEL.OK;
    }
    getBatteryChargeState(battery, chargeStatus, state) {
        if (battery === null) {
            return BATTERY_CHARGE_STATE.UNKNOWN;
        }
        if (state === 100 || (battery >= 100 && chargeStatus !== 0)) {
            return BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE;
        }
        if (chargeStatus !== null) {
            return chargeStatus !== 0
                ? BATTERY_CHARGE_STATE.IS_CHARGING
                : BATTERY_CHARGE_STATE.IS_NOT_CHARGING;
        }
        if (state === 8) {
            return BATTERY_CHARGE_STATE.IS_CHARGING;
        }
        return BATTERY_CHARGE_STATE.UNKNOWN;
    }
    getBatteryTimeToFullCharge(battery, chargeState) {
        if (battery === null) {
            return null;
        }
        if (chargeState === BATTERY_CHARGE_STATE.IS_AT_FULL_CHARGE) {
            return 0;
        }
        if (chargeState !== BATTERY_CHARGE_STATE.IS_CHARGING) {
            return null;
        }
        return (Math.ceil(100 - battery) * BATTERY_ESTIMATED_CHARGE_SECONDS_PER_PERCENT);
    }
    getOperationalState(state = this.getNumberStatus("state"), chargeStatus = this.getNumberStatus("charge_status")) {
        const operationalState = this.getRoborockOperationalState(state, chargeStatus);
        const controllerState = this.toControllerOperationalState(operationalState);
        // Dock and tank conditions deliberately never raise ERROR. The 3.4.0
        // switch that let them do so was withdrawn: it made a robot that could
        // still vacuum look unstartable, and the warning it was supposed to
        // surface never appeared in Apple Home even once.
        return controllerState;
    }
    getRoborockOperationalState(state, chargeStatus) {
        switch (state) {
            case 5: // Cleaning
            case 11: // Spot Cleaning
            case 16: // Go To
            case 17: // Zone Clean
            case 18: // Room Clean
            case 4: // Remote Control
            case 7: // Manual Mode
                return RVC_OPERATIONAL_STATE.RUNNING;
            case 10: // Paused
                return RVC_OPERATIONAL_STATE.PAUSED;
            case 6: // Returning Dock
            case 15: // Docking
            case 26: // Going to wash the mop
                return RVC_OPERATIONAL_STATE.SEEKING_CHARGER;
            case 8: // Charging
                return RVC_OPERATIONAL_STATE.CHARGING;
            case 9: // Charging Error
            case 12: // In Error
                return RVC_OPERATIONAL_STATE.ERROR;
            case 22: // Emptying dust container
                return RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN;
            case 23: // Washing the mop
                return RVC_OPERATIONAL_STATE.CLEANING_MOP;
            case 29: // Mapping
                return RVC_OPERATIONAL_STATE.UPDATING_MAPS;
            case 100: // Fully Charged
                return RVC_OPERATIONAL_STATE.DOCKED;
            default:
                if (chargeStatus !== null && chargeStatus !== 0) {
                    return RVC_OPERATIONAL_STATE.CHARGING;
                }
                return RVC_OPERATIONAL_STATE.STOPPED;
        }
    }
    toControllerOperationalState(operationalState) {
        // With Extended Operational States on, report the dock activities as
        // themselves. Only SEEKING_CHARGER used to survive this gate; EMPTYING_
        // DUST_BIN, CLEANING_MOP and UPDATING_MAPS fell through to the switch
        // below and were rewritten to RUNNING no matter what the user had
        // enabled — so the toggle silently delivered one of the four states it
        // promised, and "emptying" and "washing the mop" never reached Apple Home
        // in any released version (issue #5).
        if (this.isExtendedOperationalStateEnabled() &&
            EXTENDED_OPERATIONAL_STATES.has(operationalState)) {
            return operationalState;
        }
        if (this.isChargingDockedStateEnabled() &&
            (operationalState === RVC_OPERATIONAL_STATE.CHARGING ||
                operationalState === RVC_OPERATIONAL_STATE.DOCKED)) {
            // Opt-in: report real charging/docked states so Apple Home shows
            // "Charging"/"Docked" on the tile instead of "Ready". The battery
            // percentage is the discriminator between the two: worn batteries can
            // make the robot claim "fully charged" (or drop the charging flag)
            // early, so trust the percentage against the configured threshold and
            // only fall back to the state-based value when no battery reading is
            // available.
            return this.resolveChargingDockedDisplayState(operationalState);
        }
        switch (operationalState) {
            case RVC_OPERATIONAL_STATE.ERROR:
                // ERROR (3) is a member of even the basic advertised list, so
                // publishing it was always legal — it was downgraded to STOPPED
                // alongside the states that genuinely needed a gate, which is why a
                // robot stuck under the sofa has always read as "Ready" in Apple
                // Home. Report it for real once the user has opted in.
                //
                // Only Roborock states 9 (Charging Error) and 12 (In Error) reach
                // here, i.e. the robot's own claim that it has halted. Dock
                // consumables arrive through `dock_error_status` instead and never
                // touch the state, so a full waste-water tank does not make a robot
                // that can still vacuum look unstartable in Apple Home.
                return this.isFaultReportingEnabled()
                    ? RVC_OPERATIONAL_STATE.ERROR
                    : RVC_OPERATIONAL_STATE.STOPPED;
            case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
                return RVC_OPERATIONAL_STATE.STOPPED;
            case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
            case RVC_OPERATIONAL_STATE.CLEANING_MOP:
            case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
                return RVC_OPERATIONAL_STATE.RUNNING;
            case RVC_OPERATIONAL_STATE.CHARGING:
            case RVC_OPERATIONAL_STATE.DOCKED:
                return RVC_OPERATIONAL_STATE.STOPPED;
            default:
                return operationalState;
        }
    }
    isInCleaningRunMode(operationalState) {
        switch (operationalState) {
            case RVC_OPERATIONAL_STATE.RUNNING:
            case RVC_OPERATIONAL_STATE.PAUSED:
            case RVC_OPERATIONAL_STATE.SEEKING_CHARGER:
            case RVC_OPERATIONAL_STATE.EMPTYING_DUST_BIN:
            case RVC_OPERATIONAL_STATE.CLEANING_MOP:
            case RVC_OPERATIONAL_STATE.UPDATING_MAPS:
                return true;
            default:
                return false;
        }
    }
    rememberLiveStatus(property, value) {
        if (value !== null) {
            this.liveStatus.set(property, value);
            this.liveStatusUpdatedAt = Date.now();
        }
    }
    rememberHomeDataStatus(data) {
        const message = this.asRecord(data);
        const value = message === null || message === void 0 ? void 0 : message.val;
        if (typeof value !== "string") {
            return;
        }
        let homeData;
        try {
            homeData = JSON.parse(value);
        }
        catch (_a) {
            return;
        }
        const home = this.asRecord(homeData);
        const devices = Array.isArray(home === null || home === void 0 ? void 0 : home.devices) ? home.devices : [];
        const device = devices
            .map((entry) => this.asRecord(entry))
            .find((entry) => (entry === null || entry === void 0 ? void 0 : entry.duid) === this.getDuid());
        const deviceStatus = this.asRecord(device === null || device === void 0 ? void 0 : device.deviceStatus);
        if (!deviceStatus) {
            return;
        }
        this.rememberLiveStatus("state", this.getNumberFromValue(deviceStatus.state));
        this.rememberLiveStatus("battery", this.getNumberFromValue(deviceStatus.battery));
        this.rememberLiveStatus("charge_status", this.getNumberFromValue(deviceStatus.charge_status));
    }
    getNumberStatus(property) {
        // Prefer the freshest value from a live message, falling back to the
        // HomeData snapshot for properties live messages do not carry.
        // A stale live cache must not shadow the periodically refreshed cloud
        // snapshot forever (dead poller, connectivity loss): live values older
        // than the staleness window fall back to HomeData, which self-heals.
        const liveValue = this.liveStatus.get(property);
        if (liveValue !== undefined &&
            Date.now() - this.liveStatusUpdatedAt < LIVE_STATUS_STALENESS_MS) {
            return liveValue;
        }
        const value = this.api.getVacuumDeviceStatus(this.getDuid(), property);
        return this.getNumberFromValue(value);
    }
    getNumberFromValue(value) {
        if (typeof value === "number" && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === "string" && value.trim() !== "") {
            const parsed = Number(value);
            return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
    }
    extractStatusUpdate(data) {
        const rootMessage = this.asRecord(data);
        const dps = this.asRecord(rootMessage === null || rootMessage === void 0 ? void 0 : rootMessage.dps);
        if (dps) {
            const status = {};
            if (Object.prototype.hasOwnProperty.call(dps, "121")) {
                status.state = dps["121"];
            }
            if (Object.prototype.hasOwnProperty.call(dps, "122")) {
                status.battery = dps["122"];
            }
            // 123 is FAN POWER, not charge status. The Roborock v1 dps numbering is
            // 120 error_code, 121 state, 122 battery, 123 fan_power,
            // 124 water_box_mode, 125/126/127 main-brush/side-brush/filter life,
            // 133 charge_status — and this file's own consumables table uses
            // 125/126/127 for exactly those lives, which corroborates it.
            //
            // Reading 123 as charge_status meant that changing suction mid-clean
            // (from the Roborock app, a schedule, or SmartPlan) pushed a frame whose
            // only field was 123. That produced {charge_status: 102} with state
            // null, which falls through to the charging branch — so an actively
            // cleaning robot flipped to "Charging" in Apple Home.
            if (Object.prototype.hasOwnProperty.call(dps, "123")) {
                status.fan_power = dps["123"];
            }
            if (Object.prototype.hasOwnProperty.call(dps, "124")) {
                status.water_box_mode = dps["124"];
            }
            if (Object.prototype.hasOwnProperty.call(dps, "133")) {
                status.charge_status = dps["133"];
            }
            return Object.keys(status).length > 0 ? status : null;
        }
        const payload = Array.isArray(data) ? data : data ? [data] : [];
        const message = this.asRecord(payload[0]);
        if (!message) {
            return null;
        }
        // Every field the publish reads counts here, including `fan_power` and
        // `matter_clean_type`. This gate used to name five of the seven, so a frame
        // whose only field was one of the missing two was discarded here even
        // though the caller explicitly treats it as a meaningful update.
        const hasStatus = MEANINGFUL_LIVE_STATUS_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(message, field));
        return hasStatus ? message : null;
    }
    getLiveMessageForThisAccessory(data) {
        return (0, live_message_1.getLiveMessageForThisAccessory)(data, {
            getDuid: () => this.getDuid(),
            getVacuumName: () => this.getVacuumName(),
            shouldAcceptUnscopedLiveMessage: () => this.platform.shouldAcceptUnscopedLiveMessage(),
            logDebug: (message) => this.platform.log.debug(message),
        });
    }
    asRecord(value) {
        return value !== null && typeof value === "object"
            ? value
            : null;
    }
    setOptimisticState(partialClusters, action) {
        this.optimisticClusters = this.mergeClusterState(this.getActiveOptimisticState() || {}, partialClusters);
        this.optimisticExpiresAt = Date.now() + OPTIMISTIC_STATE_TTL_MS;
        this.optimisticGeneration += 1;
        this.optimisticAction = action;
        this.contradictingLiveStateCount = 0;
        return this.optimisticGeneration;
    }
    reconcileOptimisticStateWithLive(operationalState, roborockState, chargeStatus) {
        var _a;
        const optimistic = this.getActiveOptimisticState();
        const expected = (_a = optimistic === null || optimistic === void 0 ? void 0 : optimistic.rvcOperationalState) === null || _a === void 0 ? void 0 : _a.operationalState;
        if (typeof expected !== "number") {
            this.contradictingLiveStateCount = 0;
            return;
        }
        if (this.doesLiveStateConfirmOptimisticState(expected, operationalState, roborockState, chargeStatus)) {
            this.clearOptimisticState();
            return;
        }
        // While a start/resume/area-clean is still spinning up, cloud-only models
        // (e.g. S8 / roborock.vacuum.a51) keep reporting docked/charging for tens of
        // seconds before they report Cleaning. During the recent-command window,
        // treat those lagging reports as transitional rather than contradictions, so
        // the optimistic Cleaning state is not starved and Apple Home does not snap
        // the tile back to Docked right after Start (issue #4).
        if (expected === RVC_OPERATIONAL_STATE.RUNNING &&
            this.isRoborockDockedOrCharging(roborockState, chargeStatus) &&
            this.hasRecentlyCommandedCleaning()) {
            this.contradictingLiveStateCount = 0;
            return;
        }
        // The command was acknowledged but the robot reports a different state.
        // Tolerate a couple of transitional reports, then trust the live state so
        // an optimistic value cannot stay stuck until the TTL expires (e.g. a start
        // the robot ignored because the bin is full or it is off the dock).
        this.contradictingLiveStateCount += 1;
        if (this.contradictingLiveStateCount >= OPTIMISTIC_CONTRADICTION_LIMIT) {
            this.platform.log.debug(`Clearing optimistic Matter state for ${this.getVacuumName()} after ${this.contradictingLiveStateCount} contradicting Roborock updates (expected ${expected}, got ${operationalState}).`);
            this.clearOptimisticState();
        }
    }
    doesLiveStateConfirmOptimisticState(expected, actual, roborockState, chargeStatus) {
        if (expected === actual) {
            return true;
        }
        if (this.optimisticAction === "return to dock" &&
            expected === RVC_OPERATIONAL_STATE.RUNNING &&
            !this.isInCleaningRunMode(actual) &&
            this.isRoborockDockedOrCharging(roborockState, chargeStatus)) {
            return true;
        }
        if (expected === RVC_OPERATIONAL_STATE.RUNNING &&
            this.isInCleaningRunMode(actual)) {
            return true;
        }
        if (expected === RVC_OPERATIONAL_STATE.STOPPED &&
            !this.isInCleaningRunMode(actual)) {
            return true;
        }
        return (expected === RVC_OPERATIONAL_STATE.SEEKING_CHARGER &&
            (actual === RVC_OPERATIONAL_STATE.CHARGING ||
                actual === RVC_OPERATIONAL_STATE.DOCKED));
    }
    isRoborockDockedOrCharging(roborockState, chargeStatus) {
        return roborockState === 8 || roborockState === 100 || !!chargeStatus;
    }
    isDockedOrChargingNow() {
        return this.isRoborockDockedOrCharging(this.getNumberStatus("state"), this.getNumberStatus("charge_status"));
    }
    async publishCurrentMatterState(reason, options = {}) {
        if (options.clearOptimistic === true) {
            this.clearOptimisticState();
        }
        // Forced: identify commands and the heartbeat must always reach the
        // Matter layer — the heartbeat's forced full write is also the diff
        // mechanism's self-healing safety net.
        const updated = await this.publishRoborockSnapshot(this.buildClusters(), reason, { force: true });
        if (updated) {
            this.ensureMatterStateHeartbeat();
        }
    }
    ensureMatterStateHeartbeat() {
        if (!this.registered || this.matterStateHeartbeatTimer) {
            return;
        }
        const heartbeatTimer = (0, timers_1.scheduleTimer)(() => {
            this.matterStateHeartbeatTimer = null;
            void this.publishCurrentMatterState("Matter state heartbeat")
                .catch((error) => {
                this.platform.log.debug(`Unable to publish Matter state heartbeat for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            })
                .finally(() => {
                // Re-arm even after a failed or suppressed publish. Previously the
                // heartbeat chain only continued after a successful publish, so one
                // transient Matter error silently disabled the safety net until the
                // next live Roborock message happened to arrive.
                if (this.registered) {
                    this.ensureMatterStateHeartbeat();
                }
            });
        }, MATTER_STATE_HEARTBEAT_INTERVAL_MS);
        this.matterStateHeartbeatTimer = heartbeatTimer;
        (0, timers_1.unrefTimer)(heartbeatTimer);
    }
    applyOptimisticState(clusters) {
        const optimistic = this.getActiveOptimisticState();
        return optimistic ? this.mergeClusterState(clusters, optimistic) : clusters;
    }
    getActiveOptimisticState() {
        if (!this.optimisticClusters) {
            return null;
        }
        if (Date.now() > this.optimisticExpiresAt) {
            this.clearOptimisticState();
            return null;
        }
        return this.optimisticClusters;
    }
    clearOptimisticState() {
        this.optimisticClusters = null;
        this.optimisticExpiresAt = 0;
        this.optimisticAction = null;
        this.optimisticGeneration += 1;
        this.contradictingLiveStateCount = 0;
    }
    dispatchRoborockMatterCommand(action, command, options = {}) {
        var _a;
        const startedAt = Date.now();
        const surface = (_a = options.surface) !== null && _a !== void 0 ? _a : exports.MATTER_SURFACE;
        void command()
            .then(() => {
            this.logMatterCommandDuration(action, startedAt, surface);
            this.schedulePostCommandStatusRefresh(action);
        })
            .catch(async (error) => {
            if (this.isDeviceNotReadyError(error)) {
                // The command raced a plugin restart: Roborock login/device setup
                // has not finished yet. Log calmly, roll the optimistic state back,
                // and let the user retry once startup completes instead of showing
                // a scary error with a misleading stack.
                this.platform.log.warn(`${surface} ${action} command for ${this.getVacuumName()} arrived before the Roborock connection finished starting up. Try again in a few seconds. ${this.getErrorMessage(error)}`);
                await this.recoverMatterStateAfterFailedCommand(action);
                return;
            }
            if (this.isMatterCommandTimeoutError(error)) {
                this.platform.log.warn(`${surface} ${action} command for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`);
                this.schedulePostCommandStatusRefresh(action, {
                    acknowledgementTimedOut: true,
                });
                if (options.retryReturnToDockIfStillActive) {
                    this.scheduleReturnToDockRetry(command, surface);
                }
                return;
            }
            this.platform.log.error(`Error sending ${surface} ${action} command to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            await this.recoverMatterStateAfterFailedCommand(action);
        });
    }
    scheduleReturnToDockRetry(command, surface = exports.MATTER_SURFACE) {
        if (this.returnToDockRetryPending) {
            return;
        }
        this.returnToDockRetryPending = true;
        const retryTimer = (0, timers_1.scheduleTimer)(() => {
            this.returnToDockRetryPending = false;
            void this.refreshMatterStatusBeforeRetry()
                .then(() => {
                if (!this.shouldRetryReturnToDock()) {
                    this.platform.log.debug(`Skipping ${surface} return to dock retry for ${this.getVacuumName()} because Roborock no longer reports active cleaning.`);
                    return;
                }
                const startedAt = Date.now();
                this.platform.log.warn(`Retrying ${surface} return to dock command for ${this.getVacuumName()} because Roborock still reports active cleaning after the first command timed out.`);
                return command()
                    .then(() => {
                    this.logMatterCommandDuration("return to dock retry", startedAt, surface);
                    this.schedulePostCommandStatusRefresh("return to dock retry");
                })
                    .catch(async (error) => {
                    if (this.isMatterCommandTimeoutError(error)) {
                        this.platform.log.warn(`${surface} return to dock retry for ${this.getVacuumName()} was sent but Roborock did not acknowledge it before timeout: ${this.getErrorMessage(error)}. Keeping the optimistic Matter state and actively refreshing Roborock status.`);
                        this.schedulePostCommandStatusRefresh("return to dock retry", {
                            acknowledgementTimedOut: true,
                        });
                        return;
                    }
                    this.platform.log.error(`Error sending ${surface} return to dock retry to ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
                    await this.recoverMatterStateAfterFailedCommand("return to dock retry");
                });
            })
                .catch((error) => {
                this.platform.log.debug(`Unable to evaluate ${surface} return to dock retry for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
            });
        }, MATTER_RETURN_TO_DOCK_RETRY_DELAY_MS);
        (0, timers_1.unrefTimer)(retryTimer);
    }
    async refreshMatterStatusBeforeRetry() {
        const refreshStatus = this.api.getStatus;
        if (typeof refreshStatus !== "function") {
            return;
        }
        await refreshStatus.call(this.api, this.getDuid(), this.getMatterStatusRefreshOptions());
        await this.updateMatterStateFromRoborock();
    }
    shouldRetryReturnToDock() {
        const state = this.getNumberStatus("state");
        const chargeStatus = this.getNumberStatus("charge_status");
        if (this.isRoborockDockedOrCharging(state, chargeStatus)) {
            return false;
        }
        return this.isRoborockActivelyCleaningAwayFromDock(state);
    }
    isRoborockActivelyCleaningAwayFromDock(state) {
        switch (state) {
            case 4: // Remote Control
            case 5: // Cleaning
            case 7: // Manual Mode
            case 10: // Paused
            case 11: // Spot Cleaning
            case 16: // Go To
            case 17: // Zone Clean
            case 18: // Room Clean
            case 29: // Mapping
                return true;
            default:
                return false;
        }
    }
    async recoverMatterStateAfterFailedCommand(action) {
        try {
            await this.publishCurrentMatterState(`${action} command failure recovery`, { clearOptimistic: true });
        }
        catch (error) {
            this.platform.log.warn(`Unable to recover Matter state after failed ${action} command for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
        }
    }
    isMatterCommandTimeoutError(error) {
        return /timed out after \d+ seconds/.test(this.getErrorMessage(error));
    }
    isDeviceNotReadyError(error) {
        if (error !== null &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ROBOROCK_DEVICE_NOT_READY") {
            return true;
        }
        // Also match the upstream phrasing used by getServerTimers and
        // updateServerTimer ("Vacuum <duid> is not initialized.").
        return /is not initialized/i.test(this.getErrorMessage(error));
    }
    isMatterInitializingError(error) {
        return /\bis still initializing\b/i.test(this.getErrorMessage(error));
    }
    scheduleMatterInitializationRetry(reason, error) {
        if (this.matterInitializationRetryPending) {
            return;
        }
        const delayMs = MATTER_INITIALIZATION_RETRY_DELAYS_MS[this.matterInitializationRetryAttempt];
        if (delayMs === undefined) {
            this.platform.log.debug(`Matter state update after ${reason} for ${this.getVacuumName()} is still waiting on Homebridge endpoint initialization; suppressing additional startup retries. Last error: ${this.getErrorMessage(error)}`);
            return;
        }
        this.matterInitializationRetryAttempt += 1;
        this.matterInitializationRetryPending = true;
        this.platform.log.debug(`Matter state update after ${reason} for ${this.getVacuumName()} was delayed because Homebridge says the endpoint is still initializing; retrying in ${delayMs} ms.`);
        const retryTimer = (0, timers_1.scheduleTimer)(() => {
            this.matterInitializationRetryPending = false;
            this.scheduleMatterStateRefresh(`endpoint initialization retry (${reason})`);
        }, delayMs);
        (0, timers_1.unrefTimer)(retryTimer);
    }
    logMatterCommandDuration(action, startedAt, surface = exports.MATTER_SURFACE) {
        const durationMs = Date.now() - startedAt;
        const transport = this.getTransportDescription();
        const message = `${surface} ${action} command for ${this.getVacuumName()} was acknowledged ` +
            `by Roborock in ${durationMs} ms${transport ? ` via ${transport}` : ""}.`;
        if (durationMs >= SLOW_MATTER_COMMAND_MS) {
            this.platform.log.warn(`Slow ${message}`);
            return;
        }
        this.platform.log.info(message);
    }
    schedulePostCommandStatusRefresh(action, options = {}) {
        const refreshStatus = this.api.getStatus;
        if (!this.registered || typeof refreshStatus !== "function") {
            return;
        }
        const refreshDelays = options.acknowledgementTimedOut
            ? MATTER_AMBIGUOUS_COMMAND_STATUS_REFRESH_DELAYS_MS
            : action === "return to dock"
                ? MATTER_RETURN_TO_DOCK_STATUS_REFRESH_DELAYS_MS
                : MATTER_COMMAND_STATUS_REFRESH_DELAYS_MS;
        for (const delayMs of refreshDelays) {
            const refreshTimer = (0, timers_1.scheduleTimer)(() => {
                void refreshStatus
                    .call(this.api, this.getDuid(), this.getMatterStatusRefreshOptions())
                    .then(() => this.updateMatterStateFromRoborock())
                    .catch((error) => {
                    this.platform.log.debug(`Unable to refresh Matter status after ${action} for ${this.getVacuumName()}: ${this.getErrorMessage(error)}`);
                });
            }, delayMs);
            (0, timers_1.unrefTimer)(refreshTimer);
        }
    }
    getMatterStatusRefreshOptions() {
        const options = { force: true };
        if (this.platform.platformConfig.preferCloudForMatterCommands) {
            options.preferCloud = true;
        }
        return options;
    }
    getTransportDescription() {
        const diagnostics = typeof this.api.getTransportDiagnostics === "function"
            ? this.api.getTransportDiagnostics()
            : null;
        const transport = diagnostics && typeof diagnostics === "object"
            ? diagnostics[this.getDuid()]
            : null;
        if (!transport || typeof transport !== "object") {
            return "";
        }
        const lastTransport = "lastTransport" in transport ? String(transport.lastTransport) : "";
        const lastReason = "lastTransportReason" in transport
            ? String(transport.lastTransportReason)
            : "";
        if (lastTransport && lastReason) {
            return `${lastTransport} (${lastReason})`;
        }
        return lastTransport;
    }
    getErrorMessage(error) {
        if (error === undefined || error === null) {
            return "unknown error";
        }
        return error instanceof Error ? error.message : String(error);
    }
    mergeClusterState(base, override) {
        const merged = { ...base };
        for (const [cluster, attributes] of Object.entries(override)) {
            merged[cluster] = {
                ...(merged[cluster] || {}),
                ...attributes,
            };
        }
        return merged;
    }
    getVacuumName() {
        return (this.api.getVacuumDeviceInfo(this.getDuid(), "name") ||
            this.accessory.displayName ||
            "Roborock vacuum");
    }
    getDuid() {
        return String(this.accessory.context.duid);
    }
}
exports.default = RoborockMatterVacuumAccessory;
//# sourceMappingURL=matter_vacuum_accessory.js.map