
import "dotenv/config";

import { randomUUID } from "node:crypto";

import {
  applicationDefault,
  cert,
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
const configuredRetentionDays = Number(process.env["READING_RETENTION_DAYS"] ?? 14);
const readingRetentionDays = Number.isFinite(configuredRetentionDays) && configuredRetentionDays > 0
  ? configuredRetentionDays
  : 14;
const readingRetentionMs = readingRetentionDays * 24 * 60 * 60 * 1000;


const serviceAccountJson =
  process.env["FIREBASE_SERVICE_ACCOUNT_JSON"];

const firebaseApp =
  getApps()[0] ??
  initializeApp({
    credential: serviceAccountJson
      ? cert(JSON.parse(serviceAccountJson))
      : applicationDefault(),
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
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();
let retentionCleanupRunning = false;
const retentionIndexedDeviceIds = new Set<string>();

void cleanupExpiredReadings().catch((error: unknown) => {
  console.error("Initial reading retention cleanup failed", error);
});
const retentionCleanupTimer = setInterval(() => {
  void cleanupExpiredReadings().catch((error: unknown) => {
    console.error("Reading retention cleanup failed", error);
  });
}, 60 * 60 * 1000);
retentionCleanupTimer.unref();

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

app.post("/api/devices/:deviceId/notifications", async (request, response) => {
  const deviceId = parseDeviceId(request.params["deviceId"]);
  const firebaseUid = response.locals["firebaseUid"];
  const body = (request.body ?? {}) as Record<string, unknown>;
  const expoPushToken = body["expoPushToken"];
  const profiles = body["profiles"];
  if (!deviceId || typeof firebaseUid !== "string") {
    response.status(400).json({ error: "Invalid device or user." });
    return;
  }
  if (!(await authorizeDevice(deviceId, response))) return;
  if (typeof expoPushToken !== "string" || !(/^ExponentPushToken\[[^\]]+\]$/.test(expoPushToken) || /^ExpoPushToken\[[^\]]+\]$/.test(expoPushToken))) {
    response.status(400).json({ error: "A valid Expo push token is required." });
    return;
  }
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) {
    response.status(400).json({ error: "Plant profiles are required." });
    return;
  }
  const safeProfiles: Record<string, { name: string; startBelowPct: number | null }> = {};
  for (const [potId, value] of Object.entries(profiles as Record<string, unknown>)) {
    if (!parsePotId(potId) || !value || typeof value !== "object" || Array.isArray(value)) continue;
    const profile = value as Record<string, unknown>;
    const threshold = profile["startBelowPct"];
    if (typeof profile["name"] !== "string" || threshold !== null && (typeof threshold !== "number" || threshold < 0 || threshold > 100)) continue;
    safeProfiles[potId] = { name: profile["name"].slice(0, 80), startBelowPct: threshold as number | null };
  }
  const temperatureAlertC = body["temperatureAlertC"];
  await database.ref(`devices/${deviceId}/notificationSubscribers/${firebaseUid}`).update({
    expoPushToken,
    settings: {
      lowMoistureAlerts: body["lowMoistureAlerts"] === true,
      lowReservoirAlerts: body["lowReservoirAlerts"] === true,
      deviceOfflineAlerts: body["deviceOfflineAlerts"] === true,
      temperatureAlertC: typeof temperatureAlertC === "number" && temperatureAlertC >= -50 && temperatureAlertC <= 100 ? temperatureAlertC : null,
      profiles: safeProfiles,
    },
  });
  response.json({ registered: true });
});

