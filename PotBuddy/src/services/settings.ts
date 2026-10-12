import AsyncStorage from "@react-native-async-storage/async-storage";
import type { PlantProfile, WaterRequestRecord } from "../domain";
import { emptySettings, type AppSettings } from "./plantData";

const settingsKey = "potbuddy.user-settings.v1";
let saveQueue: Promise<void> = Promise.resolve();

export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await AsyncStorage.getItem(settingsKey);
    if (!raw) return { ...emptySettings, profiles: {}, requests: [], acknowledgedAlerts: [], autoWaterLatches: [] };
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return { ...emptySettings, profiles: {}, requests: [], acknowledgedAlerts: [], autoWaterLatches: [] };
    const profiles = loadProfiles(value["profiles"]);
    const pulseDurationSeconds = isValidDuration(value["pulseDurationSeconds"]) ? value["pulseDurationSeconds"] : null;
    const maximumRuntimeSeconds = isValidDuration(value["maximumRuntimeSeconds"]) ? value["maximumRuntimeSeconds"] : null;
    const thresholdsReady = Object.keys(profiles).length > 0 && Object.values(profiles).every((profile) => profile.startBelowPct !== null && profile.targetPct !== null && profile.startBelowPct < profile.targetPct);
    return {
      ...emptySettings,
      profiles,
      autoWaterEnabled: value["autoWaterEnabled"] === true && pulseDurationSeconds !== null && maximumRuntimeSeconds !== null && thresholdsReady,
      pulseDurationSeconds,
      maximumRuntimeSeconds,
      checkIntervalSeconds: isValidInterval(value["checkIntervalSeconds"]) ? value["checkIntervalSeconds"] : emptySettings.checkIntervalSeconds,
      temperatureAlertC: isValidTemperature(value["temperatureAlertC"]) ? value["temperatureAlertC"] : null,
      lowMoistureAlerts: value["lowMoistureAlerts"] !== false,
      lowReservoirAlerts: value["lowReservoirAlerts"] !== false,
      deviceOfflineAlerts: value["deviceOfflineAlerts"] !== false,
      requests: Array.isArray(value["requests"]) ? value["requests"].filter(isRequest).slice(-100) : [],
      acknowledgedAlerts: Array.isArray(value["acknowledgedAlerts"]) ? value["acknowledgedAlerts"].filter((entry): entry is string => typeof entry === "string").slice(-200) : [],
      autoWaterLatches: Array.isArray(value["autoWaterLatches"]) ? value["autoWaterLatches"].filter((entry): entry is string => typeof entry === "string").slice(-100) : [],
    };
  } catch {
    return { ...emptySettings, profiles: {}, requests: [], acknowledgedAlerts: [], autoWaterLatches: [] };
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  saveQueue = saveQueue.catch(() => undefined).then(() => AsyncStorage.setItem(settingsKey, JSON.stringify(settings)));
  await saveQueue;
}

export function isValidDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120;
}

function isValidInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 5 && value <= 3600;
}

export function isValidMoisture(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isValidTemperature(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= -50 && value <= 100);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function loadProfiles(value: unknown): Record<string, PlantProfile> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).flatMap(([potId, raw]) => {
    if (!isRecord(raw) || typeof raw["name"] !== "string" || typeof raw["species"] !== "string") return [];
    const startBelowPct = raw["startBelowPct"];
    const targetPct = raw["targetPct"];
    if (!isNullableMoisture(startBelowPct) || !isNullableMoisture(targetPct)) return [];
    const imageKey = raw["imageKey"];
    const profile: PlantProfile = { name: raw["name"], species: raw["species"], startBelowPct, targetPct };
    if (typeof imageKey === "string" && /^plant-[1-4]$/.test(imageKey)) profile.imageKey = imageKey;
    return [[potId, profile] as [string, PlantProfile]];
  }));
}

function isNullableMoisture(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100);
}

function isRequest(value: unknown): value is WaterRequestRecord {
  if (!isRecord(value)) return false;
  return typeof value["potId"] === "string" && typeof value["issuedAt"] === "number" && Number.isFinite(value["issuedAt"]) && isValidDuration(value["durationSeconds"]);
}
