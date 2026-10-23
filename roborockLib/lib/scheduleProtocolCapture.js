"use strict";

// An opt-in observer of this plugin's connections. It cannot see commands
// exchanged privately between the Roborock app/cloud and a robot. The only
// requests it adds are bounded reads; it never changes or runs a schedule.
const fs = require("node:fs");
const path = require("node:path");
const { createHmac, randomBytes } = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");

const CAPTURE_DIRECTORY = "roborock-schedule-captures";
const FORMAT_VERSION = 2;
const MAX_BYTES = 2 * 1024 * 1024;
const DURATION_MS = 30 * 60 * 1000;
const INTERVAL_MS = 60 * 1000;
const FILE_NAME = /^schedule-\d{13}-[a-f0-9]{16}\.jsonl$/;
const RPC_METHODS = new Set([
  "get_timer",
  "set_timer",
  "upd_timer",
  "del_timer",
  "get_server_timer",
  "set_server_timer",
  "upd_server_timer",
  "del_server_timer",
  "get_timezone",
  "get_status",
  "get_clean_summary",
  "get_clean_record",
  "server_scheduled_start",
  "app_start",
  "app_segment_clean",
  "app_pause",
  "app_charge",
]);
const SECRET =
  /password|token|secret|local.?key|authorization|cookie|rriot|client.?id|serial|^sn$|mac|ssid|bssid|email|url|host|^ip$/i;
const IDENTITY =
  /^(?:id|name|duid|deviceId|robotId|homeId|sceneId|jobId|timerId)$/i;
const NEXT_FIRE_TIME_STRING =
  /^(?:\d{10}|\d{13}|\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)$/;
const SEGMENT_LIST_STRING =
  /^[ \t]*\d{1,4}(?:[ \t]*,[ \t]*\d{1,4}){0,499}[ \t]*$/;
const SAFE_WORDS = new Set([
  "on",
  "off",
  "ok",
  "true",
  "false",
  "NORMAL",
  "TIMER",
  "WORKFLOW",
  "UTC",
  "GMT",
  "once",
  "daily",
]);

function createSanitizer() {
  const salt = randomBytes(32);
  const ref = (value) =>
    "ref-" +
    createHmac("sha256", salt).update(String(value)).digest("hex").slice(0, 16);
  const identity = (value) => ({ ref: ref(value), type: typeof value });
  function walk(value, key = "", depth = 0) {
    if (SECRET.test(key)) return "<redacted>";
    if (depth > 25) return "<depth limit>";
    if (value === null || value === undefined) return value ?? null;
    if (IDENTITY.test(key) && ["string", "number"].includes(typeof value))
      return identity(value);
    if (Array.isArray(value)) {
      // Both timer lists and upd_timer payloads use [timerId, on/off, ...].
      const timer = value.length > 1 && ["on", "off"].includes(value[1]);
      const result = value
        .slice(0, 500)
        .map((entry, index) =>
          timer && index === 0 ? identity(entry) : walk(entry, "", depth + 1)
        );
      if (value.length > 500)
        result.push({ omittedEntries: value.length - 500 });
      return result;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value);
      const result = Object.fromEntries(
        entries.slice(0, 200).map(([field, entry]) => [
          // Do not let a dynamic key expose a token, address or user label.
          /^[a-zA-Z_][a-zA-Z_0-9]{0,63}$/.test(field) ? field : ref(field),
          walk(entry, field, depth + 1),
        ])
      );
      if (entries.length > 200) result.omittedKeys = entries.length - 200;
      return result;
    }
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "boolean") return value;
    if (typeof value !== "string") return "<unsupported value>";
    if (value.length > 128 * 1024) return "<string size limit>";
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return { jsonString: walk(JSON.parse(trimmed), "", depth + 1) };
      } catch {
        return "<unparseable JSON string>";
      }
    }
    // Retain protocol text only in its expected field. Keep the original
    // representation so delay comparisons preserve timezone offsets, string
    // types, room order, and spacing; unknown text still becomes an alias.
    if (
      (key === "nextFireTime" && NEXT_FIRE_TIME_STRING.test(value)) ||
      (key === "segments" && (value === "" || SEGMENT_LIST_STRING.test(value)))
    )
      return value;
    if (
      SAFE_WORDS.has(value) ||
      (key === "method" && /^[a-z_][a-z_0-9]{0,79}$/.test(value)) ||
      /^[\d*/?,\-]+(?:\s+[\d*/?,\-]+){4,6}$/.test(value) ||
      /^(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific|Etc)\/[A-Za-z_+\-/0-9]+$/.test(
        value
      ) ||
      /^roborock\.vacuum\.[a-z0-9]+$/.test(value) ||
      /^\d{1,4}$/.test(value)
    )
      return value;
    return identity(value);
  }
  return {
    clean(value) {
      try {
        return walk(value);
      } catch {
        return "<unavailable>";
      }
    },
    ref,
    identity,
  };
}

