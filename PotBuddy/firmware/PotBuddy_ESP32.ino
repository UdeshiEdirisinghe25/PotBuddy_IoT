#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <Wire.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <time.h>
#include <math.h>

// =====================================================
// POTBUDDY ESP32-S3
// Manual + Local Automatic Watering
// 3 soil sensors, 3 pumps
// =====================================================

// Replace with your NEW credentials.
// Do not share these values publicly.
const char* WIFI_SSID = "Oshany";
const char* WIFI_PASSWORD = "12345678";

const char* MQTT_HOST = "u25c1215.ala.asia-southeast1.emqxsl.com";
const uint16_t MQTT_PORT = 8883;
const char* MQTT_USERNAME = "ESP32_MQTT";
const char* MQTT_PASSWORD = "projectiot2026";
const char* MQTT_CLIENT_ID = "potbuddy-esp32-pot-001";

const char* TOPIC_TELEMETRY = "potbuddy/pot-001/telemetry";
const char* TOPIC_STATUS = "potbuddy/pot-001/status";
const char* TOPIC_EVENTS = "potbuddy/pot-001/events";
const char* TOPIC_COMMANDS = "potbuddy/pot-001/commands";

// IMPORTANT:
// Paste the complete, valid CA certificate from your
// previously working TLS sketch between these markers.
const char* ROOT_CA = R"PEM(
-----BEGIN CERTIFICATE-----
MIIDjjCCAnagAwIBAgIQAzrx5qcRqaC7KGSxHQn65TANBgkqhkiG9w0BAQsFADBh
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSAwHgYDVQQDExdEaWdpQ2VydCBHbG9iYWwgUm9vdCBH
MjAeFw0xMzA4MDExMjAwMDBaFw0zODAxMTUxMjAwMDBaMGExCzAJBgNVBAYTAlVT
MRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMxGTAXBgNVBAsTEHd3dy5kaWdpY2VydC5j
b20xIDAeBgNVBAMTF0RpZ2lDZXJ0IEdsb2JhbCBSb290IEcyMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuzfNNNx7a8myaJCtSnX/RrohCgiN9RlUyfuI
2/Ou8jqJkTx65qsGGmvPrC3oXgkkRLpimn7Wo6h+4FR1IAWsULecYxpsMNzaHxmx
1x7e/dfgy5SDN67sH0NO3Xss0r0upS/kqbitOtSZpLYl6ZtrAGCSYP9PIUkY92eQ
q2EGnI/yuum06ZIya7XzV+hdG82MHauVBJVJ8zUtluNJbd134/tJS7SsVQepj5Wz
tCO7TG1F8PapspUwtP1MVYwnSlcUfIKdzXOS0xZKBgyMUNGPHgm+F6HmIcr9g+UQ
vIOlCsRnKPZzFBQ9RnbDhxSJITRNrw9FDKZJobq7nMWxM4MphQIDAQABo0IwQDAP
BgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIBhjAdBgNVHQ4EFgQUTiJUIBiV
5uNu5g/6+rkS7QYXjzkwDQYJKoZIhvcNAQELBQADggEBAGBnKJRvDkhj6zHd6mcY
1Yl9PMWLSn/pvtsrF9+wX3N3KjITOYFnQoQj8kVnNeyIv/iPsGEMNKSuIEyExtv4
NeF22d+mQrvHRAiGfzZ0JFrabA0UWTW98kndth/Jsw1HKj2ZL7tcu7XUIOGZX1NG
Fdtom/DzMNU+MeKNhJ7jitralj41E6Vf8PlwUHBHQRFXGU7Aj64GxJUTFy8bJZ91
8rGOmaFvE7FBcf6IKshPECBV1/MUReXgRPTqh5Uykw7+U0b6LJ3/iyK5S9kJRaTe
pLiaWN0bfVKfjllDiIGknibVb63dDcY3fe0Dkhvld1927jyNxF1WW6LZZm6zNTfl
MrY=
-----END CERTIFICATE-----
)PEM";

// ---------------- HARDWARE ----------------
const int soilPins[3] = {4, 5, 6};
const int relayPins[3] = {10, 11, 12};

const int SDA_PIN = 18;
const int SCL_PIN = 17;
const uint8_t LM75A_ADDRESS = 0x4E;
const int WATER_LEVEL_PIN = 16;

