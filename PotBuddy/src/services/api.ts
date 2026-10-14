import type { DeviceSnapshot, WaterCommand } from "../domain";
import Constants from "expo-constants";
import { getApiToken } from "./firebase";

function readExpoValue(value: string | undefined): string {
  let normalized = (value ?? "").trim().replace(/,\s*$/, "");
  if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) normalized = normalized.slice(1, -1).trim();
  return normalized;
}

const explicitBaseUrl = readExpoValue(process.env["EXPO_PUBLIC_API_URL"]).replace(/\/$/, "");
const expoHost = Constants.expoConfig?.hostUri?.split(":")[0]
  || (typeof window !== "undefined" ? window.location?.hostname ?? "" : "");
const apiPortValue = Constants.expoConfig?.extra?.["apiPort"];
const inferredBaseUrl = expoHost && typeof apiPortValue === "number" && Number.isInteger(apiPortValue) && apiPortValue > 0
  ? `http://${expoHost}:${apiPortValue}`
  : "";
const baseUrl = explicitBaseUrl || inferredBaseUrl;
let resolvedDeviceId = readExpoValue(process.env["EXPO_PUBLIC_DEVICE_ID"]);
export const apiConfigured = Boolean(baseUrl);

export type BackendStatus = { ok: boolean; mqttConnected: boolean; topicRoot: string };

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (!baseUrl) throw new Error("Could not determine the API address. Set EXPO_PUBLIC_API_URL or start Expo on the same network as the API.");
  const token = await getApiToken();
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const payload = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status}).`);
  return payload;
}

export async function getReadings(): Promise<DeviceSnapshot> {
  const id = await getDeviceId();
  return request<DeviceSnapshot>(`/api/devices/${encodeURIComponent(id)}/readings?limit=40`);
}

export function getBackendStatus(): Promise<BackendStatus> {
  return request<BackendStatus>("/health");
}

export async function registerNotificationSettings(deviceId: string, settings: {
  expoPushToken: string;
  lowMoistureAlerts: boolean;
  lowReservoirAlerts: boolean;
  deviceOfflineAlerts: boolean;
  temperatureAlertC: number | null;
  profiles: Record<string, { name: string; startBelowPct: number | null }>;
}): Promise<void> {
  await request(`/api/devices/${encodeURIComponent(deviceId)}/notifications`, {
    method: "POST",
    body: JSON.stringify(settings),
  });
}

export async function sendDeviceConfiguration(deviceId: string, configuration: {
  type: "config";
  autoWaterEnabled: boolean;
  pulseDurationSeconds: number | null;
  maximumRuntimeSeconds: number | null;
  profiles: Record<string, { startBelowPct: number | null; targetPct: number | null }>;
}): Promise<void> {
  await request(`/api/devices/${encodeURIComponent(deviceId)}/config`, {
    method: "POST",
    body: JSON.stringify(configuration),
  });
}

export async function sendPotWaterCommand(potId: string, durationSeconds: number): Promise<{ accepted: boolean; command: WaterCommand }> {
  const id = await getDeviceId();
  return request(`/api/devices/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    body: JSON.stringify({ action: "water", potId, durationSeconds }),
  });
}

export async function sendStopCommand(potId?: string): Promise<{ accepted: boolean; command: WaterCommand }> {
  const id = await getDeviceId();
  return request(`/api/devices/${encodeURIComponent(id)}/commands`, {
    method: "POST",
    body: JSON.stringify({ action: "stop", ...(potId ? { potId } : {}) }),
  });
}

async function getDeviceId(): Promise<string> {
  if (resolvedDeviceId) return resolvedDeviceId;
  const result = await request<{ devices: Array<{ deviceId: string; online: boolean; lastSeenAt: number | null }> }>("/api/devices");
  const device = result.devices.find((entry) => entry.online) ?? result.devices[0];
  if (!device) throw new Error("No controller is authorized for this Firebase account.");
  resolvedDeviceId = device.deviceId;
  return resolvedDeviceId;
}
