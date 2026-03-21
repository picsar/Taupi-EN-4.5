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
var sensor_outside = "7c:c6:b6:71:d9:ae";
var sensor_inside  = "7c:c6:b6:80:3c:4b";

//========== Additional Fans Configuration ==========
// Optional: URLs of additional Shelly Plug S devices to switch in sync.
// Add or remove entries as needed. Leave empty ([]) to disable.
var fan_plug_urls = [
  "http://192.168.100.154/relay/0",
];

//========== Switch Configuration ==========
var dewpoint_threshold    = 2;   // [°C] turn fan ON when dp_inside > (dp_outside + dewpoint_threshold)...
var min_temperature       = 5;   // [°C] ...and temp_inside > min_temperature...
var min_humidity          = 40;  // [%]  ...and humidity_inside > min_humidity
var check_interval        = 10;  // [s]  evaluate switching conditions every X seconds
var battery_warning_level = 20;  // [%]  show orange LED when battery drops below this level
var connection_timeout    = 600; // [s]  maximum age of sensor data before connection is considered lost

//===== End of Configuration — no changes needed below this line =====================================

var dewpoint_outside;
var dewpoint_inside;
var temp_inside;
var temp_outside;
var humidity_inside;
var humidity_outside;
var battery_inside;
var battery_outside;
var last_seen_inside  = 0;
var last_seen_outside = 0;

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

function setFan(on) {
  Shelly.call("Switch.Set", { id: 0, on: on });
  var cmd = on ? "?turn=on" : "?turn=off";
  for (var i = 0; i < fan_plug_urls.length; i++) {
    Shelly.call("HTTP.GET", { url: fan_plug_urls[i] + cmd });
  }
}

// Fan control logic
function controlFan() {
  // Always increment counters so connection timeout works even if values are missing
  last_seen_inside  += check_interval;
  last_seen_outside += check_interval;

  // Safety check: are all required sensor values available?
  if (
    typeof dewpoint_inside  === "undefined" ||
    typeof dewpoint_outside === "undefined" ||
    typeof temp_inside      === "undefined" ||
    typeof humidity_inside  === "undefined"
  ) {
    print("ERROR: Not all sensor values available — skipping control cycle.");
    setLedColor(100, 0, 0, 100, true); // red blink
    return;
  }

  print("Last contact with indoor sensor:",  last_seen_inside,  "seconds ago");
  print("Last contact with outdoor sensor:", last_seen_outside, "seconds ago");

  // Safety check: are we still receiving fresh data from the sensors?
  if (last_seen_inside > connection_timeout || last_seen_outside > connection_timeout) {
    print("ERROR: Sensor connection lost for too long — turning fan OFF.");
    setFan(false);
    setLedColor(100, 0, 0, 100, true); // red blink
    return;
  }

  // Switching logic
  if (
    temp_inside     > min_temperature &&
    humidity_inside > min_humidity    &&
    dewpoint_inside > dewpoint_outside + dewpoint_threshold
  ) {
    print("Turning fan ON");
    setFan(true);
    setLedColor(0, 0, 100, 10); // blue — ventilating
  } else {
    print("Turning fan OFF");
    setFan(false);
    setLedColor(0, 100, 0, 10); // green — all good
  }

  // Battery warning overrides LED color (checked last so it's always visible)
  if (battery_inside < battery_warning_level || battery_outside < battery_warning_level) {
    print("WARNING: Low battery level — indoor:", battery_inside, "%, outdoor:", battery_outside, "%");
    setLedColor(100, 50, 0, 100, true); // orange blink
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
        blinkState ? red   : 0,
        blinkState ? green : 0,
        blinkState ? blue  : 0,
        brightness
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
              on:  { rgb: [red, green, blue], brightness: brightness },
              off: { rgb: [red, green, blue], brightness: brightness },
            },
          },
        },
      },
    },
    function (result, code, msg, ud) {},
    null,
  );
}

// Process incoming BLE sensor data
function checkBlu(event) {
  if (event.address === sensor_outside) {
    temp_outside      = event.temperature;
    humidity_outside  = event.humidity;
    dewpoint_outside  = dewpoint(event.temperature, event.humidity);
    battery_outside   = event.battery;
    last_seen_outside = 0;
    print("New outdoor values:", temp_outside, "°C,", humidity_outside, "%, Dp:", round1(dewpoint_outside), "°C, Batt:", battery_outside, "%");
  } else if (event.address === sensor_inside) {
    temp_inside      = event.temperature;
    humidity_inside  = event.humidity;
    dewpoint_inside  = dewpoint(event.temperature, event.humidity);
    battery_inside   = event.battery;
    last_seen_inside = 0;
    print("New indoor values:", temp_inside, "°C,", humidity_inside, "%, Dp:", round1(dewpoint_inside), "°C, Batt:", battery_inside, "%");
  }
}