app.post("/api/devices/:deviceId/config", async (request, response) => {
  const deviceId = parseDeviceId(request.params["deviceId"]);
  const body = (request.body ?? {}) as Record<string, unknown>;
  if (!deviceId) {
    response.status(400).json({ error: "Invalid device ID." });
    return;
  }
  if (!(await authorizeDevice(deviceId, response))) return;
  if (body["type"] !== "config" || typeof body["autoWaterEnabled"] !== "boolean") {
    response.status(400).json({ error: "A config message with autoWaterEnabled is required." });
    return;
  }

  const profilesInput = body["profiles"];
  if (!profilesInput || typeof profilesInput !== "object" || Array.isArray(profilesInput)) {
    response.status(400).json({ error: "Profiles for pots 1–3 are required." });
    return;
  }

  const profiles = profilesInput as Record<string, unknown>;
  const potIds = ["pot-1", "pot-2", "pot-3"];
  const safeProfiles: Record<string, { startBelowPct: number | null; targetPct: number | null }> = {};
  for (const potId of potIds) {
    const profile = profiles[potId];
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
      response.status(400).json({ error: `A moisture profile for ${potId} is required.` });
      return;
    }
    const values = profile as Record<string, unknown>;
    const startBelowPct = values["startBelowPct"];
    const targetPct = values["targetPct"];
    const validPct = (value: unknown): value is number | null => value === null || typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
    if (!validPct(startBelowPct) || !validPct(targetPct)) {
      response.status(400).json({ error: `Moisture thresholds for ${potId} must be between 0 and 100.` });
      return;
    }
    if (body["autoWaterEnabled"] && (startBelowPct === null || targetPct === null || startBelowPct >= targetPct)) {
      response.status(400).json({ error: `Set a valid dry-soil level below the target for ${potId} before enabling Auto.` });
      return;
    }
    safeProfiles[potId] = { startBelowPct, targetPct };
  }

  const pulseDurationSeconds = body["pulseDurationSeconds"];
  const maximumRuntimeSeconds = body["maximumRuntimeSeconds"];
  const validDuration = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120;
  if (body["autoWaterEnabled"] && (!validDuration(pulseDurationSeconds) || !validDuration(maximumRuntimeSeconds) || pulseDurationSeconds > maximumRuntimeSeconds)) {
    response.status(400).json({ error: "Choose valid watering and maximum runtime values before enabling Auto." });
    return;
  }

  if (!mqttClient.connected) {
    response.status(503).json({ error: "The MQTT broker is disconnected; configuration was not sent." });
    return;
  }

  const configuration = {
    type: "config",
    autoWaterEnabled: body["autoWaterEnabled"],
    pulseDurationSeconds: validDuration(pulseDurationSeconds) ? pulseDurationSeconds : null,
    maximumRuntimeSeconds: validDuration(maximumRuntimeSeconds) ? maximumRuntimeSeconds : null,
    profiles: safeProfiles,
  };
  const topic = `${topicRoot}/${deviceId}/commands`;
  mqttClient.publish(topic, JSON.stringify(configuration), { qos: 1 }, (error) => {
    if (error) {
      console.error(`Could not publish configuration to ${topic}`, error);
      response.status(503).json({ error: "The controller configuration could not be published." });
      return;
    }
    console.info(`Sent controller configuration to ${topic}`);
    response.status(202).json({ accepted: true });
  });
});

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
  await registerDeviceForRetention(deviceId);

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

    if (status.online) {
      void processTelemetryPushAlerts(deviceId, { receivedAt: now, ...(typeof status.reservoirAvailable === "boolean" ? { reservoirAvailable: status.reservoirAvailable } : {}) }).catch((error: unknown) => console.error("Could not process status push alert", error));
    }

    if (status.online) {
      scheduleOfflineCheck(deviceId, now);
      void updateOfflinePushAlerts(deviceId, false).catch((error: unknown) => console.error("Could not clear offline push alert", error));
    } else {
      void updateOfflinePushAlerts(deviceId, true).catch((error: unknown) => console.error("Could not send offline push alert", error));
    }

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

  scheduleOfflineCheck(deviceId, now);
  void updateOfflinePushAlerts(deviceId, false).catch((error: unknown) => console.error("Could not clear offline push alert", error));
  void processTelemetryPushAlerts(deviceId, reading).catch((error: unknown) => console.error("Could not process push alerts", error));

  console.info(
    "Saved normalized telemetry:",
    JSON.stringify(reading),
  );
}

type PushAlert = { id: string; title: string; body: string; severity: "warning" | "critical" };
type PushSubscriber = { expoPushToken?: unknown; settings?: unknown; activeAlerts?: unknown };