function describeRoute(config, ref) {
  let pathname;
  try {
    pathname = new URL(config.url, config.baseURL || "https://unused.invalid")
      .pathname;
  } catch {
    return null;
  }
  const jobs = pathname.match(
    /\/user\/devices\/([^/]+)\/jobs(?:\/([^/]+))?\/?$/
  );
  if (jobs)
    return {
      route: jobs[2]
        ? "/user/devices/{robot}/jobs/{job}"
        : "/user/devices/{robot}/jobs",
      robot: ref(decodeURIComponent(jobs[1])),
      ...(jobs[2] ? { job: ref(decodeURIComponent(jobs[2])) } : {}),
    };
  const deviceScenes = pathname.match(/\/user\/scene\/device\/([^/]+)\/?$/);
  if (deviceScenes)
    return {
      route: "/user/scene/device/{robot}",
      robot: ref(decodeURIComponent(deviceScenes[1])),
    };
  const scene = pathname.match(
    /\/user\/scene(?:\/([^/]+)(?:\/(param|enable|disable|execute))?)?\/?$/
  );
  if (!scene) return null;
  return {
    route:
      "/user/scene" +
      (scene[1] ? "/{scene}" : "") +
      (scene[2] ? "/" + scene[2] : ""),
    ...(scene[1] ? { scene: ref(decodeURIComponent(scene[1])) } : {}),
  };
}

function describeError(error) {
  return {
    status: Number(error?.response?.status) || null,
    code: typeof error?.code === "number" ? error.code : null,
    // Robot refusal codes often survive only in Error.message. Keep the code,
    // never the message (which can contain identifiers, URLs or credentials).
    robotCode: String(error?.message || "").match(/-\d{4,6}\b/)?.[0] || null,
    unanswered: error?.unansweredRequest === true,
  };
}

class ScheduleProtocolCapture {
  constructor(adapter, options = {}) {
    this.adapter = adapter;
    this.sanitize = createSanitizer();
    this.trace = new AsyncLocalStorage();
    this.bytes = 0;
    this.sequence = 0;
    this.requestId = 0;
    this.startedAt = Date.now();
    this.deadline = this.startedAt + (options.durationMs ?? DURATION_MS);
    this.maxBytes = options.maxBytes ?? MAX_BYTES;
    this.active = false;
    this.restorers = [];
    this.failures = new Map();
    this.snapshotRunning = false;
    try {
      const directory = path.join(
        adapter.config.storagePath,
        CAPTURE_DIRECTORY
      );
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      // Keep at most three previous captures. Never touch unrelated files.
      const old = fs
        .readdirSync(directory)
        .filter((name) => FILE_NAME.test(name))
        .sort();
      for (const name of old.slice(0, Math.max(0, old.length - 3)))
        fs.unlinkSync(path.join(directory, name));
      this.file = path.join(
        directory,
        `schedule-${this.startedAt}-${randomBytes(8).toString("hex")}.jsonl`
      );
      this.fd = fs.openSync(this.file, "wx", 0o600);
      this.active = true;
      this.record("capture-start", {
        formatVersion: FORMAT_VERSION,
        pluginVersion: require("../../package.json").version,
        durationMinutes: (this.deadline - this.startedAt) / 60000,
        hostTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        scope:
          "Plugin HTTP/RPC traffic and read-only snapshots; not a cloud-to-robot packet capture.",
        identities:
          "Salted aliases remain consistent only within this capture. Identity objects retain original value types.",
      });
      if (!this.active) return;
      this.attachRpc();
      this.attachHttp(adapter.api);
      this.endTimer = setTimeout(
        () => this.stop("time-limit"),
        this.deadline - Date.now()
      );
      this.endTimer.unref?.();
      if (options.snapshots !== false) this.scheduleSnapshot(5000);
      adapter.log.info(
        `Schedule capture started (format ${FORMAT_VERSION}) for ${(this.deadline - this.startedAt) / 60000} minutes: ${this.file}. Debug logging is not required.`
      );
    } catch {
      this.stop("capture-unavailable");
      adapter.log.warn(
        "Schedule capture could not be started; normal robot control continues."
      );
    }
  }

  record(event, detail) {
    if (!this.active) return;
    if (Date.now() >= this.deadline) return this.stop("time-limit");
    try {
      const line =
        JSON.stringify({
          at: new Date().toISOString(),
          sequence: ++this.sequence,
          event,
          ...detail,
        }) + "\n";
      if (this.bytes + Buffer.byteLength(line) > this.maxBytes - 1024)
        return this.stop("size-limit");
      fs.writeSync(this.fd, line);
      this.bytes += Buffer.byteLength(line);
    } catch {
      this.stop("write-failed");
    }
  }

