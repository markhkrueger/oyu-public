
This documents the required software for the Raspberry Pi 3 B computer to run the flow system.


## Operating System

Use Raspberry Pi Imager to install **Raspbian Trixie 64-bit Lite**. During imaging, configure:
- Username and password (e.g., user `mark`)
- Enable SSH
- WiFi SSID and password

This OS has no desktop, so all setup is done via SSH.


## 1-Wire Temperature Sensors

DS18B20 temperature sensors use the 1-wire bus on GPIO 4. To enable it, edit `/boot/firmware/config.txt` and add under `[all]`:

    dtoverlay=w1-gpio
    enable_uart=1

The `enable_uart=1` line enables the serial port on GPIO 14 (TXD) and GPIO 15 (RXD) at `/dev/serial0`, used by the HC12 wireless module for the door sensor.

Also disable camera and display auto-detection, which can conflict with the 1-wire overlay. This system runs headless and doesn't use a camera or display, so comment these out:

    #camera_auto_detect=1
    #display_auto_detect=1

Reboot after making these changes. Verify that sensors are detected:

    ls /sys/bus/w1/devices/28-*

Each sensor appears as a directory named with its unique ID (e.g. `28-3ce6f6488743`). To read a sensor's current temperature:

    cat /sys/bus/w1/devices/28-*/w1_slave

If no `28-*` directories appear, check the following:

1. **Verify the overlay is loaded:**

        dtoverlay -l

    You should see `w1-gpio` in the list. If not, check that `dtoverlay=w1-gpio` is in `/boot/firmware/config.txt` (not `/boot/config.txt` on newer OS versions) and reboot.

2. **Check that the kernel modules are loaded:**

        lsmod | grep w1

    You should see `w1_gpio` and `w1_therm`. If missing, load them manually:

        sudo modprobe w1-gpio
        sudo modprobe w1-therm

3. **Check wiring:** DS18B20 sensors require a 4.7kΩ pull-up resistor between the data line and 3.3V. Without it, the bus may detect intermittently or not at all.

4. **Check for bus master:** The `/sys/bus/w1/devices/` directory should contain at least a `w1_bus_masterX` entry. If even that is missing, the overlay did not load.

5. **Try specifying the GPIO pin explicitly:**

        dtoverlay=w1-gpio,gpiopin=4

Once the flow server is running, open the dashboard and go to **Settings → Sensor Setup** (or navigate to `/sensor-setup`). This page lists all detected sensors and lets you assign each one a role — **Hot**, **Cold**, or **Ambient**. Only Hot is required. The assignments are saved in `sensor_config.json`.


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

    mkdir -p ~/flow


## Install raspi-1wire-temp (Temperature Sensor Library)

The DS18B20 temperature sensor interface is included as a git submodule. After cloning the repo, initialize and fetch it:

    git submodule update --init

This populates the `raspi-1wire-temp/` directory. The server loads it directly via `require('./raspi-1wire-temp/')` — no separate npm install is needed. The directory is copied to the Pi along with the other files (see below).


## Compile on the Development Machine

On your development machine (where the source repo lives), compile TypeScript:

    npx tsc

This produces compiled JavaScript in the `out/` directory.


## Copy Files to the Pi

From the development machine, copy the required files to the Pi using `scp`. Replace `yonopi.local` with your Pi's hostname or IP address:

    # Compiled server
    scp out/flow_server.js pi@yonopi.local:~/flow/
    
    # Configuration file
    scp flow_config.json pi@yonopi.local:~/flow/

    # Locale files (directory)
    scp -r locales pi@yonopi.local:~/flow/

    # Temperature sensor submodule (directory)
    scp -r raspi-1wire-temp pi@yonopi.local:~/flow/

    # Systemd service file
    scp flow-server.service pi@yonopi.local:~/flow/

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

    cd ~/flow

    npm init -y

    npm install @homebridge/hap-nodejs qrcode systeminformation glob

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

## HomeKit Settings

You can change the pairing by editing `flow_config.json`:

- `homekitPin` — Any 8-digit code in the format "XXX-XX-XXX" (e.g. "031-45-154"). Avoid codes that Apple blocks: "000-00-000", "111-11-111", "222-22-222", etc. through "999-99-999", and "123-45-678".
- `homekitUsername` — A unique MAC-like identifier in the format "XX:XX:XX:XX:XX:XX" (e.g. "0E:AA:CE:DD:01:04"). This identifies your bridge to HomeKit. Changing this is what forces a new pairing — HomeKit treats it as a different device.
- `homekitPort` — Any unused port (e.g. 47128). Only change this if something else is using the same port.

To force a fresh pairing:

1. Remove the old accessory from the Home app
2. Change `homekitUsername` to a new value (just change a digit or two)
3. Optionally change `homekitPin` to your preferred code
4. Delete the persist directory (where HAP-nodejs stores its keys): `rm -rf ~/.HomeKit-persist` or wherever your persist folder is — check for a `persist/` directory next to `flow_server.ts`
5. Restart the server

The QR code on the dashboard will update automatically with the new pin.


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
