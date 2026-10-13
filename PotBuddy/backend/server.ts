
import "dotenv/config";

import { randomUUID } from "node:crypto";
import {
  applicationDefault,
  getApps,
  initializeApp,
} from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getDatabase } from "firebase-admin/database";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import mqtt, { type MqttClient } from "mqtt";

type SensorReading = {
  receivedAt: number;
  deviceTimestamp?: number;
  moisturePct?: number;
  temperatureC?: number;
  reservoirAvailable?: boolean;
  reservoirLevelPct?: number;
  pots?: PotReading[];
};

type PotReading = {
  potId: string;
  moisturePct?: number;
  temperatureC?: number;
  pumpState?: "running" | "stopped";
};

type JsonObject = Record<string, unknown>;

const required = (name: string) => {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
};


const apiPort = Number(
  process.env["PORT"] ??
  process.env["API_PORT"] ??
  4000
);
const apiHost = process.env["API_HOST"] ?? "0.0.0.0";
const topicRoot = process.env["MQTT_TOPIC_ROOT"] ?? "potbuddy";
const offlineAfterMs = Number(
  process.env["DEVICE_OFFLINE_AFTER_MS"] ?? 90_000,
);

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: applicationDefault(),
    databaseURL: required("FIREBASE_DATABASE_URL"),
  });

const database = getDatabase(firebaseApp);
const firebaseAuth = getAuth(firebaseApp);

const mqttClient: MqttClient = mqtt.connect(required("MQTT_URL"), {
  username: required("MQTT_USERNAME"),
  password: required("MQTT_PASSWORD"),
  reconnectPeriod: 3_000,
  connectTimeout: 10_000,
  rejectUnauthorized: true,
});
const pumpStopTimers = new Map<string, ReturnType<typeof setTimeout>>();

mqttClient.on("connect", () => {
  console.info("Connected to EMQX MQTT broker");

  mqttClient.subscribe(
    [`${topicRoot}/+/telemetry`, `${topicRoot}/+/status`],
    { qos: 1 },
    (error) => {
      if (error) {
        console.error("MQTT subscription failed", error);
      }
    },
  );
});

mqttClient.on("reconnect", () => {
  console.info("Reconnecting to MQTT broker");
});

mqttClient.on("error", (error) => {
  console.error("MQTT connection error", error.message);
});

mqttClient.on("message", (topic, message) => {
  void handleMqttMessage(topic, message.toString()).catch(
    (error: unknown) => {
      console.error(`Could not process MQTT message on ${topic}`, error);
    },
  );
});

const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "16kb" }));

app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    mqttConnected: mqttClient.connected,
    topicRoot,
  });
});

// Verify Firebase authentication for all API routes.
app.use(
  "/api",
  async (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    const authorization = request.header("authorization");
    const token = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : "";

    if (!token) {
      response.status(401).json({
        error: "Sign in is required.",
      });
      return;
    }

    try {
      const decoded = await firebaseAuth.verifyIdToken(token);
      response.locals["firebaseUid"] = decoded.uid;
      next();
    } catch {
      response.status(401).json({
        error: "The sign-in token is invalid or expired.",
      });
    }
  },
);

// Get devices authorized for the signed-in user.
app.get("/api/devices", async (_request, response) => {
  const firebaseUid = response.locals["firebaseUid"];

  if (typeof firebaseUid !== "string") {
    response.status(401).json({
      error: "A valid Firebase user is required.",
    });
    return;
  }

  try {
    const snapshot = await database.ref("devices").get();

    const records = (snapshot.val() ?? {}) as Record<
      string,
      {
        authorizedUsers?: Record<string, unknown>;
        status?: {
          online?: unknown;
          lastSeenAt?: unknown;
        };
      }
    >;

    const devices = Object.entries(records)
      .flatMap(([deviceId, record]) => {
        if (
          !parseDeviceId(deviceId) ||
          record?.authorizedUsers?.[firebaseUid] !== true
        ) {
          return [];
        }

        const lastSeenAt =
          typeof record.status?.lastSeenAt === "number"
            ? record.status.lastSeenAt
            : null;

        return [
          {
            deviceId,
            online:
              record.status?.online === true &&
              lastSeenAt !== null &&
              Date.now() - lastSeenAt <= offlineAfterMs,
            lastSeenAt,
          },
        ];
      })
      .sort(
        (left, right) =>
          Number(right.online) - Number(left.online) ||
          (right.lastSeenAt ?? 0) - (left.lastSeenAt ?? 0),
      );

    response.json({ devices });
  } catch (error) {
    console.error("Could not discover authorized devices", error);

    response.status(503).json({
      error: "Authorized devices could not be loaded.",
    });
  }
});

