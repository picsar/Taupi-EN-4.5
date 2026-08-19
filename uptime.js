////////////// UPTIME MONITOR @ Shelly //////////////
// Documentation and latest versions at https://github.com/picsar/Taupi-EN-4.5
//
// This script displays device health on a virtual Text component (id 201).
// Every 60 seconds it writes:
//   - Current date and time
//   - Device uptime (hours / minutes / seconds)
//   - WiFi signal strength (RSSI)
//   - Cloud connection status
//
// If the cloud connection drops, a fail counter increments.
// After 15 consecutive failed checks (= ~15 minutes offline) the device reboots automatically.
//
// Requires a virtual Text component with id 201. Create it once via:
//   curl -X POST http://<shelly-ip>/rpc/Shelly.AddComponent \
//        -d '{"type":"text","id":201,"config":{"name":"Uptime"}}'
//

let failCount = 0;
let lastText = "";
let componentId = 201;

Timer.set(60000, true, function () {
  let wifi = Shelly.getComponentStatus("wifi");
  let cloud = Shelly.getComponentStatus("cloud");

  if (!cloud.connected) {
    failCount++;
    if (failCount >= 15) {
      failCount = 0;
      Shelly.call("Sys.Reboot", {});
    }
    return; // kein Text.Set wenn offline
  }
 

  Shelly.call("Sys.GetStatus", {}, function (result) {
    let uptime = result.uptime;
    let h = Math.floor(uptime / 3600);
    let m = Math.floor((uptime % 3600) / 60);
    let s = uptime % 60;
    lastText = h + "h " + m + "m " + s + "s | RSSI:" + wifi.rssi + " | Cloud: OK | Fails: "+ failCount;
 
    Shelly.call("Text.Set", { id: componentId, value: lastText }, function (res, err) {
      print(err ? ("Fehler: " + err) : ("OK: " + lastText));
    });
  });
  failCount = 0;
});