// Active-LOW relay boards
const int RELAY_ON = LOW;
const int RELAY_OFF = HIGH;

// Soil sensor calibration
const int DRY_RAW = 4095;
const int WET_RAW = 1500;

// ---------------- SAFETY / TIMING ----------------
const unsigned long TELEMETRY_MS = 10000UL;
const unsigned long WIFI_RETRY_MS = 10000UL;
const unsigned long MQTT_RETRY_MS = 5000UL;
const unsigned long SENSOR_CHECK_MS = 1000UL;
const unsigned long MAX_PUMP_RUNTIME_MS = 120000UL;

// ---------------- NETWORK ----------------
WiFiClientSecure secureClient;
PubSubClient mqtt(secureClient);
Preferences preferences;

// ---------------- AUTO CONFIGURATION ----------------
struct PotConfig {
  int startBelowPct;
  int targetPct;
  bool configured;
};

PotConfig profiles[3] = {
  {40, 60, false},
  {40, 60, false},
  {40, 60, false}
};

bool autoEnabled = false;  // Safety default after reboot

unsigned long pulseDurationMs = 10000UL;
unsigned long maximumRuntimeMs = 120000UL;
unsigned long checkIntervalMs = 30000UL;

// ---------------- PUMP STATE ----------------
bool pumpRunning[3] = {false, false, false};
bool pumpIsAutomatic[3] = {false, false, false};

unsigned long pumpStartedAt[3] = {0, 0, 0};
unsigned long pulseStartedAt[3] = {0, 0, 0};
unsigned long lastAutoCheck[3] = {0, 0, 0};

// Total pump-on time in the current automatic watering cycle
unsigned long autoRuntimeMs[3] = {0, 0, 0};

bool autoCycleActive[3] = {false, false, false};

unsigned long lastTelemetry = 0;
unsigned long lastWiFiAttempt = 0;
unsigned long lastMQTTAttempt = 0;
unsigned long lastSensorCheck = 0;

int moisture[3] = {0, 0, 0};
int rawValues[3] = {0, 0, 0};
float temperatureC = NAN;

// ---------------- FORWARD DECLARATIONS ----------------
void pumpOFF(int index);
void saveConfig();
void publishStatus(const char* status);

// =====================================================
// WATER LEVEL
// Assumes LOW = water available.
// Verify this against your physical float switch.
// =====================================================
bool waterAvailable() {
  return digitalRead(WATER_LEVEL_PIN) == LOW;
}

// =====================================================
// EVENTS
// =====================================================
void publishEvent(int index, const char* eventName) {
  if (!mqtt.connected()) return;

  StaticJsonDocument<160> doc;
  doc["deviceId"] = "pot-001";
  doc["event"] = eventName;
  doc["pump"] = index + 1;
  doc["automatic"] = pumpIsAutomatic[index];

  char output[160];
  size_t n = serializeJson(doc, output, sizeof(output));
  mqtt.publish(TOPIC_EVENTS, output, n);
}

// =====================================================
// PUMP CONTROL
// =====================================================
bool pumpON(int index, bool automatic) {
  if (index < 0 || index >= 3) return false;

  if (!waterAvailable()) {
    Serial.printf("Pump %d blocked: tank empty.\n", index + 1);
    return false;
  }

  if (pumpRunning[index]) return true;

  digitalWrite(relayPins[index], RELAY_ON);

  pumpRunning[index] = true;
  pumpIsAutomatic[index] = automatic;
  pumpStartedAt[index] = millis();

  Serial.printf("Pump %d ON (%s)\n",
                index + 1, automatic ? "AUTO" : "MANUAL");

  publishEvent(index, "pump_on");
  return true;
}

void pumpOFF(int index) {
  if (index < 0 || index >= 3) return;

  digitalWrite(relayPins[index], RELAY_OFF);

  bool wasRunning = pumpRunning[index];

  pumpRunning[index] = false;
  pumpIsAutomatic[index] = false;
  pumpStartedAt[index] = 0;

  if (wasRunning) {
    Serial.printf("Pump %d OFF\n", index + 1);
    publishEvent(index, "pump_off");
  }
}

