
export type SensorReading = {
  receivedAt: number;
  deviceTimestamp?: number;

  // General sensor readings
  moisturePct?: number;
  temperatureC?: number;
  humidityPct?: number;

  // Water reservoir status
  reservoirAvailable?: boolean;
  reservoirLevelPct?: number;

  // Pump status for a single pot/device
  pumpState?: "running" | "stopped";

  // Readings for multiple pots
  pots?: PotReading[];
};

export type PotReading = {
  potId: string;

  moisturePct?: number;
  temperatureC?: number;
  humidityPct?: number;

  pumpState?: "running" | "stopped";
};

export type DeviceSnapshot = {
  deviceId: string;
  online: boolean;
  lastSeenAt: number | null;

  reservoirAvailable?: boolean;
  reservoirLevelPct?: number;

  latest: SensorReading | null;
  readings: SensorReading[];
};

export type WaterCommand = {
  commandId: string;
  action: "water" | "stop";
  durationSeconds?: number;
  potId?: string;
  issuedAt: number;
};

export type PlantProfile = {
  name: string;
  species: string;
  imageKey?: string;

  startBelowPct: number | null;
  targetPct: number | null;
};

export type WaterRequestRecord = {
  potId: string;
  issuedAt: number;
  durationSeconds: number;
};
