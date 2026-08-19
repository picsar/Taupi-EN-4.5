////////////// TAUPI 4.0 @ Shelly //////////////
// copyright by boeserbob und holzachr
// Questions to quirb@web.de
// Documentation and latest versions at https://github.com/BoeserBob/Taupi-4.0
//
// This script turns a Shelly Plug into a dewpoint-based ventilation controller.
// It switches a connected fan via the Shelly's relay based on the dewpoint difference between inside and outside.
//   - It receives measurement events from BLE sensors.
//   - When readings arrive from the configured indoor and outdoor sensors, dewpoints are calculated from temperature and humidity.
//   - A timer loop periodically checks whether all conditions to run the fan are met:
//         - The fan turns ON if the indoor dewpoint exceeds the outdoor dewpoint by more than the threshold.
//         - The fan turns OFF if indoor temperature is below the minimum or indoor humidity is below the minimum.
//
// The following lines must be configured — at minimum the MAC addresses for sensor_outside and sensor_inside.
//

//========== Sensor Configuration ==========
var sensor_outside = "xx:xx:xx:xx:xx:xx"; // BLE MAC address of outdoor sensor
var sensor_inside = "xx:xx:xx:xx:xx:xx";  // BLE MAC address of indoor sensor

//========== Telegram Configuration ==========
// set to false to disable Telegram notifications (requires valid BOT_TOKEN and CHAT_ID above)
var ENABLE_TELEGRAM = false; // set to true and fill in BOT_TOKEN + CHAT_ID below to enable
let BOT_TOKEN = "YOUR_BOT_TOKEN"; // from @BotFather
let CHAT_ID = "YOUR_CHAT_ID";    // your Telegram chat ID

//========== Additional Fans Configuration ==========
// Optional: URLs of additional Shelly Plug S devices to switch in sync.
// Add or remove entries as needed. Leave empty ([]) to disable.
var fan_plug_ips = []; // optional: IPs of additional Shelly Plug S devices, e.g. ["192.168.1.100"]

//========== Switch Configuration ==========
var dewpoint_threshold = 2; // [°C] turn fan ON when dp_inside > (dp_outside + dewpoint_threshold)...
var min_temperature = 5; // [°C] ...and temp_inside > min_temperature...
var min_humidity = 40; // [%]  ...and humidity_inside > min_humidity
var check_interval = 10; // [s]  evaluate switching conditions every X seconds
var battery_warning_level = 20; // [%]  show orange LED when battery drops below this level
var connection_timeout = 600; // [s]  maximum age of sensor data before connection is considered lost
var hysteresis = 300; // [s]  minimum time between fan status changes (prevents rapid toggling)

//========== Virtual Status Component ==========
// ID of the virtual Text component that shows the current status.
// Must be created once manually via curl (Shelly.AddComponent is not callable from scripts):
//   curl -X POST http://<shelly-ip>/rpc/Shelly.AddComponent \
//        -d '{"type":"text","id":200,"config":{"name":"Taupi Status"}}'
// Set to -1 to disable.
var VIRTUAL_TEXT_ID = 200;

//========== Quiet Hours Configuration ==========
// Fan is forced OFF between quiet_hours_start and quiet_hours_end.
// Times are whole hours (0–23) in local device time (requires NTP).
// Spanning midnight is supported: start=22, end=6 means 22:00–06:00.
// Set quiet_hours_start === quiet_hours_end to disable.
var quiet_hours_start = 20; // [h] begin forcing fan OFF
var quiet_hours_end = 7;    // [h] stop forcing fan OFF

//===== End of Configuration — no changes needed below this line =====================================

var dewpoint_outside;
var dewpoint_inside;
var temp_inside;
var temp_outside;
var humidity_inside;
var humidity_outside;
var battery_inside;
var battery_outside;
var last_seen_inside = 0;
var last_seen_outside = 0;
var current_status = "unknown";
var hysteresis_elapsed = hysteresis; // pre-expired so the first cycle can switch immediately
var in_error_state = false;
var _tel_pending = null;        // deferred Telegram message — sent on next timer cycle
var _battery_warned = false;   // true once low-battery warning has been sent; reset when battery recovers
var _battery_low_count = 0;   // consecutive cycles with low battery; warning only fires after 2+

