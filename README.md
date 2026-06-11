# Taupi-EN 4.5 — Dew Point Ventilation Controller for Shelly Plug S/G3

Turns a **Shelly Plug S or G3** into a smart, dew point-based ventilation controller.
A connected fan is switched on and off automatically based on whether ventilating actually makes the room drier — or would make it wetter.

> **Original idea:** [HolzaChr](https://github.com/holzachr) & [BoeserBob](https://github.com/BoeserBob/Taupi-4.0) — brilliant work, folks! 🎉  
> **This fork:** English translation, memory optimisation, virtual status display, quiet hours, battery warnings, crash fixes — refactored with the help of [Claude](https://claude.ai) (Anthropic).

---

## How it works

The fan switches **ON** when all three conditions are met at the same time:

```
Indoor dew point  >  Outdoor dew point + threshold   →  ventilating removes moisture
Indoor temperature  >  minimum                        →  no frost risk
Indoor humidity     >  minimum                        →  sensor reading is plausible
```

The dew point is calculated from temperature and relative humidity using the **Magnus formula** (with separate coefficients for T ≥ 0 °C and T < 0 °C). A lower dew point means drier air. If the outdoor dew point is lower than indoors, ventilating will dry the room out.

---

## Hardware

| Component | Notes |
|---|---|
| **Shelly Plug S or G3** | The controller — runs the script, switches the relay, receives BLE |
| **BLE sensor (indoor)** | e.g. Shelly BLU H&T — any BTHome v2 compatible sensor works |
| **BLE sensor (outdoor)** | Same type, mounted outside |
| **Fan 230 V** *(optional)* | Plugged into the Shelly relay output |

**Requirements on the device:**
- Firmware **1.x or newer** (tested with 1.7.5)
- Bluetooth enabled: `Settings → Bluetooth → Enable`
- NTP configured (only required for quiet hours): `Settings → Time`
- No second script occupying the BLE scanner simultaneously

---

## Installation

1. Set up the Shelly Plug on your local network.
2. Enable Bluetooth: `Settings → Bluetooth → Enable`.
3. Configure NTP: `Settings → Time` (needed for quiet hours).
4. In the Shelly web interface go to **Scripts → Add Script**.
5. Paste the contents of `taupi-refactored.js`.
6. Adjust the configuration at the top of the script (see below).
7. Save and start the script. Enable **"Run on startup"**.

### Virtual status display (optional)

The script can write live sensor readings and fan state to a virtual text component visible in the Shelly app. Because `Shelly.AddComponent` is not callable from scripts, this component must be created **once** via HTTP before starting the script:

```bash
curl -X POST http://<shelly-ip>/rpc/Shelly.AddComponent \
     -d '{"type":"text","id":200,"config":{"name":"Taupi Status"}}'
```

After that the component appears under **Components → Taupi Status** in the Shelly app and is updated every 10 seconds. Set `VIRTUAL_TEXT_ID = -1` in the script to disable it.

---

## Configuration

All settings are at the top of the script, above the `End of Configuration` line.

### Sensors

```js
var sensor_outside = "xx:xx:xx:xx:xx:xx"; // BLE MAC address of outdoor sensor
var sensor_inside  = "xx:xx:xx:xx:xx:xx"; // BLE MAC address of indoor sensor
```

Find the MAC address in the Shelly app or web interface under `Bluetooth → Devices`.

### Telegram notifications

```js
var ENABLE_TELEGRAM = false;        // set to true to enable
let BOT_TOKEN = "YOUR_BOT_TOKEN";  // from @BotFather
let CHAT_ID   = "YOUR_CHAT_ID";   // your Telegram chat ID
```

Notifications are sent when:
- the fan switches on or off (with reason, dew points, temperature, humidity)
- a sensor timeout occurs
- a battery drops below `battery_warning_level`

Telegram messages are intentionally delayed to the next timer cycle (~10 s after the triggering event) to avoid concurrent Shelly call crashes.

### Additional fans (optional)

```js
var fan_plug_ips = ["192.168.1.100"]; // IPs of additional Shelly Plug S devices
var fan_plug_ips = [];                // empty = disabled
```

Additional Shelly Plug S devices that switch in sync with the primary relay. Controlled via HTTP RPC and synced to the main relay state on startup.

### Switching parameters

| Variable | Default | Unit | Description |
|---|---|---|---|
| `dewpoint_threshold` | `2` | °C | Minimum dew point difference (indoor − outdoor) to switch ON |
| `min_temperature` | `5` | °C | Fan stays OFF if indoor temperature is below this |
| `min_humidity` | `40` | % | Fan stays OFF if indoor humidity is below this |
| `check_interval` | `10` | s | How often switching conditions are evaluated |
| `battery_warning_level` | `20` | % | LED turns orange when a sensor drops below this level |
| `connection_timeout` | `600` | s | Maximum sensor data age before a timeout error is raised |
| `hysteresis` | `300` | s | Minimum time between two state changes (prevents rapid toggling) |
| `VIRTUAL_TEXT_ID` | `200` | — | ID of the virtual text component (`-1` = disabled) |

### Quiet hours

```js
var quiet_hours_start = 20; // fan forced OFF from 20:00
var quiet_hours_end   = 7;  // fan released again at 07:00
```

- Times are whole hours (0–23) in local device time (requires NTP).
- Spanning midnight is supported: `start=22, end=6` means 22:00–06:00.
- Disable: set `quiet_hours_start === quiet_hours_end` (e.g. both `0`).
- Without NTP sync, quiet hours are skipped — the fan is not blocked.

### Debug logging

```js
var DEBUG = false; // true = verbose logging + free RAM output every 10 s
```

Leave `false` in normal operation — `true` causes string allocations every 10 seconds and prints free RAM:

```
RAM: 54000/258312 bytes free
```

> **Note:** The RAM value shows total system RAM, not the mJS heap. The mJS heap is significantly smaller (~15–25 KB) and is managed separately.

---

## LED colours

| LED | Meaning |
|---|---|
| 🟢 Green (solid) | Fan OFF — all good |
| 🔵 Blue (solid) | Fan ON — actively ventilating |
| 🟠 Orange (solid) | Battery warning — one or both sensors below threshold |
| 🔴 Red (solid) | Error — no sensor data yet (waiting for first BLE packet) |
| 🟣 Violet (solid) | Error — sensor timeout (connection lost) |

Error and warning LEDs are solid (not blinking). Each blink tick would fire a `PLUGS_UI.SetConfig` call every 500 ms — under a sustained error this drains the mJS heap and crashes the device.

---

## Timing of a switch event

To avoid overloading the mJS runtime with simultaneous Shelly calls, actions after a switch event are staggered:

```
T +  0 ms   switchFans()         →  Switch.Set + HTTP.GET (extra fans)
T +500 ms   LED timer            →  PLUGS_UI.SetConfig
T + 10 s    next cycle           →  sendTelegram (HTTP.POST)
T + 11 s    updateVirtualStatus  →  Text.Set
```

---

## Sensor failure behaviour

If a BLE sensor stops sending data:

1. **Packets without temperature/humidity** (e.g. battery-only updates) are detected and do not overwrite the last valid readings.
2. **Complete connection loss:** after `connection_timeout` seconds without a packet, the script enters error state.
3. In error state: LED turns violet, one Telegram message is sent, **no further switching**, no further Telegram messages.
4. When the sensor comes back: LED returns to normal colour, operation resumes.

---

## Restart behaviour

On startup the script reads the current relay state (`switch:0`) and sets `current_status` accordingly — no unnecessary switch event is triggered after a restart. Additional fans are synced to the main relay state on startup.

---

## Troubleshooting

**LED solid red after startup**  
→ No BLE packets received yet. Is the sensor in range? Is Bluetooth enabled on the Shelly?

**LED solid violet**  
→ Sensor connection lost (no packet for `connection_timeout` seconds). Check battery, reduce distance, check if another Shelly script is occupying the BLE scanner.

**Fan doesn't switch even though conditions are met**  
→ Hysteresis active. `hysteresis` seconds must pass since the last state change. Check the log: `[DEBUG] Hysteresis: want ON but holding for Xs more`.

**Quiet hours not working**  
→ Check NTP: Shelly web interface → System → Time. Without a system time, quiet hours are skipped.

**Telegram messages arrive with a delay**  
→ This is by design — Telegram is deferred to the next timer cycle (~10 s) to avoid concurrent call crashes.

**Script ran out of memory**  
→ Set `DEBUG = false`. Check whether a second script is running simultaneously (e.g. Home Assistant BLE proxy) — move it to a separate device.

**Shelly Plug goes offline and needs a physical restart**  
→ Two possible causes:
1. **Software:** `PLUGS_UI.SetConfig` fired simultaneously with `Switch.Set` — fixed by the 500 ms LED delay in this version.
2. **Hardware:** Motor inrush current causes a brownout — test without a load plugged in. If the Shelly crashes even without load, it may be a firmware bug (observed on 1.7.5).

**`NaN` in dew point or `undefined` in sensor values**  
→ The sensor sent a packet without temperature/humidity. Since the fix in `checkBlu()`, such packets are ignored and the last valid values are retained.

---

## Files

| File | Contents |
|---|---|
| `taupi-refactored.js` | Main script — dew point ventilation controller |
| `mqtt-ble-blu-ht-forwarder.js` | Companion script — forwards BLU H&T readings via MQTT |
| `README.md` | This documentation |

---

## License & Credits

Original concept and script: **[HolzaChr](https://github.com/holzachr)** and **[BoeserBob](https://github.com/BoeserBob/Taupi-4.0)**.  
BLE decoder based on [shelly-script-examples](https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble-shelly-blu.js) © 2024 Shelly Europe, licensed under Apache 2.0.  
This fork refactored and documented with the help of **[Claude](https://claude.ai)** (Anthropic).
