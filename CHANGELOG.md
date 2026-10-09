# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Fixed

- **Self-healing Protect connection.** The realtime events websocket is no longer
  established only once at startup. A connection watchdog now periodically
  re-bootstraps the session (reconnecting an expired session and rebuilding the
  websocket) and performs a full re-login when a refresh fails. This fixes the
  recurring outages where motion events silently stopped — and camera setting
  changes quietly failed — after a controller reboot, session expiry, or network
  blip, until Homebridge was manually restarted.

### Added

- **Connection health file.** The plugin writes a health snapshot to
  `<homebridge storage>/.unifi-protect-motion-trigger-health.json` (connection
  state, camera count, last event/bootstrap times, consecutive failures) so an
  external monitor can observe the integration without the authenticated
  Homebridge UI API.

### Internal

- Realtime event packets now update a `lastEventAt` timestamp, exposed via a new
  `ProtectClient.health` accessor, alongside tests for the reconnection and
  health-reporting paths.