// Get the latest sensor reading and reading history.
app.get(
  "/api/devices/:deviceId/readings",
  async (request, response) => {
    const deviceId = parseDeviceId(request.params["deviceId"]);

    if (!deviceId) {
      response.status(400).json({
        error: "Invalid device ID.",
      });
      return;
    }

    if (!(await authorizeDevice(deviceId, response))) return;

    const parsedLimit = Number(request.query["limit"] ?? 40);

    const limit = Number.isInteger(parsedLimit)
      ? Math.max(1, Math.min(parsedLimit, 100))
      : 40;

    try {
      const deviceRef = database.ref(`devices/${deviceId}`);

      const [
        latestSnapshot,
        statusSnapshot,
        historySnapshot,
      ] = await Promise.all([
        deviceRef.child("latest").get(),
        deviceRef.child("status").get(),
        deviceRef
          .child("readings")
          .orderByChild("receivedAt")
          .limitToLast(limit)
          .get(),
      ]);

      const status = (statusSnapshot.val() ?? {}) as {
        online?: unknown;
        lastSeenAt?: unknown;
        reservoirAvailable?: unknown;
        reservoirLevelPct?: unknown;
      };

      const latest = latestSnapshot.val() as SensorReading | null;

      const lastSeenAt =
        typeof status.lastSeenAt === "number"
          ? status.lastSeenAt
          : null;

      const fresh =
        lastSeenAt !== null &&
        Date.now() - lastSeenAt <= offlineAfterMs;

      const online = status.online === true && fresh;

      const rows = Object.values(
        (historySnapshot.val() ?? {}) as Record<
          string,
          SensorReading
        >,
      )
        .filter(
          (reading) =>
            typeof reading?.receivedAt === "number",
        )
        .sort(
          (left, right) =>
            right.receivedAt - left.receivedAt,
        );

      response.json({
        deviceId,
        online,
        lastSeenAt,
        ...(typeof status.reservoirAvailable === "boolean"
          ? { reservoirAvailable: status.reservoirAvailable }
          : typeof latest?.reservoirAvailable === "boolean"
            ? { reservoirAvailable: latest.reservoirAvailable }
            : {}),
        ...(typeof status.reservoirLevelPct === "number"
          ? { reservoirLevelPct: status.reservoirLevelPct }
          : typeof latest?.reservoirLevelPct === "number"
            ? { reservoirLevelPct: latest.reservoirLevelPct }
            : {}),
        latest,
        readings: rows,
      });
    } catch (error) {
      console.error("Firebase read failed", error);

      response.status(503).json({
        error: "Sensor data is temporarily unavailable.",
      });
    }
  },
);