// Main control timer
Timer.set(check_interval * 1000, true, function () {
  print("----- Control cycle every", check_interval, "s -----");
  print("Indoor:  T =", temp_inside,  "°C, RH =", humidity_inside,  "%, Dp =", round1(dewpoint_inside),  "°C, Batt:", battery_inside,  "%");
  print("Outdoor: T =", temp_outside, "°C, RH =", humidity_outside, "%, Dp =", round1(dewpoint_outside), "°C, Batt:", battery_outside, "%");
  controlFan();
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

const uint8  = 0;
const int8   = 1;
const uint16 = 2;
const int16  = 3;
const uint24 = 4;
const int24  = 5;

// The BTH object defines the structure of the BTHome data
const BTH = {
  0x00: { n: "pid",         t: uint8  },
  0x01: { n: "battery",     t: uint8,  u: "%"  },
  0x02: { n: "temperature", t: int16,  f: 0.01, u: "tC" },
  0x03: { n: "humidity",    t: uint16, f: 0.01, u: "%"  },
  0x05: { n: "illuminance", t: uint24, f: 0.01 },
  0x21: { n: "motion",      t: uint8  },
  0x2d: { n: "window",      t: uint8  },
  0x2e: { n: "humidity",    t: uint8,  u: "%"  },
  0x3a: { n: "button",      t: uint8  },
  0x3f: { n: "rotation",    t: int16,  f: 0.1  },
  0x45: { n: "temperature", t: int16,  f: 0.1,  u: "tC" },
};

function getByteSize(type) {
  if (type === uint8  || type === int8)  return 1;
  if (type === uint16 || type === int16) return 2;
  if (type === uint24 || type === int24) return 3;
  return 255; // unreachable — advertisements are much smaller
}

// Functions for decoding and unpacking service data from Shelly BLU devices
const BTHomeDecoder = {
  utoi: function (num, bitsz) {
    const mask = 1 << (bitsz - 1);
    return num & mask ? num - (1 << bitsz) : num;
  },
  getUInt8: function (buffer) {
    return buffer.at(0);
  },
  getInt8: function (buffer) {
    return this.utoi(this.getUInt8(buffer), 8);
  },
  getUInt16LE: function (buffer) {
    return 0xffff & ((buffer.at(1) << 8) | buffer.at(0));
  },
  getInt16LE: function (buffer) {
    return this.utoi(this.getUInt16LE(buffer), 16);
  },
  getUInt24LE: function (buffer) {
    return 0x00ffffff & ((buffer.at(2) << 16) | (buffer.at(1) << 8) | buffer.at(0));
  },
  getInt24LE: function (buffer) {
    return this.utoi(this.getUInt24LE(buffer), 24);
  },
  getBufValue: function (type, buffer) {
    if (buffer.length < getByteSize(type)) return null;
    let res = null;
    if (type === uint8)  res = this.getUInt8(buffer);
    if (type === int8)   res = this.getInt8(buffer);
    if (type === uint16) res = this.getUInt16LE(buffer);
    if (type === int16)  res = this.getInt16LE(buffer);
    if (type === uint24) res = this.getUInt24LE(buffer);
    if (type === int24)  res = this.getInt24LE(buffer);
    return res;
  },

  // Unpacks the service data buffer from a Shelly BLU device
  unpack: function (buffer) {
    // Beacons might not provide BTH service data
    if (typeof buffer !== "string" || buffer.length === 0) return null;
    let result = {};
    let _dib = buffer.at(0);
    result["encryption"]     = _dib & 0x1 ? true : false;
    result["BTHome_version"] = _dib >> 5;
    if (result["BTHome_version"] !== 2) return null;
    if (result["encryption"]) return result; // cannot handle encrypted data
    buffer = buffer.slice(1);

    let _bth;
    let _value;
    while (buffer.length > 0) {
      _bth = BTH[buffer.at(0)];
      if (typeof _bth === "undefined") {
        print("BTH: Unknown type");
        break;
      }
      buffer = buffer.slice(1);
      _value = this.getBufValue(_bth.t, buffer);
      if (_value === null) break;
      if (typeof _bth.f !== "undefined") _value = _value * _bth.f;

      if (typeof result[_bth.n] === "undefined") {
        result[_bth.n] = _value;
      } else {
        if (Array.isArray(result[_bth.n])) {
          result[_bth.n].push(_value);
        } else {
          result[_bth.n] = [result[_bth.n], _value];
        }
      }

      buffer = buffer.slice(getByteSize(_bth.t));
    }
    return result;
  },
};

// Track the last packet ID to filter duplicate advertisements
let lastPacketId = 0x100;

// BLE scanner callback
function BLEScanCallback(event, result) {
  if (event !== BLE.Scanner.SCAN_RESULT) return;

  if (
    typeof result.service_data === "undefined" ||
    typeof result.service_data[BTHOME_SVC_ID_STR] === "undefined"
  ) {
    return;
  }

  let unpackedData = BTHomeDecoder.unpack(result.service_data[BTHOME_SVC_ID_STR]);

  if (unpackedData === null || typeof unpackedData === "undefined" || unpackedData["encryption"]) {
    print("Error: Encrypted devices are not supported");
    return;
  }

  if (lastPacketId === unpackedData.pid) return; // duplicate packet

  lastPacketId = unpackedData.pid;
  unpackedData.address = result.addr;
  checkBlu(unpackedData);
}

// Initialize BLE scanner
function initBLE() {
  const BLEConfig = Shelly.getComponentConfig("ble");

  if (!BLEConfig.enable) {
    print("Error: Bluetooth is not enabled — please enable it in settings");
    return;
  }

  if (BLE.Scanner.isRunning()) {
    print("Info: BLE gateway is running — scan configuration is managed by the device");
  } else {
    const bleScanner = BLE.Scanner.Start({
      duration_ms: BLE.Scanner.INFINITE_SCAN,
      active: false, // active scan requests all data from devices but drains their battery faster
    });

    if (!bleScanner) {
      print("Error: Could not start BLE scanner");
    }
  }

  BLE.Scanner.Subscribe(BLEScanCallback);
}

initBLE();
