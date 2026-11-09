# Homebridge UniFi Protect Motion Trigger

A lightweight Homebridge plugin that exposes UniFi Protect camera motion sensors and settings as HomeKit accessories, **without video streaming**.

This plugin is designed to work alongside [Scrypted](https://github.com/koush/scrypted) or other video streaming solutions. It provides motion detection and camera controls while letting your preferred streaming solution handle the video.

## Features

Each camera is exposed as a HomeKit accessory with:

- **Motion Sensor** - Triggers HomeKit automations when the camera detects motion
- **Motion Enabled Switch** - Turns UniFi Protect **Create Motion Events** on or off. While off, configured smart-detection types are cleared and remembered, then restored when the switch is turned on. Recording mode is left alone, so continuous recording is unchanged.
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

- **Motion Enabled Switch**: This changes the camera's `recordingSettings.enableMotionDetection` flag (Create Motion Events in the Protect UI) through the private Protect API used by `unifi-protect`. It does **not** write `motionSettings.isEnabled`. That field belongs to Protect sensors; on current cameras it is null, and a PATCH that sets it can return success without changing Create Motion Events. Smart detection has no separate enable flag. Turning the switch off clears non-empty `smartDetectSettings` object, audio, and auto-tracking type lists after saving them, and turning it on writes those saved lists back only where the live list is still empty. A type you set in Protect while the switch is off is kept. Recording mode (`always`, `detections`, or `never`) is not modified.

  The plugin reads the camera back with `GET /proxy/protect/api/cameras/{id}` after the PATCH. It tries immediately, then after 250ms, then after 500ms. Success is logged only when that read shows the requested Create Motion Events value. A PATCH body that echoes the new value is not enough. If that flag never agrees, HomeKit reverts the switch. If the flag matches but the smart-detection lists do not, HomeKit follows the confirmed Create Motion Events value, an error is logged, and health reports drift while the switch is off and a detection type is still set.

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

`ProtectMotionPlatform.getHealth({ refresh: true })` returns schema `1.1.0`. `refresh` only GETs cameras; it does not change them. The document contains controller addresses and camera ids and names. It does not contain usernames, passwords, or tokens. Releases through 1.0.9 had no health payload, so every field below is additive.

The same snapshot is also written to `{Homebridge storage}/.unifi-protect-motion-trigger-health.json` (typically `~/.homebridge/.unifi-protect-motion-trigger-health.json`) so an external monitor can read it without the Homebridge UI API. The file is rewritten after a successful login/bootstrap, on connect/disconnect/reconnect, when the camera set or camera settings change, after a settings readback, and every 60 seconds. Writes use a temp file plus rename. The timer is cleared on shutdown.

home-monitor reads `updatedAtEpoch` (falling back to the file mtime) and treats a snapshot older than 300 seconds as critically stale. It also requires every `controllers[].connected` value to be true, and it sums `controllers[].cameras`, so that field remains a camera **count**. Per-camera schema 1.1.0 details, including `readback` and `drift`, are under `controllers[].cameraHealth`.

| Field                                                        | Meaning                                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                                              | `1.1.0`                                                                                                                                                       |
| `pluginVersion`                                              | Plugin version that produced the document                                                                                                                     |
| `generatedAt`                                                | ISO time the document was built                                                                                                                               |
| `updatedAt` / `updatedAtEpoch`                               | ISO time and UTC epoch seconds written into the on-disk file so home-monitor can measure freshness without parsing a date string                              |
| `controllers[].cameras`                                      | Camera **count** in the on-disk file (home-monitor sums this field). `getHealth()` still returns the per-camera array                                         |
| `controllers[].cameraHealth`                                 | On-disk per-camera schema 1.1.0 objects (`readback`, `drift`, and the other camera fields below)                                                              |
| `controllers[].reconnecting` / `consecutiveFailures`         | Connection watchdog fields preserved for the on-disk file                                                                                                     |
| `controllers[].lastEventAt` / `lastBootstrapAt`              | ISO times of the last websocket event and last successful bootstrap, or `null`                                                                                |
| `readbackStaleAfterMs`                                       | Age after which a successful read is `stale` (five minutes)                                                                                                   |
| `controllers[].address`                                      | Controller host from config                                                                                                                                   |
| `controllers[].connected`                                    | Login and bootstrap succeeded                                                                                                                                 |
| `controllers[].throttled`                                    | Protect API is pausing calls                                                                                                                                  |
| `controllers[].admin`                                        | Account can change devices, or `null` when disconnected                                                                                                       |
| `controllers[].lastError`                                    | `authentication failed`, `connection failed`, or `null`                                                                                                       |
| `controllers[].cameras[].intendedMotionEnabled`              | HomeKit Motion Enabled switch                                                                                                                                 |
| `controllers[].cameras[].createMotionEvents`                 | Last read of `recordingSettings.enableMotionDetection`, or `null`                                                                                             |
| `controllers[].cameras[].smartDetectObjectTypes`             | Last read of smart-detection object types, or `null`                                                                                                          |
| `controllers[].cameras[].smartDetectAudioTypes`              | Last read of smart-detection audio types, or `null`                                                                                                           |
| `controllers[].cameras[].smartDetectAutoTrackingObjectTypes` | Last read of auto-tracking types, or `null`                                                                                                                   |
| `controllers[].cameras[].motionSettingsKnown`                | Whether the camera record had a `motionSettings` key                                                                                                          |
| `controllers[].cameras[].motionSettings`                     | Sensor-shaped value when present; `null` when the key is null or absent                                                                                       |
| `controllers[].cameras[].smartDetectPreferencesSaved`        | True when a non-empty type list is saved for re-enable                                                                                                        |
| `controllers[].cameras[].drift`                              | `true` when the switch and last read disagree, including smart-detection types that are still set while the switch is off. `null` when either side is unknown |
| `controllers[].cameras[].readback.status`                    | `verified`, `mismatch`, `unknown`, `stale`, or `error`                                                                                                        |
| `controllers[].cameras[].readback.fetchedAt`                 | ISO time of the last successful read, or `null`                                                                                                               |
| `controllers[].cameras[].readback.error`                     | Fixed read error, or `null`                                                                                                                                   |
| `controllers[].cameras[].readback.attempts`                  | Reads used for the last check, or `null`                                                                                                                      |

`verified` means the latest read is fresh and does not disagree with the switch. It does not by itself mean a write was attempted. Trust `drift` only when `readback.status` is `verified` or `mismatch`. A websocket update can move the HomeKit switch before the next GET; call `getHealth({ refresh: true })` before treating the document as current.

### LED control not working

- The user account needs Full Management permissions
- Some camera models may not support LED control

## License

MIT

## Credits

This plugin uses the [unifi-protect](https://github.com/hjdhjd/unifi-protect) library by hjdhjd for UniFi Protect API communication. Camera Create Motion Events follows that library's camera type and the `recordingSettings.enableMotionDetection` field written by [uiprotect](https://github.com/uilibs/uiprotect) `Camera.set_motion_detection`. `motionSettings.isEnabled` in the same library is the sensor type.
