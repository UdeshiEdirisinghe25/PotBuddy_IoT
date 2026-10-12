  
import type {
  DeviceSnapshot,
  PlantProfile,
  PotReading,
  SensorReading,
  WaterRequestRecord,
} from "../domain";

export type ObservedPot = PotReading & {
  receivedAt: number;
};

export type AppSettings = {
  profiles: Record<string, PlantProfile>;
  autoWaterEnabled: boolean;
  pulseDurationSeconds: number | null;
  maximumRuntimeSeconds: number | null;
  checkIntervalSeconds: number;
  temperatureAlertC: number | null;
  lowMoistureAlerts: boolean;
  lowReservoirAlerts: boolean;
  deviceOfflineAlerts: boolean;
  requests: WaterRequestRecord[];
  acknowledgedAlerts: string[];
  autoWaterLatches: string[];
};

export const emptySettings: AppSettings = {
  profiles: {},
  autoWaterEnabled: false,
  pulseDurationSeconds: null,
  maximumRuntimeSeconds: null,
  checkIntervalSeconds: 10,
  temperatureAlertC: null,
  lowMoistureAlerts: true,
  lowReservoirAlerts: true,
  deviceOfflineAlerts: true,
  requests: [],
  acknowledgedAlerts: [],
  autoWaterLatches: [],
};

type RawPotReading = {
  potId?: unknown;
  pot?: unknown;
  id?: unknown;
  moisturePct?: unknown;
  moisture?: unknown;
  soilMoisture?: unknown;
  soil_moisture?: unknown;
  temperatureC?: unknown;
  temperature?: unknown;
  tempC?: unknown;
  temp_c?: unknown;
  humidityPct?: unknown;
  humidity?: unknown;
  relativeHumidity?: unknown;
  pumpState?: unknown;
  pumpRunning?: unknown;
};

function readNumber(
  source: Record<string, unknown>,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = source[key];

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

function normalizePot(
  value: unknown,
  fallbackId?: string,
): PotReading | null {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    return null;
  }

  const raw = value as RawPotReading;

  const rawId = raw.potId ?? raw.id ?? raw.pot ?? fallbackId;

  if (rawId === undefined || rawId === null) {
    return null;
  }

  // The ESP32 sends numeric pot IDs: 1, 2, and 3.
  const potId =
    typeof rawId === "number" || typeof rawId === "string"
      ? String(rawId).startsWith("pot-")
        ? String(rawId)
        : `pot-${String(rawId)}`
      : "";

  if (!potId || !/^pot-[a-zA-Z0-9_-]{1,32}$/.test(potId)) {
    return null;
  }

  const moisturePct = readNumber(raw as Record<string, unknown>, [
    "moisturePct",
    "moisture",
    "soilMoisture",
    "soil_moisture",
  ]);

  const temperatureC = readNumber(raw as Record<string, unknown>, [
    "temperatureC",
    "temperature",
    "tempC",
    "temp_c",
  ]);

  const humidityPct = readNumber(raw as Record<string, unknown>, [
    "humidityPct",
    "humidity",
    "relativeHumidity",
  ]);

  const pump = raw.pumpState ?? raw.pumpRunning;

  const pot: PotReading = { potId };

  if (
    moisturePct !== undefined &&
    moisturePct >= 0 &&
    moisturePct <= 100
  ) {
    pot.moisturePct = moisturePct;
  }

  if (
    temperatureC !== undefined &&
    temperatureC >= -50 &&
    temperatureC <= 100
  ) {
    pot.temperatureC = temperatureC;
  }

  if (
    humidityPct !== undefined &&
    humidityPct >= 0 &&
    humidityPct <= 100
  ) {
    pot.humidityPct = humidityPct;
  }

  if (pump === true || pump === "running") {
    pot.pumpState = "running";
  } else if (pump === false || pump === "stopped") {
    pot.pumpState = "stopped";
  }

  if (
    pot.moisturePct === undefined &&
    pot.temperatureC === undefined &&
    pot.humidityPct === undefined &&
    pot.pumpState === undefined
  ) {
    return null;
  }

  return pot;
}