async function cleanupExpiredReadings() {
  if (retentionCleanupRunning) return;
  retentionCleanupRunning = true;

  try {
    const cutoff = Date.now() - readingRetentionMs;
    const indexInitializedRef = database.ref("_maintenance/readingRetentionIndexInitialized");
    const indexInitializedSnapshot = await indexInitializedRef.get();
    let deviceIds: string[];

    if (indexInitializedSnapshot.val() === true) {
      const indexedDevicesSnapshot = await database.ref("_maintenance/readingRetentionDeviceIds").get();
      const indexedDevices = (indexedDevicesSnapshot.val() ?? {}) as Record<string, unknown>;
      deviceIds = Object.keys(indexedDevices);
      deviceIds.forEach((deviceId) => retentionIndexedDeviceIds.add(deviceId));
    } else {
      // One-time index migration; later cleanups read only this small device list.
      const devicesSnapshot = await database.ref("devices").get();
      const devices = (devicesSnapshot.val() ?? {}) as Record<string, unknown>;
      deviceIds = Object.keys(devices);
      const indexUpdates = Object.fromEntries(deviceIds.map((deviceId) => [deviceId, true]));
      if (deviceIds.length > 0) {
        await database.ref("_maintenance/readingRetentionDeviceIds").update(indexUpdates);
      }
      await indexInitializedRef.set(true);
      deviceIds.forEach((deviceId) => retentionIndexedDeviceIds.add(deviceId));
    }
    let deletedCount = 0;

    for (const deviceId of deviceIds) {
      const readingsRef = database.ref(`devices/${deviceId}/readings`);
      const expiredSnapshot = await readingsRef
        .orderByChild("receivedAt")
        .endAt(cutoff)
        .get();
      const expired = (expiredSnapshot.val() ?? {}) as Record<string, SensorReading>;
      const expiredKeys = Object.entries(expired)
        .filter(([, reading]) => typeof reading?.receivedAt === "number" && reading.receivedAt < cutoff)
        .map(([key]) => key);

      for (let index = 0; index < expiredKeys.length; index += 500) {
        const updates = Object.fromEntries(
          expiredKeys.slice(index, index + 500).map((key) => [key, null]),
        );
        await readingsRef.update(updates);
      }
      deletedCount += expiredKeys.length;

      const latestRef = database.ref(`devices/${deviceId}/latest`);
      const latestSnapshot = await latestRef.get();
      const latest = latestSnapshot.val() as SensorReading | null;
      if (typeof latest?.receivedAt === "number" && latest.receivedAt < cutoff) {
        await latestRef.remove();
      }

      const statusRef = database.ref(`devices/${deviceId}/status`);
      const statusSnapshot = await statusRef.get();
      const status = statusSnapshot.val() as {
        lastSeenAt?: unknown;
        reservoirAvailable?: unknown;
        reservoirLevelPct?: unknown;
      } | null;
      if (typeof status?.lastSeenAt === "number" && status.lastSeenAt < cutoff) {
        await statusRef.update({ reservoirAvailable: null, reservoirLevelPct: null });
      }
    }

    if (deletedCount > 0) {
      console.info(`Removed ${deletedCount} sensor readings older than ${readingRetentionDays} days`);
    }
  } finally {
    retentionCleanupRunning = false;
  }
}

async function registerDeviceForRetention(deviceId: string) {
  if (retentionIndexedDeviceIds.has(deviceId)) return;
  retentionIndexedDeviceIds.add(deviceId);
  try {
    await database.ref(`_maintenance/readingRetentionDeviceIds/${deviceId}`).set(true);
  } catch (error) {
    retentionIndexedDeviceIds.delete(deviceId);
    throw error;
  }
}

function scheduleOfflineCheck(deviceId: string, lastSeenAt: number) {
  const existing = offlineTimers.get(deviceId);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    offlineTimers.delete(deviceId);
    void database.ref(`devices/${deviceId}/status`).get().then(async (snapshot) => {
      const status = snapshot.val() as { lastSeenAt?: unknown; online?: unknown } | null;
      if (status?.lastSeenAt !== lastSeenAt || status.online !== true) return;
      await database.ref(`devices/${deviceId}/status/online`).set(false);
      await updateOfflinePushAlerts(deviceId, true);
    }).catch((error: unknown) => console.error("Offline notification check failed", error));
  }, Math.max(0, offlineAfterMs));
  offlineTimers.set(deviceId, timer);
}

async function updateOfflinePushAlerts(deviceId: string, offline: boolean) {
  await updateSubscriberAlerts(deviceId, (subscriber) => {
    const settings = subscriberSettings(subscriber);
    return {
      activate: offline && settings["deviceOfflineAlerts"] ? [{ id: "offline_active", title: "Watering device is offline", body: "The watering device stopped sending updates. Check its power and Wi-Fi.", severity: "critical" }] : [],
      clear: !offline || !settings["deviceOfflineAlerts"] ? ["offline_active"] : [],
    };
  });
}

