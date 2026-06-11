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

var DEBUG = false;

var sensor        = "xx:xx:xx:xx:xx:xx"; // BLE MAC address of first sensor
var sensor_inside = "xx:xx:xx:xx:xx:xx"; // BLE MAC address of second sensor

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
  0x00: { n: "pid", t: uint8 },
  0x01: { n: "battery", t: uint8 },
  0x02: { n: "temperature", t: int16, f: 0.01 },
  0x03: { n: "humidity", t: uint16, f: 0.01 },
  0x2e: { n: "humidity", t: uint8 },
  0x45: { n: "temperature", t: int16, f: 0.1 },
};

function log(msg) {
  if (DEBUG) print(msg);
}

function round1(x) {
  return Math.round(x * 10) / 10;
}

// Dewpoint calculation
function dewpointCalculator(T, RH) {
  var a = T >= 0 ? 17.27 : 21.875;
  var b = T >= 0 ? 237.7 : 265.5;
  var alpha = (a * T) / (b + T) + Math.log(RH / 100);
  return (b * alpha) / (a - alpha);
}

// Process incoming BLE sensor data
function checkBlu(event) {
  let deviceId =
    Shelly.getDeviceInfo().id + "/" + event.address.split(":").join("");

  temperature = Array.isArray(event.temperature)
    ? event.temperature[0]
    : event.temperature;
  humidity = Array.isArray(event.humidity)
    ? event.humidity[0]
    : event.humidity;
  dewpoint = dewpointCalculator(temperature, humidity);
  battery = event.battery;
  last_seen = 0;
  log(
    "Outdoor: T=" +
      temperature +
      "°C RH=" +
      humidity +
      "% Dp=" +
      round1(dewpoint) +
      "°C Batt=" +
      battery +
      "%",
  );
  mqttMessage = JSON.stringify({
    temperature: temperature,
    humidity: humidity,
    dewpoint: round1(dewpoint),
    battery: event.battery,
  });
  MQTT.publish(deviceId + "/status", mqttMessage);
}

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
    _sz =
      _type === uint8 || _type === int8
        ? 1
        : _type === uint16 || _type === int16
          ? 2
          : 3;
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
      _raw =
        0x00ffffff &
        ((buffer.at(pos + 2) << 16) |
          (buffer.at(pos + 1) << 8) |
          buffer.at(pos));
    } else {
      _raw =
        0x00ffffff &
        ((buffer.at(pos + 2) << 16) |
          (buffer.at(pos + 1) << 8) |
          buffer.at(pos));
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
  if (result.addr !== sensor && result.addr !== sensor_inside) return;

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

  if (!BLEConfig.enable) {
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

initBLE();