export function getObservedPots(
  snapshot: DeviceSnapshot | null,
): ObservedPot[] {
  if (!snapshot) return [];

  const result = new Map<string, ObservedPot>();

  const samples = [...snapshot.readings].sort(
    (a, b) => b.receivedAt - a.receivedAt,
  );

  if (snapshot.latest) {
    samples.unshift(snapshot.latest);
  }

  for (const sample of samples) {
    for (const pot of getPotsFromReading(sample, snapshot.deviceId)) {
      const existing = result.get(pot.potId);

      if (!existing || sample.receivedAt > existing.receivedAt) {
        result.set(pot.potId, {
          ...existing,
          ...pot,
          receivedAt: sample.receivedAt,
        });
      }
    }
  }

  return [...result.values()];
}

export function getPotHistory(
  readings: SensorReading[],
  potId: string,
  deviceId: string,
): SensorReading[] {
  return readings
    .flatMap((reading) => {
      const pot = getPotsFromReading(reading, deviceId).find(
        (entry) => entry.potId === potId,
      );

      if (!pot) return [];

      const { pots: _pots, ...base } = reading;

      return [
        {
          ...base,
          ...(pot.moisturePct !== undefined
            ? { moisturePct: pot.moisturePct }
            : {}),
          ...(pot.temperatureC !== undefined
            ? { temperatureC: pot.temperatureC }
            : {}),
          ...(pot.humidityPct !== undefined
            ? { humidityPct: pot.humidityPct }
            : {}),
          ...(pot.pumpState !== undefined
            ? { pumpState: pot.pumpState }
            : {}),
        },
      ];
    })
    .sort((a, b) => a.receivedAt - b.receivedAt);
}

export function getPlantProfile(
  settings: AppSettings,
  potId: string,
): PlantProfile {
  return (
    settings.profiles[potId] ?? {
      name: potId,
      species: "",
      startBelowPct: null,
      targetPct: null,
    }
  );
}

export function getPotsFromReading(
  reading: SensorReading,
  deviceId: string,
): PotReading[] {
  const rawReading = reading as SensorReading & {
    temperature?: number;
    waterAvailable?: boolean;
    soilMoisture?: number;
    moisture?: number;
    humidity?: number;
    pots?: unknown;
  };

  if (Array.isArray(rawReading.pots)) {
    const pots = rawReading.pots
      .map((pot) => normalizePot(pot))
      .filter((pot): pot is PotReading => pot !== null);

    if (pots.length > 0) return pots;
  }

  // Also support top-level sensor fields.
  const moisturePct = readNumber(
    rawReading as Record<string, unknown>,
    ["moisturePct", "moisture", "soilMoisture"],
  );

  const temperatureC = readNumber(
    rawReading as Record<string, unknown>,
    ["temperatureC", "temperature"],
  );

  const humidityPct = readNumber(
    rawReading as Record<string, unknown>,
    ["humidityPct", "humidity"],
  );

  if (
    moisturePct !== undefined ||
    temperatureC !== undefined ||
    humidityPct !== undefined
  ) {
    return [
      {
        potId: deviceId,
        ...(moisturePct !== undefined ? { moisturePct } : {}),
        ...(temperatureC !== undefined ? { temperatureC } : {}),
        ...(humidityPct !== undefined ? { humidityPct } : {}),
      },
    ];
  }

  return [];
}

export function countRequestsToday(
  requests: WaterRequestRecord[],
  now = Date.now(),
): number {
  const date = new Date(now);

  return requests.filter((request) => {
    const issued = new Date(request.issuedAt);

    return (
      issued.getFullYear() === date.getFullYear() &&
      issued.getMonth() === date.getMonth() &&
      issued.getDate() === date.getDate()
    );
  }).length;
}

export function alertKey(
  kind: string,
  reference: string,
  value: number | string,
): string {
  return `${kind}:${reference}:${value}`;
}
