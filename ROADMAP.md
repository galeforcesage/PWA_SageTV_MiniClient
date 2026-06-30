# Roadmap

## Current Status
- Playback stability and iOS responsiveness improvements are in place and are showing positive results.
- Bridge reconnect storm mitigation and iOS performance profile changes are deployed.

## Known Issue (Open)
- Power button behavior: the top-left power icon currently still triggers SageTV standby behavior instead of a guaranteed client session exit back to the connect screen.

## Next Steps
- Add a dedicated client-only disconnect command path that never maps to SageTV POWER/standby.
- Validate disconnect behavior across Windows Chrome, iPad Safari, and Android Chrome.
- Add lightweight runtime telemetry for power-button action result (disconnect vs standby) to confirm behavior in the field.