// =====================================================
// STOP AUTOMATION SAFELY
// =====================================================
void disableAuto() {
  autoEnabled = false;

  for (int i = 0; i < 3; i++) {
    if (pumpRunning[i] && pumpIsAutomatic[i]) {
      pumpOFF(i);
    }

    autoCycleActive[i] = false;
    autoRuntimeMs[i] = 0;
  }

  saveConfig();
}

// =====================================================
// TEMPERATURE SENSOR: LM75A
// =====================================================
float readTemperature() {
  Wire.beginTransmission(LM75A_ADDRESS);
  Wire.write(0x00);

  if (Wire.endTransmission(false) != 0) return NAN;
  if (Wire.requestFrom((int)LM75A_ADDRESS, 2) < 2) return NAN;

  uint8_t msb = Wire.read();
  uint8_t lsb = Wire.read();

  int16_t raw = (int16_t)(((uint16_t)msb << 8) | lsb);
  raw >>= 5;

  if (raw & 0x0400) raw |= 0xF800;

  return raw * 0.125f;
}

// =====================================================
// READ SENSORS
// =====================================================
void readSensors() {
  for (int i = 0; i < 3; i++) {
    rawValues[i] = analogRead(soilPins[i]);

    int value = map(rawValues[i], DRY_RAW, WET_RAW, 0, 100);
    moisture[i] = constrain(value, 0, 100);
  }

  temperatureC = readTemperature();
}

// =====================================================
// SAVE / LOAD SETTINGS
// Auto mode ALWAYS starts disabled after reboot.
// Stored profiles and timings are restored.
// =====================================================
void saveConfig() {
  preferences.putBool("auto", autoEnabled);
  preferences.putULong("pulse", pulseDurationMs);
  preferences.putULong("maxrun", maximumRuntimeMs);
  preferences.putULong("interval", checkIntervalMs);

  for (int i = 0; i < 3; i++) {
    char key[16];

    snprintf(key, sizeof(key), "start%d", i);
    preferences.putInt(key, profiles[i].startBelowPct);

    snprintf(key, sizeof(key), "target%d", i);
    preferences.putInt(key, profiles[i].targetPct);

    snprintf(key, sizeof(key), "valid%d", i);
    preferences.putBool(key, profiles[i].configured);
  }
}

void loadConfig() {
  pulseDurationMs = preferences.getULong("pulse", 10000UL);
  maximumRuntimeMs = preferences.getULong("maxrun", 120000UL);
  checkIntervalMs = preferences.getULong("interval", 30000UL);

  for (int i = 0; i < 3; i++) {
    char key[16];

    snprintf(key, sizeof(key), "start%d", i);
    profiles[i].startBelowPct = preferences.getInt(key, 40);

    snprintf(key, sizeof(key), "target%d", i);
    profiles[i].targetPct = preferences.getInt(key, 60);

    snprintf(key, sizeof(key), "valid%d", i);
    profiles[i].configured = preferences.getBool(key, false);
  }

  // Deliberate safety policy: require Auto to be enabled again
  // after a restart. Do not restore an active watering cycle.
  autoEnabled = false;
}

