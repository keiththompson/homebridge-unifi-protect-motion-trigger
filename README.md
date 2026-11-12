# Homebridge UniFi Protect Motion Trigger

A lightweight Homebridge plugin that exposes UniFi Protect camera motion sensors and settings as HomeKit accessories, **without video streaming**.

This plugin is designed to work alongside [Scrypted](https://github.com/koush/scrypted) or other video streaming solutions. It provides motion detection and camera controls while letting your preferred streaming solution handle the video.

## Features

Each camera is exposed as a HomeKit accessory with:

- **Motion Sensor** - Triggers HomeKit automations when the camera detects motion
- **Motion Enabled Switch** - Turns UniFi Protect **Create Motion Events** on or off. It does not change smart detection. Recording mode is left alone, so continuous recording is unchanged.
- **Smart Detection Switch** - Turns that camera's smart detection off and back on. Off saves the camera's own zones and detection types, then clears `objectTypes`. On writes that snapshot back. Shown by default; set `showSmartDetection` to `false` to hide it.
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
      "showSmartDetection": true,
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
| `showSmartDetection`     | No       | `true`  | Show the Smart Detection switch on each camera             |
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

- **Motion Enabled Switch**: This changes the camera's `recordingSettings.enableMotionDetection` flag (Create Motion Events in the Protect UI) through the private Protect API used by `unifi-protect`. It does **not** write `motionSettings.isEnabled`, and it does **not** change smart detection. `motionSettings` belongs to Protect sensors; on current cameras it is null, and a PATCH that sets it can return success without changing Create Motion Events. Recording mode (`always`, `detections`, or `never`) is not modified.

  The plugin reads the camera back with `GET /proxy/protect/api/cameras/{id}` after the PATCH. It tries immediately, then after 250ms, then after 500ms. Success is logged only when that read shows the requested Create Motion Events value. A PATCH body that echoes the new value is not enough. If that flag never agrees, HomeKit reverts the switch.

- **Smart Detection Switch**: Current Protect cameras have no smart-detection enable flag. Detection is on when `smartDetectSettings` lists object, audio, or auto-tracking types, or when `smartDetectZones[]` (and `secondLensSmartDetectZones[]` on a dual-lens camera) has a non-empty `objectTypes` list. Turning the switch off reads that camera, saves its settings lists and zone objects, then writes the same zones back with `objectTypes` cleared. Names, points, sensitivity, color, and ids are copied from the camera. They are not replaced with defaults. One camera's zone at sensitivity 75 is restored at 75 even when another camera's zone is 50. Turning the switch on writes that camera's saved snapshot back.

  The HomeKit switch follows the smart-detection state read from Protect. A camera discovered with smart detection already off shows the switch off, and that empty state is not saved as the snapshot. If there is no saved snapshot, turning the switch on does not invent a zone; the switch returns to off and Protect is left unchanged.

  Some controllers put a type back on a list this plugin does not own. A second-lens zone is one case. The type is recorded when a clear removes other saved types and that list still has the type after one more clear, and the saved snapshot did not contain it. An ignored write changes nothing, so it is not recorded, and neither is a zone that sticks while a sibling zone in the same list clears. Recorded types are listed in the health file as `smartDetectEnforcedTypes` and are not drift. If every saved type survives the clear, HomeKit reverts the switch. A later read that no longer shows a recorded type drops it. Turning the switch off does not replace the saved snapshot with a camera that has already lost some of those saved types. A later off leaves recorded types out of the new snapshot, unless that would leave nothing to restore.

  The first off with no snapshot, and an off whose saved type has no proof it belongs to the user, does not record that type yet. The snapshot keeps it and marks it unconfirmed. The next off records it when another list in that update clears and the type is still there, then leaves it out of the snapshot. If that next off clears the type, it was the user's and stays in the snapshot. A file that already contains the controller's type, including one restored from a backup or rewritten after the detection types are turned back on in Protect, follows the same two offs. The first reports a mismatch. The second records the type.

  The snapshot is written to `{Homebridge storage}/.unifi-protect-motion-trigger-smart-detect.json` before the disable PATCH. A restart while the switch is off reloads that file. A camera that is already off does not replace a saved snapshot. The zone PATCH sends only fields Protect accepts (`id`, `name`, `color`, `points`, `sensitivity`, `objectTypes`, and `isTriggerLightEnabled` when the camera has it). If that write is rejected, it is retried without the optional fields. A failed smart-detection write does not block the Motion Enabled or Status LED change in the same request, and it does not block the next camera.

  Motion Enabled, Smart Detection, and Status LED share one write queue per controller. A scene that flips more than one switch on the same camera sends them in one request, so they cannot race.

  Read-back works the same way as Create Motion Events. The log line `smart detection disabled` or `smart detection restored` is written only after the camera GET agrees. Agreement allows a type the controller added to a list that was empty before the write. The same log line names that type once. If a saved type is still there, or the clear did not apply, HomeKit reverts the Smart Detection switch and health reports drift.

- **Status LED Switch**: This directly controls the camera's indicator LED via the UniFi Protect API, and that change is also confirmed by reading the camera back.

## Use Cases

- Trigger HomeKit automations when motion is detected (lights, notifications, etc.)
- Disable motion notifications at night without affecting UniFi Protect recordings
- Turn smart detection off and back on without changing Create Motion Events or recording mode
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
- If the controller restarts, the plugin refreshes the Protect session and reopens the events websocket. Homebridge does not need a restart for that.

### Switch says it changed but Protect did not

- A controller can accept a PATCH and leave `recordingSettings.enableMotionDetection` unchanged. This plugin treats that as a failure after readback and reverts the HomeKit switch.
- Health `readback.status` of `mismatch` or `drift: true` means the last camera read does not match a switch. `stale` means that read is older than five minutes. `unknown` means the motion flag has not been read. `error` means the last read failed.

## Health

`ProtectMotionPlatform.getHealth({ refresh: true })` returns schema `1.2.0`. `refresh` only GETs cameras; it does not change them. The document contains controller addresses and camera ids and names. It does not contain usernames, passwords, or tokens. Releases through 1.0.9 had no health payload. 1.1.0 added readback. 1.2.0 adds smart-detection expected, actual, and drift. Older fields stay in place.

The same snapshot is also written to `{Homebridge storage}/.unifi-protect-motion-trigger-health.json` (typically `~/.homebridge/.unifi-protect-motion-trigger-health.json`) so an external monitor can read it without the Homebridge UI API. The file is rewritten after a successful login/bootstrap, on connect/disconnect/reconnect, when a previously live session drops or is restored, when the camera set or camera settings change, after a settings readback, and every 60 seconds. Writes use a temp file plus rename. The timer is cleared on shutdown. A dropped bootstrap or events websocket is refreshed every few minutes, backing off after repeated failures.

home-monitor reads `updatedAtEpoch` (falling back to the file mtime) and treats a snapshot older than 300 seconds as critically stale. It also requires every `controllers[].connected` value to be true, and it sums `controllers[].cameras`, so that field remains a camera **count**. Per-camera details, including `readback`, `drift`, and smart detection, are under `controllers[].cameraHealth`.

| Field                                                        | Meaning                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion`                                              | `1.2.0`                                                                                                                                                                        |
| `pluginVersion`                                              | Plugin version that produced the document                                                                                                                                      |
| `generatedAt`                                                | ISO time the document was built                                                                                                                                                |
| `updatedAt` / `updatedAtEpoch`                               | ISO time and UTC epoch seconds written into the on-disk file so home-monitor can measure freshness without parsing a date string                                               |
| `controllers[].cameras`                                      | Camera **count** in the on-disk file (home-monitor sums this field). `getHealth()` still returns the per-camera array                                                          |
| `controllers[].cameraHealth`                                 | On-disk per-camera objects (`readback`, `drift`, smart detection, and the other camera fields below). Configured cameras stay listed when the live bootstrap is empty          |
| `controllers[].reconnecting` / `consecutiveFailures`         | Connection watchdog fields preserved for the on-disk file                                                                                                                      |
| `controllers[].lastEventAt` / `lastBootstrapAt`              | ISO times of the last websocket event and last successful bootstrap, or `null`                                                                                                 |
| `readbackStaleAfterMs`                                       | Age after which a successful read is `stale` (five minutes)                                                                                                                    |
| `controllers[].address`                                      | Controller host from config                                                                                                                                                    |
| `controllers[].connected`                                    | Login succeeded and the bootstrap is still present. A missing bootstrap is disconnected immediately. An events websocket that has been down for 30 seconds is disconnected too |
| `controllers[].throttled`                                    | Protect API is pausing calls                                                                                                                                                   |
| `controllers[].admin`                                        | Account can change devices, or `null` when disconnected                                                                                                                        |
| `controllers[].lastError`                                    | `authentication failed`, `connection failed`, `protect session lost`, or `null`                                                                                                |
| `controllers[].cameras[].intendedMotionEnabled`              | HomeKit Motion Enabled switch                                                                                                                                                  |
| `controllers[].cameras[].createMotionEvents`                 | Last read of `recordingSettings.enableMotionDetection`, or `null`                                                                                                              |
| `controllers[].cameras[].smartDetectObjectTypes`             | Last read of smart-detection object types, or `null`                                                                                                                           |
| `controllers[].cameras[].smartDetectAudioTypes`              | Last read of smart-detection audio types, or `null`                                                                                                                            |
| `controllers[].cameras[].smartDetectAutoTrackingObjectTypes` | Last read of auto-tracking types, or `null`                                                                                                                                    |
| `controllers[].cameras[].motionSettingsKnown`                | Whether the camera record had a `motionSettings` key                                                                                                                           |
| `controllers[].cameras[].motionSettings`                     | Sensor-shaped value when present; `null` when the key is null or absent                                                                                                        |
| `controllers[].cameras[].smartDetectPreferencesSaved`        | True when an active smart-detection snapshot is saved for restore                                                                                                              |
| `controllers[].cameras[].smartDetectExpected`                | Settings lists and zones the switch should have produced (`objectTypes`, and each zone's `name`, `sensitivity`, `objectTypes`, `points`), or `null`                            |
| `controllers[].cameras[].smartDetectActual`                  | Those same fields from the last successful camera read, or `null`                                                                                                              |
| `controllers[].cameras[].smartDetectDrift`                   | `true` when expected and actual smart detection disagree. `null` when either side is unknown. Leftover types in `smartDetectEnforcedTypes` are not drift                       |
| `controllers[].cameras[].smartDetectEnforcedTypes`           | Types on the last read that are not in the saved snapshot (`list`, `zoneId`, `zoneName`, `types`). Empty when compared and none. `null` when there is no snapshot or no read   |
| `controllers[].cameras[].drift`                              | `true` when the switch and last read disagree, including smart detection. `null` when the motion flag is unknown                                                               |
| `controllers[].cameras[].readback.status`                    | `verified`, `mismatch`, `unknown`, `stale`, or `error`                                                                                                                         |
| `controllers[].cameras[].readback.fetchedAt`                 | ISO time of the last successful read, or `null`                                                                                                                                |
| `controllers[].cameras[].readback.error`                     | Fixed read error, or `null`                                                                                                                                                    |
| `controllers[].cameras[].readback.attempts`                  | Reads used for the last check, or `null`                                                                                                                                       |

`verified` means the latest read is fresh and does not disagree with the switch. It does not by itself mean a write was attempted. Trust `drift` only when `readback.status` is `verified` or `mismatch`. A websocket update can move the HomeKit switch before the next GET; call `getHealth({ refresh: true })` before treating the document as current.

### Checking the Smart Detection switch

Turn **Smart Detection** off for one camera. In Protect, the types saved for that camera are cleared. A type the controller puts back on a list that was empty can remain; the switch is still off. Zone shapes and sensitivity stay as they were. The Motion Enabled switch and recording mode stay as they were. The log includes `smart detection disabled` only after the camera GET agrees.

`.unifi-protect-motion-trigger-smart-detect.json` should contain that camera's original object types, zone name, points, and sensitivity. Another camera keeps its own values. In the health file, `cameraHealth[].smartDetectDrift` is false and `readback.status` is `verified` when the read matches. `smartDetectExpected` and `smartDetectActual` show the object types and each zone's name, sensitivity, and points. `smartDetectEnforcedTypes` lists any types the controller kept that the snapshot does not contain. Those do not set `smartDetectDrift`.

Restart Homebridge while the switch stays off. The snapshot file should still contain the original types, not the cleared ones. Turn **Smart Detection** on. That camera gets its own zones and object types back. A zone that was sensitivity 75 is 75 again, even if a different camera's zone is 50.

A camera that is already off when Homebridge starts shows the switch off. Turning it on with no saved snapshot does not create a zone.

`smartDetectLines` and loiter zones are not changed. Set `showSmartDetection` to `false` to hide the switch.

### LED control not working

- The user account needs Full Management permissions
- Some camera models may not support LED control

## License

MIT

## Credits

This plugin uses the [unifi-protect](https://github.com/hjdhjd/unifi-protect) library by hjdhjd for UniFi Protect API communication. Camera Create Motion Events follows that library's camera type and the `recordingSettings.enableMotionDetection` field written by [uiprotect](https://github.com/uilibs/uiprotect) `Camera.set_motion_detection`. `motionSettings.isEnabled` in the same library is the sensor type.