  stop(reason = "shutdown") {
    if (!this.active && this.fd === undefined) return;
    this.active = false;
    clearTimeout(this.endTimer);
    clearTimeout(this.snapshotTimer);
    for (const restore of this.restorers.splice(0)) {
      try {
        restore();
      } catch {
        /* Observation must not break control. */
      }
    }
    if (this.fd !== undefined) {
      try {
        fs.writeSync(
          this.fd,
          JSON.stringify({
            at: new Date().toISOString(),
            sequence: ++this.sequence,
            event: "capture-end",
            reason,
          }) + "\n"
        );
      } catch {
        /* A full/unavailable disk must not break control. */
      }
      try {
        fs.closeSync(this.fd);
      } catch {
        /* Already unavailable. */
      }
      this.fd = undefined;
    }
    this.adapter.log.info(
      `Schedule capture ended (${reason}). Download it from the plugin's Advanced settings.`
    );
  }

  attachRpc() {
    const capture = this;
    const queue = this.adapter.messageQueueHandler;
    const original = queue.sendRequest;
    const wrapped = function (...args) {
      const [duid, method, params] = args;
      if (!capture.active || !RPC_METHODS.has(method))
        return original.apply(this, args);
      const callId = ++capture.requestId;
      const common = { callId, robot: capture.sanitize.ref(duid), method };
      const body =
        /^del_(?:server_)?timer$/.test(method) && Array.isArray(params)
          ? params.map((value) => capture.sanitize.identity(value))
          : capture.sanitize.clean(params);
      capture.record("rpc-request", { ...common, params: body });
      return capture.trace.run(callId, async () => {
        try {
          const result = await original.apply(this, args);
          capture.record("rpc-response", {
            ...common,
            result: capture.sanitize.clean(result),
          });
          return result;
        } catch (error) {
          capture.record("rpc-error", { ...common, ...describeError(error) });
          throw error;
        }
      });
    };
    queue.sendRequest = wrapped;
    this.restorers.push(() => {
      if (queue.sendRequest === wrapped) queue.sendRequest = original;
    });
    for (const [key, transport] of [
      ["exchangeOverLocal", "local"],
      ["exchangeOverCloud", "mqtt"],
    ]) {
      const originalExchange = queue[key];
      if (typeof originalExchange !== "function") continue;
      const exchange = function (context, ...args) {
        if (RPC_METHODS.has(context.method))
          capture.record("rpc-transport-attempt", {
            callId: capture.trace.getStore() ?? null,
            requestId: context.messageID,
            robot: capture.sanitize.ref(context.duid),
            method: context.method,
            transport,
          });
        return originalExchange.call(this, context, ...args);
      };
      queue[key] = exchange;
      this.restorers.push(() => {
        if (queue[key] === exchange) queue[key] = originalExchange;
      });
    }
  }

  attachHttp(api) {
    if (!api?.interceptors) return;
    const pending = new WeakMap();
    const request = api.interceptors.request.use((config) => {
      try {
        const route = describeRoute(config, this.sanitize.ref);
        if (this.active && route) {
          const common = {
            callId: ++this.requestId,
            verb: String(config.method || "GET").toUpperCase(),
            ...route,
          };
          pending.set(config, common);
          this.record("http-request", {
            ...common,
            body: this.httpBody(config),
          });
        }
      } catch {
        /* A diagnostic must never change request handling. */
      }
      return config;
    });
    const reply = (response, error) => {
      try {
        const common = pending.get(response?.config || error?.config);
        if (common) {
          this.record(error ? "http-error" : "http-response", {
            ...common,
            status: response?.status ?? error?.response?.status ?? null,
            body: this.sanitize.clean(response?.data ?? error?.response?.data),
            // Axios/signing can serialize data after the request observer.
            // Keep the final request representation as well, without headers.
            requestBody: this.httpBody(response?.config || error?.config),
            ...(error ? { error: describeError(error) } : {}),
          });
          if ((response?.status ?? error?.response?.status) === 429)
            this.stop("http-rate-limit");
        }
      } catch {
        /* Preserve the exact response or rejection. */
      }
    };
    const response = api.interceptors.response.use(
      (value) => {
        reply(value);
        return value;
      },
      (error) => {
        reply(error?.response, error);
        return Promise.reject(error);
      }
    );
    this.restorers.push(() => {
      api.interceptors.request.eject(request);
      api.interceptors.response.eject(response);
    });
  }