// =====================================================
// PROCESS MQTT COMMANDS
//
// Manual ON: {"pump":1,"action":"on"}
// Manual OFF: {"pump":1,"action":"off"}
// Stop all: {"action":"stop_all"}
// Disable auto: {"type":"config","autoWaterEnabled":false}
//
// Configuration example:
// {
//   "type":"config",
//   "autoWaterEnabled":true,
//   "pulseDurationSeconds":10,
//   "maximumRuntimeSeconds":120,
//   "profiles":{
//     "pot-1":{"startBelowPct":40,"targetPct":60},
//     "pot-2":{"startBelowPct":45,"targetPct":65},
//     "pot-3":{"startBelowPct":35,"targetPct":55}
//   }
// }
// =====================================================
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  if (strcmp(topic, TOPIC_COMMANDS) != 0) return;
  if (length == 0 || length >= 768) return;

  StaticJsonDocument<768> doc;

  DeserializationError error = deserializeJson(doc, payload, length);
  if (error) {
    Serial.println("Rejected invalid JSON command.");
    return;
  }

  const char* type = doc["type"] | "";
  const char* action = doc["action"] | "";

  // -------- Configuration command --------
  if (strcmp(type, "config") == 0) {
    bool requestedAuto = doc["autoWaterEnabled"] | false;

    unsigned long pulseSec =
      doc["pulseDurationSeconds"] | 10UL;
    unsigned long maxSec =
      doc["maximumRuntimeSeconds"] | 120UL;
    unsigned long intervalSec =
      doc["checkIntervalSeconds"] | 30UL;

    // Validate safety limits before accepting configuration.
    if (pulseSec < 1 || pulseSec > 120 ||
        maxSec < 1 || maxSec > 120 ||
        intervalSec < 5 || intervalSec > 3600) {
      Serial.println("Rejected invalid timing settings.");
      return;
    }

    PotConfig newProfiles[3];
    bool profileReceived[3] = {false, false, false};
    bool validProfiles = true;
    JsonVariant profileData = doc["profiles"];

    for (int i = 0; i < 3; i++) newProfiles[i] = profiles[i];

    // The mobile backend sends an object keyed by pot ID. Also accept the
    // array format used by earlier firmware/backend versions.
    if (profileData.is<JsonObject>()) {
      JsonObject profileObject = profileData.as<JsonObject>();
      for (int i = 0; i < 3; i++) {
        char potKey[8];
        snprintf(potKey, sizeof(potKey), "pot-%d", i + 1);
        JsonObject p = profileObject[potKey].as<JsonObject>();
        if (p.isNull()) continue;

        int start = p["startBelowPct"] | -1;
        int target = p["targetPct"] | -1;
        if (start >= 0 && start <= 100 && target >= 0 && target <= 100 && start < target) {
          newProfiles[i] = {start, target, true};
          profileReceived[i] = true;
        } else if (requestedAuto) {
          validProfiles = false;
        }
      }
    } else if (profileData.is<JsonArray>()) {
      JsonArray profileArray = profileData.as<JsonArray>();
      for (JsonObject p : profileArray) {
        int pot = p["pot"] | 0;
        int start = p["startBelowPct"] | -1;
        int target = p["targetPct"] | -1;
        if (pot < 1 || pot > 3) {
          if (requestedAuto) validProfiles = false;
          continue;
        }

        int index = pot - 1;
        if (start >= 0 && start <= 100 && target >= 0 && target <= 100 && start < target) {
          newProfiles[index] = {start, target, true};
          profileReceived[index] = true;
        } else if (requestedAuto) {
          validProfiles = false;
        }
      }
    } else if (requestedAuto) {
      validProfiles = false;
    }

    if (requestedAuto) {
      for (int i = 0; i < 3; i++) {
        if (!profileReceived[i] || !newProfiles[i].configured) validProfiles = false;
      }
    }

    if (!validProfiles) {
      Serial.println("Rejected configuration: invalid profiles.");
      return;
    }

    // Turn off automatic pumps if automation is being disabled.
    if (!requestedAuto) {
      for (int i = 0; i < 3; i++) {
        if (pumpRunning[i] && pumpIsAutomatic[i]) pumpOFF(i);
        autoCycleActive[i] = false;
        autoRuntimeMs[i] = 0;
      }
    }

    for (int i = 0; i < 3; i++) profiles[i] = newProfiles[i];

    pulseDurationMs = pulseSec * 1000UL;
    maximumRuntimeMs = maxSec * 1000UL;
    checkIntervalMs = intervalSec * 1000UL;

    autoEnabled = requestedAuto;
    saveConfig();

    Serial.printf("Auto watering: %s\n",
                  autoEnabled ? "ENABLED" : "DISABLED");
    publishStatus(autoEnabled ? "auto_enabled" : "auto_disabled");
    return;
  }

  // -------- Manual / emergency commands --------
  if (strcmp(action, "stop_all") == 0) {
    for (int i = 0; i < 3; i++) pumpOFF(i);
    return;
  }

  int pumpNumber = doc["pump"] | 0;
  if (pumpNumber < 1 || pumpNumber > 3) return;

  int index = pumpNumber - 1;

  if (strcmp(action, "off") == 0 || strcmp(action, "stop") == 0) {
    pumpOFF(index);
    return;
  }

  if (strcmp(action, "on") == 0 || strcmp(action, "water") == 0) {
    // Manual watering overrides an automatic pulse on this pot.
    if (pumpRunning[index] && pumpIsAutomatic[index]) pumpOFF(index);

    autoCycleActive[index] = false;
    autoRuntimeMs[index] = 0;

    if (waterAvailable()) {
      pumpON(index, false);
    }
    return;
  }

  Serial.println("Unknown command action.");
}