// Send a watering or stop command to the ESP32.
app.post(
  "/api/devices/:deviceId/commands",
  async (request, response) => {
    const deviceId = parseDeviceId(request.params["deviceId"]);
    const action = request.body?.action ?? "water";
    const potId = request.body?.potId;
    const durationSeconds = request.body?.durationSeconds;

    if (!deviceId) {
      response.status(400).json({
        error: "Invalid device ID.",
      });
      return;
    }

    if (!(await authorizeDevice(deviceId, response))) return;

    if (action !== "water" && action !== "stop") {
      response.status(400).json({
        error: "action must be water or stop.",
      });
      return;
    }

    if (potId !== undefined && !parsePotId(potId)) {
      response.status(400).json({
        error: "Invalid potId.",
      });
      return;
    }

    const pumpNumber = getEsp32PumpNumber(potId);
    if (pumpNumber === null) {
      response.status(400).json({
        error: "This controller requires potId pot-1, pot-2, or pot-3.",
      });
      return;
    }

    if (
      action === "water" &&
      (!Number.isInteger(durationSeconds) ||
        durationSeconds < 1 ||
        durationSeconds > 120)
    ) {
      response.status(400).json({
        error: "durationSeconds must be a whole number from 1 to 120.",
      });
      return;
    }

    if (!mqttClient.connected) {
      response.status(503).json({
        error: "The MQTT broker is disconnected; command was not sent.",
      });
      return;
    }

    const now = Date.now();

    try {
      const statusSnapshot = await database
        .ref(`devices/${deviceId}/status`)
        .get();

      const status = statusSnapshot.val() as {
        online?: unknown;
        lastSeenAt?: unknown;
        reservoirAvailable?: unknown;
      } | null;

      if (
        status?.online !== true ||
        typeof status.lastSeenAt !== "number" ||
        now - status.lastSeenAt > offlineAfterMs
      ) {
        response.status(409).json({
          error: "The device is offline; watering is blocked.",
        });
        return;
      }

      if (
        action === "water" &&
        status.reservoirAvailable === false
      ) {
        response.status(409).json({
          error: "The reservoir is reported empty; watering is blocked.",
        });
        return;
      }

      if (action === "water") {
        const cooldown = await database
          .ref(`devices/${deviceId}/control/lastCommandAt`)
          .transaction((last: unknown) => {
            if (
              typeof last === "number" &&
              now - last < 10_000
            ) {
              return;
            }

            return now;
          });

        if (!cooldown.committed) {
          response.status(429).json({
            error:
              "Wait a few seconds before sending another watering command.",
          });
          return;
        }
      }
    } catch (error) {
      console.error(
        "Could not verify device status before command",
        error,
      );

      response.status(503).json({
        error: "Device status could not be verified; command was not sent.",
      });
      return;
    }

    const command = {
      commandId: randomUUID(),
      action,
      ...(action === "water" ? { durationSeconds } : {}),
      ...(typeof potId === "string" ? { potId } : {}),
      issuedAt: Date.now(),
    } as const;

    const commandRef = database
      .ref(`devices/${deviceId}/commands`)
      .push();

    try {
      await commandRef.set({
        ...command,
        state: "pending",
      });

      await publishEsp32PumpCommand(deviceId, pumpNumber, action === "water" ? "on" : "off");

      const timerKey = `${deviceId}:${pumpNumber}`;
      const existingTimer = pumpStopTimers.get(timerKey);
      if (existingTimer) clearTimeout(existingTimer);
      pumpStopTimers.delete(timerKey);

      if (action === "water") {
        const durationMs = (durationSeconds as number) * 1000;
        const timer = setTimeout(() => {
          pumpStopTimers.delete(timerKey);
          void publishEsp32PumpCommand(deviceId, pumpNumber, "off").catch((error: unknown) => {
            console.error(`Timed pump stop failed for ${deviceId} pump ${pumpNumber}`, error);
          });
        }, durationMs);
        pumpStopTimers.set(timerKey, timer);
      }

      await commandRef.update({ state: "published" });

      response.status(202).json({
        accepted: true,
        command,
      });
    } catch (error) {
      console.error("Could not publish watering command", error);

      await commandRef
        .update({ state: "failed" })
        .catch(() => undefined);

      response.status(503).json({
        error: "The watering command could not be published.",
      });
    }
  },
);

// Handle unexpected API errors.
app.use(
  (
    error: unknown,
    _request: Request,
    response: Response,
    _next: NextFunction,
  ) => {
    console.error("Unhandled API error", error);

    response.status(500).json({
      error: "Unexpected server error.",
    });
  },
);

app.listen(apiPort, apiHost, () => {
  console.info(
    `PotBuddy API listening on http://${apiHost}:${apiPort}`,
  );
});

// Check whether the signed-in user can access this device.
async function authorizeDevice(
  deviceId: string,
  response: Response,
): Promise<boolean> {
  const firebaseUid = response.locals["firebaseUid"];

  if (typeof firebaseUid !== "string") {
    response.status(401).json({
      error: "A valid Firebase user is required.",
    });
    return false;
  }

  try {
    const access = await database
      .ref(`devices/${deviceId}/authorizedUsers/${firebaseUid}`)
      .get();

    if (access.val() !== true) {
      response.status(403).json({
        error: "This Firebase user is not authorized for the device.",
      });
      return false;
    }

    return true;
  } catch (error) {
    console.error("Could not verify device authorization", error);

    response.status(503).json({
      error: "Device authorization could not be verified.",
    });
    return false;
  }
}

