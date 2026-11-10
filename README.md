# Homebridge UniFi Protect Motion Trigger

A lightweight Homebridge plugin that exposes UniFi Protect camera motion sensors and settings as HomeKit accessories, **without video streaming**.

This plugin is designed to work alongside [Scrypted](https://github.com/koush/scrypted) or other video streaming solutions. It provides motion detection and camera controls while letting your preferred streaming solution handle the video.

## Features

Each camera is exposed as a HomeKit accessory with:

- **Motion Sensor** - Triggers HomeKit automations when the camera detects motion
- **Motion Enabled Switch** - Turns UniFi Protect **Create Motion Events** on or off. Shields down also turns off smart detection for that camera. Shields up restores that camera's own saved zones and detection types. Recording mode is left alone, so continuous recording is unchanged.
- **Status LED Switch** - Control the camera's indicator LED on/off

## Installation

### Via Homebridge UI

Search for `homebridge-unifi-protect-motion-trigger` in the Homebridge UI plugins tab.

### Via npm

```bash
npm install -g homebridge-unifi-protect-motion-trigger
```

## Configuration

Add the platform to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "UniFi Protect Motion Trigger",
      "controllers": [
        {
          "address": "192.168.1.1",
          "username": "homebridge",
          "password": "your-password"
        }
      ],
      "motionDuration": 10,
      "debug": false
    }
  ]
}
```

### Configuration Options

| Option                   | Required | Default | Description                                                |
| ------------------------ | -------- | ------- | ---------------------------------------------------------- |
| `platform`               | Yes      | -       | Must be `"UniFi Protect Motion Trigger"`                   |
| `controllers`            | Yes      | -       | Array of UniFi Protect controllers                         |
| `controllers[].address`  | Yes      | -       | IP address or hostname of your UniFi Protect controller    |
| `controllers[].username` | Yes      | -       | Local user account username                                |
| `controllers[].password` | Yes      | -       | Local user account password                                |
| `motionDuration`         | No       | `10`    | Seconds before motion sensor resets after detecting motion |
| `debug`                  | No       | `false` | Enable debug logging                                       |

## UniFi Protect User Setup

For security, create a dedicated local user for Homebridge:

1. Log into your UniFi Protect web interface
2. Go to **OS Settings** > **Admins**
3. Click **Add Admin**
4. Select **Restrict to local access only**
5. Create a username and password
6. Assign the **Full Management** role for LED control, or **View Only** for motion events only

## How It Works

- **Motion Detection**: The plugin connects to UniFi Protect's real-time WebSocket API. When a camera detects motion, the motion sensor triggers in HomeKit, allowing you to build automations.

- **Motion Enabled Switch**: This changes the camera's `recordingSettings.enableMotionDetection` flag (Create Motion Events in the Protect UI) through the private Protect API used by `unifi-protect`. It does **not** write `motionSettings.isEnabled`. That field belongs to Protect sensors; on current cameras it is null, and a PATCH that sets it can return success without changing Create Motion Events. Recording mode (`always`, `detections`, or `never`) is not modified.

  Current Protect cameras have no smart-detection enable flag. Detection is on when `smartDetectSettings` lists object, audio, or auto-tracking types, or when `smartDetectZones[]` (and `secondLensSmartDetectZones[]` on dual-lens cameras) has a non-empty `objectTypes` list. Shields down reads each camera, saves that camera's settings lists and zone objects, then writes the same zones back with `objectTypes` cleared. Names, points, sensitivity, color, and ids are copied from the camera. They are not replaced with defaults. Shields up writes that saved snapshot back. A camera whose zone sensitivity is 75 is restored at 75 even when another camera's zone is 50.

  The snapshot is written to `{Homebridge storage}/.unifi-protect-motion-trigger-smart-detect.json` before the disable PATCH. A restart while shields are down reloads that file. A camera that is already disabled does not replace a saved snapshot. If one camera's smart-detection write fails, that camera's Create Motion Events change is still attempted and the other cameras are still updated.

  The plugin reads the camera back with `GET /proxy/protect/api/cameras/{id}` after the PATCH. It tries immediately, then after 250ms, then after 500ms. Success is logged only when that read shows the requested Create Motion Events value and, when smart detection was part of the write, the requested settings lists and zones. A PATCH body that echoes the new value is not enough. If the motion flag never agrees, HomeKit reverts the switch. If the flag matches but smart detection does not, HomeKit follows the confirmed Create Motion Events value, an error is logged, and health reports smart-detection drift.

- **Status LED Switch**: This directly controls the camera's indicator LED via the UniFi Protect API, and that change is also confirmed by reading the camera back.

## Use Cases

- Trigger HomeKit automations when motion is detected (lights, notifications, etc.)
- Disable motion notifications at night without affecting UniFi Protect recordings
- Control camera status LEDs from HomeKit/Siri
- Use alongside Scrypted for video streaming with separate motion control

## Troubleshooting

### No cameras discovered

- Verify your controller address is correct
- Ensure the user has access to view cameras
- Check Homebridge logs for connection errors

### Motion events not triggering

- Ensure the Motion Enabled switch is ON
- Check that Create Motion Events is enabled in UniFi Protect
- Verify WebSocket connection in debug logs

### Switch says it changed but Protect did not

- A controller can accept a PATCH and leave `recordingSettings.enableMotionDetection` unchanged. This plugin treats that as a failure after readback and reverts the HomeKit switch.
- Health `readback.status` of `mismatch` or `drift: true` means the last camera read does not match the switch. `stale` means that read is older than five minutes. `unknown` means the flag has not been read. `error` means the last read failed. Do not treat those as a successful shields change.

## Health

`ProtectMotionPlatform.getHealth({ refresh: true })` returns schema `1.2.0`. `refresh` only GETs cameras; it does not change them. The document contains controller addresses and camera ids and names. It does not contain usernames, passwords, or tokens. Releases through 1.0.9 had no health payload. 1.1.0 added readback. 1.2.0 adds smart-detection expected, actual, and drift. Older fields stay in place.

The same snapshot is also written to `{Homebridge storage}/.unifi-protect-motion-trigger-health.json` (typically `~/.homebridge/.unifi-protect-motion-trigger-health.json`) so an external monitor can read it without the Homebridge UI API. The file is rewritten after a successful login/bootstrap, on connect/disconnect/reconnect, when the camera set or camera settings change, after a settings readback, and every 60 seconds. Writes use a temp file plus rename. The timer is cleared on shutdown.

home-monitor reads `updatedAtEpoch` (falling back to the file mtime) and treats a snapshot older than 300 seconds as critically stale. It also requires every `controllers[].connected` value to be true, and it sums `controllers[].cameras`, so that field remains a camera **count**. Per-camera details, including `readback`, `drift`, and smart detection, are under `controllers[].cameraHealth`.

| Field                                                        | Meaning                                                                                                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                              | `1.2.0`                                                                                                                                             |
| `pluginVersion`                                              | Plugin version that produced the document                                                                                                           |
| `generatedAt`                                                | ISO time the document was built                                                                                                                     |
| `updatedAt` / `updatedAtEpoch`                               | ISO time and UTC epoch seconds written into the on-disk file so home-monitor can measure freshness without parsing a date string                    |
| `controllers[].cameras`                                      | Camera **count** in the on-disk file (home-monitor sums this field). `getHealth()` still returns the per-camera array                               |
| `controllers[].cameraHealth`                                 | On-disk per-camera objects (`readback`, `drift`, smart detection, and the other camera fields below)                                                |
| `controllers[].reconnecting` / `consecutiveFailures`         | Connection watchdog fields preserved for the on-disk file                                                                                           |
| `controllers[].lastEventAt` / `lastBootstrapAt`              | ISO times of the last websocket event and last successful bootstrap, or `null`                                                                      |
| `readbackStaleAfterMs`                                       | Age after which a successful read is `stale` (five minutes)                                                                                         |
| `controllers[].address`                                      | Controller host from config                                                                                                                         |
| `controllers[].connected`                                    | Login and bootstrap succeeded                                                                                                                       |
| `controllers[].throttled`                                    | Protect API is pausing calls                                                                                                                        |
| `controllers[].admin`                                        | Account can change devices, or `null` when disconnected                                                                                             |
| `controllers[].lastError`                                    | `authentication failed`, `connection failed`, or `null`                                                                                             |
| `controllers[].cameras[].intendedMotionEnabled`              | HomeKit Motion Enabled switch                                                                                                                       |
| `controllers[].cameras[].createMotionEvents`                 | Last read of `recordingSettings.enableMotionDetection`, or `null`                                                                                   |
| `controllers[].cameras[].smartDetectObjectTypes`             | Last read of smart-detection object types, or `null`                                                                                                |
| `controllers[].cameras[].smartDetectAudioTypes`              | Last read of smart-detection audio types, or `null`                                                                                                 |
| `controllers[].cameras[].smartDetectAutoTrackingObjectTypes` | Last read of auto-tracking types, or `null`                                                                                                         |
| `controllers[].cameras[].motionSettingsKnown`                | Whether the camera record had a `motionSettings` key                                                                                                |
| `controllers[].cameras[].motionSettings`                     | Sensor-shaped value when present; `null` when the key is null or absent                                                                             |
| `controllers[].cameras[].smartDetectPreferencesSaved`        | True when an active smart-detection snapshot is saved for restore                                                                                   |
| `controllers[].cameras[].smartDetectExpected`                | Settings lists and zones the switch should have produced (`objectTypes`, and each zone's `name`, `sensitivity`, `objectTypes`, `points`), or `null` |
| `controllers[].cameras[].smartDetectActual`                  | Those same fields from the last successful camera read, or `null`                                                                                   |
| `controllers[].cameras[].smartDetectDrift`                   | `true` when expected and actual smart detection disagree. `null` when either side is unknown                                                        |
| `controllers[].cameras[].drift`                              | `true` when the switch and last read disagree, including smart detection. `null` when the motion flag is unknown                                    |
| `controllers[].cameras[].readback.status`                    | `verified`, `mismatch`, `unknown`, `stale`, or `error`                                                                                              |
| `controllers[].cameras[].readback.fetchedAt`                 | ISO time of the last successful read, or `null`                                                                                                     |
| `controllers[].cameras[].readback.error`                     | Fixed read error, or `null`                                                                                                                         |
| `controllers[].cameras[].readback.attempts`                  | Reads used for the last check, or `null`                                                                                                            |

`verified` means the latest read is fresh and does not disagree with the switch. It does not by itself mean a write was attempted. Trust `drift` only when `readback.status` is `verified` or `mismatch`. A websocket update can move the HomeKit switch before the next GET; call `getHealth({ refresh: true })` before treating the document as current.

### Checking smart detection on a Protect console

After shields go down, each managed camera's Protect settings should show smart detection with no object types selected. Zone shapes and sensitivity stay as they were. After shields go up, each camera should show its previous object types and the same zones (a driveway zone at sensitivity 75 stays 75; a yard zone at 50 stays 50). The Homebridge log line `smart detection disabled` or `smart detection restored` is written only after the camera GET agrees. In the health file, `controllers[].cameraHealth[].smartDetectDrift` is false and `readback.status` is `verified` when the read matches. `smartDetectExpected` and `smartDetectActual` show the object types and zone name, sensitivity, and points.

`smartDetectLines` and loiter zones are not changed. Protect has no separate smart-detection enable switch to flip instead.

### LED control not working

- The user account needs Full Management permissions
- Some camera models may not support LED control

## License

MIT

## Credits

This plugin uses the [unifi-protect](https://github.com/hjdhjd/unifi-protect) library by hjdhjd for UniFi Protect API communication. Camera Create Motion Events follows that library's camera type and the `recordingSettings.enableMotionDetection` field written by [uiprotect](https://github.com/uilibs/uiprotect) `Camera.set_motion_detection`. `motionSettings.isEnabled` in the same library is the sensor type.
