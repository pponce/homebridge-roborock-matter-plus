"use strict";

class MqttSessionReplacedError extends Error {
  constructor({ generation, method, operationClass }) {
    super(
      `MQTT session generation ${generation} was replaced while ${operationClass || "request"} ${method || "(unknown method)"} was pending.`
    );
    this.name = "MqttSessionReplacedError";
    this.code = "MQTT_SESSION_REPLACED";
    this.generation = generation;
    this.method = method;
    this.operationClass = operationClass;
    this.ambiguousWrite = operationClass === "write";
  }
}

class MqttReadinessError extends Error {
  constructor(message, code = "MQTT_NOT_READY") {
    super(message);
    this.name = "MqttReadinessError";
    this.code = code;
  }
}

module.exports = { MqttSessionReplacedError, MqttReadinessError };