// Process incoming MQTT messages.
async function handleMqttMessage(
  topic: string,
  message: string,
) {
  const [root, rawDeviceId, channel, ...rest] = topic.split("/");
  const deviceId = parseDeviceId(rawDeviceId);

  if (root !== topicRoot || !deviceId || rest.length > 0) {
    return;
  }

  const now = Date.now();

  if (channel === "status") {
    const status = parseStatus(message);

    if (!status) return;

    const nextStatus: {
      online: boolean;
      lastSeenAt: number;
      reservoirAvailable?: boolean;
      reservoirLevelPct?: number;
    } = {
      online: status.online,
      lastSeenAt: now,
    };

    if (typeof status.reservoirAvailable === "boolean") {
      nextStatus.reservoirAvailable = status.reservoirAvailable;
    }
    if (typeof status.reservoirLevelPct === "number") {
      nextStatus.reservoirLevelPct = status.reservoirLevelPct;
    }

    await database
      .ref(`devices/${deviceId}/status`)
      .update(nextStatus);

    return;
  }

  if (channel !== "telemetry") return;

  const payload = parseObject(message);

  // Log the incoming payload to help debug sensor data.
  console.info("Received ESP32 telemetry:", JSON.stringify(payload));

  const reading = normalizeReading(payload, now);

  if (!reading) {
    console.warn(
      `Ignoring telemetry without valid sensor values for ${deviceId}`,
    );
    return;
  }

  await Promise.all([
    database
      .ref(`devices/${deviceId}/readings`)
      .push()
      .set(reading),

    database
      .ref(`devices/${deviceId}/latest`)
      .set(reading),

    database
      .ref(`devices/${deviceId}/status`)
      .update({
        online: true,
        lastSeenAt: now,
        ...(typeof reading.reservoirAvailable === "boolean"
          ? { reservoirAvailable: reading.reservoirAvailable }
          : {}),
        ...(typeof reading.reservoirLevelPct === "number"
          ? { reservoirLevelPct: reading.reservoirLevelPct }
          : {}),
      }),
  ]);

  console.info(
    "Saved normalized telemetry:",
    JSON.stringify(reading),
  );
}

function parseObject(message: string): JsonObject {
  const value: unknown = JSON.parse(message);

  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new Error("MQTT payload must be a JSON object.");
  }

  return value as JsonObject;
}

function parseStatus(
  message: string,
): {
  online: boolean;
  reservoirAvailable?: boolean;
  reservoirLevelPct?: number;
} | null {
  if (message.trim().toLowerCase() === "offline") {
    return { online: false };
  }

  if (message.trim().toLowerCase() === "online") {
    return { online: true };
  }

  try {
    const payload = parseObject(message);

    const reservoirAvailable =
      payload["reservoirAvailable"] ??
      payload["waterAvailable"];
    const reservoirLevelPct = readNumber(payload, ["reservoirLevelPct", "waterLevelPct", "reservoirLevel", "waterLevel"]);

    if (
      typeof payload["online"] !== "boolean" &&
      typeof reservoirAvailable !== "boolean" &&
      (reservoirLevelPct === undefined || reservoirLevelPct < 0 || reservoirLevelPct > 100)
    ) {
      return null;
    }

    const result: {
      online: boolean;
      reservoirAvailable?: boolean;
      reservoirLevelPct?: number;
    } = {
      online:
        typeof payload["online"] === "boolean"
          ? payload["online"]
          : true,
    };

    if (typeof reservoirAvailable === "boolean") {
      result.reservoirAvailable = reservoirAvailable;
    }
    if (reservoirLevelPct !== undefined && reservoirLevelPct >= 0 && reservoirLevelPct <= 100) result.reservoirLevelPct = reservoirLevelPct;

    return result;
  } catch {
    return null;
  }
}

// Normalize the ESP32 telemetry to the app's data model.
function normalizeReading(
  payload: JsonObject,
  receivedAt: number,
): SensorReading | null {
  const moisturePct = readNumber(payload, [
    "moisturePct",
    "moisture",
    "soilMoisture",
    "soil_moisture",
  ]);

  const temperatureC = readNumber(payload, [
    "temperatureC",
    "temperature",
    "tempC",
    "temp_c",
  ]);

  const reservoir =
    payload["reservoirAvailable"] ??
    payload["waterAvailable"];
  const reservoirLevelPct = readNumber(payload, ["reservoirLevelPct", "waterLevelPct", "reservoirLevel", "waterLevel"]);

  const deviceTimestamp = readNumber(payload, [
    "timestamp",
    "ts",
  ]);

  const pots = normalizePots(payload["pots"]);

  const validMoisture =
    moisturePct !== undefined &&
    moisturePct >= 0 &&
    moisturePct <= 100;

  const validTemperature =
    temperatureC !== undefined &&
    temperatureC >= -50 &&
    temperatureC <= 100;

  if (
    !validMoisture &&
    !validTemperature &&
    pots.length === 0 &&
    typeof reservoir !== "boolean" &&
    (reservoirLevelPct === undefined || reservoirLevelPct < 0 || reservoirLevelPct > 100)
  ) {
    return null;
  }

  const reading: SensorReading = { receivedAt };

  if (validMoisture) {
    reading.moisturePct = moisturePct;
  }

  if (validTemperature) {
    reading.temperatureC = temperatureC;
  }

  if (typeof reservoir === "boolean") {
    reading.reservoirAvailable = reservoir;
  }
  if (reservoirLevelPct !== undefined && reservoirLevelPct >= 0 && reservoirLevelPct <= 100) reading.reservoirLevelPct = reservoirLevelPct;

  if (pots.length > 0) {
    reading.pots = pots;
  }

  if (
    deviceTimestamp !== undefined &&
    Number.isFinite(deviceTimestamp)
  ) {
    reading.deviceTimestamp = deviceTimestamp;
  }

  return reading;
}