var DEBUG = false;

function log(msg) {
  if (DEBUG) print(msg);
}

var DEVICE_NAME = (function () {
  let cfg = Shelly.getComponentConfig("sys");
  let info = Shelly.getDeviceInfo();
  return cfg.device.name !== null ? cfg.device.name : info.id;
})();

function sendTelegram(text) {
  if (!ENABLE_TELEGRAM) return;

  Shelly.call(
    "HTTP.POST",
    {
      url: "https://api.telegram.org/bot" + BOT_TOKEN + "/sendMessage",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: "[" + DEVICE_NAME + "] " + text,
      }),
    },
    null,
  );
}

// Dewpoint calculation
function dewpoint(T, RH) {
  var a = T >= 0 ? 17.27 : 21.875;
  var b = T >= 0 ? 237.7 : 265.5;
  var alpha = (a * T) / (b + T) + Math.log(RH / 100);
  return (b * alpha) / (a - alpha);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

function fmtDp(x) {
  return typeof x !== "undefined" ? round1(x) + "°C" : "N/A";
}

// Returns "DD.MM.YYYY HH:MM" from the sys component status.
// sys.time is already local time (HH:MM); date is derived from sys.unixtime (UTC).
// Uses only scalars — no array allocation.
function fmtDatetime(sys) {
  if (!sys || !sys.unixtime) return "?";
  var d = Math.floor(sys.unixtime / 86400);
  var y = 1970, yd;
  while ((yd = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365) <= d) {
    d -= yd; y++;
  }
  var leap = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 1 : 0;
  var mo = 1, md;
  while (mo <= 12) {
    md = (mo === 2) ? (leap ? 29 : 28) : (mo === 4 || mo === 6 || mo === 9 || mo === 11) ? 30 : 31;
    if (d < md) break;
    d -= md; mo++;
  }
  return (d + 1) + "." + mo + "." + y + " " + (sys.time || "?");
}

// Writes the current sensor readings and fan state to the virtual Text component.
function updateVirtualStatus() {
  if (VIRTUAL_TEXT_ID < 0) return;
  var sys = Shelly.getComponentStatus("sys");
  var dlt = (typeof dewpoint_inside !== "undefined" && typeof dewpoint_outside !== "undefined")
    ? round1(dewpoint_inside - dewpoint_outside) + "K" : "?";
  Shelly.call("Text.Set", { id: VIRTUAL_TEXT_ID, value:
    (sys && sys.time ? sys.time + " " : "") +
    "Fan: " + current_status.toUpperCase() + " | dDp: " + dlt + "\n" +
    " | In:  " + (typeof temp_inside    !== "undefined" ? temp_inside    + "°C" : "?") +
    " "     + (typeof humidity_inside  !== "undefined" ? humidity_inside  + "%" : "?") +
    " Dp: " + fmtDp(dewpoint_inside) + "\n" +
    " | Out: " + (typeof temp_outside   !== "undefined" ? temp_outside   + "°C" : "?") +
    " "     + (typeof humidity_outside !== "undefined" ? humidity_outside + "%" : "?") +
    " Dp: " + fmtDp(dewpoint_outside) + "\n" +
    " | " +fmtDatetime(sys)
  }, null, null);
}

// Returns true when the current local hour falls inside the configured quiet window.
function isQuietHour() {
  if (quiet_hours_start === quiet_hours_end) return false; // disabled
  var sys = Shelly.getComponentStatus("sys");
  if (!sys || !sys.time) return false; // no NTP — don't block the fan
  var hour = parseInt(sys.time.split(":")[0], 10);
  if (quiet_hours_start < quiet_hours_end) {
    return hour >= quiet_hours_start && hour < quiet_hours_end;
  }
  return hour >= quiet_hours_start || hour < quiet_hours_end; // spans midnight
}

function switchFans(on) {
  Shelly.call("Switch.Set", { id: 0, on: on });
  for (var i = 0; i < fan_plug_ips.length; i++) {
    Shelly.call("HTTP.GET", { url: "http://" + fan_plug_ips[i] + "/rpc/Switch.Set?id=0&on=" + on });
    if (DEBUG) log("  + extra fan " + fan_plug_ips[i] + " -> " + (on ? "ON" : "OFF"));
  }
}

// Fan control logic
function controlFan() {
  last_seen_inside  += check_interval;
  last_seen_outside += check_interval;
  hysteresis_elapsed += check_interval;

  // Safety check: are all required sensor values available?
  if (
    typeof dewpoint_inside  === "undefined" ||
    typeof dewpoint_outside === "undefined" ||
    typeof temp_inside      === "undefined" ||
    typeof humidity_inside  === "undefined"
  ) {
    if (!in_error_state) {
      print("[ERROR] No sensor data yet — waiting for first BLE packet");
      in_error_state = true;
      applyLedColor(100, 0, 0, 100); // solid red — no blink timer
    }
    return;
  }

  // Safety check: are we still receiving fresh data from the sensors?
  // only if we are not already in error state, otherwise a temporary connection loss would cause repeated Telegram messages and LED updates every cycle
  if (last_seen_inside > connection_timeout || last_seen_outside > connection_timeout) {
    if (!in_error_state) {
      print("[ERROR] Sensor timeout (indoor=" + last_seen_inside + "s, outdoor=" + last_seen_outside + "s, limit=" + connection_timeout + "s)");
      _tel_pending = "[ERROR] Sensor timeout (indoor=" + last_seen_inside + "s, outdoor=" + last_seen_outside + "s, limit=" + connection_timeout + "s)";
      in_error_state = true;
      applyLedColor(100, 0, 100, 100); // solid violet — no blink timer to avoid 500ms PLUGS_UI.SetConfig allocations
    }
    if (DEBUG) log("Sensor age: indoor=" + last_seen_inside + "s outdoor=" + last_seen_outside + "s (timeout=" + connection_timeout + "s)");
    return; // always return while timed out — prevents recovery block from resetting in_error_state
  }

  // Determine desired state
  var desired_on;
  var quiet = isQuietHour();
  if (quiet) {
    log("[INFO] Quiet hours active — fan forced OFF");
    desired_on = false;
  } else if (
    temp_inside     > min_temperature &&
    humidity_inside > min_humidity &&
    dewpoint_inside > dewpoint_outside + dewpoint_threshold
  ) {
    desired_on = true;
  } else {
    desired_on = false;
  }

  var desired_status = desired_on ? "on" : "off";

  if (desired_status !== current_status) {
    if (hysteresis_elapsed < hysteresis) {
      if (DEBUG) log("[DEBUG] Hysteresis: want " + desired_status.toUpperCase() +
          " but holding for " + (hysteresis - hysteresis_elapsed) + "s more");
    } else {
      // Build the reason string only when actually switching (avoids string allocation every cycle)
      var reason;
      if (desired_on) {
        reason = "dp diff " + round1(dewpoint_inside - dewpoint_outside) + "K >= " + dewpoint_threshold + "K";
      } else if (quiet) {
        reason = "quiet hours " + quiet_hours_start + ":00-" + quiet_hours_end + ":00";
      } else if (temp_inside <= min_temperature) {
        reason = "T_in " + temp_inside + "°C <= min " + min_temperature + "°C";
      } else if (humidity_inside <= min_humidity) {
        reason = "RH_in " + humidity_inside + "% <= min " + min_humidity + "%";
      } else {
        reason = "dp diff " + round1(dewpoint_inside - dewpoint_outside) + "K < threshold " + dewpoint_threshold + "K";
      }
      print("[INFO] Fan -> " + desired_status.toUpperCase() + " (" + reason + ")");
      switchFans(desired_on);
      current_status = desired_status;
      hysteresis_elapsed = 0;
      // Defer LED 500ms and Telegram to next cycle — avoids >2 concurrent Shelly.call()s
      // which can crash the mJS runtime when the relay fires simultaneously
      Timer.set(500, false, function() {
        if (current_status === "on") setLedColor(0, 0, 100, 10); // blue — ventilating
        else                         setLedColor(0, 100, 0, 10); // green — all good
      });
      _tel_pending =
        "Fan " + current_status.toUpperCase() + " — " + reason +
        "\nT in: " + temp_inside + "°C | RH in: " + humidity_inside + "% | Dp in: " + round1(dewpoint_inside) + "°C" +
        "\nT out: " + temp_outside + "°C | RH out: " + humidity_outside + "%| Dp out: " + round1(dewpoint_outside) + "°C" +
        "\nThreshold: " + dewpoint_threshold + "K";
    }
  }

  // Recover from error state: restore LED once when fresh data is available again
  if (in_error_state) {
    in_error_state = false;
    if (current_status === "on") {
      setLedColor(0, 0, 100, 10); // blue — ventilating
    } else {
      setLedColor(0, 100, 0, 10); // green — all good
    }
  }

  // Battery warning overrides LED color (checked last so it's always visible).
  // Requires 2 consecutive low readings before warning — filters single-packet glitches
  // (voltage sag during BLE transmission can cause one spurious low reading).
  if (battery_inside < battery_warning_level || battery_outside < battery_warning_level) {
    _battery_low_count++;
    if (_battery_low_count >= 2 && !_battery_warned) {
      print("[WARN] Low battery — indoor: " + battery_inside + "%, outdoor: " + battery_outside + "%");
      _tel_pending = "[WARN] Low battery — indoor: " + battery_inside + "%, outdoor: " + battery_outside + "%";
      _battery_warned = true;
      applyLedColor(100, 50, 0, 100); // solid orange — no blink timer
    }
  } else {
    _battery_low_count = 0;
    _battery_warned = false; // reset once both batteries are above threshold again
  }
}

var blinkTimer = null;
var blinkState = false;

// Set the LED ring color (for Shelly Plug S).
// Pass blink=true to flash the color on/off until the next setLedColor call.
function setLedColor(red, green, blue, brightness, blink) {
  if (blinkTimer !== null) {
    Timer.clear(blinkTimer);
    blinkTimer = null;
  }

  if (blink) {
    blinkState = true;
    blinkTimer = Timer.set(500, true, function () {
      blinkState = !blinkState;
      applyLedColor(
        blinkState ? red : 0,
        blinkState ? green : 0,
        blinkState ? blue : 0,
        brightness,
      );
    });
  } else {
    applyLedColor(red, green, blue, brightness);
  }
}

function applyLedColor(red, green, blue, brightness) {
  Shelly.call(
    "PLUGS_UI.SetConfig",
    {
      id: 0,
      config: {
        leds: {
          mode: "switch",
          colors: {
            "switch:0": {
              on: {
                rgb: [red, green, blue],
                brightness: brightness,
              },
              off: {
                rgb: [red, green, blue],
                brightness: brightness,
              },
            },
          },
        },
      },
    },
    null,
    null,
  );
}

// Process incoming BLE sensor data.
// Temperature and humidity are only updated when both are present in the packet —
// a packet without these fields (e.g. battery-only) must not overwrite valid readings with undefined.
function checkBlu(event) {
  if (event.address === sensor_outside) {
    battery_outside   = event.battery;
    last_seen_outside = 0;
    var t = Array.isArray(event.temperature) ? event.temperature[0] : event.temperature;
    var h = Array.isArray(event.humidity)    ? event.humidity[0]    : event.humidity;
    if (typeof t !== "undefined" && typeof h !== "undefined") {
      temp_outside     = t;
      humidity_outside = h;
      dewpoint_outside = dewpoint(t, h);
    }
    log("Outdoor: T=" + temp_outside + "°C RH=" + humidity_outside + "% Dp=" + round1(dewpoint_outside) + "°C Batt=" + battery_outside + "%");
  } else if (event.address === sensor_inside) {
    battery_inside   = event.battery;
    last_seen_inside = 0;
    var t = Array.isArray(event.temperature) ? event.temperature[0] : event.temperature;
    var h = Array.isArray(event.humidity)    ? event.humidity[0]    : event.humidity;
    if (typeof t !== "undefined" && typeof h !== "undefined") {
      temp_inside     = t;
      humidity_inside = h;
      dewpoint_inside = dewpoint(t, h);
    }
    log("Indoor:  T=" + temp_inside + "°C RH=" + humidity_inside + "% Dp=" + round1(dewpoint_inside) + "°C Batt=" + battery_inside + "%");
  }
}

// Main control timer
Timer.set(check_interval * 1000, true, function () {
  // Send deferred Telegram from previous switch cycle (kept separate to avoid concurrent calls)
  if (_tel_pending !== null) { sendTelegram(_tel_pending); _tel_pending = null; }
  print("----- Cycle (fan=" + current_status + ", hyst=" + hysteresis_elapsed + "s/" + hysteresis + "s) -----");
  print("Indoor:  T=" + temp_inside + "°C RH=" + humidity_inside + "% Dp=" + fmtDp(dewpoint_inside) + " Batt=" + battery_inside + "%");
  print("Outdoor: T=" + temp_outside + "°C RH=" + humidity_outside + "% Dp=" + fmtDp(dewpoint_outside) + " Batt=" + battery_outside + "%");
  if (DEBUG) {
    var _sys = Shelly.getComponentStatus("sys");
    log("RAM: " + _sys.ram_free + "/" + _sys.ram_size + " bytes free");
  }
  controlFan();
  // Skip virtual status update in error state — saves string building + Text.Set call
  if (!in_error_state) Timer.set(1000, false, updateVirtualStatus);
});

///////////////// BLE Decoder ///////////////////////

// The following code is a modified version of
// https://github.com/ALLTERCO/shelly-script-examples/blob/main/ble-shelly-blu.js
//
//   Copyright 2024 Shelly Europe
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0

const BTHOME_SVC_ID_STR = "fcd2";

const uint8 = 0;
const int8 = 1;
const uint16 = 2;
const int16 = 3;
const uint24 = 4;
const int24 = 5;

// The BTH object defines the structure of the BTHome data.
// Only entries actually used by checkBlu() are kept (pid, battery, temperature, humidity).
const BTH = {
  0x00: { n: "pid",         t: uint8  },
  0x01: { n: "battery",     t: uint8  },
  0x02: { n: "temperature", t: int16,  f: 0.01 },
  0x03: { n: "humidity",    t: uint16, f: 0.01 },
  0x2e: { n: "humidity",    t: uint8  },
  0x45: { n: "temperature", t: int16,  f: 0.1  },
};

// Unpacks the service data buffer from a Shelly BLU device.
// Uses an index (pos) instead of buffer.slice() to avoid heap allocations.
function unpack(buffer) {
  if (typeof buffer !== "string" || buffer.length === 0) return null;
  let result = {};
  let _dib = buffer.at(0);
  result["encryption"] = _dib & 0x1 ? true : false;
  result["BTHome_version"] = _dib >> 5;
  if (result["BTHome_version"] !== 2) return null;
  if (result["encryption"]) return result; // cannot handle encrypted data

  let pos = 1;
  let _bth, _value, _type, _sz, _raw;
  while (pos < buffer.length) {
    _bth = BTH[buffer.at(pos)];
    if (typeof _bth === "undefined") {
      log("BTH: Unknown type");
      break;
    }
    pos++;
    _type = _bth.t;
    // Inline byte size: uint8/int8=1, uint16/int16=2, uint24/int24=3
    _sz = (_type === uint8 || _type === int8) ? 1 : (_type === uint16 || _type === int16) ? 2 : 3;
    if (pos + _sz > buffer.length) break;

    // Inline read — no slice, no intermediate allocation
    if (_type === uint8) {
      _raw = buffer.at(pos);
    } else if (_type === int8) {
      _raw = buffer.at(pos);
      if (_raw & 0x80) _raw = _raw - 256;
    } else if (_type === uint16) {
      _raw = 0xffff & ((buffer.at(pos + 1) << 8) | buffer.at(pos));
    } else if (_type === int16) {
      _raw = 0xffff & ((buffer.at(pos + 1) << 8) | buffer.at(pos));
      if (_raw & 0x8000) _raw = _raw - 65536;
    } else if (_type === uint24) {
      _raw = 0x00ffffff & ((buffer.at(pos + 2) << 16) | (buffer.at(pos + 1) << 8) | buffer.at(pos));
    } else {
      _raw = 0x00ffffff & ((buffer.at(pos + 2) << 16) | (buffer.at(pos + 1) << 8) | buffer.at(pos));
      if (_raw & 0x800000) _raw = _raw - 16777216;
    }

    _value = typeof _bth.f !== "undefined" ? _raw * _bth.f : _raw;

    if (typeof result[_bth.n] === "undefined") {
      result[_bth.n] = _value;
    } else if (Array.isArray(result[_bth.n])) {
      result[_bth.n].push(_value);
    } else {
      result[_bth.n] = [result[_bth.n], _value];
    }

    pos += _sz;
  }
  return result;
}

// Track the last packet ID per sensor address to filter duplicate advertisements
let lastPacketId = {};

// BLE scanner callback
function BLEScanCallback(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT) return;

  // Ignore all devices except our two configured sensors — keeps lastPacketId small
  if (result.addr !== sensor_outside && result.addr !== sensor_inside) return;

  if (
    typeof result.service_data === "undefined" ||
    typeof result.service_data[BTHOME_SVC_ID_STR] === "undefined"
  ) {
    return;
  }

  let unpackedData = unpack(result.service_data[BTHOME_SVC_ID_STR]);

  if (
    unpackedData === null ||
    typeof unpackedData === "undefined" ||
    unpackedData["encryption"]
  ) {
    log("Error: Encrypted devices are not supported");
    return;
  }

  if (lastPacketId[result.addr] === unpackedData.pid) return; // duplicate packet

  lastPacketId[result.addr] = unpackedData.pid;
  unpackedData.address = result.addr;
  checkBlu(unpackedData);
}