async function processTelemetryPushAlerts(deviceId: string, reading: SensorReading) {
  await updateSubscriberAlerts(deviceId, (subscriber) => {
    const settings = subscriberSettings(subscriber);
    const profiles = settings["profiles"] && typeof settings["profiles"] === "object" ? settings["profiles"] as Record<string, { name?: string; startBelowPct?: number | null }> : {};
    const readings = reading.pots?.length ? reading.pots : [{ potId: deviceId, moisturePct: reading.moisturePct, temperatureC: reading.temperatureC }];
    const activate: PushAlert[] = [];
    const clear: string[] = ["offline_active"];
    for (const plant of readings) {
      const profile = profiles[plant.potId];
      const name = typeof profile?.name === "string" && profile.name ? profile.name : plant.potId;
      const moistureId = `moisture_${plant.potId}`;
      if (settings["lowMoistureAlerts"] && typeof plant.moisturePct === "number" && typeof profile?.startBelowPct === "number") {
        if (plant.moisturePct < profile.startBelowPct) activate.push({ id: moistureId, title: `${name} needs water`, body: `Soil moisture is ${plant.moisturePct.toFixed(1)}%, below the ${profile.startBelowPct}% level you chose.`, severity: "warning" });
        else clear.push(moistureId);
      } else if (!settings["lowMoistureAlerts"] || profile?.startBelowPct === null) clear.push(moistureId);

      const temperatureId = `temperature_${plant.potId}`;
      if (typeof settings["temperatureAlertC"] === "number" && typeof plant.temperatureC === "number") {
        if (plant.temperatureC > settings["temperatureAlertC"]) activate.push({ id: temperatureId, title: `It is warm near ${name}`, body: `The temperature is ${plant.temperatureC.toFixed(1)}°C, above the ${settings["temperatureAlertC"]}°C level you chose.`, severity: "warning" });
        else clear.push(temperatureId);
      } else if (settings["temperatureAlertC"] === null) clear.push(temperatureId);
    }
    if (typeof reading.reservoirAvailable === "boolean") {
      if (settings["lowReservoirAlerts"] && !reading.reservoirAvailable) activate.push({ id: "reservoir_empty", title: "Water tank is empty", body: "Refill the tank before watering your plants.", severity: "critical" });
      else clear.push("reservoir_empty");
    }
    return { activate, clear };
  });
}

function subscriberSettings(subscriber: PushSubscriber): Record<string, unknown> {
  return subscriber.settings && typeof subscriber.settings === "object" ? subscriber.settings as Record<string, unknown> : {};
}

async function updateSubscriberAlerts(deviceId: string, evaluate: (subscriber: PushSubscriber) => { activate: PushAlert[]; clear: string[] }) {
  const snapshot = await database.ref(`devices/${deviceId}/notificationSubscribers`).get();
  const subscribers = (snapshot.val() ?? {}) as Record<string, PushSubscriber>;
  await Promise.all(Object.entries(subscribers).map(async ([uid, subscriber]) => {
    if (typeof subscriber.expoPushToken !== "string") return;
    const { activate, clear } = evaluate(subscriber);
    const states = subscriber.activeAlerts && typeof subscriber.activeAlerts === "object" ? { ...(subscriber.activeAlerts as Record<string, boolean>) } : {};
    const newlyActive = activate.filter((alert) => states[alert.id] !== true);
    for (const id of clear) delete states[id];
    for (const alert of activate) states[alert.id] = true;
    await database.ref(`devices/${deviceId}/notificationSubscribers/${uid}/activeAlerts`).set(states);
    await Promise.all(newlyActive.map((alert) => sendExpoPush(subscriber.expoPushToken as string, alert)));
  }));
}

async function sendExpoPush(to: string, alert: PushAlert) {
  const result = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST",
    headers: { Accept: "application/json", "Accept-Encoding": "gzip, deflate", "Content-Type": "application/json" },
    body: JSON.stringify({ to, title: alert.title, body: alert.body, sound: "default", priority: alert.severity === "critical" ? "high" : "default", channelId: "alerts", data: { alertId: alert.id } }),
  });
  if (!result.ok) console.error("Expo push notification request failed", result.status, await result.text());
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

    const parsedPotId = typeof rawId === "number" && Number.isInteger(rawId)
      ? String(rawId)
      : parsePotId(rawId);
    const potId = parsedPotId && parsedPotId.startsWith("pot-") ? parsedPotId : parsedPotId ? `pot-${parsedPotId}` : null;

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