// Supports the ESP32 fields:
// pot, soilMoisture, soilRaw, pumpRunning.
function normalizePots(value: unknown): PotReading[] {
  const entries: Array<[string | undefined, unknown]> =
    Array.isArray(value)
      ? value
          .slice(0, 32)
          .map(
            (entry): [string | undefined, unknown] => [
              undefined,
              entry,
            ],
          )
      : typeof value === "object" && value !== null
        ? Object.entries(value as JsonObject).slice(0, 32)
        : [];

  return entries.flatMap(([key, entry]) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      Array.isArray(entry)
    ) {
      return [];
    }

    const payload = entry as JsonObject;

    // The ESP32 uses numeric IDs: 1, 2, and 3.
    const rawId =
      payload["potId"] ??
      payload["id"] ??
      payload["pot"] ??
      key;

    const potId =
      typeof rawId === "number" && Number.isInteger(rawId)
        ? String(rawId)
        : parsePotId(rawId);

    if (!potId) return [];

    const moisturePct = readNumber(payload, [
      "moisturePct",
      "moisture",
      "soilMoisture",
      "soil_moisture",
    ]);

    const temperatureC = readNumber(payload, [
      "temperatureC",
      "temperature",
      "tempC",
      "temp_c",
    ]);

    const validMoisture =
      moisturePct !== undefined &&
      moisturePct >= 0 &&
      moisturePct <= 100;

    const validTemperature =
      temperatureC !== undefined &&
      temperatureC >= -50 &&
      temperatureC <= 100;

    const pump =
      payload["pumpState"] ??
      payload["pumpRunning"];

    const validPump =
      pump === "running" ||
      pump === true ||
      pump === "stopped" ||
      pump === false;

    if (!validMoisture && !validTemperature && !validPump) {
      return [];
    }

    const reading: PotReading = { potId };

    if (validMoisture) {
      reading.moisturePct = moisturePct;
    }

    if (validTemperature) {
      reading.temperatureC = temperatureC;
    }

    if (pump === "running" || pump === true) {
      reading.pumpState = "running";
    } else if (pump === "stopped" || pump === false) {
      reading.pumpState = "stopped";
    }

    return [reading];
  });
}

function readNumber(
  payload: JsonObject,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = payload[key];

    if (
      typeof value === "number" &&
      Number.isFinite(value)
    ) {
      return value;
    }

    if (
      typeof value === "string" &&
      value.trim() !== "" &&
      Number.isFinite(Number(value))
    ) {
      return Number(value);
    }
  }

  return undefined;
}

function parseDeviceId(
  value: string | undefined,
): string | null {
  return value && /^pot-[a-zA-Z0-9-]{1,30}$/.test(value)
    ? value
    : null;
}

function parsePotId(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return String(value);
  }

  return typeof value === "string" &&
    /^[a-zA-Z0-9_-]{1,32}$/.test(value)
    ? value
    : null;
}

function getEsp32PumpNumber(potId: unknown): number | null {
  if (typeof potId !== "string") return null;
  const match = /^pot-([1-3])$/.exec(potId);
  return match ? Number(match[1]) : null;
}

function publishEsp32PumpCommand(
  deviceId: string,
  pump: number,
  action: "on" | "off",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const topic = `${topicRoot}/${deviceId}/commands`;
    const payload = JSON.stringify({ pump, action });
    mqttClient.publish(
      topic,
      payload,
      { qos: 1 },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        console.info(`Sent pump ${pump} ${action} command to ${topic}: ${payload}`);
        resolve();
      },
    );
  });
}