// =====================================================
// MQTT STATUS
// =====================================================
void publishStatus(const char* status) {
  if (!mqtt.connected()) return;

  StaticJsonDocument<192> doc;
  doc["deviceId"] = "pot-001";
  doc["status"] = status;
  doc["online"] = true;
  doc["waterAvailable"] = waterAvailable();
  doc["autoWaterEnabled"] = autoEnabled;

  char output[192];
  size_t n = serializeJson(doc, output, sizeof(output));
  mqtt.publish(
  TOPIC_STATUS,
  (const uint8_t*)output,
  (unsigned int)n,
  true
);
}

// =====================================================
// MQTT TELEMETRY
// =====================================================
void publishTelemetry() {
  if (!mqtt.connected()) return;

  StaticJsonDocument<512> doc;
  doc["deviceId"] = "pot-001";
  if (isnan(temperatureC)) {
  doc["temperature"] = nullptr;
} else {
  doc["temperature"] = temperatureC;
}
  doc["waterAvailable"] = waterAvailable();
  doc["autoWaterEnabled"] = autoEnabled;

  JsonArray pots = doc.createNestedArray("pots");

  for (int i = 0; i < 3; i++) {
    JsonObject p = pots.createNestedObject();
    p["pot"] = i + 1;
    p["soilMoisture"] = moisture[i];
    p["soilRaw"] = rawValues[i];
    p["pumpRunning"] = pumpRunning[i];
    p["automatic"] = pumpIsAutomatic[i];
  }

  char output[512];
  size_t n = serializeJson(doc, output, sizeof(output));
  mqtt.publish(TOPIC_TELEMETRY, output, n);
}

// =====================================================
// AUTONOMOUS WATERING
// A pulse runs for the configured duration.
// Recheck after the configured interval.
// Stop the cycle at the target or runtime limit.
// =====================================================
void automaticWatering() {
  unsigned long now = millis();

  if (!autoEnabled) return;

  if (!waterAvailable()) {
    for (int i = 0; i < 3; i++) {
      if (pumpRunning[i]) pumpOFF(i);
      autoCycleActive[i] = false;
      autoRuntimeMs[i] = 0;
    }
    return;
  }

  for (int i = 0; i < 3; i++) {
    if (!profiles[i].configured) continue;

    // Manage an active automatic pulse.
    if (pumpRunning[i] && pumpIsAutomatic[i]) {
      unsigned long elapsed = now - pulseStartedAt[i];

      if (elapsed >= pulseDurationMs) {
        autoRuntimeMs[i] += elapsed;
        pumpOFF(i);
        lastAutoCheck[i] = now;
      }
      continue;
    }

    // Target reached: finish this watering cycle.
    if (autoCycleActive[i] &&
        moisture[i] >= profiles[i].targetPct) {
      autoCycleActive[i] = false;
      autoRuntimeMs[i] = 0;
      lastAutoCheck[i] = now;
      publishEvent(i, "target_reached");
      continue;
    }

    // Maximum accumulated pump-on time reached.
    if (autoCycleActive[i] &&
        autoRuntimeMs[i] >= maximumRuntimeMs) {
      autoCycleActive[i] = false;
      autoRuntimeMs[i] = 0;
      lastAutoCheck[i] = now;
      publishEvent(i, "auto_runtime_limit");
      continue;
    }

    // Begin a new watering cycle only below the start threshold.
    if (!autoCycleActive[i]) {
      if (moisture[i] >= profiles[i].startBelowPct) continue;

      autoCycleActive[i] = true;
      autoRuntimeMs[i] = 0;
      lastAutoCheck[i] = 0;
    }

    if (now - lastAutoCheck[i] < checkIntervalMs) continue;

    // Limit this pulse to the remaining allowed runtime.
    unsigned long remaining = maximumRuntimeMs - autoRuntimeMs[i];
    unsigned long thisPulse = min(pulseDurationMs, remaining);

    if (thisPulse == 0) {
      autoCycleActive[i] = false;
      continue;
    }

    if (pumpON(i, true)) {
      pulseDurationMs = pulseDurationMs; // no-op; preserve configured pulse
      // Track actual start time for pulse timing.
      pulseStartedAt[i] = millis();

      // The configured pulse duration is capped by remaining runtime
      // in the independent safety check below.
      lastAutoCheck[i] = now;
    }
  }
}

