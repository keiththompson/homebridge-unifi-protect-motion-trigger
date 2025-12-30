# Homebridge UniFi Protect Motion Trigger

A lightweight Homebridge plugin that exposes UniFi Protect camera motion sensors and settings as HomeKit accessories, **without video streaming**.

This plugin is designed to work alongside [Scrypted](https://github.com/koush/scrypted) or other video streaming solutions. It provides motion detection and camera controls while letting your preferred streaming solution handle the video.

## Features

Each camera is exposed as a HomeKit accessory with:

- **Motion Sensor** - Triggers HomeKit automations when the camera detects motion
- **Motion Enabled Switch** - Toggle to suppress/enable motion notifications to HomeKit (does not affect UniFi Protect recordings)
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

- **Motion Enabled Switch**: This is a local filter only. When disabled, motion events from UniFi Protect are ignored and won't trigger the HomeKit motion sensor. The camera still records motion in UniFi Protect.

- **Status LED Switch**: This directly controls the camera's indicator LED via the UniFi Protect API.

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
- Check that motion detection is enabled in UniFi Protect
- Verify WebSocket connection in debug logs

### LED control not working

- The user account needs Full Management permissions
- Some camera models may not support LED control

## License

MIT

## Credits

This plugin uses the [unifi-protect](https://github.com/hjdhjd/unifi-protect) library by hjdhjd for UniFi Protect API communication.
