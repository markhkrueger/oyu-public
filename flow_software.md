
This documents the required software for the Raspberry Pi 3 B computer to run the flow system.


## Operating System

Use Raspberry Pi Imager to install **Raspbian Trixie 64-bit Lite**. During imaging, configure:
- Username and password (e.g., user `mark`)
- Enable SSH
- WiFi SSID and password

This OS has no desktop, so all setup is done via SSH.


## 1-Wire Temperature Sensors

DS18B20 temperature sensors use the 1-wire bus on GPIO 4. To enable it, edit `/boot/firmware/config.txt` and add:

    dtoverlay=w1-gpio

Reboot after making this change. Sensors will appear at `/sys/bus/w1/devices/28-*/w1_slave`.


## Install Node.js (v22 or later)

Node.js v22.x or later is required (at least v22.22.1). Install from the NodeSource repository:

    # Set up NodeSource v22 for 64-bit ARM
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -

    # Install Node.js and npm
    sudo apt-get install -y nodejs

    # Verify versions
    node -v    # should show v22.x.x or later
    npm -v


## Install GPIO Tools (libgpiod)

The flow server uses `gpiomon` and `gpioset` from the libgpiod package to interact with GPIO pins (for the flow sensor, pump relay, and status LEDs). Install with:

    sudo apt-get install -y gpiod


## Create the Flow Directory

Create the working directory on the Pi:

    mkdir -p /home/mark/flow


## Compile on the Development Machine

On your development machine (where the source repo lives), compile TypeScript:

    npx tsc

This produces compiled JavaScript in the `out/` directory.


## Copy Files to the Pi

From the development machine, copy the required files to the Pi using `scp`. Replace `yonopi.local` with your Pi's hostname or IP address:

    # Compiled server
    scp out/flow_server.js pi@yonopi.local:/home/mark/flow/

    # Configuration file
    scp flow_config.json pi@yonopi.local:/home/mark/flow/

    # Locale files (directory)
    scp -r locales pi@yonopi.local:/home/mark/flow/

    # Temperature sensor submodule (directory)
    scp -r raspi-1wire-temp pi@yonopi.local:/home/mark/flow/

    # Systemd service file
    scp flow-server.service pi@yonopi.local:/home/mark/flow/

The required files on the Pi are:

| File/Directory      | Purpose                                      |
| :------------------ | :------------------------------------------- |
| flow_server.js      | Compiled flow server (from out/)             |
| flow_config.json    | Server configuration (port, pins, thresholds)|
| locales/            | Locale files (en.json, jp.json)              |
| raspi-1wire-temp/   | DS18B20 temperature sensor library           |
| flow-server.service | Systemd unit file                            |


## Install npm Packages on the Pi

On the Pi, create a `package.json` and install the runtime dependencies:

    cd /home/mark/flow

    npm init -y

    npm install @homebridge/hap-nodejs qrcode systeminformation

These are the npm packages required at runtime by flow_server.js:

| Package               | Purpose                                    |
| :-------------------- | :----------------------------------------- |
| @homebridge/hap-nodejs| HomeKit accessory protocol for smart home  |
| qrcode                | QR code generation for HomeKit pairing     |
| systeminformation     | System info (CPU temp, network, disk, etc) |

Note: Node.js built-in modules (`http`, `fs`, `path`, `crypto`, `child_process`, `url`, `os`) require no installation. GPIO interaction uses `gpiomon`/`gpioset` from libgpiod (installed above), not an npm package.


## Configuration

The `flow_config.json` file controls server behavior:

```json
{
    "port": 8081,
    "tempPollInterval": 10,
    "flowPollInterval": 1,
    "flowStartDelay": 5,
    "flowStopDelay": 3,
    "pumpMaxRunTime": 30,
    "sensorPin": 12,
    "pumpPin": 26,
    "logFile": "flow.log",
    "historyFile": "flow_history.json",
    "logMaxRotations": 30,
    "tempLogThreshold": 0.5,
    "locale": "en",
    "tempUnits": "C",
    "flowUnits": "L"
}
```

Key settings:
- `port` — HTTP server port (the control server polls this)
- `sensorPin` — BCM GPIO pin for the Hall Effect flow sensor (default 12)
- `pumpPin` — BCM GPIO pin for the pump relay (default 26)
- `tempPollInterval` — seconds between temperature readings
- `flowPollInterval` — seconds between flow calculations
- `pumpMaxRunTime` — maximum minutes the pump can run continuously


## Systemd Service

The flow server runs as a systemd service so it starts automatically at boot and restarts on failure.

Install the service:

    sudo cp /home/mark/flow/flow-server.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable flow-server
    sudo systemctl start flow-server

After deploying updated code, restart the service:

    sudo systemctl restart flow-server

Useful commands:

    sudo systemctl status flow-server       # Check if running
    sudo systemctl stop flow-server         # Stop the service
    journalctl -u flow-server -f            # Tail live logs
    journalctl -u flow-server --since today # View today's logs

The service is configured with `Restart=on-failure` and `RestartSec=5`, so systemd will automatically restart it 5 seconds after any crash. It runs as user `mark` from `/home/mark/flow`.


## RaspAP (Optional — Headless WiFi Management)

For headless operation, install RaspAP so that when no WiFi is available the Pi starts a local WiFi Access Point with a web interface to configure WiFi settings:

    curl -sL https://install.raspap.com | sudo bash


## Error States

The status LEDs indicate error conditions:

| LED Behavior          | Meaning                    |
| :-------------------- | :------------------------- |
| HOT LED flashing      | Missing temperature sensor |
| FLOW LED flashing     | Missing flow sensor        |
| PUMP LED flashing     | Missing pump               |
| All LEDs flashing     | No network                 |