// =====================================================
// SETUP
// =====================================================
void setup() {
  Serial.begin(115200);
  delay(500);

  // Set output latch to OFF before configuring outputs.
  for (int i = 0; i < 3; i++) {
    digitalWrite(relayPins[i], RELAY_OFF);
    pinMode(relayPins[i], OUTPUT);
    digitalWrite(relayPins[i], RELAY_OFF);
    pumpRunning[i] = false;
  }

  pinMode(WATER_LEVEL_PIN, INPUT_PULLUP);

  Wire.begin(SDA_PIN, SCL_PIN);
  analogReadResolution(12);

  preferences.begin("potbuddy", false);
  loadConfig();

  secureClient.setCACert(ROOT_CA);
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(mqttCallback);
  mqtt.setBufferSize(768);
  mqtt.setKeepAlive(30);

  Serial.println("\nPotBuddy ESP32 starting...");
  Serial.println("Pumps default OFF.");
  Serial.println("Automatic watering defaults OFF.");

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  configTime(0, 0, "pool.ntp.org", "time.google.com");
}

// =====================================================
// MAIN LOOP
// =====================================================
void loop() {
  unsigned long now = millis();

  if (WiFi.status() != WL_CONNECTED) {
    // Do not start new manual watering while disconnected.
    if (now - lastWiFiAttempt >= WIFI_RETRY_MS) {
      lastWiFiAttempt = now;
      WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    }
  } else if (!mqtt.connected()) {
    if (now - lastMQTTAttempt >= MQTT_RETRY_MS) {
      lastMQTTAttempt = now;
      if (mqtt.connect(MQTT_CLIENT_ID, MQTT_USERNAME, MQTT_PASSWORD)) {
        mqtt.subscribe(TOPIC_COMMANDS, 1);
        publishStatus("online");
        Serial.println("MQTT connected.");
      }
    }
  }

  if (mqtt.connected()) mqtt.loop();

  // Read sensors on a regular schedule.
  if (now - lastSensorCheck >= SENSOR_CHECK_MS) {
    lastSensorCheck = now;
    readSensors();
  }

  // Reservoir safety always takes priority.
  if (!waterAvailable()) {
    for (int i = 0; i < 3; i++) {
      if (pumpRunning[i]) pumpOFF(i);
    }
  }

  // Independent maximum ON-time safety limit.
  for (int i = 0; i < 3; i++) {
    if (pumpRunning[i] &&
        now - pumpStartedAt[i] >= MAX_PUMP_RUNTIME_MS) {
      Serial.printf("SAFETY TIMEOUT: pump %d\n", i + 1);
      pumpOFF(i);
      autoCycleActive[i] = false;
      autoRuntimeMs[i] = 0;
    }

    // Cap each automatic pulse to the remaining cycle runtime.
    if (pumpRunning[i] && pumpIsAutomatic[i] &&
        now - pulseStartedAt[i] >= pulseDurationMs) {
      unsigned long elapsed = now - pulseStartedAt[i];
      autoRuntimeMs[i] += elapsed;
      pumpOFF(i);
      lastAutoCheck[i] = now;
    }
  }

  automaticWatering();

  if (now - lastTelemetry >= TELEMETRY_MS) {
    lastTelemetry = now;
    if (mqtt.connected()) {
      publishTelemetry();
    }

    Serial.printf("Water: %s | Auto: %s\n",
      waterAvailable() ? "AVAILABLE" : "EMPTY",
      autoEnabled ? "ON" : "OFF");

    for (int i = 0; i < 3; i++) {
      Serial.printf("Pot %d: %d%% (raw %d), pump %s\n",
        i + 1, moisture[i], rawValues[i],
        pumpRunning[i] ? "ON" : "OFF");
    }
  }

  delay(10);
}