// Initialize BLE scanner
function initBLE() {
  const BLEConfig = Shelly.getComponentConfig("ble");

  // Firmware 2.0.0 removed the global enable flag — BLE now auto-activates.
  // Only bail out if it is explicitly false (firmware 1.x with BLE disabled).
  if (BLEConfig.enable === false) {
    log("Error: Bluetooth is not enabled — please enable it in settings");
    return;
  }

  if (BLE.Scanner.isRunning()) {
    log(
      "Info: BLE gateway is running — scan configuration is managed by the device",
    );
  } else {
    const bleScanner = BLE.Scanner.Start({
      duration_ms: BLE.Scanner.INFINITE_SCAN,
      active: false, // active scan requests all data from devices but drains their battery faster
    });

    if (!bleScanner) {
      log("Error: Could not start BLE scanner");
    }
  }

  BLE.Scanner.Subscribe(BLEScanCallback);
}

// Read the actual relay state on startup so current_status reflects reality.
// Without this the script wouldn't know the fan is already running after a restart.
// Additional fans are synced to the main relay state unconditionally —
// querying their status first would require closures + JSON.parse which exhaust the mJS heap.
var _sw = Shelly.getComponentStatus("switch:0");
current_status = (_sw && _sw.output === true) ? "on" : "off";
print("[INFO] Startup — relay is " + current_status.toUpperCase());
for (var _i = 0; _i < fan_plug_ips.length; _i++) {
  print("[INFO] Startup — syncing extra fan " + fan_plug_ips[_i] + " -> " + current_status.toUpperCase());
  Shelly.call("HTTP.GET", { url: "http://" + fan_plug_ips[_i] + "/rpc/Switch.Set?id=0&on=" + (current_status === "on") });
}

initBLE();

// NOTE: The virtual Text component (id=VIRTUAL_TEXT_ID) must be created once manually:
//   curl -X POST http://<shelly-ip>/rpc/Shelly.AddComponent \
//        -d '{"type":"text","id":200,"config":{"name":"Taupi Status"}}'
// Afterwards this script fills it automatically via Text.Set every cycle.