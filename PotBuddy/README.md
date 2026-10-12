# PotBuddy mobile

PotBuddy is an Expo iOS/Android app written in TypeScript/TSX, with a TypeScript Node.js service. The mobile app does not connect to EMQX directly: the backend bridges MQTT telemetry and watering commands to Firebase Realtime Database and exposes an authenticated REST API.

## Configure Firebase and EMQX

1. Set the Expo Firebase web configuration and backend settings in `.env`. During development, PotBuddy derives the API host from Expo's LAN host and uses `API_PORT`; for a standalone build, set `EXPO_PUBLIC_API_URL` to a reachable API address. An explicit `EXPO_PUBLIC_DEVICE_ID` can pin a device; otherwise the app discovers devices authorized for the signed-in Firebase account.
2. In Firebase Authentication, enable **Anonymous** sign-in. The app signs in anonymously and sends its Firebase ID token to the API.
3. Create a Firebase Admin service account for the same Firebase project. Store its JSON outside source control, set `GOOGLE_APPLICATION_CREDENTIALS` to its path, and set `FIREBASE_DATABASE_URL`.
4. Apply `database.rules.json` to Realtime Database. The mobile client does not read the database directly; the Admin SDK on the backend performs database operations.
5. Set the EMQX Cloud TLS URL (`mqtts://...:8883`) and broker username/password in `.env`. Keep these server-only values private. Permit the backend MQTT identity to subscribe to `potbuddy/+/telemetry` and `potbuddy/+/status`, and publish to `potbuddy/+/commands`.
6. Sign in and get the anonymous Firebase user's UID from Firebase Authentication. In the Firebase console, add `/devices/{deviceId}/authorizedUsers/{uid}` with boolean value `true`. The app discovers authorized device IDs through the API; until allowlisted, it cannot read data or send commands.

## Sensor contract

The backend subscribes to `potbuddy/{deviceId}/telemetry` and accepts JSON with one or more of these fields:

- Soil moisture: `moisturePct`, `moisture`, `soilMoisture`, or `soil_moisture` (0–100)
- Temperature in Celsius: `temperatureC`, `temperature`, `tempC`, or `temp_c`
- Relative humidity: `humidityPct`, `humidity`, or `relativeHumidity` (0–100)
- Optional device timestamp: `timestamp` or `ts` (milliseconds since epoch)

The device publishes status to `potbuddy/{deviceId}/status` as `online`/`offline` or JSON such as `{"online":true}`. Configure the ESP32's MQTT Last Will to publish `offline` to its status topic. Telemetry also refreshes the online heartbeat. Devices are treated as offline when the last heartbeat is older than `DEVICE_OFFLINE_AFTER_MS`.

The backend writes the latest sample to `/devices/{deviceId}/latest`, history to `/devices/{deviceId}/readings/{pushId}`, and connection state to `/devices/{deviceId}/status`. It retains readings in Realtime Database; the API returns the most recent 40 by default.

## Multi-pot and actuator telemetry

For multiple monitored pots, publish an array of observed sensors. IDs are device-provided and are used to target commands; the app does not create a fixed set of pots:

```json
{
  "pots": [
    { "potId": "pot-1", "moisturePct": 42, "pumpState": "stopped" },
    { "potId": "pot-2", "moisturePct": 26, "pumpState": "running" }
  ],
  "temperatureC": 24.6,
  "humidityPct": 53,
  "reservoirAvailable": true,
  "reservoirLevelPct": 75
}
```

`pots` may also be an object keyed by pot ID. `pumpState` is optional and must be `running` or `stopped`; without it the app displays pump state as unknown. Reservoir state is optional: `reservoirAvailable` is a boolean and `reservoirLevelPct` is a number from 0 to 100. The home card shows the percentage when provided and falls back to available/empty when only the boolean is reported. The backend also accepts `waterLevelPct`, `reservoirLevel`, or `waterLevel` as aliases for the percentage. When the backend receives `reservoirAvailable: false`, watering commands are blocked until a later report says water is available. The ESP32 should still enforce the timed pump cutoff locally.

Water commands include `action: "water"`, a `potId`, and `durationSeconds`. Stop commands include `action: "stop"` and a `potId`. The controller must subscribe to the commands topic and honor those actions. Automatic watering is an app-side threshold check and runs only while the app is active; it sends a single timed pulse after a sensor reports below its configured threshold, then rearms after the configured target is reached.

A watering request publishes JSON like `{"commandId":"...","action":"water","potId":"pot-2","durationSeconds":5,"issuedAt":...}` to `potbuddy/{deviceId}/commands`. A stop request uses `action: "stop"` and the target `potId`. The API returns `202` when the MQTT broker accepts the publish; this does not confirm physical pump operation. The controller should publish pump state in telemetry. The app disables watering when the controller is offline, the broker is disconnected, or the reservoir is reported empty. It caps each pulse at the configured maximum runtime; the ESP32 must also enforce its own timed cutoff.

Plant profiles, watering thresholds, app-side automatic watering, alert preferences, command request history, and chart data are based on observed telemetry or saved on the user's device. The app contains no simulated plant or sensor readings. Automatic watering runs only while the app is active and requires pulse duration, maximum runtime, and valid thresholds for all observed pots.

## REST API

Both routes require `Authorization: Bearer <Firebase ID token>`:

- `GET /api/devices/{deviceId}/readings?limit=40` — latest sample, recent history and online state.
- `POST /api/devices/{deviceId}/commands` — water body `{ "action": "water", "potId": "pot-1", "durationSeconds": 5 }` or stop body `{ "action": "stop", "potId": "pot-1" }`. Water duration is limited to 1–120 seconds.
- `GET /health` — backend health and MQTT connection state.

The API validates device IDs using the `pot-` prefix and validates sensor ranges before storing data. Never expose the Firebase Admin service account or EMQX credentials in the Expo app.

## Run

Install dependencies with `npm install`, then run the API using `npm run api`. In a second terminal run `npm start` and open the project in Expo Go or a development build. Restart Expo after changing `.env` values. `npm run typecheck` checks the TypeScript app and backend.

For Android emulator API access, set `EXPO_PUBLIC_API_URL` to `http://10.0.2.2:4000`. For a physical device, use the development computer's reachable LAN address and allow inbound access to the API port.