  httpBody(config) {
    if (!config) return null;
    const rawType =
      config.headers?.get?.("Content-Type") ??
      config.headers?.["Content-Type"] ??
      config.headers?.["content-type"];
    const type = String(rawType || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const contentType = [
      "application/json",
      "application/x-www-form-urlencoded",
    ].includes(type)
      ? type
      : "unspecified-or-other";
    const data =
      config.data instanceof URLSearchParams
        ? config.data.toString()
        : config.data;
    if (
      contentType === "application/x-www-form-urlencoded" &&
      typeof data === "string" &&
      data.length <= 128 * 1024
    )
      return {
        contentType,
        // A list retains repeated form fields instead of dropping duplicates.
        form: [...new URLSearchParams(data)]
          .slice(0, 200)
          .map(([key, value]) => this.sanitize.clean({ [key]: value })),
      };
    return { contentType, value: this.sanitize.clean(data) };
  }

  scheduleSnapshot(delay = INTERVAL_MS) {
    if (!this.active) return;
    this.snapshotTimer = setTimeout(async () => {
      try {
        await this.snapshot();
      } catch {
        this.record("snapshot-error", {});
      }
      this.scheduleSnapshot();
    }, delay);
    this.snapshotTimer.unref?.();
  }

  async snapshot() {
    if (!this.active || this.snapshotRunning || this.adapter.stopped) return;
    const available = () =>
      this.active &&
      !this.adapter.stopped &&
      Date.now() < this.deadline &&
      !this.adapter.config.isScheduleOperationPending?.();
    if (!available())
      return this.record("snapshot-skipped", {
        reason: "schedule-operation-pending",
      });
    this.snapshotRunning = true;
    this.record("snapshot-start", { atomic: false });
    try {
      for (const device of this.adapter.devices || []) {
        const duid = device.duid;
        if (!duid || !available()) break;
        this.record("robot", {
          robot: this.sanitize.ref(duid),
          model: this.sanitize.clean(
            this.adapter.getProductAttribute?.(duid, "model")
          ),
        });
        const reads = [
          [
            "jobs",
            () =>
              this.adapter.api.get(
                `user/devices/${encodeURIComponent(duid)}/jobs`,
                { timeout: 10000 }
              ),
          ],
          [
            "scenes",
            () =>
              this.adapter.api.get(
                `user/scene/device/${encodeURIComponent(duid)}`,
                { timeout: 10000 }
              ),
          ],
        ];
        if (!this.adapter.isB01Device?.(duid)) {
          for (const method of [
            "get_server_timer",
            "get_timer",
            "get_timezone",
            "get_status",
          ])
            reads.push([
              method,
              () =>
                this.adapter.messageQueueHandler.sendRequest(
                  duid,
                  method,
                  [],
                  false,
                  false,
                  {
                    preferCloud: true,
                    operationClass: "read",
                    requestTimeoutMs: 10000,
                    cloudGateTimeoutMs: 8000,
                  }
                ),
            ]);
        }
        for (const [name, read] of reads) {
          if (!available()) break;
          const key = duid + ":" + name;
          // Failed/unsupported reads cannot turn a diagnostic into endless
          // retries. A new capture is needed after three failed attempts.
          if ((this.failures.get(key) || 0) >= 3) continue;
          try {
            await read();
          } catch (error) {
            this.failures.set(key, (this.failures.get(key) || 0) + 1);
            this.record("snapshot-read-error", {
              robot: this.sanitize.ref(duid),
              read: name,
              ...describeError(error),
            });
            if (error?.response?.status === 429) this.stop("http-rate-limit");
          }
        }
      }
    } finally {
      this.record("snapshot-end", { atomic: false });
      this.snapshotRunning = false;
    }
  }
}

function startScheduleProtocolCapture(adapter) {
  if (adapter.config.enableScheduleProtocolCapture !== true) return null;
  return new ScheduleProtocolCapture(adapter);
}

function readLatestScheduleCapture(storagePath) {
  try {
    const directory = path.join(storagePath, CAPTURE_DIRECTORY);
    const names = fs
      .readdirSync(directory)
      .filter((name) => FILE_NAME.test(name))
      .sort()
      .reverse();
    if (!names.length)
      return {
        ok: false,
        message:
          "No schedule capture yet. Enable capture and restart the Roborock child bridge.",
      };
    const name = names[0];
    const fd = fs.openSync(
      path.join(directory, name),
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_BYTES)
        throw new Error("Invalid capture");
      const content = fs.readFileSync(fd, "utf8");
      // A download while a write is in progress omits an incomplete last line.
      return {
        ok: true,
        name,
        content: content.slice(0, content.lastIndexOf("\n") + 1),
      };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return {
      ok: false,
      message:
        "No readable schedule capture. Enable capture and restart the Roborock child bridge.",
    };
  }
}

module.exports = {
  ScheduleProtocolCapture,
  startScheduleProtocolCapture,
  readLatestScheduleCapture,
  createSanitizer,
  describeRoute,
  MAX_BYTES,
};
